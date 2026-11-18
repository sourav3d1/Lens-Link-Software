import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Unambiguous uppercase alphanumeric characters (excludes 0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface SocketMeta {
  ws: WebSocket;
  role: 'pc' | 'phone' | 'vcam' | 'vcam-web';
  code: string;
  peerId: string;
  isAlive: boolean;
  wantsFrames?: boolean;
}

interface RoomState {
  code: string;
  sessionToken: string | null;
  pcName: string;
  pc: SocketMeta | null;
  phone: SocketMeta | null;
  vcamBridges: Set<SocketMeta>;
  vcamWebClients: Map<string, SocketMeta>;
  capabilities: unknown | null;
  settings: Record<string, unknown> | null;
  phoneName: string | null;
  createdAt: number;
  lastActivity: number;
}

const rooms = new Map<string, RoomState>();
const socketMetaMap = new WeakMap<WebSocket, SocketMeta>();

function generatePairingCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return Date.now().toString(36).slice(-6).toUpperCase();
}

function createEmptyRoom(code: string): RoomState {
  const now = Date.now();
  return {
    code,
    sessionToken: null,
    pcName: 'PC Workstation',
    pc: null,
    phone: null,
    vcamBridges: new Set<SocketMeta>(),
    vcamWebClients: new Map<string, SocketMeta>(),
    capabilities: null,
    settings: null,
    phoneName: null,
    createdAt: now,
    lastActivity: now,
  };
}

