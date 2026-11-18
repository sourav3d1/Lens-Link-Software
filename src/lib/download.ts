export async function downloadBundle(
  url: string,
  filename: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Download failed (${response.status}). Please retry or open in a standalone browser tab.`,
      };
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // Verify ZIP magic bytes ("PK") so HTML auth/error pages are never saved as corrupt .zip files
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return {
        ok: false,
        error: 'Server did not return a valid ZIP archive. Open the app directly in a new tab and retry.',
      };
    }

    const blob = new Blob([buffer], { type: 'application/zip' });
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

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unable to download bundle.',
    };
  }
}
