import { useState } from 'react';
import {
  Download,
  MonitorDown,
  CheckCircle2,
  X,
  WifiOff,
  Smartphone,
  Share,
} from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../../hooks/usePWAInstall';
import { downloadBundle } from '../../lib/download';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [downloadingWin, setDownloadingWin] = useState(false);

  const windowsBundleUrl = `/api/pc-app/bundle?origin=${encodeURIComponent(window.location.origin)}`;

  const handleDownloadWin = async () => {
    setDownloadingWin(true);
    await downloadBundle(windowsBundleUrl, 'lenslink-pc-windows.zip');
    setDownloadingWin(false);
  };

  if (isInstalled) {
    return (
      <div className="p-4 rounded-xl bg-white border border-slate-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>Installed as Standalone App</span>
        </div>
        <button
          type="button"
          disabled={downloadingWin}
          onClick={() => void handleDownloadWin()}
          className="text-xs font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap disabled:opacity-60"
        >
          {downloadingWin ? 'Preparing...' : 'Win Tools (.zip)'}
        </button>
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

          <button
            type="button"
            disabled={downloadingWin}
            onClick={() => void handleDownloadWin()}
            className="w-full py-2 px-4 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{downloadingWin ? 'Preparing .zip...' : 'Download Windows Installer (.zip)'}</span>
          </button>
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
                <button
                  type="button"
                  disabled={downloadingWin}
                  onClick={() => void handleDownloadWin()}
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{downloadingWin ? 'Preparing...' : 'Download .zip'}</span>
                </button>
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

export function MobilePWAInstallButton({
  variant = 'banner',
}: {
  variant?: 'banner' | 'icon';
}) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [httpsOrigin, setHttpsOrigin] = useState<string | null>(null);

  if (isInstalled) return null;

  const openFallbackGuide = () => {
    setShowGuide(true);
    if (window.location.protocol !== 'https:' && !httpsOrigin) {
      fetch('/api/network-info')
        .then((r) => r.json())
        .then((data: { httpsOrigin?: string | null }) => {
          if (data.httpsOrigin) setHttpsOrigin(data.httpsOrigin);
        })
        .catch(() => {});
    }
  };

  const handleAction = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome === 'unavailable') {
        openFallbackGuide();
      }
      return;
    }
    openFallbackGuide();
  };

  if (variant === 'icon') {
    return (
      <>
        <button
          type="button"
          onClick={() => void handleAction()}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-white/10 text-blue-400"
          aria-label="Install LensLink Cam app"
          title="Install LensLink Cam"
        >
          <Download className="w-5 h-5" />
        </button>
        {showGuide && (
          <MobileInstallGuideModal
            isIOS={isIOS}
            httpsOrigin={httpsOrigin}
            onClose={() => setShowGuide(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white truncate">
              Install LensLink Cam App
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {isInstallable
                ? 'Tap Install to add to home screen'
                : isIOS
                  ? 'Add to iPhone Home Screen'
                  : 'Use as standalone mobile app'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleAction()}
          className="min-h-[40px] px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white text-xs font-semibold whitespace-nowrap shrink-0 transition-all"
        >
          {isInstallable ? 'Install' : 'Install App'}
        </button>
      </div>

      {showGuide && (
        <MobileInstallGuideModal
          isIOS={isIOS}
          httpsOrigin={httpsOrigin}
          onClose={() => setShowGuide(false)}
        />
      )}
    </>
  );
}

function MobileInstallGuideModal({
  isIOS,
  httpsOrigin,
  onClose,
}: {
  isIOS: boolean;
  httpsOrigin: string | null;
  onClose: () => void;
}) {
  const isPlainHttp =
    typeof window !== 'undefined' &&
    window.location.protocol !== 'https:' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-slate-900 border border-slate-700 p-5 space-y-4 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">
            {isIOS ? 'Install on iPhone / iPad' : 'Install LensLink Cam'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl bg-slate-800 text-slate-300"
            aria-label="Close install instructions"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {isIOS ? (
          <ol className="space-y-2.5 text-sm text-slate-300 list-decimal list-inside">
            <li>
              Tap the{' '}
              <strong className="text-white inline-flex items-center gap-1">
                <Share className="w-3.5 h-3.5 inline" /> Share
              </strong>{' '}
              button in Safari.
            </li>
            <li>
              Scroll down and tap <strong className="text-white">Add to Home Screen</strong>.
            </li>
            <li>
              Open <strong className="text-white">LensLink Cam</strong> from your Home Screen.
            </li>
          </ol>
        ) : (
          <div className="space-y-3">
            <ol className="space-y-2 text-sm text-slate-300 list-decimal list-inside">
              <li>
                Open your browser menu (<strong className="text-white">⋮</strong>) in the top right.
              </li>
              <li>
                Tap <strong className="text-white">Add to Home screen</strong> or{' '}
                <strong className="text-white">Install app</strong>.
              </li>
              <li>
                Launch <strong className="text-white">LensLink Cam</strong> from your app drawer.
              </li>
            </ol>

            {isPlainHttp && (
              <div className="p-3 rounded-xl bg-slate-800/80 border border-slate-700 text-xs text-slate-300 space-y-2">
                <p>
                  Note: Over local <span className="font-mono">http://</span> Wi-Fi addresses, Android Chrome shows{' '}
                  <strong className="text-white">Add to Home screen</strong> in the browser menu instead of an automatic popup.
                </p>
                {httpsOrigin && (
                  <a
                    href={`${httpsOrigin}/phone`}
                    className="w-full min-h-[40px] px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold inline-flex items-center justify-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Open HTTPS Link for 1-Tap Install</span>
                  </a>
                )}
              </div>
            )}

            <div className="pt-1 border-t border-slate-800 flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-400">Want the native Kotlin source?</span>
              <button
                type="button"
                onClick={() =>
                  void downloadBundle(
                    `/api/android-app/bundle?origin=${encodeURIComponent(window.location.origin)}`,
                    'lenslink-android-studio.zip'
                  )
                }
                className="text-blue-400 hover:text-blue-300 font-semibold whitespace-nowrap"
              >
                Android Studio (.zip)
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="w-full min-h-[44px] rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold"
        >
          Done
        </button>
      </div>
    </div>
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
