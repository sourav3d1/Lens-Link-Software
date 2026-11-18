import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Globe,
  MonitorPlay,
  Radio,
  Terminal,
} from 'lucide-react';
import { downloadBundle } from '../../lib/download';
import { FirebaseBundleSyncCard } from '../common/FirebaseBundleSyncCard';

interface VirtualCamPanelProps {
  pairCode: string;
  vcamBridgeCount: number;
  vcamWebCount: number;
  vcamWebFrameCount: number;
  bridgeStreamEnabled: boolean;
  onToggleBridgeStream: () => void;
  isLiveConnected: boolean;
  mirrorOutput: boolean;
  onToggleMirror: () => void;
}

export function VirtualCamPanel({
  pairCode,
  vcamBridgeCount,
  vcamWebCount,
  vcamWebFrameCount,
  bridgeStreamEnabled,
  onToggleBridgeStream,
  isLiveConnected,
  mirrorOutput,
  onToggleMirror,
}: VirtualCamPanelProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedFrameUrl, setCopiedFrameUrl] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [downloadingBrowserExt, setDownloadingBrowserExt] = useState(false);
  const [browserExtError, setBrowserExtError] = useState<string | null>(null);
  const [downloadingBridge, setDownloadingBridge] = useState(false);
  const [bridgeDownloadError, setBridgeDownloadError] = useState<string | null>(null);
  const [showOptionalObs, setShowOptionalObs] = useState(false);

  const wsOrigin = window.location.origin
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');

  const chromelessUrl = `${window.location.origin}/?mode=vcam&pair=${pairCode}`;
  const frameModeUrl = `${chromelessUrl}&transport=frames`;
  const cliCommand = `python lenslink_vcam.py --code ${pairCode} --server ${wsOrigin}`;
  const browserBundleUrl = `/api/browser-cam/bundle?origin=${encodeURIComponent(window.location.origin)}`;
  const windowsBundleUrl = `/api/virtual-cam/bundle?origin=${encodeURIComponent(window.location.origin)}`;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(chromelessUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleCopyFrameUrl = async () => {
    try {
      await navigator.clipboard.writeText(frameModeUrl);
      setCopiedFrameUrl(true);
      window.setTimeout(() => setCopiedFrameUrl(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleCopyCmd = async () => {
    try {
      await navigator.clipboard.writeText(cliCommand);
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 1800);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Virtual Webcam (No OBS Studio Required)
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Use your paired smartphone directly as a webcam in Google Meet, Zoom, Microsoft Teams, BIS Hallmarking portals, and Windows apps without OBS Studio or third-party suites.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggleMirror}
            className={`px-3.5 py-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
              mirrorOutput
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {mirrorOutput ? 'Mirrored Output: On' : 'Mirror Output: Off'}
          </button>
        </div>
      </div>

      {/* Primary No-OBS Virtual Webcam Options */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Option 1: Standalone Browser Virtual Webcam Extension */}
        <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                <Globe className="w-3.5 h-3.5" />
                <span>Recommended — Zero Python &amp; Zero Drivers</span>
              </div>
              <h3 className="text-base font-semibold text-slate-900">
                01. Browser Virtual Webcam Extension
              </h3>
              <p className="text-sm text-slate-600">
                Adds <span className="font-semibold text-slate-800">LensLink Wireless Camera</span> directly inside Chrome &amp; Microsoft Edge for Google Meet, Zoom Web, Teams Web, and BIS portals.
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {vcamBridgeCount > 0 ? `${vcamBridgeCount} active` : 'Ready'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={downloadingBrowserExt}
              onClick={async () => {
                setDownloadingBrowserExt(true);
                setBrowserExtError(null);
                const result = await downloadBundle(
                  browserBundleUrl,
                  'lenslink-browser-webcam.zip'
                );
                setDownloadingBrowserExt(false);
                if (!result.ok) {
                  setBrowserExtError(result.error || 'Download failed.');
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>
                {downloadingBrowserExt
                  ? 'Preparing .zip...'
                  : 'Download Browser Extension (.zip)'}
              </span>
            </button>

            <button
              type="button"
              onClick={onToggleBridgeStream}
              disabled={!isLiveConnected && !bridgeStreamEnabled}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap disabled:opacity-45 disabled:pointer-events-none ${
                bridgeStreamEnabled
                  ? 'bg-slate-900 border-slate-900 text-white hover:bg-slate-800'
                  : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
              }`}
            >
              <Radio className="w-4 h-4" />
              <span>
                {bridgeStreamEnabled ? 'Frame Relay: Active' : 'Enable Frame Relay'}
              </span>
            </button>
          </div>

          {browserExtError && (
            <p className="text-xs text-red-600 leading-relaxed">{browserExtError}</p>
          )}

          <ol className="space-y-1.5 text-xs text-slate-600 list-decimal list-inside pt-1 leading-relaxed">
            <li>
              Extract <span className="font-mono text-slate-800">lenslink-browser-webcam.zip</span> on your PC.
            </li>
            <li>
              Open <span className="font-mono text-slate-800">chrome://extensions</span> (or{' '}
              <span className="font-mono text-slate-800">edge://extensions</span>), enable{' '}
              <strong className="text-slate-800">Developer mode</strong>, click{' '}
              <strong className="text-slate-800">Load unpacked</strong>, and select the extracted folder.
            </li>
            <li>
              Keep this tab open (auto-syncs code <span className="font-mono font-semibold text-slate-900">{pairCode}</span>), then pick{' '}
              <strong className="text-slate-800">LensLink Wireless Camera</strong> in any website&apos;s camera selector.
            </li>
          </ol>
        </section>

        {/* Option 2: Standalone Windows DirectShow Driver & Bridge (No OBS) */}
        <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                For Desktop Apps (Zoom.exe, Teams.exe, Windows Camera)
              </div>
              <h3 className="text-base font-semibold text-slate-900">
                02. Windows DirectShow Driver (No OBS)
              </h3>
              <p className="text-sm text-slate-600">
                Registers a standalone Windows DirectShow virtual camera driver (<span className="font-mono text-slate-800">Unity Video Capture</span>) without installing OBS Studio.
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {vcamBridgeCount > 0 ? `${vcamBridgeCount} connected` : 'Not connected'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={downloadingBridge}
              onClick={async () => {
                setDownloadingBridge(true);
                setBridgeDownloadError(null);
                const result = await downloadBundle(
                  windowsBundleUrl,
                  'lenslink-windows-vcam.zip'
                );
                setDownloadingBridge(false);
                if (!result.ok) {
                  setBridgeDownloadError(result.error || 'Download failed.');
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>
                {downloadingBridge
                  ? 'Preparing .zip...'
                  : 'Download Windows Driver + Bridge (.zip)'}
              </span>
            </button>
          </div>

          {bridgeDownloadError && (
            <p className="text-xs text-red-600 leading-relaxed">{bridgeDownloadError}</p>
          )}

          <div className="pt-1 space-y-2">
            <ol className="space-y-1 text-xs text-slate-600 list-decimal list-inside leading-relaxed">
              <li>
                Run <span className="font-mono text-slate-800">Install_Driver_No_OBS.bat</span> once to register the standalone DirectShow camera filter.
              </li>
              <li>
                Run <span className="font-mono text-slate-800">start_virtual_cam.bat</span> (Python 3.10+) or use the launch command below:
              </li>
            </ol>

            <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
              <span className="flex items-center gap-1.5 font-medium">
                <Terminal className="w-3.5 h-3.5" />
                <span>Quick Launch Command</span>
              </span>
              <button
                type="button"
                onClick={handleCopyCmd}
                className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium"
              >
                {copiedCmd ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedCmd ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <pre className="p-3 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto tabular-nums">
              {cliCommand}
            </pre>
          </div>
        </section>
      </div>

      {/* Camera Selection Guide */}
      <section className="p-6 rounded-xl bg-white border border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">
          Selecting the Virtual Webcam in Your Apps
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">Google Meet &amp; BIS Portals</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              With the Browser Extension installed, pick <span className="font-mono text-slate-800">LensLink Wireless Camera</span> (or enable <em>Set as Default Camera</em> in the extension popup).
            </p>
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">Zoom (Web &amp; Desktop)</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              In Settings → Video → Camera, choose <span className="font-mono text-slate-800">LensLink Wireless Camera</span> (Web) or <span className="font-mono text-slate-800">Unity Video Capture</span> (Desktop).
            </p>
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">Microsoft Teams &amp; Discord</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Open Settings → Devices → Camera, then select <span className="font-mono text-slate-800">LensLink Wireless Camera</span> or <span className="font-mono text-slate-800">Unity Video Capture</span>.
            </p>
          </div>
        </div>
      </section>

      <FirebaseBundleSyncCard />

      {/* Optional Chromeless / OBS Studio Browser Source (Collapsed by Default) */}
      <section className="rounded-xl bg-white border border-slate-200 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowOptionalObs((prev) => !prev)}
          className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
        >
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Optional: Chromeless Feed URL (for OBS Studio Users Only)
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Not required unless you want to composite scenes inside OBS Studio.
              {vcamWebCount > 0 &&
                ` • ${vcamWebCount} active${vcamWebFrameCount > 0 ? ' (frame relay)' : ''}`}
            </div>
          </div>
          {showOptionalObs ? (
            <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
          )}
        </button>

        {showOptionalObs && (
          <div className="px-6 pb-6 pt-2 border-t border-slate-100 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={chromelessUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                <MonitorPlay className="w-4 h-4" />
                <span>Open Chromeless Feed</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>

              <button
                type="button"
                onClick={handleCopyUrl}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                {copiedUrl ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copiedUrl ? 'Copied URL' : 'Copy Chromeless URL'}</span>
              </button>

              <button
                type="button"
                onClick={handleCopyFrameUrl}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                {copiedFrameUrl ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                <span>{copiedFrameUrl ? 'Copied Frame URL' : 'Copy Frame Mode URL'}</span>
              </button>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 font-mono text-xs text-slate-700 truncate">
              {chromelessUrl}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
