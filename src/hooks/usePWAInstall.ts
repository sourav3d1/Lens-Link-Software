import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface Window {
    __lenslinkDeferredPrompt?: BeforeInstallPromptEvent | null;
    __lenslinkAppInstalled?: boolean;
  }
}

let sharedDeferredPrompt: BeforeInstallPromptEvent | null =
  typeof window !== 'undefined' ? window.__lenslinkDeferredPrompt || null : null;
let sharedIsInstalled =
  typeof window !== 'undefined' ? Boolean(window.__lenslinkAppInstalled) : false;

const listeners = new Set<() => void>();

function notifyListeners() {
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    sharedDeferredPrompt = e as BeforeInstallPromptEvent;
    window.__lenslinkDeferredPrompt = sharedDeferredPrompt;
    notifyListeners();
  });

  window.addEventListener('lenslink:install-ready', () => {
    if (window.__lenslinkDeferredPrompt) {
      sharedDeferredPrompt = window.__lenslinkDeferredPrompt;
      notifyListeners();
    }
  });

  window.addEventListener('appinstalled', () => {
    sharedDeferredPrompt = null;
    sharedIsInstalled = true;
    window.__lenslinkDeferredPrompt = null;
    window.__lenslinkAppInstalled = true;
    notifyListeners();
  });

  window.addEventListener('lenslink:app-installed', () => {
    sharedDeferredPrompt = null;
    sharedIsInstalled = true;
    notifyListeners();
  });
}

function checkStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    sharedIsInstalled ||
    Boolean(window.__lenslinkAppInstalled) ||
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(() => {
    if (typeof window !== 'undefined' && window.__lenslinkDeferredPrompt) {
      sharedDeferredPrompt = window.__lenslinkDeferredPrompt;
    }
    return sharedDeferredPrompt;
  });
  const [isInstalled, setIsInstalled] = useState<boolean>(checkStandalone);
  const [isIOS, setIsIOS] = useState(false);
  const [isAndroid, setIsAndroid] = useState(false);

  useEffect(() => {
    setIsInstalled(checkStandalone());
    if (window.__lenslinkDeferredPrompt && !sharedDeferredPrompt) {
      sharedDeferredPrompt = window.__lenslinkDeferredPrompt;
    }
    setDeferredPrompt(sharedDeferredPrompt);

    const userAgent = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(userAgent));
    setIsAndroid(/android/.test(userAgent));

    const sync = () => {
      setDeferredPrompt(sharedDeferredPrompt);
      setIsInstalled(checkStandalone());
    };
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const install = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const promptEvent = sharedDeferredPrompt || window.__lenslinkDeferredPrompt || deferredPrompt;
    if (!promptEvent) return 'unavailable';
    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      sharedDeferredPrompt = null;
      window.__lenslinkDeferredPrompt = null;
      if (outcome === 'accepted') {
        sharedIsInstalled = true;
        window.__lenslinkAppInstalled = true;
        notifyListeners();
        return 'accepted';
      }
      notifyListeners();
      return 'dismissed';
    } catch {
      return 'unavailable';
    }
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    isAndroid,
    install,
  };
}

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
