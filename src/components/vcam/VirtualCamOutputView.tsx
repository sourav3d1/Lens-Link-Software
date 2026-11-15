import { useEffect, useRef, useState } from 'react';
import { getRtcConfiguration, getWsUrl, isLocalLanHostname } from '../../lib/webrtc';
import { SignalingMessage } from '../../types/lenslink';

interface VirtualCamOutputViewProps {
  pairCode: string;
}

export function VirtualCamOutputView({ pairCode }: VirtualCamOutputViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const [hasStream, setHasStream] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [statusText, setStatusText] = useState(`Waiting for feed (${pairCode})`);

  useEffect(() => {
    if (!pairCode) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let ws: WebSocket | null = null;

    const cleanupRtc = () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      pendingIceRef.current = [];
      setHasStream(false);
    };

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${getWsUrl()}?role=vcam-web&code=${encodeURIComponent(pairCode)}`);

      ws.onmessage = async (event) => {
        let msg: SignalingMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'room:error') {
          setStatusText(msg.message || 'Room unavailable');
          return;
        }

        if (msg.type === 'room:status') {
          if (!msg.pcOnline) {
            setStatusText(`Waiting for PC Receiver (${pairCode})`);
            cleanupRtc();
          } else if (!msg.phoneOnline) {
            setStatusText(`Waiting for smartphone camera (${pairCode})`);
            cleanupRtc();
          }
          if (msg.settings && typeof msg.settings.mirror === 'boolean') {
            setMirror(msg.settings.mirror);
          }
          return;
        }

        if (msg.type === 'camera:settings' && msg.settings && typeof msg.settings.mirror === 'boolean') {
          setMirror(msg.settings.mirror);
          return;
        }

        if (msg.type === 'rtc:offer' && msg.sdp) {
          cleanupRtc();
          const rtc = new RTCPeerConnection(getRtcConfiguration(isLocalLanHostname()));
          pcRef.current = rtc;

          rtc.ontrack = (trackEvent) => {
            const stream = trackEvent.streams[0];
            if (videoRef.current && stream) {
              videoRef.current.srcObject = stream;
              void videoRef.current.play().catch(() => {});
              setHasStream(true);
            }
          };

          rtc.onicecandidate = (iceEvent) => {
            if (iceEvent.candidate && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'rtc:ice-candidate',
                  target: 'pc',
                  candidate: iceEvent.candidate.toJSON(),
                })
              );
            }
          };

          rtc.onconnectionstatechange = () => {
            if (rtc.connectionState === 'disconnected' || rtc.connectionState === 'failed') {
              setHasStream(false);
              setStatusText(`Reconnecting feed (${pairCode})`);
            }
          };

          await rtc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          for (const cand of pendingIceRef.current) {
            await rtc.addIceCandidate(new RTCIceCandidate(cand));
          }
          pendingIceRef.current = [];

          const answer = await rtc.createAnswer();
          await rtc.setLocalDescription(answer);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'rtc:answer',
                target: 'pc',
                sdp: rtc.localDescription?.toJSON(),
              })
            );
          }
          return;
        }

        if (msg.type === 'rtc:ice-candidate' && msg.candidate) {
          if (pcRef.current && pcRef.current.remoteDescription) {
            try {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch {
              // Ignore
            }
          } else {
            pendingIceRef.current.push(msg.candidate);
          }
        }
      };

      ws.onclose = () => {
        if (closed) return;
        cleanupRtc();
        setStatusText(`Reconnecting (${pairCode})...`);
        reconnectTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
      cleanupRtc();
    };
  }, [pairCode]);

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        style={{ transform: mirror ? 'scaleX(-1)' : undefined }}
        className={`w-full h-full object-contain ${hasStream ? 'opacity-100' : 'opacity-0'}`}
      />
      {!hasStream && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm font-mono">
          {statusText}
        </div>
      )}
    </div>
  );
}
