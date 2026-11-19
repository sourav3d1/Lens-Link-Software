// LensLink Virtual Webcam — MV3 Background Service Worker (Direct Browser Relay)
// Relays live video frames directly from the open LensLink PC Receiver tab to any website
// (Google Meet, Zoom Web, Teams Web, BIS portals) via Chrome Extension ports — zero WebSocket /ws required.

const pcSourcePorts = new Map(); // Port -> { pairCode, pcOnline, phoneOnline, phoneName, hasVideoTrack }
const consumerPorts = new Set(); // Set<Port> for websites & popup

let enabledCache = true;
let lastFrameDataUrl = '';
let currentState = {
  status: 'waiting', // 'idle' | 'waiting' | 'streaming'
  message: 'Open LensLink PC Receiver tab to connect',
  pairCode: '',
  pcOnline: false,
  phoneOnline: false,
  hasVideoTrack: false,
};

async function ensureDefaultConfig() {
  const stored = await chrome.storage.local.get(['enabled', 'replaceDefaultCamera']);
  const updates = {};

  if (typeof stored.enabled !== 'boolean') {
    updates.enabled = true;
    enabledCache = true;
  } else {
    enabledCache = stored.enabled;
  }

  if (typeof stored.replaceDefaultCamera !== 'boolean') {
    updates.replaceDefaultCamera = false;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function getPrimaryPcMeta() {
  // Prefer a PC tab that currently has an active video track; otherwise the most recently registered PC tab
  let fallback = null;
  for (const meta of pcSourcePorts.values()) {
    if (meta.hasVideoTrack) return meta;
    fallback = meta;
  }
  return fallback;
}

function broadcastToConsumers(payload) {
  for (const port of consumerPorts) {
    try {
      port.postMessage(payload);
    } catch {
      consumerPorts.delete(port);
    }
  }
}

function syncRelayControlToPcTabs() {
  const shouldRelay = enabledCache !== false && consumerPorts.size > 0;
  for (const port of pcSourcePorts.keys()) {
    try {
      port.postMessage({ type: 'relay-control', active: shouldRelay });
    } catch {
      pcSourcePorts.delete(port);
    }
  }
}

function recomputeAndBroadcastStatus() {
  const meta = getPrimaryPcMeta();
  const hasConsumers = consumerPorts.size > 0;

  if (enabledCache === false) {
    currentState = {
      status: 'idle',
      message: 'Virtual webcam disabled in extension popup',
      pairCode: meta ? meta.pairCode : '',
      pcOnline: Boolean(meta),
      phoneOnline: Boolean(meta && meta.phoneOnline),
      hasVideoTrack: Boolean(meta && meta.hasVideoTrack),
    };
  } else if (!meta) {
    lastFrameDataUrl = '';
    currentState = {
      status: 'waiting',
      message: 'Open the LensLink PC Receiver tab in this browser',
      pairCode: '',
      pcOnline: false,
      phoneOnline: false,
      hasVideoTrack: false,
    };
  } else if (meta.hasVideoTrack) {
    const codeLabel = meta.pairCode ? ` (${meta.pairCode})` : '';
    const phoneLabel = meta.phoneName || 'Smartphone';
    currentState = {
      status: hasConsumers ? 'streaming' : 'waiting',
      message: hasConsumers
        ? `Streaming live from ${phoneLabel}${codeLabel}`
        : `Ready from ${phoneLabel}${codeLabel} — select LensLink Wireless Camera`,
      pairCode: meta.pairCode || '',
      pcOnline: true,
      phoneOnline: true,
      hasVideoTrack: true,
    };
  } else if (meta.phoneOnline) {
    lastFrameDataUrl = '';
    currentState = {
      status: 'waiting',
      message: `Phone paired (${meta.pairCode || 'active'}) — waiting for video stream`,
      pairCode: meta.pairCode || '',
      pcOnline: true,
      phoneOnline: true,
      hasVideoTrack: false,
    };
  } else {
    lastFrameDataUrl = '';
    currentState = {
      status: 'waiting',
      message: `Connected to PC Receiver${meta.pairCode ? ` (${meta.pairCode})` : ''} — scan QR with smartphone`,
      pairCode: meta.pairCode || '',
      pcOnline: true,
      phoneOnline: false,
      hasVideoTrack: false,
    };
  }

  broadcastToConsumers({ type: 'status', state: currentState });
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultConfig();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultConfig();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.enabled) {
    enabledCache = changes.enabled.newValue !== false;
    syncRelayControlToPcTabs();
    recomputeAndBroadcastStatus();
  }
});

chrome.runtime.onConnect.addListener((port) => {
  // 1. LensLink PC Receiver Tab Source Connection
  if (port.name === 'lenslink-pc-source') {
    pcSourcePorts.set(port, {
      pairCode: '',
      pcOnline: true,
      phoneOnline: false,
      phoneName: 'Smartphone',
      hasVideoTrack: false,
    });

    // Tell PC tab whether any website/popup is currently requesting frames
    try {
      port.postMessage({
        type: 'relay-control',
        active: enabledCache !== false && consumerPorts.size > 0,
      });
    } catch {
      pcSourcePorts.delete(port);
      return;
    }

    recomputeAndBroadcastStatus();

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      const meta = pcSourcePorts.get(port);
      if (!meta) return;

      if (msg.type === 'pc-register' || msg.type === 'pc-status') {
        if (typeof msg.pairCode === 'string' && msg.pairCode) {
          meta.pairCode = msg.pairCode.trim().toUpperCase();
        }
        if (typeof msg.phoneOnline === 'boolean') meta.phoneOnline = msg.phoneOnline;
        if (typeof msg.phoneName === 'string' && msg.phoneName) meta.phoneName = msg.phoneName;
        if (typeof msg.hasVideoTrack === 'boolean') {
          meta.hasVideoTrack = msg.hasVideoTrack;
          if (!msg.hasVideoTrack) lastFrameDataUrl = '';
        }
        recomputeAndBroadcastStatus();
        return;
      }

      if (msg.type === 'pc-frame' && typeof msg.dataUrl === 'string' && msg.dataUrl.length > 0) {
        if (enabledCache === false || consumerPorts.size === 0) return;
        meta.hasVideoTrack = true;
        meta.phoneOnline = true;
        lastFrameDataUrl = msg.dataUrl;
        if (currentState.status !== 'streaming') {
          recomputeAndBroadcastStatus();
        }
        broadcastToConsumers({ type: 'frame', dataUrl: msg.dataUrl });
      }
    });

    port.onDisconnect.addListener(() => {
      pcSourcePorts.delete(port);
      recomputeAndBroadcastStatus();
    });
    return;
  }

  // 2. Consumer Connection (Websites calling getUserMedia & Extension Popup preview)
  if (port.name === 'lenslink-vcam-stream') {
    consumerPorts.add(port);
    void ensureDefaultConfig().then(() => {
      syncRelayControlToPcTabs();
      recomputeAndBroadcastStatus();
      if (lastFrameDataUrl && enabledCache !== false) {
        try {
          port.postMessage({ type: 'frame', dataUrl: lastFrameDataUrl });
        } catch {
          consumerPorts.delete(port);
        }
      }
    });

    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'reconnect') {
        syncRelayControlToPcTabs();
        recomputeAndBroadcastStatus();
      }
    });

    port.onDisconnect.addListener(() => {
      consumerPorts.delete(port);
      syncRelayControlToPcTabs();
      recomputeAndBroadcastStatus();
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get-status') {
    sendResponse({ state: currentState });
    return false;
  }
  return false;
});
