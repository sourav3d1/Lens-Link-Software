"""
LensLink Windows Virtual Camera Bridge
--------------------------------------
Connects to the local LensLink signaling server as a virtual camera receiver
and outputs incoming frames directly to a Windows Virtual Camera device
(OBS Virtual Camera or Unity Capture via pyvirtualcam).

Apps such as Zoom, Google Meet, Microsoft Teams, Discord, and OBS Studio
can then select the virtual camera as a standard webcam input.
"""

import argparse
import asyncio
import json
import sys
import time
from io import BytesIO

import cv2
import numpy as np
import pyvirtualcam
import websockets
from PIL import Image


async def run_bridge(server_url: str, pairing_code: str, width: int, height: int, fps: int, backend: str | None):
    code = pairing_code.strip().upper()
    ws_url = f"{server_url.rstrip('/')}/ws?role=vcam&code={code}"
    print(f"[LensLink VCam] Connecting to {ws_url} ...")

    cam_kwargs = {"width": width, "height": height, "fps": fps, "fmt": pyvirtualcam.PixelFormat.RGB}
    if backend:
        cam_kwargs["backend"] = backend

    with pyvirtualcam.Camera(**cam_kwargs) as cam:
        print(f"[LensLink VCam] Virtual webcam active: {cam.device} ({width}x{height} @ {fps}fps)")
        print("[LensLink VCam] Select this camera in Zoom, Google Meet, or Microsoft Teams.")

        # Idle frame shown before the smartphone starts streaming
        idle_frame = np.zeros((height, width, 3), dtype=np.uint8)
        cv2.putText(
            idle_frame,
            f"LensLink Virtual Camera - Waiting for code {code}",
            (40, height // 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (200, 210, 225),
            2,
            cv2.LINE_AA,
        )
        cam.send(idle_frame)

        while True:
            try:
                async with websockets.connect(ws_url, max_size=8 * 1024 * 1024) as ws:
                    print(f"[LensLink VCam] Joined room {code}. Waiting for frames from PC Receiver...")
                    await ws.send(json.dumps({"type": "vcam:bridge-toggle", "code": code, "enabled": True}))

                    last_frame_time = time.perf_counter()
                    async for message in ws:
                        if isinstance(message, bytes):
                            try:
                                img = Image.open(BytesIO(message)).convert("RGB")
                                frame = np.asarray(img)
                                if frame.shape[1] != width or frame.shape[0] != height:
                                    frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_LINEAR)
                                cam.send(frame)
                                cam.sleep_until_next_frame()
                                last_frame_time = time.perf_counter()
                            except Exception as decode_err:
                                print(f"[LensLink VCam] Frame decode warning: {decode_err}")
                        else:
                            try:
                                data = json.loads(message)
                                if data.get("type") == "room:error":
                                    print(f"[LensLink VCam] Room error: {data.get('message')}")
                            except Exception:
                                pass

                        if time.perf_counter() - last_frame_time > 15:
                            cam.send(idle_frame)

            except (OSError, websockets.WebSocketException) as conn_err:
                print(f"[LensLink VCam] Connection interrupted ({conn_err}). Reconnecting in 2s...")
                cam.send(idle_frame)
                await asyncio.sleep(2)


def main():
    parser = argparse.ArgumentParser(description="LensLink Windows Virtual Camera Bridge")
    parser.add_argument("--code", required=True, help="6-character pairing code shown in LensLink PC Receiver")
    parser.add_argument("--server", default="ws://127.0.0.1:3000", help="Local LensLink server WebSocket URL")
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
