# LensLink Cam — Native Android App

Native Kotlin Android application (`com.lenslink.cam`) for turning any Android smartphone (Android 8.0 / API 26+) into a wireless webcam for the LensLink Windows PC Receiver.

## Features
- **Instant QR Pairing**: Built-in CameraX + ML Kit QR scanner reads both the PC's server URL and dynamic 6-character pairing code.
- **Native WebRTC + Camera2 Pipeline**: Low-latency local Wi-Fi video streaming (`ws://` and `wss://` supported out of the box) with automatic reconnection.
- **Gesture Controls**:
  - **Long-press & slide up/down** anywhere on the viewfinder to raise or lower brightness (`-50%` to `+50%`).
  - **Pinch-to-zoom** (`1.0x`–`6.0x`).
  - **Tap-to-focus** reticle.
- **Full Camera Controls**: Switch front/rear & multi-rear lenses, toggle flashlight, adjust resolution (`480p` / `720p` / `1080p`), frame rate (`15` / `30` / `60` fps), High-Contrast B&W, and capture snapshots directly to your PC.

## Build APK in Android Studio
1. Open the `LensLink-Android` folder in **Android Studio** (Ladybug or newer).
2. Let Gradle sync dependencies automatically.
3. Connect your Android phone via USB (or Wireless Debugging) and click **Run ▶**, or select **Build → Build Bundle(s) / APK(s) → Build APK(s)** to export `app-debug.apk`.
