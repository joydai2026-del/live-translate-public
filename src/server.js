// HTTP server: JSON API, SSE live stream, transcripts, QR, static pages. Zero runtime deps.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { RoomStore, KeyedLimiter, DIRECTIONS, MAX_SEGMENTS, MAX_ROOM_CHARS } from './rooms.js';
import { qrSvg } from './qr.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_TEXT = 2000;
const MAX_BODY = 64 * 1024;
const HEARTBEAT_MS = 25000;
const SWEEP_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_KINDS = ['quota', 'auth', 'timeout', 'budget', 'other'];
const MAX_DEVICE_TRANSLATION = 4000;
// A final whose translation is ready within this window goes out once, translated. A slower one goes out
// at once as pending (original only) and again with the same id when the translation is done.
export const GRACE_MS = 150;
// Open SSE streams (M4). The host's own stream (?role=host with a valid token) is exempt from both.
export const MAX_STREAMS_PER_IP = 20; // across all rooms
export const MAX_STREAMS_PER_ROOM = 50;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Abuse limits per client IP (token buckets: burst, refill per second). Documented in README.md.
export const LIMITS = {
  roomsPerIp: { burst: 10, perSec: 10 / 3600 }, // POST /api/rooms: 10 per hour
  finalsPerIp: { burst: 30, perSec: 1 }, // final segments across all rooms
  notFoundPerIp: { burst: 30, perSec: 0.5 }, // room-not-found answers (code guessing)
  guestsPerIp: { burst: 30, perSec: 30 / 3600 }, // POST /api/rooms/:code/guests: 30 per hour
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const PAGES = { '/': 'index.html', '/join': 'join.html' };
const PAGE_PATTERNS = [[/^\/host\/[A-Za-z0-9]{6}\/?$/, 'host.html'], [/^\/j\/[A-Za-z0-9]{6}\/?$/, 'guest.html']];

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}
const tooMany = (message, retryAfter) => new HttpError(429, message, { 'retry-after': String(Math.ceil(retryAfter)) });

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
const sendJson = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

// JSON bodies must say so: a text/plain POST needs no CORS preflight, so any site could otherwise send one.
function requireJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json');
}
const hasBody = (req) => Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'] !== undefined;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        // Stop buffering but keep the socket so the client can read the 413; close it once the answer is written.
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body too large', { connection: 'close' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const publicSegment = (s) => {
  const o = { id: s.id, lang: s.lang, text: s.text, translation: s.translation, final: s.final, ts: s.ts, speaker: s.speaker || 'host' };
  if (s.pending) o.pending = true;
  if (s.error) { o.error = true; o.errorKind = s.errorKind || 'other'; }
  if (s.clientId) o.clientId = s.clientId;
  return o;
};
// POST answer for a stored final.
const finalAnswer = (s) => {
  const o = { id: s.id, text: s.text, translation: s.translation, speaker: s.speaker };
  if (s.pending) o.pending = true;
  if (s.error) Object.assign(o, { error: true, errorKind: s.errorKind || 'other' });
  return o;
};

// Markdown escaping for speech and reply text: no links, images, raw HTML or code spans. Plain "[" and "]"
// stay readable ("[zh]..."); only "![" and "](" are broken up.
const mdEscape = (t) => String(t)
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/!\[/g, '\\![')
  .replace(/\]\(/g, '\\](');

// Private LAN IPv4 for the join link when the host page is opened on localhost: 192.168/16, then 10/8, then
// 172.16/12 (Docker bridges live there, so it comes last). Null when there is none.
export function lanAddress(ifaces = os.networkInterfaces()) {
  const rank = (a) => {
    const [x, y] = a.split('.').map(Number);
    if (x === 192 && y === 168) return 1;
    if (x === 10) return 2;
    if (x === 172 && y >= 16 && y <= 31) return 3;
    return 0;
  };
  let best = null;
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (!a || a.internal || !(a.family === 'IPv4' || a.family === 4)) continue;
      const r = rank(String(a.address));
      if (r && (!best || r < best.r)) best = { r, address: a.address };
    }
  }
  return best?.address || null;
}
const isLocalHostname = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]';