function sendJson(ws: WebSocket | null | undefined, payload: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastRoomStatus(room: RoomState) {
  const vcamWebFrameCount = Array.from(room.vcamWebClients.values()).filter(
    (c) => c.wantsFrames
  ).length;
  const statusPayload: Record<string, unknown> = {
    type: 'room:status',
    code: room.code,
    pcOnline: Boolean(room.pc && room.pc.ws.readyState === WebSocket.OPEN),
    phoneOnline: Boolean(room.phone && room.phone.ws.readyState === WebSocket.OPEN),
    vcamBridgeCount: room.vcamBridges.size,
    vcamWebCount: room.vcamWebClients.size,
    vcamWebFrameCount,
    vcamWebPeerIds: Array.from(room.vcamWebClients.keys()),
    phoneName: room.phoneName || undefined,
    pcName: room.pcName,
    capabilities: room.capabilities,
    settings: room.settings,
  };

  sendJson(room.pc?.ws, statusPayload);
  sendJson(room.phone?.ws, statusPayload);
  for (const bridge of room.vcamBridges) {
    sendJson(bridge.ws, statusPayload);
  }
  for (const webClient of room.vcamWebClients.values()) {
    sendJson(webClient.ws, statusPayload);
  }
}

function getLanIps(): string[] {
  const interfaces = os.networkInterfaces();
  const candidates: Array<{ ip: string; score: number }> = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    const lowerName = name.toLowerCase();
    const isVirtualAdapter =
      lowerName.includes('vethernet') ||
      lowerName.includes('docker') ||
      lowerName.includes('wsl') ||
      lowerName.includes('vmware') ||
      lowerName.includes('virtualbox') ||
      lowerName.includes('vbox');

    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      let score = 0;
      if (entry.address.startsWith('192.168.')) score += 30;
      else if (entry.address.startsWith('10.')) score += 20;
      else if (entry.address.startsWith('172.')) score += 10;

      if (lowerName.includes('wi-fi') || lowerName.includes('wlan') || lowerName.includes('eth') || lowerName.includes('en0')) {
        score += 15;
      }
      if (isVirtualAdapter) score -= 25;

      candidates.push({ ip: entry.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c) => c.ip);
}

// Pure Node CRC32 + minimal uncompressed ZIP builder for one-click Windows bridge download
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

function buildZipBuffer(files: Array<{ name: string; content: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.content;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // stored (no compression)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x5421, 12); // mod date
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

async function startServer() {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeRooms: rooms.size });
  });

  app.get('/phone-manifest.webmanifest', (_req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.json({
      id: '/phone',
      name: 'LensLink Camera',
      short_name: 'LensLink Cam',
      description:
        'Turn your Android or iPhone into a low-latency wireless webcam for your Windows PC.',
      start_url: '/phone',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#020617',
      theme_color: '#020617',
      icons: [
        {
          src: '/pwa-192x192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: '/pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any',
        },
        {
          src: '/pwa-maskable-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    });
  });

  app.get('/api/network-info', (req, res) => {
    const lanIps = getLanIps();
    const preferredIp = lanIps[0] || null;
    const hostHeader = (req.headers.host || '').split(':')[0];
    const isLocalhostRequest =
      hostHeader === 'localhost' || hostHeader === '127.0.0.1' || hostHeader === '::1';
    const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';

    let suggestedOrigin = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
    if (isLocalhostRequest && preferredIp) {
      suggestedOrigin = `http://${preferredIp}:${PORT}`;
    }

    const envAppUrl = (process.env.APP_URL || '').trim();
    const httpsOrigin = /^https:\/\/[^/]+/i.test(envAppUrl) ? envAppUrl.replace(/\/+$/, '') : null;

    res.json({
      lanIps,
      preferredIp,
      port: PORT,
      isLocalhostRequest,
      suggestedOrigin,
      httpsOrigin,
    });
  });

  app.get('/api/qr', async (req, res) => {
    const text = typeof req.query.text === 'string' ? req.query.text : '';
    if (!text) {
      res.status(400).json({ error: 'Missing text parameter' });
      return;
    }
    try {
      const svg = await QRCode.toString(text, {
        type: 'svg',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#0F172A',
          light: '#FFFFFF',
        },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch {
      res.status(500).json({ error: 'Failed to generate QR code' });
    }
  });

  app.get('/api/virtual-cam/bundle', (req, res) => {
    const vcamDir = path.join(__dirname, 'windows-virtual-cam');
    const fileNames = [
      'lenslink_vcam.py',
      'requirements.txt',
      'start_virtual_cam.bat',
      'Install_Driver_No_OBS.bat',
      'Uninstall_Driver.bat',
      'README.md',
    ];

    const rawOrigin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    let wsOrigin = `ws://127.0.0.1:${PORT}`;
    if (/^https?:\/\/[^/]+$/i.test(rawOrigin)) {
      wsOrigin = rawOrigin.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    } else if (req.headers.host) {
      const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'wss' : 'ws';
      wsOrigin = `${proto}://${req.headers.host}`;
    }

    const files: Array<{ name: string; content: Buffer }> = [];

    for (const fileName of fileNames) {
      const fullPath = path.join(vcamDir, fileName);
      if (fs.existsSync(fullPath)) {
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
    }

    if (files.length === 0) {
      res.status(404).json({ error: 'Virtual camera bridge files not found' });
      return;
    }

    const zipBuffer = buildZipBuffer(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="lenslink-windows-vcam.zip"');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(zipBuffer);
  });

  app.get('/api/browser-cam/bundle', (req, res) => {
    const extDir = path.join(__dirname, 'browser-virtual-cam');
    if (!fs.existsSync(extDir)) {
      res.status(404).json({ error: 'Browser virtual camera extension files not found' });
      return;
    }

    const rawOrigin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    let appOrigin = rawOrigin;
    if (!/^https?:\/\/[^/]+$/i.test(appOrigin)) {
      const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
      appOrigin = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
    }

    const files: Array<{ name: string; content: Buffer }> = [];
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

    const iconPath = path.join(__dirname, 'public', 'pwa-192x192.png');
    if (fs.existsSync(iconPath)) {
      files.push({
        name: 'lenslink-browser-webcam/icon.png',
        content: fs.readFileSync(iconPath),
      });
    }

    if (files.length === 0) {
      res.status(404).json({ error: 'Browser virtual camera extension is empty' });
      return;
    }

    const zipBuffer = buildZipBuffer(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="lenslink-browser-webcam.zip"');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(zipBuffer);
  });

  app.get('/api/pc-app/bundle', (req, res) => {
    const rawOrigin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    let appOrigin = rawOrigin;
    if (!/^https?:\/\/[^/]+$/i.test(appOrigin)) {
      const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
      appOrigin = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
    }
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
      '   and 6-character session code. Scan each PC\'s QR code with its paired',
      '   smartphone so multiple workstations operate independently on the same Wi-Fi.',
      '',
      '4. Windows Virtual Webcam (No OBS Studio Required):',
      '   Open the included virtual-cam folder and run Install_Driver_No_OBS.bat',
      '   followed by start_virtual_cam.bat to expose a native DirectShow webcam.',
      '',
    ].join('\r\n');

    const files: Array<{ name: string; content: Buffer }> = [
      { name: 'LensLink-PC/Install_LensLink_Desktop.bat', content: Buffer.from(installBat, 'utf8') },
      { name: 'LensLink-PC/Launch_LensLink.bat', content: Buffer.from(launchBat, 'utf8') },
      { name: 'LensLink-PC/README.txt', content: Buffer.from(readmeTxt, 'utf8') },
    ];

    const vcamDir = path.join(__dirname, 'windows-virtual-cam');
    for (const fileName of [
      'lenslink_vcam.py',
      'requirements.txt',
      'start_virtual_cam.bat',
      'Install_Driver_No_OBS.bat',
      'Uninstall_Driver.bat',
      'README.md',
    ]) {
      const fullPath = path.join(vcamDir, fileName);
      if (fs.existsSync(fullPath)) {
        files.push({
          name: `LensLink-PC/virtual-cam/${fileName}`,
          content: fs.readFileSync(fullPath),
        });
      }
    }

    const zipBuffer = buildZipBuffer(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="lenslink-pc-windows.zip"');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(zipBuffer);
  });

  app.get('/api/android-app/bundle', (req, res) => {
    const androidDir = path.join(__dirname, 'android-app');
    if (!fs.existsSync(androidDir)) {
      res.status(404).json({ error: 'Android app project files not found' });
      return;
    }

    const rawOrigin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    let appOrigin = rawOrigin;
    if (!/^https?:\/\/[^/]+$/i.test(appOrigin)) {
      const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
      appOrigin = `${proto}://${req.headers.host || `localhost:${PORT}`}`;
    }

    const files: Array<{ name: string; content: Buffer }> = [];
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

    if (files.length === 0) {
      res.status(404).json({ error: 'Android app project is empty' });
      return;
    }

    const zipBuffer = buildZipBuffer(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="lenslink-android-studio.zip"');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(zipBuffer);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/ws') {
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, reqUrl);
    });
  });

  function attachClientToRoom(
    ws: WebSocket,
    role: 'pc' | 'phone' | 'vcam' | 'vcam-web',
    rawCode: string,
    phoneName?: string
  ) {
    const code = rawCode.trim().toUpperCase();
    let room = rooms.get(code);

    if (!room) {
      if (role === 'pc') {
        room = createEmptyRoom(code);
        rooms.set(code, room);
      } else {
        sendJson(ws, {
          type: 'room:error',
          message: `Pairing code "${code}" was not found. Make sure the LensLink PC Receiver is open.`,
        });
        return;
      }
    }

    room.lastActivity = Date.now();
    const peerId = `${role}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: SocketMeta = {
      ws,
      role,
      code,
      peerId,
      isAlive: true,
    };
    socketMetaMap.set(ws, meta);

    if (role === 'pc') {
      if (room.pc && room.pc.ws !== ws && room.pc.ws.readyState === WebSocket.OPEN) {
        room.pc.ws.close(1000, 'Replaced by reconnected PC session');
      }
      room.pc = meta;
    } else if (role === 'phone') {
      if (room.phone && room.phone.ws !== ws && room.phone.ws.readyState === WebSocket.OPEN) {
        room.phone.ws.close(1000, 'Replaced by reconnected phone session');
      }
      room.phone = meta;
      if (phoneName) {
        room.phoneName = phoneName;
      }
    } else if (role === 'vcam') {
      room.vcamBridges.add(meta);
    } else if (role === 'vcam-web') {
      room.vcamWebClients.set(peerId, meta);
    }

    sendJson(ws, {
      type: 'room:joined',
      code,
      role,
      peerId,
    });
    broadcastRoomStatus(room);
  }

  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, reqUrl: URL) => {
    const queryRole = reqUrl.searchParams.get('role');
    const queryCode = reqUrl.searchParams.get('code');

    ws.on('pong', () => {
      const meta = socketMetaMap.get(ws);
      if (meta) meta.isAlive = true;
    });

    if (
      (queryRole === 'vcam' || queryRole === 'vcam-web' || queryRole === 'pc' || queryRole === 'phone') &&
      queryCode
    ) {
      attachClientToRoom(ws, queryRole, queryCode);
    }

    ws.on('message', (rawData, isBinary) => {
      const senderMeta = socketMetaMap.get(ws);

      // Binary frames from PC receiver are relayed to Windows Virtual Camera bridges and OBS Browser fallback clients
      if (isBinary) {
        if (!senderMeta || senderMeta.role !== 'pc') return;
        const room = rooms.get(senderMeta.code);
        if (!room) return;
        const hasFrameTargets =
          room.vcamBridges.size > 0 ||
          Array.from(room.vcamWebClients.values()).some((c) => c.wantsFrames);
        if (!hasFrameTargets) return;
        room.lastActivity = Date.now();
        for (const bridge of room.vcamBridges) {
          if (bridge.ws.readyState === WebSocket.OPEN) {
            bridge.ws.send(rawData, { binary: true });
          }
        }
        for (const webClient of room.vcamWebClients.values()) {
          if (webClient.wantsFrames && webClient.ws.readyState === WebSocket.OPEN) {
            webClient.ws.send(rawData, { binary: true });
          }
        }
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      const type = typeof msg.type === 'string' ? msg.type : '';

      if (type === 'ping') {
        sendJson(ws, { type: 'pong' });
        if (senderMeta) senderMeta.isAlive = true;
        return;
      }

      if (type === 'room:create') {
        const incomingSessionToken =
          typeof msg.sessionToken === 'string' && msg.sessionToken.trim().length > 0
            ? msg.sessionToken.trim()
            : null;
        const incomingPcName =
          typeof msg.pcName === 'string' && msg.pcName.trim().length > 0
            ? msg.pcName.trim().slice(0, 40)
            : 'PC Workstation';

        let targetCode =
          typeof msg.code === 'string' && /^[A-Z0-9]{6}$/i.test(msg.code.trim())
            ? msg.code.trim().toUpperCase()
            : generatePairingCode();

        let room = rooms.get(targetCode);
        // If another active PC session already owns this code, allocate a distinct code to avoid cross-PC collision
        if (
          room &&
          room.pc &&
          room.pc.ws.readyState === WebSocket.OPEN &&
          room.pc.ws !== ws &&
          (!incomingSessionToken || room.sessionToken !== incomingSessionToken)
        ) {
          targetCode = generatePairingCode();
          room = undefined;
        }

        if (!room) {
          room = createEmptyRoom(targetCode);
          rooms.set(targetCode, room);
        }

        if (incomingSessionToken) {
          room.sessionToken = incomingSessionToken;
        }
        room.pcName = incomingPcName;

        attachClientToRoom(ws, 'pc', targetCode);
        sendJson(ws, {
          type: 'room:created',
          code: targetCode,
          pcName: room.pcName,
          sessionToken: room.sessionToken,
        });
        return;
      }

      if (type === 'room:join') {
        const code = typeof msg.code === 'string' ? msg.code : '';
        const role = msg.role;
        const phoneName = typeof msg.phoneName === 'string' ? msg.phoneName : undefined;
        if (!code || (role !== 'pc' && role !== 'phone' && role !== 'vcam' && role !== 'vcam-web')) {
          sendJson(ws, { type: 'room:error', message: 'Invalid room join request.' });
          return;
        }
        attachClientToRoom(ws, role, code, phoneName);
        return;
      }

      if (!senderMeta) return;
      const room = rooms.get(senderMeta.code);
      if (!room) return;
      room.lastActivity = Date.now();

      if (type === 'camera:capabilities') {
        room.capabilities = msg.capabilities || null;
        if (typeof msg.phoneName === 'string') {
          room.phoneName = msg.phoneName;
        }
        sendJson(room.pc?.ws, {
          type: 'camera:capabilities',
          capabilities: room.capabilities,
          phoneName: room.phoneName,
        });
        return;
      }

      if (type === 'camera:settings') {
        const incoming =
          msg.settings && typeof msg.settings === 'object'
            ? (msg.settings as Record<string, unknown>)
            : {};
        room.settings = { ...(room.settings || {}), ...incoming };
        const target = senderMeta.role === 'pc' ? room.phone?.ws : room.pc?.ws;
        sendJson(target, {
          type: 'camera:settings',
          settings: incoming,
          from: senderMeta.role,
        });
        // Forward visual settings to chromeless vcam-web outputs so OBS mirrors PC controls
        for (const webClient of room.vcamWebClients.values()) {
          sendJson(webClient.ws, {
            type: 'camera:settings',
            settings: incoming,
            from: senderMeta.role,
          });
        }
        return;
      }

      if (type === 'vcam:frame-fallback' && senderMeta.role === 'vcam-web') {
        senderMeta.wantsFrames = Boolean(msg.enabled);
        broadcastRoomStatus(room);
        return;
      }

      if (type === 'vcam:request-offer' && senderMeta.role === 'vcam-web') {
        sendJson(room.pc?.ws, {
          type: 'vcam:request-offer',
          peerId: senderMeta.peerId,
        });
        return;
      }

      if (type === 'camera:stream-state') {
        const target = senderMeta.role === 'phone' ? room.pc?.ws : room.phone?.ws;
        sendJson(target, {
          type: 'camera:stream-state',
          streaming: Boolean(msg.streaming),
          from: senderMeta.role,
        });
        return;
      }

      if (type === 'camera:trigger-focus') {
        sendJson(room.phone?.ws, {
          type: 'camera:trigger-focus',
          focusPoint: msg.focusPoint,
          from: senderMeta.role,
        });
        return;
      }

      if (type === 'camera:request-capture') {
        sendJson(room.phone?.ws, {
          type: 'camera:request-capture',
          captureCategory: msg.captureCategory,
          from: senderMeta.role,
        });
        return;
      }

      if (type === 'camera:photo-captured') {
        sendJson(room.pc?.ws, {
          type: 'camera:photo-captured',
          photo: msg.photo,
          from: senderMeta.role,
        });
        return;
      }

      if (type === 'rtc:offer' || type === 'rtc:answer' || type === 'rtc:ice-candidate' || type === 'rtc:restart') {
        const targetRole = msg.target;
        const targetPeerId = typeof msg.peerId === 'string' ? msg.peerId : undefined;

        const outbound: Record<string, unknown> = {
          ...msg,
          from: senderMeta.role,
          peerId: senderMeta.role === 'vcam-web' ? senderMeta.peerId : targetPeerId,
        };

        if (targetRole === 'vcam-web' && targetPeerId) {
          const webClient = room.vcamWebClients.get(targetPeerId);
          sendJson(webClient?.ws, outbound);
        } else if (targetRole === 'phone') {
          sendJson(room.phone?.ws, outbound);
        } else if (targetRole === 'pc') {
          sendJson(room.pc?.ws, outbound);
        } else {
          // Default peer-to-peer routing between pc <-> phone
          const targetWs = senderMeta.role === 'pc' ? room.phone?.ws : room.pc?.ws;
          sendJson(targetWs, outbound);
        }
      }
    });

    ws.on('close', () => {
      const meta = socketMetaMap.get(ws);
      if (!meta) return;
      const room = rooms.get(meta.code);
      if (!room) return;

      if (meta.role === 'pc' && room.pc === meta) {
        room.pc = null;
      } else if (meta.role === 'phone' && room.phone === meta) {
        room.phone = null;
      } else if (meta.role === 'vcam') {
        room.vcamBridges.delete(meta);
      } else if (meta.role === 'vcam-web') {
        room.vcamWebClients.delete(meta.peerId);
      }

      broadcastRoomStatus(room);
    });
  });

  // Periodic WebSocket heartbeat & stale room cleanup
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const meta = socketMetaMap.get(ws);
      if (meta) {
        if (!meta.isAlive) {
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
      }
      ws.ping();
    }

    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
      const hasAnyClient =
        Boolean(room.pc) ||
        Boolean(room.phone) ||
        room.vcamBridges.size > 0 ||
        room.vcamWebClients.size > 0;
      if (!hasAnyClient && now - room.lastActivity > 10 * 60 * 1000) {
        rooms.delete(code);
      }
    }
  }, 15000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server, path: '/vite-hmr' },
        ws: { server, path: '/vite-hmr' },
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      const reqPath = (req.path || '').toLowerCase();
      const isPhoneReq =
        reqPath === '/phone' ||
        req.query.mode === 'phone' ||
        Boolean(req.query.pair) ||
        Boolean(req.query.code);
      if (isPhoneReq && fs.existsSync(indexHtmlPath)) {
        const html = fs
          .readFileSync(indexHtmlPath, 'utf8')
          .replace('href="/manifest.webmanifest"', 'href="/phone-manifest.webmanifest"')
          .replace('content="LensLink"', 'content="LensLink Cam"')
          .replace(
            '<title>LensLink — Wireless Smartphone Webcam</title>',
            '<title>LensLink Cam — Wireless Phone Webcam</title>'
          );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
        return;
      }
      res.sendFile(indexHtmlPath);
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    const lanIps = getLanIps();
    console.log(`LensLink server listening on http://0.0.0.0:${PORT}`);
    if (lanIps.length > 0) {
      console.log(`Local Wi-Fi URL for smartphone pairing: http://${lanIps[0]}:${PORT}`);
    }
  });
}

startServer().catch((err) => {
  console.error('Failed to start LensLink server:', err);
  process.exit(1);
});
