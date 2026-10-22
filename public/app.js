// Client for all four pages. Everything rendered goes through textContent, never innerHTML.
const $ = (s, root = document) => root.querySelector(s);
const page = document.body.dataset.page;
const codeFromPath = () => (location.pathname.split('/')[2] || '').slice(0, 6).toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LANG_TAG = { en: 'en', zh: 'zh-CN' };
const PROVIDER_LABEL = {
  mock: 'the offline test dictionary (mock)',
  mymemory: 'MyMemory (free, no key)',
  libretranslate: 'LibreTranslate',
  deepl: 'DeepL',
  google: 'Google Cloud Translation',
  azure: 'Microsoft Azure Translator',
};
const PROVIDER_SHORT = { mock: 'the mock translator', mymemory: 'MyMemory', libretranslate: 'LibreTranslate', deepl: 'DeepL', google: 'Google Cloud Translation', azure: 'Azure Translator' };
const INTERIM_TTL_MS = 8000; // an interim card with no update for this long is stale
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const isLocalHost = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]' || h === '::1';

// Public, non-secret server settings: provider name and the base URL guests join on.
const config = fetch('/api/config').then((r) => r.json()).catch(() => ({}));

// Footer: which provider is active. The server never exposes keys.
(async () => {
  const el = $('[data-test=provider]');
  if (!el) return;
  const { translator } = await config;
  el.textContent = PROVIDER_LABEL[translator] || translator || 'unknown provider';
})();

function el(tag, className, text, lang) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  if (lang) n.lang = LANG_TAG[lang] || lang;
  return n;
}

// Bilingual label for the guest and join pages: Simplified Chinese first, then English.
function bi(zh, en) {
  const f = document.createDocumentFragment();
  f.append(el('span', null, zh, 'zh'), ' / ', el('span', null, en, 'en'));
  return f;
}
const setBi = (node, zh, en) => node.replaceChildren(bi(zh, en));

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Shared SSE listener with reconnect handling. onState gets 'open' | 'reconnecting' | 'ended'.
// `presence` events carry {readers}; the server sends one right after the backlog on every connect.
// `token`: the host token, so the server knows this is the host's own stream (not counted as a reader).
function listen(code, onSegment, onState, { role, token, onPresence = () => {} } = {}) {
  let es;
  let closed = false;
  const query = role ? `?role=${role}` + (token ? `&token=${encodeURIComponent(token)}` : '') : '';
  const open = () => {
    es = new EventSource(`/api/rooms/${code}/events` + query);
    es.addEventListener('segment', (e) => onSegment(JSON.parse(e.data)));
    es.addEventListener('presence', (e) => { try { onPresence(JSON.parse(e.data)); } catch { /* ignore */ } });
    // End room: the server says so before closing, so there is no reconnect round trip.
    es.addEventListener('end', () => { closed = true; es.close(); onState('ended'); });
    es.addEventListener('open', () => onState('open'));
    es.addEventListener('error', async () => {
      if (closed) return;
      if (es.readyState === EventSource.CONNECTING) return onState('reconnecting');
      // CLOSED: the server refused (room ended or expired) or the network is gone. Check, then retry.
      onState('reconnecting');
      try {
        const r = await fetch(`/api/rooms/${code}`, { cache: 'no-store' });
        if (r.status === 404) { closed = true; return onState('ended'); }
      } catch { /* offline; keep retrying */ }
      setTimeout(open, 3000);
    });
  };
  open();
  return () => { closed = true; es?.close(); };
}

// Interim cards disappear on a clear signal (empty text) or after INTERIM_TTL_MS without an update.
function trackInterim(li, onRemove) {
  clearTimeout(li._expire);
  if (!li.classList.contains('interim')) return;
  li._expire = setTimeout(() => { if (li.isConnected && li.classList.contains('interim')) { li.remove(); onRemove(); } }, INTERIM_TTL_MS);
}
// `speaker`: clear only that speaker's live card (host and guest can talk at the same time). No speaker: all.
function clearInterims(list, onRemove, speaker) {
  const sel = speaker ? `li.interim[data-speaker="${speaker}"]` : 'li.interim';
  for (const li of list.querySelectorAll(sel)) { clearTimeout(li._expire); li.remove(); }
  onRemove();
}
// The card for a segment. Each speaker has at most one live (interim) card; finals are keyed by id and kept in
// id order above the live cards. A final takes over its own speaker's live card, never the other one's.
function cardFor(list, seg) {
  const speaker = seg.speaker || 'host';
  let li = seg.final ? list.querySelector(`li[data-id="${seg.id}"]:not(.interim)`) : null;
  li ??= list.querySelector(`li.interim[data-speaker="${speaker}"]`);
  if (!li) { li = document.createElement('li'); li.dataset.speaker = speaker; list.append(li); }
  const was = li.dataset.id;
  li.dataset.id = seg.id;
  if (seg.final && (li.classList.contains('interim') || was === undefined)) {
    li.classList.remove('interim');
    const later = [...list.children].find((x) => x !== li && (x.classList.contains('interim') || Number(x.dataset.id) > seg.id));
    if (later) list.insertBefore(li, later); else list.append(li);
  }
  return li;
}
const randomId = () => {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a); // also on plain http, unlike crypto.randomUUID
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
};

// Pressed state for hold-to-talk buttons (pointer, touch and keyboard). `down` and `up` run once per hold.
function holdButton(btn, down, up) {
  let held = false;
  const press = (e) => { if (held || btn.disabled) return; held = true; e?.preventDefault?.(); down(); };
  const release = () => { if (!held) return; held = false; up(); };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { btn.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    press(e);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) btn.addEventListener(ev, release);
  btn.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) press(e); });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } });
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long press on phones
  btn.addEventListener('click', (e) => e.preventDefault());
}

