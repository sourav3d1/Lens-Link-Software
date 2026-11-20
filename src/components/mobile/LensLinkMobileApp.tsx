import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  Battery,
  BatteryCharging,
  Camera,
  FlipHorizontal2,
  Laptop,
  Mic,
  MicOff,
  Moon,
  Power,
  QrCode,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  SwitchCamera,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  LensLinkConnectionStatus,
  LensLinkDataChannelMessage,
  CameraCapabilities,
  CameraSettings,
  DEFAULT_CAMERA_SETTINGS,
  DiscoveredPc,
  FocusTapPoint,
  FrameRatePreset,
  OrientationMode,
  PhoneTelemetry,
  ResolutionPreset,
  StreamStats,
} from '../../types/lenslink';
import {
  acquireMicrophoneTrack,
  applyHardwareConstraints,
  buildVideoFilterCss,
  collectOutboundStats,
  createInitialPhoneTelemetry,
  extractCameraCapabilities,
  getCameraStreamSafe,
  getRtcConfiguration,
  getWsUrl,
  isLocalLanHostname,
  preferHardwareVideoCodec,
  readBatteryTelemetry,
  StatsSnapshot,
  triggerTapAutoFocus,
  tuneVideoSender,
} from '../../lib/webrtc';
import {
  decodeIceCandidate,
  encodeIceCandidate,
  subscribeToRoom,
  updatePhoneRoomFields,
} from '../../lib/firestoreSignaling';
import { MobilePWAInstallButton } from '../common/PWAInstallButton';

interface LensLinkMobileAppProps {
  initialRoomCode?: string | null;
  onSwitchToDesktop: () => void;
}

const LAST_PC_STORAGE_KEY = 'lenslink_last_paired_pc';

