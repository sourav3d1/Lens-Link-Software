import React, { useState } from 'react';
import { Download, Laptop, QrCode, Smartphone, Wifi } from 'lucide-react';
import { triggerDirectFileDownload } from '../../lib/download';

interface LensLinkDownloadsPanelProps {
  mobileJoinUrl: string;
  onOpenMobileMode: () => void;
}

export const LensLinkDownloadsPanel: React.FC<LensLinkDownloadsPanelProps> = ({
  mobileJoinUrl,
  onOpenMobileMode,
}) => {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const qrSvgUrl = `/api/qr?text=${encodeURIComponent(mobileJoinUrl)}`;

  const runDownload = async (apiPath: string, filename: string, key: string) => {
    setDownloading(key);
    setNotice(null);
    const res = await triggerDirectFileDownload(
      `${apiPath}?origin=${encodeURIComponent(window.location.origin)}`,
      filename
    );
    setDownloading(null);
    setNotice(
      res.ok
        ? `Downloaded ${filename}${res.source === 'firebase' ? ' (Firebase Cloud)' : ''}`
        : res.error || 'Download failed.'
    );
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-10">
      {/* Instant Smartphone Connection Card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="grid items-center gap-6 md:grid-cols-[1fr_200px]">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-[#1D4ED8] uppercase">
              <Wifi className="h-3.5 w-3.5" />
              Zero-Config Smartphone Companion
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              Open LensLink Mobile App on Android or iPhone
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              Connect your smartphone to the same Wi-Fi network and scan this QR code — or install
              the native Android/iOS apps below. Your Windows PC appears automatically for 1-tap wireless pairing.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={onOpenMobileMode}
                className="inline-flex items-center gap-2 rounded-xl bg-[#1D4ED8] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#1E40AF]"
              >
                <Smartphone className="h-4 w-4" />
                Switch to Mobile Camera View
              </button>
              <span className="font-mono text-xs text-slate-500">
                Direct link: {window.location.origin}/phone
              </span>
            </div>
          </div>

          <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-[#F8FAFC] p-3">
            <img
              src={qrSvgUrl}
              alt="Scan with smartphone to launch LensLink Mobile Camera"
              className="h-40 w-40 rounded-lg bg-white p-1.5"
            />
            <span className="mt-2 flex items-center gap-1 text-[11px] font-medium text-slate-600">
              <QrCode className="h-3 w-3 text-[#1D4ED8]" />
              Scan with Phone Camera
            </span>
          </div>
        </div>
      </section>

      {/* Native Download Cards */}
      <div className="grid gap-5 md:grid-cols-3">
        <article className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#1D4ED8]">
              <Laptop className="h-4 w-4" />
              Windows 10 / 11
            </div>
            <h3 className="mt-2 text-base font-semibold text-slate-900">
              Windows Client & Virtual Driver
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Includes the DirectShow <span className="font-mono text-[11px]">LensLinkVirtualCam.ax</span> driver,
              mDNS discovery service, Inno Setup installer, Firewall config, and clean uninstaller.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              runDownload('/api/virtual-cam/bundle', 'lenslink-windows-webcam-suite.zip', 'win')
            }
            disabled={downloading === 'win'}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading === 'win' ? 'Downloading...' : 'Download Windows Suite'}
          </button>
        </article>

        <article className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#1D4ED8]">
              <Smartphone className="h-4 w-4" />
              Android (Kotlin)
            </div>
            <h3 className="mt-2 text-base font-semibold text-slate-900">
              Native Android App Project
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Camera2 multi-lens capture (up to 4K / 60fps), Android NSD automatic Wi-Fi discovery,
              hardware H.264, microphone audio, and battery/temperature telemetry.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              runDownload('/api/android-app/bundle', 'lenslink-android-app.zip', 'android')
            }
            disabled={downloading === 'android'}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-800 transition hover:border-[#1D4ED8] hover:text-[#1D4ED8] disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading === 'android' ? 'Downloading...' : 'Download Android Project'}
          </button>
        </article>

        <article className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#1D4ED8]">
              <Smartphone className="h-4 w-4" />
              iOS (SwiftUI)
            </div>
            <h3 className="mt-2 text-base font-semibold text-slate-900">
              Native iOS App Project
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              AVFoundation triple/dual-lens 4K capture, Apple Bonjour (<span className="font-mono text-[11px]">NWBrowser</span>)
              automatic PC discovery, thermal & battery monitoring, and OLED screen-dimming mode.
            </p>
          </div>
          <button
            type="button"
            onClick={() => runDownload('/api/ios-app/bundle', 'lenslink-ios-app.zip', 'ios')}
            disabled={downloading === 'ios'}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium text-slate-800 transition hover:border-[#1D4ED8] hover:text-[#1D4ED8] disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            {downloading === 'ios' ? 'Downloading...' : 'Download iOS Project'}
          </button>
        </article>
      </div>

      {notice && <p className="text-xs font-medium text-[#1D4ED8]">{notice}</p>}
    </div>
  );
};
