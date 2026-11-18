// LensLink Virtual Webcam — ISOLATED World Bridge
// 1. Auto-detects active LensLink PC Receiver tabs and syncs pairCode + serverOrigin.
// 2. Relays extension config and live JPEG frames between background.js and content-main.js.

(() => {
  if (window.__lenslinkIsolatedBridge) return;
  window.__lenslinkIsolatedBridge = true;

  const ISO_SOURCE = 'lenslink-ext-iso';
  const MAIN_SOURCE = 'lenslink-ext-main';

  let streamRefCount = 0;
  let port = null;

  function isStreamerOrVcamPage() {
    const path = (window.location.pathname || '').toLowerCase();
    const search = (window.location.search || '').toLowerCase();
    return (
      path === '/phone' ||
      path === '/vcam' ||
      search.includes('mode=phone') ||
      search.includes('mode=vcam')
    );
  }

  function syncPcSessionAttributes() {
    const root = document.documentElement;
    if (!root) return;
    const code = (root.getAttribute('data-lenslink-pc-code') || '').trim().toUpperCase();
    const origin = (root.getAttribute('data-lenslink-origin') || '').trim();
    if (/^[A-Z0-9]{6}$/.test(code)) {
      const updates = { pairCode: code };
      if (/^https?:\/\/[^/]+$/i.test(origin)) {
        updates.serverOrigin = origin;
      }
      chrome.storage.local.set(updates).catch(() => {});
    }
  }

  // Observe LensLink PC Receiver root attributes for zero-typing auto-pairing
  syncPcSessionAttributes();
  const attrObserver = new MutationObserver(() => {
    syncPcSessionAttributes();
  });
  if (document.documentElement) {
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-lenslink-pc-code', 'data-lenslink-origin'],
    });
  }
  window.addEventListener('lenslink:pc-session', (e) => {
    const detail = e && e.detail ? e.detail : null;
    if (detail && typeof detail.pairCode === 'string' && /^[A-Z0-9]{6}$/i.test(detail.pairCode)) {
      const updates = { pairCode: detail.pairCode.toUpperCase() };
      if (typeof detail.origin === 'string' && /^https?:\/\/[^/]+$/i.test(detail.origin)) {
        updates.serverOrigin = detail.origin;
      }
      chrome.storage.local.set(updates).catch(() => {});
    }
  });

  if (isStreamerOrVcamPage()) {
    return;
  }

  async function pushConfigToMain() {
    try {
      const data = await chrome.storage.local.get([
        'enabled',
        'replaceDefaultCamera',
        'pairCode',
        'serverOrigin',
      ]);
      window.postMessage(
        {
          source: ISO_SOURCE,
          type: 'config',
          enabled: data.enabled !== false,
          replaceDefaultCamera: Boolean(data.replaceDefaultCamera),
          pairCode: data.pairCode || '',
          serverOrigin: data.serverOrigin || '',
        },
        '*'
      );
    } catch {
      // Ignore extension context invalidation
    }
  }

  function openPortIfNeeded() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: 'lenslink-vcam-stream' });
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'frame' && msg.dataUrl) {
          window.postMessage(
            { source: ISO_SOURCE, type: 'frame', dataUrl: msg.dataUrl },
            '*'
          );
        } else if (msg.type === 'status' && msg.state) {
          window.postMessage(
            { source: ISO_SOURCE, type: 'status', state: msg.state },
            '*'
          );
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        if (streamRefCount > 0) {
          setTimeout(() => {
            if (streamRefCount > 0) openPortIfNeeded();
          }, 500);
        }
      });
    } catch {
      port = null;
    }
  }

  function closePort() {
    if (port) {
      try {
        port.disconnect();
      } catch {
        // Ignore
      }
      port = null;
    }
  }

  void pushConfigToMain();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.enabled || changes.replaceDefaultCamera || changes.pairCode || changes.serverOrigin)) {
      void pushConfigToMain();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== MAIN_SOURCE) {
      return;
    }
    if (event.data.type === 'request-config') {
      void pushConfigToMain();
    } else if (event.data.type === 'start-stream') {
      streamRefCount += 1;
      openPortIfNeeded();
    } else if (event.data.type === 'stop-stream') {
      streamRefCount = Math.max(0, streamRefCount - 1);
      if (streamRefCount === 0) {
        closePort();
      }
    }
  });
})();
