import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FlipHorizontal2,
  Maximize2,
  MonitorPlay,
  RefreshCw,
  SlidersHorizontal,
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
  applyLowLatencyReceiver,
  buildVideoFilterCss,
  captureProcessedPhoto,
  collectInboundStats,
  getRtcConfiguration,
  getWsUrl,
  preferHardwareVideoCodec,
  tuneVideoSender,
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
import { VirtualCamPanel } from '../vcam/VirtualCamPanel';
import { QrCodeDisplay } from '../common/QrCodeDisplay';
import { PWAInstallButton } from '../common/PWAInstallButton';
import { downloadBundle } from '../../lib/download';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PC_ROOM_CODE_KEY = 'lenslink_pc_room_code';

function generateLocalPairingCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function getOrCreatePersistentRoomCode(): string {
  try {
    const saved = (localStorage.getItem(PC_ROOM_CODE_KEY) || '').trim().toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(saved)) {
      return saved;
    }
  } catch {
    // Ignore storage read error
  }
  const fresh = generateLocalPairingCode();
  try {
    localStorage.setItem(PC_ROOM_CODE_KEY, fresh);
  } catch {
    // Ignore storage write error
  }
  return fresh;
}

function savePersistentRoomCode(code: string): void {
  try {
    localStorage.setItem(PC_ROOM_CODE_KEY, code);
  } catch {
    // Ignore storage write error
  }
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
  // Persistent Iriun-style room code so phone & OBS Browser Source auto-connect without re-pasting
  const [pairCode, setPairCode] = useState<string>(getOrCreatePersistentRoomCode);
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
  const [vcamWebFrameCount, setVcamWebFrameCount] = useState(0);
  const [vcamWebPeerIds, setVcamWebPeerIds] = useState<string[]>([]);
  const [bridgeStreamEnabled, setBridgeStreamEnabled] = useState(false);
  const [extConnected, setExtConnected] = useState(false);
  const [extRelayActive, setExtRelayActive] = useState(false);
  const [obsConnected, setObsConnected] = useState(false);
  const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);

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
  const [copiedObsUrl, setCopiedObsUrl] = useState(false);
  const [localOnlyIce, setLocalOnlyIce] = useState<boolean>(false);
  const [capturedPhotos, setCapturedPhotos] = useState<CapturedPhoto[]>([]);
  const [downloadingAndroid, setDownloadingAndroid] = useState(false);
  const [androidDownloadError, setAndroidDownloadError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsOpenRef = useRef<boolean>(false);
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
  const hasVideoTrackRef = useRef<boolean>(hasVideoTrack);
  const phoneNameRef = useRef<string>(phoneName);
  const extRelayActiveRef = useRef<boolean>(extRelayActive);

  // Firestore signaling tracking refs
  const lastHandledOfferIdRef = useRef<string>('');
  const processedPhoneIceRef = useRef<Set<string>>(new Set());
  const pcIceListRef = useRef<string[]>([]);
  const pcIceFlushTimerRef = useRef<number | null>(null);
  const restartNonceRef = useRef<number>(0);
  const focusNonceRef = useRef<number>(0);
  const lastSyncedSettingsJsonRef = useRef<string>('');

  // Firestore OBS Studio loopback WebRTC refs
  const obsPcRef = useRef<RTCPeerConnection | null>(null);
  const obsOfferIdRef = useRef<string>('');
  const obsAppliedAnswerOfferIdRef = useRef<string>('');
  const obsLastRequestNonceRef = useRef<number>(-1);
  const obsViewerPresentRef = useRef<boolean>(false);
  const obsProcessedViewerIceRef = useRef<Set<string>>(new Set());
  const obsPendingViewerIceRef = useRef<RTCIceCandidateInit[]>([]);
  const obsPcIceListRef = useRef<string[]>([]);
  const obsPcIceFlushTimerRef = useRef<number | null>(null);

  pairCodeRef.current = pairCode;
  sessionTokenRef.current = sessionToken;
  pcNameRef.current = pcName;
  phoneOnlineRef.current = phoneOnline;
  localOnlyIceRef.current = localOnlyIce;
  settingsRef.current = settings;
  hasVideoTrackRef.current = hasVideoTrack;
  phoneNameRef.current = phoneName;
  extRelayActiveRef.current = extRelayActive;

  // Fetch local LAN IP info for QR code generation (only override origin when on localhost)
  useEffect(() => {
    let active = true;
    const isLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    fetch('/api/network-info')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('not ok'))))
      .then((data: NetworkInfoResponse) => {
        if (!active) return;
        setNetworkInfo(data);
        if (isLocalhost && data.lanIps && data.lanIps.length > 0 && data.suggestedOrigin) {
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

  const closeObsPeer = useCallback(() => {
    if (obsPcIceFlushTimerRef.current) {
      clearTimeout(obsPcIceFlushTimerRef.current);
      obsPcIceFlushTimerRef.current = null;
    }
    obsPcIceListRef.current = [];
    obsPendingViewerIceRef.current = [];
    if (obsPcRef.current) {
      obsPcRef.current.onicecandidate = null;
      obsPcRef.current.onconnectionstatechange = null;
      obsPcRef.current.oniceconnectionstatechange = null;
      obsPcRef.current.close();
      obsPcRef.current = null;
    }
    setObsConnected(false);
  }, []);

  const closeVcamWebPeers = useCallback(() => {
    for (const rtc of vcamPeersRef.current.values()) {
      rtc.close();
    }
    vcamPeersRef.current.clear();
    closeObsPeer();
  }, [closeObsPeer]);

  const closePhonePeer = useCallback(
    (clearPendingIce = true) => {
      if (pcIceFlushTimerRef.current) {
        clearTimeout(pcIceFlushTimerRef.current);
        pcIceFlushTimerRef.current = null;
      }
      pcIceListRef.current = [];
      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
        pcRef.current = null;
      }
      if (clearPendingIce) {
        pendingIceRef.current = [];
      }
      remoteStreamRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setHasVideoTrack(false);
      prevStatsRef.current = null;
      setStats({ width: 0, height: 0, fps: 0, bitrateKbps: 0, rttMs: null });
      closeVcamWebPeers();
    },
    [closeVcamWebPeers]
  );

  const requestPhoneRestart = useCallback(() => {
    sendWs({ type: 'rtc:restart', target: 'phone' });
    restartNonceRef.current += 1;
    void updatePcRoomFields(pairCodeRef.current, {
      restartNonce: restartNonceRef.current,
    });
  }, [sendWs]);

  const handleIncomingOffer = useCallback(
    async (
      sdp: RTCSessionDescriptionInit,
      offerId?: string,
      initialPhoneIce?: RTCIceCandidateInit[]
    ) => {
      const effectiveOfferId = offerId || `ws-${Date.now()}`;
      if (offerId && lastHandledOfferIdRef.current === offerId && pcRef.current) {
        return;
      }
      lastHandledOfferIdRef.current = effectiveOfferId;

      closePhonePeer(false);
      setConnectionStatus('connecting');
      setPhoneStreaming(true);

      const rtc = new RTCPeerConnection(getRtcConfiguration(localOnlyIceRef.current));
      pcRef.current = rtc;

      const schedulePcIceFlush = () => {
        if (pcIceFlushTimerRef.current) return;
        pcIceFlushTimerRef.current = window.setTimeout(() => {
          pcIceFlushTimerRef.current = null;
          if (pcIceListRef.current.length > 0) {
            void updatePcRoomFields(pairCodeRef.current, {
              pcIceCandidates: [...pcIceListRef.current],
            });
          }
        }, 50);
      };

      rtc.ontrack = (trackEvent) => {
        applyLowLatencyReceiver(rtc);
        const stream =
          trackEvent.streams[0] ||
          (trackEvent.track ? new MediaStream([trackEvent.track]) : null);
        if (stream) {
          remoteStreamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.muted = true;
            videoRef.current.playsInline = true;
            videoRef.current.srcObject = stream;
            void videoRef.current.play().catch(() => {});
          }
          setHasVideoTrack(true);
          if (
            rtc.connectionState === 'connected' ||
            rtc.iceConnectionState === 'connected' ||
            rtc.iceConnectionState === 'completed'
          ) {
            setConnectionStatus('connected');
          }
        }
      };

      rtc.onicecandidate = (iceEvent) => {
        if (iceEvent.candidate) {
          const candJson = iceEvent.candidate.toJSON();
          sendWs({
            type: 'rtc:ice-candidate',
            target: 'phone',
            candidate: candJson,
          });
          const encoded = encodeIceCandidate(candJson);
          if (encoded && !pcIceListRef.current.includes(encoded) && pcIceListRef.current.length < 24) {
            pcIceListRef.current.push(encoded);
            schedulePcIceFlush();
          }
        }
      };

      const syncConnectionStatus = () => {
        const connState = rtc.connectionState;
        const iceState = rtc.iceConnectionState;
        if (connState === 'connected' || iceState === 'connected' || iceState === 'completed') {
          applyLowLatencyReceiver(rtc);
          setConnectionStatus('connected');
        } else if (connState === 'connecting' || iceState === 'checking') {
          setConnectionStatus('connecting');
        } else if (connState === 'disconnected' || iceState === 'disconnected') {
          setConnectionStatus('reconnecting');
        } else if (connState === 'failed' || iceState === 'failed') {
          setConnectionStatus('reconnecting');
          requestPhoneRestart();
        }
      };

      rtc.onconnectionstatechange = syncConnectionStatus;
      rtc.oniceconnectionstatechange = syncConnectionStatus;

      try {
        await rtc.setRemoteDescription(new RTCSessionDescription(sdp));
        if (initialPhoneIce && initialPhoneIce.length > 0) {
          for (const cand of initialPhoneIce) {
            await rtc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          }
        }
        for (const cand of pendingIceRef.current) {
          await rtc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        pendingIceRef.current = [];

        const answer = await rtc.createAnswer();
        await rtc.setLocalDescription(answer);
        applyLowLatencyReceiver(rtc);

        const localDesc = rtc.localDescription;
        if (localDesc) {
          sendWs({
            type: 'rtc:answer',
            target: 'phone',
            sdp: localDesc.toJSON(),
          });
          await updatePcRoomFields(pairCodeRef.current, {
            answerForOfferId: effectiveOfferId,
            answerSdp: localDesc.sdp || '',
            pcIceCandidates: [...pcIceListRef.current],
          });
        }
      } catch {
        setConnectionStatus('reconnecting');
      }
    },
    [closePhonePeer, requestPhoneRestart, sendWs]
  );

  // Firestore localhost loopback WebRTC offer to OBS Studio Browser Source (zero /ws required)
  const startObsLoopbackOffer = useCallback(async () => {
    const stream = remoteStreamRef.current;
    const code = pairCodeRef.current;
    if (!stream || !code) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.readyState !== 'live') return;

    closeObsPeer();
    const offerId = `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    obsOfferIdRef.current = offerId;
    obsAppliedAnswerOfferIdRef.current = '';
    obsProcessedViewerIceRef.current.clear();
    obsPendingViewerIceRef.current = [];

    const obsRtc = new RTCPeerConnection(getRtcConfiguration(false));
    obsPcRef.current = obsRtc;

    const sender = obsRtc.addTrack(videoTrack, stream);
    preferHardwareVideoCodec(obsRtc);
    await tuneVideoSender(sender, settingsRef.current);

    const flushObsPcIce = () => {
      if (obsPcIceFlushTimerRef.current) return;
      obsPcIceFlushTimerRef.current = window.setTimeout(() => {
        obsPcIceFlushTimerRef.current = null;
        if (obsOfferIdRef.current === offerId && obsPcIceListRef.current.length > 0) {
          void updateObsViewerFromPc(pairCodeRef.current, {
            pcIceCandidates: [...obsPcIceListRef.current],
          });
        }
      }, 50);
    };

    obsRtc.onicecandidate = (ev) => {
      if (ev.candidate) {
        const encoded = encodeIceCandidate(ev.candidate.toJSON());
        if (encoded && !obsPcIceListRef.current.includes(encoded) && obsPcIceListRef.current.length < 24) {
          obsPcIceListRef.current.push(encoded);
          flushObsPcIce();
        }
      }
    };

    const syncObsState = () => {
      const cState = obsRtc.connectionState;
      const iState = obsRtc.iceConnectionState;
      if (cState === 'connected' || iState === 'connected' || iState === 'completed') {
        setObsConnected(true);
      } else if (cState === 'failed' || cState === 'closed' || cState === 'disconnected') {
        setObsConnected(false);
      }
    };
    obsRtc.onconnectionstatechange = syncObsState;
    obsRtc.oniceconnectionstatechange = syncObsState;

    try {
      const offer = await obsRtc.createOffer();
      await obsRtc.setLocalDescription(offer);
      if (obsRtc.localDescription?.sdp && obsOfferIdRef.current === offerId) {
        await updateObsViewerFromPc(code, {
          offerId,
          offerSdp: obsRtc.localDescription.sdp,
          pcIceCandidates: [...obsPcIceListRef.current],
        });
      }
    } catch {
      closeObsPeer();
    }
  }, [closeObsPeer]);

  // Forward live remote MediaStream to chromeless /vcam browser outputs via loopback WebRTC
  const connectVcamWebPeer = useCallback(
    async (peerId: string) => {
      const stream = remoteStreamRef.current;
      if (!stream) return;

      const existing = vcamPeersRef.current.get(peerId);
      if (existing) existing.close();

      const rtc = new RTCPeerConnection(getRtcConfiguration(localOnlyIceRef.current));
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

      try {
        const offer = await rtc.createOffer();
        await rtc.setLocalDescription(offer);
        sendWs({
          type: 'rtc:offer',
          target: 'vcam-web',
          peerId,
          sdp: rtc.localDescription?.toJSON(),
        });
      } catch {
        vcamPeersRef.current.delete(peerId);
      }
    },
    [sendWs]
  );

  // Ensure remote stream attaches & plays cleanly when video becomes visible
  useEffect(() => {
    if (hasVideoTrack && videoRef.current && remoteStreamRef.current) {
      if (videoRef.current.srcObject !== remoteStreamRef.current) {
        videoRef.current.srcObject = remoteStreamRef.current;
      }
      videoRef.current.muted = true;
      videoRef.current.playsInline = true;
      void videoRef.current.play().catch(() => {});
    }
  }, [hasVideoTrack]);

  // Firestore real-time WebRTC signaling room (works even on static deployments where /ws is unavailable)
  useEffect(() => {
    if (!pairCode) return;
    let active = true;
    lastHandledOfferIdRef.current = '';
    processedPhoneIceRef.current.clear();

    void createOrResetPcRoom({
      code: pairCode,
      sessionToken: sessionTokenRef.current,
      pcName: pcNameRef.current,
    });

    const unsub = subscribeToRoom(pairCode, (room) => {
      if (!active || !room) return;

      const isPhoneOnline = Boolean(room.phoneOnline);
      setPhoneOnline(isPhoneOnline);
      if (room.phoneName) setPhoneName(room.phoneName);

      if (
        room.capabilities &&
        typeof room.capabilities === 'object' &&
        Array.isArray((room.capabilities as CameraCapabilities).devices)
      ) {
        setCapabilities(room.capabilities as CameraCapabilities);
      }

      if (room.settings && typeof room.settings === 'object' && Object.keys(room.settings).length > 0) {
        const incomingJson = JSON.stringify(room.settings);
        if (incomingJson !== lastSyncedSettingsJsonRef.current) {
          lastSyncedSettingsJsonRef.current = incomingJson;
          setSettings((prev) => {
            const merged = { ...prev, ...room.settings };
            settingsRef.current = merged;
            return merged;
          });
        }
      }

      if (typeof room.phoneStreaming === 'boolean') {
        setPhoneStreaming(room.phoneStreaming);
        if (!room.phoneStreaming && isPhoneOnline && !wsOpenRef.current) {
          closePhonePeer();
          setConnectionStatus('waiting');
        }
      }

      if (!isPhoneOnline && !wsOpenRef.current) {
        setPhoneStreaming(false);
        setConnectionStatus('waiting');
        closePhonePeer();
        lastHandledOfferIdRef.current = '';
        processedPhoneIceRef.current.clear();
        return;
      }

      // New WebRTC offer from Smartphone via Firestore
      if (
        room.phoneStreaming &&
        room.offerId &&
        room.offerSdp &&
        room.offerId !== lastHandledOfferIdRef.current
      ) {
        processedPhoneIceRef.current.clear();
        const initialIce: RTCIceCandidateInit[] = [];
        if (Array.isArray(room.phoneIceCandidates)) {
          for (const encoded of room.phoneIceCandidates) {
            processedPhoneIceRef.current.add(encoded);
            const decoded = decodeIceCandidate(encoded);
            if (decoded) initialIce.push(decoded);
          }
        }
        void handleIncomingOffer({ type: 'offer', sdp: room.offerSdp }, room.offerId, initialIce);
        return;
      }

      // Apply trickle ICE candidates from Smartphone
      if (
        Array.isArray(room.phoneIceCandidates) &&
        room.offerId &&
        room.offerId === lastHandledOfferIdRef.current
      ) {
        for (const encoded of room.phoneIceCandidates) {
          if (processedPhoneIceRef.current.has(encoded)) continue;
          processedPhoneIceRef.current.add(encoded);
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
      active = false;
      unsub();
    };
  }, [pairCode, closePhonePeer, handleIncomingOffer]);

  // Subscribe to Firestore OBS Studio Browser Source viewer requests
  useEffect(() => {
    if (!pairCode) return;
    let active = true;
    obsLastRequestNonceRef.current = -1;
    obsViewerPresentRef.current = false;
    obsProcessedViewerIceRef.current.clear();

    const unsub = subscribeToObsViewer(pairCode, async (viewer) => {
      if (!active) return;
      if (!viewer) {
        obsViewerPresentRef.current = false;
        return;
      }

      obsViewerPresentRef.current = true;
      const reqNonce = typeof viewer.requestNonce === 'number' ? viewer.requestNonce : 0;

      if (reqNonce > 0 && reqNonce !== obsLastRequestNonceRef.current) {
        obsLastRequestNonceRef.current = reqNonce;
        if (remoteStreamRef.current && hasVideoTrackRef.current) {
          void startObsLoopbackOffer();
        }
        return;
      }

      if (
        viewer.answerForOfferId &&
        viewer.answerForOfferId === obsOfferIdRef.current &&
        viewer.answerSdp &&
        obsAppliedAnswerOfferIdRef.current !== viewer.answerForOfferId &&
        obsPcRef.current
      ) {
        obsAppliedAnswerOfferIdRef.current = viewer.answerForOfferId;
        try {
          await obsPcRef.current.setRemoteDescription(
            new RTCSessionDescription({ type: 'answer', sdp: viewer.answerSdp })
          );
          for (const cand of obsPendingViewerIceRef.current) {
            await obsPcRef.current.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          }
          obsPendingViewerIceRef.current = [];
        } catch {
          // Ignore stale OBS answer
        }
      }

      if (
        Array.isArray(viewer.viewerIceCandidates) &&
        viewer.answerForOfferId === obsOfferIdRef.current
      ) {
        for (const encoded of viewer.viewerIceCandidates) {
          if (obsProcessedViewerIceRef.current.has(encoded)) continue;
          obsProcessedViewerIceRef.current.add(encoded);
          const decoded = decodeIceCandidate(encoded);
          if (!decoded) continue;
          if (obsPcRef.current && obsPcRef.current.remoteDescription) {
            await obsPcRef.current.addIceCandidate(new RTCIceCandidate(decoded)).catch(() => {});
          } else {
            obsPendingViewerIceRef.current.push(decoded);
          }
        }
      }
    });

    return () => {
      active = false;
      unsub();
      closeObsPeer();
    };
  }, [pairCode, closeObsPeer, startObsLoopbackOffer]);

  // If OBS Browser Source was already open waiting when phone stream begins, connect immediately
  useEffect(() => {
    if (hasVideoTrack && remoteStreamRef.current && obsViewerPresentRef.current && !obsPcRef.current) {
      void startObsLoopbackOffer();
    }
  }, [hasVideoTrack, startObsLoopbackOffer]);

  // Optional local Express WebSocket signaling (auto-backs off silently if /ws is not hosted)
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let openedOnce = false;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        openedOnce = true;
        wsOpenRef.current = true;
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
          if (isPhoneOnline) {
            setPhoneOnline(true);
          }
          if (msg.phoneName) setPhoneName(msg.phoneName);
          if (msg.capabilities) setCapabilities(msg.capabilities);
          if (typeof msg.vcamBridgeCount === 'number') setVcamBridgeCount(msg.vcamBridgeCount);
          if (typeof msg.vcamWebCount === 'number') setVcamWebCount(msg.vcamWebCount);
          if (typeof msg.vcamWebFrameCount === 'number') setVcamWebFrameCount(msg.vcamWebFrameCount);
          if (Array.isArray(msg.vcamWebPeerIds)) {
            setVcamWebPeerIds(msg.vcamWebPeerIds);
            for (const existingPeerId of Array.from(vcamPeersRef.current.keys())) {
              if (!msg.vcamWebPeerIds.includes(existingPeerId)) {
                vcamPeersRef.current.get(existingPeerId)?.close();
                vcamPeersRef.current.delete(existingPeerId);
              }
            }
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

        if (msg.type === 'vcam:request-offer' && msg.peerId) {
          if (remoteStreamRef.current) {
            void connectVcamWebPeer(msg.peerId);
          }
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

        // Handle WebRTC offer from Smartphone over WS
        if (msg.type === 'rtc:offer' && msg.sdp) {
          await handleIncomingOffer(msg.sdp, msg.sessionToken);
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
        wsOpenRef.current = false;
        if (disposed) return;
        attempt += 1;
        // If /ws never opened (e.g. static/shared deployment), silently rely on Firestore signaling
        if (!openedOnce && attempt >= 2) {
          return;
        }
        if (openedOnce && pcRef.current?.connectionState !== 'connected') {
          setConnectionStatus('reconnecting');
        }
        const delay = Math.min(8000, 1000 * Math.pow(1.6, attempt - 1));
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      wsOpenRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      closePhonePeer();
    };
  }, [closePhonePeer, connectVcamWebPeer, handleIncomingOffer, sendWs]);

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

  // Auto-enable frame relay when Virtual Cam extension, DirectShow bridge, or fallback browser source connects
  useEffect(() => {
    if ((vcamBridgeCount > 0 || vcamWebFrameCount > 0 || extRelayActive) && hasVideoTrack) {
      setBridgeStreamEnabled(true);
    }
  }, [vcamBridgeCount, vcamWebFrameCount, extRelayActive, hasVideoTrack]);

  // Direct zero-WebSocket bridge with LensLink Browser Virtual Webcam Extension
  const publishPcStatusToExtension = useCallback(() => {
    window.postMessage(
      {
        source: 'lenslink-pc-app',
        type: 'pc-status',
        pairCode: pairCodeRef.current,
        pcOnline: true,
        phoneOnline: phoneOnlineRef.current,
        phoneName: phoneNameRef.current,
        hasVideoTrack: hasVideoTrackRef.current,
      },
      '*'
    );
  }, []);

  useEffect(() => {
    publishPcStatusToExtension();
  }, [pairCode, phoneOnline, phoneName, hasVideoTrack, publishPcStatusToExtension]);

  useEffect(() => {
    const handleExtMessage = (event: MessageEvent) => {
      if (event.source !== window || !event.data || event.data.source !== 'lenslink-ext-iso') {
        return;
      }
      if (event.data.type === 'ext-hello') {
        setExtConnected(true);
        publishPcStatusToExtension();
      } else if (event.data.type === 'pc-relay-control') {
        setExtConnected(true);
        const active = Boolean(event.data.active);
        setExtRelayActive(active);
        if (active) {
          setBridgeStreamEnabled(true);
        }
        publishPcStatusToExtension();
      }
    };
    window.addEventListener('message', handleExtMessage);
    return () => {
      window.removeEventListener('message', handleExtMessage);
    };
  }, [publishPcStatusToExtension]);

  // Publish active PC session code for Browser Virtual Webcam extension auto-pairing
  useEffect(() => {
    if (!pairCode) return;
    document.documentElement.setAttribute('data-lenslink-pc-code', pairCode);
    document.documentElement.setAttribute('data-lenslink-origin', window.location.origin);
    window.dispatchEvent(
      new CustomEvent('lenslink:pc-session', {
        detail: { pairCode, origin: window.location.origin },
      })
    );
    return () => {
      document.documentElement.removeAttribute('data-lenslink-pc-code');
      document.documentElement.removeAttribute('data-lenslink-origin');
    };
  }, [pairCode]);

  // Stream frames asynchronously via Web Worker timer (zero main-thread freeze!)
  // Downscales Chrome Extension frames to max 960px WebP/JPEG (~70% smaller, buttery smooth)
  useEffect(() => {
    const hasWsFrameClients = vcamBridgeCount > 0 || vcamWebFrameCount > 0;
    const needsExtensionFrames = extRelayActive;
    if (!hasVideoTrack) return;
    if (!needsExtensionFrames && !(bridgeStreamEnabled && hasWsFrameClients)) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const targetFps = Math.min(30, settings.frameRate || 30);
    const intervalMs = Math.round(1000 / targetFps);
    let busy = false;
    let disposed = false;

    const blobToDataUrl = (blob: Blob): Promise<string | null> =>
      new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(typeof reader.result === 'string' ? reader.result : null);
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });

    const pumpFrame = () => {
      const video = videoRef.current;
      if (disposed || busy || !video || video.readyState < video.HAVE_CURRENT_DATA) {
        return;
      }

      const ws = wsRef.current;
      const sendOverWs =
        Boolean(ws && ws.readyState === WebSocket.OPEN) &&
        bridgeStreamEnabled &&
        hasWsFrameClients;
      const sendToExt = extRelayActiveRef.current;
      if (!sendOverWs && !sendToExt) return;

      const dims = RESOLUTION_DIMENSIONS[settings.resolution] || RESOLUTION_DIMENSIONS['720p'];
      const srcW = video.videoWidth || dims.width;
      const srcH = video.videoHeight || dims.height;

      // Cap extension relay at 960px wide to keep 30fps crisp with near-zero CPU & IPC overhead
      const maxRelayW = sendOverWs ? 1280 : 960;
      const scale = srcW > maxRelayW ? maxRelayW / srcW : 1;
      const outW = Math.max(2, Math.round(srcW * scale));
      const outH = Math.max(2, Math.round(srcH * scale));

      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
      }

      const filterCss = buildVideoFilterCss(
        settings,
        Boolean(capabilities?.brightness),
        Boolean(capabilities?.contrast)
      );
      const dz = Math.max(1, settings.digitalZoom || 1);
      const cropW = Math.round(srcW / dz);
      const cropH = Math.round(srcH / dz);
      const cropX = Math.round((srcW - cropW) / 2);
      const cropY = Math.round((srcH - cropH) / 2);

      busy = true;
      ctx.save();
      if (settings.mirror) {
        ctx.translate(outW, 0);
        ctx.scale(-1, 1);
      }
      ctx.filter = filterCss || 'none';
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
      ctx.restore();

      const mimeType = sendOverWs ? 'image/jpeg' : 'image/webp';
      const quality = sendOverWs ? 0.8 : 0.72;

      canvas.toBlob(
        async (blob) => {
          try {
            if (disposed || !blob) return;

            if (sendToExt) {
              const dataUrl = await blobToDataUrl(blob);
              if (!disposed && dataUrl) {
                window.postMessage(
                  {
                    source: 'lenslink-pc-app',
                    type: 'pc-frame',
                    dataUrl,
                  },
                  '*'
                );
              }
            }

            if (sendOverWs && ws && ws.readyState === WebSocket.OPEN) {
              const buf = await blob.arrayBuffer();
              if (!disposed && ws.readyState === WebSocket.OPEN) {
                ws.send(buf);
              }
            }
          } catch {
            // Ignore transient frame encode error
          } finally {
            busy = false;
          }
        },
        mimeType,
        quality
      );
    };

    let worker: Worker | null = null;
    let workerUrl: string | null = null;
    let fallbackTimer: number | null = null;

    try {
      const workerCode = `setInterval(() => postMessage(0), ${intervalMs});`;
      workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
      worker = new Worker(workerUrl);
      worker.onmessage = pumpFrame;
    } catch {
      fallbackTimer = window.setInterval(pumpFrame, intervalMs);
    }

    return () => {
      disposed = true;
      if (worker) worker.terminate();
      if (workerUrl) URL.revokeObjectURL(workerUrl);
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, [
    bridgeStreamEnabled,
    capabilities?.brightness,
    capabilities?.contrast,
    extRelayActive,
    hasVideoTrack,
    settings,
    vcamBridgeCount,
    vcamWebFrameCount,
  ]);

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
    savePersistentRoomCode(nextCode);
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
    void updatePcRoomFields(pairCodeRef.current, { pcName: nextName });
  };

  const updateRemoteSetting = (patch: Partial<CameraSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    lastSyncedSettingsJsonRef.current = JSON.stringify(next);
    setSettings(next);
    settingsRef.current = next;
    sendWs({ type: 'camera:settings', settings: patch });
    void updatePcRoomFields(pairCodeRef.current, { settings: next });
  };

  const pairingUrl = pairCode
    ? `${selectedOrigin}/phone?pair=${pairCode}&sid=${sessionToken}`
    : '';
  const obsBrowserUrl = pairCode ? `${window.location.origin}/?mode=vcam&pair=${pairCode}` : '';

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

  const handleCopyObsUrl = async () => {
    if (!obsBrowserUrl) return;
    await navigator.clipboard.writeText(obsBrowserUrl).catch(() => {});
    setCopiedObsUrl(true);
    window.setTimeout(() => setCopiedObsUrl(false), 1600);
  };

  const handleCaptureOnPc = async (category: CaptureCategory) => {
    if (wsOpenRef.current && phoneOnline) {
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
              Webcam
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
              Apps &amp; OBS
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
              Setup
            </button>
          </nav>

          {/* Zone 3: Single primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleRegenerateCode}
              className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              New Code
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Viewport */}
      <main className="flex-1 px-6 lg:px-8 py-6">
        <div className="max-w-[1440px] mx-auto">
          <div
            className={
              activeTab === 'receiver'
                ? 'grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start'
                : 'fixed -left-[9999px] top-0 w-[640px] h-[360px] opacity-[0.01] pointer-events-none overflow-hidden'
            }
            aria-hidden={activeTab !== 'receiver'}
          >
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
                    onLoadedMetadata={(e) => {
                      void e.currentTarget.play().catch(() => {});
                    }}
                    onPlaying={() => {
                      setConnectionStatus('connected');
                    }}
                    onClick={(e) => {
                      if (!hasVideoTrack) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
                      sendWs({ type: 'camera:trigger-focus', focusPoint: { x, y } });
                      focusNonceRef.current += 1;
                      void updatePcRoomFields(pairCodeRef.current, {
                        focusNonce: focusNonceRef.current,
                        focusX: x,
                        focusY: y,
                      });
                    }}
                    style={{
                      transform: videoTransform || undefined,
                      filter: videoFilterCss,
                    }}
                    className={
                      hasVideoTrack
                        ? 'w-full h-full object-contain cursor-crosshair'
                        : 'absolute inset-0 w-full h-full opacity-0 pointer-events-none'
                    }
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
                              ? 'Smartphone connected — tap Start Stream on your phone'
                              : 'Scan once — connect & play anytime'}
                          </h1>
                          <p className="text-sm text-slate-400 leading-relaxed">
                            Your PC remembers this code automatically so your phone and OBS Studio reconnect with one tap next time.
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
                        Wi-Fi signal interrupted — reconnecting automatically
                      </p>
                    </div>
                  )}
                </div>

                {/* Iriun-Style Instant 1-Click Play & Speed Bar */}
                <div className="p-3.5 rounded-xl bg-white border border-slate-200 flex flex-wrap items-center justify-between gap-3">
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
                      {stats.width > 0 ? `${stats.width}×${stats.height}` : RESOLUTION_DIMENSIONS[settings.resolution].label}
                    </span>

                    <span aria-hidden="true" className="text-slate-300">·</span>

                    <span className="font-mono tabular-nums">
                      {hasVideoTrack && stats.fps > 0 ? `${stats.fps} fps` : `${settings.frameRate} fps`}
                    </span>

                    {hasVideoTrack && stats.rttMs !== null && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-mono tabular-nums">{stats.rttMs} ms</span>
                      </>
                    )}

                    {(obsConnected || vcamWebCount > 0) && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-semibold text-emerald-700">OBS Live</span>
                      </>
                    )}

                    {extRelayActive && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">·</span>
                        <span className="font-semibold text-blue-700">Extension Live</span>
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Instant Speed / Quality Selector */}
                    <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 border border-slate-200/80">
                      {([
                        { id: '480p', label: 'Fast 480p' },
                        { id: '720p', label: 'Smooth 720p' },
                        { id: '1080p', label: 'Sharp 1080p' },
                      ] as { id: ResolutionPreset; label: string }[]).map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => updateRemoteSetting({ resolution: preset.id })}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                            settings.resolution === preset.id
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        updateRemoteSetting({
                          frameRate: settings.frameRate === 60 ? 30 : 60,
                        })
                      }
                      className="px-2.5 py-1.5 rounded-lg text-xs font-mono font-semibold bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 tabular-nums"
                      title="Toggle 30 / 60 fps"
                    >
                      {settings.frameRate} fps
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        updateRemoteSetting({
                          facingMode: settings.facingMode === 'environment' ? 'user' : 'environment',
                          deviceId: undefined,
                          torch: false,
                          mirror: settings.facingMode === 'environment',
                        })
                      }
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 transition-colors"
                    >
                      {settings.facingMode === 'environment' ? 'Rear' : 'Front'}
                    </button>

                    <button
                      type="button"
                      onClick={() => updateRemoteSetting({ mirror: !settings.mirror })}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors inline-flex items-center gap-1.5 ${
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
                      <span>Capture</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleFullscreen}
                      disabled={!hasVideoTrack}
                      className="p-1.5 rounded-lg text-xs font-medium bg-white text-slate-700 border border-slate-200 hover:bg-slate-100 disabled:opacity-45 disabled:pointer-events-none transition-colors"
                      title="Fullscreen"
                      aria-label="Fullscreen"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
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

              {/* Right Column: Clean Iriun-Style Quick Connect & Collapsible Adjustments */}
              <aside className="space-y-4">
                <PWAInstallButton />

                {/* Quick Connect & Outputs */}
                <section className="p-5 rounded-xl bg-white border border-slate-200 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-900">Quick Connect</h2>
                    {phoneOnline ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{phoneName}</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <WifiOff className="w-3.5 h-3.5" />
                        <span>Waiting</span>
                      </span>
                    )}
                  </div>

                  {/* Persistent Room Code + 1-click Copy */}
                  <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[11px] font-medium text-slate-500">Persistent PC Code</div>
                      <div className="font-mono text-lg font-bold tracking-[0.2em] text-slate-900 tabular-nums">
                        {pairCode}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleCopyCode}
                      className="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 transition-colors"
                    >
                      {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>

                  {/* Instant OBS Studio & Extension Actions */}
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={handleCopyObsUrl}
                      className="w-full py-2.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
                    >
                      {copiedObsUrl ? <Check className="w-3.5 h-3.5" /> : <MonitorPlay className="w-3.5 h-3.5" />}
                      <span>
                        {copiedObsUrl
                          ? 'OBS Browser URL Copied!'
                          : obsConnected || vcamWebCount > 0
                            ? 'OBS Connected — Copy URL'
                            : 'Copy OBS Browser Source URL'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setActiveTab('virtual-cam')}
                      className="w-full py-2 px-3 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium inline-flex items-center justify-center gap-2 transition-colors"
                    >
                      <Video className="w-3.5 h-3.5" />
                      <span>
                        {extRelayActive
                          ? 'Chrome Extension: Streaming'
                          : extConnected
                            ? 'Chrome Extension: Linked'
                            : 'Open OBS & Virtual Cam Setup'}
                      </span>
                    </button>
                  </div>

                  {phoneOnline && (
                    <button
                      type="button"
                      onClick={requestPhoneRestart}
                      className="w-full py-2 px-3 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Reconnect Stream</span>
                    </button>
                  )}

                  <div className="pt-2 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => onOpenPhoneMode(pairCode)}
                      className="w-full py-2 px-3 rounded-lg bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-medium inline-flex items-center justify-center gap-2 transition-colors"
                    >
                      <Smartphone className="w-3.5 h-3.5" />
                      <span>Switch to Phone Camera Mode</span>
                    </button>
                  </div>
                </section>

                {/* Collapsible Advanced Camera Adjustments */}
                <section className="rounded-xl bg-white border border-slate-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setAdjustmentsOpen((prev) => !prev)}
                    className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
                  >
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <SlidersHorizontal className="w-4 h-4 text-slate-500" />
                      <span>Camera Adjustments</span>
                    </span>
                    {adjustmentsOpen ? (
                      <ChevronUp className="w-4 h-4 text-slate-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                  </button>

                  {adjustmentsOpen && (
                    <div className="px-5 pb-5 pt-2 border-t border-slate-100 space-y-5">
                      {/* PC Workstation Label */}
                      <div className="space-y-1.5">
                        <label
                          htmlFor="pc-workstation-name"
                          className="block text-xs font-medium text-slate-600"
                        >
                          PC Label
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

                      {/* Frame Rate Presets */}
                      <div className="space-y-1.5">
                        <span className="block text-xs font-medium text-slate-600">Frame Rate</span>
                        <div className="grid grid-cols-4 gap-1.5 p-1 rounded-lg bg-slate-100">
                          {([15, 24, 30, 60] as FrameRatePreset[]).map((fps) => (
                            <button
                              key={fps}
                              type="button"
                              onClick={() => updateRemoteSetting({ frameRate: fps })}
                              className={`py-1.5 rounded-md text-xs font-semibold font-mono tabular-nums transition-colors ${
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
                                focusNonceRef.current += 1;
                                void updatePcRoomFields(pairCodeRef.current, {
                                  focusNonce: focusNonceRef.current,
                                  focusX: 0.5,
                                  focusY: 0.5,
                                });
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

                      {/* High-Contrast B&W + Reset */}
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

                      {/* Local-Only WebRTC toggle */}
                      <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                        <div>
                          <div className="text-xs font-medium text-slate-700">
                            Local-Only WebRTC
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Leave off for best router compatibility
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
                    </div>
                  )}
                </section>
              </aside>
          </div>

          {activeTab === 'virtual-cam' && (
            <VirtualCamPanel
              pairCode={pairCode}
              vcamBridgeCount={vcamBridgeCount}
              extConnected={extConnected}
              extRelayActive={extRelayActive}
              obsConnected={obsConnected}
              vcamWebCount={vcamWebCount}
              vcamWebFrameCount={vcamWebFrameCount}
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
                    Open the Virtual Webcam tab to install the Browser Virtual Webcam extension or standalone Windows DirectShow driver (no OBS Studio needed), then choose LensLink inside Google Meet, Zoom, Teams, or BIS portals.
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

              <div className="p-6 rounded-xl bg-white border border-slate-200 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Native Android Mobile App (Kotlin / Android Studio)
                    </h3>
                    <p className="text-sm text-slate-600 leading-relaxed">
                      Download the pre-configured Android Studio project with native Camera2/WebRTC streaming, QR scanner, pinch-to-zoom, and long-press brightness control.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={downloadingAndroid}
                    onClick={async () => {
                      setDownloadingAndroid(true);
                      setAndroidDownloadError(null);
                      const result = await downloadBundle(
                        `/api/android-app/bundle?origin=${encodeURIComponent(window.location.origin)}`,
                        'lenslink-android-studio.zip'
                      );
                      setDownloadingAndroid(false);
                      if (!result.ok) {
                        setAndroidDownloadError(result.error || 'Download failed.');
                      }
                    }}
                    className="px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                  >
                    <Smartphone className="w-4 h-4" />
                    <span>{downloadingAndroid ? 'Preparing .zip...' : 'Download Android App (.zip)'}</span>
                  </button>
                </div>
                {androidDownloadError && (
                  <p className="text-xs text-red-600">{androidDownloadError}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
