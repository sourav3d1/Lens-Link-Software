const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const previewImg = document.getElementById('previewImg');
const previewEmpty = document.getElementById('previewEmpty');
const pairCodeDisplay = document.getElementById('pairCodeDisplay');
const enabledToggle = document.getElementById('enabledToggle');
const defaultToggle = document.getElementById('defaultToggle');
const refreshBtn = document.getElementById('refreshBtn');

let port = null;

function applyStatus(state) {
  if (!state) return;
  statusText.textContent = state.message || '';
  pairCodeDisplay.textContent = state.pairCode || '------';

  if (state.status === 'streaming') {
    statusBadge.textContent = 'Live';
    statusBadge.className = 'badge live';
  } else if (state.status === 'waiting') {
    statusBadge.textContent = state.pcOnline ? 'Linked' : 'Waiting';
    statusBadge.className = 'badge warn';
  } else {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'badge';
  }

  if (!state.hasVideoTrack) {
    previewImg.style.display = 'none';
    previewEmpty.style.display = 'block';
  }
}

async function init() {
  const data = await chrome.storage.local.get(['enabled', 'replaceDefaultCamera', 'pairCode']);
  enabledToggle.checked = data.enabled !== false;
  defaultToggle.checked = Boolean(data.replaceDefaultCamera);
  if (data.pairCode) {
    pairCodeDisplay.textContent = data.pairCode;
  }

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

refreshBtn.addEventListener('click', () => {
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
