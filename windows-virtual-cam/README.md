# LensLink Windows Virtual Camera Component

This standalone component exposes your wirelessly connected smartphone camera as a native Windows virtual webcam device so it can be selected in **Zoom**, **Google Meet**, **Microsoft Teams**, **Discord**, and other video conferencing apps.

## Option 1: Native Windows Virtual Webcam Bridge (DirectShow / OBS Driver)

1. Ensure a Windows virtual camera driver is installed:
   - **Recommended:** Install [OBS Studio](https://obsproject.com/) (v26+ includes the signed **OBS Virtual Camera** driver automatically; you do not need to keep OBS open when using the bridge), **or** install [Unity Capture](https://github.com/schellingb/UnityCapture).
2. Extract this folder and double-click `start_virtual_cam.bat` (requires Python 3.10+).
3. Enter the 6-character pairing code shown in the LensLink PC Receiver window.
4. In the LensLink PC Receiver, open the **Virtual Webcam** tab and enable **Direct Bridge Stream**.
5. Open Zoom, Microsoft Teams, or Google Meet and select **OBS Virtual Camera** (or **Unity Video Capture**) as your camera.

## Option 2: Zero-Python OBS Browser Source

1. In the LensLink PC Receiver **Virtual Webcam** tab, copy the **Chromeless Output URL** (`/vcam?pair=XXXXXX`).
2. In OBS Studio, add a **Browser** source, paste the URL, set width `1280` × height `720` (or `1920` × `1080`).
3. Click **Start Virtual Camera** in OBS Studio.
4. Select **OBS Virtual Camera** in Zoom, Teams, or Google Meet.
