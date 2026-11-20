import fs from 'node:fs';
import path from 'node:path';

export interface ZipFileEntry {
  name: string;
  content: Buffer;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZipBuffer(files: ZipFileEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.content;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5421, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function walkDirectory(
  baseDir: string,
  zipPrefix: string,
  transform?: (relPath: string, content: Buffer) => Buffer
): ZipFileEntry[] {
  if (!fs.existsSync(baseDir)) return [];
  const files: ZipFileEntry[] = [];
  const walk = (dirPath: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.gradle' || entry.name === 'build' || entry.name === '.idea') continue;
        walk(full, rel);
      } else if (entry.isFile()) {
        const raw = fs.readFileSync(full);
        files.push({
          name: `${zipPrefix}/${rel}`,
          content: transform ? transform(rel, raw) : raw,
        });
      }
    }
  };
  walk(baseDir, '');
  return files;
}

export function buildLensLinkWindowsSuiteZip(
  rootDir: string,
  appOrigin: string,
  wsOrigin: string
): Buffer | null {
  const suiteDir = path.join(rootDir, 'windows-lenslink-suite');
  const files = walkDirectory(suiteDir, 'LensLink-Wireless-Webcam-Windows', (rel, content) => {
    if (
      rel === 'Install_LensLink_Webcam.bat' ||
      rel === 'Start_LensLink_Webcam.bat' ||
      rel === 'client/lenslink_windows_client.py'
    ) {
      const text = content
        .toString('utf8')
        .replaceAll('ws://127.0.0.1:3000', wsOrigin)
        .replaceAll(
          'https://ais-dev-uezvraxz5h2xsf4xr5nkjk-789221242334.asia-southeast1.run.app',
          appOrigin
        );
      return Buffer.from(text, 'utf8');
    }
    return content;
  });

  return files.length > 0 ? buildZipBuffer(files) : null;
}

export function buildBrowserCamZip(rootDir: string, appOrigin: string): Buffer | null {
  const extDir = path.join(rootDir, 'browser-virtual-cam');
  if (!fs.existsSync(extDir)) return null;

  const files: ZipFileEntry[] = [];
  const extFileNames = [
    'manifest.json',
    'background.js',
    'content-isolated.js',
    'content-main.js',
    'popup.html',
    'popup.js',
    'default-config.json',
    'README.txt',
  ];

  for (const fileName of extFileNames) {
    const fullPath = path.join(extDir, fileName);
    if (!fs.existsSync(fullPath)) continue;
    let content = fs.readFileSync(fullPath);
    if (fileName === 'default-config.json') {
      content = Buffer.from(JSON.stringify({ serverOrigin: appOrigin }, null, 2) + '\n', 'utf8');
    }
    files.push({
      name: `lenslink-browser-webcam/${fileName}`,
      content,
    });
  }

  const iconPath = path.join(rootDir, 'public', 'pwa-192x192.png');
  if (fs.existsSync(iconPath)) {
    files.push({
      name: 'lenslink-browser-webcam/icon.png',
      content: fs.readFileSync(iconPath),
    });
  }

  return files.length > 0 ? buildZipBuffer(files) : null;
}

export function buildAndroidStudioZip(rootDir: string, appOrigin: string): Buffer | null {
  const androidDir = path.join(rootDir, 'android-app');
  const files = walkDirectory(androidDir, 'LensLink-Android', (rel, content) => {
    if (rel === 'app/src/main/res/values/strings.xml') {
      const xmlEscapedOrigin = appOrigin.replace(/&/g, '&amp;');
      return Buffer.from(
        content.toString('utf8').replace('http://192.168.1.100:3000', xmlEscapedOrigin),
        'utf8'
      );
    }
    return content;
  });
  return files.length > 0 ? buildZipBuffer(files) : null;
}

export function buildIosAppZip(rootDir: string): Buffer | null {
  const iosDir = path.join(rootDir, 'ios-app');
  const files = walkDirectory(iosDir, 'LensLink-iOS');
  return files.length > 0 ? buildZipBuffer(files) : null;
}
