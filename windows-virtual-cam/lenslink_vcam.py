"""
LensLink Windows Virtual Camera Bridge
--------------------------------------
Connects to the LensLink signaling server as a virtual camera receiver and
outputs incoming frames directly to a Windows Virtual Camera device
(OBS Virtual Camera or Unity Capture via pyvirtualcam).

Uses a decoupled latest-frame pump so virtual camera output stays smooth and
low-latency without accumulating WebSocket frame lag.
"""

import argparse
import asyncio
import json
import sys
import threading
import time
from io import BytesIO

import cv2
import numpy as np
import pyvirtualcam
import websockets
from PIL import Image


def normalize_ws_url(raw_url: str) -> str:
    url = raw_url.strip().rstrip("/")
    if url.startswith("https://"):
        url = "wss://" + url[8:]
    elif url.startswith("http://"):
        url = "ws://" + url[7:]
    elif not (url.startswith("ws://") or url.startswith("wss://")):
        url = "ws://" + url
    return url


def build_idle_frame(width: int, height: int, code: str) -> np.ndarray:
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    cv2.putText(
        frame,
        f"LensLink Virtual Camera - Waiting for code {code}",
        (max(24, width // 12), height // 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.75,
        (200, 210, 225),
        2,
        cv2.LINE_AA,
    )
    return frame


async def run_bridge(server_url: str, pairing_code: str, width: int, height: int, fps: int, backend: str | None):
    code = pairing_code.strip().upper()
    base_ws = normalize_ws_url(server_url)
    ws_url = f"{base_ws}/ws?role=vcam&code={code}"
    print(f"[LensLink VCam] Connecting to {ws_url} ...")

    cam_kwargs = {"width": width, "height": height, "fps": fps, "fmt": pyvirtualcam.PixelFormat.RGB}
    if backend:
        cam_kwargs["backend"] = backend

    try:
        cam = pyvirtualcam.Camera(**cam_kwargs)
    except Exception as cam_err:
        print(f"[LensLink VCam] ERROR opening virtual camera driver: {cam_err}")
        print("[LensLink VCam] Tips:")
        print("  1. Make sure OBS Studio v26+ or Unity Capture is installed.")
        print("  2. If OBS Studio already has its Virtual Camera active, stop OBS Virtual Camera first")
        print("     (or use OBS Browser Source from the LensLink Virtual Webcam tab instead).")
        print("  3. Or run with --backend unitycapture if Unity Capture is installed.")
        sys.exit(1)

    idle_frame = build_idle_frame(width, height, code)
    frame_lock = threading.Lock()
    state = {
        "latest_frame": idle_frame,
        "last_frame_time": 0.0,
        "stop": False,
    }

    def output_pump():
        while not state["stop"]:
            now = time.perf_counter()
            with frame_lock:
                last_t = state["last_frame_time"]
                frame_to_send = idle_frame if (last_t == 0.0 or now - last_t > 5.0) else state["latest_frame"]
            try:
                cam.send(frame_to_send)
                cam.sleep_until_next_frame()
            except Exception as pump_err:
                print(f"[LensLink VCam] Output warning: {pump_err}")
                time.sleep(0.05)

    pump_thread = threading.Thread(target=output_pump, daemon=True)
    pump_thread.start()

    print(f"[LensLink VCam] Virtual webcam active: {cam.device} ({width}x{height} @ {fps}fps)")
    print("[LensLink VCam] Select this camera in Zoom, Google Meet, Microsoft Teams, or OBS.")

    try:
        while True:
            try:
                async with websockets.connect(
                    ws_url,
                    max_size=8 * 1024 * 1024,
                    ping_interval=15,
                    ping_timeout=10,
                ) as ws:
                    print(f"[LensLink VCam] Joined room {code}. Waiting for frames from PC Receiver...")
                    await ws.send(json.dumps({"type": "vcam:bridge-toggle", "code": code, "enabled": True}))

                    async for message in ws:
                        if isinstance(message, bytes):
                            try:
                                img = Image.open(BytesIO(message)).convert("RGB")
                                frame = np.asarray(img)
                                if frame.shape[1] != width or frame.shape[0] != height:
                                    frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_LINEAR)
                                with frame_lock:
                                    state["latest_frame"] = frame
                                    state["last_frame_time"] = time.perf_counter()
                            except Exception as decode_err:
                                print(f"[LensLink VCam] Frame decode warning: {decode_err}")
                        else:
                            try:
                                data = json.loads(message)
                                if data.get("type") == "room:error":
                                    print(f"[LensLink VCam] Room error: {data.get('message')}")
                            except Exception:
                                pass

            except (OSError, websockets.WebSocketException) as conn_err:
                print(f"[LensLink VCam] Connection interrupted ({conn_err}). Reconnecting in 2s...")
                with frame_lock:
                    state["last_frame_time"] = 0.0
                await asyncio.sleep(2)
    finally:
        state["stop"] = True
        pump_thread.join(timeout=1.5)
        cam.close()


def main():
    parser = argparse.ArgumentParser(description="LensLink Windows Virtual Camera Bridge")
    parser.add_argument("--code", required=True, help="6-character pairing code shown in LensLink PC Receiver")
    parser.add_argument("--server", default="ws://127.0.0.1:3000", help="LensLink server URL (ws:// or wss://)")
    parser.add_argument("--width", type=int, default=1280, help="Virtual camera output width")
    parser.add_argument("--height", type=int, default=720, help="Virtual camera output height")
    parser.add_argument("--fps", type=int, default=30, help="Virtual camera target frame rate")
    parser.add_argument("--backend", default=None, help="Optional pyvirtualcam backend (obs or unitycapture)")
    args = parser.parse_args()

    try:
        asyncio.run(run_bridge(args.server, args.code, args.width, args.height, args.fps, args.backend))
    except KeyboardInterrupt:
        print("\n[LensLink VCam] Stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
