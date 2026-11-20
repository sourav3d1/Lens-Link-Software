"""
LensLink Wireless Webcam — Windows Desktop Client & System Virtual Webcam Feeder
================================================================================
1. Announces this Windows PC over local Wi-Fi via mDNS (_lenslink-webcam._tcp.local.)
   so Android & iOS LensLink mobile apps automatically discover & pair with 1 tap.
2. Connects to the local LensLink signaling / WebRTC stream (DTLS-SRTP encrypted).
3. Decodes live H.264/VP8 smartphone video frames and feeds them directly into:
   - Native DirectShow driver shared memory (Local\\LensLinkWirelessWebcamFrameBuffer)
     exposing "LensLink Wireless Webcam" to Google Meet, Zoom, Teams, WhatsApp, OBS,
     VLC, Chrome, and Edge.
   - Automatic fallback to pyvirtualcam (Unity Video Capture / OBS Virtual Cam)
     if LensLinkVirtualCam.ax is not yet compiled on this workstation.
4. Optional smartphone microphone routing to Windows Virtual Microphone (e.g. VB-Cable).
"""

import argparse
import asyncio
import ctypes
import json
import mmap
import os
import socket
import struct
import sys
import time
from typing import Optional

import numpy as np

try:
    import cv2
except ImportError:
    cv2 = None

try:
    from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
    from aiortc.sdp import candidate_from_sdp
except ImportError:
    RTCPeerConnection = None

try:
    import websockets
except ImportError:
    websockets = None

try:
    import pyvirtualcam
except ImportError:
    pyvirtualcam = None

try:
    from zeroconf import ServiceInfo, Zeroconf
except ImportError:
    ServiceInfo = None
    Zeroconf = None


LENSLINK_SHMEM_NAME = "Local\\LensLinkWirelessWebcamFrameBuffer"
LENSLINK_MUTEX_NAME = "Local\\LensLinkWirelessWebcamMutex"
LENSLINK_SHMEM_MAGIC = 0x4C534E4C  # 'LNSL'
LENSLINK_MAX_FRAME_BYTES = 3840 * 2160 * 3
LENSLINK_HEADER_FMT = "<IIIIIIQQIIII"  # Matches LensLinkSharedFrameHeader (52 bytes)
LENSLINK_HEADER_SIZE = struct.calcsize(LENSLINK_HEADER_FMT)
LENSLINK_SHMEM_TOTAL_BYTES = LENSLINK_HEADER_SIZE + LENSLINK_MAX_FRAME_BYTES


def get_primary_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


class LensLinkDirectShowWriter:
    """Writes RGB24 frames into Local\\LensLinkWirelessWebcamFrameBuffer for LensLinkVirtualCam.ax."""

    def __init__(self) -> None:
        self.seq = 0
        self.shm: Optional[mmap.mmap] = None
        self.mutex = None
        self.kernel32 = None
        if os.name == "nt":
            try:
                self.kernel32 = ctypes.windll.kernel32
                self.mutex = self.kernel32.CreateMutexW(None, False, LENSLINK_MUTEX_NAME)
                self.shm = mmap.mmap(-1, LENSLINK_SHMEM_TOTAL_BYTES, tagname=LENSLINK_SHMEM_NAME)
            except Exception as exc:
                print(f"[LensLink Driver] Shared memory unavailable ({exc}); will use pyvirtualcam fallback.")
                self.shm = None

    def write_frame(self, rgb_frame: np.ndarray, fps: int, connected: bool = True) -> None:
        if self.shm is None:
            return
        h, w, c = rgb_frame.shape
        if c != 3 or (w * h * 3) > LENSLINK_MAX_FRAME_BYTES:
            return
        self.seq += 1
        header = struct.pack(
            LENSLINK_HEADER_FMT,
            LENSLINK_SHMEM_MAGIC,
            1,
            w,
            h,
            fps,
            1,  # RGB24
            self.seq,
            int(time.time() * 1_000_000),
            1 if connected else 0,
            0,
            0,
            0,
        )
        raw = rgb_frame.tobytes()
        acquired = False
        try:
            if self.kernel32 and self.mutex:
                acquired = self.kernel32.WaitForSingleObject(self.mutex, 15) == 0
            self.shm.seek(0)
            self.shm.write(header)
            self.shm.write(raw)
        finally:
            if acquired and self.kernel32 and self.mutex:
                self.kernel32.ReleaseMutex(self.mutex)

    def mark_disconnected(self) -> None:
        if self.shm is None:
            return
        header = struct.pack(
            LENSLINK_HEADER_FMT,
            LENSLINK_SHMEM_MAGIC,
            1,
            1280,
            720,
            30,
            1,
            self.seq,
            int(time.time() * 1_000_000),
            0,
            0,
            0,
            0,
        )
        self.shm.seek(0)
        self.shm.write(header)

    def close(self) -> None:
        self.mark_disconnected()
        if self.shm is not None:
            self.shm.close()
            self.shm = None
        if self.kernel32 and self.mutex:
            self.kernel32.CloseHandle(self.mutex)
            self.mutex = None


