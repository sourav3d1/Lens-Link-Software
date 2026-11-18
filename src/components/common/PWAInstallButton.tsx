import { useState } from 'react';
import { Download, MonitorDown, CheckCircle2, X, WifiOff } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  const windowsBundleUrl = `/api/pc-app/bundle?origin=${encodeURIComponent(window.location.origin)}`;

  if (isInstalled) {
    return (
      <div className="p-4 rounded-xl bg-white border border-slate-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>Installed as Standalone App</span>
        </div>
        <a
          href={windowsBundleUrl}
          download="lenslink-pc-windows.zip"
          className="text-xs font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap"
        >
          Win Tools (.zip)
        </a>
      </div>
    );
  }

  return (
    <>
      <section className="p-5 rounded-xl bg-white border border-slate-200 space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">Install PC App</h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            Install LensLink on this Windows PC or download the standalone launcher. Each launch generates its own dynamic session QR code.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {isInstallable ? (
            <button
              type="button"
              onClick={() => void install()}
              className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
            >
              <MonitorDown className="w-4 h-4" />
              <span>Install Desktop App</span>
            </button>
          ) : isIOS ? (
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
            >
              <MonitorDown className="w-4 h-4" />
              <span>Install on iOS</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowGuide(true)}
              className="w-full py-2.5 px-4 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
            >
              <MonitorDown className="w-4 h-4" />
              <span>How to Install Desktop App</span>
            </button>
          )}

          <a
            href={windowsBundleUrl}
            download="lenslink-pc-windows.zip"
            className="w-full py-2 px-4 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download Windows Installer (.zip)</span>
          </a>
        </div>
      </section>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white border border-slate-200 p-6 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {isIOS ? 'Install on iPhone / iPad' : 'Install LensLink on Windows PC'}
              </h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close install instructions"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="space-y-2 text-sm text-slate-600 list-decimal list-inside">
                <li>Tap the <strong>Share</strong> icon in the Safari toolbar.</li>
                <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              </ol>
            ) : (
              <div className="space-y-3 text-sm text-slate-600">
                <p>
                  You can install LensLink directly from Microsoft Edge or Google Chrome, or use the downloadable Windows package:
                </p>
                <ol className="space-y-1.5 list-decimal list-inside text-xs leading-relaxed">
                  <li>
                    <strong>Browser Install:</strong> Click the <strong>Install App</strong> icon in the Edge/Chrome address bar (or Menu → Apps → Install LensLink).
                  </li>
                  <li>
                    <strong>Downloadable Package:</strong> Download <strong>lenslink-pc-windows.zip</strong>, extract it, and run <span className="font-mono text-slate-800">Install_LensLink_Desktop.bat</span> to create a Desktop &amp; Start Menu shortcut.
                  </li>
                </ol>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              {!isIOS && (
                <a
                  href={windowsBundleUrl}
                  download="lenslink-pc-windows.zip"
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download .zip</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium"
              >
                Close
              </button>
            </div>
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
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>Network Offline — Waiting for Wi-Fi connection</span>
    </div>
  );
}
