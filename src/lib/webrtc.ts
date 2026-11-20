import {
  CameraCapabilities,
  CameraDeviceSummary,
  CameraSettings,
  PhoneTelemetry,
  RESOLUTION_SPECS,
  SignalQuality,
  StreamStats,
} from '../types/lenslink';

export function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function isLocalLanHostname(hostname: string = window.location.hostname): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  ) {
    return true;
  }
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(hostname)) return true;
  return false;
}

export function getRtcConfiguration(localOnly: boolean): RTCConfiguration {
  if (localOnly) {
    return {
      iceServers: [],
      iceCandidatePoolSize: 4,
    };
  }
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    iceCandidatePoolSize: 6,
  };
}

export function buildMediaConstraints(settings: CameraSettings): MediaStreamConstraints {
  const spec = RESOLUTION_SPECS[settings.resolution] || RESOLUTION_SPECS['1080p'];
  const isPortrait = settings.orientation === 'portrait';
  const idealWidth = isPortrait ? spec.height : spec.width;
  const idealHeight = isPortrait ? spec.width : spec.height;

  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: idealWidth },
    height: { ideal: idealHeight },
    frameRate: { ideal: settings.frameRate, max: 60 },
  };

  if (settings.deviceId) {
    videoConstraints.deviceId = { ideal: settings.deviceId };
  } else {
    videoConstraints.facingMode = { ideal: settings.facingMode };
  }

  return {
    audio: settings.audioEnabled
      ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      : false,
    video: videoConstraints,
  };
}

export async function getCameraStreamSafe(
  settings: CameraSettings
): Promise<MediaStream> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      'Camera API unavailable. Open LensLink over HTTPS or localhost on a modern smartphone browser.'
    );
  }

  const acquire = async () => {
    try {
      return await navigator.mediaDevices.getUserMedia(buildMediaConstraints(settings));
    } catch (err) {
      // Fallback 1: retry video-only if mic permission failed or resolution was rejected
      const fallbackConstraints: MediaStreamConstraints = {
        audio: false,
        video: settings.deviceId
          ? { deviceId: { ideal: settings.deviceId } }
          : { facingMode: { ideal: settings.facingMode } },
      };
      try {
        return await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      } catch {
        throw err;
      }
    }
  };

  try {
    return await acquire();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      return await acquire();
    }
    throw err;
  }
}

export async function acquireMicrophoneTrack(): Promise<MediaStreamTrack | null> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return audioStream.getAudioTracks()[0] || null;
  } catch {
    return null;
  }
}

function classifyCameraDevice(rawLabel: string, index: number): Omit<CameraDeviceSummary, 'deviceId'> {
  const label = rawLabel || `Camera ${index + 1}`;
  const lower = label.toLowerCase();

  const isFront =
    lower.includes('front') ||
    lower.includes('facing front') ||
    lower.includes('facetime') ||
    lower.includes('selfie') ||
    lower.includes('user');
  const isBack =
    lower.includes('back') ||
    lower.includes('rear') ||
    lower.includes('environment') ||
    lower.includes('facing back');

  const facing: 'back' | 'front' | 'unknown' = isFront
    ? 'front'
    : isBack
      ? 'back'
      : 'unknown';

  let shortLabel = label;
  if (lower.includes('ultra') && lower.includes('wide')) {
    shortLabel = isBack ? 'Rear Ultra-Wide' : 'Ultra-Wide';
  } else if (lower.includes('macro')) {
    shortLabel = 'Rear Macro';
  } else if (lower.includes('telephoto') || lower.includes('tele')) {
    shortLabel = 'Rear Telephoto';
  } else if (lower.includes('triple')) {
    shortLabel = 'Rear Triple';
  } else if (lower.includes('dual wide')) {
    shortLabel = 'Rear Dual Wide';
  } else if (lower.includes('dual')) {
    shortLabel = 'Rear Dual';
  } else if (isBack && lower.includes('wide')) {
    shortLabel = 'Rear Main';
  } else if (isBack) {
    const camNumMatch = lower.match(/camera2?\s*(\d+)/i);
    if (camNumMatch) {
      const idx = Number(camNumMatch[1]);
      shortLabel = idx === 0 ? 'Rear Main' : `Rear Lens ${idx}`;
    } else {
      shortLabel = `Rear ${index + 1}`;
    }
  } else if (isFront) {
    shortLabel = 'Front';
  } else if (label.length > 18) {
    shortLabel = `Lens ${index + 1}`;
  }

  return { label, shortLabel, facing };
}

