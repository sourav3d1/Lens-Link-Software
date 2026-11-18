export type ConnectionStatus =
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type ResolutionPreset = '480p' | '720p' | '1080p';
export type FrameRatePreset = 15 | 24 | 30 | 60;
export type CameraFacing = 'user' | 'environment';
export type FocusMode = 'continuous' | 'manual';
export type CaptureCategory = 'article' | 'huid';
export type FramingGuide = 'none' | 'article' | 'huid';

export interface CameraSettings {
  facingMode: CameraFacing;
  deviceId?: string;
  resolution: ResolutionPreset;
  frameRate: FrameRatePreset;
  zoom: number;
  digitalZoom: number;
  focusMode: FocusMode;
  focusDistance: number;
  brightness: number; // -50 to +50 (0 = neutral)
  contrast: number; // -50 to +100 (0 = neutral, 100 = 200% contrast)
  sharpness: number; // 0 to 100 when hardware supported
  grayscale: boolean;
  exposureCompensation: number; // hardware EV when supported
  whiteBalanceMode: 'continuous' | 'manual';
  colorTemperature: number;
  torch: boolean;
  mirror: boolean;
}

export interface CameraDeviceSummary {
  deviceId: string;
  label: string;
  shortLabel: string;
  facing: 'back' | 'front' | 'unknown';
}

export interface RangeCapability {
  min: number;
  max: number;
  step: number;
}

export interface CameraCapabilities {
  devices: CameraDeviceSummary[];
  zoom?: RangeCapability;
  exposureCompensation?: RangeCapability;
  brightness?: RangeCapability;
  contrast?: RangeCapability;
  sharpness?: RangeCapability;
  colorTemperature?: RangeCapability;
  whiteBalanceModes?: string[];
  focusDistance?: RangeCapability;
  focusModes?: string[];
  torch?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}

export interface CapturedPhoto {
  id: string;
  category: CaptureCategory;
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  lensLabel: string;
  zoom: number;
}

export interface RoomStatusPayload {
  type: 'room:status';
  code: string;
  pcOnline: boolean;
  phoneOnline: boolean;
  vcamBridgeCount: number;
  vcamWebCount: number;
  vcamWebFrameCount?: number;
  vcamWebPeerIds?: string[];
  phoneName?: string;
  pcName?: string;
  capabilities?: CameraCapabilities | null;
  settings?: CameraSettings;
}

export interface SignalingMessage {
  type:
    | 'room:create'
    | 'room:created'
    | 'room:join'
    | 'room:joined'
    | 'room:error'
    | 'room:status'
    | 'rtc:offer'
    | 'rtc:answer'
    | 'rtc:ice-candidate'
    | 'rtc:restart'
    | 'camera:capabilities'
    | 'camera:settings'
    | 'camera:stream-state'
    | 'camera:trigger-focus'
    | 'camera:photo-captured'
    | 'camera:request-capture'
    | 'vcam:bridge-toggle'
    | 'vcam:frame-fallback'
    | 'vcam:request-offer'
    | 'ping'
    | 'pong';
  code?: string;
  sessionToken?: string;
  role?: 'pc' | 'phone' | 'vcam' | 'vcam-web';
  target?: 'pc' | 'phone' | 'vcam-web';
  from?: 'pc' | 'phone' | 'vcam-web';
  peerId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  capabilities?: CameraCapabilities;
  settings?: Partial<CameraSettings>;
  streaming?: boolean;
  enabled?: boolean;
  phoneName?: string;
  pcName?: string;
  message?: string;
  pcOnline?: boolean;
  phoneOnline?: boolean;
  vcamBridgeCount?: number;
  vcamWebCount?: number;
  vcamWebFrameCount?: number;
  vcamWebPeerIds?: string[];
  focusPoint?: { x: number; y: number };
  photo?: CapturedPhoto;
  captureCategory?: CaptureCategory;
}

export interface NetworkInfoResponse {
  lanIps: string[];
  preferredIp: string | null;
  port: number;
  isLocalhostRequest: boolean;
  suggestedOrigin: string;
}

export interface StreamStats {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  rttMs: number | null;
}

export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  facingMode: 'environment',
  resolution: '1080p',
  frameRate: 30,
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
  colorTemperature: 4500,
  torch: false,
  mirror: false,
};

export const RESOLUTION_DIMENSIONS: Record<
  ResolutionPreset,
  { width: number; height: number; label: string }
> = {
  '480p': { width: 854, height: 480, label: '480p SD' },
  '720p': { width: 1280, height: 720, label: '720p HD' },
  '1080p': { width: 1920, height: 1080, label: '1080p Full HD' },
};
