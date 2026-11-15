import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  FlipHorizontal2,
  Flashlight,
  QrCode,
  RefreshCw,
  SlidersHorizontal,
  Video,
  VideoOff,
  ArrowLeft,
  X,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import {
  CameraCapabilities,
  CameraSettings,
  ConnectionStatus,
  DEFAULT_CAMERA_SETTINGS,
  FrameRatePreset,
  ResolutionPreset,
  SignalingMessage,
} from '../../types/lenslink';
import {
  applyHardwareConstraints,
  extractCameraCapabilities,
  getCameraStreamSafe,
  getRtcConfiguration,
  getWsUrl,
  isLocalLanHostname,
  tuneVideoSender,
} from '../../lib/webrtc';
import { QrScannerModal } from '../common/QrScannerModal';

interface PhoneCameraViewProps {
  initialPairCode?: string;
  onSwitchToPc?: () => void;
}

export function PhoneCameraView({ initialPairCode = '', onSwitchToPc }: PhoneCameraViewProps) {
  const [pairCodeInput, setPairCodeInput] = useState(initialPairCode.toUpperCase());
  const [activeCode, setActiveCode] = useState<string>(
    /^[A-Z0-9]{6}$/i.test(initialPairCode) ? initialPairCode.toUpperCase() : ''
  );
  const [scannerOpen, setScannerOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);

  const [permissionGranted, setPermissionGranted] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [pcOnline, setPcOnline] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({ devices: [] });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const reconnectTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const isStreamingRef = useRef(false);
  const settingsRef = useRef<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  settingsRef.current = settings;
  isStreamingRef.current = isStreaming;

  const stopCameraStream = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const closePeerConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pendingIceRef.current = [];
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        // Ignore release errors
      }
      wakeLockRef.current = null;
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request('screen');
      }
    } catch {
      // Wake lock optional on unsupported browsers
    }
  }, []);

  const sendWs = useCallback((payload: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const createAndSendOffer = useCallback(async () => {
    const stream = localStreamRef.current;
    const ws = wsRef.current;
    if (!stream || !ws || ws.readyState !== WebSocket.OPEN || !isStreamingRef.current) {
      return;
    }

    closePeerConnection();
    setConnectionStatus('connecting');

    const localOnly = isLocalLanHostname();
    const rtc = new RTCPeerConnection(getRtcConfiguration(localOnly));
    pcRef.current = rtc;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = rtc.addTrack(videoTrack, stream);
      await tuneVideoSender(sender, settingsRef.current);
    }

    rtc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({
          type: 'rtc:ice-candidate',
          target: 'pc',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    rtc.onconnectionstatechange = () => {
      const state = rtc.connectionState;
      if (state === 'connected') {
        setConnectionStatus('connected');
        setErrorMsg(null);
      } else if (state === 'connecting') {
        setConnectionStatus('connecting');
      } else if (state === 'disconnected') {
        setConnectionStatus('reconnecting');
      } else if (state === 'failed') {
        setConnectionStatus('reconnecting');
        if (isStreamingRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
          window.setTimeout(() => {
            if (isMountedRef.current && isStreamingRef.current) {
              void createAndSendOffer();
            }
          }, 1200);
        }
      }
    };

    try {
      const offer = await rtc.createOffer();
      await rtc.setLocalDescription(offer);
      sendWs({
        type: 'rtc:offer',
        target: 'pc',
        sdp: rtc.localDescription?.toJSON(),
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to negotiate WebRTC connection.');
    }
  }, [closePeerConnection, sendWs]);

  const startLocalCamera = useCallback(
    async (nextSettings: CameraSettings): Promise<MediaStream | null> => {
      // Stop existing track first so iOS Safari releases the hardware camera cleanly
      stopCameraStream();
      setErrorMsg(null);

      try {
        const stream = await getCameraStreamSafe(nextSettings);
        if (!isMountedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
        localStreamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        const track = stream.getVideoTracks()[0];
        if (track) {
          await applyHardwareConstraints(track, nextSettings);
          const caps = await extractCameraCapabilities(track);
          setCapabilities(caps);
          sendWs({
            type: 'camera:capabilities',
            capabilities: caps,
            phoneName: navigator.userAgent.includes('iPhone')
              ? 'iPhone Camera'
              : navigator.userAgent.includes('Android')
                ? 'Android Camera'
                : 'Mobile Browser Camera',
          });

          // Replace track on active RTCPeerConnection for glitch-free switching
          if (pcRef.current && isStreamingRef.current) {
            const sender = pcRef.current.getSenders().find((s) => s.track?.kind === 'video');
            if (sender) {
              await sender.replaceTrack(track);
              await tuneVideoSender(sender, nextSettings);
            }
          }
        }

        setPermissionGranted(true);
        return stream;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Camera permission denied. Please allow camera access in browser settings.';
        setErrorMsg(msg);
        setPermissionGranted(false);
        return null;
      }
    },
    [sendWs, stopCameraStream]
  );

  // Signaling WebSocket with automatic reconnection on Wi-Fi interruption
  useEffect(() => {
    isMountedRef.current = true;
    if (!activeCode) return;

    let attempt = 0;
    let manualClose = false;

    const connectSocket = () => {
      if (!isMountedRef.current || manualClose) return;
      setConnectionStatus(attempt > 0 ? 'reconnecting' : 'connecting');

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMountedRef.current) return;
        attempt = 0;
        setReconnectAttempt(0);
        setErrorMsg(null);
        const deviceLabel = /iPhone|iPad/i.test(navigator.userAgent)
          ? 'iPhone Safari'
          : /Android/i.test(navigator.userAgent)
            ? 'Android Chrome'
            : 'Smartphone Camera';

        sendWs({
          type: 'room:join',
          code: activeCode,
          role: 'phone',
          phoneName: deviceLabel,
        });

        // Re-announce capabilities & active stream on reconnect
        if (localStreamRef.current) {
          const track = localStreamRef.current.getVideoTracks()[0];
          if (track) {
            void extractCameraCapabilities(track).then((caps) => {
              sendWs({ type: 'camera:capabilities', capabilities: caps, phoneName: deviceLabel });
            });
          }
          if (isStreamingRef.current) {
            sendWs({ type: 'camera:stream-state', streaming: true });
          }
        }
      };

      ws.onmessage = async (event) => {
        let msg: SignalingMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'room:error') {
          setErrorMsg(msg.message || 'Unable to join room.');
          setConnectionStatus('disconnected');
          return;
        }

        if (msg.type === 'room:status') {
          const online = Boolean(msg.pcOnline);
          setPcOnline(online);
          if (online && isStreamingRef.current) {
            const rtcState = pcRef.current?.connectionState;
            if (!pcRef.current || rtcState === 'closed' || rtcState === 'failed') {
              await createAndSendOffer();
            }
          } else if (!online) {
            setConnectionStatus('waiting');
            closePeerConnection();
          }
          return;
        }

        if (msg.type === 'rtc:answer' && msg.sdp && pcRef.current) {
          try {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            for (const cand of pendingIceRef.current) {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
            }
            pendingIceRef.current = [];
          } catch {
            // Ignore stale answer
          }
          return;
        }

        if (msg.type === 'rtc:ice-candidate' && msg.candidate) {
          if (pcRef.current && pcRef.current.remoteDescription) {
            try {
              await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch {
              // Ignore invalid candidate
            }
          } else {
            pendingIceRef.current.push(msg.candidate);
          }
          return;
        }

        if (msg.type === 'rtc:restart') {
          if (isStreamingRef.current && localStreamRef.current) {
            await createAndSendOffer();
          }
          return;
        }

        if (msg.type === 'camera:settings' && msg.settings) {
          const incoming = msg.settings;
          const prev = settingsRef.current;
          const merged: CameraSettings = { ...prev, ...incoming };
          setSettings(merged);

          const needsTrackReopen =
            (incoming.facingMode && incoming.facingMode !== prev.facingMode) ||
            (incoming.deviceId !== undefined && incoming.deviceId !== prev.deviceId) ||
            (incoming.resolution && incoming.resolution !== prev.resolution) ||
            (incoming.frameRate && incoming.frameRate !== prev.frameRate);

          if (needsTrackReopen && localStreamRef.current) {
            await startLocalCamera(merged);
          } else if (localStreamRef.current) {
            const track = localStreamRef.current.getVideoTracks()[0];
            await applyHardwareConstraints(track, incoming);
          }
        }
      };

      ws.onclose = () => {
        if (!isMountedRef.current || manualClose) return;
        setPcOnline(false);
        setConnectionStatus('reconnecting');
        attempt += 1;
        setReconnectAttempt(attempt);
        const delayMs = Math.min(8000, 1000 * Math.pow(1.6, attempt - 1));
        reconnectTimerRef.current = window.setTimeout(connectSocket, delayMs);
      };
    };

    connectSocket();

    const handleOnline = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        connectSocket();
      }
    };
    window.addEventListener('online', handleOnline);

    return () => {
      manualClose = true;
      window.removeEventListener('online', handleOnline);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      closePeerConnection();
    };
  }, [activeCode, closePeerConnection, createAndSendOffer, sendWs, startLocalCamera]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      stopCameraStream();
      closePeerConnection();
      void releaseWakeLock();
    };
  }, [closePeerConnection, releaseWakeLock, stopCameraStream]);

  const handleJoinSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = pairCodeInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(cleaned)) {
      setErrorMsg('Enter the 6-character pairing code shown on your PC.');
      return;
    }
    setErrorMsg(null);
    setActiveCode(cleaned);
    await startLocalCamera(settings);
  };

  const handleToggleStream = async () => {
    if (isStreaming) {
      setIsStreaming(false);
      isStreamingRef.current = false;
      sendWs({ type: 'camera:stream-state', streaming: false });
      closePeerConnection();
      setConnectionStatus(pcOnline ? 'waiting' : 'disconnected');
      await releaseWakeLock();
      return;
    }

    let stream = localStreamRef.current;
    if (!stream) {
      stream = await startLocalCamera(settings);
      if (!stream) return;
    }

    setIsStreaming(true);
    isStreamingRef.current = true;
    sendWs({ type: 'camera:stream-state', streaming: true });
    await requestWakeLock();
    if (pcOnline) {
      await createAndSendOffer();
    } else {
      setConnectionStatus('waiting');
    }
  };

  const updateSetting = async (patch: Partial<CameraSettings>) => {
    const prev = settings;
    const next = { ...prev, ...patch };
    setSettings(next);
    sendWs({ type: 'camera:settings', settings: patch });

    const needsReopen =
      (patch.facingMode && patch.facingMode !== prev.facingMode) ||
      (patch.deviceId !== undefined && patch.deviceId !== prev.deviceId) ||
      (patch.resolution && patch.resolution !== prev.resolution) ||
      (patch.frameRate && patch.frameRate !== prev.frameRate);

    if (needsReopen && localStreamRef.current) {
      await startLocalCamera(next);
    } else if (localStreamRef.current) {
      const track = localStreamRef.current.getVideoTracks()[0];
      await applyHardwareConstraints(track, patch);
    }
  };

  const handleFlipCamera = () => {
    const nextFacing = settings.facingMode === 'environment' ? 'user' : 'environment';
    void updateSetting({
      facingMode: nextFacing,
      deviceId: undefined,
      torch: false,
      mirror: nextFacing === 'user',
    });
  };

  const handleQrDetected = useCallback((code: string) => {
    setScannerOpen(false);
    setPairCodeInput(code);
    setActiveCode(code);
    // Delay slightly on iOS Safari so QR scanner camera track finishes releasing
    window.setTimeout(() => {
      void startLocalCamera(settingsRef.current);
    }, 220);
  }, [startLocalCamera]);

  const handleLeaveRoom = async () => {
    setIsStreaming(false);
    isStreamingRef.current = false;
    closePeerConnection();
    stopCameraStream();
    setPermissionGranted(false);
    setActiveCode('');
    setConnectionStatus('disconnected');
    await releaseWakeLock();
  };

  // Pairing Gate / Camera Authorization Screen
  if (!activeCode || !permissionGranted) {
    return (
      <div className="min-h-[100dvh] bg-slate-950 text-white flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-slate-800/80">
          <div className="flex items-center gap-3">
            {onSwitchToPc && (
              <button
                type="button"
                onClick={onSwitchToPc}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white"
                aria-label="Back to PC Receiver"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <span className="text-lg font-bold tracking-tight whitespace-nowrap">LensLink</span>
          </div>
          <span className="text-xs font-medium text-slate-400 whitespace-nowrap">
            Smartphone Camera
          </span>
        </header>

        <main className="flex-1 flex items-center justify-center p-5">
          <div className="w-full max-w-md space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight text-balance">
                Connect your phone camera
              </h1>
              <p className="text-sm text-slate-400 leading-relaxed">
                Scan the QR code on your Windows PC or enter the 6-character pairing code. Video transmits directly over your local Wi-Fi.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              className="w-full min-h-[52px] flex items-center justify-center gap-3 rounded-2xl bg-blue-600 hover:bg-blue-500 active:scale-[0.99] text-white font-semibold text-base transition-all shadow-lg shadow-blue-950/50"
            >
              <QrCode className="w-5 h-5" />
              <span>Scan PC QR Code</span>
            </button>

            <div className="flex items-center gap-3 text-xs text-slate-500">
              <div className="h-px flex-1 bg-slate-800" />
              <span>or enter code</span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>

            <form onSubmit={handleJoinSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="pair-code-input"
                  className="block text-xs font-medium text-slate-300 mb-2"
                >
                  6-Character Pairing Code
                </label>
                <input
                  id="pair-code-input"
                  type="text"
                  maxLength={6}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  value={pairCodeInput}
                  onChange={(e) => setPairCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  placeholder="K7M4P9"
                  className="w-full min-h-[52px] px-4 rounded-xl bg-slate-900 border border-slate-700 focus:border-blue-500 focus:outline-none text-center font-mono text-2xl tracking-[0.35em] text-white placeholder:text-slate-600 uppercase tabular-nums"
                />
              </div>

              {errorMsg && (
                <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-950/60 border border-red-900/70 text-red-200 text-xs leading-relaxed">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={pairCodeInput.trim().length !== 6}
                className="w-full min-h-[52px] flex items-center justify-center gap-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 disabled:opacity-45 disabled:pointer-events-none text-white font-semibold text-sm border border-slate-700 transition-colors"
              >
                <Camera className="w-5 h-5" />
                <span>Allow Camera &amp; Connect</span>
              </button>
            </form>

            <p className="text-xs text-slate-500 text-center">
              Requires camera permission. No account or cloud servers used.
            </p>
          </div>
        </main>

        <QrScannerModal
          open={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onDetected={handleQrDetected}
        />
      </div>
    );
  }

  const brightnessCss = 1 + settings.brightness / 150;
  const statusLabel =
    connectionStatus === 'connected'
      ? 'Live on PC'
      : connectionStatus === 'connecting'
        ? 'Connecting'
        : connectionStatus === 'reconnecting'
          ? `Reconnecting (${reconnectAttempt})`
          : pcOnline
            ? 'Ready to stream'
            : 'Waiting for PC';

  return (
    <div className="relative h-[100dvh] w-full bg-black text-white overflow-hidden flex flex-col">
      {/* Compact Sticky Top Bar (< 56px) */}
      <header className="relative z-20 flex items-center justify-between px-3 py-2 bg-slate-950/85 backdrop-blur-md border-b border-white/10">
        <button
          type="button"
          onClick={handleLeaveRoom}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-white/10 text-slate-200"
          aria-label="Disconnect and change pairing code"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-xs font-semibold tracking-wider text-slate-300 tabular-nums">
            {activeCode}
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <div className="flex items-center gap-1.5 text-xs font-medium truncate">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : connectionStatus === 'reconnecting' ? (
              <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
            ) : !pcOnline ? (
              <WifiOff className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            ) : null}
            <span
              className={
                connectionStatus === 'connected'
                  ? 'text-emerald-300'
                  : connectionStatus === 'reconnecting'
                    ? 'text-amber-300'
                    : 'text-slate-300'
              }
            >
              {statusLabel}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setControlsOpen(true)}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-white/10 text-slate-200"
          aria-label="Camera adjustments"
        >
          <SlidersHorizontal className="w-5 h-5" />
        </button>
      </header>

      {/* Live Camera Viewfinder */}
      <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            transform: settings.facingMode === 'user' ? 'scaleX(-1)' : undefined,
            filter: settings.brightness !== 0 ? `brightness(${brightnessCss})` : undefined,
          }}
          className="w-full h-full object-cover"
        />

        {errorMsg && (
          <div className="absolute top-3 inset-x-4 z-20 flex items-center gap-2 p-3 rounded-xl bg-red-950/90 border border-red-800 text-xs text-red-100">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* Quiet technical readout */}
        <div className="pointer-events-none absolute top-3 left-3 z-10 px-2.5 py-1 rounded-lg bg-black/55 backdrop-blur-sm text-[11px] font-mono text-slate-200 tabular-nums">
          {settings.resolution} · {settings.frameRate} fps · {settings.facingMode === 'environment' ? 'Rear' : 'Front'}
        </div>
      </div>

      {/* Natural Thumb-Zone Bottom Controls */}
      <footer className="relative z-20 px-5 py-4 bg-slate-950/90 backdrop-blur-md border-t border-white/10">
        <div className="max-w-md mx-auto flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={handleFlipCamera}
            className="min-h-[48px] min-w-[48px] px-3.5 flex items-center justify-center gap-2 rounded-2xl bg-slate-800/90 hover:bg-slate-700 text-white text-xs font-medium transition-colors"
            aria-label="Switch front or rear camera"
          >
            <FlipHorizontal2 className="w-5 h-5" />
            <span className="hidden xs:inline">Flip</span>
          </button>

          <button
            type="button"
            onClick={handleToggleStream}
            className={`flex-1 min-h-[52px] flex items-center justify-center gap-2.5 rounded-2xl font-semibold text-sm transition-all active:scale-[0.98] ${
              isStreaming
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {isStreaming ? (
              <>
                <VideoOff className="w-5 h-5" />
                <span>Stop Streaming</span>
              </>
            ) : (
              <>
                <Video className="w-5 h-5" />
                <span>Start Streaming</span>
              </>
            )}
          </button>

          {capabilities.torch && settings.facingMode === 'environment' ? (
            <button
              type="button"
              onClick={() => void updateSetting({ torch: !settings.torch })}
              className={`min-h-[48px] min-w-[48px] flex items-center justify-center rounded-2xl transition-colors ${
                settings.torch
                  ? 'bg-amber-500 text-slate-950'
                  : 'bg-slate-800/90 hover:bg-slate-700 text-white'
              }`}
              aria-label="Toggle camera flash light"
            >
              <Flashlight className="w-5 h-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setControlsOpen(true)}
              className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-2xl bg-slate-800/90 hover:bg-slate-700 text-white transition-colors"
              aria-label="Open video controls"
            >
              <SlidersHorizontal className="w-5 h-5" />
            </button>
          )}
        </div>
      </footer>

      {/* Mobile Camera Adjustments Bottom Sheet */}
      {controlsOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/60 backdrop-blur-xs"
          onClick={() => setControlsOpen(false)}
        >
          <div
            className="w-full max-h-[82dvh] overflow-y-auto rounded-t-3xl bg-slate-900 border-t border-slate-700 p-5 pb-8 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-700 rounded-full mx-auto" />

            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Camera &amp; Video Controls</h2>
              <button
                type="button"
                onClick={() => setControlsOpen(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300"
                aria-label="Close controls"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Lens selector if browser exposes multiple cameras */}
            {capabilities.devices.length > 1 && (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-400">Camera Lens</label>
                <select
                  value={settings.deviceId || ''}
                  onChange={(e) =>
                    void updateSetting({ deviceId: e.target.value || undefined })
                  }
                  className="w-full min-h-[44px] px-3 rounded-xl bg-slate-800 border border-slate-700 text-sm text-white"
                >
                  <option value="">
                    Auto ({settings.facingMode === 'environment' ? 'Rear' : 'Front'})
                  </option>
                  {capabilities.devices.map((dev) => (
                    <option key={dev.deviceId} value={dev.deviceId}>
                      {dev.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Resolution */}
            <div className="space-y-2">
              <span className="block text-xs font-medium text-slate-400">Resolution</span>
              <div className="grid grid-cols-3 gap-2">
                {(['480p', '720p', '1080p'] as ResolutionPreset[]).map((res) => (
                  <button
                    key={res}
                    type="button"
                    onClick={() => void updateSetting({ resolution: res })}
                    className={`min-h-[44px] rounded-xl text-xs font-semibold font-mono transition-colors ${
                      settings.resolution === res
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>

            {/* Frame Rate */}
            <div className="space-y-2">
              <span className="block text-xs font-medium text-slate-400">Frame Rate</span>
              <div className="grid grid-cols-4 gap-2">
                {([15, 24, 30, 60] as FrameRatePreset[]).map((fps) => (
                  <button
                    key={fps}
                    type="button"
                    onClick={() => void updateSetting({ frameRate: fps })}
                    className={`min-h-[44px] rounded-xl text-xs font-semibold font-mono tabular-nums transition-colors ${
                      settings.frameRate === fps
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {fps} fps
                  </button>
                ))}
              </div>
            </div>

            {/* Zoom */}
            {capabilities.zoom && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-medium text-slate-400">Zoom</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {settings.zoom.toFixed(1)}×
                  </span>
                </div>
                <input
                  type="range"
                  min={capabilities.zoom.min}
                  max={Math.min(capabilities.zoom.max, 8)}
                  step={capabilities.zoom.step || 0.1}
                  value={settings.zoom}
                  onChange={(e) => void updateSetting({ zoom: Number(e.target.value) })}
                  className="w-full lens-slider"
                />
              </div>
            )}

            {/* Focus Mode & Distance */}
            {capabilities.focusModes && capabilities.focusModes.length > 0 && (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">Focus Mode</span>
                  <div className="flex gap-1.5 bg-slate-800 p-1 rounded-xl">
                    {(['continuous', 'manual'] as const).map((mode) => {
                      const supported = capabilities.focusModes?.includes(mode);
                      if (!supported) return null;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => void updateSetting({ focusMode: mode })}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${
                            settings.focusMode === mode
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-300'
                          }`}
                        >
                          {mode === 'continuous' ? 'Auto' : 'Manual'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {settings.focusMode === 'manual' && capabilities.focusDistance && (
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.02}
                    value={settings.focusDistance}
                    onChange={(e) =>
                      void updateSetting({ focusDistance: Number(e.target.value) })
                    }
                    className="w-full lens-slider"
                    aria-label="Manual focus distance"
                  />
                )}
              </div>
            )}

            {/* Brightness / Exposure */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-medium text-slate-400">
                  {capabilities.exposureCompensation ? 'Exposure Brightness' : 'Video Brightness'}
                </span>
                <span className="font-mono tabular-nums text-slate-200">
                  {capabilities.exposureCompensation
                    ? `${settings.exposureCompensation > 0 ? '+' : ''}${settings.exposureCompensation.toFixed(1)} EV`
                    : `${settings.brightness > 0 ? '+' : ''}${settings.brightness}%`}
                </span>
              </div>
              {capabilities.exposureCompensation ? (
                <input
                  type="range"
                  min={capabilities.exposureCompensation.min}
                  max={capabilities.exposureCompensation.max}
                  step={capabilities.exposureCompensation.step || 0.25}
                  value={settings.exposureCompensation}
                  onChange={(e) =>
                    void updateSetting({ exposureCompensation: Number(e.target.value) })
                  }
                  className="w-full lens-slider"
                />
              ) : (
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={5}
                  value={settings.brightness}
                  onChange={(e) =>
                    void updateSetting({ brightness: Number(e.target.value) })
                  }
                  className="w-full lens-slider"
                />
              )}
            </div>
          </div>
        </div>
      )}

      <QrScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleQrDetected}
      />
    </div>
  );
}
