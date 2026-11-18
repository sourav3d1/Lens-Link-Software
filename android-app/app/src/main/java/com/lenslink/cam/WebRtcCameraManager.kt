package com.lenslink.cam

import android.content.Context
import android.graphics.Bitmap
import android.util.Base64
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoFrame
import org.webrtc.VideoProcessor
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class WebRtcCameraManager(
    private val context: Context,
    private val renderer: SurfaceViewRenderer,
    private val listener: Listener
) {
    interface Listener {
        fun onIceCandidateGenerated(sdpMid: String, sdpMLineIndex: Int, candidate: String)
        fun onOfferCreated(sdp: String)
        fun onConnectionStateChanged(state: String)
        fun onCameraError(message: String)
    }

    private val eglBase: EglBase = EglBase.create()
    private val factory: PeerConnectionFactory
    private val enumerator = Camera2Enumerator(context)

    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var localVideoTrack: VideoTrack? = null
    private var peerConnection: PeerConnection? = null

    @Volatile
    private var currentSettings = CameraSettings()

    private var sink: VideoSink? = null

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()

        renderer.init(eglBase.eglBaseContext, null)
        renderer.setEnableHardwareScaler(true)
        renderer.setMirror(false)
    }

    fun getAvailableCameras(): List<CameraDeviceSummary> {
        val names = enumerator.deviceNames
        val result = mutableListOf<CameraDeviceSummary>()
        var rearCount = 0
        for ((idx, name) in names.withIndex()) {
            val isBack = enumerator.isBackFacing(name)
            val isFront = enumerator.isFrontFacing(name)
            val facing = when {
                isFront -> "front"
                isBack -> "back"
                else -> "unknown"
            }
            val shortLabel = when {
                isFront -> "Front"
                isBack -> {
                    rearCount += 1
                    if (rearCount == 1) "Rear Main" else "Rear Lens $rearCount"
                }
                else -> "Camera ${idx + 1}"
            }
            result.add(
                CameraDeviceSummary(
                    deviceId = name,
                    label = "$shortLabel ($name)",
                    shortLabel = shortLabel,
                    facing = facing
                )
            )
        }
        return result
    }

    fun startCamera(settings: CameraSettings) {
        currentSettings = settings
        renderer.setMirror(settings.facingMode == "user")
        stopCameraOnly()

        val selectedName = resolveDeviceName(settings)
        if (selectedName == null) {
            listener.onCameraError("No matching camera device found.")
            return
        }

        val capturer = enumerator.createCapturer(selectedName, object : CameraVideoCapturer.CameraEventsHandler {
            override fun onCameraError(errorDescription: String?) {
                listener.onCameraError(errorDescription ?: "Camera error")
            }

            override fun onCameraDisconnected() {}
            override fun onCameraFreezed(errorDescription: String?) {}
            override fun onCameraOpening(cameraName: String?) {}
            override fun onFirstFrameAvailable() {}
            override fun onCameraClosed() {}
        })

        if (capturer == null) {
            listener.onCameraError("Unable to open camera capturer.")
            return
        }

        videoCapturer = capturer
        val helper = SurfaceTextureHelper.create("LensLinkCaptureThread", eglBase.eglBaseContext)
        surfaceTextureHelper = helper
        val source = factory.createVideoSource(capturer.isScreencast)
        videoSource = source

        source.setVideoProcessor(object : VideoProcessor {
            override fun onCapturerStarted(success: Boolean) {}
            override fun onCapturerStopped() {}
            override fun setSink(videoSink: VideoSink?) {
                sink = videoSink
            }

            override fun onFrameCaptured(frame: VideoFrame) {
                val activeSettings = currentSettings
                val needsZoom = activeSettings.zoom > 1.05f
                val needsBrightness = activeSettings.brightness != 0
                val needsGrayscale = activeSettings.grayscale

                if (!needsZoom && !needsBrightness && !needsGrayscale) {
                    sink?.onFrame(frame)
                    return
                }

                val baseI420 = frame.buffer.toI420()
                if (baseI420 == null) {
                    sink?.onFrame(frame)
                    return
                }

                val width = baseI420.width
                val height = baseI420.height

                val zoomedBuffer = if (needsZoom) {
                    val cropW = max(16, (width / activeSettings.zoom).roundToInt() and 0xFFFE)
                    val cropH = max(16, (height / activeSettings.zoom).roundToInt() and 0xFFFE)
                    val cropX = ((width - cropW) / 2) and 0xFFFE
                    val cropY = ((height - cropH) / 2) and 0xFFFE
                    val scaled = baseI420.cropAndScale(cropX, cropY, cropW, cropH, width, height)
                    baseI420.release()
                    scaled.toI420().also { scaled.release() }
                } else {
                    baseI420
                }

                if (zoomedBuffer == null) {
                    sink?.onFrame(frame)
                    return
                }

                if (needsBrightness || needsGrayscale) {
                    if (needsBrightness) {
                        val delta = (activeSettings.brightness * 1.4f).roundToInt()
                        adjustLumaPlane(zoomedBuffer.dataY, zoomedBuffer.strideY, zoomedBuffer.width, zoomedBuffer.height, delta)
                    }
                    if (needsGrayscale) {
                        neutralizeChroma(zoomedBuffer.dataU, zoomedBuffer.strideU, zoomedBuffer.width / 2, zoomedBuffer.height / 2)
                        neutralizeChroma(zoomedBuffer.dataV, zoomedBuffer.strideV, zoomedBuffer.width / 2, zoomedBuffer.height / 2)
                    }
                }

                val outFrame = VideoFrame(zoomedBuffer, frame.rotation, frame.timestampNs)
                sink?.onFrame(outFrame)
                outFrame.release()
            }
        })

        capturer.initialize(helper, context, source.capturerObserver)
        val (w, h) = settings.targetDimensions()
        capturer.startCapture(w, h, settings.frameRate)

        val track = factory.createVideoTrack("ARDAMSv0", source)
        track.setEnabled(true)
        track.addSink(renderer)
        localVideoTrack = track

        // Hot-swap video track if PeerConnection is already streaming
        peerConnection?.senders?.firstOrNull { it.track()?.kind() == "video" }?.setTrack(track, false)
    }

    fun updateSettings(next: CameraSettings) {
        val reopenNeeded = next.facingMode != currentSettings.facingMode ||
            next.deviceId != currentSettings.deviceId ||
            next.resolution != currentSettings.resolution ||
            next.frameRate != currentSettings.frameRate

        currentSettings = next
        renderer.setMirror(next.facingMode == "user")
        if (reopenNeeded) {
            startCamera(next)
        }
    }

    fun createAndSendOffer(useStun: Boolean) {
        closePeerConnection()
        val iceServers = if (useStun) {
            listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
        } else {
            emptyList()
        }

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        val pc = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                if (candidate != null) {
                    listener.onIceCandidateGenerated(candidate.sdpMid, candidate.sdpMLineIndex, candidate.sdp)
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                val label = when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED -> "connected"
                    PeerConnection.PeerConnectionState.CONNECTING -> "connecting"
                    PeerConnection.PeerConnectionState.DISCONNECTED,
                    PeerConnection.PeerConnectionState.FAILED -> "reconnecting"
                    else -> "waiting"
                }
                listener.onConnectionStateChanged(label)
            }

            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
        }) ?: return

        peerConnection = pc
        localVideoTrack?.let { pc.addTrack(it, listOf("ARDAMS")) }

        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
        }

        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                if (sdp == null) return
                pc.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        listener.onOfferCreated(sdp.description)
                    }
                    override fun onSetFailure(err: String?) {}
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(p0: String?) {}
                }, sdp)
            }
            override fun onCreateFailure(err: String?) {
                listener.onCameraError(err ?: "Offer creation failed")
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, constraints)
    }

    fun applyRemoteAnswer(sdp: String, type: String) {
        val pc = peerConnection ?: return
        val descType = if (type.equals("answer", true)) SessionDescription.Type.ANSWER else SessionDescription.Type.OFFER
        pc.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, SessionDescription(descType, sdp))
    }

    fun addRemoteIceCandidate(sdpMid: String, sdpMLineIndex: Int, candidate: String) {
        peerConnection?.addIceCandidate(IceCandidate(sdpMid, sdpMLineIndex, candidate))
    }

    fun captureSnapshot(onCaptured: (dataUrl: String, width: Int, height: Int) -> Unit) {
        renderer.addFrameListener({ bitmap ->
            if (bitmap == null) return@addFrameListener
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 92, out)
            val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            onCaptured("data:image/jpeg;base64,$b64", bitmap.width, bitmap.height)
        }, 1.0f)
    }

    fun closePeerConnection() {
        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null
    }

    private fun stopCameraOnly() {
        localVideoTrack?.removeSink(renderer)
        localVideoTrack?.dispose()
        localVideoTrack = null
        try {
            videoCapturer?.stopCapture()
        } catch (_: Exception) {
        }
        videoCapturer?.dispose()
        videoCapturer = null
        videoSource?.dispose()
        videoSource = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null
    }

    fun release() {
        closePeerConnection()
        stopCameraOnly()
        renderer.release()
        factory.dispose()
        eglBase.release()
    }

    private fun resolveDeviceName(settings: CameraSettings): String? {
        val names = enumerator.deviceNames
        if (!settings.deviceId.isNullOrBlank() && names.contains(settings.deviceId)) {
            return settings.deviceId
        }
        val wantFront = settings.facingMode == "user"
        return names.firstOrNull { name ->
            if (wantFront) enumerator.isFrontFacing(name) else enumerator.isBackFacing(name)
        } ?: names.firstOrNull()
    }

    private fun adjustLumaPlane(buffer: ByteBuffer, stride: Int, width: Int, height: Int, delta: Int) {
        for (row in 0 until height) {
            val rowOffset = row * stride
            for (col in 0 until width) {
                val idx = rowOffset + col
                val y = buffer.get(idx).toInt() and 0xFF
                val next = min(255, max(0, y + delta))
                buffer.put(idx, next.toByte())
            }
        }
    }

    private fun neutralizeChroma(buffer: ByteBuffer, stride: Int, width: Int, height: Int) {
        for (row in 0 until height) {
            val rowOffset = row * stride
            for (col in 0 until width) {
                buffer.put(rowOffset + col, 128.toByte())
            }
        }
    }
}
