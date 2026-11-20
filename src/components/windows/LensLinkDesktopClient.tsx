import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BatteryCharging,
  Camera,
  FlipHorizontal2,
  Focus,
  HardDrive,
  Mic,
  MicOff,
  Power,
  QrCode,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Smartphone,
  Sun,
  Volume2,
  VolumeX,
  Wifi,
  Zap,
} from 'lucide-react';
import {
  LensLinkConnectionStatus,
  LensLinkDataChannelMessage,
  CameraCapabilities,
  CameraSettings,
  DEFAULT_CAMERA_SETTINGS,
  FocusTapPoint,
  FrameRatePreset,
  NetworkInfo,
  OrientationMode,
  PhoneTelemetry,
  ResolutionPreset,
  StreamStats,
} from '../../types/lenslink';
import {
  applyLowLatencyReceiver,
  buildVideoFilterCss,
  collectInboundStats,
  getRtcConfiguration,
  getWsUrl,
  isLocalLanHostname,
  preferHardwareVideoCodec,
  StatsSnapshot,
} from '../../lib/webrtc';
import {
  createOrResetPcRoom,
  decodeIceCandidate,
  encodeIceCandidate,
  subscribeToObsViewer,
  subscribeToRoom,
  updateObsViewerFromPc,
  updatePcRoomFields,
} from '../../lib/firestoreSignaling';
import { PWAInstallButton } from '../common/PWAInstallButton';
import { LensLinkDriverPanel } from './LensLinkDriverPanel';
import { LensLinkDownloadsPanel } from './LensLinkDownloadsPanel';

type DesktopTab = 'camera' | 'driver' | 'setup';

