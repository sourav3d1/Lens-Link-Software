import { useState } from 'react';
import { Download, MonitorDown, Share, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  const handleClick = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome === 'unavailable') setShowGuide(true);
      return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
      >
        <MonitorDown className="h-3.5 w-3.5 text-[#1D4ED8]" />
        <span>Install App</span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-xs"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                {isIOS ? 'Install LensLink on iOS' : 'Install LensLink Desktop App'}
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="mt-3 list-inside list-decimal space-y-2 text-xs leading-relaxed text-slate-600">
                <li>
                  Tap <strong className="text-slate-900">Share</strong> in Safari.
                </li>
                <li>
                  Select <strong className="text-slate-900">Add to Home Screen</strong>.
                </li>
              </ol>
            ) : (
              <p className="mt-3 text-xs leading-relaxed text-slate-600">
                Click the <strong className="text-slate-900">Install App</strong> icon in your Chrome
                or Microsoft Edge address bar, or open the <strong className="text-slate-900">Virtual Driver</strong> tab
                to download the full Windows Installer & DirectShow virtual webcam driver.
              </p>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full rounded-xl bg-[#1D4ED8] py-2 text-xs font-medium text-white hover:bg-[#1E40AF]"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function MobilePWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  const handleClick = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome === 'unavailable') setShowGuide(true);
      return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        className="inline-flex items-center gap-1 rounded-lg bg-[#EFF6FF] px-2.5 py-1.5 text-xs font-semibold text-[#1D4ED8]"
      >
        <Download className="h-3.5 w-3.5" />
        Install
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Install LensLink Cam on Phone</h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="mt-3 list-inside list-decimal space-y-2 text-xs text-slate-600">
                <li>
                  Tap <Share className="inline h-3.5 w-3.5" /> <strong>Share</strong> in Safari.
                </li>
                <li>
                  Tap <strong>Add to Home Screen</strong>.
                </li>
              </ol>
            ) : (
              <ol className="mt-3 list-inside list-decimal space-y-2 text-xs text-slate-600">
                <li>Open Chrome menu (⋮) in the top-right corner.</li>
                <li>
                  Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
                </li>
              </ol>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-4 w-full rounded-xl bg-[#1D4ED8] py-2.5 text-xs font-semibold text-white"
            >
              Got It
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>Wi-Fi Offline — Automatic reconnection armed</span>
    </div>
  );
}
