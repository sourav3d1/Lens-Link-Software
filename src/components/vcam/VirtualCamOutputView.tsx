import { useEffect, useRef, useState } from 'react';
import {
  buildVideoFilterCss,
  getRtcConfiguration,
  getWsUrl,
  isLocalLanHostname,
} from '../../lib/webrtc';
import {
  CameraCapabilities,
  CameraSettings,
  DEFAULT_CAMERA_SETTINGS,
  SignalingMessage,
} from '../../types/lenslink';

interface VirtualCamOutputViewProps {
  pairCode: string;
}

export function VirtualCamOutputView({ pairCode }: VirtualCamOutputViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  const [hasWebRtcStream, setHasWebRtcStream] = useState(false);
  const [hasFrameStream, setHasFrameStream] = useState(false);
  const [fallbackActive, setFallbackActive] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('transport') === 'frames';
  });
  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities | null>(null);
  const [statusText, setStatusText] = useState(`Waiting for feed (${pairCode})`);

  const hasWebRtcRef = useRef(false);
  const fallbackActiveRef = useRef(fallbackActive);
  hasWebRtcRef.current = hasWebRtcStream;
  fallbackActiveRef.current = fallbackActive;

  useEffect(() => {
    if (!pairCode) return;

    const params = new URLSearchParams(window.location.search);
    const forceFrames = params.get('transport') === 'frames';

    let closed = false;
    let reconnectTimer: number | null = null;
    let offerRetryTimer: number | null = null;
    let fallbackTimer: number | null = null;
    let ws: WebSocket | null = null;
    let decodingFrame = false;

    const clearWatchdogs = () => {
      if (offerRetryTimer) {
        clearTimeout(offerRetryTimer);
        offerRetryTimer = null;
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    const cleanupRtc = () => {
      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
        pcRef.current = null;
      }
      pendingIceRef.current = [];
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      hasWebRtcRef.current = false;
      setHasWebRtcStream(false);
    };

    const enableFrameFallback = () => {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (!fallbackActiveRef.current) {
        fallbackActiveRef.current = true;
        setFallbackActive(true);
      }
      ws.send(JSON.stringify({ type: 'vcam:frame-fallback', enabled: true }));
    };

    const armWatchdogs = (pcOnline: boolean, phoneOnline: boolean) => {
      clearWatchdogs();
      if (!pcOnline || !phoneOnline) return;

      if (forceFrames || fallbackActiveRef.current) {
        enableFrameFallback();
        return;
      }

      // If no WebRTC offer arrives within 1.2s (e.g. OBS Browser Source reloaded mid-stream), request one
      offerRetryTimer = window.setTimeout(() => {
        if (!closed && !hasWebRtcRef.current && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'vcam:request-offer' }));
        }
      }, 1200);

      // If OBS CEF blocks WebRTC ICE/mDNS or video fails to play within 3s, switch seamlessly to WS frame relay
      fallbackTimer = window.setTimeout(() => {
        if (!closed && !hasWebRtcRef.current) {
          setStatusText(`Switching to OBS frame stream (${pairCode})...`);
          enableFrameFallback();
        }
      }, 3000);
    };

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${getWsUrl()}?role=vcam-web&code=${encodeURIComponent(pairCode)}`);
      ws.binaryType = 'blob';

      ws.onopen = () => {
        if (forceFrames) {
          enableFrameFallback();
        }
      };

      ws.onmessage = async (event) => {
        // Binary JPEG frames from PC Receiver fallback relay
        if (event.data instanceof Blob) {
          if (decodingFrame) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          decodingFrame = true;
          try {
            const bitmap = await createImageBitmap(event.data);
            if (!closed) {
              if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
              }
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(bitmap, 0, 0);
                setHasFrameStream(true);
              }
            }
            bitmap.close();
          } catch {
            // Ignore malformed frame
          } finally {
            decodingFrame = false;
          }
          return;
        }

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
          if (msg.capabilities) {
            setCapabilities(msg.capabilities);
          }
          if (msg.settings) {
            setSettings((prev) => ({ ...prev, ...msg.settings }));
          }

          if (!msg.pcOnline) {
            clearWatchdogs();
            setStatusText(`Waiting for PC Receiver (${pairCode})`);
            cleanupRtc();
            setHasFrameStream(false);
          } else if (!msg.phoneOnline) {
            clearWatchdogs();
            setStatusText(`Waiting for smartphone camera (${pairCode})`);
            cleanupRtc();
            setHasFrameStream(false);
          } else {
            armWatchdogs(true, true);
          }
          return;
        }

        if (msg.type === 'camera:capabilities' && msg.capabilities) {
          setCapabilities(msg.capabilities);
          return;
        }

        if (msg.type === 'camera:settings' && msg.settings) {
          setSettings((prev) => ({ ...prev, ...msg.settings }));
          return;
        }

        if (msg.type === 'camera:stream-state' && !msg.streaming) {
          clearWatchdogs();
          cleanupRtc();
          setHasFrameStream(false);
          setStatusText(`Waiting for smartphone stream (${pairCode})`);
          return;
        }

        if (msg.type === 'rtc:offer' && msg.sdp) {
          if (forceFrames) return;
          cleanupRtc();
          const rtc = new RTCPeerConnection(getRtcConfiguration(isLocalLanHostname()));
          pcRef.current = rtc;

          rtc.ontrack = (trackEvent) => {
            const stream =
              trackEvent.streams[0] ||
              (trackEvent.track ? new MediaStream([trackEvent.track]) : null);
            const vid = videoRef.current;
            if (vid && stream) {
              vid.muted = true;
              vid.playsInline = true;
              vid.srcObject = stream;
              void vid.play().catch(() => {});
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
            if (rtc.connectionState === 'failed' || rtc.connectionState === 'disconnected') {
              hasWebRtcRef.current = false;
              setHasWebRtcStream(false);
              if (!closed) {
                enableFrameFallback();
              }
            }
          };

          try {
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
          } catch {
            enableFrameFallback();
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
        clearWatchdogs();
        cleanupRtc();
        setHasFrameStream(false);
        setStatusText(`Reconnecting (${pairCode})...`);
        reconnectTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      closed = true;
      clearWatchdogs();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
      cleanupRtc();
    };
  }, [pairCode]);

  const filterCss = buildVideoFilterCss(
    settings,
    Boolean(capabilities?.brightness),
    Boolean(capabilities?.contrast)
  );
  const videoTransform = [
    settings.mirror ? 'scaleX(-1)' : '',
    settings.digitalZoom > 1 ? `scale(${settings.digitalZoom})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const showWebRtc = hasWebRtcStream && !fallbackActive;
  const showFallbackCanvas = hasFrameStream && !showWebRtc;
  const isLive = showWebRtc || showFallbackCanvas;

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        onPlaying={() => {
          if (!videoRef.current || videoRef.current.videoWidth === 0) return;
          hasWebRtcRef.current = true;
          setHasWebRtcStream(true);
        }}
        style={{
          transform: videoTransform || undefined,
          filter: filterCss,
        }}
        className={`w-full h-full object-contain ${showWebRtc ? 'block' : 'hidden'}`}
      />

      <canvas
        ref={canvasRef}
        className={`w-full h-full object-contain ${showFallbackCanvas ? 'block' : 'hidden'}`}
      />

      {!isLive && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm font-mono px-4 text-center">
          {statusText}
        </div>
      )}
    </div>
  );
}
