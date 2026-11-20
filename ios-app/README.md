# LensLink Wireless Webcam — Native iOS Application (SwiftUI + AVFoundation)

## Features
- **Zero-Config Local Wi-Fi Auto-Discovery** via Apple Bonjour (`NWBrowser` for `_lenslink-webcam._tcp`).
- **Native AVFoundation Multi-Lens Capture** (Triple/Dual/Ultra-Wide/Telephoto/Front, 480p / 720p / 1080p / 4K, 24 / 30 / 60 FPS).
- **Hardware Controls**: Tap-to-focus, optical zoom, torch/flashlight, optional microphone audio, and OLED screen-dimming mode.
- **Live Device Monitoring**: Real battery percentage (`UIDevice.batteryLevel`) and thermal state (`ProcessInfo.thermalState`).

## Build in Xcode
1. Open Xcode 15+ and create a new iOS App target (`SwiftUI`, Bundle ID `com.lenslink.wirelesswebcam`, Deployment Target iOS 16.0+).
2. Add the Swift files from `Sources/` and copy the permission keys from `Info.plist`.
3. Add `WebRTC-lib` via Swift Package Manager if streaming directly to the LensLink Windows Desktop Client over WebRTC.
4. Build and run on your iPhone connected to the same Wi-Fi network as your Windows PC.
