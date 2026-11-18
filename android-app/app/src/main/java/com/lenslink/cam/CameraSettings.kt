package com.lenslink.cam

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

data class CameraDeviceSummary(
    val deviceId: String,
    val label: String,
    val shortLabel: String,
    val facing: String
)

data class CameraSettings(
    val facingMode: String = "environment",
    val deviceId: String? = null,
    val resolution: String = "1080p",
    val frameRate: Int = 30,
    val zoom: Float = 1.0f,
    val brightness: Int = 0,
    val grayscale: Boolean = false,
    val mirror: Boolean = false
) {
    fun targetDimensions(): Pair<Int, Int> {
        return when (resolution) {
            "480p" -> 854 to 480
            "720p" -> 1280 to 720
            else -> 1920 to 1080
        }
    }

    fun toJson(): JSONObject {
        return JSONObject().apply {
            put("facingMode", facingMode)
            if (deviceId != null) put("deviceId", deviceId)
            put("resolution", resolution)
            put("frameRate", frameRate)
            put("zoom", zoom.toDouble())
            put("digitalZoom", 1.0)
            put("brightness", brightness)
            put("grayscale", grayscale)
            put("mirror", mirror)
        }
    }
}

data class QrPairingResult(
    val pairCode: String,
    val serverOrigin: String?
)

object PairingParser {
    private val CODE_REGEX = Regex("^[A-Z0-9]{6}$", RegexOption.IGNORE_CASE)

    fun parseQrPayload(raw: String): QrPairingResult? {
        val trimmed = raw.trim()
        if (CODE_REGEX.matches(trimmed)) {
            return QrPairingResult(trimmed.uppercase(), null)
        }
        return try {
            val uri = Uri.parse(trimmed)
            val param = uri.getQueryParameter("pair") ?: uri.getQueryParameter("code")
            if (param != null && CODE_REGEX.matches(param.trim())) {
                val scheme = uri.scheme
                val authority = uri.encodedAuthority
                val origin = if (!scheme.isNullOrBlank() && !authority.isNullOrBlank()) {
                    "$scheme://$authority"
                } else {
                    null
                }
                QrPairingResult(param.trim().uppercase(), origin)
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    fun buildWebSocketUrl(serverOrigin: String): String {
        val normalized = serverOrigin.trim().trimEnd('/')
        val wsBase = when {
            normalized.startsWith("https://", ignoreCase = true) ->
                "wss://" + normalized.substring(8)
            normalized.startsWith("http://", ignoreCase = true) ->
                "ws://" + normalized.substring(7)
            normalized.startsWith("wss://", ignoreCase = true) ||
                normalized.startsWith("ws://", ignoreCase = true) -> normalized
            else -> "ws://$normalized"
        }
        return "$wsBase/ws"
    }

    fun devicesToCapabilitiesJson(devices: List<CameraDeviceSummary>): JSONObject {
        val arr = JSONArray()
        for (dev in devices) {
            arr.put(
                JSONObject().apply {
                    put("deviceId", dev.deviceId)
                    put("label", dev.label)
                    put("shortLabel", dev.shortLabel)
                    put("facing", dev.facing)
                }
            )
        }
        return JSONObject().apply {
            put("devices", arr)
            put("zoom", JSONObject().apply {
                put("min", 1.0)
                put("max", 6.0)
                put("step", 0.1)
            })
            put("brightness", JSONObject().apply {
                put("min", -50)
                put("max", 50)
                put("step", 1)
            })
        }
    }
}
