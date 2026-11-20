import React, { useEffect, useState } from 'react';
import {
  Check,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleProvider } from '../../lib/firebase';
import {
  BUNDLE_CATALOG,
  fetchAllBundleStatuses,
  StoredBundleStatus,
  syncAllBundlesToFirebase,
} from '../../lib/firebaseBundles';
import { triggerDirectFileDownload } from '../../lib/download';

interface LensLinkDriverPanelProps {
  roomCode: string;
  pcName: string;
  vcamBridgeCount: number;
  vcamWebCount: number;
  isConnected: boolean;
}

const SUPPORTED_APPS = [
  'Google Meet',
  'Zoom Desktop',
  'Microsoft Teams',
  'WhatsApp Desktop',
  'OBS Studio',
  'VLC Media Player',
  'Google Chrome',
  'Microsoft Edge',
];

export const LensLinkDriverPanel: React.FC<LensLinkDriverPanelProps> = ({
  roomCode,
  pcName,
  vcamBridgeCount,
  vcamWebCount,
  isConnected,
}) => {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const [fbUser, setFbUser] = useState<User | null>(null);
  const [bundleStatuses, setBundleStatuses] = useState<StoredBundleStatus[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const obsDirectUrl = `${window.location.origin}/vcam?code=${encodeURIComponent(roomCode)}`;

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => setFbUser(user));
    void fetchAllBundleStatuses().then(setBundleStatuses);
    return () => unsub();
  }, []);

  const handleDownload = async (apiPath: string, filename: string, id: string) => {
    setDownloadingId(id);
    setDownloadMsg(null);
    const result = await triggerDirectFileDownload(
      `${apiPath}?origin=${encodeURIComponent(window.location.origin)}`,
      filename
    );
    setDownloadingId(null);
    if (!result.ok) {
      setDownloadMsg(result.error || 'Download failed.');
    } else {
      const sourceNote = result.source === 'firebase' ? ' (Firebase Cloud)' : '';
      setDownloadMsg(`Downloaded ${filename}${sourceNote}`);
    }
  };

  const handleCopyObsUrl = async () => {
    try {
      await navigator.clipboard.writeText(obsDirectUrl);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 1800);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleSyncFirebase = async () => {
    setSyncStatus(null);
    try {
      let activeUser = fbUser;
      if (!activeUser) {
        const res = await signInWithPopup(auth, googleProvider);
        activeUser = res.user;
      }
      setSyncing(true);
      const updated = await syncAllBundlesToFirebase(activeUser, (done, total, title) => {
        setSyncStatus(`Syncing ${done}/${total}: ${title}`);
      });
      setBundleStatuses(updated);
      setSyncStatus('All LensLink v2.0.0 packages synced to Firebase Cloud.');
    } catch (err) {
      setSyncStatus(err instanceof Error ? err.message : 'Firebase sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-10">
      {/* Primary Card: System-Level Windows Virtual Webcam Driver */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-[#1D4ED8] uppercase">
              <HardDrive className="h-3.5 w-3.5" />
              System-Level Windows Driver
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              LensLink Wireless Webcam — DirectShow Virtual Camera
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              Installs the native Windows DirectShow capture filter (<span className="font-mono text-xs text-slate-800">LensLinkVirtualCam.ax</span>),
              mDNS local Wi-Fi auto-discovery service, Windows Firewall rules, and clean uninstaller so Windows
              recognizes your smartphone as a standard physical camera named{' '}
              <strong className="font-semibold text-slate-900">LensLink Wireless Webcam</strong>.
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
            <button
              type="button"
              onClick={() =>
                handleDownload(
                  '/api/virtual-cam/bundle',
                  'lenslink-windows-webcam-suite.zip',
                  'windows-vcam'
                )
              }
              disabled={downloadingId === 'windows-vcam'}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D4ED8] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#1E40AF] disabled:opacity-60"
            >
              <Download className="h-4 w-4" />
              {downloadingId === 'windows-vcam'
                ? 'Preparing Installer...'
                : 'Download Windows Suite (.zip)'}
            </button>
            <span className="text-center text-xs text-slate-500">
              Windows 10 / 11 (x64) · v2.0.0
            </span>
          </div>
        </div>

        {/* Driver Status + Compatibility Grid */}
        <div className="mt-6 grid gap-4 border-t border-slate-100 pt-5 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-slate-500">Active Driver Status</p>
            <div className="mt-1.5 flex items-baseline gap-3">
              <span className="text-sm font-semibold text-slate-900">
                {vcamBridgeCount > 0
                  ? 'Virtual Driver Service Active'
                  : 'Waiting for Windows Driver Bridge'}
              </span>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                Session {roomCode} · {pcName}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              {isConnected
                ? 'Smartphone feed is live. Launch Start_LensLink_Webcam.bat with your session code to push frames into LensLink Wireless Webcam.'
                : 'Pair your smartphone on the Live Camera tab, then run Install_LensLink_Webcam.bat once as Administrator.'}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-500">Verified Third-Party Applications</p>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-medium text-slate-700">
              {SUPPORTED_APPS.map((app) => (
                <span key={app} className="inline-flex items-center gap-1">
                  <Check className="h-3 w-3 text-[#1D4ED8]" />
                  {app}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* 3-Step Installation & Clean Uninstall */}
        <div className="mt-5 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-3.5">
            <p className="text-xs font-semibold text-slate-900">1. Install & Register Driver</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Extract the ZIP and run <span className="font-mono text-[11px] text-slate-800">Install_LensLink_Webcam.bat</span>.
              Registers the DirectShow device, Firewall rules, and Desktop shortcut.
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3.5">
            <p className="text-xs font-semibold text-slate-900">2. Select in Any App</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Run <span className="font-mono text-[11px] text-slate-800">Start_LensLink_Webcam.bat</span> and pick{' '}
              <span className="font-medium text-slate-800">LensLink Wireless Webcam</span> in Meet, Zoom, Teams, or OBS.
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 p-3.5">
            <p className="text-xs font-semibold text-slate-900">3. Clean Uninstallation</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Run <span className="font-mono text-[11px] text-slate-800">Uninstall_LensLink_Webcam.bat</span> (or Inno Setup
              uninstaller) to cleanly unregister the camera and remove firewall rules.
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-slate-200/80 bg-[#F8FAFC] px-4 py-3 text-xs text-slate-600">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#1D4ED8]" />
          <p>
            Includes full C++ DirectShow filter source (<span className="font-mono text-[11px]">driver/LensLinkVirtualCam.cpp</span>,{' '}
            <span className="font-mono text-[11px]">CMakeLists.txt</span>), Inno Setup script (<span className="font-mono text-[11px]">LensLinkWebcamSetup.iss</span>),
            and EV code-signing instructions in <span className="font-mono text-[11px]">DRIVER_SIGNING_AND_BUILD.md</span>.
            Web browsers cannot silently install system drivers directly from a webpage; running the installer registers it cleanly with Windows.
          </p>
        </div>

        {downloadMsg && (
          <p className="mt-3 text-xs font-medium text-[#1D4ED8]">{downloadMsg}</p>
        )}
      </section>

      {/* Secondary Integrations: Chrome/Edge Extension + OBS Studio Direct Source */}
      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <h3 className="text-sm font-semibold text-slate-900">
            Chrome & Edge Virtual Webcam Extension
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Instant browser-level companion exposing <strong>LensLink Wireless Webcam</strong> directly inside
            Google Meet, Zoom Web, WhatsApp Web, and Microsoft Teams without needing Admin rights.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                handleDownload('/api/browser-cam/bundle', 'lenslink-browser-webcam.zip', 'browser-webcam')
              }
              disabled={downloadingId === 'browser-webcam'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-800 transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
            >
              <Download className="h-3.5 w-3.5" />
              {downloadingId === 'browser-webcam' ? 'Downloading...' : 'Download Extension v2.0'}
            </button>
            <span className="text-[11px] text-slate-500">Load unpacked in chrome://extensions</span>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">OBS Studio Direct Browser Source</h3>
            {vcamWebCount > 0 && (
              <span className="font-mono text-[11px] font-medium text-emerald-700 tabular-nums">
                {vcamWebCount} connected
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
            Add a Browser Source in OBS Studio (1920×1080) with the local loopback URL below for zero-frame-drop capture.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={obsDirectUrl}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-xs text-slate-700 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopyObsUrl}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
            >
              {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedUrl ? 'Copied' : 'Copy'}
            </button>
            <a
              href={obsDirectUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 transition hover:border-[#1D4ED8] hover:text-[#1D4ED8]"
              title="Preview OBS Feed"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </section>
      </div>

      {/* Firebase Cloud Package Storage */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Terminal className="h-4 w-4 text-[#1D4ED8]" />
              Cloud Installer Storage (Firebase Firestore)
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Mirror all 4 LensLink v2.0.0 ZIP bundles in Firebase so downloads work reliably even from static previews.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {fbUser && (
              <button
                type="button"
                onClick={() => void signOut(auth)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Sign out
              </button>
            )}
            <button
              type="button"
              onClick={handleSyncFirebase}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {syncing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudUpload className="h-3.5 w-3.5" />
              )}
              {syncing ? 'Syncing...' : fbUser ? 'Sync LensLink v2.0 Bundles' : 'Sign in & Sync Bundles'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {BUNDLE_CATALOG.map((entry) => {
            const st = bundleStatuses.find((b) => b.bundleId === entry.bundleId);
            return (
              <div
                key={entry.bundleId}
                className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5 text-xs"
              >
                <p className="truncate font-medium text-slate-800">{entry.filename}</p>
                <p className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
                  {st?.storedInFirebase
                    ? `Synced v${st.version || entry.version} · ${Math.round((st.sizeBytes || 0) / 1024)} KB`
                    : 'Not synced yet'}
                </p>
              </div>
            );
          })}
        </div>

        {syncStatus && (
          <p className="mt-3 text-xs font-medium text-[#1D4ED8]">{syncStatus}</p>
        )}
      </section>
    </div>
  );
};