function isRangeCap(val: unknown): val is { min: number; max: number; step?: number } {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as { min?: unknown }).min === 'number' &&
    typeof (val as { max?: unknown }).max === 'number'
  );
}

export async function extractCameraCapabilities(
  track: MediaStreamTrack
): Promise<CameraCapabilities> {
  let devices: CameraDeviceSummary[] = [];
  try {
    const rawDevices = await navigator.mediaDevices.enumerateDevices();
    const seen = new Set<string>();
    devices = rawDevices
      .filter((d) => d.kind === 'videoinput' && d.deviceId)
      .filter((d) => {
        if (seen.has(d.deviceId)) return false;
        seen.add(d.deviceId);
        return true;
      })
      .map((d, index) => ({
        deviceId: d.deviceId,
        ...classifyCameraDevice(d.label, index),
      }));
  } catch {
    devices = [];
  }

  const capabilities: CameraCapabilities = { devices };

  if (typeof track.getCapabilities === 'function') {
    const raw = track.getCapabilities() as Record<string, unknown>;

    if (isRangeCap(raw.zoom)) {
      capabilities.zoom = {
        min: raw.zoom.min,
        max: raw.zoom.max,
        step: raw.zoom.step || 0.1,
      };
    }

    if (isRangeCap(raw.exposureCompensation)) {
      capabilities.exposureCompensation = {
        min: raw.exposureCompensation.min,
        max: raw.exposureCompensation.max,
        step: raw.exposureCompensation.step || 0.25,
      };
    }

    if (isRangeCap(raw.iso)) {
      capabilities.iso = {
        min: raw.iso.min,
        max: raw.iso.max,
        step: raw.iso.step || 50,
      };
    }

    if (isRangeCap(raw.brightness)) {
      capabilities.brightness = {
        min: raw.brightness.min,
        max: raw.brightness.max,
        step: raw.brightness.step || 1,
      };
    }

    if (isRangeCap(raw.contrast)) {
      capabilities.contrast = {
        min: raw.contrast.min,
        max: raw.contrast.max,
        step: raw.contrast.step || 1,
      };
    }

    if (isRangeCap(raw.colorTemperature)) {
      capabilities.colorTemperature = {
        min: raw.colorTemperature.min,
        max: raw.colorTemperature.max,
        step: raw.colorTemperature.step || 100,
      };
    }

    if (Array.isArray(raw.whiteBalanceMode)) {
      capabilities.whiteBalanceModes = raw.whiteBalanceMode.filter(
        (m): m is string => typeof m === 'string'
      );
    }

    if (isRangeCap(raw.focusDistance)) {
      capabilities.focusDistance = {
        min: raw.focusDistance.min,
        max: raw.focusDistance.max,
        step: raw.focusDistance.step || 0.02,
      };
    }

    if (Array.isArray(raw.focusMode)) {
      capabilities.focusModes = raw.focusMode.filter((m): m is string => typeof m === 'string');
    }

    if (typeof raw.torch === 'boolean') {
      capabilities.torch = raw.torch;
    }

    if (isRangeCap(raw.width)) {
      capabilities.maxWidth = raw.width.max;
    }
    if (isRangeCap(raw.height)) {
      capabilities.maxHeight = raw.height.max;
    }
    if (isRangeCap(raw.frameRate)) {
      capabilities.maxFrameRate = raw.frameRate.max;
    }
  }

  return capabilities;
}

function mapNormalizedToRange(
  normalizedPercent: number,
  minVal: number,
  maxVal: number,
  range: { min: number; max: number }
): number {
  const t = (normalizedPercent - minVal) / (maxVal - minVal);
  const clampedT = Math.min(1, Math.max(0, t));
  return range.min + (range.max - range.min) * clampedT;
}