function transcript(room, format) {
  const segs = room.segments.map(publicSegment);
  if (format === 'json') {
    return ['application/json; charset=utf-8', JSON.stringify({ code: room.code, direction: room.direction, createdAt: new Date(room.createdAt).toISOString(), segments: segs }, null, 2)];
  }
  const label = { en: 'EN', zh: 'ZH' };
  const other = { en: 'ZH', zh: 'EN' };
  const who = (s) => label[s.lang] + (s.speaker === 'guest' ? ' (guest)' : '');
  const tr = (s, unavailable, translating) => s.pending ? translating : s.translation == null ? unavailable : oneLine(s.translation);
  const time = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const oneLine = (t) => String(t ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
  if (format === 'md') {
    // Newlines are collapsed so speech text cannot break the document structure, and text is escaped so it
    // cannot form links, images or raw HTML in a Markdown previewer.
    const lines = [`# Transcript ${room.code}`, '', `Started ${time(room.createdAt)}. Direction: ${room.direction}.`, ''];
    const mdTr = (s) => s.pending || s.translation == null ? tr(s, '_(translation unavailable)_', '_(translating)_') : mdEscape(oneLine(s.translation));
    for (const s of segs) {
      lines.push(`**${time(s.ts)}** ${who(s)}: ${mdEscape(oneLine(s.text))}`, '');
      lines.push(`> ${other[s.lang]}: ${mdTr(s)}`, '');
    }
    return ['text/markdown; charset=utf-8', lines.join('\n')];
  }
  const lines = [`Transcript ${room.code}`, `Started ${time(room.createdAt)}. Direction: ${room.direction}.`, ''];
  for (const s of segs) {
    lines.push(`[${time(s.ts)}] ${who(s)}: ${oneLine(s.text)}`);
    lines.push(`    ${other[s.lang]}: ${tr(s, '(translation unavailable)', '(translating)')}`, '');
  }
  return ['text/plain; charset=utf-8', lines.join('\n')];
}

function serveStatic(req, res, pathname) {
  let file = PAGES[pathname];
  if (!file) for (const [re, f] of PAGE_PATTERNS) if (re.test(pathname)) file = f;
  if (!file) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'bad path'); }
    file = rel.replace(/^\/+/, '');
  }
  const full = path.resolve(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || full.includes('\0')) return send(res, 404, 'not found');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const headers = { ...BASE_HEADERS, 'content-type': type, 'content-length': st.size, 'cache-control': 'no-cache' };
    if (type.startsWith('text/html')) headers['content-security-policy'] = PAGE_CSP;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