function loadRememberedPc(): { roomCode: string; pcName: string } | null {
  try {
    const raw = window.localStorage.getItem(LAST_PC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { roomCode?: string; pcName?: string };
    if (parsed.roomCode && /^[A-Z0-9]{6}$/.test(parsed.roomCode)) {
      return { roomCode: parsed.roomCode, pcName: parsed.pcName || 'Windows PC' };
    }
  } catch {
    // Ignore storage error
  }
  return null;
}

function saveRememberedPc(roomCode: string, pcName: string) {
  try {
    window.localStorage.setItem(LAST_PC_STORAGE_KEY, JSON.stringify({ roomCode, pcName }));
  } catch {
    // Ignore storage error
  }
}

export const LensLinkMobileApp: React.FC<LensLinkMobileAppProps> = ({
  initialRoomCode,
  onSwitchToDesktop,
}) => {
  const [discoveredPcs, setDiscoveredPcs] = useState<DiscoveredPc[]>([]);
  const [rememberedPc, setRememberedPc] = useState<{ roomCode: string; pcName: string } | null>(
    () => loadRememberedPc()
  );
  const [activeRoomCode, setActiveRoomCode] = useState<string | null>(() =>
    initialRoomCode && /^[A-Z0-9]{6}$/i.test(initialRoomCode)
      ? initialRoomCode.toUpperCase()
      : null
  );
  const [connectedPcName, setConnectedPcName] = useState<string>('Windows PC');
  const [status, setStatus] = useState<LensLinkConnectionStatus>(
    initialRoomCode ? 'connecting' : 'searching'
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchElapsedSec, setSearchElapsedSec] = useState(0);

  // Camera & streaming state
  const [settings, setSettings] = useState<CameraSettings>(DEFAULT_CAMERA_SETTINGS);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({ devices: [] });
  const [stats, setStats] = useState<StreamStats>({
    width: 0,
    height: 0,
    fps: 0,
    bitrateKbps: 0,
    rttMs: null,
    packetLossPct: 0,
    signalQuality: 'Excellent',
  });
  const [batteryPct, setBatteryPct] = useState<number | null>(null);
  const [batteryCharging, setBatteryCharging] = useState<boolean | null>(null);

  // UI overlays
  const [showSettingsSheet, setShowSettingsSheet] = useState(false);
  const [screenDimmed, setScreenDimmed] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [focusTap, setFocusTap] = useState<FocusTapPoint | null>(null);

  // Refs for media, WebSocket, WebRTC, and adaptive bitrate
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const qrVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const statsSnapshotRef = useRef<StatsSnapshot | null>(null);
  const bitrateScaleRef = useRef<number>(1);
  const settingsRef = useRef<CameraSettings>(settings);
  settingsRef.current = settings;
  const activeRoomRef = useRef<string | null>(activeRoomCode);
  activeRoomRef.current = activeRoomCode;

  // Pinch-to-zoom tracking
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);

  // Firestore signaling tracking refs
  const currentOfferIdRef = useRef<string>('');
  const processedAnswerOfferIdRef = useRef<string>('');
  const processedPcIceRef = useRef<Set<string>>(new Set());
  const phoneIceBufRef = useRef<string[]>([]);
  const phoneIceTimerRef = useRef<number | null>(null);
  const lastRestartNonceRef = useRef<number>(0);
  const lastFocusNonceRef = useRef<number>(0);

  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const sendDataChannel = useCallback((msg: LensLinkDataChannelMessage) => {
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

  // Keep screen awake during streaming (including during OLED screen-dimming mode)
  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request('screen');
      }
    } catch {
      // Optional API
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  // Battery telemetry poller
  useEffect(() => {
    const refresh = async () => {
      const bat = await readBatteryTelemetry();
      setBatteryPct(bat.batteryPct);
      setBatteryCharging(bat.charging);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  // Compute current active lens label
  const activeLensLabel = useMemo(() => {
    if (settings.deviceId) {
      const found = capabilities.devices.find((d) => d.deviceId === settings.deviceId);
      if (found) return found.shortLabel;
    }
    return settings.facingMode === 'user' ? 'Front' : 'Rear Main';
  }, [capabilities.devices, settings.deviceId, settings.facingMode]);

  const buildTelemetry = useCallback((): PhoneTelemetry => {
    const base = createInitialPhoneTelemetry(activeLensLabel, settingsRef.current.audioEnabled);
    return {
      ...base,
      batteryPct,
      charging: batteryCharging,
      thermalState: 'Nominal',
    };
  }, [activeLensLabel, batteryCharging, batteryPct]);

  // Send telemetry heartbeat whenever connected
  useEffect(() => {
    if (!activeRoomCode || status !== 'connected') return;
    const emit = () => {
      const tel = buildTelemetry();
      sendDataChannel({ type: 'telemetry', telemetry: tel });
      sendWs({ type: 'camera:telemetry', telemetry: tel });
    };
    emit();
    const timer = window.setInterval(emit, 5000);
    return () => window.clearInterval(timer);
  }, [activeRoomCode, buildTelemetry, sendDataChannel, sendWs, status]);

  // Stop local media tracks
  const stopLocalMedia = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = null;
    }
  }, []);

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
        rtcPcRef.current.onicecandidate = null;
        rtcPcRef.current.onconnectionstatechange = null;
        rtcPcRef.current.close();
      } catch {
        // Ignore
      }
      rtcPcRef.current = null;
    }
    statsSnapshotRef.current = null;
  }, []);

  const flushPhoneIceToFirestore = useCallback((code: string) => {
    if (phoneIceTimerRef.current) return;
    phoneIceTimerRef.current = window.setTimeout(() => {
      phoneIceTimerRef.current = null;
      if (phoneIceBufRef.current.length === 0) return;
      void updatePhoneRoomFields(code, { phoneIceCandidates: [...phoneIceBufRef.current] });
    }, 50);
  }, []);

  // Acquire smartphone camera (+ optional microphone) and publish capabilities
  const startCameraCapture = useCallback(
    async (targetSettings: CameraSettings, roomCode: string): Promise<MediaStream | null> => {
      try {
        stopLocalMedia();
        const stream = await getCameraStreamSafe(targetSettings);
        streamRef.current = stream;

        if (previewVideoRef.current) {
          previewVideoRef.current.srcObject = stream;
          previewVideoRef.current.play().catch(() => {});
        }

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          const caps = await extractCameraCapabilities(videoTrack);
          setCapabilities(caps);
          await applyHardwareConstraints(videoTrack, targetSettings);

          const tel = createInitialPhoneTelemetry(
            targetSettings.facingMode === 'user' ? 'Front' : 'Rear Main',
            stream.getAudioTracks().length > 0
          );
          sendWs({
            type: 'camera:capabilities',
            capabilities: caps,
            phoneName: tel.model,
          });
          sendDataChannel({ type: 'capabilities', capabilities: caps });
          void updatePhoneRoomFields(roomCode, {
            phoneOnline: true,
            phoneName: tel.model,
            phoneStreaming: true,
            capabilities: caps,
            settings: targetSettings,
          });
        }
        setErrorMessage(null);
        return stream;
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Camera access was denied. Please grant camera permission and try again.';
        setErrorMessage(msg);
        setStatus('disconnected');
        return null;
      }
    },
    [sendDataChannel, sendWs, stopLocalMedia]
  );

  // Create & transmit encrypted WebRTC Offer to the Windows PC
  const startWebRtcOffer = useCallback(
    async (roomCode: string, existingStream?: MediaStream | null) => {
      setStatus('connecting');
      const stream =
        existingStream || streamRef.current || (await startCameraCapture(settingsRef.current, roomCode));
      if (!stream) return;

      closePeerConnection();
      const pc = new RTCPeerConnection(getRtcConfiguration(isLocalLanHostname()));
      rtcPcRef.current = pc;
      phoneIceBufRef.current = [];
      processedPcIceRef.current.clear();

      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      // Create ultra-low-latency DataChannel for remote controls & telemetry
      const dc = pc.createDataChannel('lenslink-control', { ordered: true });
      dataChannelRef.current = dc;
      dc.onopen = () => {
        const tel = buildTelemetry();
        dc.send(JSON.stringify({ type: 'telemetry', telemetry: tel }));
      };
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as LensLinkDataChannelMessage;
          if (msg.type === 'settings') {
            void applyRemoteOrLocalSettingsRef.current(msg.settings, true);
          } else if (msg.type === 'tap-focus') {
            setFocusTap({ x: msg.x, y: msg.y, ts: Date.now() });
            const vt = streamRef.current?.getVideoTracks()[0];
            void triggerTapAutoFocus(vt, { x: msg.x, y: msg.y });
          }
        } catch {
          // Ignore malformed DataChannel frame
        }
      };

      preferHardwareVideoCodec(pc);

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        const init = ev.candidate.toJSON();
        sendWs({ type: 'rtc:ice-candidate', candidate: init, target: 'pc' });
        const enc = encodeIceCandidate(init);
        if (enc && phoneIceBufRef.current.length < 24) {
          phoneIceBufRef.current.push(enc);
          flushPhoneIceToFirestore(roomCode);
        }
      };

      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
          setStatus('connected');
          setErrorMessage(null);
          const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
          void tuneVideoSender(videoSender, settingsRef.current, bitrateScaleRef.current);
        } else if (st === 'connecting') {
          setStatus('connecting');
        } else if (st === 'failed' || st === 'disconnected') {
          setStatus('disconnected');
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const offerId = `offer-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        currentOfferIdRef.current = offerId;
        processedAnswerOfferIdRef.current = '';

        sendWs({ type: 'rtc:offer', sdp: offer.sdp, target: 'pc' });
        await updatePhoneRoomFields(roomCode, {
          phoneOnline: true,
          phoneStreaming: true,
          offerId,
          offerSdp: offer.sdp || '',
          phoneIceCandidates: phoneIceBufRef.current,
        });
      } catch {
        setStatus('disconnected');
        setErrorMessage('Failed to establish encrypted Wi-Fi video link. Tap Reconnect.');
      }
    },
    [
      buildTelemetry,
      closePeerConnection,
      flushPhoneIceToFirestore,
      sendWs,
      startCameraCapture,
    ]
  );

  // Apply settings either from user taps on phone or remote commands from Windows PC
  const applyRemoteOrLocalSettings = useCallback(
    async (patch: Partial<CameraSettings>, fromRemote: boolean) => {
      const prev = settingsRef.current;
      const next: CameraSettings = { ...prev, ...patch };
      setSettings(next);

      if (!fromRemote) {
        sendDataChannel({ type: 'settings', settings: patch });
        sendWs({ type: 'camera:settings', settings: patch });
        if (activeRoomRef.current) {
          void updatePhoneRoomFields(activeRoomRef.current, { settings: next });
        }
      }

      const needsStreamRestart =
        patch.facingMode !== undefined ||
        patch.deviceId !== undefined ||
        patch.resolution !== undefined ||
        patch.frameRate !== undefined ||
        patch.orientation !== undefined;

      if (needsStreamRestart && activeRoomRef.current) {
        const freshStream = await startCameraCapture(next, activeRoomRef.current);
        if (freshStream && rtcPcRef.current) {
          const newVideoTrack = freshStream.getVideoTracks()[0];
          const videoSender = rtcPcRef.current
            .getSenders()
            .find((s) => s.track?.kind === 'video');
          if (newVideoTrack && videoSender) {
            await videoSender.replaceTrack(newVideoTrack);
            await tuneVideoSender(videoSender, next, bitrateScaleRef.current);
          } else {
            await startWebRtcOffer(activeRoomRef.current, freshStream);
          }
        }
        return;
      }

      // Live toggle of smartphone microphone audio without interrupting video
      if (patch.audioEnabled !== undefined && activeRoomRef.current) {
        const stream = streamRef.current;
        const pc = rtcPcRef.current;
        if (patch.audioEnabled) {
          const micTrack = await acquireMicrophoneTrack();
          if (micTrack && stream) {
            stream.addTrack(micTrack);
            if (pc) {
              const existingAudioSender = pc
                .getSenders()
                .find((s) => s.track?.kind === 'audio');
              if (existingAudioSender) {
                await existingAudioSender.replaceTrack(micTrack);
              } else {
                pc.addTrack(micTrack, stream);
                await startWebRtcOffer(activeRoomRef.current, stream);
              }
            }
          }
        } else if (stream) {
          for (const audioTrack of stream.getAudioTracks()) {
            audioTrack.stop();
            stream.removeTrack(audioTrack);
          }
          if (pc) {
            const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio');
            if (audioSender) {
              await audioSender.replaceTrack(null).catch(() => {});
            }
          }
        }
      }

      const videoTrack = streamRef.current?.getVideoTracks()[0];
      await applyHardwareConstraints(videoTrack, patch);
    },
    [sendDataChannel, sendWs, startCameraCapture, startWebRtcOffer]
  );

  const applyRemoteOrLocalSettingsRef = useRef(applyRemoteOrLocalSettings);
  applyRemoteOrLocalSettingsRef.current = applyRemoteOrLocalSettings;

  // Connect to a selected Windows PC (1-tap from discovery list or QR scan)
  const connectToPc = useCallback(
    async (roomCode: string, pcName: string) => {
      const cleanCode = roomCode.trim().toUpperCase();
      setActiveRoomCode(cleanCode);
      setConnectedPcName(pcName || 'Windows PC');
      saveRememberedPc(cleanCode, pcName || 'Windows PC');
      setRememberedPc({ roomCode: cleanCode, pcName: pcName || 'Windows PC' });
      setStatus('connecting');
      setErrorMessage(null);
      await requestWakeLock();

      const tel = createInitialPhoneTelemetry(activeLensLabel, settingsRef.current.audioEnabled);
      sendWs({
        type: 'room:join',
        role: 'phone',
        code: cleanCode,
        phoneName: tel.model,
      });

      const stream = await startCameraCapture(settingsRef.current, cleanCode);
      if (stream) {
        await startWebRtcOffer(cleanCode, stream);
      }
    },
    [activeLensLabel, requestWakeLock, sendWs, startCameraCapture, startWebRtcOffer]
  );

  const disconnectFromPc = useCallback(() => {
    const code = activeRoomRef.current;
    if (code) {
      void updatePhoneRoomFields(code, { phoneOnline: false, phoneStreaming: false });
    }
    closePeerConnection();
    stopLocalMedia();
    releaseWakeLock();
    setScreenDimmed(false);
    setShowSettingsSheet(false);
    setActiveRoomCode(null);
    setStatus(discoveredPcs.length > 0 ? 'device-found' : 'searching');
  }, [closePeerConnection, discoveredPcs.length, releaseWakeLock, stopLocalMedia]);

  // Automatic Local Wi-Fi Discovery + Active Room WebSocket
  useEffect(() => {
    let active = true;
    let reconnectTimer: number | null = null;

    const connectWs = () => {
      if (!active) return;
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        ws.send(JSON.stringify({ type: 'discovery:subscribe' }));
        if (activeRoomRef.current) {
          const tel = createInitialPhoneTelemetry(activeLensLabel, settingsRef.current.audioEnabled);
          ws.send(
            JSON.stringify({
              type: 'room:join',
              role: 'phone',
              code: activeRoomRef.current,
              phoneName: tel.model,
            })
          );
        }
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
        if (type === 'discovery:pcs' && Array.isArray(msg.pcs)) {
          const list = msg.pcs as DiscoveredPc[];
          setDiscoveredPcs(list);
          if (!activeRoomRef.current) {
            setStatus(list.length > 0 ? 'device-found' : 'searching');
          }
        } else if (type === 'room:status') {
          if (typeof msg.pcName === 'string' && msg.pcName) {
            setConnectedPcName(msg.pcName);
          }
        } else if (type === 'rtc:answer' && typeof msg.sdp === 'string') {
          const pc = rtcPcRef.current;
          if (pc && pc.signalingState === 'have-local-offer') {
            void pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
          }
        } else if (type === 'rtc:ice-candidate' && msg.candidate) {
          const pc = rtcPcRef.current;
          if (pc && pc.remoteDescription) {
            void pc.addIceCandidate(msg.candidate as RTCIceCandidateInit).catch(() => {});
          }
        } else if (type === 'rtc:restart' && activeRoomRef.current) {
          void startWebRtcOffer(activeRoomRef.current);
        } else if (type === 'camera:settings' && msg.settings && msg.from === 'pc') {
          void applyRemoteOrLocalSettingsRef.current(
            msg.settings as Partial<CameraSettings>,
            true
          );
        } else if (type === 'camera:trigger-focus' && msg.focusPoint) {
          const pt = msg.focusPoint as { x: number; y: number };
          setFocusTap({ x: pt.x, y: pt.y, ts: Date.now() });
          const vt = streamRef.current?.getVideoTracks()[0];
          void triggerTapAutoFocus(vt, pt);
        }
      };

      ws.onclose = () => {
        if (!active) return;
        reconnectTimer = window.setTimeout(connectWs, 2000);
      };
    };

    connectWs();

    // HTTP discovery fallback poll (3s) when on discovery screen
    const poll = window.setInterval(async () => {
      if (activeRoomRef.current) return;
      try {
        const res = await fetch('/api/discover', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { pcs?: DiscoveredPc[] };
        if (Array.isArray(data.pcs)) {
          setDiscoveredPcs(data.pcs);
          setStatus(data.pcs.length > 0 ? 'device-found' : 'searching');
        }
      } catch {
        // Ignore transient network poll error
      }
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(poll);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        // Ignore
      }
    };
  }, [activeLensLabel, startWebRtcOffer]);

  // Auto-connect if launched via QR code URL (?code=XXXXXX)
  const autoJoinedInitialRef = useRef(false);
  useEffect(() => {
    if (initialRoomCode && !autoJoinedInitialRef.current) {
      autoJoinedInitialRef.current = true;
      void connectToPc(initialRoomCode, 'Windows PC');
    }
  }, [connectToPc, initialRoomCode]);

  // Firestore signaling subscription when connected to a room
  useEffect(() => {
    if (!activeRoomCode) return;
    const unsub = subscribeToRoom(activeRoomCode, (room) => {
      if (!room) return;
      if (room.pcName) setConnectedPcName(room.pcName);

      const pc = rtcPcRef.current;
      if (
        pc &&
        room.answerSdp &&
        room.answerForOfferId === currentOfferIdRef.current &&
        room.answerForOfferId !== processedAnswerOfferIdRef.current &&
        pc.signalingState === 'have-local-offer'
      ) {
        processedAnswerOfferIdRef.current = room.answerForOfferId;
        void pc.setRemoteDescription({ type: 'answer', sdp: room.answerSdp }).catch(() => {});
      }

      if (pc && Array.isArray(room.pcIceCandidates)) {
        for (const enc of room.pcIceCandidates) {
          if (processedPcIceRef.current.has(enc)) continue;
          processedPcIceRef.current.add(enc);
          const cand = decodeIceCandidate(enc);
          if (cand && pc.remoteDescription) {
            void pc.addIceCandidate(cand).catch(() => {});
          }
        }
      }

      if (room.restartNonce > lastRestartNonceRef.current) {
        lastRestartNonceRef.current = room.restartNonce;
        void startWebRtcOffer(activeRoomCode);
      }

      if (room.focusNonce > lastFocusNonceRef.current) {
        lastFocusNonceRef.current = room.focusNonce;
        const pt = { x: room.focusX, y: room.focusY };
        setFocusTap({ ...pt, ts: Date.now() });
        const vt = streamRef.current?.getVideoTracks()[0];
        void triggerTapAutoFocus(vt, pt);
      }
    });
    return () => unsub();
  }, [activeRoomCode, startWebRtcOffer]);

  // Automatic Wi-Fi Recovery on network reconnection
  useEffect(() => {
    const handleOnline = () => {
      if (activeRoomRef.current) {
        void startWebRtcOffer(activeRoomRef.current);
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [startWebRtcOffer]);

  // Outbound Stats + Dynamic Adaptive Bitrate Controller (every 2s)
  useEffect(() => {
    if (!activeRoomCode) return;
    const timer = window.setInterval(async () => {
      const pc = rtcPcRef.current;
      if (!pc || pc.connectionState !== 'connected') return;
      try {
        const { stats: nextStats, nextSnapshot } = await collectOutboundStats(
          pc,
          statsSnapshotRef.current
        );
        statsSnapshotRef.current = nextSnapshot;
        setStats(nextStats);

        // Adaptive bitrate: drop smoothly on congestion, restore on clear Wi-Fi
        const prevScale = bitrateScaleRef.current;
        let targetScale = prevScale;
        if (nextStats.packetLossPct > 3 || (nextStats.rttMs !== null && nextStats.rttMs > 140)) {
          targetScale = Math.max(0.45, prevScale - 0.15);
        } else if (nextStats.packetLossPct < 0.5 && (nextStats.rttMs === null || nextStats.rttMs < 55)) {
          targetScale = Math.min(1, prevScale + 0.1);
        }
        if (Math.abs(targetScale - prevScale) >= 0.08) {
          bitrateScaleRef.current = targetScale;
          const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
          void tuneVideoSender(videoSender, settingsRef.current, targetScale);
        }
      } catch {
        // Ignore transient stats error
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeRoomCode]);

  // Track discovery elapsed time for helpful Firewall / Wi-Fi guidance
  useEffect(() => {
    if (activeRoomCode || discoveredPcs.length > 0) {
      setSearchElapsedSec(0);
      return;
    }
    const timer = window.setInterval(() => setSearchElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeRoomCode, discoveredPcs.length]);

  // QR Code Scanner Camera Loop (Alternative Pairing Method)
  useEffect(() => {
    if (!showQrScanner) return;
    let active = true;
    let qrStream: MediaStream | null = null;
    let rafId = 0;

    const startScanner = async () => {
      try {
        qrStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!active) {
          qrStream.getTracks().forEach((t) => t.stop());
          return;
        }
        const vid = qrVideoRef.current;
        if (!vid) return;
        vid.srcObject = qrStream;
        await vid.play();

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        const tick = () => {
          if (!active || !vid || !ctx) return;
          if (vid.readyState >= 2 && vid.videoWidth > 0) {
            canvas.width = vid.videoWidth;
            canvas.height = vid.videoHeight;
            ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const decoded = jsQR(imgData.data, imgData.width, imgData.height);
            if (decoded?.data) {
              const raw = decoded.data.trim();
              const match = raw.match(/[?&](?:code|pair)=([A-Z0-9]{6})/i) || raw.match(/^([A-Z0-9]{6})$/i);
              if (match && match[1]) {
                setShowQrScanner(false);
                void connectToPc(match[1].toUpperCase(), 'Windows PC');
                return;
              }
            }
          }
          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);
      } catch {
        setErrorMessage('Unable to open camera for QR scanning.');
        setShowQrScanner(false);
      }
    };

    void startScanner();

    return () => {
      active = false;
      if (rafId) window.cancelAnimationFrame(rafId);
      if (qrStream) qrStream.getTracks().forEach((t) => t.stop());
    };
  }, [connectToPc, showQrScanner]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closePeerConnection();
      stopLocalMedia();
      releaseWakeLock();
    };
  }, [closePeerConnection, releaseWakeLock, stopLocalMedia]);

  // Tap-to-Focus & Pinch-to-Zoom handlers on live camera viewfinder
  const handleViewfinderTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (screenDimmed) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFocusTap({ x, y, ts: Date.now() });
    const vt = streamRef.current?.getVideoTracks()[0];
    void triggerTapAutoFocus(vt, { x, y });
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDistRef.current = Math.hypot(dx, dy);
      pinchStartZoomRef.current = capabilities.zoom ? settings.zoom : settings.digitalZoom;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartDistRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / pinchStartDistRef.current;
      const maxZ = capabilities.zoom ? Math.min(8, capabilities.zoom.max) : 4;
      const minZ = capabilities.zoom ? capabilities.zoom.min : 1;
      const nextZoom = Number(
        Math.min(maxZ, Math.max(minZ, pinchStartZoomRef.current * ratio)).toFixed(1)
      );
      void applyRemoteOrLocalSettings(
        capabilities.zoom ? { zoom: nextZoom } : { digitalZoom: nextZoom },
        false
      );
    }
  };

  const handleTouchEnd = () => {
    pinchStartDistRef.current = null;
  };

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

  // =========================================================================
  // VIEW 1: Automatic Wi-Fi Discovery & 1-Tap Connect Screen
  // =========================================================================
  if (!activeRoomCode) {
    return (
      <div className="flex min-h-[100dvh] flex-col bg-[#F8FAFC] text-[#0F172A]">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1D4ED8] text-white">
              <Camera className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-bold tracking-tight text-slate-900">LensLink</p>
              <p className="text-[11px] text-slate-500">Wireless Mobile Camera</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <MobilePWAInstallButton />
            <button
              type="button"
              onClick={onSwitchToDesktop}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600"
            >
              PC Mode
            </button>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 py-6">
          {/* Radar Discovery Header */}
          <div className="flex flex-col items-center rounded-2xl border border-slate-200 bg-white px-5 py-7 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <div className="relative mb-4 flex h-14 w-14 items-center justify-center">
              {status === 'searching' && (
                <span className="lenslink-radar-ring absolute inset-0 rounded-full border-2 border-[#2563EB]/40" />
              )}
              <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-[#EFF6FF] text-[#1D4ED8]">
                <Wifi className="h-5 w-5" />
              </div>
            </div>

            <p className="text-xs font-semibold tracking-wide text-[#1D4ED8] uppercase">
              {status === 'device-found' ? 'Device Found' : 'Searching'}
            </p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
              {discoveredPcs.length > 0
                ? 'Tap Your Windows PC to Connect'
                : 'Looking for Windows PCs on Wi-Fi'}
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Open LensLink on your Windows PC on the same Wi-Fi network. Connection starts in one tap — no IP address required.
            </p>
          </div>

          {/* Discovered Windows PCs List */}
          <div className="mt-5 space-y-2.5">
            {discoveredPcs.map((pc) => (
              <button
                key={pc.roomCode}
                type="button"
                onClick={() => void connectToPc(pc.roomCode, pc.pcName)}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition active:scale-[0.99] hover:border-[#1D4ED8]"
              >
                <div className="flex items-center gap-3.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#EFF6FF] text-[#1D4ED8]">
                    <Laptop className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{pc.pcName}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {pc.platform} · {pc.lanHint}
                    </p>
                  </div>
                </div>
                <span className="rounded-xl bg-[#1D4ED8] px-3.5 py-2 text-xs font-semibold text-white">
                  Connect
                </span>
              </button>
            ))}

            {/* Quick Reconnect to Previously Paired PC */}
            {discoveredPcs.length === 0 && rememberedPc && (
              <button
                type="button"
                onClick={() => void connectToPc(rememberedPc.roomCode, rememberedPc.pcName)}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-left transition hover:border-[#1D4ED8]"
              >
                <div>
                  <p className="text-[11px] font-medium text-slate-400">Previously Paired PC</p>
                  <p className="text-sm font-semibold text-slate-900">{rememberedPc.pcName}</p>
                </div>
                <span className="text-xs font-semibold text-[#1D4ED8]">Reconnect</span>
              </button>
            )}
          </div>

          {/* Alternative QR Pairing Button */}
          <div className="mt-5">
            <button
              type="button"
              onClick={() => setShowQrScanner(true)}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white py-3 text-xs font-semibold text-slate-700 shadow-2xs transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
            >
              <QrCode className="h-4 w-4 text-[#1D4ED8]" />
              Pair via QR Code Instead
            </button>
          </div>

          {/* Helpful Wi-Fi / Firewall Diagnostic if no PC appears */}
          {discoveredPcs.length === 0 && searchElapsedSec >= 6 && (
            <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4 text-xs leading-relaxed text-slate-600">
              <p className="font-semibold text-slate-800">Not seeing your Windows PC?</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4">
                <li>Verify both devices are on the same Wi-Fi network (not Guest isolation).</li>
                <li>Make sure LensLink Desktop is open on your Windows PC.</li>
                <li>If Windows Firewall blocks local discovery, tap <strong>Pair via QR Code Instead</strong>.</li>
              </ul>
            </div>
          )}

          {errorMessage && (
            <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
              {errorMessage}
            </p>
          )}
        </main>

        {/* QR Code Scanner Overlay */}
        {showQrScanner && (
          <div className="fixed inset-0 z-50 flex flex-col bg-black text-white">
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm font-semibold">Scan PC QR Code</span>
              <button
                type="button"
                onClick={() => setShowQrScanner(false)}
                className="rounded-lg bg-white/10 p-2 text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="relative flex-1 overflow-hidden">
              <video
                ref={qrVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-56 w-56 rounded-2xl border-2 border-[#3B82F6] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // VIEW 2: Full-Bleed Live Mobile Camera Viewfinder & Controls
  // =========================================================================
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black text-white select-none">
      {/* Full-Bleed Camera Preview */}
      <div
        onClick={handleViewfinderTap}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="relative h-full w-full"
      >
        <video
          ref={previewVideoRef}
          autoPlay
          playsInline
          muted
          style={{
            transform: `${settings.mirror ? 'scaleX(-1) ' : ''}${
              settings.digitalZoom > 1 ? `scale(${settings.digitalZoom.toFixed(2)})` : ''
            }`.trim() || undefined,
            filter: videoFilterCss,
          }}
          className="h-full w-full object-cover"
        />

        {/* Tap-to-Focus Reticle */}
        {focusTap && (
          <div
            key={focusTap.ts}
            style={{ left: `${focusTap.x * 100}%`, top: `${focusTap.y * 100}%` }}
            className="lenslink-focus-reticle pointer-events-none absolute h-16 w-16 rounded-xl border-2 border-[#3B82F6]"
          />
        )}
      </div>

      {/* Top Minimalist Telemetry HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/75 via-black/35 to-transparent px-4 pt-3 pb-8">
        <div className="pointer-events-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-400'
                  : status === 'connecting'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-red-400'
              }`}
            />
            <span className="text-xs font-semibold tracking-tight text-white">
              {status === 'connected'
                ? connectedPcName
                : status === 'connecting'
                  ? 'Connecting...'
                  : 'Disconnected'}
            </span>
          </div>

          <div className="flex items-center gap-3 font-mono text-[11px] text-white/90 tabular-nums">
            <span>
              {stats.width > 0 ? `${stats.height}p` : settings.resolution.toUpperCase()} ·{' '}
              {stats.fps > 0 ? stats.fps : settings.frameRate}fps
            </span>
            {status === 'connected' && <span>{bitrateDisplay}</span>}
            {stats.rttMs !== null && <span>{stats.rttMs}ms</span>}
            {batteryPct !== null && (
              <span className="inline-flex items-center gap-1">
                {batteryCharging ? (
                  <BatteryCharging className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Battery className="h-3.5 w-3.5 text-white/80" />
                )}
                {batteryPct}%
              </span>
            )}
          </div>
        </div>

        {/* Multi-Rear Lens Switcher (only when multiple rear lenses exist) */}
        {rearLenses.length > 1 && settings.facingMode === 'environment' && (
          <div className="pointer-events-auto mt-3 flex justify-center gap-1.5">
            {rearLenses.map((lens) => (
              <button
                key={lens.deviceId}
                type="button"
                onClick={() =>
                  void applyRemoteOrLocalSettings(
                    { facingMode: 'environment', deviceId: lens.deviceId },
                    false
                  )
                }
                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium backdrop-blur-md transition ${
                  settings.deviceId === lens.deviceId
                    ? 'bg-[#2563EB] text-white'
                    : 'bg-black/45 text-white/85'
                }`}
              >
                {lens.shortLabel}
              </button>
            ))}
          </div>
        )}

        {errorMessage && (
          <div className="pointer-events-auto mt-2.5 rounded-xl bg-red-600/90 px-3 py-2 text-xs text-white">
            {errorMessage}
          </div>
        )}
      </div>

      {/* Bottom Camera Controls Dock */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pt-8 pb-6">
        <div className="mx-auto flex max-w-md items-center justify-between gap-2">
          {/* Flip Camera */}
          <button
            type="button"
            onClick={() =>
              void applyRemoteOrLocalSettings(
                {
                  facingMode: settings.facingMode === 'environment' ? 'user' : 'environment',
                  deviceId: null,
                },
                false
              )
            }
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 text-white backdrop-blur-md active:scale-95"
            aria-label="Switch Front or Rear Camera"
          >
            <SwitchCamera className="h-5 w-5" />
          </button>

          {/* Flashlight */}
          <button
            type="button"
            disabled={capabilities.torch === false}
            onClick={() =>
              void applyRemoteOrLocalSettings({ torch: !settings.torch }, false)
            }
            className={`flex h-11 w-11 items-center justify-center rounded-xl backdrop-blur-md active:scale-95 disabled:opacity-35 ${
              settings.torch ? 'bg-[#2563EB] text-white' : 'bg-white/15 text-white'
            }`}
            aria-label="Toggle Flashlight"
          >
            <Zap className="h-5 w-5" />
          </button>

          {/* Microphone Toggle */}
          <button
            type="button"
            onClick={() =>
              void applyRemoteOrLocalSettings({ audioEnabled: !settings.audioEnabled }, false)
            }
            className={`flex h-11 w-11 items-center justify-center rounded-xl backdrop-blur-md active:scale-95 ${
              settings.audioEnabled ? 'bg-[#2563EB] text-white' : 'bg-white/15 text-white'
            }`}
            aria-label="Toggle Microphone Audio"
          >
            {settings.audioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </button>

          {/* Screen Dimming Mode (Battery Saver) */}
          <button
            type="button"
            onClick={() => setScreenDimmed(true)}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 text-white backdrop-blur-md active:scale-95"
            aria-label="Dim Screen to Save Battery"
          >
            <Moon className="h-5 w-5" />
          </button>

          {/* Camera Settings Drawer */}
          <button
            type="button"
            onClick={() => setShowSettingsSheet(true)}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 text-white backdrop-blur-md active:scale-95"
            aria-label="Camera Settings"
          >
            <SlidersHorizontal className="h-5 w-5" />
          </button>

          {/* Reconnect or Disconnect */}
          {status === 'disconnected' ? (
            <button
              type="button"
              onClick={() => activeRoomCode && void startWebRtcOffer(activeRoomCode)}
              className="flex h-11 items-center gap-1.5 rounded-xl bg-[#2563EB] px-3.5 text-xs font-semibold text-white active:scale-95"
            >
              <RefreshCw className="h-4 w-4" />
              Retry
            </button>
          ) : (
            <button
              type="button"
              onClick={disconnectFromPc}
              className="flex h-11 w-11 items-center justify-center rounded-xl bg-red-600/90 text-white active:scale-95"
              aria-label="Disconnect"
            >
              <Power className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* Camera Settings Bottom Sheet */}
      {showSettingsSheet && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/55 backdrop-blur-xs">
          <div className="max-h-[82dvh] w-full overflow-y-auto rounded-t-3xl bg-[#0F172A] px-5 pt-4 pb-8 text-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h2 className="text-sm font-semibold">Camera Settings</h2>
              <button
                type="button"
                onClick={() => setShowSettingsSheet(false)}
                className="rounded-lg bg-white/10 p-1.5 text-white/80"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-5">
              {/* Resolution */}
              <div className="space-y-1.5">
                <p className="text-xs text-slate-400">Resolution</p>
                <div className="grid grid-cols-4 gap-2">
                  {(['480p', '720p', '1080p', '4k'] as ResolutionPreset[]).map((res) => (
                    <button
                      key={res}
                      type="button"
                      onClick={() => void applyRemoteOrLocalSettings({ resolution: res }, false)}
                      className={`rounded-xl py-2 font-mono text-xs font-medium ${
                        settings.resolution === res
                          ? 'bg-[#2563EB] text-white'
                          : 'bg-white/10 text-slate-200'
                      }`}
                    >
                      {res === '4k' ? '4K' : res}
                    </button>
                  ))}
                </div>
              </div>

              {/* Frame Rate */}
              <div className="space-y-1.5">
                <p className="text-xs text-slate-400">Frame Rate</p>
                <div className="grid grid-cols-3 gap-2">
                  {([24, 30, 60] as FrameRatePreset[]).map((fps) => (
                    <button
                      key={fps}
                      type="button"
                      onClick={() => void applyRemoteOrLocalSettings({ frameRate: fps }, false)}
                      className={`rounded-xl py-2 font-mono text-xs font-medium tabular-nums ${
                        settings.frameRate === fps
                          ? 'bg-[#2563EB] text-white'
                          : 'bg-white/10 text-slate-200'
                      }`}
                    >
                      {fps} FPS
                    </button>
                  ))}
                </div>
              </div>

              {/* Zoom */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Zoom</span>
                  <span className="font-mono tabular-nums">
                    {(capabilities.zoom ? settings.zoom : settings.digitalZoom).toFixed(1)}×
                  </span>
                </div>
                <input
                  type="range"
                  className="lenslink-slider-dark"
                  min={capabilities.zoom ? capabilities.zoom.min : 1}
                  max={capabilities.zoom ? Math.min(8, capabilities.zoom.max) : 4}
                  step={0.1}
                  value={capabilities.zoom ? settings.zoom : settings.digitalZoom}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    void applyRemoteOrLocalSettings(
                      capabilities.zoom ? { zoom: val } : { digitalZoom: val },
                      false
                    );
                  }}
                />
              </div>

              {/* Focus */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Focus</span>
                  <div className="flex gap-1.5">
                    {(['continuous', 'manual'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => void applyRemoteOrLocalSettings({ focusMode: m }, false)}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                          settings.focusMode === m
                            ? 'bg-[#2563EB] text-white'
                            : 'bg-white/10 text-slate-300'
                        }`}
                      >
                        {m === 'continuous' ? 'Auto' : 'Manual'}
                      </button>
                    ))}
                  </div>
                </div>
                {settings.focusMode === 'manual' && (
                  <input
                    type="range"
                    className="lenslink-slider-dark"
                    min={0}
                    max={1}
                    step={0.02}
                    value={settings.focusDistance}
                    onChange={(e) =>
                      void applyRemoteOrLocalSettings(
                        { focusDistance: Number(e.target.value) },
                        false
                      )
                    }
                  />
                )}
              </div>

              {/* Exposure EV, ISO & Brightness */}
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Exposure</span>
                    <span className="font-mono tabular-nums">
                      {settings.exposureCompensation >= 0 ? '+' : ''}
                      {settings.exposureCompensation.toFixed(1)} EV
                    </span>
                  </div>
                  <input
                    type="range"
                    className="lenslink-slider-dark"
                    min={capabilities.exposureCompensation?.min ?? -2}
                    max={capabilities.exposureCompensation?.max ?? 2}
                    step={capabilities.exposureCompensation?.step ?? 0.25}
                    value={settings.exposureCompensation}
                    onChange={(e) =>
                      void applyRemoteOrLocalSettings(
                        { exposureCompensation: Number(e.target.value) },
                        false
                      )
                    }
                  />
                </div>

                {capabilities.iso && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-400">ISO</span>
                      <span className="font-mono tabular-nums">{Math.round(settings.iso)}</span>
                    </div>
                    <input
                      type="range"
                      className="lenslink-slider-dark"
                      min={capabilities.iso.min}
                      max={capabilities.iso.max}
                      step={capabilities.iso.step}
                      value={settings.iso}
                      onChange={(e) =>
                        void applyRemoteOrLocalSettings({ iso: Number(e.target.value) }, false)
                      }
                    />
                  </div>
                )}

                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Brightness</span>
                    <span className="font-mono tabular-nums">{settings.brightness}</span>
                  </div>
                  <input
                    type="range"
                    className="lenslink-slider-dark"
                    min={-40}
                    max={40}
                    step={2}
                    value={settings.brightness}
                    onChange={(e) =>
                      void applyRemoteOrLocalSettings({ brightness: Number(e.target.value) }, false)
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">White Balance</span>
                    <div className="flex gap-1.5">
                      {(['continuous', 'manual'] as const).map((wb) => (
                        <button
                          key={wb}
                          type="button"
                          onClick={() =>
                            void applyRemoteOrLocalSettings({ whiteBalanceMode: wb }, false)
                          }
                          className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
                            settings.whiteBalanceMode === wb
                              ? 'bg-[#2563EB] text-white'
                              : 'bg-white/10 text-slate-300'
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
                      className="lenslink-slider-dark"
                      min={capabilities.colorTemperature?.min ?? 2800}
                      max={capabilities.colorTemperature?.max ?? 7500}
                      step={100}
                      value={settings.colorTemperature}
                      onChange={(e) =>
                        void applyRemoteOrLocalSettings(
                          { colorTemperature: Number(e.target.value) },
                          false
                        )
                      }
                    />
                  )}
                </div>
              </div>

              {/* Orientation & Mirror */}
              <div className="grid grid-cols-4 gap-2">
                {(['auto', 'landscape', 'portrait'] as OrientationMode[]).map((ori) => (
                  <button
                    key={ori}
                    type="button"
                    onClick={() => void applyRemoteOrLocalSettings({ orientation: ori }, false)}
                    className={`inline-flex items-center justify-center gap-1 rounded-xl py-2 text-[11px] font-medium capitalize ${
                      settings.orientation === ori
                        ? 'bg-[#2563EB] text-white'
                        : 'bg-white/10 text-slate-200'
                    }`}
                  >
                    <RotateCw className="h-3 w-3" />
                    {ori}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    void applyRemoteOrLocalSettings({ mirror: !settings.mirror }, false)
                  }
                  className={`inline-flex items-center justify-center gap-1 rounded-xl py-2 text-[11px] font-medium ${
                    settings.mirror ? 'bg-[#2563EB] text-white' : 'bg-white/10 text-slate-200'
                  }`}
                >
                  <FlipHorizontal2 className="h-3.5 w-3.5" />
                  Mirror
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Battery-Saving Screen Dimming Mode Overlay (Camera & Audio Continue Uninterrupted) */}
      {screenDimmed && (
        <button
          type="button"
          onClick={() => setScreenDimmed(false)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/97 px-6 text-center text-white/40"
        >
          <Moon className="mb-3 h-7 w-7 text-[#2563EB]/70" />
          <p className="text-sm font-medium text-white/60">
            LensLink Streaming Active · {connectedPcName}
          </p>
          <p className="mt-1 font-mono text-xs tabular-nums">
            {stats.width > 0 ? `${stats.width}×${stats.height}` : settings.resolution.toUpperCase()} ·{' '}
            {stats.fps > 0 ? `${stats.fps} fps` : `${settings.frameRate} fps`}
            {batteryPct !== null ? ` · ${batteryPct}%` : ''}
          </p>
          <p className="mt-6 text-xs text-white/35">Tap anywhere to brighten screen</p>
        </button>
      )}
    </div>
  );
};
