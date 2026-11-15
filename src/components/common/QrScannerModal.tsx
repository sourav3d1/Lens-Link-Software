import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { X, QrCode, AlertCircle } from 'lucide-react';

interface QrScannerModalProps {
  open: boolean;
  onClose: () => void;
  onDetected: (pairingCode: string) => void;
}

export function extractPairingCodeFromQr(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (/^[A-Z0-9]{6}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  try {
    const url = new URL(trimmed);
    const param = url.searchParams.get('pair') || url.searchParams.get('code');
    if (param && /^[A-Z0-9]{6}$/i.test(param.trim())) {
      return param.trim().toUpperCase();
    }
  } catch {
    const match = trimmed.match(/pair=([A-Z0-9]{6})/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

export function QrScannerModal({ open, onClose, onDetected }: QrScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId = 0;

    async function startScanner() {
      setError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const videoEl = videoRef.current;
        if (!videoEl) return;
        videoEl.srcObject = stream;
        await videoEl.play();

        const scanFrame = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video && canvas && video.readyState >= video.HAVE_ENOUGH_DATA) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w > 0 && h > 0) {
              if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
              }
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(video, 0, 0, w, h);
                const imageData = ctx.getImageData(0, 0, w, h);
                const result = jsQR(imageData.data, w, h, {
                  inversionAttempts: 'dontInvert',
                });
                if (result?.data) {
                  const code = extractPairingCodeFromQr(result.data);
                  if (code) {
                    stream?.getTracks().forEach((t) => t.stop());
                    onDetected(code);
                    return;
                  }
                }
              }
            }
          }
          rafId = requestAnimationFrame(scanFrame);
        };

        rafId = requestAnimationFrame(scanFrame);
      } catch (err) {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : 'Unable to access rear camera for QR scanning.';
          setError(msg);
        }
      }
    }

    startScanner();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [open, onDetected]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Scan pairing QR code"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <QrCode className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">Scan PC QR Code</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          aria-label="Close scanner"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="relative flex-1 flex items-center justify-center overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="w-full h-full object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />

        {!error && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center p-6">
            <div className="w-60 h-60 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(2,6,23,0.55)]" />
            <p className="mt-6 text-sm font-medium text-white bg-slate-950/80 px-4 py-2 rounded-xl">
              Point camera at the QR code on your PC screen
            </p>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-6 p-5 rounded-2xl bg-slate-900 border border-slate-700 text-center space-y-3">
            <AlertCircle className="w-8 h-8 text-amber-400 mx-auto" />
            <p className="text-sm text-slate-200">{error}</p>
            <p className="text-xs text-slate-400">
              You can also close this scanner and enter the 6-character code manually, or scan with your phone&apos;s native Camera app.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full min-h-[44px] rounded-xl bg-blue-600 text-white text-sm font-medium"
            >
              Enter Code Manually
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
