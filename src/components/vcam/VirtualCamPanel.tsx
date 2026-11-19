import { useState } from 'react';
import {
  Check,
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
  extConnected?: boolean;
  extRelayActive?: boolean;
  obsConnected?: boolean;
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
  extConnected = false,
  extRelayActive = false,
  obsConnected = false,
  vcamWebCount,
  vcamWebFrameCount,
  bridgeStreamEnabled,
  onToggleBridgeStream,
  isLiveConnected,
  mirrorOutput,
  onToggleMirror,
}: VirtualCamPanelProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [downloadingBrowserExt, setDownloadingBrowserExt] = useState(false);
  const [browserExtError, setBrowserExtError] = useState<string | null>(null);
  const [downloadingBridge, setDownloadingBridge] = useState(false);
  const [bridgeDownloadError, setBridgeDownloadError] = useState<string | null>(null);

  const wsOrigin = window.location.origin
    .replace(/^https:\/\//i, 'wss://')
    .replace(/^http:\/\//i, 'ws://');

  const obsUrl = `${window.location.origin}/?mode=vcam&pair=${pairCode}`;
  const cliCommand = `python lenslink_vcam.py --code ${pairCode} --server ${wsOrigin}`;
  const browserBundleUrl = `/api/browser-cam/bundle?origin=${encodeURIComponent(window.location.origin)}`;
  const windowsBundleUrl = `/api/virtual-cam/bundle?origin=${encodeURIComponent(window.location.origin)}`;

  const isObsLive = obsConnected || vcamWebCount > 0;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(obsUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
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
            Use Phone Camera in Apps &amp; OBS Studio
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Stream directly to OBS Studio via hardware-accelerated WebRTC, or use the Chrome/Edge extension for Google Meet, Zoom, Teams, and BIS portals with zero extra apps.
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

      {/* Primary Output Cards: OBS Studio + Chrome Extension */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Option 1: OBS Studio Browser Source (Persistent URL, Works Everywhere) */}
        <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-blue-700">
                <MonitorPlay className="w-3.5 h-3.5" />
                <span>Direct Low-Latency WebRTC · Persistent URL</span>
              </div>
              <h3 className="text-base font-semibold text-slate-900">
                01. OBS Studio Browser Source
              </h3>
              <p className="text-sm text-slate-600">
                Smooth 30–60 fps direct stream into OBS Studio on both hosted and local connections. Because your code <span className="font-mono font-semibold text-slate-900">{pairCode}</span> stays saved on this PC, you only paste this URL once.
              </p>
            </div>
            <span
              className={`text-xs font-mono tabular-nums whitespace-nowrap ${
                isObsLive ? 'text-emerald-700 font-semibold' : 'text-slate-500'
              }`}
            >
              {isObsLive
                ? `OBS Connected${vcamWebFrameCount > 0 ? ' (frames)' : ''}`
                : 'Ready'}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 font-mono text-xs text-slate-700 break-all select-all">
            {obsUrl}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleCopyUrl}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              {copiedUrl ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedUrl ? 'Copied OBS URL' : 'Copy OBS Browser URL'}</span>
            </button>

            <a
              href={obsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Test Feed in Tab</span>
            </a>
          </div>

          <ol className="space-y-1.5 text-xs text-slate-600 list-decimal list-inside pt-1 leading-relaxed">
            <li>
              In OBS Studio, click <strong className="text-slate-800">Sources → + → Browser</strong> and name it <span className="font-mono text-slate-800">LensLink</span>.
            </li>
            <li>
              Paste the URL above, set <strong className="text-slate-800">Width 1280</strong>, <strong className="text-slate-800">Height 720</strong>, and set <strong className="text-slate-800">FPS 30</strong> (or 60).
            </li>
            <li>
              Keep this LensLink PC window open (or minimized — do not close it). Click <strong className="text-slate-800">Start Virtual Camera</strong> in OBS to use it in Zoom, Teams, or Discord.
            </li>
          </ol>
        </section>

        {/* Option 2: Standalone Browser Virtual Webcam Extension (v1.2 — Zero OBS) */}
        <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <Globe className="w-3.5 h-3.5" />
                <span>Zero OBS · Zero Python · Zero Drivers</span>
              </div>
              <h3 className="text-base font-semibold text-slate-900">
                02. Chrome / Edge Virtual Webcam (v1.2)
              </h3>
              <p className="text-sm text-slate-600">
                Adds <span className="font-semibold text-slate-800">LensLink Wireless Camera</span> directly inside Chrome &amp; Edge for Google Meet, Zoom Web, Teams Web, and BIS portals using low-latency async frames.
              </p>
            </div>
            <span
              className={`text-xs font-mono tabular-nums whitespace-nowrap ${
                extRelayActive
                  ? 'text-emerald-700 font-semibold'
                  : extConnected
                    ? 'text-blue-700 font-semibold'
                    : 'text-slate-500'
              }`}
            >
              {extRelayActive
                ? 'Streaming Direct'
                : extConnected
                  ? 'Extension Linked'
                  : 'Ready (v1.2)'}
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
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>
                {downloadingBrowserExt
                  ? 'Preparing .zip...'
                  : 'Download Extension v1.2 (.zip)'}
              </span>
            </button>

            <button
              type="button"
              onClick={onToggleBridgeStream}
              disabled={!isLiveConnected && !bridgeStreamEnabled}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap disabled:opacity-45 disabled:pointer-events-none ${
                bridgeStreamEnabled
                  ? 'bg-emerald-700 border-emerald-700 text-white hover:bg-emerald-800'
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
              Extract <span className="font-mono text-slate-800">lenslink-browser-webcam.zip</span> to a folder on your PC.
            </li>
            <li>
              Open <span className="font-mono text-slate-800">chrome://extensions</span> (or{' '}
              <span className="font-mono text-slate-800">edge://extensions</span>), turn on{' '}
              <strong className="text-slate-800">Developer mode</strong>, and click{' '}
              <strong className="text-slate-800">Load unpacked</strong> (or click Reload if upgrading).
            </li>
            <li>
              Keep this window open, then pick{' '}
              <strong className="text-slate-800">LensLink Wireless Camera</strong> in any website&apos;s camera dropdown.
            </li>
          </ol>
        </section>
      </div>

      {/* Option 3: Standalone Windows DirectShow Driver & Bridge */}
      <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Desktop Apps (Zoom.exe, Teams.exe, Windows Camera) without OBS
            </div>
            <h3 className="text-base font-semibold text-slate-900">
              03. Windows DirectShow Driver &amp; Bridge
            </h3>
            <p className="text-sm text-slate-600">
              Registers a standalone Windows DirectShow virtual camera filter (<span className="font-mono text-slate-800">Unity Video Capture</span>) for native desktop apps on a local network server.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {vcamBridgeCount > 0 ? `${vcamBridgeCount} connected` : 'Optional'}
            </span>
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
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>
                {downloadingBridge ? 'Preparing .zip...' : 'Download Windows Driver (.zip)'}
              </span>
            </button>
          </div>
        </div>

        {bridgeDownloadError && (
          <p className="text-xs text-red-600 leading-relaxed">{bridgeDownloadError}</p>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-1 items-center">
          <ol className="space-y-1 text-xs text-slate-600 list-decimal list-inside leading-relaxed">
            <li>
              Run <span className="font-mono text-slate-800">Install_Driver_No_OBS.bat</span> once as Administrator to register the DirectShow camera.
            </li>
            <li>
              Run <span className="font-mono text-slate-800">start_virtual_cam.bat</span> (Python 3.10+) or run the launch command shown here.
            </li>
          </ol>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span className="flex items-center gap-1.5 font-medium">
                <Terminal className="w-3.5 h-3.5" />
                <span>CLI Bridge Command</span>
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
            <pre className="p-2.5 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs overflow-x-auto tabular-nums">
              {cliCommand}
            </pre>
          </div>
        </div>
      </section>

      <FirebaseBundleSyncCard />
    </div>
  );
}