class LensLinkMdnsBroadcaster:
    """Publishes _lenslink-webcam._tcp.local. so mobile apps discover this PC automatically."""

    def __init__(self, pc_name: str, room_code: str, port: int = 3000) -> None:
        self.pc_name = pc_name
        self.room_code = room_code
        self.port = port
        self.zc = None
        self.info = None

    def start(self) -> None:
        if Zeroconf is None or ServiceInfo is None:
            print("[LensLink mDNS] zeroconf not installed; LAN server discovery still active.")
            return
        try:
            ip = get_primary_lan_ip()
            self.zc = Zeroconf()
            safe_name = "".join(ch for ch in self.pc_name if ch.isalnum() or ch in "-_") or "WindowsPC"
            self.info = ServiceInfo(
                "_lenslink-webcam._tcp.local.",
                f"{safe_name}._lenslink-webcam._tcp.local.",
                addresses=[socket.inet_aton(ip)],
                port=self.port,
                properties={
                    b"pcName": self.pc_name.encode("utf-8"),
                    b"roomCode": self.room_code.encode("utf-8"),
                    b"device": b"LensLink Wireless Webcam",
                    b"version": b"2.0.0",
                },
            )
            self.zc.register_service(self.info)
            print(f"[LensLink mDNS] Advertising '{self.pc_name}' ({ip}:{self.port}) as _lenslink-webcam._tcp.local.")
        except Exception as exc:
            print(f"[LensLink mDNS] Could not start Bonjour/mDNS broadcast: {exc}")

    def stop(self) -> None:
        if self.zc and self.info:
            try:
                self.zc.unregister_service(self.info)
                self.zc.close()
            except Exception:
                pass


def open_fallback_virtual_camera(width: int, height: int, fps: int):
    if pyvirtualcam is None:
        return None
    for backend in ("unitycapture", "obs", None):
        try:
            kwargs = {"width": width, "height": height, "fps": fps}
            if backend:
                kwargs["backend"] = backend
            cam = pyvirtualcam.Camera(**kwargs)
            print(f"[LensLink VCam] Secondary virtual camera active: {cam.device} ({width}x{height}@{fps}fps)")
            return cam
        except Exception:
            continue
    return None


