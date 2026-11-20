# LensLink Wireless Webcam — Windows Virtual Camera Driver & Signing Guide

## 1. Architecture Overview
`LensLink Wireless Webcam` exposes a real, system-level Windows DirectShow Video Capture Source Filter (`LensLinkVirtualCam.ax`) registered under `CLSID_VideoInputDeviceCategory`.

Because it registers as a standard Windows camera capture device, it appears automatically as **`LensLink Wireless Webcam`** inside:
- Google Meet (Chrome / Edge / Firefox)
- Zoom Desktop
- Microsoft Teams Desktop & Web
- WhatsApp Desktop
- OBS Studio & Streamlabs
- VLC Media Player & Windows Camera

The LensLink Windows Desktop Client (`client/lenslink_windows_client.py`) decodes the live smartphone WebRTC H.264 stream over local Wi-Fi and writes synchronized RGB24 frames into Windows Shared Memory (`Local\LensLinkWirelessWebcamFrameBuffer`) protected by a named mutex (`Local\LensLinkWirelessWebcamMutex`).

## 2. Building `LensLinkVirtualCam.ax` (64-bit Windows)
Prerequisites:
- Visual Studio 2022 (Desktop Development with C++)
- Windows 10/11 SDK
- Microsoft DirectShow BaseClasses (`strmbase.lib` + `streams.h`)

```powershell
cd driver
cmake -B build -A x64 -DDIRECTSHOW_BASECLASSES_DIR="C:/path/to/directshow/baseclasses"
cmake --build build --config Release
```

Output binary: `driver/build/Release/LensLinkVirtualCam.ax`

## 3. Code Signing & Production Distribution
- **User-mode DirectShow COM filters (`.ax`)** do not require kernel-mode WHQL attestation, making them immediately installable on standard Windows 10/11 machines without enabling Test Mode.
- For zero Windows SmartScreen warnings in enterprise/public distribution, sign both `LensLinkVirtualCam.ax` and the compiled Inno Setup installer (`LensLink_Wireless_Webcam_Setup_2.0.0.exe`) with an EV Code Signing Certificate:
  ```powershell
  signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a driver\build\Release\LensLinkVirtualCam.ax
  signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a LensLink_Wireless_Webcam_Setup_2.0.0.exe
  ```

## 4. Registering & Clean Uninstallation
- **Install / Register (Admin)**:
  `regsvr32 /s LensLinkVirtualCam.ax` (or run `Install_LensLink_Webcam.bat`)
- **Uninstall / Remove (Admin)**:
  `regsvr32 /u /s LensLinkVirtualCam.ax` (or run `Uninstall_LensLink_Webcam.bat`)
  Immediately removes **`LensLink Wireless Webcam`** from all Windows camera device lists.

## 5. Optional Virtual Microphone Routing
To expose your smartphone's microphone to Zoom, Teams, or Meet as an independent Windows input device:
1. Enable **Phone Microphone** in the LensLink Desktop or Mobile interface.
2. Install **VB-CABLE Virtual Audio Device** (free standard Windows virtual audio driver) and select `CABLE Input` as the LensLink Audio Output device.
3. Select `CABLE Output (VB-Audio Virtual Cable)` as your microphone inside Meet, Zoom, Teams, or OBS.