interface LensLinkDesktopClientProps {
  onSwitchToMobile: () => void;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function createSessionCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function getOrCreateSessionCode(): string {
  try {
    const existing = window.sessionStorage.getItem('lenslink_pc_room_code');
    if (existing && /^[A-Z0-9]{6}$/.test(existing)) return existing;
    const fresh = createSessionCode();
    window.sessionStorage.setItem('lenslink_pc_room_code', fresh);
    return fresh;
  } catch {
    return createSessionCode();
  }
}

function getOrCreateSessionToken(): string {
  try {
    const existing = window.sessionStorage.getItem('lenslink_pc_session_token');
    if (existing && existing.length >= 12) return existing;
    const fresh = `ll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem('lenslink_pc_session_token', fresh);
    return fresh;
  } catch {
    return `ll_${Date.now().toString(36)}`;
  }
}

function getStoredPcName(): string {
  try {
    const saved = window.localStorage.getItem('lenslink_pc_name');
    if (saved && saved.trim().length > 0) return saved.trim().slice(0, 36);
  } catch {
    // Ignore storage error
  }
  return 'Windows PC';
}

const STATUS_META: Record<
  LensLinkConnectionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  searching: {
    label: 'Searching',
    dotClass: 'bg-[#2563EB] animate-pulse',
    textClass: 'text-[#1D4ED8]',
  },
  'device-found': {
    label: 'Device Found',
    dotClass: 'bg-[#2563EB]',
    textClass: 'text-[#1D4ED8]',
  },
  connecting: {
    label: 'Connecting',
    dotClass: 'bg-amber-500 animate-pulse',
    textClass: 'text-amber-700',
  },
  connected: {
    label: 'Connected',
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-700',
  },
  disconnected: {
    label: 'Disconnected',
    dotClass: 'bg-slate-400',
    textClass: 'text-slate-500',
  },
};

export const LensLinkDesktopClient: React.FC<LensLinkDesktopClientProps> = ({ onSwitchToMobile }) => {
  const [activeTab, setActiveTab] = useState<DesktopTab>('camera');
  const [roomCode, setRoomCode] = useState<string>(() => getOrCreateSessionCode());
  const sessionTokenRef = useRef<string>(getOrCreateSessionToken());

  const [pcName, setPcName] = useState<string>(() => getStoredPcName());
  const [editingPcName, setEditingPcName] = useState(false);
  const [pcNameDraft, setPcNameDraft] = useState(pcName);

  const [connectionStatus, setConnectionStatus] = useState<LensLinkConnectionStatus>('searching');
  const [wsReachable, setWsReachable] = useState<boolean>(true);
  const [firewallWarning, setFirewallWarning] = useState<string | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);

  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [phoneOnline, setPhoneOnline] = useState(false);
  const [hasLiveVideo, setHasLiveVideo] = useState(false);
  const [vcamBridgeCount, setVcamBridgeCount] = useState(0);
  const [vcamWebCount, setVcamWebCount] = useState(0);
  const [vcamWebFrameCount, setVcamWebFrameCount] = useState(0);

  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({ devices: [] });
  const [telemetry, setTelemetry] = useState<PhoneTelemetry>({
    deviceName: '',
    model: '',
    lensLabel: 'Rear Main',
    batteryPct: null,
    charging: null,
    thermalState: null,
    audioActive: false,
  });

  const [stats, setStats] = useState<StreamStats>({
    width: 0,
    height: 0,
    fps: 0,
    bitrateKbps: 0,
    rttMs: null,
    packetLossPct: 0,
    signalQuality: 'Excellent',
  });

  const [focusTap, setFocusTap] = useState<FocusTapPoint | null>(null);
  const [audioMuted, setAudioMuted] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioOutputId, setSelectedAudioOutputId] = useState<string>('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const statsSnapshotRef = useRef<StatsSnapshot | null>(null);
  const manuallyDisconnectedRef = useRef<boolean>(false);

  // Firestore signaling tracking refs
  const lastProcessedOfferIdRef = useRef<string>('');
  const processedPhoneIceRef = useRef<Set<string>>(new Set());
  const pcIceBufferRef = useRef<string[]>([]);
  const pcIceFlushTimerRef = useRef<number | null>(null);
  const firestoreNonceRef = useRef({ restart: 0, focus: 0 });
  const settingsRef = useRef<CameraSettings>(settings);
  settingsRef.current = settings;

  // Loopback OBS / Chrome Extension viewer PeerConnections
  const vcamWebPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const lastObsReqNonceRef = useRef<number>(0);
  const lastObsAnswerOfferIdRef = useRef<string>('');
  const obsProcessedViewerIceRef = useRef<Set<string>>(new Set());
  const obsPcIceBufRef = useRef<string[]>([]);
  const obsPcIceTimerRef = useRef<number | null>(null);

  const preferredOrigin = useMemo(() => {
    if (networkInfo?.preferredOrigin) return networkInfo.preferredOrigin;
    return window.location.origin;
  }, [networkInfo]);

  const mobileJoinUrl = useMemo(
    () => `${preferredOrigin}/phone?code=${encodeURIComponent(roomCode)}`,
    [preferredOrigin, roomCode]
  );

  // Fetch LAN info + available audio outputs (for Virtual Mic routing)
  useEffect(() => {
    fetch('/api/network-info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setNetworkInfo(data as NetworkInfo);
      })
      .catch(() => {});

    const loadAudioOutputs = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devs = await navigator.mediaDevices.enumerateDevices();
        setAudioOutputs(devs.filter((d) => d.kind === 'audiooutput'));
      } catch {
        // Ignore audio output enumeration restrictions
      }
    };
    void loadAudioOutputs();
  }, []);

  // Apply selected audio output sink (e.g. VB-Cable Input -> Virtual Microphone!)
  const handleSelectAudioOutput = async (sinkId: string) => {
    setSelectedAudioOutputId(sinkId);
    const vid = videoRef.current as (HTMLVideoElement & {
      setSinkId?: (id: string) => Promise<void>;
    }) | null;
    if (vid && typeof vid.setSinkId === 'function' && sinkId) {
      try {
        await vid.setSinkId(sinkId);
      } catch {
        // Browser may restrict setSinkId without audio permission
      }
    }
  };

  // Cleanup WebRTC peer connection
  const closePeerConnection = useCallback(() => {
    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch {
        // Ignore
      }
      dataChannelRef.current = null;
    }
    if (rtcPcRef.current) {
      try {
        rtcPcRef.current.ontrack = null;
        rtcPcRef.current.onicecandidate = null;
        rtcPcRef.current.onconnectionstatechange = null;
        rtcPcRef.current.close();
      } catch {
        // Ignore
      }
      rtcPcRef.current = null;
    }
    pendingIceRef.current = [];
    statsSnapshotRef.current = null;
    remoteStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setHasLiveVideo(false);
    setAudioLevel(0);
  }, []);

  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const sendDataChannel = useCallback((msg: LensLinkDataChannelMessage): boolean => {
    const dc = dataChannelRef.current;
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const flushPcIceToFirestore = useCallback(
    (code: string) => {
      if (pcIceFlushTimerRef.current) return;
      pcIceFlushTimerRef.current = window.setTimeout(() => {
        pcIceFlushTimerRef.current = null;
        if (pcIceBufferRef.current.length === 0) return;
        const batch = [...pcIceBufferRef.current];
        void updatePcRoomFields(code, { pcIceCandidates: batch });
      }, 50);
    },
    []
  );

  // Create or get RTCPeerConnection to answer an incoming smartphone offer
  const handleIncomingOffer = useCallback(
    async (
      sdp: string,
      source: 'ws' | 'firestore',
      offerId?: string,
      activeCode?: string
    ) => {
      if (manuallyDisconnectedRef.current) return;
      const targetCode = activeCode || roomCode;
      setConnectionStatus('connecting');
      closePeerConnection();

      const localOnly = isLocalLanHostname();
      const pc = new RTCPeerConnection(getRtcConfiguration(localOnly));
      rtcPcRef.current = pc;
      pcIceBufferRef.current = [];
      processedPhoneIceRef.current.clear();

      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        dataChannelRef.current = ch;
        ch.onmessage = (msgEv) => {
          try {
            const parsed = JSON.parse(String(msgEv.data)) as LensLinkDataChannelMessage;
            if (parsed.type === 'telemetry') {
              setTelemetry(parsed.telemetry);
            } else if (parsed.type === 'capabilities') {
              setCapabilities(parsed.capabilities);
            } else if (parsed.type === 'settings') {
              setSettings((prev) => ({ ...prev, ...parsed.settings }));
            } else if (parsed.type === 'ping') {
              ch.send(JSON.stringify({ type: 'pong', ts: parsed.ts }));
            }
          } catch {
            // Ignore malformed message
          }
        };
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0] || new MediaStream([event.track]);
        remoteStreamRef.current = stream;
        applyLowLatencyReceiver(pc);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        if (event.track.kind === 'video') {
          setHasLiveVideo(true);
          setConnectionStatus('connected');
          setFirewallWarning(null);
        }
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        const init = event.candidate.toJSON();
        if (source === 'ws') {
          sendWs({ type: 'rtc:ice-candidate', candidate: init, target: 'phone' });
        }
        const encoded = encodeIceCandidate(init);
        if (encoded && pcIceBufferRef.current.length < 24) {
          pcIceBufferRef.current.push(encoded);
          flushPcIceToFirestore(targetCode);
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
          setConnectionStatus('connected');
          setFirewallWarning(null);
        } else if (st === 'connecting') {
          setConnectionStatus('connecting');
        } else if (st === 'failed') {
          setConnectionStatus('disconnected');
          setHasLiveVideo(false);
          setFirewallWarning(
            'Video stream blocked on local Wi-Fi. Check that both devices share the same Wi-Fi network and Windows Firewall allows Private network traffic.'
          );
        } else if (st === 'disconnected') {
          setConnectionStatus(phoneOnline ? 'connecting' : 'searching');
        }
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        preferHardwareVideoCodec(pc);

        for (const cand of pendingIceRef.current) {
          await pc.addIceCandidate(cand).catch(() => {});
        }
        pendingIceRef.current = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (source === 'ws') {
          sendWs({
            type: 'rtc:answer',
            sdp: answer.sdp,
            target: 'phone',
          });
        }
        if (offerId) {
          await updatePcRoomFields(targetCode, {
            answerForOfferId: offerId,
            answerSdp: answer.sdp || '',
            pcIceCandidates: pcIceBufferRef.current,
          });
        }
      } catch {
        setConnectionStatus('disconnected');
      }
    },
    [closePeerConnection, flushPcIceToFirestore, phoneOnline, roomCode, sendWs]
  );

  // OBS / Virtual Camera Loopback PeerConnection Creator
  const createObsLoopbackOffer = useCallback(
    async (targetPeerId?: string, isFirestoreObs?: boolean) => {
      const stream = remoteStreamRef.current;
      if (!stream) return;

      const key = isFirestoreObs ? 'obs-primary' : targetPeerId || 'obs-ws';
      const existing = vcamWebPeersRef.current.get(key);
      if (existing) {
        try {
          existing.close();
        } catch {
          // Ignore
        }
      }

      const pc = new RTCPeerConnection(getRtcConfiguration(true));
      vcamWebPeersRef.current.set(key, pc);
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      if (isFirestoreObs) {
        obsPcIceBufRef.current = [];
        obsProcessedViewerIceRef.current.clear();
      }

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const init = ev.candidate.toJSON();
        if (isFirestoreObs) {
          const enc = encodeIceCandidate(init);
          if (enc && obsPcIceBufRef.current.length < 24) {
            obsPcIceBufRef.current.push(enc);
            if (!obsPcIceTimerRef.current) {
              obsPcIceTimerRef.current = window.setTimeout(() => {
                obsPcIceTimerRef.current = null;
                void updateObsViewerFromPc(roomCode, {
                  pcIceCandidates: [...obsPcIceBufRef.current],
                });
              }, 50);
            }
          }
        } else if (targetPeerId) {
          sendWs({
            type: 'rtc:ice-candidate',
            candidate: init,
            target: 'vcam-web',
            peerId: targetPeerId,
          });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (isFirestoreObs) {
        const offerId = `obs-${Date.now()}`;
        await updateObsViewerFromPc(roomCode, {
          offerId,
          offerSdp: offer.sdp || '',
          pcIceCandidates: [...obsPcIceBufRef.current],
        });
      } else if (targetPeerId) {
        sendWs({
          type: 'rtc:offer',
          sdp: offer.sdp,
          target: 'vcam-web',
          peerId: targetPeerId,
        });
      }
    },
    [roomCode, sendWs]
  );

  // Primary WebSocket Connection + Local Wi-Fi PC Announcement
  useEffect(() => {
    let active = true;
    let reconnectTimer: number | null = null;

    const connectWs = () => {
      if (!active) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        setWsReachable(true);
        ws.send(
          JSON.stringify({
            type: 'room:create',
            code: roomCode,
            pcName,
            platform: 'Windows Desktop',
            sessionToken: sessionTokenRef.current,
          })
        );
      };

      ws.onmessage = (event) => {
        if (!active || typeof event.data !== 'string') return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        const type = msg.type;
        if (type === 'room:created' && typeof msg.code === 'string' && msg.code !== roomCode) {
          setRoomCode(msg.code);
          try {
            window.sessionStorage.setItem('lenslink_pc_room_code', msg.code);
          } catch {
            // Ignore
          }
        } else if (type === 'room:status') {
          const isPhoneOn = Boolean(msg.phoneOnline);
          setPhoneOnline(isPhoneOn);
          setVcamBridgeCount(Number(msg.vcamBridgeCount || 0));
          setVcamWebCount(Number(msg.vcamWebCount || 0));
          setVcamWebFrameCount(Number(msg.vcamWebFrameCount || 0));
          if (typeof msg.phoneName === 'string' && msg.phoneName) {
            setTelemetry((prev) => ({
              ...prev,
              deviceName: prev.deviceName || (msg.phoneName as string),
              model: prev.model || (msg.phoneName as string),
            }));
          }
          if (msg.capabilities && typeof msg.capabilities === 'object') {
            setCapabilities(msg.capabilities as CameraCapabilities);
          }
          if (msg.telemetry && typeof msg.telemetry === 'object') {
            setTelemetry(msg.telemetry as PhoneTelemetry);
          }
          if (!manuallyDisconnectedRef.current) {
            setConnectionStatus((prev) => {
              if (prev === 'connected' && isPhoneOn) return 'connected';
              if (isPhoneOn) return 'device-found';
              return 'searching';
            });
          }
          if (!isPhoneOn) {
            closePeerConnection();
          }
        } else if (type === 'camera:capabilities' && msg.capabilities) {
          setCapabilities(msg.capabilities as CameraCapabilities);
          if (typeof msg.phoneName === 'string' && msg.phoneName) {
            setTelemetry((prev) => ({ ...prev, deviceName: msg.phoneName as string }));
          }
        } else if (type === 'camera:telemetry' && msg.telemetry) {
          setTelemetry(msg.telemetry as PhoneTelemetry);
        } else if (type === 'camera:settings' && msg.settings && msg.from === 'phone') {
          setSettings((prev) => ({ ...prev, ...(msg.settings as Partial<CameraSettings>) }));
        } else if (type === 'rtc:offer' && typeof msg.sdp === 'string') {
          void handleIncomingOffer(msg.sdp, 'ws');
        } else if (type === 'rtc:ice-candidate' && msg.candidate) {
          if (msg.from === 'vcam-web' && typeof msg.peerId === 'string') {
            const vPeer = vcamWebPeersRef.current.get(msg.peerId);
            if (vPeer) {
              void vPeer.addIceCandidate(msg.candidate as RTCIceCandidateInit).catch(() => {});
            }
          } else {
            const cand = msg.candidate as RTCIceCandidateInit;
            if (rtcPcRef.current?.remoteDescription) {
              void rtcPcRef.current.addIceCandidate(cand).catch(() => {});
            } else {
              pendingIceRef.current.push(cand);
            }
          }
        } else if (type === 'rtc:answer' && msg.from === 'vcam-web' && typeof msg.peerId === 'string') {
          const vPeer = vcamWebPeersRef.current.get(msg.peerId);
          if (vPeer && typeof msg.sdp === 'string') {
            void vPeer.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
          }
        } else if (type === 'vcam:request-offer' && typeof msg.peerId === 'string') {
          void createObsLoopbackOffer(msg.peerId, false);
        }
      };

      ws.onerror = () => {
        setWsReachable(false);
      };

      ws.onclose = () => {
        if (!active) return;
        reconnectTimer = window.setTimeout(connectWs, 2500);
      };
    };

    connectWs();

    return () => {
      active = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        // Ignore
      }
    };
  }, [closePeerConnection, createObsLoopbackOffer, handleIncomingOffer, pcName, roomCode]);

  // Firestore Cloud Signaling Backup (guarantees QR pairing works even without local WS)
  useEffect(() => {
    let active = true;
    void createOrResetPcRoom({
      code: roomCode,
      sessionToken: sessionTokenRef.current,
      pcName,
    });

    const unsubRoom = subscribeToRoom(roomCode, (room) => {
      if (!active || !room) return;
      if (room.phoneName) {
        setTelemetry((prev) => ({
          ...prev,
          deviceName: prev.deviceName || room.phoneName,
          model: prev.model || room.phoneName,
        }));
      }
      if (room.capabilities && typeof room.capabilities === 'object' && 'devices' in room.capabilities) {
        setCapabilities(room.capabilities as CameraCapabilities);
      }
      if (room.phoneOnline) {
        setPhoneOnline(true);
        if (!manuallyDisconnectedRef.current) {
          setConnectionStatus((prev) => (prev === 'connected' ? 'connected' : 'device-found'));
        }
      }
      if (
        room.offerId &&
        room.offerSdp &&
        room.offerId !== lastProcessedOfferIdRef.current &&
        !manuallyDisconnectedRef.current
      ) {
        // Only answer Firestore offer if WebRTC isn't already connected via WS
        const pcState = rtcPcRef.current?.connectionState;
        if (pcState !== 'connected') {
          lastProcessedOfferIdRef.current = room.offerId;
          void handleIncomingOffer(room.offerSdp, 'firestore', room.offerId, roomCode);
        }
      }
      if (Array.isArray(room.phoneIceCandidates) && rtcPcRef.current) {
        for (const enc of room.phoneIceCandidates) {
          if (processedPhoneIceRef.current.has(enc)) continue;
          processedPhoneIceRef.current.add(enc);
          const cand = decodeIceCandidate(enc);
          if (!cand) continue;
          if (rtcPcRef.current.remoteDescription) {
            void rtcPcRef.current.addIceCandidate(cand).catch(() => {});
          } else {
            pendingIceRef.current.push(cand);
          }
        }
      }
    });

    const unsubObs = subscribeToObsViewer(roomCode, (viewer) => {
      if (!active || !viewer) return;
      if (viewer.requestNonce > lastObsReqNonceRef.current && remoteStreamRef.current) {
        lastObsReqNonceRef.current = viewer.requestNonce;
        void createObsLoopbackOffer(undefined, true);
      }
      const obsPc = vcamWebPeersRef.current.get('obs-primary');
      if (
        obsPc &&
        viewer.answerSdp &&
        viewer.answerForOfferId &&
        viewer.answerForOfferId !== lastObsAnswerOfferIdRef.current
      ) {
        lastObsAnswerOfferIdRef.current = viewer.answerForOfferId;
        void obsPc.setRemoteDescription({ type: 'answer', sdp: viewer.answerSdp }).catch(() => {});
      }
      if (obsPc && Array.isArray(viewer.viewerIceCandidates)) {
        for (const enc of viewer.viewerIceCandidates) {
          if (obsProcessedViewerIceRef.current.has(enc)) continue;
          obsProcessedViewerIceRef.current.add(enc);
          const cand = decodeIceCandidate(enc);
          if (cand) void obsPc.addIceCandidate(cand).catch(() => {});
        }
      }
    });

    return () => {
      active = false;
      unsubRoom();
      unsubObs();
      void updatePcRoomFields(roomCode, { pcOnline: false });
    };
  }, [createObsLoopbackOffer, handleIncomingOffer, pcName, roomCode]);

  // Live Inbound WebRTC Stats Poller (1 Hz)
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const pc = rtcPcRef.current;
      if (!pc || pc.connectionState !== 'connected') return;
      try {
        const res = await collectInboundStats(pc, statsSnapshotRef.current);
        statsSnapshotRef.current = res.nextSnapshot;
        setStats(res.stats);
      } catch {
        // Ignore transient stats error
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Real-time Microphone Audio Level Meter when smartphone mic is active
  useEffect(() => {
    const stream = remoteStreamRef.current;
    if (!hasLiveVideo || !stream || stream.getAudioTracks().length === 0) {
      setAudioLevel(0);
      return;
    }

    let rafId = 0;
    let audioCtx: AudioContext | null = null;
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const sample = () => {
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        setAudioLevel(Math.min(100, Math.round(avg * 180)));
        rafId = window.requestAnimationFrame(sample);
      };
      rafId = window.requestAnimationFrame(sample);
    } catch {
      // Ignore AudioContext autoplay restriction
    }

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      if (audioCtx) void audioCtx.close().catch(() => {});
    };
  }, [hasLiveVideo, settings.audioEnabled]);

  // Frame Publisher for Chrome/Edge Virtual Webcam Extension & DirectShow Bridge
  useEffect(() => {
    const needsFrames = vcamBridgeCount > 0 || vcamWebFrameCount > 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let timer = 0;

    const pushFrame = () => {
      const video = videoRef.current;
      if (!video || !ctx || video.readyState < 2 || video.videoWidth === 0) return;
      const targetW = Math.min(1280, video.videoWidth);
      const targetH = Math.round((targetW / video.videoWidth) * video.videoHeight);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.save();
      if (settingsRef.current.mirror) {
        ctx.translate(targetW, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, targetW, targetH);
      ctx.restore();

      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      // Publish to LensLink Browser Virtual Webcam Extension (content-isolated.js listener)
      window.postMessage(
        {
          source: 'lenslink-pc-receiver',
          type: 'frame',
          pairCode: roomCode,
          dataUrl,
          width: targetW,
          height: targetH,
        },
        '*'
      );

      // Push binary JPEG frame to any connected Windows Bridge clients
      if (needsFrames && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        canvas.toBlob(
          (blob) => {
            if (blob && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              blob.arrayBuffer().then((buf) => {
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(buf);
                }
              });
            }
          },
          'image/jpeg',
          0.8
        );
      }
    };

    if (hasLiveVideo) {
      timer = window.setInterval(pushFrame, needsFrames ? 33 : 66);
    }
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [hasLiveVideo, roomCode, vcamBridgeCount, vcamWebFrameCount]);

  // Remote Camera Control Dispatcher (DataChannel -> WS -> Firestore)
  const updateCameraSetting = useCallback(
    (patch: Partial<CameraSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        sendDataChannel({ type: 'settings', settings: patch });
        sendWs({ type: 'camera:settings', settings: patch });
        void updatePcRoomFields(roomCode, { settings: next });
        return next;
      });
    },
    [roomCode, sendDataChannel, sendWs]
  );

  const handlePreviewClickToFocus = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!hasLiveVideo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFocusTap({ x, y, ts: Date.now() });

    sendDataChannel({ type: 'tap-focus', x, y });
    sendWs({ type: 'camera:trigger-focus', focusPoint: { x, y } });
    firestoreNonceRef.current.focus += 1;
    void updatePcRoomFields(roomCode, {
      focusNonce: firestoreNonceRef.current.focus,
      focusX: x,
      focusY: y,
    });
  };

  const handleDisconnect = () => {
    manuallyDisconnectedRef.current = true;
    closePeerConnection();
    setConnectionStatus('disconnected');
  };

  const handleReconnect = () => {
    manuallyDisconnectedRef.current = false;
    setFirewallWarning(null);
    setConnectionStatus(phoneOnline ? 'connecting' : 'searching');
    sendWs({ type: 'rtc:restart', target: 'phone' });
    firestoreNonceRef.current.restart += 1;
    void updatePcRoomFields(roomCode, {
      restartNonce: firestoreNonceRef.current.restart,
      pcOnline: true,
    });
  };

  const savePcName = () => {
    const cleaned = pcNameDraft.trim().slice(0, 36) || 'Windows PC';
    setPcName(cleaned);
    setPcNameDraft(cleaned);
    setEditingPcName(false);
    try {
      window.localStorage.setItem('lenslink_pc_name', cleaned);
    } catch {
      // Ignore
    }
    sendWs({
      type: 'room:create',
      code: roomCode,
      pcName: cleaned,
      platform: 'Windows Desktop',
      sessionToken: sessionTokenRef.current,
    });
    void updatePcRoomFields(roomCode, { pcName: cleaned });
  };

  const activeLensLabel = useMemo(() => {
    if (settings.deviceId) {
      const found = capabilities.devices.find((d) => d.deviceId === settings.deviceId);
      if (found) return found.shortLabel;
    }
    if (telemetry.lensLabel) return telemetry.lensLabel;
    return settings.facingMode === 'user' ? 'Front' : 'Rear Main';
  }, [capabilities.devices, settings.deviceId, settings.facingMode, telemetry.lensLabel]);

  const rearLenses = useMemo(
    () => capabilities.devices.filter((d) => d.facing === 'back'),
    [capabilities.devices]
  );

  const videoFilterCss = buildVideoFilterCss(
    settings,
    Boolean(capabilities.brightness),
    Boolean(capabilities.contrast)
  );

  const bitrateDisplay =
    stats.bitrateKbps >= 1000
      ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps`
      : `${stats.bitrateKbps} kbps`;

  const statusInfo = STATUS_META[connectionStatus];

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A]">
      {/* Clean 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-15 max-w-[1440px] items-center justify-between px-4 sm:px-6">
          {/* Zone 1: Brand Mark */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1D4ED8] text-white shadow-xs">
              <Camera className="h-4 w-4" />
            </div>
            <div className="leading-tight">
              <span className="text-sm font-bold tracking-tight text-slate-900">LensLink</span>
              <span className="ml-1.5 hidden text-xs font-medium text-slate-500 sm:inline">
                Wireless Webcam
              </span>
            </div>
          </div>

          {/* Zone 2: Minimal Navigation */}
          <nav className="flex items-center gap-1 rounded-xl bg-slate-100/90 p-1">
            {(
              [
                { id: 'camera', label: 'Live Camera' },
                { id: 'driver', label: 'Virtual Driver' },
                { id: 'setup', label: 'Mobile & Setup' },
              ] as Array<{ id: DesktopTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                  activeTab === tab.id
                    ? 'bg-white text-[#1D4ED8] shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: Primary Action */}
          <div className="flex items-center gap-2.5">
            <PWAInstallButton />
            {connectionStatus === 'connected' ? (
              <button
                type="button"
                onClick={handleDisconnect}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                <Power className="h-3.5 w-3.5" />
                Disconnect
              </button>
            ) : (
              <button
                type="button"
                onClick={handleReconnect}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#1D4ED8] px-3.5 py-1.5 text-xs font-medium text-white shadow-xs transition hover:bg-[#1E40AF]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        {activeTab === 'driver' && (
          <LensLinkDriverPanel
            roomCode={roomCode}
            pcName={pcName}
            vcamBridgeCount={vcamBridgeCount}
            vcamWebCount={vcamWebCount}
            isConnected={connectionStatus === 'connected'}
          />
        )}

        {activeTab === 'setup' && (
          <LensLinkDownloadsPanel
            mobileJoinUrl={mobileJoinUrl}
            onOpenMobileMode={onSwitchToMobile}
          />
        )}

        {activeTab === 'camera' && (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            {/* Left Primary Stage: Live Video Viewport + Unboxed Telemetry Strip */}
            <div className="space-y-4">
              {/* Dominant 16:9 Live Preview Frame */}
              <div
                onClick={handlePreviewClickToFocus}
                className={`relative aspect-video w-full overflow-hidden rounded-2xl border border-slate-200 bg-[#0B1120] shadow-[0_2px_12px_rgba(15,23,42,0.06)] ${
                  hasLiveVideo ? 'cursor-crosshair' : ''
                }`}
              >
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted={audioMuted}
                  style={{
                    transform: `${settings.mirror ? 'scaleX(-1) ' : ''}${
                      settings.digitalZoom > 1 ? `scale(${settings.digitalZoom.toFixed(2)})` : ''
                    }`.trim() || undefined,
                    filter: videoFilterCss,
                  }}
                  className={`h-full w-full object-contain transition-opacity duration-300 ${
                    hasLiveVideo ? 'opacity-100' : 'opacity-0'
                  }`}
                />

                {/* Tap-to-Focus Reticle */}
                {focusTap && hasLiveVideo && (
                  <div
                    key={focusTap.ts}
                    style={{ left: `${focusTap.x * 100}%`, top: `${focusTap.y * 100}%` }}
                    className="lenslink-focus-reticle pointer-events-none absolute h-14 w-14 rounded-xl border-2 border-[#3B82F6] shadow-[0_0_0_2px_rgba(15,23,42,0.35)]"
                  />
                )}

                {/* Waiting / Auto-Discovery Stage */}
                {!hasLiveVideo && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-white to-[#F1F5F9] px-6 text-center">
                    <div className="relative mb-5 flex h-16 w-16 items-center justify-center">
                      {connectionStatus === 'searching' && (
                        <span className="lenslink-radar-ring absolute inset-0 rounded-full border-2 border-[#2563EB]/40" />
                      )}
                      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-[#EFF6FF] text-[#1D4ED8] ring-1 ring-[#BFDBFE]">
                        <Wifi className="h-6 w-6" />
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
                      <span className={`h-2 w-2 rounded-full ${statusInfo.dotClass}`} />
                      <span className={statusInfo.textClass}>{statusInfo.label}</span>
                    </div>

                    <h1 className="mt-2 text-lg font-semibold tracking-tight text-slate-900">
                      {connectionStatus === 'disconnected'
                        ? 'Camera Disconnected'
                        : connectionStatus === 'connecting'
                          ? 'Establishing Encrypted Wi-Fi Video Stream...'
                          : connectionStatus === 'device-found'
                            ? `${telemetry.deviceName || 'Smartphone'} Detected on Wi-Fi`
                            : `Waiting for Smartphone on Wi-Fi`}
                    </h1>

                    <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
                      Open <strong>LensLink Mobile</strong> on your Android or iPhone connected to the same
                      Wi-Fi network. This PC (<strong className="text-slate-700">{pcName}</strong>) will
                      appear automatically for 1-tap connection.
                    </p>

                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => setShowQrModal((prev) => !prev)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
                      >
                        <QrCode className="h-3.5 w-3.5" />
                        {showQrModal ? 'Hide QR Pairing' : 'Pair via QR Code'}
                      </button>
                      <button
                        type="button"
                        onClick={onSwitchToMobile}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-2xs transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
                      >
                        <Smartphone className="h-3.5 w-3.5" />
                        Open Mobile App Here
                      </button>
                      {connectionStatus === 'disconnected' && (
                        <button
                          type="button"
                          onClick={handleReconnect}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[#1D4ED8] px-4 py-2 text-xs font-medium text-white shadow-xs transition hover:bg-[#1E40AF]"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Reconnect Now
                        </button>
                      )}
                    </div>

                    {showQrModal && (
                      <div className="mt-5 flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-3.5 text-left shadow-sm">
                        <img
                          src={`/api/qr?text=${encodeURIComponent(mobileJoinUrl)}`}
                          alt="LensLink QR Pairing Code"
                          className="h-28 w-28 rounded-lg border border-slate-100 bg-white p-1"
                        />
                        <div className="space-y-1">
                          <p className="text-xs font-semibold text-slate-900">Alternative QR Pairing</p>
                          <p className="text-[11px] text-slate-500">
                            Scan with your phone camera to connect directly to <strong>{pcName}</strong>.
                          </p>
                          <p className="pt-1 font-mono text-sm font-semibold tracking-widest text-[#1D4ED8] tabular-nums">
                            {roomCode}
                          </p>
                        </div>
                      </div>
                    )}

                    {(firewallWarning || !wsReachable) && (
                      <div className="mt-5 max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-left text-xs text-amber-800">
                        {firewallWarning ||
                          'Local network discovery socket paused. Ensure Windows Firewall allows Private Wi-Fi access (port 3000) or pair via QR code.'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Unboxed Precision Telemetry Bar (Zero Pills!) */}
              <div className="rounded-2xl border border-slate-200 bg-white px-5 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 text-xs">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 font-semibold">
                      <span className={`h-2 w-2 rounded-full ${statusInfo.dotClass}`} />
                      <span className={statusInfo.textClass}>{statusInfo.label}</span>
                    </div>

                    <span className="h-3.5 w-px bg-slate-200" />

                    <div>
                      <span className="text-slate-400">Device </span>
                      <span className="font-semibold text-slate-900">
                        {hasLiveVideo
                          ? telemetry.model || telemetry.deviceName || 'Smartphone'
                          : 'None'}
                      </span>
                    </div>

                    <span className="hidden h-3.5 w-px bg-slate-200 sm:inline-block" />

                    <div className="hidden sm:block">
                      <span className="text-slate-400">Lens </span>
                      <span className="font-medium text-slate-800">{activeLensLabel}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-slate-700 tabular-nums">
                    <span>
                      {stats.width > 0 ? `${stats.width}×${stats.height}` : settings.resolution.toUpperCase()}
                      {' · '}
                      {stats.fps > 0 ? `${stats.fps} fps` : `${settings.frameRate} fps`}
                    </span>
                    <span>{hasLiveVideo ? bitrateDisplay : '0 kbps'}</span>
                    <span>{stats.rttMs !== null ? `${stats.rttMs} ms` : '— ms'}</span>
                    <span
                      className={
                        !hasLiveVideo
                          ? 'text-slate-400'
                          : stats.signalQuality === 'Excellent' || stats.signalQuality === 'Good'
                            ? 'font-semibold text-emerald-700'
                            : 'font-semibold text-amber-700'
                      }
                    >
                      {hasLiveVideo ? stats.signalQuality : 'Standby'}
                    </span>
                    {telemetry.batteryPct !== null && (
                      <span className="inline-flex items-center gap-1 text-slate-700">
                        <BatteryCharging className="h-3.5 w-3.5 text-[#1D4ED8]" />
                        {telemetry.batteryPct}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Workstation Name + Virtual Webcam Status Line */}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
                  <div className="flex items-center gap-2">
                    <span>PC Name:</span>
                    {editingPcName ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          savePcName();
                        }}
                        className="inline-flex items-center gap-1.5"
                      >
                        <input
                          type="text"
                          value={pcNameDraft}
                          onChange={(e) => setPcNameDraft(e.target.value)}
                          maxLength={36}
                          autoFocus
                          className="rounded-md border border-[#1D4ED8] bg-white px-2 py-0.5 text-xs font-medium text-slate-900 focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="font-medium text-[#1D4ED8] hover:underline"
                        >
                          Save
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setPcNameDraft(pcName);
                          setEditingPcName(true);
                        }}
                        className="font-semibold text-slate-800 hover:text-[#1D4ED8]"
                        title="Click to rename how this PC appears on your phone"
                      >
                        {pcName}
                      </button>
                    )}
                    <span className="text-slate-300">·</span>
                    <span className="font-mono text-[11px] text-slate-500">
                      Virtual Device: LensLink Wireless Webcam
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveTab('driver')}
                    className="inline-flex items-center gap-1 font-medium text-[#1D4ED8] hover:underline"
                  >
                    <HardDrive className="h-3.5 w-3.5" />
                    {vcamBridgeCount > 0
                      ? 'Driver Active in Windows'
                      : 'Install Windows Virtual Driver'}
                  </button>
                </div>
              </div>
            </div>

            {/* Right Control Sidebar: Full Remote Smartphone Camera Controls */}
            <aside className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3.5">
                <h2 className="text-sm font-semibold text-slate-900">Camera Controls</h2>
                <button
                  type="button"
                  onClick={() =>
                    updateCameraSetting({
                      zoom: 1,
                      digitalZoom: 1,
                      focusMode: 'continuous',
                      exposureCompensation: 0,
                      brightness: 0,
                      contrast: 0,
                      whiteBalanceMode: 'continuous',
                      mirror: false,
                      torch: false,
                    })
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition hover:text-[#1D4ED8]"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </button>
              </div>

              <div className="mt-4 space-y-5">
                {/* Camera Lens Selection */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-slate-600">Camera & Lens</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        updateCameraSetting({ facingMode: 'environment', deviceId: null })
                      }
                      className={`rounded-xl py-2 text-xs font-medium transition ${
                        settings.facingMode === 'environment' && !settings.deviceId
                          ? 'bg-[#1D4ED8] text-white shadow-2xs'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                      }`}
                    >
                      Rear Camera
                    </button>
                    <button
                      type="button"
                      onClick={() => updateCameraSetting({ facingMode: 'user', deviceId: null })}
                      className={`rounded-xl py-2 text-xs font-medium transition ${
                        settings.facingMode === 'user' && !settings.deviceId
                          ? 'bg-[#1D4ED8] text-white shadow-2xs'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                      }`}
                    >
                      Front Camera
                    </button>
                  </div>

                  {rearLenses.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {rearLenses.map((lens) => (
                        <button
                          key={lens.deviceId}
                          type="button"
                          onClick={() =>
                            updateCameraSetting({
                              facingMode: 'environment',
                              deviceId: lens.deviceId,
                            })
                          }
                          className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                            settings.deviceId === lens.deviceId
                              ? 'border-[#1D4ED8] bg-[#EFF6FF] text-[#1D4ED8]'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          {lens.shortLabel}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Resolution (480p / 720p / 1080p / 4K) & Frame Rate (24 / 30 / 60) */}
                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600">Resolution</label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {(['480p', '720p', '1080p', '4k'] as ResolutionPreset[]).map((res) => (
                        <button
                          key={res}
                          type="button"
                          onClick={() => updateCameraSetting({ resolution: res })}
                          className={`rounded-lg py-1.5 font-mono text-xs font-medium transition ${
                            settings.resolution === res
                              ? 'bg-[#1D4ED8] text-white'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                          }`}
                        >
                          {res === '4k' ? '4K' : res}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-600">Frame Rate</label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {([24, 30, 60] as FrameRatePreset[]).map((fps) => (
                        <button
                          key={fps}
                          type="button"
                          onClick={() => updateCameraSetting({ frameRate: fps })}
                          className={`rounded-lg py-1.5 font-mono text-xs font-medium tabular-nums transition ${
                            settings.frameRate === fps
                              ? 'bg-[#1D4ED8] text-white'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200/70'
                          }`}
                        >
                          {fps} FPS
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Zoom Slider */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">Zoom</span>
                    <span className="font-mono text-slate-800 tabular-nums">
                      {(capabilities.zoom ? settings.zoom : settings.digitalZoom).toFixed(1)}×
                    </span>
                  </div>
                  <input
                    type="range"
                    className="lenslink-slider"
                    min={capabilities.zoom ? capabilities.zoom.min : 1}
                    max={capabilities.zoom ? Math.min(8, capabilities.zoom.max) : 4}
                    step={0.1}
                    value={capabilities.zoom ? settings.zoom : settings.digitalZoom}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      updateCameraSetting(
                        capabilities.zoom ? { zoom: val } : { digitalZoom: val }
                      );
                    }}
                  />
                </div>

                {/* Focus Mode + Manual Focus */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                      <Focus className="h-3.5 w-3.5 text-slate-400" />
                      Focus
                    </span>
                    <div className="flex gap-1">
                      {(['continuous', 'manual'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => updateCameraSetting({ focusMode: mode })}
                          className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                            settings.focusMode === mode
                              ? 'bg-[#EFF6FF] text-[#1D4ED8]'
                              : 'text-slate-500 hover:text-slate-800'
                          }`}
                        >
                          {mode === 'continuous' ? 'Auto' : 'Manual'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {settings.focusMode === 'manual' && (
                    <input
                      type="range"
                      className="lenslink-slider"
                      min={0}
                      max={1}
                      step={0.02}
                      value={settings.focusDistance}
                      onChange={(e) =>
                        updateCameraSetting({ focusDistance: Number(e.target.value) })
                      }
                    />
                  )}
                </div>

                {/* Exposure EV, ISO & Brightness */}
                <div className="space-y-3 border-t border-slate-100 pt-4">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 font-medium text-slate-600">
                        <Sun className="h-3.5 w-3.5 text-slate-400" />
                        Exposure
                      </span>
                      <span className="font-mono text-slate-700 tabular-nums">
                        {settings.exposureCompensation >= 0 ? '+' : ''}
                        {settings.exposureCompensation.toFixed(1)} EV
                      </span>
                    </div>
                    <input
                      type="range"
                      className="lenslink-slider"
                      min={capabilities.exposureCompensation?.min ?? -2}
                      max={capabilities.exposureCompensation?.max ?? 2}
                      step={capabilities.exposureCompensation?.step ?? 0.25}
                      value={settings.exposureCompensation}
                      onChange={(e) =>
                        updateCameraSetting({ exposureCompensation: Number(e.target.value) })
                      }
                    />
                  </div>

                  {capabilities.iso && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-600">ISO</span>
                        <span className="font-mono text-slate-700 tabular-nums">
                          {Math.round(settings.iso)}
                        </span>
                      </div>
                      <input
                        type="range"
                        className="lenslink-slider"
                        min={capabilities.iso.min}
                        max={capabilities.iso.max}
                        step={capabilities.iso.step}
                        value={settings.iso}
                        onChange={(e) => updateCameraSetting({ iso: Number(e.target.value) })}
                      />
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-600">Brightness</span>
                      <span className="font-mono text-slate-700 tabular-nums">
                        {settings.brightness > 0 ? `+${settings.brightness}` : settings.brightness}
                      </span>
                    </div>
                    <input
                      type="range"
                      className="lenslink-slider"
                      min={-40}
                      max={40}
                      step={2}
                      value={settings.brightness}
                      onChange={(e) => updateCameraSetting({ brightness: Number(e.target.value) })}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-600">White Balance</span>
                      <div className="flex gap-1">
                        {(['continuous', 'manual'] as const).map((wb) => (
                          <button
                            key={wb}
                            type="button"
                            onClick={() => updateCameraSetting({ whiteBalanceMode: wb })}
                            className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                              settings.whiteBalanceMode === wb
                                ? 'bg-[#EFF6FF] text-[#1D4ED8]'
                                : 'text-slate-500 hover:text-slate-800'
                            }`}
                          >
                            {wb === 'continuous' ? 'Auto' : `${settings.colorTemperature}K`}
                          </button>
                        ))}
                      </div>
                    </div>
                    {settings.whiteBalanceMode === 'manual' && (
                      <input
                        type="range"
                        className="lenslink-slider"
                        min={capabilities.colorTemperature?.min ?? 2800}
                        max={capabilities.colorTemperature?.max ?? 7500}
                        step={100}
                        value={settings.colorTemperature}
                        onChange={(e) =>
                          updateCameraSetting({ colorTemperature: Number(e.target.value) })
                        }
                      />
                    )}
                  </div>
                </div>

                {/* Orientation, Mirror & Flashlight */}
                <div className="space-y-2.5 border-t border-slate-100 pt-4">
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['auto', 'landscape', 'portrait'] as OrientationMode[]).map((ori) => (
                      <button
                        key={ori}
                        type="button"
                        onClick={() => updateCameraSetting({ orientation: ori })}
                        className={`inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium capitalize transition ${
                          settings.orientation === ori
                            ? 'bg-[#EFF6FF] text-[#1D4ED8] ring-1 ring-[#BFDBFE]'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                        }`}
                      >
                        <RotateCw className="h-3 w-3" />
                        {ori}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => updateCameraSetting({ mirror: !settings.mirror })}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-medium transition ${
                        settings.mirror
                          ? 'border-[#1D4ED8] bg-[#EFF6FF] text-[#1D4ED8]'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <FlipHorizontal2 className="h-3.5 w-3.5" />
                      Mirror
                    </button>

                    <button
                      type="button"
                      onClick={() => updateCameraSetting({ torch: !settings.torch })}
                      disabled={capabilities.torch === false}
                      className={`inline-flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
                        settings.torch
                          ? 'border-[#1D4ED8] bg-[#EFF6FF] text-[#1D4ED8]'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Zap className="h-3.5 w-3.5" />
                      Flashlight
                    </button>
                  </div>
                </div>

                {/* Optional Smartphone Microphone & Virtual Mic Audio Routing */}
                <div className="space-y-2.5 border-t border-slate-100 pt-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-700">Phone Microphone</span>
                    <button
                      type="button"
                      onClick={() =>
                        updateCameraSetting({ audioEnabled: !settings.audioEnabled })
                      }
                      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                        settings.audioEnabled
                          ? 'bg-[#1D4ED8] text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                      }`}
                    >
                      {settings.audioEnabled ? (
                        <>
                          <Mic className="h-3.5 w-3.5" /> Enabled
                        </>
                      ) : (
                        <>
                          <MicOff className="h-3.5 w-3.5" /> Off
                        </>
                      )}
                    </button>
                  </div>

                  {settings.audioEnabled && (
                    <div className="space-y-2 rounded-xl bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className="h-full bg-[#1D4ED8] transition-all duration-75"
                            style={{ width: `${audioLevel}%` }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setAudioMuted((prev) => !prev)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-700 hover:text-[#1D4ED8]"
                        >
                          {audioMuted ? (
                            <>
                              <VolumeX className="h-3.5 w-3.5" /> Unmute
                            </>
                          ) : (
                            <>
                              <Volume2 className="h-3.5 w-3.5 text-[#1D4ED8]" /> Live
                            </>
                          )}
                        </button>
                      </div>

                      {audioOutputs.length > 0 && (
                        <select
                          value={selectedAudioOutputId}
                          onChange={(e) => void handleSelectAudioOutput(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-700 focus:border-[#1D4ED8] focus:outline-none"
                          aria-label="Route phone microphone to audio device"
                        >
                          <option value="">Default Audio Output (or VB-Cable Virtual Mic)</option>
                          {audioOutputs.map((dev) => (
                            <option key={dev.deviceId} value={dev.deviceId}>
                              {dev.label || `Audio Device (${dev.deviceId.slice(0, 6)})`}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
};
