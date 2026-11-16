// Instructor login (signed, HTTP-only cookie) and small helpers.
import crypto from 'node:crypto';
import { config } from './env.js';

const COOKIE = 'instructor_session';
const HOURS = 8;

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

function sign(body) {
  return crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
}

export function passwordMatches(candidate) {
  const a = Buffer.from(sha256(String(candidate ?? '')));
  const b = Buffer.from(sha256(config.instructorPassword));
  return crypto.timingSafeEqual(a, b);
}

export function setSession(res) {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + HOURS * 3600_000 })).toString('base64url');
  const flags = `HttpOnly; Path=/; SameSite=Strict; Max-Age=${HOURS * 3600}${config.production ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${body}.${sign(body)}; ${flags}`);
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${config.production ? '; Secure' : ''}`);
}

export function isInstructor(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!raw) return false;
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!body || !mac) return false;
  const expected = sign(body);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

export function requireInstructor(req, res, next) {
  if (!isInstructor(req)) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Reject cross-site form posts to the instructor API.
export function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* ignore */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
}

// Simple in-memory rate limiter: at most `max` hits per `windowMs` per key.
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();
  return key => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count++;
    return h.count <= max;
  };
}
