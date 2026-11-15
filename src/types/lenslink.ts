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

export interface CameraSettings {
  facingMode: CameraFacing;
  deviceId?: string;
  resolution: ResolutionPreset;
  frameRate: FrameRatePreset;
  zoom: number;
  focusMode: FocusMode;
  focusDistance: number;
  brightness: number; // -100 to +100 software/exposure adjustment (0 = neutral)
  exposureCompensation: number; // hardware EV when supported
  torch: boolean;
  mirror: boolean;
}

export interface CameraDeviceSummary {
  deviceId: string;
  label: string;
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
  focusDistance?: RangeCapability;
  focusModes?: string[];
  torch?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate?: number;
}

export interface RoomStatusPayload {
  type: 'room:status';
  code: string;
  pcOnline: boolean;
  phoneOnline: boolean;
  vcamBridgeCount: number;
  vcamWebCount: number;
  vcamWebPeerIds?: string[];
  phoneName?: string;
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
    | 'vcam:bridge-toggle'
    | 'ping'
    | 'pong';
  code?: string;
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
  message?: string;
  pcOnline?: boolean;
  phoneOnline?: boolean;
  vcamBridgeCount?: number;
  vcamWebCount?: number;
  vcamWebPeerIds?: string[];
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
  resolution: '720p',
  frameRate: 30,
  zoom: 1,
  focusMode: 'continuous',
  focusDistance: 0.5,
  brightness: 0,
  exposureCompensation: 0,
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
