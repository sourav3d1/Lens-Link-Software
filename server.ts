import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildAndroidStudioZip,
  buildBrowserCamZip,
  buildPcWindowsZip,
  buildWindowsVcamZip,
} from './lib/bundles.ts';

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

  const resolveRequestAppOrigin = (req: express.Request): string => {
    const rawOrigin = typeof req.query.origin === 'string' ? req.query.origin.trim() : '';
    if (/^https?:\/\/[^/]+$/i.test(rawOrigin)) {
      return rawOrigin;
    }
    const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
    return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
  };

  const sendZipResponse = (res: express.Response, filename: string, zipBuffer: Buffer) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(zipBuffer);
  };

  app.get('/api/virtual-cam/bundle', (req, res) => {
    const appOrigin = resolveRequestAppOrigin(req);
    const wsOrigin = appOrigin.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    const zipBuffer = buildWindowsVcamZip(__dirname, wsOrigin);
    if (!zipBuffer) {
      res.status(404).json({ error: 'Virtual camera bridge files not found' });
      return;
    }
    sendZipResponse(res, 'lenslink-windows-vcam.zip', zipBuffer);
  });

  app.get('/api/browser-cam/bundle', (req, res) => {
    const appOrigin = resolveRequestAppOrigin(req);
    const zipBuffer = buildBrowserCamZip(__dirname, appOrigin);
    if (!zipBuffer) {
      res.status(404).json({ error: 'Browser virtual camera extension files not found' });
      return;
    }
    sendZipResponse(res, 'lenslink-browser-webcam.zip', zipBuffer);
  });

  app.get('/api/pc-app/bundle', (req, res) => {
    const appOrigin = resolveRequestAppOrigin(req);
    const zipBuffer = buildPcWindowsZip(__dirname, appOrigin);
    sendZipResponse(res, 'lenslink-pc-windows.zip', zipBuffer);
  });

  app.get('/api/android-app/bundle', (req, res) => {
    const appOrigin = resolveRequestAppOrigin(req);
    const zipBuffer = buildAndroidStudioZip(__dirname, appOrigin);
    if (!zipBuffer) {
      res.status(404).json({ error: 'Android app project files not found' });
      return;
    }
    sendZipResponse(res, 'lenslink-android-studio.zip', zipBuffer);
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
