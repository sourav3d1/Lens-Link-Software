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

const VCAM_FILES = [
  'lenslink_vcam.py',
  'requirements.txt',
  'start_virtual_cam.bat',
  'Install_Driver_No_OBS.bat',
  'Uninstall_Driver.bat',
  'README.md',
];

export function buildWindowsVcamZip(rootDir: string, wsOrigin: string): Buffer | null {
  const vcamDir = path.join(rootDir, 'windows-virtual-cam');
  const files: ZipFileEntry[] = [];

  for (const fileName of VCAM_FILES) {
    const fullPath = path.join(vcamDir, fileName);
    if (!fs.existsSync(fullPath)) continue;
    let content = fs.readFileSync(fullPath);
    if (fileName === 'start_virtual_cam.bat' || fileName === 'lenslink_vcam.py') {
      content = Buffer.from(
        content.toString('utf8').replaceAll('ws://127.0.0.1:3000', wsOrigin),
        'utf8'
      );
    }
    files.push({
      name: `lenslink-windows-vcam/${fileName}`,
      content,
    });
  }

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

export function buildPcWindowsZip(rootDir: string, appOrigin: string): Buffer {
  const launchUrl = `${appOrigin}/?mode=pc`;

  const launchBat = [
    '@echo off',
    'setlocal',
    `set "APP_URL=${launchUrl}"`,
    'echo Launching LensLink PC Receiver...',
    'where msedge >nul 2>nul && (start "" msedge --app="%APP_URL%" --new-window && exit /b 0)',
    'if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" (start "" "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" --app="%APP_URL%" --new-window && exit /b 0)',
    'if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" (start "" "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" --app="%APP_URL%" --new-window && exit /b 0)',
    'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" (start "" "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" --app="%APP_URL%" --new-window && exit /b 0)',
    'if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" (start "" "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" --app="%APP_URL%" --new-window && exit /b 0)',
    'start "" "%APP_URL%"',
    'exit /b 0',
    '',
  ].join('\r\n');

  const installBat = [
    '@echo off',
    'setlocal',
    `set "APP_URL=${launchUrl}"`,
    'echo ==================================================',
    'echo   LensLink PC Desktop Installer (Windows 10 / 11)',
    'echo ==================================================',
    'echo.',
    'set "BROWSER_EXE="',
    'if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE (',
    '  echo Microsoft Edge or Google Chrome not found in default paths.',
    '  echo Opening in your default browser instead...',
    '  start "" "%APP_URL%"',
    '  pause',
    '  exit /b 0',
    ')',
    'echo Creating Desktop and Start Menu shortcuts for LensLink...',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath(\'Desktop\'); $startMenu = Join-Path ([Environment]::GetFolderPath(\'Programs\')) \'LensLink.lnk\'; foreach ($path in @((Join-Path $desktop \'LensLink.lnk\'), $startMenu)) { $s = $ws.CreateShortcut($path); $s.TargetPath = \'%BROWSER_EXE%\'; $s.Arguments = \'--app=%APP_URL% --new-window\'; $s.Description = \'LensLink Wireless Smartphone Webcam\'; $s.Save() }"',
    'echo.',
    'echo Shortcut installed! Launching LensLink PC Receiver...',
    'start "" "%BROWSER_EXE%" --app="%APP_URL%" --new-window',
    'exit /b 0',
    '',
  ].join('\r\n');

  const readmeTxt = [
    'LensLink PC Desktop Application (Windows 10 / 11)',
    '==================================================',
    '',
    '1. Install Desktop Shortcut:',
    '   Double-click Install_LensLink_Desktop.bat to add a LensLink icon',
    '   to your Windows Desktop and Start Menu and launch it as a standalone app.',
    '',
    '2. Portable Quick Launch:',
    '   Double-click Launch_LensLink.bat anytime to open a fresh session window.',
    '',
    '3. Multi-PC & Multi-Smartphone on the Same Wi-Fi:',
    '   Each time LensLink opens on any PC, it generates a unique dynamic QR code',
    "   and 6-character session code. Scan each PC's QR code with its paired",
    '   smartphone so multiple workstations operate independently on the same Wi-Fi.',
    '',
    '4. Windows Virtual Webcam (No OBS Studio Required):',
    '   Open the included virtual-cam folder and run Install_Driver_No_OBS.bat',
    '   followed by start_virtual_cam.bat to expose a native DirectShow webcam.',
    '',
  ].join('\r\n');

  const files: ZipFileEntry[] = [
    { name: 'LensLink-PC/Install_LensLink_Desktop.bat', content: Buffer.from(installBat, 'utf8') },
    { name: 'LensLink-PC/Launch_LensLink.bat', content: Buffer.from(launchBat, 'utf8') },
    { name: 'LensLink-PC/README.txt', content: Buffer.from(readmeTxt, 'utf8') },
  ];

  const vcamDir = path.join(rootDir, 'windows-virtual-cam');
  for (const fileName of VCAM_FILES) {
    const fullPath = path.join(vcamDir, fileName);
    if (fs.existsSync(fullPath)) {
      files.push({
        name: `LensLink-PC/virtual-cam/${fileName}`,
        content: fs.readFileSync(fullPath),
      });
    }
  }

  return buildZipBuffer(files);
}

export function buildAndroidStudioZip(rootDir: string, appOrigin: string): Buffer | null {
  const androidDir = path.join(rootDir, 'android-app');
  if (!fs.existsSync(androidDir)) return null;

  const files: ZipFileEntry[] = [];
  const walk = (dirPath: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.gradle' || entry.name === 'build' || entry.name === '.idea') continue;
        walk(full, rel);
      } else if (entry.isFile()) {
        let content = fs.readFileSync(full);
        if (rel === 'app/src/main/res/values/strings.xml') {
          const xmlEscapedOrigin = appOrigin.replace(/&/g, '&amp;');
          content = Buffer.from(
            content.toString('utf8').replace('http://192.168.1.100:3000', xmlEscapedOrigin),
            'utf8'
          );
        }
        files.push({
          name: `LensLink-Android/${rel}`,
          content,
        });
      }
    }
  };

  walk(androidDir, '');
  return files.length > 0 ? buildZipBuffer(files) : null;
}
