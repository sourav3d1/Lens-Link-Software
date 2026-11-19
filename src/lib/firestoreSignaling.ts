import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Unsubscribe,
  updateDoc,
} from 'firebase/firestore';
import { CameraCapabilities, CameraSettings } from '../types/lenslink';
import { db, handleFirestoreError, OperationType } from './firebase';

export interface FirestoreRoomDoc {
  code: string;
  sessionToken: string;
  pcName: string;
  pcOnline: boolean;
  phoneOnline: boolean;
  phoneName: string;
  phoneStreaming: boolean;
  offerId: string;
  offerSdp: string;
  answerForOfferId: string;
  answerSdp: string;
  phoneIceCandidates: string[];
  pcIceCandidates: string[];
  restartNonce: number;
  focusNonce: number;
  focusX: number;
  focusY: number;
  captureNonce: number;
  settings: Partial<CameraSettings>;
  capabilities: CameraCapabilities | Record<string, unknown>;
}

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;

function sanitizeForFirestore<T>(val: T): T {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val
      .filter((item) => item !== undefined)
      .map((item) => sanitizeForFirestore(item)) as unknown as T;
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = sanitizeForFirestore(v);
      }
    }
    return out as T;
  }
  return val;
}

export function encodeIceCandidate(cand: RTCIceCandidateInit): string | null {
  const raw = typeof cand.candidate === 'string' ? cand.candidate.trim() : '';
  if (!raw) return null;
  const mid = cand.sdpMid ?? '0';
  const idx = typeof cand.sdpMLineIndex === 'number' ? cand.sdpMLineIndex : 0;
  const encoded = `${mid}|${idx}|${raw}`;
  return encoded.length <= 600 ? encoded : null;
}

export function decodeIceCandidate(encoded: string): RTCIceCandidateInit | null {
  const firstBar = encoded.indexOf('|');
  if (firstBar === -1) return null;
  const secondBar = encoded.indexOf('|', firstBar + 1);
  if (secondBar === -1) return null;
  const sdpMid = encoded.slice(0, firstBar) || '0';
  const sdpMLineIndex = Number(encoded.slice(firstBar + 1, secondBar));
  const candidate = encoded.slice(secondBar + 1);
  if (!candidate) return null;
  return {
    sdpMid,
    sdpMLineIndex: Number.isFinite(sdpMLineIndex) ? sdpMLineIndex : 0,
    candidate,
  };
}

export function sanitizePcName(name: string): string {
  const cleaned = (name || '').trim().slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'PC Workstation';
}

export function sanitizeSessionToken(token: string): string {
  const cleaned = (token || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned.length >= 8 ? cleaned : `tok${Date.now().toString(36)}0000`;
}

export async function createOrResetPcRoom(params: {
  code: string;
  sessionToken: string;
  pcName: string;
}): Promise<boolean> {
  const code = params.code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) return false;

  const docPath = `webrtc_rooms/${code}`;
  const roomRef = doc(db, 'webrtc_rooms', code);

  try {
    const existingSnap = await getDoc(roomRef);
    if (existingSnap.exists()) {
      await updateDoc(roomRef, {
        pcName: sanitizePcName(params.pcName),
        pcOnline: true,
        answerForOfferId: '',
        answerSdp: '',
        pcIceCandidates: [],
        updatedAt: serverTimestamp(),
      });
      return true;
    }

    await setDoc(roomRef, {
      code,
      sessionToken: sanitizeSessionToken(params.sessionToken),
      pcName: sanitizePcName(params.pcName),
      pcOnline: true,
      phoneOnline: false,
      phoneName: '',
      phoneStreaming: false,
      offerId: '',
      offerSdp: '',
      answerForOfferId: '',
      answerSdp: '',
      phoneIceCandidates: [],
      pcIceCandidates: [],
      restartNonce: 0,
      focusNonce: 0,
      focusX: 0.5,
      focusY: 0.5,
      captureNonce: 0,
      settings: {},
      capabilities: {},
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.WRITE, docPath);
    }
    return false;
  }
}

