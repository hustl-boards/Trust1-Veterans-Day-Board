(() => {
  // Office TV board. One video element is reused. The playlist is clips.js.
  // There is no GitHub API call and no second preload element. Clips play to
  // the end, muted, so Chrome autoplay works. Listeners and timers are created
  // once; a clip change only swaps the source on the same element.
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

  const stage = document.getElementById('stage');
  const vid = document.getElementById('vid');
  const bar = document.querySelector('#progress span');
  const counter = document.getElementById('counter');
  const countdown = document.getElementById('countdown');
  const pauseBtn = document.getElementById('pause');
  const soundBtn = document.getElementById('sound');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  if (!store.get('vb_since')) store.set('vb_since', String(Date.now()));
  store.set('vb_loads', String((Number(store.get('vb_loads')) || 0) + 1));

  // The muted property has to be set in script. The HTML attribute alone is not
  // enough for some TV browsers, and audible autoplay is what they block.
  vid.muted = true;
  vid.defaultMuted = true;
  vid.loop = false;
  vid.playsInline = true;
  try { vid.disablePictureInPicture = true; } catch (e) {}
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
  let expectedSrc = '';
  let paused = false;
  let failures = 0;
  let failedGen = -1;
  let reloading = false;
  let reloadDue = false;
  let reloadDeferred = '';
  let switching = false;
  let countdownTimer = 0;
  let idleTimer = 0;
  let lastGood = Date.now();
  let lastMediaTime = -1;
  let clipStarted = 0;
  let sawFrame = false;
  let wakeLock = null;
  const booted = Date.now();
  const reloadAt = reloadHours > 0 ? booted + reloadHours * 3600 * 1000 : 0;
  const hardReloadAt = reloadAt ? reloadAt + hardMinutes * 60 * 1000 : 0;

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

  function nyParts(date) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const bits = fmt.formatToParts(date);
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
    return nyParts(new Date());
  }

  // Wednesday, November 11, 2026. After that day the thank-you stays up.
  function daysUntilVeteransDay(parts) {
    const today = Date.UTC(parts.y, parts.m - 1, parts.d);
    const veterans = Date.UTC(2026, 10, 11);
    return Math.round((veterans - today) / 86400000);
  }

  function paintCountdown() {
    const days = daysUntilVeteransDay(activeParts());
    if (days <= 0) {
      countdown.textContent = 'HAPPY VETERANS DAY \u2014 THANK YOU FOR YOUR SERVICE';
      countdown.classList.add('long');
    } else if (days === 1) {
      countdown.textContent = '1 DAY UNTIL VETERANS DAY';
      countdown.classList.remove('long');
    } else {
      countdown.textContent = days + ' DAYS UNTIL VETERANS DAY';
      countdown.classList.remove('long');
    }
    publish();
  }

  function scheduleCountdown() {
    countdownTimer = clearTimer(countdownTimer);
    if (document.hidden) return;
    countdownTimer = setTimeout(() => {
      countdownTimer = 0;
      if (document.hidden) return;
      paintCountdown();
      scheduleCountdown();
    }, 60 * 1000);
  }

  function publish() {
    window.__board = {
      index: index,
      count: clips.length,
      src: clips.length ? clips[index] : '',
      paused: paused,
      days: daysUntilVeteransDay(activeParts()),
      failures: failures,
      reloadDue: reloadDue
    };
  }

  function discardElement(el) {
    if (!el) return;
    try { el.pause(); } catch (e) {}
    // Abort the fetch and drop the decoder. removeAttribute avoids assigning
    // src='', which resolves against the page URL and loads the board as media.
    // A stray preload element still gets src='' plus load(), then is removed.
    try { el.src = ''; } catch (e) {}
    el.removeAttribute('src');
    try { el.load(); } catch (e) {}
  }

  function releaseVideo() {
    // Detach the decoder before the next clip. expectedSrc is cleared first so
    // the error some TVs fire when src is removed does not count as a bad file.
    switching = true;
    expectedSrc = '';
    try { vid.pause(); } catch (e) {}
    vid.classList.remove('on');
    vid.removeAttribute('src');
    try { vid.load(); } catch (e) {}
    const extras = document.getElementsByTagName('video');
    for (let n = extras.length - 1; n >= 0; n--) {
      if (extras[n] === vid) continue;
      discardElement(extras[n]);
      if (extras[n].parentNode) extras[n].parentNode.removeChild(extras[n]);
    }
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
    let ret;
    try { ret = vid.play(); } catch (e) { ret = Promise.reject(e); }
    // Older TV browsers return undefined from play(). Calling .then on that
    // throws, and a throw here used to reload the Halloween board in a loop.
    Promise.resolve(ret).then(() => {
      if (gen !== generation) return;
      if (paused || document.hidden) {
        try { vid.pause(); } catch (e) {}
        return;
      }
      vid.classList.add('on');
      lastGood = Date.now();
    }).catch((err) => {
      if (gen !== generation || paused || reloading) return;
      // Switching clips or pausing aborts the in-flight play(). That is not a bad file.
      if (err && err.name === 'AbortError') return;
      // Autoplay is blocked when the element is audible. Mute and try once more.
      if (!vid.muted) {
        vid.muted = true;
        wantSound = false;
        soundBtn.textContent = '\uD83D\uDD07';
        soundBtn.setAttribute('aria-label', 'Turn sound on');
        playClip(gen);
        return;
      }
      skipCurrent('playback rejected ' + labelOf(clips[index]));
    });
  }

  function show(n) {
    if (!clips.length) {
      showEmpty();
      return;
    }
    const gen = ++generation;
    releaseVideo();
    index = ((n % clips.length) + clips.length) % clips.length;
    const src = clips[index];
    expectedSrc = src;
    counter.style.opacity = '';
    counter.textContent = (index + 1) + ' / ' + clips.length;
    bar.style.width = '0%';
    lastMediaTime = -1;
    sawFrame = false;
    lastGood = Date.now();
    clipStarted = lastGood;
    vid.muted = !wantSound;
    publish();
    vid.src = src;
    // The load algorithm fires abort/emptied before this function returns.
    setTimeout(() => {
      if (generation === gen) switching = false;
    }, 0);
    if (paused || document.hidden) return;
    playClip(gen);
  }

  function showEmpty() {
    releaseVideo();
    counter.textContent = window.CLIPS ? 'No clips yet' : 'Playlist missing';
    counter.style.opacity = '1';
    bar.style.width = '0%';
    publish();
  }

  function currentSrcMatches() {
    return !!expectedSrc && (vid.getAttribute('src') || '') === expectedSrc;
  }

  function onEnded() {
    if (switching || reloading || !currentSrcMatches()) return;
    failures = 0;
    lastGood = Date.now();
    publish();
    advance(generation);
  }

  function onError() {
    if (reloading || paused || document.hidden || !currentSrcMatches()) return;
    skipCurrent('could not load ' + labelOf(expectedSrc));
  }

  function onStalled() {
    if (switching || reloading || paused || document.hidden || !currentSrcMatches()) return;
    if (Date.now() - lastGood < stallSeconds * 1000) return;
    skipCurrent('stalled ' + labelOf(expectedSrc));
  }

  function onAbortOrEmptied() {
    if (switching || reloading || paused || document.hidden || !currentSrcMatches()) return;
    // Our own source swap fires these with no error. A real abort leaves the
    // element with no source, or with a media error, and must not sit there.
    if (!vid.error && vid.networkState !== 3) return;
    skipCurrent('aborted ' + labelOf(expectedSrc));
  }

  function onPlaying() {
    if (reloading || !currentSrcMatches()) return;
    vid.classList.add('on');
    lastGood = Date.now();
  }

  vid.addEventListener('ended', onEnded);
  vid.addEventListener('error', onError);
  vid.addEventListener('stalled', onStalled);
  vid.addEventListener('abort', onAbortOrEmptied);
  vid.addEventListener('emptied', onAbortOrEmptied);
  vid.addEventListener('playing', onPlaying);

  function togglePause() {
    paused = !paused;
    pauseBtn.textContent = paused ? '\u25b6' : '\u2161';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    publish();
    if (!clips.length) return;
    if (paused) {
      try { vid.pause(); } catch (e) {}
      if (reloadDue) requestReload('scheduled');
      return;
    }
    lastGood = Date.now();
    clipStarted = lastGood;
    playClip(generation);
  }

  function toggleSound() {
    wantSound = !wantSound;
    vid.muted = !wantSound;
    soundBtn.textContent = vid.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    soundBtn.setAttribute('aria-label', vid.muted ? 'Turn sound on' : 'Turn sound off');
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
      countdownTimer = clearTimer(countdownTimer);
      if (!paused) {
        try { vid.pause(); } catch (e) {}
      }
      return;
    }
    wake();
    paintCountdown();
    scheduleCountdown();
    if (paused || reloading || !clips.length) return;
    lastGood = Date.now();
    clipStarted = Date.now();
    if (!expectedSrc || vid.error || vid.networkState === 3) show(index);
    else if (vid.paused) playClip(generation);
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

  addEventListener('online', () => {
    if (reloading) return;
    const deferred = reloadDeferred;
    reloadDeferred = '';
    if (deferred) {
      if (requestReload(deferred)) return;
    }
    if (Date.now() - booted < 5000 || paused || !clips.length) return;
    if (vid.error || vid.networkState === 3 || !expectedSrc) show(index);
    else if (vid.paused && !document.hidden) playClip(generation);
  });

  addEventListener('offline', () => {
    note('offline');
  });

  // Log script errors. Reloading here caused a reboot loop when play() threw.
  window.onerror = (msg) => { note('error: ' + msg); };

  // One pulse for the stall watchdog, the per-clip cap, and the reload deadlines.
  setInterval(() => {
    if (reloading) return;
    checkReload();
    if (document.hidden || paused || !clips.length || !expectedSrc) {
      lastGood = Date.now();
      return;
    }
    const duration = vid.duration;
    if (duration && isFinite(duration) && duration > 0) {
      bar.style.width = Math.min(100, (100 * vid.currentTime) / duration) + '%';
    }
    if (vid.currentTime > lastMediaTime + 0.2) {
      lastMediaTime = vid.currentTime;
      lastGood = Date.now();
      if (vid.currentTime > 3) failures = 0;
      // Time can move while the decoder paints nothing. A black picture is a bad clip.
      if (!sawFrame && vid.currentTime > 1) {
        if (vid.videoWidth > 0) sawFrame = true;
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

  paintCountdown();
  scheduleCountdown();
  wake();
  document.addEventListener('visibilitychange', onVisible);
  setInterval(wake, 60000);

  if (!clips.length) showEmpty();
  else show(startIndex());
})();
