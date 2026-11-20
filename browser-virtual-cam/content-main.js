// LensLink Virtual Webcam — MAIN World MediaDevices Provider
// Exposes "LensLink Wireless Camera" in navigator.mediaDevices.enumerateDevices() and
// navigator.mediaDevices.getUserMedia() across Chrome & Edge websites with zero OBS Studio.

(() => {
  if (window.__lenslinkVcamMainInstalled) return;

  const path = (window.location.pathname || '').toLowerCase();
  const search = (window.location.search || '').toLowerCase();
  if (
    path === '/phone' ||
    path === '/vcam' ||
    search.includes('mode=phone') ||
    search.includes('mode=vcam')
  ) {
    return;
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return;
  }

  window.__lenslinkVcamMainInstalled = true;

  const ISO_SOURCE = 'lenslink-ext-iso';
  const MAIN_SOURCE = 'lenslink-ext-main';
  const VIRTUAL_DEVICE_ID = 'lenslink-wireless-webcam';
  const VIRTUAL_GROUP_ID = 'lenslink-vcam-group';
  const VIRTUAL_LABEL = 'LensLink Wireless Webcam';

  const origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  let config = {
    enabled: true,
    replaceDefaultCamera: false,
    pairCode: '',
  };

  let statusText = 'Waiting for LensLink Desktop Client...';
  let lastFrameAt = 0;

  // Shared offscreen canvas rendered into captureStream(30)
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');

  let activeStreams = 0;
  let idleDrawTimer = null;
  let decodingFrame = false;
  let pendingDataUrl = null;
  const frameImg = new Image();

  function drawFrameDataUrl(dataUrl) {
    if (activeStreams <= 0 || !ctx) {
      decodingFrame = false;
      pendingDataUrl = null;
      return;
    }
    decodingFrame = true;
    frameImg.onload = () => {
      if (frameImg.naturalWidth > 0 && frameImg.naturalHeight > 0) {
        if (
          canvas.width !== frameImg.naturalWidth ||
          canvas.height !== frameImg.naturalHeight
        ) {
          canvas.width = frameImg.naturalWidth;
          canvas.height = frameImg.naturalHeight;
        }
        ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
        lastFrameAt = Date.now();
      }
      if (pendingDataUrl) {
        const nextUrl = pendingDataUrl;
        pendingDataUrl = null;
        drawFrameDataUrl(nextUrl);
      } else {
        decodingFrame = false;
      }
    };
    frameImg.onerror = () => {
      decodingFrame = false;
      pendingDataUrl = null;
    };
    frameImg.src = dataUrl;
  }

  function drawWaitingCard() {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(37, 99, 235, 0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(32, 32, w - 64, h - 64);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '600 32px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LensLink Wireless Webcam', w / 2, h / 2 - 18);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '400 20px system-ui, -apple-system, sans-serif';
    const sub = config.pairCode
      ? `${statusText} (Code: ${config.pairCode})`
      : statusText;
    ctx.fillText(sub, w / 2, h / 2 + 24);
  }

  function ensureIdleHeartbeat() {
    if (idleDrawTimer) return;
    drawWaitingCard();
    idleDrawTimer = window.setInterval(() => {
      if (activeStreams <= 0) {
        window.clearInterval(idleDrawTimer);
        idleDrawTimer = null;
        return;
      }
      if (Date.now() - lastFrameAt > 1500) {
        drawWaitingCard();
      }
    }, 250);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== ISO_SOURCE) {
      return;
    }
    const msg = event.data;
    if (msg.type === 'config') {
      config = {
        enabled: msg.enabled !== false,
        replaceDefaultCamera: Boolean(msg.replaceDefaultCamera),
        pairCode: msg.pairCode || '',
      };
    } else if (msg.type === 'status' && msg.state) {
      statusText = msg.state.message || statusText;
    } else if (msg.type === 'frame' && typeof msg.dataUrl === 'string') {
      if (activeStreams <= 0 || !ctx) return;
      if (decodingFrame) {
        // Always keep only the newest frame to guarantee zero latency buildup
        pendingDataUrl = msg.dataUrl;
        return;
      }
      drawFrameDataUrl(msg.dataUrl);
    }
  });

  window.postMessage({ source: MAIN_SOURCE, type: 'request-config' }, '*');

  function extractRequestedDeviceId(videoConstraint) {
    if (!videoConstraint || typeof videoConstraint !== 'object') return null;
    const raw = videoConstraint.deviceId;
    if (!raw) return null;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw[0] || null;
    if (typeof raw === 'object') {
      if (typeof raw.exact === 'string') return raw.exact;
      if (Array.isArray(raw.exact)) return raw.exact[0] || null;
      if (typeof raw.ideal === 'string') return raw.ideal;
      if (Array.isArray(raw.ideal)) return raw.ideal[0] || null;
    }
    return null;
  }

  function createVirtualVideoStream() {
    activeStreams += 1;
    ensureIdleHeartbeat();
    window.postMessage({ source: MAIN_SOURCE, type: 'start-stream' }, '*');

    const captured = canvas.captureStream(30);
    const track = captured.getVideoTracks()[0];
    let stopped = false;

    if (track) {
      const origStop = track.stop.bind(track);
      const notifyStopped = () => {
        if (stopped) return;
        stopped = true;
        activeStreams = Math.max(0, activeStreams - 1);
        window.postMessage({ source: MAIN_SOURCE, type: 'stop-stream' }, '*');
      };

      track.stop = () => {
        notifyStopped();
        origStop();
      };

      try {
        Object.defineProperty(track, 'label', {
          get: () => VIRTUAL_LABEL,
          configurable: true,
        });
      } catch {
        // Ignore non-configurable label
      }

      track.getSettings = () => ({
        width: canvas.width,
        height: canvas.height,
        frameRate: 30,
        aspectRatio: canvas.width / Math.max(1, canvas.height),
        deviceId: VIRTUAL_DEVICE_ID,
        groupId: VIRTUAL_GROUP_ID,
        facingMode: 'environment',
      });

      track.getCapabilities = () => ({
        width: { min: 320, max: 1920 },
        height: { min: 240, max: 1080 },
        frameRate: { min: 1, max: 30 },
        deviceId: VIRTUAL_DEVICE_ID,
        groupId: VIRTUAL_GROUP_ID,
        facingMode: ['environment'],
      });

      track.applyConstraints = async () => {};
    }

    return captured;
  }

  const patchedEnumerateDevices = async () => {
    let realDevices = [];
    try {
      realDevices = await origEnumerateDevices();
    } catch {
      realDevices = [];
    }

    if (!config.enabled) {
      return realDevices;
    }

    const alreadyHasVirtual = realDevices.some((d) => d.deviceId === VIRTUAL_DEVICE_ID);
    if (alreadyHasVirtual) {
      return realDevices;
    }

    const virtualDevice = {
      deviceId: VIRTUAL_DEVICE_ID,
      groupId: VIRTUAL_GROUP_ID,
      kind: 'videoinput',
      label: VIRTUAL_LABEL,
      toJSON() {
        return {
          deviceId: this.deviceId,
          groupId: this.groupId,
          kind: this.kind,
          label: this.label,
        };
      },
    };

    if (config.replaceDefaultCamera) {
      return [virtualDevice, ...realDevices];
    }
    return [...realDevices, virtualDevice];
  };

  const patchedGetUserMedia = async (constraints) => {
    const hasVideo = Boolean(constraints && constraints.video);
    if (!hasVideo || !config.enabled) {
      return origGetUserMedia(constraints);
    }

    const requestedDeviceId = extractRequestedDeviceId(constraints.video);
    const shouldUseVirtual =
      requestedDeviceId === VIRTUAL_DEVICE_ID ||
      (config.replaceDefaultCamera && !requestedDeviceId);

    if (!shouldUseVirtual) {
      return origGetUserMedia(constraints);
    }

    const virtualStream = createVirtualVideoStream();

    if (constraints.audio) {
      try {
        const audioStream = await origGetUserMedia({ audio: constraints.audio, video: false });
        for (const audioTrack of audioStream.getAudioTracks()) {
          virtualStream.addTrack(audioTrack);
        }
      } catch {
        // Proceed with video-only stream if audio permission is unavailable
      }
    }

    return virtualStream;
  };

  try {
    navigator.mediaDevices.enumerateDevices = patchedEnumerateDevices;
  } catch {
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      value: patchedEnumerateDevices,
      configurable: true,
    });
  }

  try {
    navigator.mediaDevices.getUserMedia = patchedGetUserMedia;
  } catch {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: patchedGetUserMedia,
      configurable: true,
    });
  }
})();
