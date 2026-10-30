(() => {
  // Office TV board. Two video elements are created once and reused: the clip
  // on screen, and the next clip warmed up behind it. Every other decoder is
  // paused, detached, and load()-ed so a TV left on for weeks does not keep
  // accumulating media buffers. The playlist is clips.js. Listeners and the
  // one-second pulse are registered once.
  const params = new URLSearchParams(location.search);

  function num(key, fallback, min, max) {
    if (!params.has(key)) return fallback;
    const n = Number(params.get(key));
    if (!isFinite(n)) return fallback;
    if (n < min) return min;
    if (max != null && n > max) return max;
    return n;
  }

  const maxClip = num('maxclip', 60, 10, 600);
  const stallSeconds = num('stall', 8, 5, 120);
  const reloadHours = num('reload', 4, 0, 168);
  const hardMinutes = num('hard', 15, 0.05, 240);
  const fresh = params.get('fresh') === '1';
  const debug = params.get('debug') === '1';
  const IDLE_MS = 3000;
  const PULSE_MS = 1000;
  const FAILURES_BEFORE_RELOAD = 3;
  const FAULTS_BEFORE_RELOAD = 5;

  const stage = document.getElementById('stage');
  const primary = document.getElementById('vid');
  const secondary = document.getElementById('vid-next');
  const players = secondary ? [primary, secondary] : [primary];
  const bar = document.querySelector('#progress span');
  const counter = document.getElementById('counter');
  const countdown = document.getElementById('countdown');
  const pauseBtn = document.getElementById('pause');
  const soundBtn = document.getElementById('sound');
  const screenBox = document.getElementById('screen');
  const brand = document.getElementById('brand');
  const mask = document.getElementById('mask');
  const logo = document.getElementById('logo');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  if (!store.get('vb_since')) store.set('vb_since', String(Date.now()));
  store.set('vb_loads', String((Number(store.get('vb_loads')) || 0) + 1));

  // The muted property has to be set in script. The HTML attribute alone is not
  // enough for some TV browsers, and audible autoplay is what they block.
  // autoplay stays off until a slot is the one on screen, so the warmed-up
  // clip does not start a second decoder.
  for (let p = 0; p < players.length; p++) {
    const el = players[p];
    el.muted = true;
    el.defaultMuted = true;
    el.loop = false;
    el.autoplay = false;
    el.playsInline = true;
    el.preload = 'none';
    try { el.disablePictureInPicture = true; } catch (e) {}
  }
  let wantSound = false;

  function readClips() {
    const list = window.CLIPS;
    const out = [];
    if (!list || !list.length) return out;
    for (let n = 0; n < list.length; n++) {
      if (typeof list[n] === 'string' && list[n].trim()) out.push(list[n].trim());
    }
    return out;
  }

  let clips = readClips();
  if (params.get('shuffle') === '1') {
    for (let n = clips.length - 1; n > 0; n--) {
      const j = Math.floor(Math.random() * (n + 1));
      const swap = clips[n];
      clips[n] = clips[j];
      clips[j] = swap;
    }
  }

  let index = 0;
  let generation = 0;
  let activeSlot = 0;
  const slotSrc = players.map(() => '');
  const blanking = players.map(() => false);
  let expectedSrc = '';
  let paused = false;
  let failures = 0;
  let failedGen = -1;
  let reloading = false;
  let reloadDue = false;
  let reloadDeferred = '';
  let switching = false;
  let shownCountdown = '';
  let idleTimer = 0;
  let plateTimer = 0;
  let plateMode = '';
  let fitW = 0;
  let fitH = 0;
  let lastGood = Date.now();
  let lastMediaTime = -1;
  let clipStarted = 0;
  let sawFrame = false;
  let wakeLock = null;
  let recovering = false;
  let faultWindow = 0;
  let faultCount = 0;
  const booted = Date.now();
  const reloadAt = reloadHours > 0 ? booted + reloadHours * 3600 * 1000 : 0;
  const hardReloadAt = reloadAt ? reloadAt + hardMinutes * 60 * 1000 : 0;

  // One formatter for the life of the page. Building a new Intl.DateTimeFormat
  // on the one-second countdown allocated a fresh ICU object every tick, which
  // is what ran the TV out of memory after the live countdown shipped.
  let nyFmt = null;
  let nyClockFmt = null;
  let cachedParts = null;
  let cachedPartsAt = 0;

  function note(msg) {
    store.set('vb_err', new Date().toLocaleTimeString() + ' ' + msg);
  }

  function clearTimer(id) {
    if (id) clearTimeout(id);
    return 0;
  }

  function labelOf(src) {
    const path = (src || '').split('?')[0];
    const parts = path.split('/');
    return parts[parts.length - 1] || src || 'clip';
  }

  // Footer plate. Title, tribute, and closing clips put the lockup in different
  // places, so the plate moves. The mask keeps the previous spot covered while
  // the outgoing clip fades. One timeout, cleared on the next change.
  function brandMode(src) {
    const name = labelOf(src);
    if (name.indexOf('vd00') === 0) return 'title';
    if (name.indexOf('vd99') === 0) return 'thanks';
    return 'tribute';
  }

  function setBrand(src) {
    if (!brand || !mask) return;
    if (!src) {
      plateTimer = clearTimer(plateTimer);
      plateMode = '';
      brand.className = '';
      mask.className = '';
      return;
    }
    const mode = brandMode(src);
    if (mode === plateMode) return;
    if (plateMode) {
      mask.className = plateMode + ' show';
      plateTimer = clearTimer(plateTimer);
      plateTimer = setTimeout(() => {
        plateTimer = 0;
        mask.className = '';
      }, 700);
    }
    plateMode = mode;
    brand.className = mode;
  }

  function fitScreen() {
    if (!screenBox) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    if (!vw || !vh) return;
    let w = vw;
    let h = Math.round(w * 9 / 16);
    if (h > vh) {
      h = vh;
      w = Math.round(h * 16 / 9);
    }
    if (w === fitW && h === fitH) return;
    fitW = w;
    fitH = h;
    screenBox.style.width = w + 'px';
    screenBox.style.height = h + 'px';
  }

  function activeEl() {
    return players[activeSlot];
  }

  function otherSlot(i) {
    if (players.length < 2) return i;
    return i ? 0 : 1;
  }

  function dateFormatter() {
    if (!nyFmt) {
      nyFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    }
    return nyFmt;
  }

  function clockFormatter() {
    if (!nyClockFmt) {
      nyClockFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
    return nyClockFmt;
  }

  function nyParts(date) {
    try {
      const bits = dateFormatter().formatToParts(date);
      const grab = (type) => {
        for (let n = 0; n < bits.length; n++) {
          if (bits[n].type === type) return Number(bits[n].value);
        }
        return 0;
      };
      return { y: grab('year'), m: grab('month'), d: grab('day') };
    } catch (e) {
      return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
    }
  }

  function activeParts() {
    const raw = params.get('date');
    if (raw) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (match) return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
    }
    const now = Date.now();
    if (cachedParts && now - cachedPartsAt < 30000) return cachedParts;
    cachedParts = nyParts(new Date());
    cachedPartsAt = now;
    return cachedParts;
  }

  // Wednesday, November 11, 2026, 12:00 AM America/New_York.
  // The instant is resolved once. November 2026 is Eastern Standard Time (UTC-5).
  function wallClockUtc(y, m, d, h, mi, s) {
    const want = Date.UTC(y, m - 1, d, h, mi, s);
    let utc = want;
    let fmt;
    try {
      fmt = clockFormatter();
    } catch (e) {
      return Date.UTC(2026, 10, 11, 5, 0, 0);
    }
    for (let n = 0; n < 4; n++) {
      const bits = fmt.formatToParts(new Date(utc));
      const grab = (type) => {
        for (let i = 0; i < bits.length; i++) {
          if (bits[i].type === type) return Number(bits[i].value);
        }
        return 0;
      };
      let hour = grab('hour');
      if (hour === 24) hour = 0;
      const got = Date.UTC(grab('year'), grab('month') - 1, grab('day'), hour, grab('minute'), grab('second'));
      const delta = got - want;
      if (delta === 0) return utc;
      utc -= delta;
    }
    return utc;
  }

  const VETERANS_AT = wallClockUtc(2026, 11, 11, 0, 0, 0);
  const AFTER_AT = wallClockUtc(2026, 11, 12, 0, 0, 0);

  function frozenNow() {
    const raw = params.get('date');
    if (!raw) return 0;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return 0;
    return wallClockUtc(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0);
  }

  const FROZEN_NOW = frozenNow();

  function clockNow() {
    return FROZEN_NOW || Date.now();
  }

  // Wednesday, November 11, 2026. After that day the thank-you stays up.
  // Whole calendar days in America/New_York, not a floor of the remaining hours.
  function daysUntilVeteransDay(parts) {
    const today = Date.UTC(parts.y, parts.m - 1, parts.d);
    const veterans = Date.UTC(2026, 10, 11);
    return Math.round((veterans - today) / 86400000);
  }

  function countdownMessage(ms) {
    if (ms >= AFTER_AT) return 'HAPPY VETERANS DAY \u2014 THANK YOU FOR YOUR SERVICE';
    if (ms >= VETERANS_AT) return 'Happy Veterans Day / Today';
    let days = daysUntilVeteransDay(activeParts());
    if (days < 1) days = 1;
    return (days === 1 ? '1 day' : days + ' days') + ' until Veterans Day';
  }

  function paintCountdown() {
    const text = countdownMessage(clockNow());
    if (text === shownCountdown) return;
    shownCountdown = text;
    countdown.textContent = text;
    if (text.indexOf('until Veterans Day') === -1 && text !== 'Happy Veterans Day / Today') countdown.classList.add('long');
    else countdown.classList.remove('long');
    publish();
  }

  function publish() {
    window.__board = {
      index: index,
      count: clips.length,
      src: clips.length ? clips[index] : '',
      paused: paused,
      days: daysUntilVeteransDay(activeParts()),
      failures: failures,
      reloadDue: reloadDue,
      videos: players.length,
      loaded: slotSrc.filter((src) => !!src).length
    };
  }

  function findSlot(src) {
    if (!src) return -1;
    for (let i = 0; i < players.length; i++) {
      if (slotSrc[i] === src) return i;
    }
    return -1;
  }

  function slotReady(i, src) {
    const el = players[i];
    return slotSrc[i] === src && (el.getAttribute('src') || '') === src && !el.error;
  }

  function blankSlot(i) {
    if (blanking[i]) return;
    blanking[i] = true;
    const el = players[i];
    slotSrc[i] = '';
    el.classList.remove('on');
    el.autoplay = false;
    try { el.pause(); } catch (e) {}
    // Abort the fetch and drop the decoder. removeAttribute avoids assigning
    // src='', which resolves against the page URL and loads the board as media.
    el.removeAttribute('src');
    try { el.load(); } catch (e) {}
    blanking[i] = false;
  }

  function assignSlot(i, src) {
    const el = players[i];
    if (slotReady(i, src)) return;
    try { el.pause(); } catch (e) {}
    el.classList.remove('on');
    el.autoplay = false;
    el.muted = true;
    el.defaultMuted = true;
    el.preload = 'auto';
    el.removeAttribute('src');
    try { el.load(); } catch (e) {}
    slotSrc[i] = src;
    el.src = src;
  }

  function rewind(el) {
    try {
      if (el.ended || el.currentTime > 0.2) el.currentTime = 0;
    } catch (e) {}
  }

  function sweepStrays() {
    const extras = document.getElementsByTagName('video');
    for (let n = extras.length - 1; n >= 0; n--) {
      const el = extras[n];
      if (players.indexOf(el) !== -1) continue;
      try { el.pause(); } catch (e) {}
      el.removeAttribute('src');
      try { el.load(); } catch (e) {}
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  }

  function releaseAll() {
    switching = true;
    expectedSrc = '';
    for (let i = 0; i < players.length; i++) blankSlot(i);
    sweepStrays();
  }

  function bustedLocation() {
    try {
      const url = new URL(location.href);
      url.searchParams.set('v', String(Date.now()));
      return url.toString();
    } catch (e) {
      const join = location.href.indexOf('?') === -1 ? '?' : '&';
      return location.href + join + 'v=' + Date.now();
    }
  }

  function failureReload(reason) {
    return reason.indexOf('fail') === 0;
  }

  function requestReload(reason) {
    if (reloading) return true;
    // A navigation while offline replaces the board with the browser error page.
    if (navigator.onLine === false) {
      reloadDeferred = reason;
      note('offline defer ' + reason);
      return false;
    }
    const last = Number(store.get('vb_reload_at')) || 0;
    if (failureReload(reason) && Date.now() - last < 180000) {
      failures = 0;
      note('reload suppressed ' + reason);
      return false;
    }
    reloading = true;
    note(reason);
    store.set('vb_reload_at', String(Date.now()));
    store.set('vb_reason', reason);
    if (clips.length) store.set('vb_next', String((index + 1) % clips.length));
    try { releaseAll(); } catch (e) {}
    location.replace(bustedLocation());
    return true;
  }

  function skipCurrent(reason) {
    const gen = generation;
    if (failedGen === gen || reloading) return;
    failedGen = gen;
    note(reason);
    setTimeout(() => {
      if (generation !== gen || reloading) return;
      if (reloadDue) {
        if (requestReload('scheduled')) return;
      }
      failures += 1;
      publish();
      if (!clips.length) return;
      if (failures >= FAILURES_BEFORE_RELOAD) {
        if (requestReload('fail ' + reason)) return;
        failures = 0;
      }
      goTo(index + 1);
    }, 0);
  }

  function goTo(n) {
    if (!clips.length) {
      showEmpty();
      return;
    }
    if (fresh && clips.length > 1) {
      const next = ((n % clips.length) + clips.length) % clips.length;
      store.set('vb_next', String(next));
      if (requestReload('fresh')) return;
    }
    show(n);
  }

  function advance(gen, manual) {
    if (gen != null && gen !== generation) return;
    if (!clips.length || reloading) return;
    if (!manual && reloadDue) {
      if (requestReload('scheduled')) return;
    }
    goTo(index + 1);
  }

  function playClip(gen) {
    if (gen !== generation || paused || document.hidden || reloading) return;
    const el = activeEl();
    el.autoplay = true;
    el.muted = !wantSound;
    el.defaultMuted = !wantSound;
    let ret;
    try { ret = el.play(); } catch (e) { ret = Promise.reject(e); }
    // Older TV browsers return undefined from play(). Calling .then on that
    // throws, and a throw here used to reload the Halloween board in a loop.
    Promise.resolve(ret).then(() => {
      if (gen !== generation) {
        try { el.pause(); } catch (e) {}
        return;
      }
      if (paused || document.hidden) {
        try { el.pause(); } catch (e) {}
        return;
      }
      el.classList.add('on');
      lastGood = Date.now();
    }).catch((err) => {
      if (gen !== generation || paused || reloading) return;
      // Switching clips or pausing aborts the in-flight play(). That is not a bad file.
      if (err && err.name === 'AbortError') return;
      // Autoplay is blocked when the element is audible. Mute and try once more.
      if (!el.muted) {
        el.muted = true;
        wantSound = false;
        soundBtn.textContent = '\uD83D\uDD07';
        soundBtn.setAttribute('aria-label', 'Turn sound on');
        playClip(gen);
        return;
      }
      skipCurrent('playback rejected ' + labelOf(clips[index]));
    });
  }

  function pickSlot(src) {
    const found = findSlot(src);
    if (found >= 0) return found;
    if (!slotSrc[activeSlot]) return activeSlot;
    return otherSlot(activeSlot);
  }

  function show(n) {
    if (!clips.length) {
      showEmpty();
      return;
    }
    const gen = ++generation;
    try {
      showClip(n, gen);
    } catch (e) {
      note('show ' + (e && e.message ? e.message : e));
      skipCurrent('show failed');
    }
  }

  function showClip(n, gen) {
    switching = true;
    index = ((n % clips.length) + clips.length) % clips.length;
    const src = clips[index];
    setBrand(src);
    const nextSrc = clips.length > 1 ? clips[(index + 1) % clips.length] : '';
    const slot = pickSlot(src);

    for (let i = 0; i < players.length; i++) {
      if (i === slot) continue;
      try { players[i].pause(); } catch (e) {}
      players[i].classList.remove('on');
      players[i].autoplay = false;
      if (nextSrc && slotSrc[i] === nextSrc && !players[i].error) continue;
      if (slotSrc[i] || players[i].getAttribute('src')) blankSlot(i);
    }

    if (slotReady(slot, src)) rewind(players[slot]);
    else assignSlot(slot, src);

    if (players.length > 1 && nextSrc && nextSrc !== src) {
      const idle = otherSlot(slot);
      if (idle !== slot && (!slotReady(idle, nextSrc))) assignSlot(idle, nextSrc);
    }

    activeSlot = slot;
    expectedSrc = src;
    const el = players[slot];
    counter.style.opacity = '';
    counter.textContent = (index + 1) + ' / ' + clips.length;
    bar.style.width = '0%';
    lastMediaTime = -1;
    sawFrame = false;
    lastGood = Date.now();
    clipStarted = lastGood;
    el.muted = !wantSound;
    el.defaultMuted = !wantSound;
    sweepStrays();
    publish();
    // The load algorithm fires abort/emptied before this function returns.
    setTimeout(() => {
      if (generation === gen) switching = false;
    }, 0);
    if (el.error) {
      skipCurrent('could not load ' + labelOf(src));
      return;
    }
    if (paused || document.hidden) return;
    playClip(gen);
  }

  function showEmpty() {
    releaseAll();
    setBrand('');
    counter.textContent = window.CLIPS ? 'No clips yet' : 'Playlist missing';
    counter.style.opacity = '1';
    bar.style.width = '0%';
    publish();
  }

  function currentSrcMatches() {
    const el = activeEl();
    return !!expectedSrc && slotSrc[activeSlot] === expectedSrc && (el.getAttribute('src') || '') === expectedSrc;
  }

  function onEnded(ev) {
    if (switching || reloading || ev.currentTarget !== activeEl() || !currentSrcMatches()) return;
    failures = 0;
    lastGood = Date.now();
    publish();
    advance(generation);
  }

  function onError(ev) {
    const el = ev.currentTarget;
    const slot = players.indexOf(el);
    if (slot < 0 || reloading || blanking[slot]) return;
    if (el !== activeEl()) {
      // A warmed clip that fails must not sit in the decoder. The slide it
      // belongs to is loaded again when it comes up, and skipped if it still fails.
      if (!switching && slotSrc[slot]) blankSlot(slot);
      return;
    }
    if (switching || paused || document.hidden || !currentSrcMatches()) return;
    skipCurrent('could not load ' + labelOf(expectedSrc));
  }

  function onStalled(ev) {
    if (ev.currentTarget !== activeEl()) return;
    if (switching || reloading || paused || document.hidden || !currentSrcMatches()) return;
    if (Date.now() - lastGood < stallSeconds * 1000) return;
    skipCurrent('stalled ' + labelOf(expectedSrc));
  }

  function onAbortOrEmptied(ev) {
    if (ev.currentTarget !== activeEl()) return;
    if (switching || reloading || paused || document.hidden || !currentSrcMatches()) return;
    // Our own source swap fires these with no error. A real abort leaves the
    // element with no source, or with a media error, and must not sit there.
    const el = activeEl();
    if (!el.error && el.networkState !== 3) return;
    skipCurrent('aborted ' + labelOf(expectedSrc));
  }

  function onPlaying(ev) {
    if (ev.currentTarget !== activeEl() || reloading || !currentSrcMatches()) return;
    activeEl().classList.add('on');
    lastGood = Date.now();
  }

  for (let p = 0; p < players.length; p++) {
    const el = players[p];
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.addEventListener('stalled', onStalled);
    el.addEventListener('abort', onAbortOrEmptied);
    el.addEventListener('emptied', onAbortOrEmptied);
    el.addEventListener('playing', onPlaying);
  }

  function togglePause() {
    paused = !paused;
    pauseBtn.textContent = paused ? '\u25b6' : '\u2161';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    publish();
    if (!clips.length) return;
    if (paused) {
      try { activeEl().pause(); } catch (e) {}
      if (reloadDue) requestReload('scheduled');
      return;
    }
    lastGood = Date.now();
    clipStarted = lastGood;
    playClip(generation);
  }

  function toggleSound() {
    wantSound = !wantSound;
    activeEl().muted = !wantSound;
    activeEl().defaultMuted = !wantSound;
    soundBtn.textContent = activeEl().muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    soundBtn.setAttribute('aria-label', activeEl().muted ? 'Turn sound on' : 'Turn sound off');
    if (wantSound && !paused && clips.length) playClip(generation);
  }

  document.getElementById('next').onclick = () => advance(generation, true);
  document.getElementById('prev').onclick = () => show(index - 1);
  pauseBtn.onclick = togglePause;
  soundBtn.onclick = (e) => {
    e.stopPropagation();
    toggleSound();
  };
  document.getElementById('full').onclick = () => {
    const request = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    if (request && request.catch) request.catch(() => {});
  };
  addEventListener('keydown', (e) => {
    const key = (e.key || '').toLowerCase();
    wakeCursor();
    if (key === 'arrowright' || key === ' ') {
      e.preventDefault();
      advance(generation, true);
    } else if (key === 'arrowleft') {
      e.preventDefault();
      show(index - 1);
    } else if (key === 'p') togglePause();
    else if (key === 'm') toggleSound();
    else if (key === 'f') document.getElementById('full').click();
  });

  function wakeCursor() {
    stage.classList.add('awake');
    idleTimer = clearTimer(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      stage.classList.remove('awake');
    }, IDLE_MS);
  }
  stage.addEventListener('mousemove', wakeCursor);
  stage.addEventListener('touchstart', wakeCursor);

  function onWakeReleased() {
    wakeLock = null;
    if (!document.hidden) wake();
  }

  async function wake() {
    if (!('wakeLock' in navigator) || document.hidden) return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', onWakeReleased, { once: true });
    } catch (e) {}
  }

  function onVisible() {
    if (document.hidden) {
      lastGood = Date.now();
      clipStarted = Date.now();
      if (!paused) {
        for (let i = 0; i < players.length; i++) {
          try { players[i].pause(); } catch (e) {}
        }
      }
      return;
    }
    wake();
    paintCountdown();
    if (paused || reloading || !clips.length) return;
    lastGood = Date.now();
    clipStarted = Date.now();
    const el = activeEl();
    if (!expectedSrc || el.error || el.networkState === 3) show(index);
    else if (el.paused) playClip(generation);
  }

  function checkReload() {
    if (reloading) return;
    if (hardReloadAt && Date.now() >= hardReloadAt) {
      requestReload('hard');
      return;
    }
    if (reloadAt && !reloadDue && Date.now() >= reloadAt) {
      reloadDue = true;
      publish();
      if (paused || !clips.length || document.hidden) requestReload('scheduled');
    }
  }

  function noteFault(msg) {
    const now = Date.now();
    if (now - faultWindow > 60000) {
      faultWindow = now;
      faultCount = 0;
    }
    faultCount += 1;
    note('error: ' + msg);
    if (faultCount >= FAULTS_BEFORE_RELOAD) {
      faultCount = 0;
      reloadDue = true;
      publish();
    }
  }

  // Recover without reloading inside the handler. A reload from onerror is what
  // reboot-looped the Halloween board when play() threw. A stuck clip is skipped.
  // Repeated faults arm the between-clip page reload instead.
  function recoverFromScript(msg) {
    if (recovering) return;
    recovering = true;
    try {
      noteFault(msg);
      if (reloading || switching || !clips.length) return;
      const el = activeEl();
      if (!expectedSrc || el.error || el.networkState === 3) skipCurrent('script fault');
    } finally {
      recovering = false;
    }
  }

  addEventListener('online', () => {
    if (reloading) return;
    const deferred = reloadDeferred;
    reloadDeferred = '';
    if (deferred) {
      if (requestReload(deferred)) return;
    }
    if (Date.now() - booted < 5000 || paused || !clips.length) return;
    const el = activeEl();
    if (el.error || el.networkState === 3 || !expectedSrc) show(index);
    else if (el.paused && !document.hidden) playClip(generation);
  });

  addEventListener('offline', () => {
    note('offline');
  });

  addEventListener('pagehide', () => {
    plateTimer = clearTimer(plateTimer);
    for (let i = 0; i < players.length; i++) blankSlot(i);
  });

  if (logo) {
    logo.addEventListener('error', function onLogoError() {
      logo.removeEventListener('error', onLogoError);
      logo.removeAttribute('src');
      logo.alt = '';
      logo.style.display = 'none';
    });
  }

  window.onerror = (msg) => {
    recoverFromScript(msg);
    return true;
  };
  addEventListener('unhandledrejection', (ev) => {
    const reason = ev && ev.reason;
    const msg = reason && reason.message ? reason.message : reason;
    recoverFromScript(msg || 'rejection');
    if (ev && ev.preventDefault) ev.preventDefault();
  });

  // One pulse for the countdown, the stall watchdog, the per-clip cap, the
  // wake lock, and the reload deadlines. It is created once.
  let pulseCount = 0;
  setInterval(() => {
    pulseCount += 1;
    try {
      fitScreen();
      // Day count changes at Eastern midnight. Once a minute is enough.
      if (!document.hidden && pulseCount % 60 === 0) paintCountdown();
      if (pulseCount % 60 === 0) wake();
      if (reloading) return;
      checkReload();
      const el = activeEl();
      if (players.length > 1) {
        const idle = players[otherSlot(activeSlot)];
        if (idle !== el && !idle.paused) {
          try { idle.pause(); } catch (e) {}
        }
      }
      if (document.hidden || paused || !clips.length || !expectedSrc) {
        lastGood = Date.now();
        return;
      }
      if (el.error) {
        skipCurrent('could not load ' + labelOf(clips[index]));
        return;
      }
      const duration = el.duration;
      if (duration && isFinite(duration) && duration > 0) {
        bar.style.width = Math.min(100, (100 * el.currentTime) / duration) + '%';
      }
      if (el.currentTime > lastMediaTime + 0.2) {
        lastMediaTime = el.currentTime;
        lastGood = Date.now();
        if (el.currentTime > 3) failures = 0;
        // Time can move while the decoder paints nothing. A black picture is a bad clip.
        if (!sawFrame && el.currentTime > 1) {
          if (el.videoWidth > 0) sawFrame = true;
          else skipCurrent('no frames ' + labelOf(clips[index]));
        }
      } else if (Date.now() - lastGood >= stallSeconds * 1000) {
        lastGood = Date.now();
        skipCurrent('no progress ' + labelOf(clips[index]));
        return;
      }
      if (clipStarted && Date.now() - clipStarted >= maxClip * 1000) {
        clipStarted = Date.now();
        advance(generation);
      }
    } catch (e) {
      noteFault('pulse ' + (e && e.message ? e.message : e));
    }
  }, PULSE_MS);

  if (debug) {
    const dbg = document.createElement('div');
    dbg.style.cssText = 'position:fixed;left:28px;bottom:28px;z-index:9;background:rgba(7,17,31,.82);color:#f4f7fb;font:16px/1.4 monospace;padding:8px 10px;border-radius:6px;white-space:pre';
    document.body.appendChild(dbg);
    setInterval(() => {
      const up = Math.round((Date.now() - Number(store.get('vb_since'))) / 60000);
      dbg.textContent = 'clip: ' + (clips.length ? (index + 1) + '/' + clips.length + '  ' + labelOf(clips[index]) : 'none')
        + '\nrunning: ' + up + ' min'
        + '\npage loads: ' + store.get('vb_loads')
        + '\nloaded decoders: ' + slotSrc.filter((src) => !!src).length
        + '\nlast problem: ' + (store.get('vb_err') || 'none');
    }, 1000);
  }

  function startIndex() {
    if (params.has('slide')) {
      const q = Number(params.get('slide'));
      if (isFinite(q)) return Math.max(1, Math.floor(q)) - 1;
    }
    const raw = store.get('vb_next');
    if (raw) {
      const n = Number(raw);
      store.set('vb_next', '');
      if (isFinite(n) && n >= 0 && clips.length) return n % clips.length;
    }
    return 0;
  }

  fitScreen();
  paintCountdown();
  wake();
  document.addEventListener('visibilitychange', onVisible);

  if (!clips.length) showEmpty();
  else show(startIndex());
})();