// ---- Sending lines (host and guest). Speech results, typed text and the test hook share one path. ----
// Finals are posted with wait:false, so the server answers once the line is stored and the translation
// follows on the event stream; no POST stays open for a slow provider. The next final goes out once the
// previous one has landed: its POST was answered, or the page's own event stream shows it (matched by its
// clientId). So ids follow the feed order. Each final has a random clientId, reused on every retry, so a
// retry of a line the server already has is answered with that line and not stored twice. A final refused
// with 429, 5xx or a network error is retried with backoff, and later finals wait behind it. Interims are
// throttled to about 3 per second, newest text wins, and may be dropped.
const RETRY_MS = [500, 1000, 2000, 4000, 8000];
const MAX_TRIES = 20; // about two minutes at the 8 s cap, then the line is given up
const INTERIM_GAP_MS = 350;
const REFUSED = {
  403: 'This browser is not allowed to send text to this room.',
  404: 'This room has ended. Start a new room.',
  409: 'The transcript is full. Start a new room to continue.',
  413: 'That line is too long to send.',
};
// `refreshAuth`: called once when a POST gets 403 (a guest token the host revoked); the POST is then repeated.
function createSender({ code, auth, refreshAuth, prepare = () => ({}), onRetry = () => {}, onRecovered = () => {}, onFail = () => {} }) {
  const queue = [];
  let retrying = false;
  let stopped = false;
  let interim = null;
  let interimLang = 'en';
  let interimTimer = null;
  let lastInterimAt = 0;
  let interimOnScreen = false;
  let interimInFlight = Promise.resolve();

  // An auth error marked retry:false (e.g. no free guest reply slot) is final; any other auth failure is
  // treated like a network error and retried.
  const authFailed = (e) => (e && e.retry === false ? e : Object.assign(new Error('offline'), { retry: true }));
  async function post(body, reauthed = false) {
    let creds;
    try { creds = await auth(); } catch (e) { throw authFailed(e); }
    let r;
    try {
      r = await fetch(`/api/rooms/${code}/segments`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...creds, ...body }),
      });
    } catch {
      throw Object.assign(new Error('offline'), { retry: true });
    }
    if (r.ok) return r.json();
    if (r.status === 403 && refreshAuth && !reauthed) {
      try { await refreshAuth(); } catch (e) { throw authFailed(e); }
      return post(body, true);
    }
    const retry = r.status === 429 || r.status >= 500;
    throw Object.assign(new Error(REFUSED[r.status] || `The server refused that line (HTTP ${r.status}).`), { retry, status: r.status });
  }
  const waiting = () => queue.filter((i) => i.state !== 'done').length;

  function kick() {
    while (queue.length && queue[0].state === 'done') queue.shift();
    for (const item of queue) {
      if (item.state === 'done') continue;
      if (item.state === 'backoff' || item.state === 'preparing') return;
      if (item.state === 'flight') {
        if (!item.landed) return;
        continue;
      }
      if (!item.prepared) {
        item.state = 'preparing';
        item.ready.then(() => { item.state = 'new'; kick(); });
        return;
      }
      send(item);
      return;
    }
  }

  async function send(item) {
    item.state = 'flight';
    item.landed = false;
    item.tries++;
    await interimInFlight; // a late interim must not overtake its final
    try {
      const out = await post({ text: item.text, lang: item.lang, final: true, wait: false, clientId: item.clientId, ...item.extra });
      item.state = 'done';
      item.resolve(out);
      if (retrying && !queue.some((i) => i.state === 'backoff')) { retrying = false; onRecovered(); }
    } catch (e) {
      if (!e.retry || item.tries >= MAX_TRIES || stopped) {
        item.state = 'done';
        if (retrying && !queue.some((i) => i.state === 'backoff')) retrying = false;
        if (!stopped) onFail(e, item);
        item.reject(e);
      } else {
        item.state = 'backoff';
        retrying = true;
        onRetry(waiting());
        await sleep(RETRY_MS[Math.min(item.tries - 1, RETRY_MS.length - 1)]);
        if (item.state === 'backoff') item.state = 'new';
      }
    }
    kick();
  }

  function final(text, lang) {
    return new Promise((resolve, reject) => {
      if (stopped) return reject(new Error('stopped'));
      const item = { text, lang, resolve, reject, state: 'new', tries: 0, extra: {}, prepared: false, clientId: randomId() };
      item.ready = Promise.resolve().then(() => prepare(text, lang)).catch(() => ({}))
        .then((x) => { item.extra = x || {}; item.prepared = true; });
      queue.push(item);
      interim = null; // the final supersedes any interim not yet sent
      interimOnScreen = false;
      kick();
    });
  }

  function scheduleInterim() {
    if (interimTimer || interim == null || stopped) return;
    interimTimer = setTimeout(() => {
      interimTimer = null;
      if (interim == null || stopped) return;
      const t = interim;
      interim = null;
      lastInterimAt = Date.now();
      interimOnScreen = t !== '';
      interimInFlight = post({ text: t, lang: interimLang, final: false }).catch(() => {});
    }, Math.max(0, lastInterimAt + INTERIM_GAP_MS - Date.now()));
  }
  function sendInterim(text, lang) { interim = text; interimLang = lang; scheduleInterim(); }
  // Tell readers to drop the "Listening..." card (on stop, release and language switch).
  function clearInterim() { if (interimOnScreen || interim) sendInterim('', interimLang); }
  // A final of ours arrived on the event stream: the server has stored it, so the next one may go. Matched by
  // clientId: an older line with the same text, or a backlog replay, must not release the queue.
  function landed(seg) {
    if (!seg.clientId) return;
    const item = queue.find((i) => i.state === 'flight' && !i.landed && i.clientId === seg.clientId);
    if (!item) return;
    item.landed = true;
    kick();
  }
  function stop() {
    stopped = true;
    interim = null;
    for (const i of queue) if (i.state !== 'done') { i.state = 'done'; i.reject(new Error('stopped')); }
    queue.length = 0;
  }
  return { final, interim: sendInterim, clearInterim, landed, stop, get retrying() { return retrying; } };
}

// Recognition results -> lines. Each final is delivered once, even when Android repeats it.
function resultHandler(feed, lang) {
  return (e) => {
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { if (i >= e.resultIndex) Promise.resolve(feed(r[0].transcript, true, lang)).catch(() => {}); }
      else interim += r[0].transcript;
    }
    if (interim.trim()) feed(interim, false, lang);
  };
}

/* ---------------- Home ---------------- */
if (page === 'home') {
  const err = $('[data-test=start-error]');
  for (const b of document.querySelectorAll('[data-dir]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      err.textContent = '';
      try {
        const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: b.dataset.dir }) });
        if (r.status === 429) throw new Error('This device has started many rooms in the last hour. Try again later.');
        if (!r.ok) throw new Error(`The server answered HTTP ${r.status}. Try again.`);
        const { code, hostToken } = await r.json();
        sessionStorage.setItem('hostToken:' + code, hostToken);
        location.href = '/host/' + code;
      } catch (e) {
        b.disabled = false;
        err.textContent = 'Could not start a room. ' + (e instanceof TypeError ? 'You seem to be offline.' : e.message || '');
      }
    });
  }
}

