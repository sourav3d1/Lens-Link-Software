const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const previewImg = document.getElementById('previewImg');
const previewEmpty = document.getElementById('previewEmpty');
const pairCodeInput = document.getElementById('pairCodeInput');
const serverOriginInput = document.getElementById('serverOriginInput');
const enabledToggle = document.getElementById('enabledToggle');
const defaultToggle = document.getElementById('defaultToggle');
const saveBtn = document.getElementById('saveBtn');

let port = null;

function applyStatus(state) {
  if (!state) return;
  statusText.textContent = state.message || '';
  if (state.status === 'streaming') {
    statusBadge.textContent = 'Streaming';
    statusBadge.className = 'badge live';
  } else if (state.status === 'waiting' || state.status === 'connecting') {
    statusBadge.textContent = state.status === 'connecting' ? 'Connecting' : 'Ready';
    statusBadge.className = 'badge warn';
  } else if (state.status === 'error') {
    statusBadge.textContent = 'Error';
    statusBadge.className = 'badge';
  } else {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'badge';
  }
}

async function init() {
  const data = await chrome.storage.local.get([
    'pairCode',
    'serverOrigin',
    'enabled',
    'replaceDefaultCamera',
  ]);
  pairCodeInput.value = data.pairCode || '';
  serverOriginInput.value = data.serverOrigin || '';
  enabledToggle.checked = data.enabled !== false;
  defaultToggle.checked = Boolean(data.replaceDefaultCamera);

  port = chrome.runtime.connect({ name: 'lenslink-vcam-stream' });
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'status') {
      applyStatus(msg.state);
    } else if (msg.type === 'frame' && msg.dataUrl) {
      previewImg.src = msg.dataUrl;
      previewImg.style.display = 'block';
      previewEmpty.style.display = 'none';
    }
  });
}

saveBtn.addEventListener('click', async () => {
  const pairCode = pairCodeInput.value.trim().toUpperCase();
  const serverOrigin = serverOriginInput.value.trim().replace(/\/+$/, '');
  await chrome.storage.local.set({
    pairCode,
    serverOrigin,
    enabled: enabledToggle.checked,
    replaceDefaultCamera: defaultToggle.checked,
  });
  if (port) {
    port.postMessage({ type: 'reconnect' });
  }
});

enabledToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: enabledToggle.checked });
});

defaultToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ replaceDefaultCamera: defaultToggle.checked });
});

void init();
