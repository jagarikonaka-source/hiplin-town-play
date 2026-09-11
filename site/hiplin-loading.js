(function (global) {
  'use strict';
  let last = 0, finished = false, failed = false;
  const el = id => global.document.getElementById(id);
  function paint(value) {
    el('hiplin-walker').style.left = value + '%';
    el('hiplin-loading-fill').style.width = value + '%';
    el('hiplin-loading-progress').setAttribute('aria-valuenow', value);
    el('hiplin-loading-percent').textContent = value + '%';
  }
  global.HiplinLoading = {
    progress(value) {
      if (finished || failed || !Number.isFinite(value)) return;
      // Reserve the last step for Unity's successful initialization, not a timer.
      last = Math.max(last, Math.min(99, Math.floor(Math.max(0, value) * 100)));
      paint(last);
      if (last >= 90) el('hiplin-loading-status').textContent = 'まもなく、街へ…';
    },
    ready() {
      if (finished || failed) return;
      finished = true; paint(100); el('hiplin-loading').hidden = true;
      // No minimum display time or extra click: reveal the game immediately.
    },
    fail() {
      if (finished || failed) return;
      failed = true; el('hiplin-loading').setAttribute('data-failed', '');
      el('hiplin-loading-status').textContent = '読み込めませんでした。通信状況を確認してください。';
      const retry = el('hiplin-loading-retry'); retry.hidden = false;
      retry.addEventListener('click', () => global.location.reload(), { once:true });
    }
  };
})(window);
