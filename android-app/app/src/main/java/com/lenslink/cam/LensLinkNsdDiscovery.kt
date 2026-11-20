package com.lenslink.cam

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.BatteryManager

data class DiscoveredLensLinkPc(
    val pcName: String,
    val hostIp: String,
    val port: Int,
    val roomCode: String
)

data class AndroidBatteryStatus(
    val percentage: Int,
    val temperatureC: Float,
    val charging: Boolean
)

/**
 * Automatic local Wi-Fi PC discovery via Android NsdManager (_lenslink-webcam._tcp.)
 * plus real hardware battery percentage & temperature telemetry.
 */
class LensLinkNsdDiscovery(
    private val context: Context,
    private val onPcDiscovered: (DiscoveredLensLinkPc) -> Unit,
    private val onPcLost: (String) -> Unit
) {
    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    fun startDiscovery() {
        stopDiscovery()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {}
            override fun onServiceFound(service: NsdServiceInfo) {
                if (service.serviceType.contains("_lenslink-webcam")) {
                    @Suppress("DEPRECATION")
                    nsdManager.resolveService(service, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
                        override fun onServiceResolved(resolved: NsdServiceInfo) {
                            val ip = resolved.host?.hostAddress ?: return
                            val attrs = resolved.attributes
                            val pcName = attrs["pcName"]?.toString(Charsets.UTF_8) ?: resolved.serviceName
                            val roomCode = attrs["roomCode"]?.toString(Charsets.UTF_8) ?: ""
                            onPcDiscovered(
                                DiscoveredLensLinkPc(
                                    pcName = pcName,
                                    hostIp = ip,
                                    port = resolved.port,
                                    roomCode = roomCode
                                )
                            )
                        }
                    })
                }
            }

            override fun onServiceLost(service: NsdServiceInfo) {
                onPcLost(service.serviceName)
            }

            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                stopDiscovery()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                stopDiscovery()
            }
        }
        discoveryListener = listener
        nsdManager.discoverServices("_lenslink-webcam._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
    }

    fun stopDiscovery() {
        discoveryListener?.let {
            try {
                nsdManager.stopServiceDiscovery(it)
            } catch (_: Exception) {
            }
        }
        discoveryListener = null
    }

    companion object {
        fun readBatteryTelemetry(context: Context): AndroidBatteryStatus {
            val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            val tempTenths = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val pct = if (level >= 0 && scale > 0) (level * 100) / scale else 100
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
            return AndroidBatteryStatus(
                percentage = pct,
                temperatureC = tempTenths / 10f,
                charging = charging
            )
        }
    }
}
