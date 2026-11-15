import { useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  MonitorPlay,
  Radio,
  Terminal,
} from 'lucide-react';

interface VirtualCamPanelProps {
  pairCode: string;
  vcamBridgeCount: number;
  vcamWebCount: number;
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
  bridgeStreamEnabled,
  onToggleBridgeStream,
  isLiveConnected,
  mirrorOutput,
  onToggleMirror,
}: VirtualCamPanelProps) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const chromelessUrl = `${window.location.origin}/?mode=vcam&pair=${pairCode}`;
  const cliCommand = `python lenslink_vcam.py --code ${pairCode}`;

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(chromelessUrl);
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
            Windows Virtual Webcam Component
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Expose your smartphone feed as a standard camera device in Zoom, Google Meet, Microsoft Teams, and OBS Studio.
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

      {/* Live Output Status Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Option 1: Direct Windows Virtual Camera Driver Bridge */}
        <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900">
                01. Windows DirectShow Bridge
              </h3>
              <p className="text-sm text-slate-600">
                Streams frames directly to the Windows Virtual Camera driver via our lightweight local Python bridge.
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {vcamBridgeCount > 0 ? `${vcamBridgeCount} connected` : 'Not connected'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href="/api/virtual-cam/bundle"
              download="lenslink-windows-vcam.zip"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>Download Windows Bridge (.zip)</span>
            </a>

            <button
              type="button"
              onClick={onToggleBridgeStream}
              disabled={!isLiveConnected && !bridgeStreamEnabled}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap disabled:opacity-45 disabled:pointer-events-none ${
                bridgeStreamEnabled
                  ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                  : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-50'
              }`}
            >
              <Radio className="w-4 h-4" />
              <span>
                {bridgeStreamEnabled ? 'Bridge Frame Relay: Active' : 'Enable Bridge Frame Relay'}
              </span>
            </button>
          </div>

          <div className="pt-2 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span className="flex items-center gap-1.5 font-medium">
                <Terminal className="w-3.5 h-3.5" />
                <span>Quick Launch Command (inside extracted folder)</span>
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
            <p className="text-xs text-slate-500 leading-relaxed">
              Requires OBS Studio (v26+ virtual camera driver) or Unity Capture installed on Windows, plus Python 3.10+. Or double-click <span className="font-mono text-slate-700">start_virtual_cam.bat</span>.
            </p>
          </div>
        </section>

        {/* Option 2: Zero-Install OBS Virtual Camera Browser Source */}
        <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900">
                02. OBS Virtual Camera Output
              </h3>
              <p className="text-sm text-slate-600">
                Zero-Python setup. Paste the chromeless local feed URL into an OBS Browser Source and click Start Virtual Camera.
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
              {vcamWebCount > 0 ? `${vcamWebCount} active` : 'Idle'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href={chromelessUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <MonitorPlay className="w-4 h-4" />
              <span>Open Chromeless Feed</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            <button
              type="button"
              onClick={handleCopyUrl}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 text-xs font-semibold transition-colors whitespace-nowrap"
            >
              {copiedUrl ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              <span>{copiedUrl ? 'Copied OBS URL' : 'Copy Browser Source URL'}</span>
            </button>
          </div>

          <div className="pt-2 space-y-2">
            <span className="block text-xs font-medium text-slate-500">
              Chromeless Localhost Feed URL
            </span>
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 font-mono text-xs text-slate-700 truncate">
              {chromelessUrl}
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              In OBS Studio: Add <strong className="font-semibold text-slate-700">Browser Source</strong> → set 1280×720 or 1920×1080 → click <strong className="font-semibold text-slate-700">Start Virtual Camera</strong>.
            </p>
          </div>
        </section>
      </div>

      {/* Video Conferencing App Selection Guide */}
      <section className="p-6 rounded-xl bg-white border border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">
          Selecting the Virtual Webcam in Conferencing Apps
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">Zoom</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Open Settings → Video → Camera dropdown, then select <span className="font-mono text-slate-800">OBS Virtual Camera</span>.
            </p>
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">Google Meet</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Click More options (⋮) → Settings → Video → Camera, then select <span className="font-mono text-slate-800">OBS Virtual Camera</span>.
            </p>
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-slate-900">Microsoft Teams</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Open Settings → Devices → Camera, then choose <span className="font-mono text-slate-800">OBS Virtual Camera</span>.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
