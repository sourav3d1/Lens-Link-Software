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
}

interface RoomState {
  code: string;
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
  const statusPayload: Record<string, unknown> = {
    type: 'room:status',
    code: room.code,
    pcOnline: Boolean(room.pc && room.pc.ws.readyState === WebSocket.OPEN),
    phoneOnline: Boolean(room.phone && room.phone.ws.readyState === WebSocket.OPEN),
    vcamBridgeCount: room.vcamBridges.size,
    vcamWebCount: room.vcamWebClients.size,
    vcamWebPeerIds: Array.from(room.vcamWebClients.keys()),
    phoneName: room.phoneName || undefined,
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

    res.json({
      lanIps,
      preferredIp,
      port: PORT,
      isLocalhostRequest,
      suggestedOrigin,
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

  app.get('/api/virtual-cam/bundle', (_req, res) => {
    const vcamDir = path.join(__dirname, 'windows-virtual-cam');
    const fileNames = ['lenslink_vcam.py', 'requirements.txt', 'start_virtual_cam.bat', 'README.md'];
    const files: Array<{ name: string; content: Buffer }> = [];

    for (const fileName of fileNames) {
      const fullPath = path.join(vcamDir, fileName);
      if (fs.existsSync(fullPath)) {
        files.push({
          name: `lenslink-windows-vcam/${fileName}`,
          content: fs.readFileSync(fullPath),
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

      // Binary frames from PC receiver are relayed directly to Windows Virtual Camera bridges
      if (isBinary) {
        if (!senderMeta || senderMeta.role !== 'pc') return;
        const room = rooms.get(senderMeta.code);
        if (!room || room.vcamBridges.size === 0) return;
        room.lastActivity = Date.now();
        for (const bridge of room.vcamBridges) {
          if (bridge.ws.readyState === WebSocket.OPEN) {
            bridge.ws.send(rawData, { binary: true });
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
        const requestedCode =
          typeof msg.code === 'string' && /^[A-Z0-9]{6}$/i.test(msg.code.trim())
            ? msg.code.trim().toUpperCase()
            : generatePairingCode();

        let room = rooms.get(requestedCode);
        if (!room) {
          room = createEmptyRoom(requestedCode);
          rooms.set(requestedCode, room);
        }
        attachClientToRoom(ws, 'pc', requestedCode);
        sendJson(ws, { type: 'room:created', code: requestedCode });
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
        // Also forward mirror setting to chromeless vcam-web outputs
        if (typeof incoming.mirror === 'boolean') {
          for (const webClient of room.vcamWebClients.values()) {
            sendJson(webClient.ws, {
              type: 'camera:settings',
              settings: { mirror: incoming.mirror },
              from: senderMeta.role,
            });
          }
        }
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
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
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
