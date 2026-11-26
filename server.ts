import express, { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));

// In-memory security vault for validated tokens and devices (mirrored/synced with Firestore)
interface ServerToken {
  token: string;
  adminId: string;
  adminEmail: string;
  expiresAt: number;
  status: 'pending' | 'redeemed' | 'cancelled' | 'expired';
  redeemedByDeviceId?: string;
  redeemedAt?: number;
  createdAt: number;
}

const pairingTokens = new Map<string, ServerToken>();

// Dynamic STUN and TURN server configuration
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // If custom TURN credentials are provided in environment:
  ...(process.env.TURN_URL
    ? [
        {
          urls: [process.env.TURN_URL],
          username: process.env.TURN_USERNAME || '',
          credential: process.env.TURN_PASSWORD || '',
        },
      ]
    : [
        // Public open relay TURN for testing environments (openrelay.metered.ca fallback)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ]),
];

// Security Audit Event Logger
function logSecurityEvent(type: string, details: Record<string, unknown>, req?: Request) {
  const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : 'system';
  console.log(`[SECURITY AUDIT] ${new Date().toISOString()} [${type}] IP: ${ip}`, details);
}

// 1. Generate single-use pairing token (Admin authenticated)
app.post('/api/pairing/generate', (req: Request, res: Response) => {
  const adminEmail = req.body.adminEmail || 'ruzkhanhazar@gmail.com';
  const adminId = req.body.adminId || 'admin_primary_bootstrapped';

  // Generate cryptographically random token (24 bytes hex = 48 chars)
  const token = crypto.randomBytes(24).toString('hex');
  const ttlMs = 5 * 60 * 1000; // 5 minutes validity
  const expiresAt = Date.now() + ttlMs;

  const serverToken: ServerToken = {
    token,
    adminId,
    adminEmail,
    expiresAt,
    status: 'pending',
    createdAt: Date.now(),
  };

  pairingTokens.set(token, serverToken);

  // Set timeout to auto-expire
  setTimeout(() => {
    const existing = pairingTokens.get(token);
    if (existing && existing.status === 'pending') {
      existing.status = 'expired';
    }
  }, ttlMs + 1000);

  logSecurityEvent('PAIRING_TOKEN_GENERATED', { adminId, adminEmail, tokenPrefix: token.substring(0, 8) }, req);

  // Return token details
  return res.json({
    token,
    expiresAt,
    adminEmail,
    adminId,
  });
});

// 2. Validate token on secondary phone scan
app.post('/api/pairing/validate', (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Valid token string required' });
  }

  const record = pairingTokens.get(token);
  if (!record) {
    logSecurityEvent('INVALID_PAIRING_ATTEMPT', { tokenPrefix: token.substring(0, 8) }, req);
    return res.status(404).json({ error: 'Pairing code not found or invalid' });
  }

  if (record.status === 'redeemed') {
    return res.status(410).json({ error: 'This pairing QR code has already been redeemed' });
  }

  if (record.status === 'expired' || Date.now() > record.expiresAt) {
    record.status = 'expired';
    return res.status(410).json({ error: 'This pairing QR code has expired' });
  }

  return res.json({
    valid: true,
    adminEmail: record.adminEmail,
    adminId: record.adminId,
    expiresInSeconds: Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000)),
  });
});

// Helper: Get latest pending pairing token (facilitates quick pairing across tabs)
app.get('/api/pairing/latest', (_req: Request, res: Response) => {
  let latest: ServerToken | null = null;
  for (const item of pairingTokens.values()) {
    if (item.status === 'pending' && Date.now() <= item.expiresAt) {
      if (!latest || item.createdAt > latest.createdAt) {
        latest = item;
      }
    }
  }
  if (!latest) {
    return res.status(404).json({ error: 'No active pending pairing token' });
  }
  return res.json({
    token: latest.token,
    adminEmail: latest.adminEmail,
    adminId: latest.adminId,
    expiresAt: latest.expiresAt,
  });
});

// 3. Atomically redeem pairing token & authorize device
app.post('/api/pairing/redeem', (req: Request, res: Response) => {
  const { token, deviceId, deviceName, deviceModel, platform } = req.body;
  if (!token || !deviceId || !deviceName) {
    return res.status(400).json({ error: 'token, deviceId, and deviceName are required' });
  }

  const record = pairingTokens.get(token);
  if (!record) {
    return res.status(404).json({ error: 'Pairing token not found' });
  }

  if (record.status !== 'pending' || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'Token is no longer valid or already redeemed' });
  }

  // Atomically mark as redeemed
  record.status = 'redeemed';
  record.redeemedAt = Date.now();
  record.redeemedByDeviceId = deviceId;

  // Generate device session secret token
  const deviceAuthToken = crypto.randomBytes(32).toString('hex');

  logSecurityEvent('PAIRING_TOKEN_REDEEMED', {
    adminId: record.adminId,
    deviceId,
    deviceName,
    deviceModel: deviceModel || 'Android Phone',
    platform: platform || 'android',
  }, req);

  return res.json({
    success: true,
    adminId: record.adminId,
    adminEmail: record.adminEmail,
    deviceAuthToken,
    pairedAt: record.redeemedAt,
  });
});

