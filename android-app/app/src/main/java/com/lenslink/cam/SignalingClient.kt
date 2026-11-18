package com.lenslink.cam

import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

class SignalingClient(
    private val wsUrl: String,
    private val pairCode: String,
    private val listener: Listener
) {
    interface Listener {
        fun onConnected()
        fun onReconnecting(attempt: Int)
        fun onRoomStatus(pcOnline: Boolean, pcName: String)
        fun onRoomError(message: String)
        fun onRtcAnswer(sdp: String, type: String)
        fun onIceCandidate(sdpMid: String, sdpMLineIndex: Int, candidate: String)
        fun onRtcRestartRequested()
        fun onRemoteSettingsChanged(patch: JSONObject)
        fun onRemoteCaptureRequested()
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var closedManually = false
    private var reconnectAttempt = 0
    private var reconnectRunnable: Runnable? = null

    fun connect() {
        closedManually = false
        openSocket()
    }

    fun disconnect() {
        closedManually = true
        reconnectRunnable?.let { mainHandler.removeCallbacks(it) }
        reconnectRunnable = null
        webSocket?.close(1000, "User disconnected")
        webSocket = null
    }

    fun send(payload: JSONObject) {
        webSocket?.send(payload.toString())
    }

    fun sendStreamState(streaming: Boolean) {
        send(JSONObject().apply {
            put("type", "camera:stream-state")
            put("streaming", streaming)
        })
    }

    fun sendCapabilities(devices: List<CameraDeviceSummary>) {
        val model = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        send(JSONObject().apply {
            put("type", "camera:capabilities")
            put("capabilities", PairingParser.devicesToCapabilitiesJson(devices))
            put("phoneName", "$model (Android App)")
        })
    }

    fun sendSettingsPatch(patch: JSONObject) {
        send(JSONObject().apply {
            put("type", "camera:settings")
            put("settings", patch)
        })
    }

    fun sendOffer(sdp: String) {
        send(JSONObject().apply {
            put("type", "rtc:offer")
            put("target", "pc")
            put("sdp", JSONObject().apply {
                put("type", "offer")
                put("sdp", sdp)
            })
        })
    }

    fun sendIceCandidate(sdpMid: String, sdpMLineIndex: Int, candidate: String) {
        send(JSONObject().apply {
            put("type", "rtc:ice-candidate")
            put("target", "pc")
            put("candidate", JSONObject().apply {
                put("sdpMid", sdpMid)
                put("sdpMLineIndex", sdpMLineIndex)
                put("candidate", candidate)
            })
        })
    }

    fun sendCapturedPhoto(
        dataUrl: String,
        width: Int,
        height: Int,
        lensLabel: String,
        zoom: Float
    ) {
        send(JSONObject().apply {
            put("type", "camera:photo-captured")
            put("photo", JSONObject().apply {
                put("id", "photo-${System.currentTimeMillis()}")
                put("category", "article")
                put("dataUrl", dataUrl)
                put("width", width)
                put("height", height)
                put("capturedAt", java.time.Instant.now().toString())
                put("lensLabel", lensLabel)
                put("zoom", zoom.toDouble())
            })
        })
    }

    private fun openSocket() {
        if (closedManually) return
        val request = Request.Builder().url(wsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempt = 0
                val deviceLabel = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
                val joinMsg = JSONObject().apply {
                    put("type", "room:join")
                    put("code", pairCode)
                    put("role", "phone")
                    put("phoneName", "$deviceLabel (Android App)")
                }
                webSocket.send(joinMsg.toString())
                mainHandler.post { listener.onConnected() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try {
                    JSONObject(text)
                } catch (_: Exception) {
                    return
                }
                val type = msg.optString("type")
                mainHandler.post { handleInboundMessage(type, msg) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect()
            }
        })
    }

    private fun handleInboundMessage(type: String, msg: JSONObject) {
        when (type) {
            "room:status" -> {
                val pcOnline = msg.optBoolean("pcOnline", false)
                val pcName = msg.optString("pcName", "PC")
                listener.onRoomStatus(pcOnline, pcName)
            }
            "room:error" -> {
                listener.onRoomError(msg.optString("message", "Unable to join PC session."))
            }
            "rtc:answer" -> {
                val sdpObj = msg.optJSONObject("sdp") ?: return
                val sdp = sdpObj.optString("sdp")
                val sdpType = sdpObj.optString("type", "answer")
                if (sdp.isNotEmpty()) {
                    listener.onRtcAnswer(sdp, sdpType)
                }
            }
            "rtc:ice-candidate" -> {
                val candObj = msg.optJSONObject("candidate") ?: return
                val candidate = candObj.optString("candidate")
                val sdpMid = candObj.optString("sdpMid", "0")
                val sdpMLineIndex = candObj.optInt("sdpMLineIndex", 0)
                if (candidate.isNotEmpty()) {
                    listener.onIceCandidate(sdpMid, sdpMLineIndex, candidate)
                }
            }
            "rtc:restart" -> {
                listener.onRtcRestartRequested()
            }
            "camera:settings" -> {
                val patch = msg.optJSONObject("settings") ?: return
                listener.onRemoteSettingsChanged(patch)
            }
            "camera:request-capture" -> {
                listener.onRemoteCaptureRequested()
            }
        }
    }

    private fun scheduleReconnect() {
        if (closedManually) return
        reconnectAttempt += 1
        val delayMs = min(8000L, (1000.0 * 1.6.pow((reconnectAttempt - 1).toDouble())).toLong())
        mainHandler.post { listener.onReconnecting(reconnectAttempt) }
        val runnable = Runnable { openSocket() }
        reconnectRunnable = runnable
        mainHandler.postDelayed(runnable, delayMs)
    }
}
