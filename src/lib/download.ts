import {
  BundleId,
  fetchBundleFromFirebase,
  getCatalogEntry,
  inferBundleIdFromUrl,
  isValidZipBytes,
} from './firebaseBundles';

export interface DownloadResult {
  ok: boolean;
  source?: 'firebase' | 'api' | 'static';
  error?: string;
}

function triggerZipSave(bytes: Uint8Array, filename: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/zip' });
  const blobUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 15000);
}

async function fetchValidZipFromUrl(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return isValidZipBytes(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

export async function downloadBundle(
  url: string,
  filename: string,
  options?: { bundleId?: BundleId; preferFirebase?: boolean }
): Promise<DownloadResult> {
  const bundleId = options?.bundleId || inferBundleIdFromUrl(url);
  const preferFirebase = options?.preferFirebase !== false;
  const catalogEntry = bundleId ? getCatalogEntry(bundleId) : undefined;

  try {
    let staleFirebaseFallback: { bytes: Uint8Array; filename: string } | null = null;

    // 1. Try Firebase Firestore bundle store first when up-to-date
    if (bundleId && preferFirebase) {
      const fbPayload = await fetchBundleFromFirebase(bundleId);
      if (fbPayload && isValidZipBytes(fbPayload.bytes)) {
        const versionMatches = !catalogEntry || fbPayload.version === catalogEntry.version;
        if (versionMatches) {
          triggerZipSave(fbPayload.bytes, fbPayload.filename || filename);
          return { ok: true, source: 'firebase' };
        }
        staleFirebaseFallback = {
          bytes: fbPayload.bytes,
          filename: fbPayload.filename || filename,
        };
      }
    }

    // 2. Try dynamic API endpoint
    const apiBytes = await fetchValidZipFromUrl(url);
    if (apiBytes) {
      triggerZipSave(apiBytes, filename);
      return { ok: true, source: 'api' };
    }

    // 3. Fallback to pre-built static archive under /downloads/
    const staticUrl = catalogEntry?.staticPath || `/downloads/${filename}`;
    const staticBytes = await fetchValidZipFromUrl(staticUrl);
    if (staticBytes) {
      triggerZipSave(staticBytes, filename);
      return { ok: true, source: 'static' };
    }

    // 4. Final fallback to Firebase (even if version differed or preferFirebase was false)
    if (staleFirebaseFallback) {
      triggerZipSave(staleFirebaseFallback.bytes, staleFirebaseFallback.filename);
      return { ok: true, source: 'firebase' };
    }
    if (bundleId && !preferFirebase) {
      const fbPayload = await fetchBundleFromFirebase(bundleId);
      if (fbPayload && isValidZipBytes(fbPayload.bytes)) {
        triggerZipSave(fbPayload.bytes, fbPayload.filename || filename);
        return { ok: true, source: 'firebase' };
      }
    }

    return {
      ok: false,
      error: `Unable to download ${filename}. Please sign in to Firebase Cloud Bundles or retry.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to download bundle.',
    };
  }
}
