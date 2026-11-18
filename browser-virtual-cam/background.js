// LensLink Virtual Webcam — MV3 Background Service Worker
// Connects to the LensLink WebSocket signaling room as role=vcam and relays live JPEG frames
// to active browser tabs & the extension popup without needing OBS Studio or external drivers.

const activePorts = new Set();
let ws = null;
let reconnectTimer = null;
let pingTimer = null;
let currentState = {
  status: 'idle', // 'idle' | 'connecting' | 'waiting' | 'streaming' | 'error'
  message: 'Open LensLink PC Receiver to auto-pair',
  pairCode: '',
  serverOrigin: '',
  pcOnline: false,
  phoneOnline: false,
};

function normalizeWsBase(origin) {
  const clean = (origin || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (/^https:\/\//i.test(clean)) return 'wss://' + clean.slice(8);
  if (/^http:\/\//i.test(clean)) return 'ws://' + clean.slice(7);
  if (/^wss?:\/\//i.test(clean)) return clean;
  return 'ws://' + clean;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function broadcastToPorts(payload) {
  for (const port of activePorts) {
    try {
      port.postMessage(payload);
    } catch {
      activePorts.delete(port);
    }
  }
}

function updateStatus(partial) {
  currentState = { ...currentState, ...partial };
  broadcastToPorts({ type: 'status', state: currentState });
}

async function ensureDefaultConfig() {
  const stored = await chrome.storage.local.get([
    'serverOrigin',
    'pairCode',
    'enabled',
    'replaceDefaultCamera',
  ]);
  const updates = {};

  if (!stored.serverOrigin) {
    try {
      const resp = await fetch(chrome.runtime.getURL('default-config.json'));
      const cfg = await resp.json();
      if (cfg && typeof cfg.serverOrigin === 'string' && cfg.serverOrigin.trim()) {
        updates.serverOrigin = cfg.serverOrigin.trim();
      }
    } catch {
      updates.serverOrigin = 'http://127.0.0.1:3000';
    }
  }

  if (typeof stored.enabled !== 'boolean') {
    updates.enabled = true;
  }
  if (typeof stored.replaceDefaultCamera !== 'boolean') {
    updates.replaceDefaultCamera = false;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function disconnectSocket(reasonStatus = 'idle', reasonMsg = 'Idle (no active camera request)') {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close(1000, 'Closed by extension');
    } catch {
      // Ignore close error
    }
    ws = null;
  }
  updateStatus({
    status: reasonStatus,
    message: reasonMsg,
    pcOnline: false,
    phoneOnline: false,
  });
}

async function connectIfNeeded() {
  if (activePorts.size === 0) {
    disconnectSocket('idle', 'Ready — select LensLink Wireless Camera in any site');
    return;
  }

  await ensureDefaultConfig();
  const { serverOrigin, pairCode, enabled } = await chrome.storage.local.get([
    'serverOrigin',
    'pairCode',
    'enabled',
  ]);

  if (enabled === false) {
    disconnectSocket('idle', 'Virtual webcam disabled in extension popup');
    return;
  }

  const cleanCode = (pairCode || '').trim().toUpperCase();
  const wsBase = normalizeWsBase(serverOrigin);

  if (!wsBase || !/^[A-Z0-9]{6}$/.test(cleanCode)) {
    disconnectSocket('waiting', 'Open LensLink PC Receiver tab or enter 6-char code');
    return;
  }

  const targetUrl = `${wsBase}/ws?role=vcam&code=${encodeURIComponent(cleanCode)}`;
  if (
    ws &&
    ws.url === targetUrl &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  disconnectSocket('connecting', `Connecting to room ${cleanCode}...`);
  updateStatus({ pairCode: cleanCode, serverOrigin });

  try {
    ws = new WebSocket(targetUrl);
    ws.binaryType = 'arraybuffer';
  } catch (err) {
    updateStatus({
      status: 'error',
      message: err instanceof Error ? err.message : 'Invalid server URL',
    });
    return;
  }

  ws.onopen = () => {
    updateStatus({
      status: 'waiting',
      message: `Connected to room ${cleanCode} — waiting for smartphone feed`,
    });
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore send failure
        }
      }
    }, 15000);
  };

  ws.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'room:status') {
          const pcOnline = Boolean(msg.pcOnline);
          const phoneOnline = Boolean(msg.phoneOnline);
          let status = 'waiting';
          let message = `Room ${cleanCode} connected`;
          if (!pcOnline) {
            message = `Keep LensLink PC Receiver tab open for room ${cleanCode}`;
          } else if (!phoneOnline) {
            message = `Waiting for smartphone to stream in room ${cleanCode}`;
          } else {
            status = 'streaming';
            message = `Live from ${msg.phoneName || 'Smartphone'} (${cleanCode})`;
          }
          updateStatus({ status, message, pcOnline, phoneOnline });
        } else if (msg.type === 'room:error') {
          updateStatus({
            status: 'error',
            message: msg.message || `Room ${cleanCode} not found`,
          });
        }
      } catch {
        // Ignore malformed JSON
      }
      return;
    }

    let buffer = null;
    if (event.data instanceof ArrayBuffer) {
      buffer = event.data;
    } else if (event.data instanceof Blob) {
      buffer = await event.data.arrayBuffer();
    }
    if (!buffer || buffer.byteLength === 0) return;

    const dataUrl = `data:image/jpeg;base64,${arrayBufferToBase64(buffer)}`;
    if (currentState.status !== 'streaming') {
      updateStatus({ status: 'streaming', message: `Streaming live (${cleanCode})` });
    }
    broadcastToPorts({ type: 'frame', dataUrl });
  };

  ws.onerror = () => {
    updateStatus({
      status: 'error',
      message: `Unable to reach LensLink server (${serverOrigin})`,
    });
  };

  ws.onclose = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    ws = null;
    if (activePorts.size > 0) {
      updateStatus({
        status: 'connecting',
        message: 'Connection lost — reconnecting...',
      });
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connectIfNeeded();
        }, 2000);
      }
    }
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultConfig();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultConfig();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.pairCode || changes.serverOrigin || changes.enabled) {
    if (activePorts.size > 0) {
      disconnectSocket('connecting', 'Applying updated pairing configuration...');
      void connectIfNeeded();
    }
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'lenslink-vcam-stream') return;
  activePorts.add(port);
  port.postMessage({ type: 'status', state: currentState });
  void connectIfNeeded();

  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'reconnect') {
      disconnectSocket('connecting', 'Reconnecting...');
      void connectIfNeeded();
    }
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(port);
    if (activePorts.size === 0) {
      disconnectSocket('idle', 'Idle (camera stopped)');
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get-status') {
    sendResponse({ state: currentState });
    return false;
  }
  return false;
});
