import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  CheckCircle2,
  CloudUpload,
  Database,
  Download,
  LogIn,
  LogOut,
  RefreshCw,
} from 'lucide-react';
import { ADMIN_EMAIL, auth, googleProvider } from '../../lib/firebase';
import {
  BUNDLE_CATALOG,
  BundleId,
  fetchAllBundleStatuses,
  StoredBundleStatus,
  syncAllBundlesToFirebase,
} from '../../lib/firebaseBundles';
import { downloadBundle } from '../../lib/download';

function formatKb(bytes?: number): string {
  if (!bytes) return '';
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function FirebaseBundleSyncCard() {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [authReady, setAuthReady] = useState(false);
  const [statuses, setStatuses] = useState<StoredBundleStatus[]>([]);
  const [loadingStatuses, setLoadingStatuses] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStatusText, setSyncStatusText] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<BundleId | null>(null);

  const refreshStatuses = useCallback(async () => {
    setLoadingStatuses(true);
    try {
      const next = await fetchAllBundleStatuses();
      setStatuses(next);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to read Firebase status.');
    } finally {
      setLoadingStatuses(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
    });
    void refreshStatuses();
    return () => unsub();
  }, [refreshStatuses]);

  const handleSignIn = async () => {
    setErrorMsg(null);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      if (cred.user) {
        setUser(cred.user);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Google sign-in failed.');
    }
  };

  const handleSignOut = async () => {
    setErrorMsg(null);
    try {
      await signOut(auth);
      setSyncStatusText(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sign out failed.');
    }
  };

  const handleSyncToFirebase = async () => {
    if (!user) return;
    setSyncing(true);
    setErrorMsg(null);
    setSyncStatusText('Preparing archives...');
    try {
      const updated = await syncAllBundlesToFirebase(user, (completed, total, label) => {
        if (completed < total) {
          setSyncStatusText(`Uploading ${completed + 1}/${total}: ${label}...`);
        } else {
          setSyncStatusText(`All ${total} files stored in Firebase Firestore.`);
        }
      });
      setStatuses(updated);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Failed to store files in Firebase. Make sure you are signed in as the admin account.'
      );
      setSyncStatusText(null);
    } finally {
      setSyncing(false);
    }
  };

  const handleDownload = async (bundleId: BundleId, apiPath: string, filename: string) => {
    setDownloadingId(bundleId);
    setErrorMsg(null);
    const result = await downloadBundle(
      `${apiPath}?origin=${encodeURIComponent(window.location.origin)}`,
      filename,
      { bundleId, preferFirebase: true }
    );
    setDownloadingId(null);
    if (!result.ok) {
      setErrorMsg(result.error || `Could not download ${filename}.`);
    }
  };

  const storedCount = statuses.filter((s) => s.storedInFirebase).length;
  const isAdminEmail =
    Boolean(user?.email && user.emailVerified && user.email.toLowerCase() === ADMIN_EMAIL);

  return (
    <section className="p-6 rounded-xl bg-white border border-slate-200 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
            <Database className="w-3.5 h-3.5" />
            <span>
              Firebase Cloud Storage ({storedCount}/{BUNDLE_CATALOG.length} Stored)
            </span>
          </div>
          <h3 className="text-base font-semibold text-slate-900">
            Firebase Downloadable Files Repository
          </h3>
          <p className="text-xs text-slate-600 leading-relaxed">
            Store all LensLink ZIP packages directly in Firebase Firestore so downloads always succeed without 404 errors.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {authReady && !user && (
            <button
              type="button"
              onClick={() => void handleSignIn()}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Sign in with Google</span>
            </button>
          )}

          {user && (
            <>
              <button
                type="button"
                disabled={syncing || !isAdminEmail}
                onClick={() => void handleSyncToFirebase()}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>
                  {syncing
                    ? 'Storing in Firebase...'
                    : storedCount === BUNDLE_CATALOG.length
                      ? 'Refresh Files in Firebase'
                      : 'Store All Files in Firebase'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors"
                title={`Signed in as ${user.email || 'Google user'}`}
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </>
          )}

          <button
            type="button"
            disabled={loadingStatuses}
            onClick={() => void refreshStatuses()}
            className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 disabled:opacity-50"
            aria-label="Refresh Firebase bundle status"
            title="Refresh Firebase status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatuses ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {user && !isAdminEmail && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Signed in as <span className="font-mono">{user.email}</span>. Sign in as{' '}
          <span className="font-mono">{ADMIN_EMAIL}</span> to upload or update bundles in Firebase. Downloading works for everyone.
        </p>
      )}

      {syncStatusText && (
        <p className="text-xs text-emerald-700 font-medium">{syncStatusText}</p>
      )}

      {errorMsg && (
        <p className="text-xs text-red-600 break-words">{errorMsg}</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {BUNDLE_CATALOG.map((item) => {
          const status = statuses.find((s) => s.bundleId === item.bundleId);
          const isStored = Boolean(status?.storedInFirebase);
          const isDownloading = downloadingId === item.bundleId;

          return (
            <div
              key={item.bundleId}
              className="p-4 rounded-lg border border-slate-200 bg-slate-50/70 flex items-center justify-between gap-3"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-900 truncate">
                    {item.title}
                  </span>
                  {isStored && (
                    <CheckCircle2
                      className="w-3.5 h-3.5 text-emerald-600 shrink-0"
                      aria-label="Stored in Firebase"
                    />
                  )}
                </div>
                <div className="text-[11px] text-slate-500 font-mono truncate">
                  {item.filename}
                  {status?.sizeBytes ? ` • ${formatKb(status.sizeBytes)}` : ''}
                  {isStored ? ' • Firebase' : ' • Ready'}
                </div>
              </div>

              <button
                type="button"
                disabled={isDownloading}
                onClick={() => void handleDownload(item.bundleId, item.apiPath, item.filename)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 text-xs font-semibold whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isDownloading ? 'Saving...' : 'Download'}</span>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