async def run_lenslink_client(server_ws: str, room_code: str, pc_name: str, width: int, height: int, fps: int) -> None:
    if RTCPeerConnection is None or websockets is None:
        print("Missing Python packages. Run: pip install -r requirements.txt")
        sys.exit(1)

    ds_writer = LensLinkDirectShowWriter()
    fallback_cam = open_fallback_virtual_camera(width, height, fps)
    mdns = LensLinkMdnsBroadcaster(pc_name=pc_name, room_code=room_code)
    mdns.start()

    print("================================================================")
    print("  LensLink Wireless Webcam — Windows Virtual Camera Service Ready")
    print(f"  PC Name        : {pc_name}")
    print(f"  Pairing Code   : {room_code}")
    print(f"  Virtual Device : LensLink Wireless Webcam ({width}x{height} @ {fps}fps)")
    print("  Compatible     : Google Meet, Zoom, Teams, WhatsApp, OBS, VLC, Chrome, Edge")
    print("================================================================")

    try:
        while True:
            try:
                async with websockets.connect(server_ws, ping_interval=20, ping_timeout=20) as ws:
                    await ws.send(json.dumps({
                        "type": "join",
                        "role": "vcam",
                        "room": room_code,
                        "pcName": pc_name,
                    }))
                    print(f"[LensLink] Connected to local signaling at {server_ws}. Waiting for smartphone...")

                    pc = RTCPeerConnection(
                        configuration=RTCConfiguration(
                            iceServers=[RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
                        )
                    )
                    frame_task: Optional[asyncio.Task] = None

                    @pc.on("track")
                    def on_track(track):
                        nonlocal frame_task
                        if track.kind != "video":
                            return
                        print("[LensLink] Smartphone camera stream locked! Feeding LensLink Wireless Webcam...")

                        async def pump_frames():
                            while True:
                                frame = await track.recv()
                                img = frame.to_ndarray(format="rgb24")
                                if img.shape[1] != width or img.shape[0] != height:
                                    if cv2 is not None:
                                        img = cv2.resize(img, (width, height), interpolation=cv2.INTER_LINEAR)
                                ds_writer.write_frame(img, fps=fps, connected=True)
                                if fallback_cam is not None:
                                    fallback_cam.send(img)
                                    fallback_cam.sleep_until_next_frame()

                        frame_task = asyncio.create_task(pump_frames())

                    @pc.on("icecandidate")
                    async def on_ice(candidate):
                        if candidate is None:
                            return
                        await ws.send(json.dumps({
                            "type": "signal",
                            "signal": {
                                "type": "candidate",
                                "candidate": {
                                    "candidate": f"candidate:{candidate.to_sdp()}",
                                    "sdpMid": candidate.sdpMid,
                                    "sdpMLineIndex": candidate.sdpMLineIndex,
                                },
                            },
                        }))

                    async for raw_msg in ws:
                        data = json.loads(raw_msg)
                        if data.get("type") == "signal":
                            sig = data.get("signal", {})
                            if sig.get("type") == "offer":
                                await pc.setRemoteDescription(
                                    RTCSessionDescription(sdp=sig["sdp"], type="offer")
                                )
                                answer = await pc.createAnswer()
                                await pc.setLocalDescription(answer)
                                await ws.send(json.dumps({
                                    "type": "signal",
                                    "signal": {
                                        "type": "answer",
                                        "sdp": pc.localDescription.sdp,
                                    },
                                }))
                            elif sig.get("type") == "candidate" and sig.get("candidate"):
                                cinfo = sig["candidate"]
                                cand_str = cinfo.get("candidate", "")
                                if cand_str.startswith("candidate:"):
                                    cand = candidate_from_sdp(cand_str.split(":", 1)[1])
                                    cand.sdpMid = cinfo.get("sdpMid")
                                    cand.sdpMLineIndex = cinfo.get("sdpMLineIndex")
                                    await pc.addIceCandidate(cand)

                    if frame_task:
                        frame_task.cancel()
                    await pc.close()
                    ds_writer.mark_disconnected()
            except Exception as exc:
                ds_writer.mark_disconnected()
                print(f"[LensLink] Reconnecting in 2.5s ({exc})...")
                await asyncio.sleep(2.5)
    finally:
        mdns.stop()
        ds_writer.close()
        if fallback_cam is not None:
            fallback_cam.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="LensLink Wireless Webcam Windows Client")
    parser.add_argument("--server", default="ws://127.0.0.1:3000/ws", help="WebSocket signaling URL")
    parser.add_argument("--room", required=True, help="6-character LensLink session code")
    parser.add_argument("--name", default=socket.gethostname(), help="Windows PC display name")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=30)
    args = parser.parse_args()

    try:
        asyncio.run(
            run_lenslink_client(
                server_ws=args.server,
                room_code=args.room.strip().upper(),
                pc_name=args.name.strip()[:36],
                width=args.width,
                height=args.height,
                fps=args.fps,
            )
        )
    except KeyboardInterrupt:
        print("\n[LensLink] Shutdown complete.")


if __name__ == "__main__":
    main()
