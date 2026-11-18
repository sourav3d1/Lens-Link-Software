import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  Crosshair,
  Download,
  Flashlight,
  FlipHorizontal2,
  Focus,
  Grid,
  QrCode,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Video,
  VideoOff,
  X,
  WifiOff,
  ZoomIn,
} from 'lucide-react';
import {
  CameraCapabilities,
  CameraSettings,
  CaptureCategory,
  CapturedPhoto,
  ConnectionStatus,
  DEFAULT_CAMERA_SETTINGS,
  FrameRatePreset,
  FramingGuide,
  ResolutionPreset,
  SignalingMessage,
} from '../../types/lenslink';
import {
  applyHardwareConstraints,
  buildVideoFilterCss,
  captureProcessedPhoto,
  extractCameraCapabilities,
  getCameraStreamSafe,
  getRtcConfiguration,
  getWsUrl,
  isLocalLanHostname,
  triggerTapAutoFocus,
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
  const [pcName, setPcName] = useState<string>('PC');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({ devices: [] });

  // BIS Jewellery & HUID capture workflow state
  const [framingGuide, setFramingGuide] = useState<FramingGuide>('none');
  const [captureCategory, setCaptureCategory] = useState<CaptureCategory>('article');
  const [lastCaptured, setLastCaptured] = useState<CapturedPhoto | null>(null);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [focusReticle, setFocusReticle] = useState<{ x: number; y: number } | null>(null);
  const [zoomToast, setZoomToast] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewfinderRef = useRef<HTMLDivElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const reconnectTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const isStreamingRef = useRef(false);
  const settingsRef = useRef<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const capabilitiesRef = useRef<CameraCapabilities>({ devices: [] });
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const focusReticleTimerRef = useRef<number | null>(null);
  const zoomToastTimerRef = useRef<number | null>(null);

  // Pinch-to-zoom tracking
  const pinchStateRef = useRef<{
    active: boolean;
    startDist: number;
    startTotalZoom: number;
  }>({ active: false, startDist: 0, startTotalZoom: 1 });

  settingsRef.current = settings;
  capabilitiesRef.current = capabilities;
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
      // Optional on unsupported browsers
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
          capabilitiesRef.current = caps;

          // Match active deviceId if browser auto-selected one
          const activeTrackSettings =
            typeof track.getSettings === 'function' ? track.getSettings() : {};
          if (activeTrackSettings.deviceId && !nextSettings.deviceId) {
            const updated = { ...nextSettings, deviceId: activeTrackSettings.deviceId };
            setSettings(updated);
            settingsRef.current = updated;
          }

          sendWs({
            type: 'camera:capabilities',
            capabilities: caps,
            phoneName: navigator.userAgent.includes('iPhone')
              ? 'iPhone Camera'
              : navigator.userAgent.includes('Android')
                ? 'Android Camera'
                : 'Mobile Browser Camera',
          });

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

  const handleCapturePhoto = useCallback(
    async (categoryOverride?: CaptureCategory) => {
      const video = videoRef.current;
      if (!video) return;
      const cat = categoryOverride || captureCategory;
      const currentSettings = settingsRef.current;
      const caps = capabilitiesRef.current;
      const track = localStreamRef.current?.getVideoTracks()[0] || null;
      const activeDev = caps.devices.find((d) => d.deviceId === currentSettings.deviceId);
      const lensLabel =
        activeDev?.shortLabel ||
        (currentSettings.facingMode === 'environment' ? 'Rear Camera' : 'Front Camera');

      setCaptureFlash(true);
      window.setTimeout(() => setCaptureFlash(false), 180);

      const photo = await captureProcessedPhoto({
        video,
        track,
        settings: currentSettings,
        category: cat,
        lensLabel,
        hardwareBrightnessActive: Boolean(caps.brightness),
        hardwareContrastActive: Boolean(caps.contrast),
      });

      if (photo) {
        setLastCaptured(photo);
        sendWs({
          type: 'camera:photo-captured',
          photo,
        });
      }
    },
    [captureCategory, sendWs]
  );

  // Signaling WebSocket with automatic reconnection
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
          if (msg.pcName) setPcName(msg.pcName);
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

        if (msg.type === 'camera:trigger-focus') {
          const track = localStreamRef.current?.getVideoTracks()[0];
          void triggerTapAutoFocus(track, msg.focusPoint);
          return;
        }

        if (msg.type === 'camera:request-capture') {
          void handleCapturePhoto(msg.captureCategory);
          return;
        }

        if (msg.type === 'camera:settings' && msg.settings) {
          const incoming = msg.settings;
          const prev = settingsRef.current;
          const merged: CameraSettings = { ...prev, ...incoming };
          setSettings(merged);
          settingsRef.current = merged;

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
  }, [activeCode, closePeerConnection, createAndSendOffer, handleCapturePhoto, sendWs, startLocalCamera]);

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

  const updateSetting = useCallback(
    async (patch: Partial<CameraSettings>) => {
      const prev = settingsRef.current;
      const next = { ...prev, ...patch };
      setSettings(next);
      settingsRef.current = next;
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
    },
    [sendWs, startLocalCamera]
  );

  // Hybrid Zoom setter: uses hardware zoom up to device max, then smooth digital zoom up to 8x total
  const setTotalZoom = useCallback(
    (desiredTotalZoom: number) => {
      const clampedTotal = Math.min(8, Math.max(1, desiredTotalZoom));
      const hwZoomCap = capabilitiesRef.current.zoom;

      let nextHwZoom = 1;
      let nextDigitalZoom = 1;

      if (hwZoomCap && hwZoomCap.max > 1) {
        nextHwZoom = Math.min(hwZoomCap.max, Math.max(hwZoomCap.min, clampedTotal));
        nextDigitalZoom =
          clampedTotal > hwZoomCap.max
            ? Math.min(4, Number((clampedTotal / hwZoomCap.max).toFixed(2)))
            : 1;
      } else {
        nextHwZoom = 1;
        nextDigitalZoom = Math.min(4, Number(clampedTotal.toFixed(2)));
      }

      setZoomToast(true);
      if (zoomToastTimerRef.current) clearTimeout(zoomToastTimerRef.current);
      zoomToastTimerRef.current = window.setTimeout(() => setZoomToast(false), 1200);

      void updateSetting({ zoom: nextHwZoom, digitalZoom: nextDigitalZoom });
    },
    [updateSetting]
  );

  // Pinch-to-zoom & Tap-to-focus gesture handlers on viewfinder
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      pinchStateRef.current = {
        active: true,
        startDist: dist,
        startTotalZoom: settingsRef.current.zoom * settingsRef.current.digitalZoom,
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStateRef.current.active) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (pinchStateRef.current.startDist > 0) {
        const scale = dist / pinchStateRef.current.startDist;
        setTotalZoom(pinchStateRef.current.startTotalZoom * scale);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (pinchStateRef.current.active && e.touches.length < 2) {
      pinchStateRef.current.active = false;
    }
  };

  const handleViewfinderTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (pinchStateRef.current.active || !viewfinderRef.current) return;
    const rect = viewfinderRef.current.getBoundingClientRect();
    const relX = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const relY = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));

    setFocusReticle({ x: relX * 100, y: relY * 100 });
    if (focusReticleTimerRef.current) clearTimeout(focusReticleTimerRef.current);
    focusReticleTimerRef.current = window.setTimeout(() => setFocusReticle(null), 1200);

    if (settingsRef.current.focusMode !== 'continuous') {
      void updateSetting({ focusMode: 'continuous' });
    }
    const track = localStreamRef.current?.getVideoTracks()[0];
    void triggerTapAutoFocus(track, { x: relX, y: relY });
  };

  const handleFlipCamera = () => {
    const nextFacing = settings.facingMode === 'environment' ? 'user' : 'environment';
    void updateSetting({
      facingMode: nextFacing,
      deviceId: undefined,
      zoom: 1,
      digitalZoom: 1,
      torch: false,
      mirror: nextFacing === 'user',
    });
  };

  const handleResetImageControls = () => {
    void updateSetting({
      zoom: 1,
      digitalZoom: 1,
      focusMode: 'continuous',
      focusDistance: 0.5,
      brightness: 0,
      contrast: 0,
      sharpness: 50,
      grayscale: false,
      exposureCompensation: 0,
      whiteBalanceMode: 'continuous',
    });
  };

  const handleQrDetected = useCallback(
    (code: string) => {
      setScannerOpen(false);
      setPairCodeInput(code);
      setActiveCode(code);
      window.setTimeout(() => {
        void startLocalCamera(settingsRef.current);
      }, 220);
    },
    [startLocalCamera]
  );

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
                Scan the QR code on your Windows PC or enter the 6-character pairing code. Full lens, focus, zoom, brightness, and contrast controls unlock once paired.
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
                  onChange={(e) =>
                    setPairCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                  }
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

  const totalZoom = Number((settings.zoom * settings.digitalZoom).toFixed(1));
  const filterCss = buildVideoFilterCss(
    settings,
    Boolean(capabilities.brightness),
    Boolean(capabilities.contrast)
  );
  const videoTransform = [
    settings.facingMode === 'user' ? 'scaleX(-1)' : '',
    settings.digitalZoom > 1 ? `scale(${settings.digitalZoom})` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const rearDevices = capabilities.devices.filter((d) => d.facing !== 'front');
  const statusLabel =
    connectionStatus === 'connected'
      ? `Live on ${pcName}`
      : connectionStatus === 'connecting'
        ? 'Connecting'
        : connectionStatus === 'reconnecting'
          ? `Reconnecting (${reconnectAttempt})`
          : pcOnline
            ? `Paired: ${pcName}`
            : 'Waiting for PC';

  const cycleFramingGuide = () => {
    setFramingGuide((prev) =>
      prev === 'none' ? 'article' : prev === 'article' ? 'huid' : 'none'
    );
  };

  return (
    <div className="relative h-[100dvh] w-full bg-black text-white overflow-hidden flex flex-col select-none">
      {/* Compact Top Bar */}
      <header className="relative z-20 flex items-center justify-between px-3 py-1.5 bg-slate-950/90 backdrop-blur-md border-b border-white/10">
        <button
          type="button"
          onClick={handleLeaveRoom}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-white/10 text-slate-200"
          aria-label="Disconnect and change pairing code"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 min-w-0">
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

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={cycleFramingGuide}
            className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl transition-colors ${
              framingGuide !== 'none'
                ? 'bg-blue-600/25 text-blue-300'
                : 'hover:bg-white/10 text-slate-200'
            }`}
            aria-label="Toggle BIS framing guide"
            title="Cycle framing guide (Off / Article Grid / HUID Target)"
          >
            <Grid className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setControlsOpen(true)}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-white/10 text-slate-200"
            aria-label="Open all camera controls"
          >
            <SlidersHorizontal className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Live Camera Viewfinder with Pinch-to-Zoom & Tap-to-Focus */}
      <div
        ref={viewfinderRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleViewfinderTap}
        className="relative flex-1 bg-black flex items-center justify-center overflow-hidden touch-none"
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            transform: videoTransform || undefined,
            filter: filterCss,
          }}
          className="w-full h-full object-cover"
        />

        {/* Shutter Flash Feedback */}
        {captureFlash && (
          <div className="pointer-events-none absolute inset-0 bg-white/75 z-30" />
        )}

        {/* Tap-to-Focus Reticle */}
        {focusReticle && (
          <div
            style={{
              left: `${focusReticle.x}%`,
              top: `${focusReticle.y}%`,
            }}
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 w-14 h-14 border-2 border-amber-400 rounded-lg z-20 flex items-center justify-center shadow-sm"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          </div>
        )}

        {/* BIS Article Framing Grid */}
        {framingGuide === 'article' && (
          <div className="pointer-events-none absolute inset-0 z-10 grid grid-cols-3 grid-rows-3">
            {Array.from({ length: 9 }).map((_, idx) => (
              <div key={idx} className="border border-white/20" />
            ))}
          </div>
        )}

        {/* BIS HUID Macro Alignment Target */}
        {framingGuide === 'huid' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center">
            <div className="w-56 h-24 rounded-xl border-2 border-amber-400/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)] flex items-center justify-center">
              <div className="w-4 h-px bg-amber-400/80" />
            </div>
            <span className="mt-2.5 px-2.5 py-1 rounded-md bg-black/75 text-[11px] font-medium text-amber-200">
              Align 6-digit HUID mark inside frame
            </span>
          </div>
        )}

        {errorMsg && (
          <div className="absolute top-3 inset-x-4 z-20 flex items-center gap-2 p-3 rounded-xl bg-red-950/90 border border-red-800 text-xs text-red-100">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* Quiet technical readout */}
        <div className="pointer-events-none absolute top-3 left-3 z-10 px-2.5 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-[11px] font-mono text-slate-200 tabular-nums">
          {settings.resolution} · {settings.frameRate} fps · {totalZoom.toFixed(1)}× ·{' '}
          {settings.focusMode === 'manual' ? 'Manual Focus' : 'Auto Focus'}
        </div>

        {/* Zoom feedback badge while pinching */}
        {zoomToast && (
          <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 px-4 py-2 rounded-xl bg-black/75 backdrop-blur-sm font-mono text-lg font-semibold text-white tabular-nums">
            {totalZoom.toFixed(1)}×
          </div>
        )}

        {/* Last Captured Thumbnail Chip (tap to save locally too) */}
        {lastCaptured && (
          <a
            href={lastCaptured.dataUrl}
            download={`${lastCaptured.category}-${Date.now()}.jpg`}
            onClick={(e) => e.stopPropagation()}
            className="absolute top-3 right-3 z-20 flex items-center gap-2 p-1.5 pr-2.5 rounded-xl bg-slate-900/90 border border-white/20 text-xs text-white"
            title="Download captured photo"
          >
            <img
              src={lastCaptured.dataUrl}
              alt="Last capture"
              className="w-9 h-9 rounded-lg object-cover"
            />
            <div className="text-left leading-tight">
              <div className="font-semibold text-[11px]">
                {lastCaptured.category === 'huid' ? 'HUID Saved' : 'Article Saved'}
              </div>
              <div className="text-[10px] text-slate-300 flex items-center gap-1">
                <Download className="w-3 h-3" />
                <span>Download</span>
              </div>
            </div>
          </a>
        )}
      </div>

      {/* Quick On-Screen Optical Strip (Rear Lenses, Zoom Presets, AF/MF, Torch, HUID Clarity) */}
      <div className="relative z-20 bg-slate-950/95 border-t border-white/10 px-3 pt-2.5 pb-1.5 space-y-2">
        {/* Rear Camera / Lens Switcher when multiple rear cameras exist */}
        {rearDevices.length > 1 && settings.facingMode === 'environment' && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {rearDevices.map((dev) => {
              const active = settings.deviceId === dev.deviceId;
              return (
                <button
                  key={dev.deviceId}
                  type="button"
                  onClick={() =>
                    void updateSetting({
                      facingMode: 'environment',
                      deviceId: dev.deviceId,
                    })
                  }
                  className={`min-h-[36px] px-3 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-800/90 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {dev.shortLabel}
                </button>
              );
            })}
          </div>
        )}

        {/* Manual Focus Fine Slider when MF is selected */}
        {settings.focusMode === 'manual' && capabilities.focusDistance && (
          <div className="flex items-center gap-3 px-1">
            <span className="text-[11px] font-medium text-amber-300 whitespace-nowrap">
              Macro Focus
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={settings.focusDistance}
              onChange={(e) =>
                void updateSetting({ focusDistance: Number(e.target.value) })
              }
              className="flex-1 lens-slider"
              aria-label="Manual focus distance"
            />
          </div>
        )}

        {/* Zoom Quick Presets + Focus + Contrast/Torch Shortcuts */}
        <div className="flex items-center justify-between gap-2 overflow-x-auto">
          <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl shrink-0">
            {[1, 2, 3, 5].map((z) => {
              const isSelected = Math.abs(totalZoom - z) < 0.25;
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => setTotalZoom(z)}
                  className={`min-h-[36px] px-2.5 rounded-lg font-mono text-xs font-semibold tabular-nums transition-colors ${
                    isSelected
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {z}×
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (
                  settings.focusMode === 'continuous' &&
                  capabilities.focusModes?.includes('manual')
                ) {
                  void updateSetting({ focusMode: 'manual' });
                } else {
                  void updateSetting({ focusMode: 'continuous' });
                  const track = localStreamRef.current?.getVideoTracks()[0];
                  void triggerTapAutoFocus(track);
                }
              }}
              className={`min-h-[40px] px-2.5 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                settings.focusMode === 'manual'
                  ? 'bg-amber-500 text-slate-950 font-semibold'
                  : 'bg-slate-800 text-slate-200'
              }`}
              title="Toggle Auto Focus / Manual Focus"
            >
              <Focus className="w-3.5 h-3.5" />
              <span>{settings.focusMode === 'manual' ? 'MF' : 'AF'}</span>
            </button>

            <button
              type="button"
              onClick={() =>
                void updateSetting({
                  grayscale: !settings.grayscale,
                  contrast: !settings.grayscale && settings.contrast < 25 ? 30 : settings.contrast,
                })
              }
              className={`min-h-[40px] px-2.5 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                settings.grayscale
                  ? 'bg-white text-slate-950 font-semibold'
                  : 'bg-slate-800 text-slate-200'
              }`}
              title="High-contrast monochrome mode for HUID reading"
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>HUID B&amp;W</span>
            </button>

            {capabilities.torch && settings.facingMode === 'environment' && (
              <button
                type="button"
                onClick={() => void updateSetting({ torch: !settings.torch })}
                className={`min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl transition-colors ${
                  settings.torch
                    ? 'bg-amber-400 text-slate-950'
                    : 'bg-slate-800 text-slate-200'
                }`}
                aria-label="Toggle flashlight"
              >
                <Flashlight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Natural Thumb-Zone Primary Dock: Flip, Stream, Capture Photo (Article / HUID) */}
      <footer className="relative z-20 px-3 py-3 bg-slate-950 border-t border-white/10">
        <div className="max-w-md mx-auto flex items-center gap-2">
          <button
            type="button"
            onClick={handleFlipCamera}
            className="min-h-[48px] min-w-[48px] flex items-center justify-center rounded-2xl bg-slate-800 hover:bg-slate-700 text-white transition-colors shrink-0"
            aria-label="Switch front or rear camera"
            title="Switch Front / Rear Camera"
          >
            <FlipHorizontal2 className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={handleToggleStream}
            className={`min-h-[48px] px-3.5 flex items-center justify-center gap-2 rounded-2xl font-semibold text-xs transition-all active:scale-[0.98] shrink-0 ${
              isStreaming
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-blue-600 hover:bg-blue-500 text-white'
            }`}
          >
            {isStreaming ? (
              <>
                <VideoOff className="w-4 h-4" />
                <span>Stop</span>
              </>
            ) : (
              <>
                <Video className="w-4 h-4" />
                <span>Stream</span>
              </>
            )}
          </button>

          {/* BIS Capture Mode + Capture Button */}
          <div className="flex-1 flex items-center bg-slate-900 rounded-2xl p-1 border border-slate-800">
            <button
              type="button"
              onClick={() =>
                setCaptureCategory((prev) => (prev === 'article' ? 'huid' : 'article'))
              }
              className="min-h-[40px] px-2.5 rounded-xl bg-slate-800 text-[11px] font-semibold text-slate-200 whitespace-nowrap"
              title="Switch photo tag between Jewellery Article and HUID"
            >
              {captureCategory === 'article' ? 'Article' : 'HUID'}
            </button>
            <button
              type="button"
              onClick={() => void handleCapturePhoto()}
              className="flex-1 min-h-[40px] flex items-center justify-center gap-1.5 rounded-xl bg-white text-slate-950 hover:bg-slate-100 active:scale-[0.98] font-semibold text-xs transition-all ml-1"
            >
              <Camera className="w-4 h-4" />
              <span>Capture</span>
            </button>
          </div>
        </div>
      </footer>

      {/* Complete Camera & Image Controls Bottom Sheet */}
      {controlsOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/60 backdrop-blur-xs"
          onClick={() => setControlsOpen(false)}
        >
          <div
            className="w-full max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-slate-900 border-t border-slate-700 p-5 pb-8 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1.5 bg-slate-700 rounded-full mx-auto" />

            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Camera &amp; BIS Capture Controls</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleResetImageControls}
                  className="min-h-[40px] px-3 rounded-xl bg-slate-800 text-xs font-medium text-slate-300 hover:text-white inline-flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset</span>
                </button>
                <button
                  type="button"
                  onClick={() => setControlsOpen(false)}
                  className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300"
                  aria-label="Close controls"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Camera / Rear Lens Picker */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-400">
                Camera Lens Selection
              </label>
              {capabilities.devices.length > 0 ? (
                <div className="grid grid-cols-1 gap-1.5">
                  {capabilities.devices.map((dev) => {
                    const active = settings.deviceId === dev.deviceId;
                    return (
                      <button
                        key={dev.deviceId}
                        type="button"
                        onClick={() =>
                          void updateSetting({
                            deviceId: dev.deviceId,
                            facingMode: dev.facing === 'front' ? 'user' : 'environment',
                            mirror: dev.facing === 'front',
                          })
                        }
                        className={`min-h-[44px] px-3.5 rounded-xl text-left text-xs font-medium flex items-center justify-between border transition-colors ${
                          active
                            ? 'bg-blue-600/20 border-blue-500 text-white'
                            : 'bg-slate-800/80 border-slate-700 text-slate-300'
                        }`}
                      >
                        <span className="truncate">{dev.label}</span>
                        <span className="ml-2 text-[11px] font-mono text-slate-400 shrink-0">
                          {dev.shortLabel}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void updateSetting({ facingMode: 'environment', deviceId: undefined, mirror: false })
                    }
                    className={`min-h-[44px] rounded-xl text-xs font-semibold ${
                      settings.facingMode === 'environment'
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    Rear Camera
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateSetting({ facingMode: 'user', deviceId: undefined, mirror: true })
                    }
                    className={`min-h-[44px] rounded-xl text-xs font-semibold ${
                      settings.facingMode === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    Front Camera
                  </button>
                </div>
              )}
            </div>

            {/* Pinch / Slider Zoom */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-medium text-slate-400 flex items-center gap-1.5">
                  <ZoomIn className="w-3.5 h-3.5" />
                  <span>Zoom (Pinch Viewfinder or Slide)</span>
                </span>
                <span className="font-mono tabular-nums text-slate-200">
                  {totalZoom.toFixed(1)}×
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={8}
                step={0.1}
                value={totalZoom}
                onChange={(e) => setTotalZoom(Number(e.target.value))}
                className="w-full lens-slider"
              />
            </div>

            {/* Focus Mode & Macro Focus Distance */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Focus Control</span>
                <div className="flex gap-1.5 bg-slate-800 p-1 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      void updateSetting({ focusMode: 'continuous' });
                      const track = localStreamRef.current?.getVideoTracks()[0];
                      void triggerTapAutoFocus(track);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                      settings.focusMode === 'continuous'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-300'
                    }`}
                  >
                    Auto Focus
                  </button>
                  {capabilities.focusModes?.includes('manual') && (
                    <button
                      type="button"
                      onClick={() => void updateSetting({ focusMode: 'manual' })}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                        settings.focusMode === 'manual'
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-300'
                      }`}
                    >
                      Manual
                    </button>
                  )}
                </div>
              </div>
              {settings.focusMode === 'manual' && capabilities.focusDistance && (
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Macro Close</span>
                    <span>Far</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={settings.focusDistance}
                    onChange={(e) =>
                      void updateSetting({ focusDistance: Number(e.target.value) })
                    }
                    className="w-full lens-slider"
                    aria-label="Manual focus distance"
                  />
                </div>
              )}
            </div>

            {/* Exposure Compensation (Hardware EV when supported) */}
            {capabilities.exposureCompensation && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-medium text-slate-400">Exposure (Sensor EV)</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {settings.exposureCompensation > 0 ? '+' : ''}
                    {settings.exposureCompensation.toFixed(1)} EV
                  </span>
                </div>
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
              </div>
            )}

            {/* Brightness */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-medium text-slate-400">Image Brightness</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {settings.brightness > 0 ? '+' : ''}
                  {settings.brightness}%
                </span>
              </div>
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
            </div>

            {/* Contrast */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-medium text-slate-400">Image Contrast</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {100 + settings.contrast}%
                </span>
              </div>
              <input
                type="range"
                min={-50}
                max={100}
                step={5}
                value={settings.contrast}
                onChange={(e) =>
                  void updateSetting({ contrast: Number(e.target.value) })
                }
                className="w-full lens-slider"
              />
            </div>

            {/* Hardware Sharpness when supported */}
            {capabilities.sharpness && (
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-medium text-slate-400">Sharpness</span>
                  <span className="font-mono tabular-nums text-slate-200">
                    {settings.sharpness}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.sharpness}
                  onChange={(e) =>
                    void updateSetting({ sharpness: Number(e.target.value) })
                  }
                  className="w-full lens-slider"
                />
              </div>
            )}

            {/* White Balance when supported */}
            {capabilities.whiteBalanceModes && capabilities.whiteBalanceModes.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">White Balance</span>
                  <div className="flex gap-1.5 bg-slate-800 p-1 rounded-xl">
                    {(['continuous', 'manual'] as const).map((wb) => {
                      if (!capabilities.whiteBalanceModes?.includes(wb)) return null;
                      return (
                        <button
                          key={wb}
                          type="button"
                          onClick={() => void updateSetting({ whiteBalanceMode: wb })}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                            settings.whiteBalanceMode === wb
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-300'
                          }`}
                        >
                          {wb === 'continuous' ? 'Auto' : 'Manual'}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {settings.whiteBalanceMode === 'manual' && capabilities.colorTemperature && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] font-mono text-slate-400">
                      <span>Warm</span>
                      <span>{settings.colorTemperature}K</span>
                      <span>Cool</span>
                    </div>
                    <input
                      type="range"
                      min={capabilities.colorTemperature.min}
                      max={capabilities.colorTemperature.max}
                      step={capabilities.colorTemperature.step || 100}
                      value={settings.colorTemperature}
                      onChange={(e) =>
                        void updateSetting({ colorTemperature: Number(e.target.value) })
                      }
                      className="w-full lens-slider"
                    />
                  </div>
                )}
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