export async function updatePcRoomFields(
  code: string,
  fields: Partial<{
    pcName: string;
    pcOnline: boolean;
    answerForOfferId: string;
    answerSdp: string;
    pcIceCandidates: string[];
    restartNonce: number;
    focusNonce: number;
    focusX: number;
    focusY: number;
    captureNonce: number;
    settings: Partial<CameraSettings>;
  }>
): Promise<boolean> {
  const cleanCode = code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(cleanCode)) return false;

  const docPath = `webrtc_rooms/${cleanCode}`;
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };

  if (typeof fields.pcName === 'string') payload.pcName = sanitizePcName(fields.pcName);
  if (typeof fields.pcOnline === 'boolean') payload.pcOnline = fields.pcOnline;
  if (typeof fields.answerForOfferId === 'string') {
    payload.answerForOfferId = fields.answerForOfferId.slice(0, 64);
  }
  if (typeof fields.answerSdp === 'string') {
    payload.answerSdp = fields.answerSdp.slice(0, 25000);
  }
  if (Array.isArray(fields.pcIceCandidates)) {
    payload.pcIceCandidates = fields.pcIceCandidates.slice(0, 24);
  }
  if (typeof fields.restartNonce === 'number') {
    payload.restartNonce = Math.max(0, Math.min(1000000, Math.floor(fields.restartNonce)));
  }
  if (typeof fields.focusNonce === 'number') {
    payload.focusNonce = Math.max(0, Math.min(1000000, Math.floor(fields.focusNonce)));
  }
  if (typeof fields.focusX === 'number') {
    payload.focusX = Math.max(0, Math.min(1, fields.focusX));
  }
  if (typeof fields.focusY === 'number') {
    payload.focusY = Math.max(0, Math.min(1, fields.focusY));
  }
  if (typeof fields.captureNonce === 'number') {
    payload.captureNonce = Math.max(0, Math.min(1000000, Math.floor(fields.captureNonce)));
  }
  if (fields.settings) {
    payload.settings = sanitizeForFirestore(fields.settings);
  }

  try {
    await updateDoc(doc(db, 'webrtc_rooms', cleanCode), payload);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.UPDATE, docPath);
    }
    return false;
  }
}

export async function updatePhoneRoomFields(
  code: string,
  fields: Partial<{
    phoneOnline: boolean;
    phoneName: string;
    phoneStreaming: boolean;
    offerId: string;
    offerSdp: string;
    phoneIceCandidates: string[];
    capabilities: CameraCapabilities;
    settings: Partial<CameraSettings>;
  }>
): Promise<boolean> {
  const cleanCode = code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(cleanCode)) return false;

  const docPath = `webrtc_rooms/${cleanCode}`;
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };

  if (typeof fields.phoneOnline === 'boolean') payload.phoneOnline = fields.phoneOnline;
  if (typeof fields.phoneName === 'string') payload.phoneName = fields.phoneName.trim().slice(0, 64);
  if (typeof fields.phoneStreaming === 'boolean') payload.phoneStreaming = fields.phoneStreaming;
  if (typeof fields.offerId === 'string') payload.offerId = fields.offerId.slice(0, 64);
  if (typeof fields.offerSdp === 'string') payload.offerSdp = fields.offerSdp.slice(0, 25000);
  if (Array.isArray(fields.phoneIceCandidates)) {
    payload.phoneIceCandidates = fields.phoneIceCandidates.slice(0, 24);
  }
  if (fields.capabilities) {
    payload.capabilities = sanitizeForFirestore(fields.capabilities);
  }
  if (fields.settings) {
    payload.settings = sanitizeForFirestore(fields.settings);
  }

  try {
    await updateDoc(doc(db, 'webrtc_rooms', cleanCode), payload);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.UPDATE, docPath);
    }
    return false;
  }
}

export function subscribeToRoom(
  code: string,
  onData: (room: FirestoreRoomDoc | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const cleanCode = code.trim().toUpperCase();
  const docPath = `webrtc_rooms/${cleanCode}`;
  return onSnapshot(
    doc(db, 'webrtc_rooms', cleanCode),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      onData(snap.data() as FirestoreRoomDoc);
    },
    (error) => {
      if (error.message.toLowerCase().includes('permission')) {
        handleFirestoreError(error, OperationType.GET, docPath);
      }
      onError?.(error);
    }
  );
}

export interface FirestoreObsViewerDoc {
  viewerId: 'obs-primary';
  roomCode: string;
  requestNonce: number;
  offerId: string;
  offerSdp: string;
  answerForOfferId: string;
  answerSdp: string;
  pcIceCandidates: string[];
  viewerIceCandidates: string[];
}

