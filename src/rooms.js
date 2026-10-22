// In-memory rooms: codes, host tokens, segments, SSE subscribers, idle expiry, rate limiting.
import crypto from 'node:crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const DIRECTIONS = ['en-zh', 'zh-en', 'both'];
export const IDLE_MS = 12 * 60 * 60 * 1000;
export const MAX_ROOMS = 10000;
export const MAX_SEGMENTS = 5000;
export const MAX_ROOM_CHARS = 200000; // total chars of stored final text per room
export const MAX_GUESTS = 20; // guest tokens per room
export const MAX_TOTAL_CHARS = 50_000_000; // total chars of stored final text across all rooms

const newToken = () => crypto.randomBytes(24).toString('base64url');
function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function newCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}

export function normalizeCode(code) {
  const c = String(code || '').toUpperCase();
  return /^[A-HJ-NP-Z2-9]{6}$/.test(c) ? c : null;
}

// Token bucket: `burst` requests at once, refilled at `perSec`.
export class RateLimiter {
  constructor(perSec = 5, burst = 20, now = Date.now) {
    Object.assign(this, { perSec, burst, now, tokens: burst, last: now() });
  }
  take() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  // True when the bucket has refilled completely, so dropping it changes nothing.
  idle() { return this.tokens + ((this.now() - this.last) / 1000) * this.perSec >= this.burst; }
}

// One token bucket per key (client IP). Full buckets are swept so the map cannot grow without bound.
export class KeyedLimiter {
  constructor(perSec, burst, now = Date.now, maxKeys = 50000) {
    Object.assign(this, { perSec, burst, now, maxKeys, map: new Map() });
  }
  take(key) {
    let l = this.map.get(key);
    if (!l) {
      if (this.map.size >= this.maxKeys) this.sweep();
      // Still full of active keys: forget the oldest ones rather than grow.
      for (const k of this.map.keys()) { if (this.map.size < this.maxKeys) break; this.map.delete(k); }
      l = new RateLimiter(this.perSec, this.burst, this.now);
      this.map.set(key, l);
    }
    return l.take();
  }
  sweep() { for (const [k, l] of this.map) if (l.idle()) this.map.delete(k); }
}

export class Room {
  constructor(code, direction, clock = Date.now) {
    const now = clock();
    this.code = code;
    this.direction = direction;
    this.hostToken = newToken();
    this.readToken = newToken(); // read-only transcript access (G8)
    this.guestTokens = [];
    this.createdAt = now;
    this.lastActive = now;
    this.segments = []; // final segments only
    this.chars = 0; // total chars of stored final text
    this.lastFinalText = null;
    this.nextId = 1;
    this.byClientId = new Map(); // `${speaker}:${clientId}` -> stored final, so a retried POST is not stored twice
    this.seq = 0; // SSE event id: bumped on every final broadcast (pending line or its update)
    this.clients = new Set(); // SSE responses; `res.reader` is false for the host's own stream
    // Separate buckets so a flood of interim results can never starve final lines.
    this.interimLimiter = new RateLimiter(5, 20, clock);
    this.finalLimiter = new RateLimiter(2, 20, clock);
  }
  checkToken(token) { return sameToken(token, this.hostToken); }
  checkReadToken(token) { return sameToken(token, this.hostToken) || sameToken(token, this.readToken); }
  checkGuestToken(token) { return this.guestTokens.some((t) => sameToken(token, t)); }
  // Revokes every guest token and frees the slots (the host's "Reset guests").
  resetGuests() { this.guestTokens = []; }
  addGuest() {
    if (this.guestTokens.length >= MAX_GUESTS) return null;
    const t = newToken();
    this.guestTokens.push(t);
    return t;
  }
  // The host speaks the room's source language; a guest replies in the other one. `both` accepts either.
  allows(lang, speaker = 'host') {
    if (this.direction === 'both') return true;
    return this.direction.startsWith(lang + '-') === (speaker === 'host');
  }
  // `seg` is the public JSON. Finals carry an SSE id (room.seq) so a reconnect can resume via Last-Event-ID.
  broadcast(seg) {
    const msg = (seg.final ? `id: ${++this.seq}\n` : '') + `event: segment\ndata: ${JSON.stringify(seg)}\n\n`;
    for (const c of this.clients) c.write(msg);
    return this.seq;
  }
  readers() { let n = 0; for (const c of this.clients) if (c.reader) n++; return n; }
  // Streams that count against MAX_STREAMS_PER_ROOM: every one except the authenticated host stream.
  capped() { let n = 0; for (const c of this.clients) if (!c.host) n++; return n; }
  sendPresence() {
    const msg = `event: presence\ndata: ${JSON.stringify({ readers: this.readers() })}\n\n`;
    for (const c of this.clients) c.write(msg);
  }
  // `ended`: the room is gone for good (End room, idle expiry), so readers can say so at once.
  close(ended = false) {
    for (const c of this.clients) { if (ended) c.write('event: end\ndata: {}\n\n'); c.end(); }
    this.clients.clear();
  }
}

export class RoomStore {
  constructor({ idleMs = IDLE_MS, now = Date.now, maxTotalChars = MAX_TOTAL_CHARS } = {}) {
    this.rooms = new Map();
    this.idleMs = idleMs;
    this.now = now;
    this.maxTotalChars = maxTotalChars;
    this.totalChars = 0; // stored final text across all rooms
  }
  create(direction) {
    this.sweep();
    if (this.rooms.size >= MAX_ROOMS) return null;
    let code;
    do code = newCode(); while (this.rooms.has(code));
    const room = new Room(code, direction, this.now);
    this.rooms.set(code, room);
    return room;
  }
  get(code) {
    const c = normalizeCode(code);
    const room = c && this.rooms.get(c);
    if (!room) return null;
    if (this.expired(room)) { this.delete(room); return null; }
    return room;
  }
  touch(room) { room.lastActive = this.now(); }
  // Global stored-text cap: true when `n` more chars fit. `addChars` records them for `room`.
  hasRoom(n) { return this.totalChars + n <= this.maxTotalChars; }
  addChars(room, n) { room.chars += n; this.totalChars += n; }
  expired(room) { return this.now() - room.lastActive > this.idleMs; }
  delete(room) {
    room.close(true);
    if (this.rooms.get(room.code) === room) { this.rooms.delete(room.code); this.totalChars -= room.chars; }
  }
  sweep() { for (const r of this.rooms.values()) if (this.expired(r)) this.delete(r); }
  closeAll() { for (const r of this.rooms.values()) r.close(); }
}