/* ---------------- Join ---------------- */
if (page === 'join') {
  const input = $('[data-test=code-input]');
  const err = $('[data-test=error]');
  // No maxlength on the input: pasted "ABC-234" must keep all six characters after cleaning.
  input.addEventListener('input', () => {
    const clean = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (clean !== input.value) input.value = clean;
    err.textContent = '';
  });
  input.focus();
  $('[data-test=join-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (code.length !== 6) return setBi(err, '房间码是六位字符。', 'The code is six characters long.');
    try {
      const r = await fetch('/api/rooms/' + encodeURIComponent(code));
      if (r.ok) { location.href = '/j/' + code; return; }
      if (r.status === 404) setBi(err, '找不到这个房间，请向对方确认房间码。', 'No room with that code. Check it with the speaker.');
      else if (r.status === 429) setBi(err, '尝试次数太多，请等一分钟再试。', 'Too many tries. Wait a minute and try again.');
      else setBi(err, '出了点问题，请重试。', 'Something went wrong. Try again.');
    } catch {
      setBi(err, '网络好像断开了，请重试。', 'You seem to be offline. Try again.');
    }
  });
}

/* ---------------- Guest (phone) ---------------- */
if (page === 'guest') {
  const code = codeFromPath();
  const list = $('[data-test=segments]');
  const waiting = $('[data-test=waiting]');
  const status = $('[data-test=status]');
  $('[data-test=guest-code]').textContent = code;
  document.title = `实时翻译 Live translation ${code}`;
  const STATUS = {
    waiting: ['等待中', 'Waiting', ''],
    speaking: ['正在说话', 'Speaking', 'live'],
    live: ['实时', 'Live', 'live'],
    paused: ['对方暂停', 'Speaker paused', 'quiet'],
    reconnecting: ['正在重新连接', 'Reconnecting', 'warn'],
    ended: ['房间已结束', 'Room ended', 'warn'],
  };
  const PAUSE_MS = 60000; // no new line for this long: tell the reader the speaker paused
  let count = 0;
  let ended = false;
  let paused = false;
  let pauseTimer = null;
  let stick = true; // auto-scroll unless the reader scrolled up to re-read something
  let direction = null;
  let lastHostLang = null;

  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  window.addEventListener('scroll', () => { stick = nearBottom(); }, { passive: true });

  // Two lines (Chinese, then small English) so long states fit the bar on a narrow phone.
  const setStatus = (key) => {
    const [zh, en, cls] = STATUS[key];
    const stack = el('span', 'stack');
    stack.append(el('span', null, zh, 'zh'), el('small', null, en, 'en'));
    status.replaceChildren(stack);
    status.className = 'pill' + (cls ? ' ' + cls : '');
  };
  const afterInterimGone = () => {
    if (ended || count) return;
    if (!list.querySelector('li')) { waiting.hidden = false; setStatus('waiting'); }
  };
  function armPause() {
    clearTimeout(pauseTimer);
    paused = false;
    pauseTimer = setTimeout(() => { if (!ended && count) { paused = true; setStatus('paused'); } }, PAUSE_MS);
  }

  // ---- Read aloud: speak each new final translation once. Never interims, the join backlog or own replies. ----
  const readBtn = $('[data-test=read-aloud]');
  const tts = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
  let readAloud = tts && localStorage.getItem('guestReadAloud') === '1';
  let caughtUp = false; // false while the backlog of a (re)connect is arriving
  const spoken = new Set();
  const showRead = () => { readBtn.setAttribute('aria-pressed', String(readAloud)); };
  readBtn.hidden = !tts;
  showRead();
  readBtn.addEventListener('click', () => {
    readAloud = !readAloud;
    localStorage.setItem('guestReadAloud', readAloud ? '1' : '0');
    if (!readAloud) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
    showRead();
  });
  // Only lines whose big text is a translation (the speaker talked in the other language).
  function maybeSpeak(seg) {
    if (!seg.final || seg.pending || seg.translation == null || seg.speaker === 'guest' || spoken.has(seg.id)) return;
    if (seg.lang === readerLang()) return;
    if (!caughtUp) { spoken.add(seg.id); return; } // already on screen when the reader arrived
    if (!readAloud) return;
    spoken.add(seg.id);
    try {
      const u = new SpeechSynthesisUtterance(seg.translation);
      u.lang = seg.lang === 'en' ? 'zh-CN' : 'en-US';
      speechSynthesis.speak(u);
    } catch { /* no voice */ }
  }

  // ---- Reader language: the language of the big text. Fixed by one-way rooms, a toggle in both-ways rooms. ----
  const readerBtn = $('[data-test=reader-lang]');
  let readerPick = localStorage.getItem('guestReaderLang');
  if (readerPick !== 'zh' && readerPick !== 'en') readerPick = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  const readerLang = () => direction === 'en-zh' ? 'zh' : direction === 'zh-en' ? 'en' : readerPick;
  function showReaderLang() {
    const l = readerLang();
    readerBtn.dataset.lang = l;
    readerBtn.hidden = direction !== 'both';
    const stack = el('span', 'stack');
    if (l === 'zh') stack.append(el('span', null, '大字：中文', 'zh'), el('small', null, 'Big text: Chinese', 'en'));
    else stack.append(el('span', null, '大字：英文', 'zh'), el('small', null, 'Big text: English', 'en'));
    readerBtn.querySelector('.stack').replaceWith(stack);
    readerBtn.title = l === 'zh' ? '改为英文大字 / Switch big text to English' : '改为中文大字 / Switch big text to Chinese';
  }
  readerBtn.addEventListener('click', () => {
    readerPick = readerLang() === 'zh' ? 'en' : 'zh';
    try { localStorage.setItem('guestReaderLang', readerPick); } catch { /* private mode */ }
    showReaderLang();
    rerender();
  });
  function rerender() { for (const li of list.querySelectorAll('li')) if (li._seg) fill(li, li._seg); }

  // Fills a card. Lines from the speaker: [data-test=big] in the reader language (the original when it was
  // spoken in it, else the translation or its placeholder) and [data-test=small] with the other text.
  function fill(li, seg) {
    li._seg = seg;
    const mine = seg.speaker === 'guest';
    li.className = (seg.final ? '' : 'interim') + (mine ? ' mine' : '');
    const target = seg.lang === 'en' ? 'zh' : 'en';
    if (mine) {
      // The reader's own reply: their words first, the translation the speaker sees below.
      const who = el('p', 'g-who'); who.append(bi('你', 'You'));
      const own = el('p', 'g-own', seg.text, seg.lang);
      let tr;
      if (!seg.final) { tr = el('p', 'g-orig'); tr.append(bi('正在听...', 'Listening...')); }
      else if (seg.pending) { tr = el('p', 'g-orig pending'); tr.append(bi('翻译中', 'Translating')); }
      else tr = el('p', 'g-orig', seg.translation ?? '', target);
      li.replaceChildren(who, own, tr);
      return;
    }
    // The translation (or its placeholder) as a paragraph with the given class.
    const trP = (cls) => {
      let p;
      if (!seg.final) { p = el('p', cls); p.append(bi('正在听...', 'Listening...')); }
      else if (seg.pending) { p = el('p', cls + ' pending'); p.append(bi('翻译中', 'Translating')); }
      else if (seg.translation == null) { p = el('p', cls + ' unavailable'); p.append(bi('此句暂无翻译', 'Translation unavailable for this line')); }
      else p = el('p', cls, seg.translation, target);
      return p;
    };
    let big, small;
    if (seg.lang === readerLang()) { big = el('p', 'g-tr', seg.text, seg.lang); small = trP('g-orig'); if (!seg.final) small = el('p', 'g-orig'); }
    else { big = trP('g-tr'); small = el('p', 'g-orig', seg.text, seg.lang); }
    big.dataset.test = 'big';
    small.dataset.test = 'small';
    li.replaceChildren(big, small);
  }

  function render(seg) {
    if (!ended && count) { armPause(); if (status.classList.contains('quiet')) setStatus('live'); }
    if (!seg.final && !seg.text) return clearInterims(list, afterInterimGone, seg.speaker || 'host');
    const mine = seg.speaker === 'guest';
    if (!mine && seg.final) lastHostLang = seg.lang;
    if (mine && seg.final) sender.landed(seg);
    const li = cardFor(list, seg);
    fill(li, seg);
    trackInterim(li, afterInterimGone);
    if (seg.final && !li.dataset.counted) { li.dataset.counted = '1'; count++; }
    if (seg.final) { waiting.hidden = true; if (!ended) setStatus('live'); armPause(); }
    else if (count === 0) { waiting.hidden = true; setStatus('speaking'); }
    maybeSpeak(seg);
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }

  // ---- Reply: typed (works over plain http) or hold-to-speak (needs a secure origin). ----
  const replyForm = $('[data-test=reply-form]');
  const replyInput = $('[data-test=reply-input]');
  const replyStatus = $('[data-test=reply-status]');
  const talkBtn = $('[data-test=guest-talk]');
  const replyLang = (text) => direction === 'en-zh' ? 'zh' : direction === 'zh-en' ? 'en' : CJK.test(text) ? 'zh' : 'en';
  const talkLang = () => direction === 'en-zh' ? 'zh' : direction === 'zh-en' ? 'en'
    : lastHostLang ? (lastHostLang === 'en' ? 'zh' : 'en') : /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  const roomInfo = fetch(`/api/rooms/${code}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  roomInfo.then((room) => {
    if (!room) return;
    direction = room.direction;
    if (direction === 'zh-en') {
      replyInput.placeholder = 'Type a reply 输入回复';
      replyInput.lang = 'en';
    }
    showReaderLang();
    rerender();
  });
  let tokenP = null;
  const guestToken = () => tokenP ??= (async () => {
    const key = 'guestToken:' + code;
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const r = await fetch(`/api/rooms/${code}/guests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    // 429: every reply slot of this room is taken, or this network asked for too many reply keys this hour.
    // Retrying right away will not help either way; the server's message tells the two apart.
    if (r.status === 429) {
      const msg = await r.json().then((j) => String(j.error || ''), () => '');
      throw Object.assign(new Error('no reply slot'), { retry: false, full: /too many guests/.test(msg), busy: !/too many guests/.test(msg) });
    }
    if (r.status === 404) throw Object.assign(new Error('room ended'), { retry: false, status: 404 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { guestToken: t } = await r.json();
    try { sessionStorage.setItem(key, t); } catch { /* private mode */ }
    return t;
  })().catch((e) => { tokenP = null; throw e; });
  guestToken().catch(() => {});
  // The host reset the guests: drop the saved token and ask for a new one (createSender does this once per POST).
  const newGuestToken = () => {
    try { sessionStorage.removeItem('guestToken:' + code); } catch { /* private mode */ }
    tokenP = null;
    return guestToken();
  };
  const setReplyStatus = (zh, en) => { if (zh) setBi(replyStatus, zh, en); else replyStatus.textContent = ''; };
  const sender = createSender({
    code,
    auth: async () => ({ guestToken: await guestToken() }),
    refreshAuth: newGuestToken,
    onRetry: () => setReplyStatus('网络不稳，正在重试...', 'Connection is slow. Retrying...'),
    onRecovered: () => setReplyStatus(),
    onFail: (e) => (e.retry ? setReplyStatus('没有发出去，请检查网络后再试。', 'Not sent. Check the connection and try again.')
      : e.status === 404 ? endUi()
      : e.busy ? setReplyStatus('这个网络最近加入的人太多，没有发出去。请过几分钟再试。你仍然可以阅读。', 'Not sent: too many people joined from this network recently. Try again in a few minutes. You can still read.')
      : e.full ? setReplyStatus('这个房间的回复名额已满，没有发出去。你仍然可以阅读。请对方点 "Reset guests"。', 'Not sent: this room has no free reply slots. You can still read. Ask the speaker to tap "Reset guests".')
      : setReplyStatus('没有发出去。', 'Not sent.')),
  });
  const pendingReplies = new Set();
  replyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = replyInput.value.trim().slice(0, 2000);
    if (!text || pendingReplies.has(text) || ended) return;
    pendingReplies.add(text);
    setReplyStatus();
    // The text stays in the box until the server has it.
    roomInfo.then(() => sender.final(text, replyLang(text)))
      .then(() => { if (replyInput.value.trim() === text) replyInput.value = ''; })
      .catch(() => { if (!replyInput.value.trim()) replyInput.value = text; })
      .finally(() => pendingReplies.delete(text));
  });

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  talkBtn.hidden = !(SR && window.isSecureContext);
  const feedGuest = (text, isFinal, l) => {
    text = String(text ?? '').trim().slice(0, 2000);
    if (!text || ended) return Promise.resolve();
    if (!isFinal) { sender.interim(text, l); return Promise.resolve(); }
    return sender.final(text, l);
  };
  let talk = null;
  if (!talkBtn.hidden) {
    holdButton(talkBtn, () => {
      if (ended || talk) return;
      const l = talkLang();
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = l === 'zh' ? 'zh-CN' : 'en-US';
      talk = r;
      r.onresult = resultHandler(feedGuest, l);
      r.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setReplyStatus('无法使用麦克风，请改为打字。', 'The microphone is blocked here. Type instead.');
      };
      r.onend = () => { if (talk === r) talk = null; sender.clearInterim(); talkBtn.classList.remove('recording'); };
      talkBtn.classList.add('recording');
      talkBtn.setAttribute('aria-pressed', 'true');
      setReplyStatus();
      try { r.start(); } catch { talk = null; talkBtn.classList.remove('recording'); }
    }, () => {
      talkBtn.setAttribute('aria-pressed', 'false');
      const r = talk;
      if (!r) return;
      // stop(), not abort(): the recognizer finalizes the last words, then ends.
      try { r.stop(); } catch { /* already stopped */ }
      setTimeout(() => { if (talk === r) { talk = null; talkBtn.classList.remove('recording'); } }, 4000);
    });
  }

  function endUi() {
    if (ended) return;
    ended = true;
    clearTimeout(pauseTimer);
    sender.stop();
    try { talk?.stop(); } catch { /* ignore */ }
    setStatus('ended');
    clearInterims(list, () => {});
    for (const li of list.querySelectorAll('li')) if (li._seg?.pending) li._seg = { ...li._seg, pending: false, translation: null };
    for (const p of list.querySelectorAll('.pending')) {
      p.classList.replace('pending', 'unavailable');
      p.replaceChildren(bi('未翻译', 'Not translated'));
    }
    if (count) list.after(waiting); // the reader is at the bottom of the list
    waiting.hidden = false;
    waiting.classList.add('ended');
    setBi($('h1', waiting), '房间已结束', 'This room has ended');
    setBi($('p', waiting), '请对方新建一个房间，并把新的房间码发给你。', 'Ask the speaker to start a new room and share the new code.');
    replyInput.disabled = true;
    for (const b of replyForm.querySelectorAll('button')) b.disabled = true;
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }

  listen(code, render, (state) => {
    if (ended) return;
    if (state === 'open') { caughtUp = false; setStatus(paused ? 'paused' : count ? 'live' : 'waiting'); }
    else if (state === 'reconnecting') setStatus('reconnecting');
    else if (state === 'ended') endUi();
  }, { onPresence: () => { caughtUp = true; } });

  // Font size: six steps up to twice the default, remembered on this phone.
  const SCALES = [0.85, 1, 1.25, 1.5, 1.75, 2];
  let level = Math.min(SCALES.length - 1, Math.max(0, Number(localStorage.getItem('guestFont') ?? 1)));
  const up = $('[data-test=font-up]');
  const down = $('[data-test=font-down]');
  const applyScale = () => {
    document.documentElement.style.setProperty('--guest-scale', SCALES[level]);
    up.disabled = level === SCALES.length - 1;
    down.disabled = level === 0;
    localStorage.setItem('guestFont', level);
  };
  up.addEventListener('click', () => { level++; applyScale(); });
  down.addEventListener('click', () => { level--; applyScale(); });
  applyScale();

  // Keep the screen awake while reading; re-request when the tab comes back.
  let lock = null;
  const wake = async () => {
    if (!navigator.wakeLock || lock) return;
    try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch { /* denied or unsupported */ }
  };
  wake();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  document.addEventListener('pointerdown', wake, { once: true });
}
/* ---------------- Host ---------------- */
if (page === 'host') {
  const code = codeFromPath();
  const token = sessionStorage.getItem('hostToken:' + code);
  const status = $('[data-test=status]');
  const micBtn = $('[data-test=mic]');
  const micLabel = $('[data-test=mic-label]');
  const list = $('[data-test=segments]');
  const empty = $('[data-test=empty]');
  const announce = $('[data-test=announce]');
  const typeInput = $('[data-test=type-input]');
  const langBtn = { en: $('[data-test=lang-en]'), zh: $('[data-test=lang-zh]') };
  const pttBtn = { en: $('[data-test=ptt-en]'), zh: $('[data-test=ptt-zh]') };
  const LANG_NAME = { en: 'English', zh: 'Chinese' };
  let lang = 'en';
  let direction = 'both';
  let provider = '';
  let roomEnded = false;
  let stopListening = () => {};
  const allowed = (l) => direction === 'both' || direction.startsWith(l + '-');

  document.title = `Host ${code}: live-translate`;
  $('[data-test=room-code]').textContent = code;
  // The host token doubles as the transcript key, so only this tab's links carry it.
  const dl = (f) => `/api/rooms/${code}/transcript?format=${f}&download=1` + (token ? `&token=${encodeURIComponent(token)}` : '');
  for (const f of ['md', 'txt', 'json']) $(`[data-test=download-${f}]`).href = dl(f);

  // ---- Join link: the same base URL the QR encodes (PUBLIC_URL, else the LAN address when on localhost). ----
  let joinUrl = '';
  config.then((cfg) => {
    provider = cfg.translator || '';
    const base = cfg.joinBase || location.origin;
    joinUrl = `${base}/j/${code}`;
    const link = $('[data-test=join-url]');
    link.textContent = joinUrl.replace(/^https?:\/\//, '');
    link.href = joinUrl;
    const img = document.createElement('img');
    img.src = `/api/rooms/${code}/qr.svg`;
    img.alt = `QR code that opens ${joinUrl}`;
    img.dataset.test = 'qr';
    img.width = 184; img.height = 184;
    $('[data-test=qr]').replaceWith(img);
    let baseUrl = null;
    try { baseUrl = new URL(base); } catch { /* keep null */ }
    const local = !baseUrl || isLocalHost(baseUrl.hostname);
    $('[data-test=localhost-warning]').hidden = !(isLocalHost(location.hostname) && local);
    // A plain http LAN link only works when both devices share a network that lets them see each other.
    $('[data-test=network-hint]').hidden = local || baseUrl.protocol === 'https:';
  });

  const copyBtn = $('[data-test=copy]');
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(joinUrl); copyBtn.textContent = 'Copied'; }
    catch { copyBtn.textContent = 'Copy failed'; }
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
  });

  const setStatus = (text, cls = '') => { status.textContent = text; status.className = 'status' + (cls ? ' ' + cls : ''); };

  // ---- Readers connected (presence from the server; this page's own stream is not counted). ----
  const readersEl = $('[data-test=readers]');
  const readersLabel = $('[data-test=readers-label]');
  function showReaders({ readers }) {
    const n = Math.max(0, Number(readers) || 0);
    readersEl.textContent = String(n);
    readersLabel.textContent = n === 0 ? 'No one is reading yet' : n === 1 ? 'reader connected' : 'readers connected';
    readersEl.parentElement.classList.toggle('on', n > 0);
  }

  // ---- Translation problem banner: once per kind, never shows keys. ----
  const banner = $('[data-test=translate-banner]');
  const bannerShown = new Set();
  function showBanner(kind) {
    if (!['quota', 'auth', 'budget'].includes(kind) || bannerShown.has(kind)) return;
    bannerShown.add(kind);
    const name = PROVIDER_SHORT[provider] || 'the translation provider';
    const saved = 'Lines are still saved, without a translation.';
    const keyed = 'or switch to a provider with a bigger free tier and its own key (TRANSLATOR=azure or TRANSLATOR=deepl, see README.md)';
    const text = {
      quota: provider === 'mymemory'
        ? `Translation quota reached for MyMemory today. ${saved} Set MYMEMORY_EMAIL on the server for a larger daily quota, ${keyed}.`
        : `Translation quota reached for ${name}. ${saved} Check the provider plan, ${keyed}.`,
      auth: `${name} did not accept this server's key or address. ${saved} Check the provider settings on the server or choose another TRANSLATOR.`,
      budget: `This server's daily translation budget is used up. ${saved} Translation resumes after midnight UTC, or raise TRANSLATE_DAILY_CHAR_LIMIT.`,
    }[kind];
    $('[data-test=banner-text]').textContent = text;
    banner.hidden = false;
  }
  $('[data-test=banner-close]').addEventListener('click', () => { banner.hidden = true; });

  // ---- On-device translation (Chrome Translator API) when the model is already on this device. ----
  // Created on a user gesture; never starts a model download. Any failure falls back to the server.
  const device = { avail: {}, tr: {} };
  const pairOf = (l) => ({ sourceLanguage: l, targetLanguage: l === 'en' ? 'zh' : 'en' });
  const hasDeviceApi = typeof self.Translator?.availability === 'function' && typeof self.Translator?.create === 'function';
  if (hasDeviceApi) {
    for (const l of ['en', 'zh']) {
      Promise.resolve().then(() => self.Translator.availability(pairOf(l))).then((a) => { device.avail[l] = a; }).catch(() => {});
    }
  }
  function prepareDevice() {
    if (!hasDeviceApi) return;
    for (const l of ['en', 'zh']) {
      if (device.avail[l] !== 'available' || device.tr[l] || !allowed(l)) continue;
      device.tr[l] = Promise.resolve().then(() => self.Translator.create(pairOf(l))).catch(() => null);
    }
  }
  async function deviceTranslate(text, l) {
    const p = device.tr[l];
    if (!p) return {};
    try {
      const t = await Promise.race([p.then((tr) => tr?.translate(text)), sleep(5000).then(() => null)]);
      if (typeof t !== 'string' || !t.trim()) return {};
      $('[data-test=device-note]').hidden = false;
      return { translation: t.slice(0, 4000) };
    } catch { return {}; }
  }

  // ---- Sending ----
  let retryShown = false;
  const sender = createSender({
    code,
    auth: () => ({ hostToken: token }),
    prepare: deviceTranslate,
    onRetry: (n) => { retryShown = true; setStatus(`Connection is slow. Retrying ${n === 1 ? '1 line' : n + ' lines'}...`); },
    onRecovered: () => { retryShown = false; restoreStatus(); },
    onFail: (e, item) => {
      retryShown = false;
      setStatus(e.retry ? `A line could not be sent after several tries: "${item.text.slice(0, 60)}". Check the connection.` : e.message, 'bad');
      if (e.status === 404) endRoomUi('This room has ended. Start a new room.');
    },
  });
  const recentFinals = [];
  function feed(text, isFinal, l = lang) {
    text = String(text ?? '').trim().slice(0, 2000);
    if (!text || roomEnded) return Promise.resolve();
    if (!isFinal) { sender.interim(text, l); return Promise.resolve(); }
    // Android Chrome can deliver the same final twice; skip an exact repeat of a recent line.
    const now = Date.now();
    while (recentFinals.length && now - recentFinals[0].at > 3000) recentFinals.shift();
    if (recentFinals.some((f) => f.text === text)) return Promise.resolve();
    recentFinals.push({ text, at: now });
    if (recentFinals.length > 5) recentFinals.shift();
    return sender.final(text, l);
  }
  window.__liveTranslateTest = { feed: (text, isFinal) => feed(text, isFinal) };

  // ---- Language toggle (continuous mode) ----
  function setLang(l) {
    if (langBtn[l].disabled) return;
    if (l !== lang) sender.clearInterim();
    lang = l;
    for (const k of Object.keys(langBtn)) langBtn[k].setAttribute('aria-pressed', String(k === l));
    if (rec) restart();
    else if (SR && token && !roomEnded && !ptt) setStatus(`Ready to listen in ${LANG_NAME[l]}. Hold a button while you speak, or tap the mic to keep listening.`);
  }
  langBtn.en.addEventListener('click', () => setLang('en'));
  langBtn.zh.addEventListener('click', () => setLang('zh'));
  fetch(`/api/rooms/${code}`).then((r) => r.ok ? r.json() : null).then((room) => {
    if (!room) return endRoomUi('This room has expired. Start a new room.');
    direction = room.direction;
    if (direction === 'en-zh') { langBtn.zh.disabled = true; langBtn.zh.title = 'This room only translates English to Chinese'; pttBtn.zh.hidden = true; }
    if (direction === 'zh-en') {
      langBtn.en.disabled = true; langBtn.en.title = 'This room only translates Chinese to English'; setLang('zh');
      pttBtn.en.hidden = true;
      // In a Chinese to English room the host is the Chinese speaker.
      $('.ptt-main', pttBtn.zh).replaceChildren(el('span', null, '我说中文', 'zh'));
      $('.ptt-sub', pttBtn.zh).textContent = 'I speak Chinese';
      delete $('.ptt-sub', pttBtn.zh).dataset.idle;
    }
    $('[data-test=ptt-row]').classList.toggle('single', direction !== 'both');
  }).catch(() => {});

  // ---- Screen wake lock while listening (a locked phone stops recognition). ----
  let wakeLock = null;
  async function holdWake() {
    if (!navigator.wakeLock || wakeLock || document.hidden) return;
    try {
      const l = await navigator.wakeLock.request('screen');
      if (!wantListening) { Promise.resolve(l.release?.()).catch(() => {}); return; }
      wakeLock = l;
      l.addEventListener?.('release', () => { if (wakeLock === l) wakeLock = null; });
    } catch { /* denied or unsupported */ }
  }
  function dropWake() {
    const l = wakeLock;
    wakeLock = null;
    if (l) Promise.resolve(l.release?.()).catch(() => {});
  }
  let stoppedWhileHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (wantListening) holdWake();
    if (stoppedWhileHidden) {
      stoppedWhileHidden = false;
      showIdle('Listening stopped because the screen locked. Tap the mic to continue.');
    }
  });

  // ---- Speech recognition: continuous mode (mic button) ----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let wantListening = false;
  const ERR = {
    'not-allowed': 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.',
    'service-not-allowed': 'The speech service is not allowed in this browser. Try Chrome or Edge.',
    'audio-capture': 'No microphone was found on this device.',
    'network': 'The speech service could not be reached. Check your connection. Some browsers (such as Brave) have no speech service, so try Chrome or Edge.',
    'language-not-supported': 'This browser cannot recognize that language.',
  };
  function showListening() {
    micBtn.setAttribute('aria-pressed', 'true');
    micBtn.setAttribute('aria-label', 'Stop listening');
    micLabel.textContent = 'Listening';
    setStatus(`Hearing ${LANG_NAME[lang]}. Tap the mic to pause.`, 'live');
  }
  function showIdle(msg) {
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.setAttribute('aria-label', 'Start listening');
    micLabel.textContent = 'Keep listening';
    if (msg !== undefined) setStatus(msg);
  }
  function restoreStatus() {
    if (roomEnded) return;
    if (rec) showListening();
    else setStatus(SR ? 'Hold a button while you speak, or tap the mic to keep listening.' : 'Type below instead of speaking.');
  }
  function start() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    const l = lang;
    rec.onresult = resultHandler(feed, l);
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // onend restarts
      wantListening = false;
      dropWake();
      if (document.hidden) { stoppedWhileHidden = true; return; } // explained when the page is back
      showIdle(ERR[e.error] || `Speech recognition stopped (${e.error}). Tap the mic to try again.`);
      status.className = 'status bad';
    };
    rec.onend = () => {
      rec = null;
      if (wantListening && document.hidden) {
        // The screen locked or the tab was hidden; a restart would fail now.
        wantListening = false;
        stoppedWhileHidden = true;
        dropWake();
        sender.clearInterim();
        return showIdle();
      }
      // Browsers stop after a pause or a time limit; keep going until the host taps stop.
      if (wantListening) setTimeout(() => { if (wantListening && !rec && !document.hidden) start(); }, 200);
      else { sender.clearInterim(); showIdle(); }
    };
    rec.onstart = showListening;
    micBtn.setAttribute('aria-pressed', 'true');
    micLabel.textContent = 'Starting';
    setStatus('Allow microphone access if your browser asks.');
    try { rec.start(); } catch (err) { rec = null; wantListening = false; dropWake(); showIdle('Could not start the microphone. ' + (err.message || '')); }
  }
  function stop(msg = 'Paused. Tap the mic to continue.') {
    wantListening = false;
    dropWake();
    const r = rec; rec = null;
    if (r) { r.onend = null; try { r.stop(); } catch { /* already stopped */ } }
    sender.clearInterim();
    showIdle(msg);
  }
  function restart() {
    const r = rec; rec = null;
    if (r) { r.onend = null; try { r.abort(); } catch { /* ignore */ } }
    start();
  }
  micBtn.addEventListener('click', () => {
    if (!SR || !token || roomEnded) return;
    prepareDevice();
    if (wantListening) stop();
    else { wantListening = true; stoppedWhileHidden = false; holdWake(); start(); }
  });

  // ---- Push-to-talk: hold a button while one person speaks, release to send. ----
  // Each press gets its own recognizer in that button's language; release calls stop() (not abort())
  // so the recognizer finalizes the last words before it ends.
  let ptt = null;
  for (const l of ['en', 'zh']) {
    const btn = pttBtn[l];
    holdButton(btn, () => {
      if (!SR || !token || roomEnded || ptt) return;
      prepareDevice();
      if (wantListening || rec) stop(undefined);
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = l === 'zh' ? 'zh-CN' : 'en-US';
      ptt = { rec: r, btn };
      r.onresult = resultHandler(feed, l);
      r.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        setStatus(ERR[e.error] || `Speech recognition stopped (${e.error}).`, 'bad');
      };
      r.onend = () => {
        if (ptt && ptt.rec !== r) return; // a newer press owns the button state now
        ptt = null;
        btn.classList.remove('recording');
        const sub = $('.ptt-sub', btn);
        if (sub.dataset.idle) sub.textContent = sub.dataset.idle;
        sender.clearInterim();
        if (!status.classList.contains('bad') && !sender.retrying) restoreStatus();
      };
      btn.classList.add('recording');
      btn.setAttribute('aria-pressed', 'true');
      const sub = $('.ptt-sub', btn);
      sub.dataset.idle ??= sub.textContent;
      sub.textContent = 'Release to send';
      setStatus(l === 'en' ? 'Listening for English. Release to send.' : 'Listening for Chinese. Release to send.', 'live');
      try { r.start(); } catch (err) { ptt = null; btn.classList.remove('recording'); btn.setAttribute('aria-pressed', 'false'); setStatus('Could not start the microphone. ' + (err.message || ''), 'bad'); }
    }, () => {
      btn.setAttribute('aria-pressed', 'false');
      const cur = ptt;
      if (!cur || cur.btn !== btn || cur.released) return;
      cur.released = true;
      try { cur.rec.stop(); } catch { /* already stopped */ }
      // A recognizer that never ends must not block the next press.
      setTimeout(() => { if (ptt === cur) { ptt = null; cur.rec.onend?.(); } }, 4000);
    });
  }

  if (!SR && token) {
    $('[data-test=nospeech]').hidden = false;
    setStatus('Type below instead of speaking.');
  }
  if (!SR) { micBtn.disabled = true; for (const b of Object.values(pttBtn)) b.disabled = true; }
  if (!token) {
    micBtn.disabled = true;
    for (const b of Object.values(pttBtn)) b.disabled = true;
    typeInput.disabled = true;
    $('[data-test=end-room]').disabled = true;
    setStatus('This browser did not create this room, so it cannot send speech. Open the room on the device that started it, or start a new room.', 'bad');
  }

  // Typed text stays in the input until the server has it, so a failed send loses nothing.
  const typedPending = new Set();
  $('[data-test=type-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = typeInput.value.trim().slice(0, 2000);
    if (!text || typedPending.has(text) || roomEnded) return;
    prepareDevice();
    typedPending.add(text);
    // The mic language toggle is for speech. Typed text in a both-ways room is sent in the language it is
    // written in (Chinese characters: Chinese, else English), the same rule as guest replies.
    const typedLang = direction === 'both' ? (CJK.test(text) ? 'zh' : 'en') : lang;
    sender.final(text, typedLang)
      .then(() => { if (typeInput.value.trim() === text) typeInput.value = ''; })
      .catch(() => { if (!typeInput.value.trim()) typeInput.value = text; })
      .finally(() => typedPending.delete(text));
  });

  // ---- Reset guests: revokes every guest token, so the 20 reply slots are free again. ----
  const resetBtn = $('[data-test=reset-guests]');
  const resetStatus = $('[data-test=reset-guests-status]');
  resetBtn.disabled = !token;
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset guests? Every guest reply key is revoked and the 20 reply slots are freed. Guests who are still here get a new key with their next reply, and everyone can keep reading.')) return;
    resetStatus.textContent = '';
    try {
      const r = await fetch(`/api/rooms/${code}/guests`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken: token }) });
      if (r.status !== 204) throw new Error(`HTTP ${r.status}`);
      resetStatus.textContent = 'Guests reset.';
    } catch (e) {
      resetStatus.textContent = 'Could not reset guests. ' + (e instanceof TypeError ? 'You seem to be offline.' : e.message);
    }
  });

  // ---- End room: deletes the room and transcript on the server for everyone. ----
  const endBtn = $('[data-test=end-room]');
  const endConfirm = $('[data-test=end-confirm]');
  const endErr = $('[data-test=end-error]');
  endBtn.addEventListener('click', () => { endConfirm.hidden = false; endBtn.hidden = true; $('[data-test=end-room-cancel]').focus(); });
  $('[data-test=end-room-cancel]').addEventListener('click', () => { endConfirm.hidden = true; endBtn.hidden = false; endBtn.focus(); });
  const ENDED_BY_HOST = 'Room ended. The transcript was deleted from the server and the listener sees that the room ended.';
  let endingByHost = false;
  $('[data-test=end-room-confirm]').addEventListener('click', async () => {
    endErr.textContent = '';
    endingByHost = true;
    try {
      const r = await fetch(`/api/rooms/${code}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostToken: token }) });
      if (r.status !== 204 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      endRoomUi(ENDED_BY_HOST);
    } catch (e) {
      endingByHost = false;
      endErr.textContent = 'Could not end the room. ' + (e instanceof TypeError ? 'You seem to be offline.' : e.message);
    }
  });
  function endRoomUi(msg) {
    if (roomEnded) return;
    roomEnded = true;
    if (wantListening || rec) stop(msg);
    try { ptt?.rec.stop(); } catch { /* ignore */ }
    ptt = null;
    dropWake();
    sender.stop();
    stopListening();
    clearInterims(list, () => {});
    micBtn.disabled = true;
    typeInput.disabled = true;
    for (const b of [...Object.values(langBtn), ...Object.values(pttBtn)]) b.disabled = true;
    resetBtn.disabled = true;
    $('[data-test=end-zone]').hidden = true;
    $('.downloads').hidden = true;
    $('[data-test=presence]').hidden = true;
    setStatus(msg, 'bad');
  }

  // Leaving the page loses host control (the token lives in this tab only).
  window.addEventListener('beforeunload', (e) => {
    if (roomEnded || !list.querySelector('li:not(.interim)')) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---- Live transcript ----
  const announced = new Set();
  const afterInterimGone = () => { empty.hidden = !!list.querySelector('li'); };
  const UNAVAILABLE = {
    quota: 'Not translated: the translation quota is used up',
    auth: 'Not translated: the provider refused the server settings',
    budget: 'Not translated: the daily translation budget is used up',
    timeout: 'Not translated: the provider did not answer in time',
  };
  function render(seg) {
    if (!seg.final && !seg.text) return clearInterims(list, afterInterimGone, seg.speaker || 'host');
    const li = cardFor(list, seg);
    const guest = seg.speaker === 'guest';
    if (!guest && seg.final) sender.landed(seg);
    li.className = (seg.final ? '' : 'interim') + (guest ? ' from-guest' : '');
    const target = seg.lang === 'en' ? 'zh' : 'en';
    const meta = el('div', 'seg-meta');
    meta.append(el('span', 'tag ' + seg.lang, seg.lang.toUpperCase()));
    if (guest) { const g = el('span', 'tag from-guest'); g.append('Guest ', el('span', null, '对方', 'zh')); meta.append(g); }
    meta.append(el('time', null, seg.final ? fmtTime(seg.ts) : 'speaking'));
    const text = el('p', 'seg-text', seg.text, seg.lang);
    let tr;
    if (!seg.final) tr = el('p', 'seg-tr', '');
    else if (seg.pending) { tr = el('p', 'seg-tr pending'); tr.append(el('span', null, '翻译中', 'zh'), ' Translating'); }
    else if (seg.translation == null) tr = el('p', 'seg-tr unavailable', UNAVAILABLE[seg.errorKind] || 'Translation unavailable for this line');
    else tr = el('p', 'seg-tr', seg.translation, target);
    li.replaceChildren(meta, text, tr);
    trackInterim(li, afterInterimGone);
    empty.hidden = true;
    li.scrollIntoView({ block: 'nearest' });
    if (seg.final && !seg.pending && !announced.has(seg.id)) {
      // One screen reader announcement per final line; interims and pending lines stay silent.
      announced.add(seg.id);
      announce.textContent = seg.translation == null ? seg.text : `${seg.text}. ${seg.translation}`;
    }
    if (seg.final && seg.error) showBanner(seg.errorKind);
  }
  stopListening = listen(code, render, (state) => {
    // Our own End room can reach us over SSE before the DELETE answer; keep the more useful message then.
    if (state === 'ended') endRoomUi(endingByHost ? ENDED_BY_HOST : 'This room has ended. Start a new room.');
    else if (state === 'reconnecting' && !rec && !ptt && !retryShown) setStatus('Reconnecting to the room...');
    else if (state === 'open' && !rec && !ptt && !retryShown && /^Reconnecting/.test(status.textContent)) restoreStatus();
  }, { role: 'host', token, onPresence: showReaders });
}
