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
  | 'windows-vcam'
  | 'android-studio'
  | 'ios-app'
  | 'browser-webcam'
  | 'pc-windows';

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
    bundleId: 'windows-vcam',
    title: 'LensLink Windows Client & Virtual Webcam Driver',
    description:
      'System-level DirectShow virtual webcam driver (LensLink Wireless Webcam), mDNS auto-discovery client, Inno Setup installer & uninstaller',
    filename: 'lenslink-windows-webcam-suite.zip',
    apiPath: '/api/virtual-cam/bundle',
    staticPath: '/downloads/lenslink-windows-webcam-suite.zip',
    version: '2.0.0',
  },
  {
    bundleId: 'android-studio',
    title: 'LensLink Mobile App — Android (Kotlin)',
    description:
      'Native Android app with Camera2 multi-lens, 4K/60fps, NSD auto-discovery, MediaCodec H.264, microphone & battery monitor',
    filename: 'lenslink-android-app.zip',
    apiPath: '/api/android-app/bundle',
    staticPath: '/downloads/lenslink-android-app.zip',
    version: '2.0.0',
  },
  {
    bundleId: 'ios-app',
    title: 'LensLink Mobile App — iOS (SwiftUI)',
    description:
      'Native iOS app with AVFoundation multi-lens, 4K/60fps, Bonjour auto-discovery, VideoToolbox H.264, microphone & thermal monitor',
    filename: 'lenslink-ios-app.zip',
    apiPath: '/api/ios-app/bundle',
    staticPath: '/downloads/lenslink-ios-app.zip',
    version: '2.0.0',
  },
  {
    bundleId: 'browser-webcam',
    title: 'LensLink Browser Virtual Webcam (Chrome / Edge)',
    description:
      'Zero-driver Chrome & Edge extension exposing LensLink Wireless Webcam directly in Google Meet, Zoom Web & Teams Web',
    filename: 'lenslink-browser-webcam.zip',
    apiPath: '/api/browser-cam/bundle',
    staticPath: '/downloads/lenslink-browser-webcam.zip',
    version: '2.0.0',
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
  if (url.includes('/api/virtual-cam/bundle') || url.includes('lenslink-windows-webcam-suite')) {
    return 'windows-vcam';
  }
  if (url.includes('/api/ios-app/bundle') || url.includes('lenslink-ios-app')) {
    return 'ios-app';
  }
  if (url.includes('/api/android-app/bundle') || url.includes('lenslink-android-app')) {
    return 'android-studio';
  }
  if (url.includes('/api/pc-app/bundle')) {
    return 'windows-vcam';
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
