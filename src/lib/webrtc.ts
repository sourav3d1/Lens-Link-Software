import {
  CameraCapabilities,
  CameraDeviceSummary,
  CameraSettings,
  CaptureCategory,
  CapturedPhoto,
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
  const dims = RESOLUTION_DIMENSIONS[settings.resolution] || RESOLUTION_DIMENSIONS['1080p'];
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
    // Distinguish Android camera2 0/2/etc.
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

    if (isRangeCap(raw.sharpness)) {
      capabilities.sharpness = {
        min: raw.sharpness.min,
        max: raw.sharpness.max,
        step: raw.sharpness.step || 1,
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

function isRangeCap(val: unknown): val is { min: number; max: number; step?: number } {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as { min?: unknown }).min === 'number' &&
    typeof (val as { max?: unknown }).max === 'number'
  );
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

  if (typeof patch.brightness === 'number' && isRangeCap(caps.brightness)) {
    advanced.brightness = mapNormalizedToRange(patch.brightness, -50, 50, caps.brightness);
  }

  if (typeof patch.contrast === 'number' && isRangeCap(caps.contrast)) {
    advanced.contrast = mapNormalizedToRange(patch.contrast, -50, 100, caps.contrast);
  }

  if (typeof patch.sharpness === 'number' && isRangeCap(caps.sharpness)) {
    advanced.sharpness = mapNormalizedToRange(patch.sharpness, 0, 100, caps.sharpness);
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
    // Graceful fallback when browser doesn't support pointsOfInterest
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

  if (settings.grayscale) {
    filters.push('grayscale(1)');
  }

  return filters.length > 0 ? filters.join(' ') : undefined;
}

export async function captureProcessedPhoto(options: {
  video: HTMLVideoElement;
  track?: MediaStreamTrack | null;
  settings: CameraSettings;
  category: CaptureCategory;
  lensLabel: string;
  hardwareBrightnessActive: boolean;
  hardwareContrastActive: boolean;
}): Promise<CapturedPhoto | null> {
  const {
    video,
    track,
    settings,
    category,
    lensLabel,
    hardwareBrightnessActive,
    hardwareContrastActive,
  } = options;

  const digitalZoom = Math.max(1, settings.digitalZoom || 1);
  const filterCss = buildVideoFilterCss(
    settings,
    hardwareBrightnessActive,
    hardwareContrastActive
  );

  let sourceImage: CanvasImageSource = video;
  let srcW = video.videoWidth || 1920;
  let srcH = video.videoHeight || 1080;

  // Use native full-sensor ImageCapture.takePhoto() when available on Android Chrome
  const win = window as unknown as {
    ImageCapture?: new (track: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
  };
  if (track && win.ImageCapture && digitalZoom === 1 && !filterCss && !settings.mirror) {
    try {
      const imageCapture = new win.ImageCapture(track);
      const blob = await imageCapture.takePhoto();
      const bitmap = await createImageBitmap(blob);
      sourceImage = bitmap;
      srcW = bitmap.width;
      srcH = bitmap.height;
    } catch {
      // Fallback to live video frame capture
    }
  }

  if (srcW === 0 || srcH === 0) return null;

  const cropW = Math.round(srcW / digitalZoom);
  const cropH = Math.round(srcH / digitalZoom);
  const cropX = Math.round((srcW - cropW) / 2);
  const cropY = Math.round((srcH - cropH) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.save();
  if (settings.mirror) {
    ctx.translate(srcW, 0);
    ctx.scale(-1, 1);
  }
  if (filterCss) {
    ctx.filter = filterCss;
  }
  ctx.drawImage(sourceImage, cropX, cropY, cropW, cropH, 0, 0, srcW, srcH);
  ctx.restore();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.94);

  return {
    id: `${category}-${Date.now()}`,
    category,
    dataUrl,
    width: srcW,
    height: srcH,
    capturedAt: new Date().toISOString(),
    lensLabel,
    zoom: Number((settings.zoom * digitalZoom).toFixed(1)),
  };
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
        ? 5_000_000
        : settings.resolution === '720p'
          ? 2_800_000
          : 1_200_000;
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = settings.frameRate;
    params.degradationPreference = 'maintain-resolution';
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
