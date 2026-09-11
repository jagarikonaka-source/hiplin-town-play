(function (global) {
  'use strict';
  let last = 0, state = 'loading', typingTimer, revealTimer;
  const el = id => global.document.getElementById(id);
  const greeting = 'ようこそ、HIPLIN TOWNへ！\nゆっくりしていってね。';
  const reducedMotion = () => global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function install() {
    // Keep keyboard focus and pointer gestures in the opening until entry.
    const game = el('unity-container');
    if (game) game.inert = true;
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'keydown', 'keyup', 'wheel']) {
      el('hiplin-loading').addEventListener(type, event => {
        event.stopPropagation();
        // Display/chat controls are mounted outside the Unity container.
        // Keep Tab inside this modal too, including while those controls appear.
        if (type === 'keydown' && event.key === 'Tab') {
          event.preventDefault();
          const target = state === 'welcome' ? el('hiplin-loading-enter')
            : state === 'failed' ? el('hiplin-loading-retry') : el('hiplin-loading');
          target.focus({ preventScroll: true });
        }
      });
    }
    el('hiplin-loading-enter').addEventListener('click', enter);
    el('hiplin-loading-retry').addEventListener('click', () => global.location.reload());
    el('hiplin-loading').focus({ preventScroll: true });
  }

  function enter() {
    if (state !== 'welcome') return;
    state = 'entering';
    global.clearTimeout(typingTimer);
    el('hiplin-loading-enter').disabled = true;
    el('hiplin-loading').removeAttribute('data-speaking');
    el('hiplin-loading').setAttribute('data-entering', '');
    const reveal = () => {
      state = 'entered';
      el('hiplin-loading').hidden = true;
      const game = el('unity-container');
      if (game) game.inert = false;
      el('unity-canvas')?.focus({ preventScroll: true });
    };
    if (reducedMotion()) reveal();
    else revealTimer = global.setTimeout(reveal, 320);
  }

  function speak() {
    const text = el('hiplin-welcome-text');
    let position = 0;
    const letters = Array.from(greeting);
    el('hiplin-welcome-announcement').textContent = greeting;
    if (reducedMotion()) { text.textContent = greeting; return; }
    el('hiplin-loading').setAttribute('data-speaking', '');
    const next = () => {
      if (state !== 'welcome') return;
      text.textContent = letters.slice(0, ++position).join('');
      if (position === letters.length) {
        el('hiplin-loading').removeAttribute('data-speaking');
        return;
      }
      typingTimer = global.setTimeout(next, /[、！。\n]/.test(letters[position - 1]) ? 240 : 55);
    };
    next();
  }
  function paint(value) {
    el('hiplin-walker').style.left = value + '%';
    el('hiplin-loading-fill').style.width = value + '%';
    el('hiplin-loading-progress').setAttribute('aria-valuenow', value);
    el('hiplin-loading-percent').textContent = value + '%';
  }
  global.HiplinLoading = {
    progress(value) {
      if (state !== 'loading' || !Number.isFinite(value)) return;
      // Reserve the last step for Unity's successful initialization, not a timer.
      last = Math.max(last, Math.min(99, Math.floor(Math.max(0, value) * 100)));
      paint(last);
      if (last >= 90) el('hiplin-loading-status').textContent = 'まもなく、街へ…';
    },
    ready() {
      if (state !== 'loading') return;
      state = 'welcome';
      paint(100);
      el('hiplin-loading').setAttribute('data-welcome', '');
      el('hiplin-loading-progress').hidden = true;
      el('hiplin-welcome').hidden = false;
      el('hiplin-loading').querySelector('.hiplin-sprite').setAttribute('aria-label', 'ヒップリンがお出迎えしています');
      el('hiplin-loading-enter').hidden = false;
      el('hiplin-loading-enter').focus({ preventScroll: true });
      speak();
    },
    fail() {
      if (state === 'failed' || state === 'entered') return;
      state = 'failed';
      global.clearTimeout(typingTimer);
      global.clearTimeout(revealTimer);
      el('hiplin-loading').removeAttribute('data-welcome');
      el('hiplin-loading').removeAttribute('data-speaking');
      el('hiplin-loading').removeAttribute('data-entering');
      el('hiplin-welcome').hidden = true;
      el('hiplin-loading-enter').hidden = true;
      el('hiplin-loading-progress').hidden = false;
      el('hiplin-loading').setAttribute('data-failed', '');
      el('hiplin-loading-status').textContent = '読み込めませんでした。通信状況を確認してください。';
      const retry = el('hiplin-loading-retry'); retry.hidden = false;
      retry.focus({ preventScroll: true });
    }
  };
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})(window);
