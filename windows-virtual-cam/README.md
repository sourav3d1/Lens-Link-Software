# LensLink Windows Virtual Camera Component (No OBS Required)

This standalone package exposes your paired smartphone camera as a native Windows virtual webcam device so you can select it in **Zoom**, **Microsoft Teams**, **Google Meet**, **Discord**, **Windows Camera**, and other desktop or browser apps — **without installing OBS Studio**.

## Quick Setup (Zero OBS Studio)

1. Extract this folder anywhere on your Windows PC.
2. Double-click **`Install_Driver_No_OBS.bat`** (accept the single Windows Administrator prompt to register the lightweight DirectShow virtual camera driver `Unity Video Capture`).
3. Double-click **`start_virtual_cam.bat`** (requires Python 3.10+). It will automatically verify dependencies and ask for your 6-character LensLink Pairing Code.
4. Keep the **LensLink PC Receiver** window open on your PC (Bridge Frame Relay enables automatically).
5. Open **Zoom**, **Microsoft Teams**, **Google Meet**, or **Windows Camera** and select **`Unity Video Capture`** as your camera.

> **Using only browser apps (Google Meet, Zoom Web, Teams Web, BIS Portal)?**
> You don't even need Python or DirectShow drivers — download the **LensLink Browser Virtual Webcam** Chrome/Edge extension from the Virtual Webcam tab in LensLink PC Receiver!
