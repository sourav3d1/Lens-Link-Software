export type AppMode = 'desktop' | 'mobile' | 'vcam';

export type LensLinkConnectionStatus =
  | 'searching'
  | 'device-found'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export type ResolutionPreset = '480p' | '720p' | '1080p' | '4k';
export type FrameRatePreset = 24 | 30 | 60;
export type FocusMode = 'continuous' | 'manual';
export type WhiteBalanceMode = 'continuous' | 'manual';
export type OrientationMode = 'auto' | 'landscape' | 'portrait';
export type SignalQuality = 'Excellent' | 'Good' | 'Fair' | 'Weak';

export interface ResolutionSpec {
  width: number;
  height: number;
  label: string;
  targetBitrateBps: number;
}

export const RESOLUTION_SPECS: Record<ResolutionPreset, ResolutionSpec> = {
  '480p': { width: 854, height: 480, label: '480p SD', targetBitrateBps: 1_200_000 },
  '720p': { width: 1280, height: 720, label: '720p HD', targetBitrateBps: 2_600_000 },
  '1080p': { width: 1920, height: 1080, label: '1080p Full HD', targetBitrateBps: 4_800_000 },
  '4k': { width: 3840, height: 2160, label: '4K UHD', targetBitrateBps: 11_000_000 },
};

export interface RangeCapability {
  min: number;
  max: number;
  step: number;
}

export interface CameraDeviceSummary {
  deviceId: string;
  label: string;
  shortLabel: string;
  facing: 'back' | 'front' | 'unknown';
}

export interface CameraCapabilities {
  devices: CameraDeviceSummary[];
  zoom?: RangeCapability;
  exposureCompensation?: RangeCapability;
  iso?: RangeCapability;
  brightness?: RangeCapability;
  contrast?: RangeCapability;
  colorTemperature?: RangeCapability;
  whiteBalanceModes?: string[];
  focusDistance?: RangeCapability;
  focusModes?: string[];
  torch?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}

export interface CameraSettings {
  facingMode: 'environment' | 'user';
  deviceId: string | null;
  resolution: ResolutionPreset;
  frameRate: FrameRatePreset;
  zoom: number;
  digitalZoom: number;
  focusMode: FocusMode;
  focusDistance: number;
  exposureCompensation: number;
  iso: number;
  brightness: number;
  contrast: number;
  whiteBalanceMode: WhiteBalanceMode;
  colorTemperature: number;
  torch: boolean;
  mirror: boolean;
  orientation: OrientationMode;
  audioEnabled: boolean;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  facingMode: 'environment',
  deviceId: null,
  resolution: '1080p',
  frameRate: 30,
  zoom: 1,
  digitalZoom: 1,
  focusMode: 'continuous',
  focusDistance: 0.5,
  exposureCompensation: 0,
  iso: 200,
  brightness: 0,
  contrast: 0,
  whiteBalanceMode: 'continuous',
  colorTemperature: 5200,
  torch: false,
  mirror: false,
  orientation: 'auto',
  audioEnabled: false,
};

export interface DiscoveredPc {
  roomCode: string;
  pcName: string;
  platform: string;
  lanHint: string;
  phoneConnected: boolean;
  lastSeenMs: number;
}

export interface PhoneTelemetry {
  deviceName: string;
  model: string;
  lensLabel: string;
  batteryPct: number | null;
  charging: boolean | null;
  thermalState: 'Nominal' | 'Warm' | 'Elevated' | null;
  audioActive: boolean;
}

export interface StreamStats {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  rttMs: number | null;
  packetLossPct: number;
  signalQuality: SignalQuality;
}

export interface NetworkInfo {
  port: number;
  preferredOrigin: string;
  lanIps: string[];
  hostname: string;
  wsPath: string;
}

export interface FocusTapPoint {
  x: number;
  y: number;
  ts: number;
}

export type LensLinkDataChannelMessage =
  | { type: 'settings'; settings: Partial<CameraSettings> }
  | { type: 'telemetry'; telemetry: PhoneTelemetry }
  | { type: 'capabilities'; capabilities: CameraCapabilities }
  | { type: 'tap-focus'; x: number; y: number }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number };