const OBS_VIEWER_ID = 'obs-primary' as const;

export async function requestObsViewerStream(code: string): Promise<boolean> {
  const cleanCode = code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(cleanCode)) return false;

  const docPath = `webrtc_rooms/${cleanCode}/viewers/${OBS_VIEWER_ID}`;
  const viewerRef = doc(db, 'webrtc_rooms', cleanCode, 'viewers', OBS_VIEWER_ID);

  try {
    const snap = await getDoc(viewerRef);
    if (snap.exists()) {
      const prevNonce = typeof snap.data().requestNonce === 'number' ? snap.data().requestNonce : 0;
      const nextNonce = prevNonce >= 999999 ? 1 : prevNonce + 1;
      await updateDoc(viewerRef, {
        requestNonce: nextNonce,
        answerForOfferId: '',
        answerSdp: '',
        viewerIceCandidates: [],
        updatedAt: serverTimestamp(),
      });
      return true;
    }

    await setDoc(viewerRef, {
      viewerId: OBS_VIEWER_ID,
      roomCode: cleanCode,
      requestNonce: 1,
      offerId: '',
      offerSdp: '',
      answerForOfferId: '',
      answerSdp: '',
      pcIceCandidates: [],
      viewerIceCandidates: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.WRITE, docPath);
    }
    return false;
  }
}

export async function updateObsViewerFromPc(
  code: string,
  fields: Partial<{
    offerId: string;
    offerSdp: string;
    pcIceCandidates: string[];
  }>
): Promise<boolean> {
  const cleanCode = code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(cleanCode)) return false;

  const docPath = `webrtc_rooms/${cleanCode}/viewers/${OBS_VIEWER_ID}`;
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (typeof fields.offerId === 'string') payload.offerId = fields.offerId.slice(0, 64);
  if (typeof fields.offerSdp === 'string') payload.offerSdp = fields.offerSdp.slice(0, 25000);
  if (Array.isArray(fields.pcIceCandidates)) {
    payload.pcIceCandidates = fields.pcIceCandidates.slice(0, 24);
  }

  try {
    await updateDoc(doc(db, 'webrtc_rooms', cleanCode, 'viewers', OBS_VIEWER_ID), payload);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.UPDATE, docPath);
    }
    return false;
  }
}

export async function updateObsViewerFromClient(
  code: string,
  fields: Partial<{
    requestNonce: number;
    answerForOfferId: string;
    answerSdp: string;
    viewerIceCandidates: string[];
  }>
): Promise<boolean> {
  const cleanCode = code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(cleanCode)) return false;

  const docPath = `webrtc_rooms/${cleanCode}/viewers/${OBS_VIEWER_ID}`;
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (typeof fields.requestNonce === 'number') {
    payload.requestNonce = Math.max(0, Math.min(1000000, Math.floor(fields.requestNonce)));
  }
  if (typeof fields.answerForOfferId === 'string') {
    payload.answerForOfferId = fields.answerForOfferId.slice(0, 64);
  }
  if (typeof fields.answerSdp === 'string') {
    payload.answerSdp = fields.answerSdp.slice(0, 25000);
  }
  if (Array.isArray(fields.viewerIceCandidates)) {
    payload.viewerIceCandidates = fields.viewerIceCandidates.slice(0, 24);
  }

  try {
    await updateDoc(doc(db, 'webrtc_rooms', cleanCode, 'viewers', OBS_VIEWER_ID), payload);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.UPDATE, docPath);
    }
    return false;
  }
}

export function subscribeToObsViewer(
  code: string,
  onData: (viewer: FirestoreObsViewerDoc | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const cleanCode = code.trim().toUpperCase();
  const docPath = `webrtc_rooms/${cleanCode}/viewers/${OBS_VIEWER_ID}`;
  return onSnapshot(
    doc(db, 'webrtc_rooms', cleanCode, 'viewers', OBS_VIEWER_ID),
    (snap) => {
      if (!snap.exists()) {
        onData(null);
        return;
      }
      onData(snap.data() as FirestoreObsViewerDoc);
    },
    (error) => {
      if (error.message.toLowerCase().includes('permission')) {
        handleFirestoreError(error, OperationType.GET, docPath);
      }
      onError?.(error);
    }
  );
}
