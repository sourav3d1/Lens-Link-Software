import {
  CameraCapabilities,
  CameraDeviceSummary,
  CameraSettings,
  RESOLUTION_DIMENSIONS,
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
    ],
    iceCandidatePoolSize: 4,
  };
}

export function buildMediaConstraints(settings: CameraSettings): MediaStreamConstraints {
  const dims = RESOLUTION_DIMENSIONS[settings.resolution] || RESOLUTION_DIMENSIONS['720p'];
  const videoConstraints: MediaTrackConstraints = {
    width: { ideal: dims.width },
    height: { ideal: dims.height },
    frameRate: { ideal: settings.frameRate, max: 60 },
  };

  if (settings.deviceId) {
    videoConstraints.deviceId = { ideal: settings.deviceId };
  } else {
    videoConstraints.facingMode = { ideal: settings.facingMode };
  }

  return {
    audio: false,
    video: videoConstraints,
  };
}

export async function getCameraStreamSafe(
  settings: CameraSettings
): Promise<MediaStream> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      'Camera API unavailable. Open LensLink over HTTPS or localhost on a modern mobile browser.'
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia(buildMediaConstraints(settings));
  } catch (err) {
    // Fallback for strict iOS/Android devices rejecting resolution/framerate combinations
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
}

export async function extractCameraCapabilities(
  track: MediaStreamTrack
): Promise<CameraCapabilities> {
  let devices: CameraDeviceSummary[] = [];
  try {
    const rawDevices = await navigator.mediaDevices.enumerateDevices();
    devices = rawDevices
      .filter((d) => d.kind === 'videoinput')
      .map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${index + 1}`,
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

    if (isRangeCap(raw.focusDistance)) {
      capabilities.focusDistance = {
        min: raw.focusDistance.min,
        max: raw.focusDistance.max,
        step: raw.focusDistance.step || 0.05,
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

function isRangeCap(val: unknown): val is { min: number; max: number; step?: number } {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as { min?: unknown }).min === 'number' &&
    typeof (val as { max?: unknown }).max === 'number'
  );
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
      (caps.focusDistance.max - caps.focusDistance.min) * Math.min(1, Math.max(0, patch.focusDistance));
    advanced.focusDistance = mapped;
  }

  if (typeof patch.exposureCompensation === 'number' && isRangeCap(caps.exposureCompensation)) {
    advanced.exposureCompensation = Math.min(
      caps.exposureCompensation.max,
      Math.max(caps.exposureCompensation.min, patch.exposureCompensation)
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
      // Some mobile browsers throw if an advanced constraint isn't allowed with current mode
    }
  }
}

export async function tuneVideoSender(
  sender: RTCRtpSender | undefined,
  settings: CameraSettings
): Promise<void> {
  if (!sender || typeof sender.getParameters !== 'function') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const maxBitrate =
      settings.resolution === '1080p'
        ? 4_500_000
        : settings.resolution === '720p'
          ? 2_500_000
          : 1_200_000;
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = settings.frameRate;
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch {
    // Ignore on browsers that don't allow dynamic sender parameters
  }
}

export async function collectInboundStats(
  pc: RTCPeerConnection,
  prevSnapshot: { bytes: number; timestamp: number } | null
): Promise<{ stats: StreamStats; nextSnapshot: { bytes: number; timestamp: number } | null }> {
  const report = await pc.getStats();
  let width = 0;
  let height = 0;
  let fps = 0;
  let bytesReceived = 0;
  let timestamp = 0;
  let rttMs: number | null = null;

  report.forEach((entry) => {
    if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
      width = entry.frameWidth || width;
      height = entry.frameHeight || height;
      fps = typeof entry.framesPerSecond === 'number' ? Math.round(entry.framesPerSecond) : fps;
      bytesReceived = entry.bytesReceived || 0;
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
  if (prevSnapshot && timestamp > prevSnapshot.timestamp && bytesReceived >= prevSnapshot.bytes) {
    const dtSec = (timestamp - prevSnapshot.timestamp) / 1000;
    if (dtSec > 0) {
      bitrateKbps = Math.round(((bytesReceived - prevSnapshot.bytes) * 8) / dtSec / 1000);
    }
  }

  return {
    stats: { width, height, fps, bitrateKbps, rttMs },
    nextSnapshot: timestamp ? { bytes: bytesReceived, timestamp } : prevSnapshot,
  };
}
