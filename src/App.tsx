import { useState } from 'react';
import { PcReceiverView } from './components/pc/PcReceiverView';
import { PhoneCameraView } from './components/phone/PhoneCameraView';
import { VirtualCamOutputView } from './components/vcam/VirtualCamOutputView';
import { OfflineIndicator } from './components/common/PWAInstallButton';

type AppMode = 'pc' | 'phone' | 'vcam';

function getInitialRoute(): { mode: AppMode; pairCode: string } {
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.toLowerCase();
  const rawPair = (params.get('pair') || params.get('code') || '').toUpperCase().trim();
  const pairCode = /^[A-Z0-9]{6}$/.test(rawPair) ? rawPair : '';
  const modeParam = params.get('mode')?.toLowerCase();

  if (modeParam === 'vcam' || path === '/vcam') {
    return { mode: 'vcam', pairCode };
  }
  if (modeParam === 'phone' || path === '/phone' || pairCode) {
    return { mode: 'phone', pairCode };
  }
  if (modeParam === 'pc') {
    return { mode: 'pc', pairCode: '' };
  }

  // Default mobile browsers to Smartphone Camera view, desktop browsers to PC Receiver
  const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return {
    mode: isMobileUa ? 'phone' : 'pc',
    pairCode: '',
  };
}

export default function App() {
  const initial = getInitialRoute();
  const [mode, setMode] = useState<AppMode>(initial.mode);
  const [pairCode, setPairCode] = useState<string>(initial.pairCode);

  return (
    <>
      {mode === 'vcam' ? (
        <VirtualCamOutputView pairCode={pairCode} />
      ) : mode === 'phone' ? (
        <PhoneCameraView
          initialPairCode={pairCode}
          onSwitchToPc={() => {
            setMode('pc');
            window.history.replaceState({}, '', '/?mode=pc');
          }}
        />
      ) : (
        <PcReceiverView
          onOpenPhoneMode={(code) => {
            setPairCode(code);
            setMode('phone');
          }}
        />
      )}
      <OfflineIndicator />
    </>
  );
}
