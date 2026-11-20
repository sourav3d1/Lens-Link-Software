import { useEffect, useState } from 'react';
import { AppMode } from './types/lenslink';
import { LensLinkDesktopClient } from './components/windows/LensLinkDesktopClient';
import { LensLinkMobileApp } from './components/mobile/LensLinkMobileApp';
import { VirtualCamOutputView } from './components/vcam/VirtualCamOutputView';
import { OfflineIndicator } from './components/common/PWAInstallButton';

function parseRouteState(): { mode: AppMode; initialRoomCode: string | null } {
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname.toLowerCase();
  const modeParam = (params.get('mode') || '').toLowerCase();
  const rawCode = (params.get('code') || params.get('pair') || '').trim().toUpperCase();
  const validCode = /^[A-Z0-9]{6}$/.test(rawCode) ? rawCode : null;

  if (path === '/vcam' || modeParam === 'vcam') {
    return { mode: 'vcam', initialRoomCode: validCode };
  }

  if (modeParam === 'pc' || modeParam === 'desktop') {
    return { mode: 'desktop', initialRoomCode: validCode };
  }

  const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  if (path === '/phone' || modeParam === 'phone' || modeParam === 'mobile' || validCode || isMobileUa) {
    return { mode: 'mobile', initialRoomCode: validCode };
  }

  return { mode: 'desktop', initialRoomCode: null };
}

export function App() {
  const [route, setRoute] = useState<{ mode: AppMode; initialRoomCode: string | null }>(() =>
    parseRouteState()
  );

  useEffect(() => {
    const onPopState = () => setRoute(parseRouteState());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  if (route.mode === 'vcam') {
    return <VirtualCamOutputView pairCode={route.initialRoomCode || ''} />;
  }

  if (route.mode === 'mobile') {
    return (
      <>
        <LensLinkMobileApp
          initialRoomCode={route.initialRoomCode}
          onSwitchToDesktop={() => setRoute({ mode: 'desktop', initialRoomCode: null })}
        />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <>
      <LensLinkDesktopClient
        onSwitchToMobile={() => setRoute({ mode: 'mobile', initialRoomCode: null })}
      />
      <OfflineIndicator />
    </>
  );
}

export default App;