export async function applyHardwareConstraints(
  track: MediaStreamTrack | null | undefined,
  patch: Partial<CameraSettings>
): Promise<void> {
  if (!track || track.readyState !== 'live' || typeof track.applyConstraints !== 'function') {
    return;
  }

  const caps =
    typeof track.getCapabilities === 'function'
      ? (track.getCapabilities() as Record<string, unknown>)
      : {};

  const advanced: Record<string, unknown> = {};

  if (typeof patch.zoom === 'number' && isRangeCap(caps.zoom)) {
    advanced.zoom = Math.min(caps.zoom.max, Math.max(caps.zoom.min, patch.zoom));
  }

  if (patch.focusMode && Array.isArray(caps.focusMode)) {
    if (patch.focusMode === 'manual' && caps.focusMode.includes('manual')) {
      advanced.focusMode = 'manual';
    } else if (patch.focusMode === 'continuous' && caps.focusMode.includes('continuous')) {
      advanced.focusMode = 'continuous';
    }
  }

  if (typeof patch.focusDistance === 'number' && isRangeCap(caps.focusDistance)) {
    const mapped =
      caps.focusDistance.min +
      (caps.focusDistance.max - caps.focusDistance.min) *
        Math.min(1, Math.max(0, patch.focusDistance));
    advanced.focusDistance = mapped;
  }

  if (typeof patch.exposureCompensation === 'number' && isRangeCap(caps.exposureCompensation)) {
    advanced.exposureCompensation = Math.min(
      caps.exposureCompensation.max,
      Math.max(caps.exposureCompensation.min, patch.exposureCompensation)
    );
  }

  if (typeof patch.iso === 'number' && isRangeCap(caps.iso)) {
    advanced.iso = Math.min(caps.iso.max, Math.max(caps.iso.min, patch.iso));
  }

  if (typeof patch.brightness === 'number' && isRangeCap(caps.brightness)) {
    advanced.brightness = mapNormalizedToRange(patch.brightness, -50, 50, caps.brightness);
  }

  if (typeof patch.contrast === 'number' && isRangeCap(caps.contrast)) {
    advanced.contrast = mapNormalizedToRange(patch.contrast, -50, 100, caps.contrast);
  }

  if (patch.whiteBalanceMode && Array.isArray(caps.whiteBalanceMode)) {
    if (caps.whiteBalanceMode.includes(patch.whiteBalanceMode)) {
      advanced.whiteBalanceMode = patch.whiteBalanceMode;
    }
  }

  if (typeof patch.colorTemperature === 'number' && isRangeCap(caps.colorTemperature)) {
    advanced.colorTemperature = Math.min(
      caps.colorTemperature.max,
      Math.max(caps.colorTemperature.min, patch.colorTemperature)
    );
  }

  if (typeof patch.torch === 'boolean' && caps.torch === true) {
    advanced.torch = patch.torch;
  }

  if (Object.keys(advanced).length > 0) {
    try {
      await track.applyConstraints({
        advanced: [advanced as MediaTrackConstraintSet],
      });
    } catch {
      // Some mobile browsers reject combined advanced constraints
    }
  }
}

export async function triggerTapAutoFocus(
  track: MediaStreamTrack | null | undefined,
  point?: { x: number; y: number }
): Promise<boolean> {
  if (!track || track.readyState !== 'live' || typeof track.applyConstraints !== 'function') {
    return false;
  }

  const caps =
    typeof track.getCapabilities === 'function'
      ? (track.getCapabilities() as Record<string, unknown>)
      : {};
  const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : [];

  try {
    const advancedEntry: Record<string, unknown> = {};
    if (point) {
      advancedEntry.pointsOfInterest = [{ x: point.x, y: point.y }];
    }

    if (focusModes.includes('single-shot')) {
      await track.applyConstraints({
        advanced: [{ ...advancedEntry, focusMode: 'single-shot' } as MediaTrackConstraintSet],
      });
      if (focusModes.includes('continuous')) {
        window.setTimeout(() => {
          void track
            .applyConstraints({
              advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
            })
            .catch(() => {});
        }, 450);
      }
      return true;
    }

    if (focusModes.includes('continuous')) {
      await track.applyConstraints({
        advanced: [{ ...advancedEntry, focusMode: 'continuous' } as MediaTrackConstraintSet],
      });
      return true;
    }
  } catch {
    if (focusModes.includes('continuous')) {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
        });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function buildVideoFilterCss(
  settings: CameraSettings,
  hardwareBrightnessActive: boolean,
  hardwareContrastActive: boolean
): string | undefined {
  const filters: string[] = [];

  if (!hardwareBrightnessActive && settings.brightness !== 0) {
    const b = Math.max(0.4, 1 + settings.brightness / 100);
    filters.push(`brightness(${b.toFixed(2)})`);
  }

  if (!hardwareContrastActive && settings.contrast !== 0) {
    const c = Math.max(0.4, 1 + settings.contrast / 100);
    filters.push(`contrast(${c.toFixed(2)})`);
  }

  return filters.length > 0 ? filters.join(' ') : undefined;
}

export function preferHardwareVideoCodec(pc: RTCPeerConnection): void {
  try {
    if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
      return;
    }
    const caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return;

    const h264: RTCRtpCodec[] = [];
    const vp8: RTCRtpCodec[] = [];
    const rest: RTCRtpCodec[] = [];

    for (const codec of caps.codecs) {
      const mime = (codec.mimeType || '').toLowerCase();
      if (mime === 'video/h264') {
        h264.push(codec);
      } else if (mime === 'video/vp8') {
        vp8.push(codec);
      } else {
        rest.push(codec);
      }
    }

    const ordered = [...h264, ...vp8, ...rest];
    for (const transceiver of pc.getTransceivers()) {
      const kind =
        transceiver.sender?.track?.kind || transceiver.receiver?.track?.kind;
      if (kind === 'video' && typeof transceiver.setCodecPreferences === 'function') {
        transceiver.setCodecPreferences(ordered);
      }
    }
  } catch {
    // Codec preference selection is optional per browser
  }
}

