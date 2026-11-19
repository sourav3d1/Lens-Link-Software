// LensLink Virtual Webcam — ISOLATED World Bridge
// 1. On the LensLink PC Receiver tab: opens a direct 'lenslink-pc-source' Chrome port to background.js
//    and relays live video frames & status straight from PcReceiverView without any WebSocket server.
// 2. On all other websites (Google Meet, Zoom Web, Teams, BIS portals): relays extension config and
//    incoming live frames between background.js and content-main.js.

(() => {
  if (window.__lenslinkIsolatedBridge) return;
  window.__lenslinkIsolatedBridge = true;

  const ISO_SOURCE = 'lenslink-ext-iso';
  const MAIN_SOURCE = 'lenslink-ext-main';
  const PC_APP_SOURCE = 'lenslink-pc-app';

  let streamRefCount = 0;
  let consumerPort = null;

  let pcSourcePort = null;
  let pcReconnectTimer = null;
  let pcKeepaliveTimer = null;
  let detectedPcCode = '';

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

  function ensurePcSourcePort(code, origin) {
    if (code && /^[A-Z0-9]{6}$/.test(code)) {
      detectedPcCode = code;
      const updates = { pairCode: code };
      if (origin && /^https?:\/\/[^/]+$/i.test(origin)) {
        updates.serverOrigin = origin;
      }
      chrome.storage.local.set(updates).catch(() => {});
    }

    if (pcSourcePort) {
      if (detectedPcCode) {
        try {
          pcSourcePort.postMessage({
            type: 'pc-register',
            pairCode: detectedPcCode,
          });
        } catch {
          pcSourcePort = null;
        }
      }
      return;
    }

    try {
      pcSourcePort = chrome.runtime.connect({ name: 'lenslink-pc-source' });

      if (detectedPcCode) {
        pcSourcePort.postMessage({
          type: 'pc-register',
          pairCode: detectedPcCode,
        });
      }

      // Greet PcReceiverView so it immediately publishes current status & knows extension is active
      window.postMessage({ source: ISO_SOURCE, type: 'ext-hello' }, '*');

      pcSourcePort.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'relay-control') {
          window.postMessage(
            {
              source: ISO_SOURCE,
              type: 'pc-relay-control',
              active: Boolean(msg.active),
            },
            '*'
          );
        }
      });

      if (pcKeepaliveTimer) clearInterval(pcKeepaliveTimer);
      pcKeepaliveTimer = setInterval(() => {
        if (pcSourcePort) {
          try {
            pcSourcePort.postMessage({ type: 'ping' });
          } catch {
            // Reconnect handled in onDisconnect
          }
        }
      }, 20000);

      pcSourcePort.onDisconnect.addListener(() => {
        pcSourcePort = null;
        if (pcKeepaliveTimer) {
          clearInterval(pcKeepaliveTimer);
          pcKeepaliveTimer = null;
        }
        // Re-establish source port if this tab is still the LensLink PC Receiver
        if (detectedPcCode && !pcReconnectTimer) {
          pcReconnectTimer = setTimeout(() => {
            pcReconnectTimer = null;
            if (detectedPcCode) {
              ensurePcSourcePort(detectedPcCode, window.location.origin);
            }
          }, 800);
        }
      });
    } catch {
      pcSourcePort = null;
    }
  }

  function syncPcSessionAttributes() {
    const root = document.documentElement;
    if (!root) return;
    const code = (root.getAttribute('data-lenslink-pc-code') || '').trim().toUpperCase();
    const origin = (root.getAttribute('data-lenslink-origin') || '').trim();
    if (/^[A-Z0-9]{6}$/.test(code)) {
      ensurePcSourcePort(code, origin);
    }
  }

  // Observe LensLink PC Receiver root attributes for instant zero-config direct linking
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
      ensurePcSourcePort(detail.pairCode.toUpperCase(), detail.origin || window.location.origin);
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
      ]);
      window.postMessage(
        {
          source: ISO_SOURCE,
          type: 'config',
          enabled: data.enabled !== false,
          replaceDefaultCamera: Boolean(data.replaceDefaultCamera),
          pairCode: data.pairCode || '',
        },
        '*'
      );
    } catch {
      // Ignore extension context invalidation
    }
  }

  function openConsumerPortIfNeeded() {
    if (consumerPort) return;
    try {
      consumerPort = chrome.runtime.connect({ name: 'lenslink-vcam-stream' });
      consumerPort.onMessage.addListener((msg) => {
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
      consumerPort.onDisconnect.addListener(() => {
        consumerPort = null;
        if (streamRefCount > 0) {
          setTimeout(() => {
            if (streamRefCount > 0) openConsumerPortIfNeeded();
          }, 500);
        }
      });
    } catch {
      consumerPort = null;
    }
  }

  function closeConsumerPort() {
    if (consumerPort) {
      try {
        consumerPort.disconnect();
      } catch {
        // Ignore
      }
      consumerPort = null;
    }
  }

  void pushConfigToMain();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === 'local' &&
      (changes.enabled || changes.replaceDefaultCamera || changes.pairCode)
    ) {
      void pushConfigToMain();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    // Messages from LensLink PC Receiver React app -> background.js
    if (event.data.source === PC_APP_SOURCE) {
      if (event.data.type === 'pc-status') {
        const code =
          typeof event.data.pairCode === 'string'
            ? event.data.pairCode.trim().toUpperCase()
            : detectedPcCode;
        if (code && /^[A-Z0-9]{6}$/.test(code)) {
          ensurePcSourcePort(code, window.location.origin);
        }
        if (pcSourcePort) {
          try {
            pcSourcePort.postMessage({
              type: 'pc-status',
              pairCode: code,
              pcOnline: Boolean(event.data.pcOnline),
              phoneOnline: Boolean(event.data.phoneOnline),
              phoneName: event.data.phoneName || 'Smartphone',
              hasVideoTrack: Boolean(event.data.hasVideoTrack),
            });
          } catch {
            pcSourcePort = null;
          }
        }
      } else if (event.data.type === 'pc-frame' && event.data.dataUrl) {
        if (!pcSourcePort && detectedPcCode) {
          ensurePcSourcePort(detectedPcCode, window.location.origin);
        }
        if (pcSourcePort) {
          try {
            pcSourcePort.postMessage({
              type: 'pc-frame',
              dataUrl: event.data.dataUrl,
            });
          } catch {
            pcSourcePort = null;
          }
        }
      }
      return;
    }

    // Messages from content-main.js on consumer websites -> background.js
    if (event.data.source === MAIN_SOURCE) {
      if (event.data.type === 'request-config') {
        void pushConfigToMain();
      } else if (event.data.type === 'start-stream') {
        streamRefCount += 1;
        openConsumerPortIfNeeded();
      } else if (event.data.type === 'stop-stream') {
        streamRefCount = Math.max(0, streamRefCount - 1);
        if (streamRefCount === 0) {
          closeConsumerPort();
        }
      }
    }
  });
})();
