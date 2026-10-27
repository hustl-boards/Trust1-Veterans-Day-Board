(() => {
  // Office TV board. One video element is reused. The playlist is clips.js.
  // There is no GitHub API call. Clips play to the end, muted, so Chrome autoplay works.
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
  const stallSeconds = num('stall', 20, 5, 120);
  const watchdogSeconds = num('watchdog', 90, 20, 600);
  const reloadHours = num('reload', 4, 0, 168);
  const fresh = params.get('fresh') === '1';
  const debug = params.get('debug') === '1';

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
  let timer = 0;
  let stallTimer = 0;
  let lastGood = Date.now();
  let lastMediaTime = -1;
  let sawFrame = false;
  let wakeLock = null;
  const booted = Date.now();
  const reloadAt = reloadHours > 0 ? Date.now() + reloadHours * 3600 * 1000 : 0;

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

  function publish() {
    window.__board = {
      index: index,
      count: clips.length,
      src: clips.length ? clips[index] : '',
      paused: paused,
      days: daysUntilVeteransDay(activeParts())
    };
  }

  function releaseVideo() {
    // Detach the decoder before the next clip. expectedSrc is cleared first so
    // the error some TVs fire when src is removed does not count as a bad file.
    expectedSrc = '';
    vid.onended = null;
    vid.onerror = null;
    vid.onplaying = null;
    try { vid.pause(); } catch (e) {}
    vid.classList.remove('on');
    vid.removeAttribute('src');
    try { vid.load(); } catch (e) {}
  }

  function armStall(gen) {
    stallTimer = clearTimer(stallTimer);
    stallTimer = setTimeout(() => {
      if (gen !== generation || paused) return;
      recover('stalled ' + labelOf(clips[index]));
    }, stallSeconds * 1000);
  }

  function armMax(gen) {
    timer = clearTimer(timer);
    timer = setTimeout(() => {
      if (gen !== generation || paused) return;
      advance(gen);
    }, maxClip * 1000);
  }

  function playClip(gen) {
    let ret;
    try { ret = vid.play(); } catch (e) { ret = Promise.reject(e); }
    // Older TV browsers return undefined from play(). Calling .then on that
    // throws, and a throw here used to reload the Halloween board in a loop.
    Promise.resolve(ret).then(() => {
      if (gen !== generation) return;
      // Pause can land while play() is still resolving. Leave it paused.
      if (paused) {
        try { vid.pause(); } catch (e) {}
        return;
      }
      vid.classList.add('on');
      lastGood = Date.now();
    }).catch((err) => {
      if (gen !== generation || paused) return;
      // Switching clips or pausing aborts the in-flight play(). That is not a bad file.
      if (err && err.name === 'AbortError') return;
      if (!vid.muted) {
        vid.muted = true;
        wantSound = false;
        soundBtn.textContent = '\uD83D\uDD07';
        soundBtn.setAttribute('aria-label', 'Turn sound on');
        playClip(gen);
        return;
      }
      recover('playback rejected ' + labelOf(clips[index]));
    });
  }

  function failureReason(reason) {
    return reason.indexOf('watchdog') === 0
      || reason.indexOf('stalled') === 0
      || reason.indexOf('could not') === 0
      || reason.indexOf('playback rejected') === 0
      || reason.indexOf('no frames') === 0
      || reason.indexOf('no progress') !== -1;
  }

  function safeReload(reason) {
    if (reloading) return;
    note(reason);
    const last = Number(store.get('vb_reload_at')) || 0;
    // A clip that kills the page must not reboot the TV every few seconds.
    if (failureReason(reason) && Date.now() - last < 180000) {
      timer = clearTimer(timer);
      stallTimer = clearTimer(stallTimer);
      failures = 0;
      timer = setTimeout(() => {
        timer = 0;
        if (!reloading) show(0);
      }, 60000);
      return;
    }
    reloading = true;
    store.set('vb_reload_at', String(Date.now()));
    store.set('vb_reason', reason);
    if (clips.length) store.set('vb_next', String((index + 1) % clips.length));
    location.reload();
  }

  function recover(reason) {
    const gen = generation;
    if (failedGen === gen || reloading) return;
    failedGen = gen;
    note(reason);
    setTimeout(() => {
      if (generation !== gen || reloading) return;
      if (reloadDue) {
        safeReload('scheduled');
        return;
      }
      failures += 1;
      if (!clips.length) return;
      if (failures >= clips.length) {
        failures = 0;
        safeReload('watchdog ' + reason);
        return;
      }
      goTo(index + 1);
    }, 0);
  }

  function goTo(n) {
    if (fresh && clips.length > 1) {
      const next = ((n % clips.length) + clips.length) % clips.length;
      store.set('vb_next', String(next));
      location.reload();
      return;
    }
    show(n);
  }

  function advance(gen, manual) {
    if (gen != null && gen !== generation) return;
    if (!clips.length || reloading) return;
    if (!manual && reloadDue) {
      safeReload('scheduled');
      return;
    }
    goTo(index + 1);
  }

  function show(n) {
    if (!clips.length) {
      showEmpty();
      return;
    }
    const gen = ++generation;
    timer = clearTimer(timer);
    stallTimer = clearTimer(stallTimer);
    releaseVideo();
    index = ((n % clips.length) + clips.length) % clips.length;
    const src = clips[index];
    expectedSrc = src;
    counter.style.opacity = '';
    counter.textContent = (index + 1) + ' / ' + clips.length;
    bar.style.width = '0%';
    lastMediaTime = -1;
    sawFrame = false;
    vid.muted = !wantSound;
    publish();

    vid.onended = () => {
      if (generation !== gen) return;
      if ((vid.getAttribute('src') || '') !== expectedSrc) return;
      failures = 0;
      lastGood = Date.now();
      advance(gen);
    };
    vid.onerror = () => {
      const current = vid.getAttribute('src') || '';
      if (!current || current !== expectedSrc || generation !== gen) return;
      recover('could not load ' + labelOf(current));
    };
    vid.onplaying = () => {
      if (generation !== gen) return;
      vid.classList.add('on');
      lastGood = Date.now();
    };
    vid.src = src;
    if (paused) return;
    playClip(gen);
    armMax(gen);
    armStall(gen);
  }

  function showEmpty() {
    timer = clearTimer(timer);
    stallTimer = clearTimer(stallTimer);
    releaseVideo();
    counter.textContent = window.CLIPS ? 'No clips yet' : 'Playlist missing';
    counter.style.opacity = '1';
    bar.style.width = '0%';
    publish();
  }

  function togglePause() {
    paused = !paused;
    pauseBtn.textContent = paused ? '\u25b6' : '\u2161';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    publish();
    if (!clips.length) return;
    if (paused) {
      timer = clearTimer(timer);
      stallTimer = clearTimer(stallTimer);
      try { vid.pause(); } catch (e) {}
      if (reloadDue) safeReload('scheduled');
      return;
    }
    playClip(generation);
    armMax(generation);
    armStall(generation);
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

  async function wake() {
    if (!('wakeLock' in navigator) || document.hidden) return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
  }

  function onVisible() {
    if (document.hidden) return;
    wake();
    if (!paused && expectedSrc && vid.paused && !reloading) playClip(generation);
  }

  // Tick once a minute instead of one multi-hour timeout. Some TV browsers drop long timers.
  function watchReload() {
    if (reloadAt && !reloadDue && Date.now() >= reloadAt) {
      reloadDue = true;
      if (paused || !clips.length) safeReload('scheduled');
    }
    setTimeout(watchReload, 60 * 1000);
  }

  addEventListener('online', () => {
    if (Date.now() - booted < 5000 || paused || !clips.length || reloading) return;
    if (vid.error || vid.networkState === 3) show(index);
  });

  // Log script errors. Reloading here caused a reboot loop when play() threw.
  window.onerror = (msg) => { note('error: ' + msg); };

  setInterval(() => {
    if (reloading) return;
    if (paused || !clips.length || document.hidden) {
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
      failures = 0;
      armStall(generation);
      // Time can move while the decoder paints nothing. A black picture is a bad clip.
      if (!sawFrame && vid.currentTime > 1) {
        if (vid.videoWidth > 0) sawFrame = true;
        else recover('no frames ' + labelOf(clips[index]));
      }
    }
  }, 250);

  setInterval(() => {
    if (paused || !clips.length || document.hidden || reloading) {
      lastGood = Date.now();
      return;
    }
    if (Date.now() - lastGood > watchdogSeconds * 1000) {
      lastGood = Date.now();
      recover('no progress');
    }
  }, 5000);

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
  setInterval(paintCountdown, 60 * 1000);
  wake();
  document.addEventListener('visibilitychange', onVisible);
  setInterval(wake, 60000);
  watchReload();

  if (!clips.length) showEmpty();
  else show(startIndex());
})();