export function applyLowLatencyReceiver(pc: RTCPeerConnection): void {
  try {
    for (const receiver of pc.getReceivers()) {
      if (receiver.track?.kind !== 'video') continue;
      const ext = receiver as RTCRtpReceiver & {
        playoutDelayHint?: number;
        jitterBufferTarget?: number;
      };
      if ('playoutDelayHint' in ext) {
        ext.playoutDelayHint = 0;
      }
      if ('jitterBufferTarget' in ext) {
        ext.jitterBufferTarget = 0;
      }
    }
  } catch {
    // Low-latency receiver hints are optional per browser
  }
}

export async function tuneVideoSender(
  sender: RTCRtpSender | undefined,
  settings: CameraSettings,
  bitrateScale: number = 1
): Promise<void> {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    if (sender.track && 'contentHint' in sender.track) {
      sender.track.contentHint = 'motion';
    }
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const spec = RESOLUTION_SPECS[settings.resolution] || RESOLUTION_SPECS['1080p'];
    const clampedScale = Math.min(1, Math.max(0.4, bitrateScale));
    params.encodings[0].maxBitrate = Math.round(spec.targetBitrateBps * clampedScale);
    params.encodings[0].maxFramerate = settings.frameRate;
    params.encodings[0].scaleResolutionDownBy = 1;
    const extEncoding = params.encodings[0] as RTCRtpEncodingParameters & {
      networkPriority?: 'very-low' | 'low' | 'medium' | 'high';
    };
    extEncoding.networkPriority = 'high';
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch {
    // Ignore on browsers that don't allow dynamic sender parameters
  }
}

export function computeSignalQuality(rttMs: number | null, packetLossPct: number): SignalQuality {
  if (packetLossPct > 6 || (rttMs !== null && rttMs > 180)) return 'Weak';
  if (packetLossPct > 2.5 || (rttMs !== null && rttMs > 90)) return 'Fair';
  if (packetLossPct > 0.8 || (rttMs !== null && rttMs > 40)) return 'Good';
  return 'Excellent';
}

export interface StatsSnapshot {
  bytes: number;
  timestamp: number;
  packetsLost: number;
  packetsTotal: number;
}

export async function collectInboundStats(
  pc: RTCPeerConnection,
  prevSnapshot: StatsSnapshot | null
): Promise<{ stats: StreamStats; nextSnapshot: StatsSnapshot | null }> {
  const report = await pc.getStats();
  let width = 0;
  let height = 0;
  let fps = 0;
  let bytesReceived = 0;
  let packetsLost = 0;
  let packetsReceived = 0;
  let timestamp = 0;
  let rttMs: number | null = null;

  report.forEach((entry) => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
      width = entry.frameWidth || width;
      height = entry.frameHeight || height;
      fps = typeof entry.framesPerSecond === 'number' ? Math.round(entry.framesPerSecond) : fps;
      bytesReceived = entry.bytesReceived || 0;
      packetsLost = entry.packetsLost || 0;
      packetsReceived = entry.packetsReceived || 0;
      timestamp = entry.timestamp || 0;
    }
    if (
      entry.type === 'candidate-pair' &&
      entry.state === 'succeeded' &&
      typeof entry.currentRoundTripTime === 'number'
    ) {
      rttMs = Math.round(entry.currentRoundTripTime * 1000);
    }
  });

  let bitrateKbps = 0;
  let packetLossPct = 0;
  const packetsTotal = packetsReceived + packetsLost;

  if (prevSnapshot && timestamp > prevSnapshot.timestamp && bytesReceived >= prevSnapshot.bytes) {
    const dtSec = (timestamp - prevSnapshot.timestamp) / 1000;
    if (dtSec > 0) {
      bitrateKbps = Math.round(((bytesReceived - prevSnapshot.bytes) * 8) / dtSec / 1000);
    }
    const deltaTotal = packetsTotal - prevSnapshot.packetsTotal;
    const deltaLost = Math.max(0, packetsLost - prevSnapshot.packetsLost);
    if (deltaTotal > 0) {
      packetLossPct = Number(((deltaLost / deltaTotal) * 100).toFixed(1));
    }
  }

  return {
    stats: {
      width,
      height,
      fps,
      bitrateKbps,
      rttMs,
      packetLossPct,
      signalQuality: computeSignalQuality(rttMs, packetLossPct),
    },
    nextSnapshot: timestamp
      ? { bytes: bytesReceived, timestamp, packetsLost, packetsTotal }
      : prevSnapshot,
  };
}

