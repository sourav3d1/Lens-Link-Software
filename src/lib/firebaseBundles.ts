import { User } from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  serverTimestamp,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';

export type BundleId =
  | 'browser-webcam'
  | 'windows-vcam'
  | 'pc-windows'
  | 'android-studio';

export interface BundleCatalogEntry {
  bundleId: BundleId;
  title: string;
  description: string;
  filename: string;
  apiPath: string;
  staticPath: string;
  version: string;
}

export const BUNDLE_CATALOG: BundleCatalogEntry[] = [
  {
    bundleId: 'browser-webcam',
    title: 'Browser Virtual Webcam Extension',
    description: 'Chrome & Edge extension (zero OBS, zero Python, zero drivers)',
    filename: 'lenslink-browser-webcam.zip',
    apiPath: '/api/browser-cam/bundle',
    staticPath: '/downloads/lenslink-browser-webcam.zip',
    version: '1.2.0',
  },
  {
    bundleId: 'windows-vcam',
    title: 'Windows DirectShow Driver + Bridge',
    description: 'Standalone Windows DirectShow virtual camera bridge (no OBS)',
    filename: 'lenslink-windows-vcam.zip',
    apiPath: '/api/virtual-cam/bundle',
    staticPath: '/downloads/lenslink-windows-vcam.zip',
    version: '1.0.0',
  },
  {
    bundleId: 'pc-windows',
    title: 'Windows PC Desktop Launcher',
    description: 'Standalone Windows desktop shortcut installer & scripts',
    filename: 'lenslink-pc-windows.zip',
    apiPath: '/api/pc-app/bundle',
    staticPath: '/downloads/lenslink-pc-windows.zip',
    version: '1.0.0',
  },
  {
    bundleId: 'android-studio',
    title: 'Native Android Mobile App (Kotlin)',
    description: 'Android Studio project with Camera2, WebRTC & QR scanner',
    filename: 'lenslink-android-studio.zip',
    apiPath: '/api/android-app/bundle',
    staticPath: '/downloads/lenslink-android-studio.zip',
    version: '1.0.0',
  },
];

export interface StoredBundleStatus {
  bundleId: BundleId;
  storedInFirebase: boolean;
  sizeBytes?: number;
  version?: string;
  updatedAtMs?: number;
}

export interface FirebaseBundlePayload {
  bytes: Uint8Array;
  filename: string;
  sizeBytes: number;
  version?: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function isValidZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function getCatalogEntry(bundleId: BundleId): BundleCatalogEntry | undefined {
  return BUNDLE_CATALOG.find((item) => item.bundleId === bundleId);
}

export function inferBundleIdFromUrl(url: string): BundleId | undefined {
  if (url.includes('/api/browser-cam/bundle') || url.includes('lenslink-browser-webcam')) {
    return 'browser-webcam';
  }
  if (url.includes('/api/virtual-cam/bundle') || url.includes('lenslink-windows-vcam')) {
    return 'windows-vcam';
  }
  if (url.includes('/api/pc-app/bundle') || url.includes('lenslink-pc-windows')) {
    return 'pc-windows';
  }
  if (url.includes('/api/android-app/bundle') || url.includes('lenslink-android-studio')) {
    return 'android-studio';
  }
  return undefined;
}

export async function fetchBundleFromFirebase(
  bundleId: BundleId
): Promise<FirebaseBundlePayload | null> {
  const docPath = `download_bundles/${bundleId}`;
  try {
    let snap;
    try {
      snap = await getDocFromServer(doc(db, 'download_bundles', bundleId));
    } catch {
      snap = await getDoc(doc(db, 'download_bundles', bundleId));
    }

    if (!snap.exists()) {
      return null;
    }

    const data = snap.data();
    if (
      typeof data.zipBase64 !== 'string' ||
      typeof data.filename !== 'string' ||
      data.zipBase64.length < 8
    ) {
      return null;
    }

    const bytes = base64ToUint8(data.zipBase64);
    if (!isValidZipBytes(bytes)) {
      return null;
    }

    return {
      bytes,
      filename: data.filename,
      sizeBytes: bytes.byteLength,
      version: typeof data.version === 'string' ? data.version : undefined,
    };
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }
    return null;
  }
}

export async function fetchAllBundleStatuses(): Promise<StoredBundleStatus[]> {
  return Promise.all(
    BUNDLE_CATALOG.map(async (entry) => {
      const docPath = `download_bundles/${entry.bundleId}`;
      try {
        const snap = await getDoc(doc(db, 'download_bundles', entry.bundleId));
        if (!snap.exists()) {
          return { bundleId: entry.bundleId, storedInFirebase: false };
        }
        const data = snap.data();
        const updatedAt = data.updatedAt instanceof Timestamp ? data.updatedAt.toMillis() : undefined;
        return {
          bundleId: entry.bundleId,
          storedInFirebase: true,
          sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : undefined,
          version: typeof data.version === 'string' ? data.version : undefined,
          updatedAtMs: updatedAt,
        };
      } catch (error) {
        if (error instanceof Error && error.message.toLowerCase().includes('permission')) {
          handleFirestoreError(error, OperationType.GET, docPath);
        }
        return { bundleId: entry.bundleId, storedInFirebase: false };
      }
    })
  );
}

async function fetchSourceZipBytes(entry: BundleCatalogEntry): Promise<Uint8Array> {
  const originParam = encodeURIComponent(window.location.origin);
  const candidates = [`${entry.apiPath}?origin=${originParam}`, entry.staticPath];

  for (const candidateUrl of candidates) {
    try {
      const res = await fetch(candidateUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isValidZipBytes(bytes)) {
        return bytes;
      }
    } catch {
      // Try next source
    }
  }

  throw new Error(`Could not locate source ZIP for ${entry.filename}.`);
}

export async function syncAllBundlesToFirebase(
  user: User,
  onProgress?: (completed: number, total: number, currentTitle: string) => void
): Promise<StoredBundleStatus[]> {
  const total = BUNDLE_CATALOG.length;

  for (let i = 0; i < total; i++) {
    const entry = BUNDLE_CATALOG[i];
    onProgress?.(i, total, entry.title);

    const bytes = await fetchSourceZipBytes(entry);
    const zipBase64 = uint8ToBase64(bytes);
    if (zipBase64.length > 900000) {
      throw new Error(`${entry.filename} exceeds Firestore document size limit.`);
    }
    const sha256 = await computeSha256Hex(bytes);

    const docRef = doc(db, 'download_bundles', entry.bundleId);
    const docPath = `download_bundles/${entry.bundleId}`;

    let existingSnap;
    try {
      existingSnap = await getDoc(docRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }

    const existingCreatedAt = existingSnap.exists() ? existingSnap.data().createdAt : null;

    const payload = {
      bundleId: entry.bundleId,
      filename: entry.filename,
      contentType: 'application/zip' as const,
      sizeBytes: bytes.byteLength,
      zipBase64,
      sha256,
      version: entry.version,
      uploadedBy: user.uid,
      createdAt: existingCreatedAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(docRef, payload);
    } catch (error) {
      handleFirestoreError(
        error,
        existingSnap.exists() ? OperationType.UPDATE : OperationType.CREATE,
        docPath
      );
    }
  }

  onProgress?.(total, total, 'All files synced');
  return fetchAllBundleStatuses();
}
