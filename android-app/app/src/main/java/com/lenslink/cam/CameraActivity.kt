package com.lenslink.cam

import android.content.Context
import android.content.res.ColorStateList
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.SeekBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.lenslink.cam.databinding.ActivityCameraBinding
import com.lenslink.cam.databinding.SheetCameraControlsBinding
import org.json.JSONObject
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class CameraActivity : AppCompatActivity(), SignalingClient.Listener, WebRtcCameraManager.Listener {
    companion object {
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_PAIR_CODE = "pair_code"
    }

    private lateinit var binding: ActivityCameraBinding
    private lateinit var signaling: SignalingClient
    private lateinit var cameraManager: WebRtcCameraManager
    private lateinit var sysCameraManager: CameraManager

    private val mainHandler = Handler(Looper.getMainLooper())

    private var serverOrigin: String = ""
    private var pairCode: String = ""
    private var settings = CameraSettings()
    private var devices: List<CameraDeviceSummary> = emptyList()

    private var isStreaming = false
    private var pcOnline = false
    private var pcName = "PC"
    private var torchEnabled = false

    // Long-press & vertical slide brightness gesture state
    private var longPressRunnable: Runnable? = null
    private var hideBrightnessRunnable: Runnable? = null
    private var brightnessGestureActive = false
    private var pointerDownX = 0f
    private var pointerDownY = 0f
    private var gestureStartBrightness = 0
    private var isScaling = false

    private lateinit var scaleDetector: ScaleGestureDetector

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        binding = ActivityCameraBinding.inflate(layoutInflater)
        setContentView(binding.root)

        serverOrigin = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty()
        pairCode = intent.getStringExtra(EXTRA_PAIR_CODE).orEmpty()
        binding.tvPairCode.text = pairCode

        sysCameraManager = getSystemService(Context.CAMERA_SERVICE) as CameraManager
        cameraManager = WebRtcCameraManager(this, binding.localSurfaceRenderer, this)
        devices = cameraManager.getAvailableCameras()

        val defaultRear = devices.firstOrNull { it.facing == "back" }
        if (defaultRear != null) {
            settings = settings.copy(deviceId = defaultRear.deviceId, facingMode = "environment")
        }

        // Start rear camera preview immediately with zero blank delay
        cameraManager.startCamera(settings)
        setupLensAndTorchBar()
        updateTechReadout()

        val wsUrl = PairingParser.buildWebSocketUrl(serverOrigin)
        signaling = SignalingClient(wsUrl, pairCode, this)
        signaling.connect()

        setupControls()
        setupViewfinderGestures()
    }

    private fun setupControls() {
        binding.btnDisconnect.setOnClickListener { finish() }

        binding.btnFlipCamera.setOnClickListener {
            val nextFacing = if (settings.facingMode == "environment") "user" else "environment"
            val targetDevice = devices.firstOrNull {
                if (nextFacing == "user") it.facing == "front" else it.facing == "back"
            }
            applySettingsChange(
                settings.copy(
                    facingMode = nextFacing,
                    deviceId = targetDevice?.deviceId,
                    zoom = 1.0f,
                    mirror = nextFacing == "user"
                )
            )
            setupLensAndTorchBar()
        }

        binding.btnToggleStream.setOnClickListener {
            if (isStreaming) {
                isStreaming = false
                signaling.sendStreamState(false)
                cameraManager.closePeerConnection()
                updateStreamButtonUi()
                binding.tvConnectionStatus.text = if (pcOnline) "Paired: $pcName" else "Waiting for PC"
            } else {
                isStreaming = true
                signaling.sendStreamState(true)
                updateStreamButtonUi()
                if (pcOnline) {
                    binding.tvConnectionStatus.text = "Connecting..."
                    cameraManager.createAndSendOffer(!isLocalOrigin(serverOrigin))
                } else {
                    binding.tvConnectionStatus.text = "Waiting for PC"
                }
            }
        }

        binding.btnCapturePhoto.setOnClickListener { triggerPhotoCapture() }
        binding.btnOpenSettings.setOnClickListener { showControlsSheet() }
    }

    private fun setupLensAndTorchBar() {
        val rearDevices = devices.filter { it.facing == "back" }
        val hasFlash = hasFlashForActiveCamera()
        val showBar = settings.facingMode == "environment" && (rearDevices.size > 1 || hasFlash)

        binding.lensBar.visibility = if (showBar) View.VISIBLE else View.GONE
        if (!showBar) return

        binding.lensChipsContainer.removeAllViews()
        if (rearDevices.size > 1) {
            for (dev in rearDevices) {
                val active = settings.deviceId == dev.deviceId
                val chip = MaterialButton(this).apply {
                    text = dev.shortLabel
                    isAllCaps = false
                    textSize = 12f
                    setTextColor(ContextCompat.getColor(this@CameraActivity, R.color.text_white))
                    backgroundTintList = ColorStateList.valueOf(
                        ContextCompat.getColor(
                            this@CameraActivity,
                            if (active) R.color.primary_blue else R.color.surface_slate_800
                        )
                    )
                    cornerRadius = (10 * resources.displayMetrics.density).roundToInt()
                    val lp = ViewGroup.MarginLayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        (38 * resources.displayMetrics.density).roundToInt()
                    ).apply {
                        marginEnd = (6 * resources.displayMetrics.density).roundToInt()
                    }
                    layoutParams = lp
                    setOnClickListener {
                        applySettingsChange(
                            settings.copy(facingMode = "environment", deviceId = dev.deviceId, mirror = false)
                        )
                        setupLensAndTorchBar()
                    }
                }
                binding.lensChipsContainer.addView(chip)
            }
        }

        binding.btnTorch.visibility = if (hasFlash) View.VISIBLE else View.GONE
        binding.btnTorch.setOnClickListener {
            toggleTorch()
        }
    }

    private fun hasFlashForActiveCamera(): Boolean {
        val camId = settings.deviceId ?: return false
        return try {
            val chars = sysCameraManager.getCameraCharacteristics(camId)
            chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } catch (_: Exception) {
            false
        }
    }

    private fun toggleTorch() {
        val camId = settings.deviceId ?: return
        try {
            torchEnabled = !torchEnabled
            sysCameraManager.setTorchMode(camId, torchEnabled)
            binding.btnTorch.backgroundTintList = ColorStateList.valueOf(
                ContextCompat.getColor(
                    this,
                    if (torchEnabled) R.color.accent_amber else R.color.surface_slate_800
                )
            )
            binding.btnTorch.setTextColor(
                ContextCompat.getColor(this, if (torchEnabled) R.color.bg_slate_950 else R.color.text_white)
            )
        } catch (_: Exception) {
            torchEnabled = false
        }
    }

    private fun setupViewfinderGestures() {
        scaleDetector = ScaleGestureDetector(
            this,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                    isScaling = true
                    cancelLongPress()
                    return true
                }

                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    val nextZoom = min(6.0f, max(1.0f, settings.zoom * detector.scaleFactor))
                    applySettingsChange(settings.copy(zoom = nextZoom))
                    showZoomToast(nextZoom)
                    return true
                }

                override fun onScaleEnd(detector: ScaleGestureDetector) {
                    isScaling = false
                }
            }
        )

        binding.viewfinderContainer.setOnTouchListener { v, event ->
            scaleDetector.onTouchEvent(event)

            if (event.pointerCount > 1 || isScaling) {
                cancelLongPress()
                return@setOnTouchListener true
            }

            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    pointerDownX = event.x
                    pointerDownY = event.y
                    gestureStartBrightness = settings.brightness
                    brightnessGestureActive = false
                    scheduleLongPress(event.x, event.y)
                }

                MotionEvent.ACTION_MOVE -> {
                    if (brightnessGestureActive) {
                        val deltaY = pointerDownY - event.y
                        val deltaBrightness = ((deltaY / dpToPx(180f)) * 100f).roundToInt()
                        val nextBrightness = min(50, max(-50, gestureStartBrightness + deltaBrightness))
                        if (nextBrightness != settings.brightness) {
                            applySettingsChange(settings.copy(brightness = nextBrightness))
                            updateBrightnessHudVisual()
                        }
                    } else {
                        val moved = hypot(event.x - pointerDownX, event.y - pointerDownY)
                        if (moved > dpToPx(14f)) {
                            cancelLongPress()
                        }
                    }
                }

                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    cancelLongPress()
                    if (brightnessGestureActive) {
                        brightnessGestureActive = false
                        scheduleBrightnessHudHide()
                    } else if (event.actionMasked == MotionEvent.ACTION_UP) {
                        if (binding.brightnessHud.visibility == View.VISIBLE) {
                            binding.brightnessHud.visibility = View.GONE
                        }
                        showFocusReticle(event.x, event.y)
                        v.performClick()
                    }
                }
            }
            true
        }

        // Allow direct vertical drag on the floating brightness HUD after lifting finger
        binding.brightnessHud.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                    hideBrightnessRunnable?.let { mainHandler.removeCallbacks(it) }
                    val trackLoc = IntArray(2)
                    binding.brightnessTrack.getLocationOnScreen(trackLoc)
                    val trackTop = trackLoc[1].toFloat()
                    val trackHeight = max(1f, binding.brightnessTrack.height.toFloat())
                    val ratioFromBottom = min(1f, max(0f, ((trackTop + trackHeight) - event.rawY) / trackHeight))
                    val nextBrightness = (ratioFromBottom * 100f - 50f).roundToInt()
                    if (nextBrightness != settings.brightness) {
                        applySettingsChange(settings.copy(brightness = nextBrightness))
                        updateBrightnessHudVisual()
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    scheduleBrightnessHudHide()
                }
            }
            true
        }
    }

    private fun scheduleLongPress(touchX: Float, touchY: Float) {
        cancelLongPress()
        val runnable = Runnable {
            if (isScaling) return@Runnable
            brightnessGestureActive = true
            hideBrightnessRunnable?.let { mainHandler.removeCallbacks(it) }
            binding.focusReticle.visibility = View.GONE
            binding.viewfinderContainer.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            positionAndShowBrightnessHud(touchX, touchY)
        }
        longPressRunnable = runnable
        mainHandler.postDelayed(runnable, 380L)
    }

    private fun cancelLongPress() {
        longPressRunnable?.let { mainHandler.removeCallbacks(it) }
        longPressRunnable = null
    }

    private fun positionAndShowBrightnessHud(touchX: Float, touchY: Float) {
        val parentW = binding.viewfinderContainer.width.toFloat()
        val parentH = binding.viewfinderContainer.height.toFloat()
        val hudW = dpToPx(52f)
        val hudH = dpToPx(220f)
        val offset = dpToPx(56f)

        val targetX = if (touchX > parentW * 0.66f) touchX - offset - hudW / 2f else touchX + offset - hudW / 2f
        val clampedX = min(max(dpToPx(12f), targetX), max(dpToPx(12f), parentW - hudW - dpToPx(12f)))
        val clampedY = min(max(dpToPx(16f), touchY - hudH / 2f), max(dpToPx(16f), parentH - hudH - dpToPx(16f)))

        val lp = binding.brightnessHud.layoutParams as FrameLayout.LayoutParams
        lp.leftMargin = clampedX.roundToInt()
        lp.topMargin = clampedY.roundToInt()
        binding.brightnessHud.layoutParams = lp
        binding.brightnessHud.visibility = View.VISIBLE
        updateBrightnessHudVisual()
    }

    private fun updateBrightnessHudVisual() {
        val pct = min(100, max(0, settings.brightness + 50))
        val trackHeight = binding.brightnessTrack.height.takeIf { it > 0 } ?: dpToPx(150f).roundToInt()
        val fillLp = binding.brightnessFill.layoutParams
        fillLp.height = max(2, (trackHeight * (pct / 100f)).roundToInt())
        binding.brightnessFill.layoutParams = fillLp
        binding.tvBrightnessValue.text = if (settings.brightness > 0) "+${settings.brightness}%" else "${settings.brightness}%"
    }

    private fun scheduleBrightnessHudHide() {
        hideBrightnessRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable { binding.brightnessHud.visibility = View.GONE }
        hideBrightnessRunnable = r
        mainHandler.postDelayed(r, 2200L)
    }

    private fun showFocusReticle(x: Float, y: Float) {
        val size = dpToPx(56f)
        val lp = binding.focusReticle.layoutParams as FrameLayout.LayoutParams
        lp.leftMargin = (x - size / 2f).roundToInt()
        lp.topMargin = (y - size / 2f).roundToInt()
        binding.focusReticle.layoutParams = lp
        binding.focusReticle.visibility = View.VISIBLE
        mainHandler.postDelayed({ binding.focusReticle.visibility = View.GONE }, 950L)
    }

    private fun showZoomToast(zoom: Float) {
        binding.tvZoomToast.text = String.format("%.1f×", zoom)
        binding.tvZoomToast.visibility = View.VISIBLE
        mainHandler.postDelayed({ binding.tvZoomToast.visibility = View.GONE }, 1000L)
    }

    private fun showControlsSheet() {
        val dialog = BottomSheetDialog(this)
        val sheet = SheetCameraControlsBinding.inflate(layoutInflater)
        dialog.setContentView(sheet.root)

        fun syncSheetUi() {
            sheet.tvSheetZoom.text = String.format("%.1f×", settings.zoom)
            sheet.seekZoom.progress = ((settings.zoom - 1.0f) * 10f).roundToInt()
            sheet.tvSheetBrightness.text =
                if (settings.brightness > 0) "+${settings.brightness}%" else "${settings.brightness}%"
            sheet.seekBrightness.progress = settings.brightness + 50
            sheet.switchGrayscale.isChecked = settings.grayscale

            val blue = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.primary_blue))
            val slate = ColorStateList.valueOf(ContextCompat.getColor(this, R.color.surface_slate_800))
            sheet.btnRes480p.backgroundTintList = if (settings.resolution == "480p") blue else slate
            sheet.btnRes720p.backgroundTintList = if (settings.resolution == "720p") blue else slate
            sheet.btnRes1080p.backgroundTintList = if (settings.resolution == "1080p") blue else slate
            sheet.btnFps15.backgroundTintList = if (settings.frameRate == 15) blue else slate
            sheet.btnFps30.backgroundTintList = if (settings.frameRate == 30) blue else slate
            sheet.btnFps60.backgroundTintList = if (settings.frameRate == 60) blue else slate
        }

        syncSheetUi()

        sheet.seekZoom.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                val z = 1.0f + progress / 10f
                applySettingsChange(settings.copy(zoom = z))
                sheet.tvSheetZoom.text = String.format("%.1f×", z)
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        sheet.seekBrightness.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                val b = progress - 50
                applySettingsChange(settings.copy(brightness = b))
                sheet.tvSheetBrightness.text = if (b > 0) "+${b}%" else "${b}%"
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {}
            override fun onStopTrackingTouch(sb: SeekBar?) {}
        })

        sheet.switchGrayscale.setOnCheckedChangeListener { _, checked ->
            applySettingsChange(settings.copy(grayscale = checked))
        }

        sheet.btnRes480p.setOnClickListener { applySettingsChange(settings.copy(resolution = "480p")); syncSheetUi() }
        sheet.btnRes720p.setOnClickListener { applySettingsChange(settings.copy(resolution = "720p")); syncSheetUi() }
        sheet.btnRes1080p.setOnClickListener { applySettingsChange(settings.copy(resolution = "1080p")); syncSheetUi() }

        sheet.btnFps15.setOnClickListener { applySettingsChange(settings.copy(frameRate = 15)); syncSheetUi() }
        sheet.btnFps30.setOnClickListener { applySettingsChange(settings.copy(frameRate = 30)); syncSheetUi() }
        sheet.btnFps60.setOnClickListener { applySettingsChange(settings.copy(frameRate = 60)); syncSheetUi() }

        sheet.btnSheetReset.setOnClickListener {
            applySettingsChange(settings.copy(zoom = 1.0f, brightness = 0, grayscale = false))
            syncSheetUi()
        }

        dialog.show()
    }

    private fun applySettingsChange(next: CameraSettings) {
        settings = next
        cameraManager.updateSettings(next)
        updateTechReadout()
        signaling.sendSettingsPatch(next.toJson())
    }

    private fun updateTechReadout() {
        binding.tvTechReadout.text = String.format("%s · %.1f×", settings.resolution, settings.zoom)
    }

    private fun updateStreamButtonUi() {
        if (isStreaming) {
            binding.btnToggleStream.text = "Stop Stream"
            binding.btnToggleStream.backgroundTintList =
                ColorStateList.valueOf(ContextCompat.getColor(this, R.color.status_red))
        } else {
            binding.btnToggleStream.text = "Start Stream"
            binding.btnToggleStream.backgroundTintList =
                ColorStateList.valueOf(ContextCompat.getColor(this, R.color.primary_blue))
        }
    }

    private fun triggerPhotoCapture() {
        binding.shutterFlash.visibility = View.VISIBLE
        mainHandler.postDelayed({ binding.shutterFlash.visibility = View.GONE }, 150L)

        val lensLabel = devices.firstOrNull { it.deviceId == settings.deviceId }?.shortLabel ?: "Rear Camera"
        cameraManager.captureSnapshot { dataUrl, w, h ->
            runOnUiThread {
                signaling.sendCapturedPhoto(dataUrl, w, h, lensLabel, settings.zoom)
                Toast.makeText(this, "Photo sent to $pcName", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun isLocalOrigin(origin: String): Boolean {
        return origin.contains("192.168.") || origin.contains("10.") || origin.contains("172.") || origin.contains("localhost")
    }

    private fun dpToPx(dp: Float): Float = dp * resources.displayMetrics.density

    // SignalingClient.Listener callbacks
    override fun onConnected() {
        signaling.sendCapabilities(devices)
        if (isStreaming) {
            signaling.sendStreamState(true)
        }
    }

    override fun onReconnecting(attempt: Int) {
        binding.tvConnectionStatus.text = "Reconnecting ($attempt)"
    }

    override fun onRoomStatus(pcOnline: Boolean, pcName: String) {
        this.pcOnline = pcOnline
        this.pcName = pcName
        if (pcOnline && isStreaming) {
            cameraManager.createAndSendOffer(!isLocalOrigin(serverOrigin))
        } else {
            binding.tvConnectionStatus.text = if (pcOnline) "Paired: $pcName" else "Waiting for PC"
        }
    }

    override fun onRoomError(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        binding.tvConnectionStatus.text = "Room error"
    }

    override fun onRtcAnswer(sdp: String, type: String) {
        cameraManager.applyRemoteAnswer(sdp, type)
    }

    override fun onIceCandidate(sdpMid: String, sdpMLineIndex: Int, candidate: String) {
        cameraManager.addRemoteIceCandidate(sdpMid, sdpMLineIndex, candidate)
    }

    override fun onRtcRestartRequested() {
        if (isStreaming) {
            cameraManager.createAndSendOffer(!isLocalOrigin(serverOrigin))
        }
    }

    override fun onRemoteSettingsChanged(patch: JSONObject) {
        val next = settings.copy(
            facingMode = patch.optString("facingMode", settings.facingMode),
            resolution = patch.optString("resolution", settings.resolution),
            frameRate = patch.optInt("frameRate", settings.frameRate),
            zoom = patch.optDouble("zoom", settings.zoom.toDouble()).toFloat(),
            brightness = patch.optInt("brightness", settings.brightness),
            grayscale = patch.optBoolean("grayscale", settings.grayscale)
        )
        settings = next
        cameraManager.updateSettings(next)
        updateTechReadout()
    }

    override fun onRemoteCaptureRequested() {
        triggerPhotoCapture()
    }

    // WebRtcCameraManager.Listener callbacks
    override fun onIceCandidateGenerated(sdpMid: String, sdpMLineIndex: Int, candidate: String) {
        signaling.sendIceCandidate(sdpMid, sdpMLineIndex, candidate)
    }

    override fun onOfferCreated(sdp: String) {
        signaling.sendOffer(sdp)
    }

    override fun onConnectionStateChanged(state: String) {
        runOnUiThread {
            binding.tvConnectionStatus.text = when (state) {
                "connected" -> "Live on $pcName"
                "connecting" -> "Connecting"
                "reconnecting" -> "Reconnecting"
                else -> if (pcOnline) "Paired: $pcName" else "Waiting for PC"
            }
        }
    }

    override fun onCameraError(message: String) {
        runOnUiThread {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cancelLongPress()
        hideBrightnessRunnable?.let { mainHandler.removeCallbacks(it) }
        signaling.disconnect()
        cameraManager.release()
    }
}