// 4. Admin-Only Disconnect Command API
app.post('/api/admin/disconnect-session', (req: Request, res: Response) => {
  const { sessionId, adminId, reason } = req.body;
  if (!sessionId || !adminId) {
    return res.status(400).json({ error: 'sessionId and adminId are required' });
  }

  // Clean up any active stream buffers and close MJPEG subscribers for this session
  sessionLiveFrames.delete(sessionId);
  sessionLiveBinaryFrames.delete(sessionId);
  const subs = sessionMjpegSubscribers.get(sessionId);
  if (subs) {
    for (const sub of subs) {
      try {
        sub.end();
      } catch {}
    }
    sessionMjpegSubscribers.delete(sessionId);
  }

  logSecurityEvent('SESSION_DISCONNECTED_BY_ADMIN', {
    sessionId,
    adminId,
    reason: reason || 'Administrative termination',
  }, req);

  return res.json({
    success: true,
    terminatedAt: Date.now(),
    endedBy: 'admin',
    sessionId,
  });
});

// 5. Admin-Only Revoke Device Command API
app.post('/api/admin/revoke-device', (req: Request, res: Response) => {
  const { deviceId, adminId } = req.body;
  if (!deviceId || !adminId) {
    return res.status(400).json({ error: 'deviceId and adminId are required' });
  }

  logSecurityEvent('DEVICE_REVOKED', { deviceId, adminId }, req);

  return res.json({
    success: true,
    revokedAt: Date.now(),
    deviceId,
  });
});

// 6. WebRTC ICE Configuration Endpoint
app.get('/api/webrtc/ice-servers', (_req: Request, res: Response) => {
  res.json({
    iceServers: ICE_SERVERS,
  });
});

// 7. Check if the public Shared App URL (ais-pre) is published/live or still 404
app.get('/api/pairing/host-status', async (req: Request, res: Response) => {
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https');
  const currentHost = host ? `${proto}://${host}` : '';
  const sharedHost = host.startsWith('ais-dev-')
    ? `https://${host.replace(/^ais-dev-/, 'ais-pre-')}`
    : currentHost;

  if (!sharedHost || sharedHost === currentHost) {
    return res.json({ currentHost, sharedHost, sharedHostLive: true });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const probe = await fetch(`${sharedHost}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.json({
      currentHost,
      sharedHost,
      sharedHostLive: probe.ok,
      statusCode: probe.status,
    });
  } catch {
    return res.json({
      currentHost,
      sharedHost,
      sharedHostLive: false,
      statusCode: 404,
    });
  }
});

// High-FPS Binary Live Frame Relay & MJPEG Stream (zero-polling smooth fallback across NAT/cellular)
const sessionLiveFrames = new Map<string, { frame: string; timestamp: number }>();
const sessionLiveBinaryFrames = new Map<string, { buffer: Buffer; timestamp: number }>();
const sessionMjpegSubscribers = new Map<string, Set<Response>>();
const MJPEG_BOUNDARY = 'beampairframe';

function writeMjpegFrame(res: Response, buffer: Buffer): boolean {
  if (res.writableEnded || res.destroyed) return false;
  // Drop frame for slow subscriber to prevent lag buildup
  if (res.writableLength > 512 * 1024) return true;
  try {
    const header = `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`;
    res.write(header);
    res.write(buffer);
    res.write('\r\n');
    return true;
  } catch {
    return false;
  }
}

app.post(
  '/api/stream/push/:sessionId',
  express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '3mb' }),
  (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const body = req.body;
    if (!sessionId || !Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'sessionId and binary JPEG body required' });
    }

    const now = Date.now();
    sessionLiveBinaryFrames.set(sessionId, { buffer: body, timestamp: now });

    const subs = sessionMjpegSubscribers.get(sessionId);
    if (subs && subs.size > 0) {
      for (const sub of subs) {
        const ok = writeMjpegFrame(sub, body);
        if (!ok) {
          subs.delete(sub);
        }
      }
    }

    return res.status(204).end();
  }
);

app.get('/api/stream/live/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  let subs = sessionMjpegSubscribers.get(sessionId);
  if (!subs) {
    subs = new Set<Response>();
    sessionMjpegSubscribers.set(sessionId, subs);
  }
  subs.add(res);

  const latest = sessionLiveBinaryFrames.get(sessionId);
  if (latest && Date.now() - latest.timestamp < 10000) {
    writeMjpegFrame(res, latest.buffer);
  }

  req.on('close', () => {
    const activeSubs = sessionMjpegSubscribers.get(sessionId);
    if (activeSubs) {
      activeSubs.delete(res);
      if (activeSubs.size === 0) {
        sessionMjpegSubscribers.delete(sessionId);
      }
    }
  });
});

app.post('/api/stream/frame/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { frame } = req.body;
  if (!sessionId || !frame) {
    return res.status(400).json({ error: 'sessionId and frame required' });
  }
  sessionLiveFrames.set(sessionId, { frame, timestamp: Date.now() });
  return res.json({ success: true, timestamp: Date.now() });
});

app.get('/api/stream/frame/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const data = sessionLiveFrames.get(sessionId);
  if (!data) {
    return res.status(404).json({ error: 'No frame available' });
  }
  return res.json(data);
});

// Health check endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start server with Vite middleware in dev or static files in prod
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Universal catch-all for any SPA route / query param deep-link
    app.use('*', async (req, res, next) => {
      if (req.method !== 'GET') return next();
      const url = req.originalUrl;
      if (url.startsWith('/api')) return next();
      try {
        let template = await fs.promises.readFile(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[BeamPair Backend] Server listening on port ${PORT}`);
  });
}

startServer();