export async function collectOutboundStats(
  pc: RTCPeerConnection,
  prevSnapshot: StatsSnapshot | null
): Promise<{ stats: StreamStats; nextSnapshot: StatsSnapshot | null }> {
  const report = await pc.getStats();
  let width = 0;
  let height = 0;
  let fps = 0;
  let bytesSent = 0;
  let packetsSent = 0;
  let timestamp = 0;
  let rttMs: number | null = null;
  let packetsLost = 0;

  report.forEach((entry) => {
    if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
      width = entry.frameWidth || width;
      height = entry.frameHeight || height;
      fps = typeof entry.framesPerSecond === 'number' ? Math.round(entry.framesPerSecond) : fps;
      bytesSent = entry.bytesSent || 0;
      packetsSent = entry.packetsSent || 0;
      timestamp = entry.timestamp || 0;
    }
    if (entry.type === 'remote-inbound-rtp' && entry.kind === 'video') {
      if (typeof entry.packetsLost === 'number') {
        packetsLost = entry.packetsLost;
      }
      if (typeof entry.roundTripTime === 'number') {
        rttMs = Math.round(entry.roundTripTime * 1000);
      }
    }
    if (
      entry.type === 'candidate-pair' &&
      entry.state === 'succeeded' &&
      typeof entry.currentRoundTripTime === 'number' &&
      rttMs === null
    ) {
      rttMs = Math.round(entry.currentRoundTripTime * 1000);
    }
  });

  let bitrateKbps = 0;
  let packetLossPct = 0;
  if (prevSnapshot && timestamp > prevSnapshot.timestamp && bytesSent >= prevSnapshot.bytes) {
    const dtSec = (timestamp - prevSnapshot.timestamp) / 1000;
    if (dtSec > 0) {
      bitrateKbps = Math.round(((bytesSent - prevSnapshot.bytes) * 8) / dtSec / 1000);
    }
    const deltaSent = packetsSent - prevSnapshot.packetsTotal;
    const deltaLost = Math.max(0, packetsLost - prevSnapshot.packetsLost);
    if (deltaSent > 0) {
      packetLossPct = Number(((deltaLost / deltaSent) * 100).toFixed(1));
    }
  }

  return {
    stats: {
      width,
      height,
      fps,
      bitrateKbps,
      rttMs,
      packetLossPct,
      signalQuality: computeSignalQuality(rttMs, packetLossPct),
    },
    nextSnapshot: timestamp
      ? { bytes: bytesSent, timestamp, packetsLost, packetsTotal: packetsSent }
      : prevSnapshot,
  };
}

export function detectSmartphoneModel(): string {
  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'Apple iPhone';
  if (/iPad/i.test(ua)) return 'Apple iPad';
  const androidMatch = ua.match(/Android\s[\d.]+;\s([^;)]+)/i);
  if (androidMatch && androidMatch[1]) {
    return androidMatch[1].replace(/\s*Build\/.*$/i, '').trim().slice(0, 32);
  }
  if (/Android/i.test(ua)) return 'Android Smartphone';
  return 'Mobile Camera';
}

export async function readBatteryTelemetry(): Promise<{
  batteryPct: number | null;
  charging: boolean | null;
}> {
  try {
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{ level: number; charging: boolean }>;
    };
    if (typeof nav.getBattery === 'function') {
      const bat = await nav.getBattery();
      return {
        batteryPct: Math.round(bat.level * 100),
        charging: Boolean(bat.charging),
      };
    }
  } catch {
    // Battery API unavailable (e.g. iOS Safari)
  }
  return { batteryPct: null, charging: null };
}

export function createInitialPhoneTelemetry(lensLabel: string, audioActive: boolean): PhoneTelemetry {
  const model = detectSmartphoneModel();
  return {
    deviceName: model,
    model,
    lensLabel,
    batteryPct: null,
    charging: null,
    thermalState: null,
    audioActive,
  };
}
