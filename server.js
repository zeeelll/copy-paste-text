'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NOTE_FILE = path.join(DATA_DIR, 'note.json');
const USERNAME = process.env.APP_USERNAME || 'admin';
const PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NOTE_BYTES = 1024 * 1024;
const COOKIE = 'session';

if (!PASSWORD) {
  console.error('APP_PASSWORD environment variable is required.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set: logins will be reset every restart.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- note storage ----------
let note = { text: '', updatedAt: 0 };
try {
  note = JSON.parse(fs.readFileSync(NOTE_FILE, 'utf8'));
} catch {}

function saveNote() {
  const tmp = NOTE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(note));
  fs.renameSync(tmp, NOTE_FILE);
}

// ---------- auth ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function makeSession() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function validSession(token) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isAuthed = (req) => validSession(parseCookies(req)[COOKIE]);

function cookieHeader(req, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

// brute-force protection: 5 failures per IP per 15 minutes
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}
function isLocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILS;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

// ---------- http helpers ----------
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_NOTE_BYTES + 1024) {
        reject(Object.assign(new Error('Too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const PAGES = {
  '/': 'index.html',
  '/login': 'login.html',
};
function sendFile(res, name) {
  const html = fs.readFileSync(path.join(__dirname, 'public', name));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const authed = isAuthed(req);

    if (route === 'GET /healthz') return send(res, 200, 'ok');

    if (route === 'GET /login') {
      if (authed) return send(res, 302, '', { Location: '/' });
      return sendFile(res, PAGES['/login']);
    }

    if (route === 'POST /api/login') {
      const ip = clientIp(req);
      if (isLocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const { username = '', password = '' } = await readJson(req);
      const userOk = safeEqual(String(username), USERNAME);
      const passOk = safeEqual(String(password), PASSWORD);
      const ok = userOk && passOk;
      if (!ok) {
        recordFailure(ip);
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      failures.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, makeSession(), SESSION_TTL_MS / 1000) });
    }

    if (route === 'POST /api/logout') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
    }

    if (route === 'GET /') {
      if (!authed) return send(res, 302, '', { Location: '/login' });
      return sendFile(res, PAGES['/']);
    }

    if (url.pathname === '/api/note') {
      if (!authed) return send(res, 401, { error: 'Not logged in.' });
      if (req.method === 'GET') return send(res, 200, note);
      if (req.method === 'PUT') {
        const { text } = await readJson(req);
        if (typeof text !== 'string') return send(res, 400, { error: 'text must be a string' });
        if (Buffer.byteLength(text) > MAX_NOTE_BYTES) return send(res, 413, { error: 'Note too large (1 MB max).' });
        note = { text, updatedAt: Date.now() };
        saveNote();
        return send(res, 200, note);
      }
    }

    send(res, 404, 'Not found');
  } catch (err) {
    send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
