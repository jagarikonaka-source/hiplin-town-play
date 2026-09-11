(function (global) {
  'use strict';
  let last = 0, shown = 0, state = 'loading';
  let initialized = false, prepared = false, frame = 0, timer = 0;
  const el = id => global.document.getElementById(id);
  const reducedMotion = () => global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function paint(value) {
    shown = value;
    el('hiplin-walker').style.left = value + '%';
    el('hiplin-loading-fill').style.width = value + '%';
    const percent = Math.floor(value);
    el('hiplin-loading-progress').setAttribute('aria-valuenow', percent);
    el('hiplin-loading-percent').textContent = percent + '%';
  }
  function animateTo(value, duration, done) {
    global.cancelAnimationFrame(frame);
    if (reducedMotion()) { paint(value); if (done) done(); return; }
    const from = shown;
    let start;
    function step(now) {
      if (state === 'failed') return;
      if (start === undefined) start = now;
      const t = Math.min(1, (now - start) / duration);
      paint(from + (value - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = global.requestAnimationFrame(step);
      else { frame = 0; if (done) done(); }
    }
    frame = global.requestAnimationFrame(step);
  }
  function reveal() {
    if (state !== 'holding') return;
    state = 'revealing';
    const screen = el('hiplin-loading');
    function finish(event) {
      if (event && (event.target !== screen || event.propertyName !== 'opacity')) return;
      if (state !== 'revealing') return;
      global.clearTimeout(timer);
      screen.removeEventListener('transitionend', finish);
      screen.hidden = true;
      state = 'revealed';
    }
    screen.addEventListener('transitionend', finish);
    screen.setAttribute('data-revealing', '');
    // A fallback also completes the handoff if CSS transitions are unavailable.
    timer = global.setTimeout(finish, reducedMotion() ? 0 : 800);
  }
  function completeWhenPrepared() {
    if (state !== 'loading' || !initialized || !prepared) return;
    state = 'completing';
    animateTo(100, 650, () => {
      state = 'holding';
      el('hiplin-loading-status').textContent = '準備ができました。街へ入ります…';
      el('hiplin-loading').setAttribute('data-complete', '');
      // Let 100% and the walker's arrival actually paint before dissolving.
      timer = global.setTimeout(reveal, 400);
    });
  }
  global.HiplinLoading = {
    get covered() { return state !== 'revealed'; },
    progress(value) {
      if (state !== 'loading' || !Number.isFinite(value)) return;
      // Only real loader progress; 100% also requires the town camera to be ready.
      const next = Math.max(last, Math.min(99, Math.floor(Math.max(0, value) * 100)));
      if (next > last) { last = next; animateTo(last, 450); }
      if (last >= 90) el('hiplin-loading-status').textContent = 'まもなく、街へ…';
    },
    ready() { initialized = true; completeWhenPrepared(); },
    sceneReady() { prepared = true; completeWhenPrepared(); },
    fail() {
      if (state === 'revealed' || state === 'failed') return;
      state = 'failed';
      global.cancelAnimationFrame(frame); global.clearTimeout(timer);
      const screen = el('hiplin-loading');
      screen.removeAttribute('data-revealing');
      screen.setAttribute('data-failed', '');
      el('hiplin-loading-status').textContent = '読み込めませんでした。通信状況を確認してください。';
      const retry = el('hiplin-loading-retry'); retry.hidden = false;
      retry.addEventListener('click', () => global.location.reload(), { once:true });
    }
  };
})(window);
