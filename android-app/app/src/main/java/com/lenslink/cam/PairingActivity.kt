package com.lenslink.cam

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.lenslink.cam.databinding.ActivityPairingBinding

class PairingActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPairingBinding
    private var pendingAction: (() -> Unit)? = null

    private val prefs by lazy {
        getSharedPreferences("lenslink_prefs", MODE_PRIVATE)
    }

    private val requestCameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                binding.tvPairingError.visibility = View.GONE
                pendingAction?.invoke()
            } else {
                showError("Camera permission is required to scan QR codes and stream video.")
            }
            pendingAction = null
        }

    private val qrLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == RESULT_OK && result.data != null) {
                val code = result.data?.getStringExtra(QrScannerActivity.EXTRA_PAIR_CODE).orEmpty()
                val origin = result.data?.getStringExtra(QrScannerActivity.EXTRA_SERVER_ORIGIN)
                if (!origin.isNullOrBlank()) {
                    binding.etServerUrl.setText(origin)
                    prefs.edit().putString("server_url", origin).apply()
                }
                if (code.length == 6) {
                    binding.etPairCode.setText(code)
                    launchCameraWithPermission(origin ?: currentServerUrl(), code)
                }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPairingBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val savedUrl = prefs.getString("server_url", null)
        if (!savedUrl.isNullOrBlank()) {
            binding.etServerUrl.setText(savedUrl)
        }

        binding.btnScanQr.setOnClickListener {
            withCameraPermission {
                qrLauncher.launch(Intent(this, QrScannerActivity::class.java))
            }
        }

        binding.btnConnect.setOnClickListener {
            val serverUrl = currentServerUrl()
            val code = binding.etPairCode.text?.toString()?.trim()?.uppercase().orEmpty()
            if (!Regex("^[A-Z0-9]{6}$").matches(code)) {
                showError("Enter the 6-character pairing code shown on your PC.")
                return@setOnClickListener
            }
            if (serverUrl.isBlank()) {
                showError("Enter the PC Server URL shown in LensLink (e.g. http://192.168.1.100:3000).")
                return@setOnClickListener
            }
            prefs.edit().putString("server_url", serverUrl).apply()
            launchCameraWithPermission(serverUrl, code)
        }
    }

    private fun currentServerUrl(): String {
        return binding.etServerUrl.text?.toString()?.trim().orEmpty()
    }

    private fun launchCameraWithPermission(serverUrl: String, pairCode: String) {
        withCameraPermission {
            val intent = Intent(this, CameraActivity::class.java).apply {
                putExtra(CameraActivity.EXTRA_SERVER_URL, serverUrl)
                putExtra(CameraActivity.EXTRA_PAIR_CODE, pairCode)
            }
            startActivity(intent)
        }
    }

    private fun withCameraPermission(action: () -> Unit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            action()
        } else {
            pendingAction = action
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun showError(msg: String) {
        binding.tvPairingError.text = msg
        binding.tvPairingError.visibility = View.VISIBLE
    }
}
