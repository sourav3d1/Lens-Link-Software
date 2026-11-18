import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CheckCircle2,
  Copy,
  FlipHorizontal2,
  Maximize2,
  RefreshCw,
  Smartphone,
  Video,
  Wifi,
  WifiOff,
  Download,
  Flashlight,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import {
  CameraCapabilities,
  CameraSettings,
  CaptureCategory,
  CapturedPhoto,
  ConnectionStatus,
  DEFAULT_CAMERA_SETTINGS,
  FrameRatePreset,
  NetworkInfoResponse,
  RESOLUTION_DIMENSIONS,
  ResolutionPreset,
  SignalingMessage,
  StreamStats,
} from '../../types/lenslink';
import {
  buildVideoFilterCss,
  captureProcessedPhoto,
  collectInboundStats,
  getRtcConfiguration,
  getWsUrl,
  isLocalLanHostname,
} from '../../lib/webrtc';
import { VirtualCamPanel } from '../vcam/VirtualCamPanel';
import { QrCodeDisplay } from '../common/QrCodeDisplay';
import { PWAInstallButton } from '../common/PWAInstallButton';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateLocalPairingCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function generateSessionToken(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getSavedPcName(): string {
  try {
    return localStorage.getItem('lenslink_pc_name') || 'PC Workstation';
  } catch {
    return 'PC Workstation';
  }
}

type ActiveTab = 'receiver' | 'virtual-cam' | 'guide';

interface PcReceiverViewProps {
  onOpenPhoneMode: (pairCode: string) => void;
}

export function PcReceiverView({ onOpenPhoneMode }: PcReceiverViewProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('receiver');
  // Generate a brand-new dynamic session pairing code and token every time the PC app opens
  const [pairCode, setPairCode] = useState<string>(generateLocalPairingCode);
  const [sessionToken, setSessionToken] = useState<string>(generateSessionToken);
  const [pcName, setPcName] = useState<string>(getSavedPcName);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfoResponse | null>(null);
  const [selectedOrigin, setSelectedOrigin] = useState<string>(window.location.origin);

  const [phoneOnline, setPhoneOnline] = useState(false);
  const [phoneName, setPhoneName] = useState<string>('Smartphone');
  const [phoneStreaming, setPhoneStreaming] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('waiting');
  const [hasVideoTrack, setHasVideoTrack] = useState(false);

  const [vcamBridgeCount, setVcamBridgeCount] = useState(0);
  const [vcamWebCount, setVcamWebCount] = useState(0);
  const [vcamWebPeerIds, setVcamWebPeerIds] = useState<string[]>([]);
  const [bridgeStreamEnabled, setBridgeStreamEnabled] = useState(false);

  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities | null>(null);
  const [stats, setStats] = useState<StreamStats>({
    width: 0,
    height: 0,
    fps: 0,
    bitrateKbps: 0,
    rttMs: null,
  });

  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [localOnlyIce, setLocalOnlyIce] = useState<boolean>(() => isLocalLanHostname());
  const [capturedPhotos, setCapturedPhotos] = useState<CapturedPhoto[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const vcamPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const prevStatsRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pairCodeRef = useRef<string>(pairCode);
  const sessionTokenRef = useRef<string>(sessionToken);
  const pcNameRef = useRef<string>(pcName);
  const phoneOnlineRef = useRef<boolean>(phoneOnline);
  const localOnlyIceRef = useRef<boolean>(localOnlyIce);
  const settingsRef = useRef<CameraSettings>(settings);

  pairCodeRef.current = pairCode;
  sessionTokenRef.current = sessionToken;
  pcNameRef.current = pcName;
  phoneOnlineRef.current = phoneOnline;
  localOnlyIceRef.current = localOnlyIce;
  settingsRef.current = settings;

  // Fetch local LAN IP info for QR code generation
  useEffect(() => {
    let active = true;
    fetch('/api/network-info')
      .then((res) => res.json())
      .then((data: NetworkInfoResponse) => {
        if (!active) return;
        setNetworkInfo(data);
        if (data.suggestedOrigin) {
          setSelectedOrigin(data.suggestedOrigin);
        }
      })
      .catch(() => {
        // Keep window.location.origin fallback
      });
    return () => {
      active = false;
    };
  }, []);

  const sendWs = useCallback((msg: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const closePhonePeer = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onicecandidate = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    pendingIceRef.current = [];
    remoteStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setHasVideoTrack(false);
    prevStatsRef.current = null;
    setStats({ width: 0, height: 0, fps: 0, bitrateKbps: 0, rttMs: null });
  }, []);

  const closeVcamWebPeers = useCallback(() => {
    for (const rtc of vcamPeersRef.current.values()) {
      rtc.close();
    }
    vcamPeersRef.current.clear();
  }, []);

  // Forward live remote MediaStream to chromeless /vcam browser outputs via local loopback WebRTC
  const connectVcamWebPeer = useCallback(
    async (peerId: string) => {
      const stream = remoteStreamRef.current;
      if (!stream) return;

      const existing = vcamPeersRef.current.get(peerId);
      if (existing) existing.close();

      const rtc = new RTCPeerConnection(getRtcConfiguration(true));
      vcamPeersRef.current.set(peerId, rtc);

      const track = stream.getVideoTracks()[0];
      if (track) {
        rtc.addTrack(track, stream);
      }

      rtc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendWs({
            type: 'rtc:ice-candidate',
            target: 'vcam-web',
            peerId,
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      rtc.onconnectionstatechange = () => {
        if (rtc.connectionState === 'closed' || rtc.connectionState === 'failed') {
          vcamPeersRef.current.delete(peerId);
        }
      };

      const offer = await rtc.createOffer();
      await rtc.setLocalDescription(offer);
      sendWs({
        type: 'rtc:offer',
        target: 'vcam-web',
        peerId,
        sdp: rtc.localDescription?.toJSON(),
      });
    },
    [sendWs]
  );

  // Signaling WebSocket with auto-reconnect
  useEffect(() => {
    let disposed = false;
    let attempt = 0;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        const codeToUse = pairCodeRef.current || generateLocalPairingCode();
        sendWs({
          type: 'room:create',
          code: codeToUse,
          sessionToken: sessionTokenRef.current,
          pcName: pcNameRef.current,
        });
      };

      ws.onmessage = async (event) => {
        let msg: SignalingMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'room:created' || msg.type === 'room:joined') {
          if (msg.code) {
            setPairCode(msg.code);
            pairCodeRef.current = msg.code;
          }
          return;
        }

        if (msg.type === 'room:status') {
          const isPhoneOnline = Boolean(msg.phoneOnline);
          setPhoneOnline(isPhoneOnline);
          if (msg.phoneName) setPhoneName(msg.phoneName);
          if (msg.capabilities) setCapabilities(msg.capabilities);
          if (typeof msg.vcamBridgeCount === 'number') setVcamBridgeCount(msg.vcamBridgeCount);
          if (typeof msg.vcamWebCount === 'number') setVcamWebCount(msg.vcamWebCount);
          if (Array.isArray(msg.vcamWebPeerIds)) {
            setVcamWebPeerIds(msg.vcamWebPeerIds);
            // Clean up any departed vcam-web peers
            for (const existingPeerId of Array.from(vcamPeersRef.current.keys())) {
              if (!msg.vcamWebPeerIds.includes(existingPeerId)) {
                vcamPeersRef.current.get(existingPeerId)?.close();
                vcamPeersRef.current.delete(existingPeerId);
              }
            }
          }

          if (!isPhoneOnline) {
            setPhoneStreaming(false);
            setConnectionStatus('waiting');
            closePhonePeer();
            closeVcamWebPeers();
          }
          return;
        }

        if (msg.type === 'camera:capabilities') {
          if (msg.capabilities) setCapabilities(msg.capabilities);
          if (msg.phoneName) setPhoneName(msg.phoneName);
          return;
        }

        if (msg.type === 'camera:stream-state') {
          const active = Boolean(msg.streaming);
          setPhoneStreaming(active);
          if (!active) {
            closePhonePeer();
            closeVcamWebPeers();
            setConnectionStatus(phoneOnlineRef.current ? 'waiting' : 'disconnected');
          }
          return;
        }

        if (msg.type === 'camera:settings' && msg.settings) {
          setSettings((prev) => ({ ...prev, ...msg.settings }));
          return;
        }

        if (msg.type === 'camera:photo-captured' && msg.photo) {
          const incomingPhoto = msg.photo;
          setCapturedPhotos((prev) => [incomingPhoto, ...prev].slice(0, 12));
          return;
        }

        // Loopback answer/ICE from chromeless vcam-web outputs
        if (msg.from === 'vcam-web' && msg.peerId) {
          const vcamPeer = vcamPeersRef.current.get(msg.peerId);
          if (msg.type === 'rtc:answer' && msg.sdp && vcamPeer) {
            await vcamPeer.setRemoteDescription(new RTCSessionDescription(msg.sdp)).catch(() => {});
          } else if (msg.type === 'rtc:ice-candidate' && msg.candidate && vcamPeer) {
            await vcamPeer.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
          }
          return;
        }

        // Handle WebRTC offer from Smartphone
        if (msg.type === 'rtc:offer' && msg.sdp) {
          closePhonePeer();
          setConnectionStatus('connecting');
          setPhoneStreaming(true);

          const rtc = new RTCPeerConnection(getRtcConfiguration(localOnlyIceRef.current));
          pcRef.current = rtc;

          rtc.ontrack = (trackEvent) => {
            const stream =
              trackEvent.streams[0] ||
              (trackEvent.track ? new MediaStream([trackEvent.track]) : null);
            if (stream) {
              remoteStreamRef.current = stream;
              if (videoRef.current) {
                videoRef.current.srcObject = stream;
                void videoRef.current.play().catch(() => {});
              }
              setHasVideoTrack(true);
              setConnectionStatus('connected');
            }
          };

          rtc.onicecandidate = (iceEvent) => {
            if (iceEvent.candidate) {
              sendWs({
                type: 'rtc:ice-candidate',
                target: 'phone',
                candidate: iceEvent.candidate.toJSON(),
              });
            }
          };

          rtc.onconnectionstatechange = () => {
            const st = rtc.connectionState;
            if (st === 'connected') {
              setConnectionStatus('connected');
            } else if (st === 'connecting') {
              setConnectionStatus('connecting');
            } else if (st === 'disconnected') {
              setConnectionStatus('reconnecting');
            } else if (st === 'failed') {
              setConnectionStatus('reconnecting');
              sendWs({ type: 'rtc:restart', target: 'phone' });
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
            sendWs({
              type: 'rtc:answer',
              target: 'phone',
              sdp: rtc.localDescription?.toJSON(),
            });
          } catch {
            setConnectionStatus('reconnecting');
          }
          return;
        }

        if (msg.type === 'rtc:ice-candidate' && msg.candidate) {
          if (pcRef.current && pcRef.current.remoteDescription) {
            await pcRef.current
              .addIceCandidate(new RTCIceCandidate(msg.candidate))
              .catch(() => {});
          } else {
            pendingIceRef.current.push(msg.candidate);
          }
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnectionStatus('reconnecting');
        attempt += 1;
        const delay = Math.min(8000, 1000 * Math.pow(1.6, attempt - 1));
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      closePhonePeer();
      closeVcamWebPeers();
    };
  }, [closePhonePeer, closeVcamWebPeers, sendWs]);

  // Periodically collect real WebRTC stats while connected
  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    const interval = window.setInterval(async () => {
      if (!pcRef.current) return;
      try {
        const result = await collectInboundStats(pcRef.current, prevStatsRef.current);
        prevStatsRef.current = result.nextSnapshot;

        const vid = videoRef.current;
        const measuredW = result.stats.width || vid?.videoWidth || 0;
        const measuredH = result.stats.height || vid?.videoHeight || 0;
        setStats({
          ...result.stats,
          width: measuredW,
          height: measuredH,
        });
      } catch {
        // Ignore transient stats error
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [connectionStatus]);

  // Auto-enable bridge frame relay when Windows Python Virtual Cam bridge connects
  useEffect(() => {
    if (vcamBridgeCount > 0 && hasVideoTrack) {
      setBridgeStreamEnabled(true);
    }
  }, [vcamBridgeCount, hasVideoTrack]);

  // Stream JPEG frames over localhost WS to Windows Virtual Camera Bridge when enabled
  useEffect(() => {
    if (!bridgeStreamEnabled || !hasVideoTrack || vcamBridgeCount === 0) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const targetFps = Math.min(30, settings.frameRate || 30);
    const intervalMs = Math.round(1000 / targetFps);
    let busy = false;

    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const ws = wsRef.current;
      if (
        busy ||
        !video ||
        !ws ||
        ws.readyState !== WebSocket.OPEN ||
        video.readyState < video.HAVE_CURRENT_DATA
      ) {
        return;
      }

      const dims = RESOLUTION_DIMENSIONS[settings.resolution] || RESOLUTION_DIMENSIONS['720p'];
      const w = video.videoWidth || dims.width;
      const h = video.videoHeight || dims.height;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const filterCss = buildVideoFilterCss(
        settings,
        Boolean(capabilities?.brightness),
        Boolean(capabilities?.contrast)
      );
      const dz = Math.max(1, settings.digitalZoom || 1);
      const cropW = Math.round(w / dz);
      const cropH = Math.round(h / dz);
      const cropX = Math.round((w - cropW) / 2);
      const cropY = Math.round((h - cropH) / 2);

      busy = true;
      ctx.save();
      if (settings.mirror) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.filter = filterCss || 'none';
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, w, h);
      ctx.restore();

      canvas.toBlob(
        (blob) => {
          if (blob && ws.readyState === WebSocket.OPEN) {
            void blob.arrayBuffer().then((buf) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(buf);
              }
              busy = false;
            });
          } else {
            busy = false;
          }
        },
        'image/jpeg',
        0.82
      );
    }, intervalMs);

    return () => clearInterval(timer);
  }, [bridgeStreamEnabled, capabilities?.brightness, capabilities?.contrast, hasVideoTrack, settings, vcamBridgeCount]);

  // Connect loopback WebRTC streams to any attached chromeless vcam-web output windows
  useEffect(() => {
    if (!hasVideoTrack || !remoteStreamRef.current) return;
    for (const peerId of vcamWebPeerIds) {
      if (!vcamPeersRef.current.has(peerId)) {
        void connectVcamWebPeer(peerId);
      }
    }
  }, [connectVcamWebPeer, hasVideoTrack, vcamWebPeerIds]);

  const handleRegenerateCode = () => {
    closePhonePeer();
    closeVcamWebPeers();
    setPhoneOnline(false);
    setPhoneStreaming(false);
    setCapabilities(null);
    setConnectionStatus('waiting');
    const nextCode = generateLocalPairingCode();
    const nextToken = generateSessionToken();
    setPairCode(nextCode);
    setSessionToken(nextToken);
    pairCodeRef.current = nextCode;
    sessionTokenRef.current = nextToken;
    sendWs({
      type: 'room:create',
      code: nextCode,
      sessionToken: nextToken,
      pcName: pcNameRef.current,
    });
  };

  const handlePcNameChange = (nextName: string) => {
    setPcName(nextName);
    pcNameRef.current = nextName;
    try {
      localStorage.setItem('lenslink_pc_name', nextName);
    } catch {
      // Ignore storage error
    }
    sendWs({
      type: 'room:create',
      code: pairCodeRef.current,
      sessionToken: sessionTokenRef.current,
      pcName: nextName,
    });
  };

  const updateRemoteSetting = (patch: Partial<CameraSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    sendWs({ type: 'camera:settings', settings: patch });
  };

  const pairingUrl = pairCode
    ? `${selectedOrigin}/phone?pair=${pairCode}&sid=${sessionToken}`
    : '';

  const handleCopyCode = async () => {
    if (!pairCode) return;
    await navigator.clipboard.writeText(pairCode).catch(() => {});
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1600);
  };

  const handleCopyLink = async () => {
    if (!pairingUrl) return;
    await navigator.clipboard.writeText(pairingUrl).catch(() => {});
    setCopiedLink(true);
    window.setTimeout(() => setCopiedLink(false), 1600);
  };

  const handleCaptureOnPc = async (category: CaptureCategory) => {
    if (phoneOnline) {
      sendWs({ type: 'camera:request-capture', captureCategory: category });
      return;
    }
    const video = videoRef.current;
    if (!video || !hasVideoTrack) return;
    const photo = await captureProcessedPhoto({
      video,
      settings,
      category,
      lensLabel: settings.facingMode === 'environment' ? 'Rear Camera' : 'Front Camera',
      hardwareBrightnessActive: Boolean(capabilities?.brightness),
      hardwareContrastActive: Boolean(capabilities?.contrast),
    });
    if (photo) {
      setCapturedPhotos((prev) => [photo, ...prev].slice(0, 12));
    }
  };

  const handleFullscreen = () => {
    const el = videoContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  };

  const handleSetTotalZoom = (desiredTotal: number) => {
    const clamped = Math.min(8, Math.max(1, desiredTotal));
    const hwCap = capabilities?.zoom;
    let hwZoom = 1;
    let digitalZoom = 1;
    if (hwCap && hwCap.max > 1) {
      hwZoom = Math.min(hwCap.max, Math.max(hwCap.min, clamped));
      digitalZoom = clamped > hwCap.max ? Math.min(4, Number((clamped / hwCap.max).toFixed(2))) : 1;
    } else {
      digitalZoom = Math.min(4, Number(clamped.toFixed(2)));
    }
    updateRemoteSetting({ zoom: hwZoom, digitalZoom });
  };

  const handleResetAdjustments = () => {
    updateRemoteSetting({
      zoom: 1,
      digitalZoom: 1,
      focusMode: 'continuous',
      focusDistance: 0.5,
      brightness: 0,
      contrast: 0,
      sharpness: 50,
      grayscale: false,
      exposureCompensation: 0,
    });
  };

  const totalZoom = Number((settings.zoom * settings.digitalZoom).toFixed(1));
  const videoFilterCss = buildVideoFilterCss(
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

  const statusMeta = (() => {
    if (connectionStatus === 'connected' && hasVideoTrack) {
      return {
        label: 'Connected',
        colorClass: 'text-emerald-700',
        dotClass: 'bg-emerald-600',
      };
    }
    if (connectionStatus === 'connecting') {
      return {
        label: 'Connecting',
        colorClass: 'text-blue-700',
        dotClass: 'bg-blue-600',
      };
    }
    if (connectionStatus === 'reconnecting') {
      return {
        label: 'Reconnecting',
        colorClass: 'text-amber-700',
        dotClass: 'bg-amber-500',
      };
    }
    if (phoneOnline && !phoneStreaming) {
      return {
        label: 'Phone Paired (Stream Paused)',
        colorClass: 'text-slate-700',
        dotClass: 'bg-slate-500',
      };
    }
    return {
      label: 'Waiting for Smartphone',
      colorClass: 'text-slate-600',
      dotClass: 'bg-slate-400',
    };
  })();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 px-6 lg:px-8">
        <div className="max-w-[1440px] mx-auto h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-element brand wordmark */}
          <a
            href="/"
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            LensLink
          </a>

          {/* Zone 2: Clean single-line navigation links */}
          <nav className="flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveTab('receiver')}
              className={`py-5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'receiver'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Receiver
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('virtual-cam')}
              className={`py-5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'virtual-cam'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Virtual Webcam
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('guide')}
              className={`py-5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'guide'
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Setup Guide
            </button>
          </nav>

          {/* Zone 3: Single primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleRegenerateCode}
              className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              New Pairing Code
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Viewport */}
      <main className="flex-1 px-6 lg:px-8 py-6">
        <div className="max-w-[1440px] mx-auto">
          {activeTab === 'receiver' && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start">
              {/* Left Column: Focal Anchor (Live Video Stage or QR Pairing Stage) */}
              <div className="space-y-4">
                <div
                  ref={videoContainerRef}
                  className={`relative w-full rounded-xl bg-slate-950 border border-slate-200 flex items-center justify-center ${
                    hasVideoTrack
                      ? 'aspect-video overflow-hidden'
                      : 'min-h-[380px] lg:min-h-[480px]'
                  }`}
                >
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    onClick={(e) => {
                      if (!hasVideoTrack) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
                      sendWs({ type: 'camera:trigger-focus', focusPoint: { x, y } });
                    }}
                    style={{
                      transform: videoTransform || undefined,
                      filter: videoFilterCss,
                    }}
                    className={`w-full h-full object-contain ${
                      hasVideoTrack ? 'block cursor-crosshair' : 'hidden'
                    }`}
                  />

                  {/* Pairing / Waiting State */}
                  {!hasVideoTrack && (
                    <div className="w-full h-full p-6 sm:p-8 flex flex-col md:flex-row items-center justify-center gap-6 md:gap-10 bg-slate-950 text-white">
                      <div className="bg-white p-3 rounded-xl shrink-0 shadow-sm">
                        <QrCodeDisplay
                          value={pairingUrl}
                          size={184}
                          alt={`QR code for pairing code ${pairCode}`}
                        />
                      </div>

                      <div className="max-w-sm space-y-4 text-center md:text-left">
                        <div className="space-y-1.5">
                          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
                            {phoneOnline
                              ? 'Smartphone connected — tap Start Streaming on your phone'
                              : 'Scan QR code with your phone'}
                          </h1>
                          <p className="text-sm text-slate-400 leading-relaxed">
                            Open your Android or iPhone camera to scan, or visit the address below in Chrome or Safari.
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center justify-center md:justify-start gap-3">
                          <div className="px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 font-mono text-2xl font-semibold tracking-[0.28em] text-white tabular-nums">
                            {pairCode || '------'}
                          </div>
                          <button
                            type="button"
                            onClick={handleCopyCode}
                            className="px-3.5 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5 transition-colors"
                          >
                            {copiedCode ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 pt-1">
                          <button
                            type="button"
                            onClick={handleCopyLink}
                            className="text-xs font-mono text-blue-400 hover:text-blue-300 underline underline-offset-4 truncate max-w-[260px]"
                          >
                            {copiedLink ? 'Pairing URL copied to clipboard' : pairingUrl}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Reconnecting Overlay if Wi-Fi drops while streaming */}
                  {hasVideoTrack && connectionStatus === 'reconnecting' && (
                    <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-xs flex flex-col items-center justify-center gap-3 text-white">
                      <RefreshCw className="w-7 h-7 animate-spin text-amber-400" />
                      <p className="text-sm font-medium">
                        Wi-Fi signal interrupted — attempting automatic reconnection
                      </p>
                    </div>
                  )}
                </div>

                {/* Clean Unboxed Status & Telemetry Bar */}
                <div className="flex flex-wrap items-center justify-between gap-4 px-1 py-1">
                  <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-2 font-semibold text-slate-900">
                      <span
                        className={`w-2 h-2 rounded-full ${statusMeta.dotClass}`}
                        aria-hidden="true"
                      />
                      <span className={statusMeta.colorClass}>{statusMeta.label}</span>
                    </span>

                    <span aria-hidden="true" className="text-slate-300">·</span>

                    <span className="font-mono tabular-nums">
                      {stats.width > 0 ? `${stats.width} × ${stats.height}` : RESOLUTION_DIMENSIONS[settings.resolution].label}
                    </span>

                    <span aria-hidden="true" className="text-slate-300">·</span>

                    <span className="font-mono tabular-nums">
                      {hasVideoTrack && stats.fps > 0 ? `${stats.fps} fps` : `${settings.frameRate} fps target`}
                    </span>

                    {hasVideoTrack && stats.bitrateKbps > 0 && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-mono tabular-nums">{stats.bitrateKbps} kbps</span>
                      </>
                    )}

                    {hasVideoTrack && stats.rttMs !== null && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-mono tabular-nums">{stats.rttMs} ms RTT</span>
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateRemoteSetting({ mirror: !settings.mirror })}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors inline-flex items-center gap-1.5 ${
                        settings.mirror
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <FlipHorizontal2 className="w-3.5 h-3.5" />
                      <span>Mirror</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleCaptureOnPc('article')}
                      disabled={!hasVideoTrack}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-45 disabled:pointer-events-none inline-flex items-center gap-1.5 transition-colors"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>Capture Photo</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleFullscreen}
                      disabled={!hasVideoTrack}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 disabled:opacity-45 disabled:pointer-events-none inline-flex items-center gap-1.5 transition-colors"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>Fullscreen</span>
                    </button>
                  </div>
                </div>

                {/* Captured Photos Gallery */}
                {capturedPhotos.length > 0 && (
                  <section className="p-4 rounded-xl bg-white border border-slate-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-slate-900">
                        Captured Photos ({capturedPhotos.length})
                      </h2>
                      <button
                        type="button"
                        onClick={() => setCapturedPhotos([])}
                        className="text-xs font-medium text-slate-500 hover:text-red-600 inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Clear</span>
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                      {capturedPhotos.map((photo) => (
                        <div
                          key={photo.id}
                          className="rounded-lg border border-slate-200 overflow-hidden bg-slate-50 flex flex-col"
                        >
                          <img
                            src={photo.dataUrl}
                            alt="Captured photo"
                            className="aspect-video w-full object-cover bg-slate-950"
                          />
                          <div className="p-2 flex items-center justify-between gap-2 text-[11px]">
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 truncate">
                                Captured Photo
                              </div>
                              <div className="font-mono text-slate-500 tabular-nums truncate">
                                {photo.width}×{photo.height} · {photo.zoom}×
                              </div>
                            </div>
                            <a
                              href={photo.dataUrl}
                              download={`lenslink-photo-${photo.id}.jpg`}
                              className="p-1.5 rounded-md bg-white border border-slate-200 text-slate-700 hover:bg-slate-100 shrink-0"
                              title="Download photo"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </div>

              {/* Right Column: Controls Sidebar */}
              <aside className="space-y-4">
                <PWAInstallButton />

                {/* Connection & Pairing Summary */}
                <section className="p-5 rounded-xl bg-white border border-slate-200 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-900">Connection</h2>
                    {phoneOnline ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{phoneName}</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <WifiOff className="w-3.5 h-3.5" />
                        <span>No device</span>
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="pc-workstation-name"
                      className="block text-xs font-medium text-slate-600"
                    >
                      PC Workstation Label
                    </label>
                    <input
                      id="pc-workstation-name"
                      type="text"
                      maxLength={32}
                      value={pcName}
                      onChange={(e) => handlePcNameChange(e.target.value)}
                      placeholder="PC Workstation"
                      className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:border-blue-500 focus:outline-none"
                    />
                  </div>

                  {/* Network Address Selector (shows LAN IP when accessed via localhost) */}
                  {networkInfo && networkInfo.lanIps.length > 0 && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600">
                        Local Network Address
                      </label>
                      <select
                        value={selectedOrigin}
                        onChange={(e) => setSelectedOrigin(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-800"
                      >
                        {networkInfo.lanIps.map((ip) => {
                          const lanOrigin = `http://${ip}:${networkInfo.port}`;
                          return (
                            <option key={ip} value={lanOrigin}>
                              {lanOrigin} (Wi-Fi LAN)
                            </option>
                          );
                        })}
                        <option value={window.location.origin}>
                          {window.location.origin} (Current)
                        </option>
                      </select>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <div className="text-xs font-medium text-slate-700">
                        Local-Only WebRTC
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Disable for cross-network testing
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={localOnlyIce}
                      onClick={() => setLocalOnlyIce((prev) => !prev)}
                      className={`w-11 h-6 rounded-full transition-colors p-0.5 ${
                        localOnlyIce ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                          localOnlyIce ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenPhoneMode(pairCode)}
                      className="w-full py-2 px-3 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium inline-flex items-center justify-center gap-2 transition-colors"
                    >
                      <Smartphone className="w-3.5 h-3.5" />
                      <span>Switch to Smartphone Mode</span>
                    </button>
                  </div>
                </section>

                {/* Camera & Video Controls */}
                <section className="p-5 rounded-xl bg-white border border-slate-200 space-y-5">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-900">
                      Camera &amp; Video Controls
                    </h2>
                    {phoneOnline && (
                      <button
                        type="button"
                        onClick={() => sendWs({ type: 'rtc:restart', target: 'phone' })}
                        className="text-xs font-medium text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
                        title="Renegotiate stream"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Refresh</span>
                      </button>
                    )}
                  </div>

                  {/* Front / Rear Camera Switch */}
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-600">
                      Smartphone Camera
                    </span>
                    <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-slate-100">
                      <button
                        type="button"
                        onClick={() =>
                          updateRemoteSetting({
                            facingMode: 'environment',
                            deviceId: undefined,
                            mirror: false,
                          })
                        }
                        className={`py-2 rounded-md text-xs font-semibold transition-colors ${
                          settings.facingMode === 'environment'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Rear Camera
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateRemoteSetting({
                            facingMode: 'user',
                            deviceId: undefined,
                            torch: false,
                            mirror: true,
                          })
                        }
                        className={`py-2 rounded-md text-xs font-semibold transition-colors ${
                          settings.facingMode === 'user'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        Front Camera
                      </button>
                    </div>
                  </div>

                  {/* Multi-lens selector when phone exposes multiple cameras */}
                  {capabilities && capabilities.devices.length > 1 && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-slate-600">
                        Specific Lens
                      </label>
                      <select
                        value={settings.deviceId || ''}
                        onChange={(e) =>
                          updateRemoteSetting({ deviceId: e.target.value || undefined })
                        }
                        className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-800"
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
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-600">Resolution</span>
                    <div className="grid grid-cols-3 gap-1.5 p-1 rounded-lg bg-slate-100">
                      {(['480p', '720p', '1080p'] as ResolutionPreset[]).map((res) => (
                        <button
                          key={res}
                          type="button"
                          onClick={() => updateRemoteSetting({ resolution: res })}
                          className={`py-2 rounded-md text-xs font-semibold font-mono transition-colors ${
                            settings.resolution === res
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {res}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Frame Rate */}
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-600">Frame Rate</span>
                    <div className="grid grid-cols-4 gap-1.5 p-1 rounded-lg bg-slate-100">
                      {([15, 24, 30, 60] as FrameRatePreset[]).map((fps) => (
                        <button
                          key={fps}
                          type="button"
                          onClick={() => updateRemoteSetting({ frameRate: fps })}
                          className={`py-2 rounded-md text-xs font-semibold font-mono tabular-nums transition-colors ${
                            settings.frameRate === fps
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {fps}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Zoom (Hardware + Digital) */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-600">Zoom</span>
                      <span className="font-mono tabular-nums text-slate-800">
                        {totalZoom.toFixed(1)}×
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={8}
                      step={0.1}
                      value={totalZoom}
                      onChange={(e) => handleSetTotalZoom(Number(e.target.value))}
                      className="w-full lens-slider"
                    />
                  </div>

                  {/* Focus */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-600">Focus</span>
                      <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg">
                        <button
                          type="button"
                          onClick={() => {
                            updateRemoteSetting({ focusMode: 'continuous' });
                            sendWs({ type: 'camera:trigger-focus' });
                          }}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium ${
                            settings.focusMode === 'continuous'
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600'
                          }`}
                        >
                          Auto
                        </button>
                        <button
                          type="button"
                          disabled={
                            phoneOnline &&
                            capabilities?.focusModes !== undefined &&
                            !capabilities.focusModes.includes('manual')
                          }
                          onClick={() => updateRemoteSetting({ focusMode: 'manual' })}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium disabled:opacity-40 ${
                            settings.focusMode === 'manual'
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600'
                          }`}
                        >
                          Manual
                        </button>
                      </div>
                    </div>
                    {settings.focusMode === 'manual' && (
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={settings.focusDistance}
                        onChange={(e) =>
                          updateRemoteSetting({ focusDistance: Number(e.target.value) })
                        }
                        className="w-full lens-slider"
                        aria-label="Manual focus distance"
                      />
                    )}
                  </div>

                  {/* Exposure EV when supported */}
                  {capabilities?.exposureCompensation && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-600">Exposure (EV)</span>
                        <span className="font-mono tabular-nums text-slate-800">
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
                          updateRemoteSetting({
                            exposureCompensation: Number(e.target.value),
                          })
                        }
                        className="w-full lens-slider"
                      />
                    </div>
                  )}

                  {/* Brightness */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-600">Brightness</span>
                      <span className="font-mono tabular-nums text-slate-800">
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
                        updateRemoteSetting({ brightness: Number(e.target.value) })
                      }
                      className="w-full lens-slider"
                    />
                  </div>

                  {/* Contrast */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-600">Contrast</span>
                      <span className="font-mono tabular-nums text-slate-800">
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
                        updateRemoteSetting({ contrast: Number(e.target.value) })
                      }
                      className="w-full lens-slider"
                    />
                  </div>

                  {/* HUID High-Contrast B&W + Reset */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateRemoteSetting({
                          grayscale: !settings.grayscale,
                          contrast:
                            !settings.grayscale && settings.contrast < 25 ? 30 : settings.contrast,
                        })
                      }
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-colors ${
                        settings.grayscale
                          ? 'bg-slate-900 border-slate-900 text-white'
                          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      High-Contrast B&amp;W
                    </button>
                    <button
                      type="button"
                      onClick={handleResetAdjustments}
                      className="py-2 px-3 rounded-lg text-xs font-medium border border-slate-200 text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1"
                      title="Reset image adjustments"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset</span>
                    </button>
                  </div>

                  {/* Torch toggle when rear camera supports flash */}
                  {capabilities?.torch && settings.facingMode === 'environment' && (
                    <button
                      type="button"
                      onClick={() => updateRemoteSetting({ torch: !settings.torch })}
                      className={`w-full py-2 px-3 rounded-lg text-xs font-semibold border inline-flex items-center justify-center gap-2 transition-colors ${
                        settings.torch
                          ? 'bg-amber-50 border-amber-300 text-amber-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Flashlight className="w-3.5 h-3.5" />
                      <span>{settings.torch ? 'Flashlight On' : 'Turn On Flashlight'}</span>
                    </button>
                  )}
                </section>
              </aside>
            </div>
          )}

          {activeTab === 'virtual-cam' && (
            <VirtualCamPanel
              pairCode={pairCode}
              vcamBridgeCount={vcamBridgeCount}
              vcamWebCount={vcamWebCount}
              bridgeStreamEnabled={bridgeStreamEnabled}
              onToggleBridgeStream={() => setBridgeStreamEnabled((prev) => !prev)}
              isLiveConnected={hasVideoTrack}
              mirrorOutput={settings.mirror}
              onToggleMirror={() => updateRemoteSetting({ mirror: !settings.mirror })}
            />
          )}

          {activeTab === 'guide' && (
            <div className="max-w-4xl space-y-8 py-2">
              <div className="space-y-2">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                  Wireless Webcam Setup Guide
                </h1>
                <p className="text-sm text-slate-600 leading-relaxed">
                  Connect any Android or iOS smartphone to your Windows PC over the same Wi-Fi network in under 30 seconds — no cables or user accounts required.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="p-6 rounded-xl bg-white border border-slate-200 space-y-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-900">
                    <Wifi className="w-5 h-5" />
                  </div>
                  <h2 className="text-base font-semibold text-slate-900">
                    01. Connect Same Wi-Fi
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Ensure your Windows PC and smartphone are connected to the same Wi-Fi network. Video streams peer-to-peer via WebRTC without passing through external cloud servers.
                  </p>
                </div>

                <div className="p-6 rounded-xl bg-white border border-slate-200 space-y-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-900">
                    <Camera className="w-5 h-5" />
                  </div>
                  <h2 className="text-base font-semibold text-slate-900">
                    02. Scan &amp; Allow Camera
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Scan the QR code from the Receiver tab using your phone camera (iOS Safari or Android Chrome), grant camera permission, and tap Start Streaming.
                  </p>
                </div>

                <div className="p-6 rounded-xl bg-white border border-slate-200 space-y-3">
                  <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-900">
                    <Video className="w-5 h-5" />
                  </div>
                  <h2 className="text-base font-semibold text-slate-900">
                    03. Select Virtual Webcam
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    Open the Virtual Webcam tab to run the Windows DirectShow bridge or connect OBS Virtual Camera, then choose it inside Zoom, Microsoft Teams, or Google Meet.
                  </p>
                </div>
              </div>

              <div className="p-6 rounded-xl bg-white border border-slate-200 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  Mobile Browser Camera Notes (iOS Safari &amp; Android Chrome)
                </h3>
                <ul className="space-y-2 text-sm text-slate-600 list-disc list-inside">
                  <li>
                    Modern mobile browsers require either a local network origin or HTTPS to grant camera access.
                  </li>
                  <li>
                    Zoom, manual focus, and hardware exposure controls automatically enable when exposed by your phone&apos;s browser and active camera lens.
                  </li>
                  <li>
                    If Wi-Fi momentarily disconnects, both the PC Receiver and Smartphone page automatically reconnect to the same pairing code.
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