// `lanHost`: this machine's LAN address, used in join links when the host page is on localhost. Only the
// CLI passes it (see the bottom of this file); in-process servers use the request's Host as is.
export function createServer({ translator, store = new RoomStore(), now = store.now, dailyCharLimit, lanHost = null, log = () => {} } = {}) {
  let tr = translator;
  const getTr = async () => tr ??= (await import('./translate/index.js')).getTranslator();
  const trustProxy = process.env.TRUST_PROXY === '1';
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const charLimit = Number(dailyCharLimit ?? process.env.TRANSLATE_DAILY_CHAR_LIMIT) || 0; // 0 = unlimited
  const budget = { day: -1, used: 0 };
  const limiters = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, new KeyedLimiter(v.perSec, v.burst, now)]));

  const clientIp = (req) => {
    if (trustProxy) {
      const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (first) return first;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // Base URL guests open: PUBLIC_URL, else the LAN address when the host page is on localhost (phones
  // cannot open localhost), else the address this request came in on.
  function joinBase(req) {
    if (publicUrl) return publicUrl;
    const host = /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(req.headers.host || '') ? req.headers.host : 'localhost';
    const [, hostname, port] = host.match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/) || [];
    if (lanHost && hostname && isLocalHostname(hostname.toLowerCase())) return `http://${lanHost}${port ? ':' + port : ''}`;
    const fwd = trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = fwd === 'https' || req.socket.encrypted ? 'https' : 'http';
    return `${proto}://${host}`;
  }

  // Daily translation budget in characters, per UTC day of `now`. Reserves before calling the provider.
  function budgetAllows(chars) {
    if (!charLimit) return true;
    const day = Math.floor(now() / DAY_MS);
    if (day !== budget.day) Object.assign(budget, { day, used: 0 });
    if (budget.used + chars > charLimit) return false;
    budget.used += chars;
    return true;
  }
  // A failed provider call gives its reservation back, but only to the day it was taken from.
  function budgetRefund(chars, day) {
    if (charLimit && day === budget.day) budget.used = Math.max(0, budget.used - chars);
  }

  async function translateSegment(room, seg) {
    const to = seg.lang === 'en' ? 'zh' : 'en';
    if (!budgetAllows(seg.text.length)) {
      Object.assign(seg, { translation: null, error: true, errorKind: 'budget' });
      log(`translate skipped room=${room.code}: daily char budget (${charLimit}) used up`);
      return;
    }
    const day = budget.day;
    try {
      const t = await (await getTr()).translate(seg.text, seg.lang, to);
      if (typeof t !== 'string') throw new Error('translator returned non-string');
      seg.translation = t;
    } catch (e) {
      seg.translation = null;
      seg.error = true;
      seg.errorKind = ERROR_KINDS.includes(e?.kind) ? e.kind : 'other';
      budgetRefund(seg.text.length, day);
      log(`translate error room=${room.code} kind=${seg.errorKind}: ${e?.message || e}`);
    }
  }

  // Sends a final again (pending line, or its update) and records the SSE id it went out with.
  function broadcastFinal(room, seg) { seg.seq = room.broadcast(publicSegment(seg)); }

  async function postSegment(req, res, room) {
    requireJson(req);
    const b = await readJson(req);
    const speaker = b.guestToken !== undefined ? 'guest' : 'host';
    if (speaker === 'guest' ? !room.checkGuestToken(b.guestToken) : !room.checkToken(b.hostToken)) throw new HttpError(403, `bad ${speaker} token`);
    if (typeof b.final !== 'boolean') throw new HttpError(400, 'final must be true or false');
    const final = b.final;
    if (typeof b.text !== 'string') throw new HttpError(400, 'text required');
    // An empty interim is a "clear" signal (speaker stopped or switched language); finals need text.
    if (final && !b.text.trim()) throw new HttpError(400, 'text required');
    if (b.text.length > MAX_TEXT) throw new HttpError(413, `text longer than ${MAX_TEXT} chars`);
    if (b.lang !== 'en' && b.lang !== 'zh') throw new HttpError(400, "lang must be 'en' or 'zh'");
    if (!room.allows(b.lang, speaker)) throw new HttpError(400, `room direction ${room.direction} does not accept ${b.lang} from the ${speaker}`);
    if (b.wait !== undefined && typeof b.wait !== 'boolean') throw new HttpError(400, 'wait must be true or false');
    const wait = b.wait !== false;
    let clientKey = null;
    if (final && b.clientId !== undefined) {
      if (typeof b.clientId !== 'string' || !CLIENT_ID.test(b.clientId)) throw new HttpError(400, 'clientId must be 1 to 64 chars from A-Z a-z 0-9 _ -');
      clientKey = `${speaker}:${b.clientId}`;
    }
    // A retry of a final the server already has: answer with that line, store and broadcast nothing.
    const known = clientKey && room.byClientId.get(clientKey);
    if (known) {
      store.touch(room);
      if (wait && known.pending) await known.done;
      return sendJson(res, 200, finalAnswer(known));
    }
    // Translation computed on the host device (Chrome Translator API). Only host finals use it; a guest's
    // `translation` is ignored and the server translates.
    let device = null;
    if (final && speaker === 'host' && b.translation !== undefined && b.translation !== null) {
      if (typeof b.translation !== 'string') throw new HttpError(400, 'translation must be a string');
      if (b.translation.length > MAX_DEVICE_TRANSLATION) throw new HttpError(413, `translation longer than ${MAX_DEVICE_TRANSLATION} chars`);
      device = b.translation.trim() || null;
    }
    const text = b.text.trim();
    if (!final) {
      if (!room.interimLimiter.take()) throw tooMany('too many interim updates, slow down', 1);
      store.touch(room);
      // Interim text shares the id the next final segment will get, so clients can replace it.
      const seg = { id: room.nextId, lang: b.lang, text, translation: null, final: false, ts: now(), speaker };
      // A late interim repeating the line that was just finalized would show up as a stale card: drop it.
      if (!text || text !== room.lastFinalText) room.broadcast(publicSegment(seg));
      return sendJson(res, 200, { id: seg.id, text, translation: null, speaker });
    }
    if (room.segments.length >= MAX_SEGMENTS || room.chars + text.length > MAX_ROOM_CHARS) {
      throw new HttpError(409, 'room transcript is full, start a new room');
    }
    if (!store.hasRoom(text.length)) throw new HttpError(503, 'the server is full, try again later');
    if (!room.finalLimiter.take()) throw tooMany('too many lines in this room, slow down', 1);
    if (!limiters.finalsPerIp.take(clientIp(req))) throw tooMany('too many lines from this address, slow down', 1);
    store.touch(room);
    store.addChars(room, text.length);
    room.lastFinalText = text;
    // Stored at once (transcript and backlog, in id order) and translated in the background.
    const seg = { id: room.nextId++, lang: b.lang, text, translation: device, final: true, ts: now(), speaker, pending: !device };
    if (clientKey) { seg.clientId = b.clientId; room.byClientId.set(clientKey, seg); }
    room.segments.push(seg);
    const done = device ? Promise.resolve() : translateSegment(room, seg).finally(() => { seg.pending = false; });
    seg.done = done;
    let graceTimer;
    const grace = new Promise((r) => { graceTimer = setTimeout(r, GRACE_MS); });
    const inTime = await Promise.race([done.then(() => true), grace.then(() => false)]);
    clearTimeout(graceTimer);
    broadcastFinal(room, seg); // translated, or pending
    // wait:false (the pages): answer now, the translation follows on SSE as the same-id update.
    if (!wait) sendJson(res, 200, finalAnswer(seg));
    if (!inTime) {
      await done;
      broadcastFinal(room, seg); // the update, same id
    }
    if (wait) sendJson(res, 200, finalAnswer(seg));
  }

  // Open streams per client IP (M4), across all rooms.
  const streamsByIp = new Map();

  function events(req, res, room) {
    const q = new URL(req.url, 'http://x').searchParams;
    // The host page opens its stream with ?role=host&token=<hostToken>: not counted as a reader and exempt
    // from the stream caps. Every other stream, including ?role=host without a valid token, is a reader.
    const host = q.get('role') === 'host' && room.checkToken(q.get('token'));
    const ip = clientIp(req);
    if (!host) {
      if ((streamsByIp.get(ip) || 0) >= MAX_STREAMS_PER_IP) throw tooMany('too many open streams from this address', 10);
      if (room.capped() >= MAX_STREAMS_PER_ROOM) throw tooMany('too many readers in this room', 10);
      streamsByIp.set(ip, (streamsByIp.get(ip) || 0) + 1);
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Last-Event-ID is the room's broadcast counter, so a reconnect also gets lines updated since then
    // (a pending line that was translated while the reader was away). Lines still in their grace window
    // have not been broadcast yet and are always included.
    const last = Number(req.headers['last-event-id']) || 0;
    let backlog = 'retry: 2000\n\n';
    for (const s of room.segments) {
      if (s.seq && s.seq <= last) continue;
      backlog += `id: ${s.seq || room.seq}\nevent: segment\ndata: ${JSON.stringify(publicSegment(s))}\n\n`;
    }
    res.write(backlog);
    res.host = host;
    res.reader = !host;
    room.clients.add(res);
    room.sendPresence(); // the new stream learns the count, the others see it change
    const hb = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    hb.unref();
    let gone = false;
    // Runs once, whichever comes first: the client leaves, the room ends (res.end) or the server closes.
    const done = () => {
      clearInterval(hb);
      if (gone) return;
      gone = true;
      if (!host) {
        const n = (streamsByIp.get(ip) || 1) - 1;
        if (n > 0) streamsByIp.set(ip, n); else streamsByIp.delete(ip);
      }
      if (room.clients.delete(res) && res.reader) room.sendPresence();
    };
    req.on('close', done);
    res.on('close', done);
    res.on('finish', done);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = p.match(/^\/api\/rooms(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/);
    if (m) {
      const [, code, sub] = m;
      if (!code) {
        if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
        requireJson(req);
        const b = await readJson(req);
        const direction = b.direction ?? 'en-zh';
        if (!DIRECTIONS.includes(direction)) throw new HttpError(400, `direction must be one of ${DIRECTIONS.join(', ')}`);
        if (!limiters.roomsPerIp.take(clientIp(req))) throw tooMany('too many new rooms from this address, try again later', 360);
        const room = store.create(direction);
        if (!room) throw new HttpError(503, 'too many rooms');
        return sendJson(res, 201, { code: room.code, hostToken: room.hostToken, readToken: room.readToken });
      }
      const room = store.get(code);
      if (!room) {
        // Slow down code guessing: every miss costs a token.
        if (!limiters.notFoundPerIp.take(clientIp(req))) throw tooMany('too many unknown room codes, wait a minute', 60);
        throw new HttpError(404, 'room not found');
      }
      const isGet = req.method === 'GET' || req.method === 'HEAD';
      if (!sub && isGet) return sendJson(res, 200, { code: room.code, direction: room.direction });
      if (!sub && req.method === 'DELETE') {
        if (hasBody(req)) requireJson(req);
        const b = await readJson(req);
        if (!room.checkToken(b.hostToken)) throw new HttpError(403, 'bad host token');
        store.delete(room); // ends every SSE stream
        res.writeHead(204, { ...BASE_HEADERS, 'cache-control': 'no-store' });
        return res.end();
      }
      if (sub === 'qr.svg' && isGet) return send(res, 200, qrSvg(`${joinBase(req)}/j/${room.code}`), 'image/svg+xml; charset=utf-8', { 'cache-control': 'private, max-age=3600' });
      if (sub === 'segments' && req.method === 'POST') return postSegment(req, res, room);
      if (sub === 'guests' && req.method === 'DELETE') {
        requireJson(req);
        const b = await readJson(req);
        if (!room.checkToken(b.hostToken)) throw new HttpError(403, 'bad host token');
        room.resetGuests();
        store.touch(room);
        res.writeHead(204, { ...BASE_HEADERS, 'cache-control': 'no-store' });
        return res.end();
      }
      if (sub === 'guests' && req.method === 'POST') {
        // Always JSON, also with no body: a cross-site form POST must not be able to mint tokens.
        requireJson(req);
        await readJson(req);
        if (!limiters.guestsPerIp.take(clientIp(req))) throw tooMany('too many guest joins from this address, try again later', 120);
        const guestToken = room.addGuest();
        if (!guestToken) throw tooMany('this room has too many guests', 60);
        store.touch(room);
        return sendJson(res, 201, { guestToken });
      }
      if (sub === 'events' && req.method === 'GET') return events(req, res, room);
      if (sub === 'transcript' && isGet) {
        const format = url.searchParams.get('format') || 'json';
        if (!['json', 'md', 'txt'].includes(format)) throw new HttpError(400, 'format must be json, md or txt');
        if (!room.checkReadToken(url.searchParams.get('token'))) throw new HttpError(403, 'transcript needs ?token= (host token or read token)');
        const [type, body] = transcript(room, format);
        const extra = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="transcript-${room.code}.${format}"` } : {};
        return send(res, 200, body, type, extra);
      }
      throw new HttpError(sub && !['qr.svg', 'segments', 'events', 'transcript', 'guests'].includes(sub) ? 404 : 405, 'not found');
    }
    if (p === '/api/config') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      // Public, non-secret info for the page footer. Never includes keys.
      return sendJson(res, 200, { translator: tr?.name || process.env.TRANSLATOR || 'mymemory', joinBase: joinBase(req) });
    }
    if (p.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    return serveStatic(req, res, p);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`error: ${e?.stack || e}`);
      if (res.headersSent) return res.end();
      // connection: close answers (oversize body) drop the socket soon after the answer, whatever the client still sends.
      if (e.headers?.connection === 'close') res.once('finish', () => setTimeout(() => req.socket.destroy(), 1000).unref());
      sendJson(res, status, { error: status === 500 ? 'internal error' : e.message }, e.headers);
    });
  });
  const sweeper = setInterval(() => { store.sweep(); for (const l of Object.values(limiters)) l.sweep(); }, SWEEP_MS);
  sweeper.unref();
  server.on('close', () => { clearInterval(sweeper); store.closeAll(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { getTranslator, configWarnings } = await import('./translate/index.js');
  const translator = getTranslator();
  const port = Number(process.env.PORT) || 3000;
  for (const w of configWarnings(translator.name)) console.error('warning: ' + w);
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  // Read once at startup: the address phones on the same network can open.
  const lanHost = publicUrl ? null : lanAddress();
  const server = createServer({ translator, lanHost, log: (m) => console.error(m) });
  server.listen(port, () => {
    console.log(`live-translate on http://localhost:${port} (translator: ${translator.name || process.env.TRANSLATOR || 'mymemory'})`);
    if (publicUrl) return console.log(`Guests join at ${publicUrl} (PUBLIC_URL)`);
    if (lanHost) return console.log(`Guests join at http://${lanHost}:${port} (same Wi-Fi, or a phone hotspot). Open the host page on http://localhost:${port} so the microphone works.`);
    console.log('No private network address found, so phones cannot reach this computer yet. Join the same Wi-Fi or a phone hotspot and restart, or set PUBLIC_URL to an https tunnel (see README.md).');
  });
}
