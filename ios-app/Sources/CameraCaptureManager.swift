import AVFoundation
import UIKit

enum LensLinkResolution: String, CaseIterable {
    case p480 = "480p"
    case p720 = "720p"
    case p1080 = "1080p"
    case p4k = "4K"

    var preset: AVCaptureSession.Preset {
        switch self {
        case .p480: return .vga640x480
        case .p720: return .hd1280x720
        case .p1080: return .hd1920x1080
        case .p4k: return .hd4K3840x2160
        }
    }
}

final class CameraCaptureManager: NSObject, ObservableObject {
    let session = AVCaptureSession()
    @Published var activeResolution: LensLinkResolution = .p1080
    @Published var targetFps: Int = 30
    @Published var zoomFactor: CGFloat = 1.0
    @Published var torchEnabled: Bool = false
    @Published var micEnabled: Bool = false
    @Published var isDimmed: Bool = false
    @Published var batteryPercent: Int = 100
    @Published var thermalLabel: String = "Nominal"

    private var activeDevice: AVCaptureDevice?
    private let sessionQueue = DispatchQueue(label: "com.lenslink.camera.session")

    override init() {
        super.init()
        UIDevice.current.isBatteryMonitoringEnabled = true
        refreshDeviceTelemetry()
    }

    func startCamera(position: AVCaptureDevice.Position = .back) {
        sessionQueue.async {
            self.session.beginConfiguration()
            self.session.sessionPreset = self.activeResolution.preset
            self.session.inputs.forEach { self.session.removeInput($0) }

            let deviceTypes: [AVCaptureDevice.DeviceType] = [
                .builtInTripleCamera,
                .builtInDualWideCamera,
                .builtInWideAngleCamera,
                .builtInUltraWideCamera,
                .builtInTelephotoCamera
            ]
            let discovery = AVCaptureDevice.DiscoverySession(
                deviceTypes: deviceTypes,
                mediaType: .video,
                position: position
            )
            if let device = discovery.devices.first,
               let input = try? AVCaptureDeviceInput(device: device),
               self.session.canAddInput(input) {
                self.session.addInput(input)
                self.activeDevice = device
                self.configureFrameRate(device: device, fps: self.targetFps)
            }
            self.session.commitConfiguration()
            if !self.session.isRunning {
                self.session.startRunning()
            }
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = true
            }
        }
    }

    func setResolution(_ resolution: LensLinkResolution) {
        activeResolution = resolution
        sessionQueue.async {
            guard self.session.canSetSessionPreset(resolution.preset) else { return }
            self.session.beginConfiguration()
            self.session.sessionPreset = resolution.preset
            self.session.commitConfiguration()
        }
    }

    func setZoom(_ factor: CGFloat) {
        zoomFactor = factor
        sessionQueue.async {
            guard let device = self.activeDevice else { return }
            try? device.lockForConfiguration()
            let clamped = max(1.0, min(factor, device.activeFormat.videoMaxZoomFactor))
            device.videoZoomFactor = clamped
            device.unlockForConfiguration()
        }
    }

    func setTorch(_ on: Bool) {
        torchEnabled = on
        sessionQueue.async {
            guard let device = self.activeDevice, device.hasTorch else { return }
            try? device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
        }
    }

    func tapToFocus(point: CGPoint) {
        sessionQueue.async {
            guard let device = self.activeDevice, device.isFocusPointOfInterestSupported else { return }
            try? device.lockForConfiguration()
            device.focusPointOfInterest = point
            device.focusMode = .continuousAutoFocus
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = point
                device.exposureMode = .continuousAutoExposure
            }
            device.unlockForConfiguration()
        }
    }

    private func configureFrameRate(device: AVCaptureDevice, fps: Int) {
        try? device.lockForConfiguration()
        let duration = CMTime(value: 1, timescale: CMTimeScale(fps))
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
        device.unlockForConfiguration()
    }

    func refreshDeviceTelemetry() {
        let level = UIDevice.current.batteryLevel
        batteryPercent = level >= 0 ? Int(level * 100) : 100
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermalLabel = "Nominal"
        case .fair: thermalLabel = "Warm"
        case .serious, .critical: thermalLabel = "Elevated"
        @unknown default: thermalLabel = "Nominal"
        }
    }
}
