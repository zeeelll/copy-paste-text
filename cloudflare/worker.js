// Cloudflare Workers version of server.js.
// The note and login rate-limit counters live in a single Durable Object.
import { DurableObject } from 'cloudflare:workers';

const COOKIE = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NOTE_BYTES = 1024 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const enc = new TextEncoder();

// ---------- Durable Object: note + failed-login counters ----------
export class Notepad extends DurableObject {
  async getNote() {
    return (await this.ctx.storage.get('note')) || { text: '', updatedAt: 0 };
  }
  async putNote(text) {
    const note = { text, updatedAt: Date.now() };
    await this.ctx.storage.put('note', note);
    return note;
  }
  async isLocked(ip) {
    const f = await this.ctx.storage.get('fail:' + ip);
    if (!f) return false;
    if (Date.now() - f.first > WINDOW_MS) {
      await this.ctx.storage.delete('fail:' + ip);
      return false;
    }
    return f.count >= MAX_FAILS;
  }
  async recordFailure(ip) {
    const f = await this.ctx.storage.get('fail:' + ip);
    if (!f || Date.now() - f.first > WINDOW_MS) await this.ctx.storage.put('fail:' + ip, { count: 1, first: Date.now() });
    else await this.ctx.storage.put('fail:' + ip, { count: f.count + 1, first: f.first });
  }
  async clearFailures(ip) {
    await this.ctx.storage.delete('fail:' + ip);
  }
}

// ---------- auth helpers ----------
async function sha(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha(a), sha(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function makeSession(secret) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${await sign(exp, secret)}`;
}
async function validSession(token, secret) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !(await safeEqual(sig, await sign(exp, secret)))) return false;
  return Number(exp) > Date.now();
}
function getCookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const cookie = (value, maxAgeSec) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

const SEC_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...SEC_HEADERS, ...headers } });
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, ...SEC_HEADERS } });

async function page(env, request, file) {
  const res = await env.ASSETS.fetch(new Request(new URL('/' + file, request.url)));
  return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS } });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_NOTE_BYTES + 1024) throw Object.assign(new Error('Too large'), { status: 413 });
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// ---------- worker ----------
export default {
  async fetch(request, env) {
    try {
      if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
        return new Response('Set the APP_PASSWORD and SESSION_SECRET secrets, then reload.', { status: 500 });
      }
      const username = env.APP_USERNAME || 'admin';
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      const authed = await validSession(getCookie(request, COOKIE), env.SESSION_SECRET);
      const notepad = env.NOTEPAD.get(env.NOTEPAD.idFromName('main'));

      if (route === 'GET /healthz') return new Response('ok');

      if (route === 'GET /login') return authed ? redirect('/') : page(env, request, 'login.html');

      if (route === 'GET /') return authed ? page(env, request, 'index.html') : redirect('/login');

      if (route === 'POST /api/login') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (await notepad.isLocked(ip)) return json(429, { error: 'Too many attempts. Try again later.' });
        const body = await readJson(request);
        const userOk = await safeEqual(String(body.username ?? ''), username);
        const passOk = await safeEqual(String(body.password ?? ''), env.APP_PASSWORD);
        if (!(userOk && passOk)) {
          await notepad.recordFailure(ip);
          return json(401, { error: 'Wrong username or password.' });
        }
        await notepad.clearFailures(ip);
        const token = await makeSession(env.SESSION_SECRET);
        return json(200, { ok: true }, { 'Set-Cookie': cookie(token, SESSION_TTL_MS / 1000) });
      }

      if (route === 'POST /api/logout') return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

      if (url.pathname === '/api/note') {
        if (!authed) return json(401, { error: 'Not logged in.' });
        if (request.method === 'GET') return json(200, await notepad.getNote());
        if (request.method === 'PUT') {
          const { text } = await readJson(request);
          if (typeof text !== 'string') return json(400, { error: 'text must be a string' });
          if (enc.encode(text).length > MAX_NOTE_BYTES) return json(413, { error: 'Note too large (1 MB max).' });
          return json(200, await notepad.putNote(text));
        }
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json(err.status || 500, { error: err.status ? err.message : 'Server error' });
    }
  },
};
