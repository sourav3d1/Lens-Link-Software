import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { ErrorBoundary } from './components/common/ErrorBoundary.tsx';
import './index.css';

// Point mobile camera sessions to the dedicated installable mobile PWA manifest
const params = new URLSearchParams(window.location.search);
const path = window.location.pathname.toLowerCase();
const modeParam = params.get('mode')?.toLowerCase();
const hasPair = Boolean(params.get('pair') || params.get('code'));
const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobileAppRoute =
  modeParam !== 'vcam' &&
  path !== '/vcam' &&
  modeParam !== 'pc' &&
  (modeParam === 'phone' || path === '/phone' || hasPair || isMobileUa);

if (isMobileAppRoute) {
  let manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!manifestLink) {
    manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    document.head.appendChild(manifestLink);
  }
  manifestLink.href = '/phone-manifest.webmanifest';

  const appleTitle = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (appleTitle) {
    appleTitle.content = 'LensLink Cam';
  }
  document.title = 'LensLink Cam — Wireless Phone Webcam';
}

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
