import { useEffect, useRef, useState } from 'react';
import {
  applyLowLatencyReceiver,
  buildVideoFilterCss,
  getRtcConfiguration,
  getWsUrl,
} from '../../lib/webrtc';
import {
  decodeIceCandidate,
  encodeIceCandidate,
  requestObsViewerStream,
  subscribeToObsViewer,
  subscribeToRoom,
  updateObsViewerFromClient,
} from '../../lib/firestoreSignaling';
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
  const [forceFramesMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('transport') === 'frames';
  });
  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities | null>(null);
  const [statusText, setStatusText] = useState(`Waiting for feed (${pairCode})`);

  const hasWebRtcRef = useRef(false);
  hasWebRtcRef.current = hasWebRtcStream;

  // Primary: Firestore localhost loopback WebRTC signaling (works everywhere — zero /ws 404s)
  useEffect(() => {
    if (!pairCode || forceFramesMode) return;

    let closed = false;
    let roomReady = false;
    let requestedForLiveSession = false;
    let lastHandledOfferId = '';
    const processedPcIce = new Set<string>();
    const viewerIceList: string[] = [];
    let viewerIceFlushTimer: number | null = null;
    let retryRequestTimer: number | null = null;

    const clearTimers = () => {
      if (viewerIceFlushTimer) {
        clearTimeout(viewerIceFlushTimer);
        viewerIceFlushTimer = null;
      }
      if (retryRequestTimer) {
        clearTimeout(retryRequestTimer);
        retryRequestTimer = null;
      }
    };

    const cleanupRtc = () => {
      if (viewerIceFlushTimer) {
        clearTimeout(viewerIceFlushTimer);
        viewerIceFlushTimer = null;
      }
      viewerIceList.length = 0;
      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
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

    const scheduleStreamRequest = (delayMs = 0) => {
      if (retryRequestTimer) {
        clearTimeout(retryRequestTimer);
        retryRequestTimer = null;
      }
      const fire = () => {
        if (closed || !roomReady || hasWebRtcRef.current) return;
        setStatusText(`Connecting to PC Receiver (${pairCode})...`);
        void requestObsViewerStream(pairCode);
        // Retry automatically if offer didn't establish video within 4.5s
        retryRequestTimer = window.setTimeout(() => {
          if (!closed && roomReady && !hasWebRtcRef.current) {
            void requestObsViewerStream(pairCode);
          }
        }, 4500);
      };
      if (delayMs > 0) {
        retryRequestTimer = window.setTimeout(fire, delayMs);
      } else {
        fire();
      }
    };

    const handleOfferFromPc = async (
      offerId: string,
      offerSdp: string,
      initialPcIce: RTCIceCandidateInit[]
    ) => {
      if (closed || !offerId || !offerSdp) return;
      if (offerId === lastHandledOfferId && pcRef.current) return;
      lastHandledOfferId = offerId;

      cleanupRtc();
      setStatusText(`Negotiating low-latency stream (${pairCode})...`);

      const rtc = new RTCPeerConnection(getRtcConfiguration(false));
      pcRef.current = rtc;

      const flushViewerIce = () => {
        if (viewerIceFlushTimer) return;
        viewerIceFlushTimer = window.setTimeout(() => {
          viewerIceFlushTimer = null;
          if (!closed && viewerIceList.length > 0 && lastHandledOfferId === offerId) {
            void updateObsViewerFromClient(pairCode, {
              viewerIceCandidates: [...viewerIceList],
            });
          }
        }, 50);
      };

      rtc.ontrack = (trackEvent) => {
        applyLowLatencyReceiver(rtc);
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
        if (iceEvent.candidate) {
          const encoded = encodeIceCandidate(iceEvent.candidate.toJSON());
          if (encoded && !viewerIceList.includes(encoded) && viewerIceList.length < 24) {
            viewerIceList.push(encoded);
            flushViewerIce();
          }
        }
      };

      const handleStateChange = () => {
        const cState = rtc.connectionState;
        const iState = rtc.iceConnectionState;
        if (cState === 'connected' || iState === 'connected' || iState === 'completed') {
          applyLowLatencyReceiver(rtc);
          if (videoRef.current) {
            void videoRef.current.play().catch(() => {});
          }
        } else if (cState === 'failed' || iState === 'failed') {
          hasWebRtcRef.current = false;
          setHasWebRtcStream(false);
          if (!closed && roomReady) {
            lastHandledOfferId = '';
            scheduleStreamRequest(1200);
          }
        }
      };

      rtc.onconnectionstatechange = handleStateChange;
      rtc.oniceconnectionstatechange = handleStateChange;

      try {
        await rtc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
        for (const cand of initialPcIce) {
          await rtc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        for (const cand of pendingIceRef.current) {
          await rtc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        pendingIceRef.current = [];

        const answer = await rtc.createAnswer();
        await rtc.setLocalDescription(answer);
        applyLowLatencyReceiver(rtc);

        if (rtc.localDescription?.sdp && !closed) {
          await updateObsViewerFromClient(pairCode, {
            answerForOfferId: offerId,
            answerSdp: rtc.localDescription.sdp,
            viewerIceCandidates: [...viewerIceList],
          });
        }
      } catch {
        if (!closed && roomReady) {
          lastHandledOfferId = '';
          scheduleStreamRequest(1500);
        }
      }
    };

    const unsubRoom = subscribeToRoom(pairCode, (room) => {
      if (closed) return;
      if (!room) {
        roomReady = false;
        requestedForLiveSession = false;
        cleanupRtc();
        setStatusText(`Waiting for PC Receiver (${pairCode})`);
        return;
      }

      if (
        room.capabilities &&
        typeof room.capabilities === 'object' &&
        Array.isArray((room.capabilities as CameraCapabilities).devices)
      ) {
        setCapabilities(room.capabilities as CameraCapabilities);
      }
      if (room.settings && typeof room.settings === 'object' && Object.keys(room.settings).length > 0) {
        setSettings((prev) => ({ ...prev, ...room.settings }));
      }

      const pcOnline = Boolean(room.pcOnline);
      const phoneOnline = Boolean(room.phoneOnline);
      const phoneStreaming = Boolean(room.phoneStreaming);

      if (!pcOnline) {
        roomReady = false;
        requestedForLiveSession = false;
        cleanupRtc();
        setStatusText(`Waiting for PC Receiver (${pairCode})`);
        return;
      }

      if (!phoneOnline || !phoneStreaming) {
        roomReady = false;
        requestedForLiveSession = false;
        cleanupRtc();
        setStatusText(`Waiting for smartphone camera (${pairCode})`);
        return;
      }

      roomReady = true;
      if (!requestedForLiveSession && !hasWebRtcRef.current) {
        requestedForLiveSession = true;
        scheduleStreamRequest(0);
      }
    });

    const unsubViewer = subscribeToObsViewer(pairCode, (viewer) => {
      if (closed || !viewer) return;

      if (viewer.offerId && viewer.offerSdp && viewer.offerId !== lastHandledOfferId) {
        processedPcIce.clear();
        const initialIce: RTCIceCandidateInit[] = [];
        if (Array.isArray(viewer.pcIceCandidates)) {
          for (const encoded of viewer.pcIceCandidates) {
            processedPcIce.add(encoded);
            const decoded = decodeIceCandidate(encoded);
            if (decoded) initialIce.push(decoded);
          }
        }
        void handleOfferFromPc(viewer.offerId, viewer.offerSdp, initialIce);
        return;
      }

      if (
        Array.isArray(viewer.pcIceCandidates) &&
        viewer.offerId &&
        viewer.offerId === lastHandledOfferId
      ) {
        for (const encoded of viewer.pcIceCandidates) {
          if (processedPcIce.has(encoded)) continue;
          processedPcIce.add(encoded);
          const decoded = decodeIceCandidate(encoded);
          if (!decoded) continue;
          if (pcRef.current && pcRef.current.remoteDescription) {
            void pcRef.current.addIceCandidate(new RTCIceCandidate(decoded)).catch(() => {});
          } else {
            pendingIceRef.current.push(decoded);
          }
        }
      }
    });

    return () => {
      closed = true;
      clearTimers();
      unsubRoom();
      unsubViewer();
      cleanupRtc();
    };
  }, [pairCode, forceFramesMode]);

  // Optional local-only WS frame mode (?transport=frames on localhost Express server)
  useEffect(() => {
    if (!pairCode || !forceFramesMode) return;

    let closed = false;
    let decodingFrame = false;
    let ws: WebSocket | null = null;

    ws = new WebSocket(`${getWsUrl()}?role=vcam-web&code=${encodeURIComponent(pairCode)}`);
    ws.binaryType = 'blob';

    ws.onopen = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'vcam:frame-fallback', enabled: true }));
      }
    };

    ws.onmessage = async (event) => {
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

      try {
        const msg = JSON.parse(event.data) as SignalingMessage;
        if (msg.type === 'room:status') {
          if (msg.capabilities) setCapabilities(msg.capabilities);
          if (msg.settings) setSettings((prev) => ({ ...prev, ...msg.settings }));
          if (!msg.pcOnline) {
            setStatusText(`Waiting for PC Receiver (${pairCode})`);
            setHasFrameStream(false);
          } else if (!msg.phoneOnline) {
            setStatusText(`Waiting for smartphone camera (${pairCode})`);
            setHasFrameStream(false);
          }
        }
      } catch {
        // Ignore
      }
    };

    ws.onerror = () => {
      if (!closed) {
        setStatusText(`Frame relay requires local server — remove &transport=frames to use direct WebRTC`);
      }
    };

    return () => {
      closed = true;
      if (ws) ws.close();
    };
  }, [pairCode, forceFramesMode]);

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

  const showWebRtc = hasWebRtcStream && !forceFramesMode;
  const showFallbackCanvas = hasFrameStream && forceFramesMode;
  const isLive = showWebRtc || showFallbackCanvas;

  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center overflow-hidden">
      {/* Keep <video> always mounted (never display:none) so OBS CEF starts decoding immediately */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        onLoadedMetadata={(e) => {
          void e.currentTarget.play().catch(() => {});
        }}
        onCanPlay={(e) => {
          void e.currentTarget.play().catch(() => {});
          if (e.currentTarget.videoWidth > 0) {
            hasWebRtcRef.current = true;
            setHasWebRtcStream(true);
          }
        }}
        onPlaying={(e) => {
          if (e.currentTarget.videoWidth === 0) return;
          hasWebRtcRef.current = true;
          setHasWebRtcStream(true);
        }}
        style={{
          transform: videoTransform || undefined,
          filter: filterCss,
        }}
        className={`w-full h-full object-contain transition-opacity duration-150 ${
          showWebRtc ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />

      {forceFramesMode && (
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full object-contain ${
            showFallbackCanvas ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        />
      )}

      {!isLive && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm font-mono px-4 text-center">
          {statusText}
        </div>
      )}
    </div>
  );
}
