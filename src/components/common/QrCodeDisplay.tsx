import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeDisplayProps {
  value: string;
  size?: number;
  alt?: string;
}

export function QrCodeDisplay({ value, size = 192, alt = 'Pairing QR code' }: QrCodeDisplayProps) {
  const [dataUrl, setDataUrl] = useState<string>('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!value) {
      setDataUrl('');
      return;
    }

    let cancelled = false;
    setFailed(false);

    QRCode.toDataURL(value, {
      width: size * 2,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!value) {
    return (
      <div
        style={{ width: size, height: size }}
        className="bg-slate-100 rounded-lg animate-pulse"
        aria-label="Generating pairing QR code"
      />
    );
  }

  if (failed) {
    return (
      <img
        src={`/api/qr?text=${encodeURIComponent(value)}`}
        alt={alt}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="block rounded-sm"
      />
    );
  }

  return dataUrl ? (
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="block rounded-sm"
    />
  ) : (
    <div
      style={{ width: size, height: size }}
      className="bg-slate-100 rounded-lg animate-pulse"
      aria-label="Rendering QR code"
    />
  );
}
