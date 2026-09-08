(function (global) {
  'use strict';
  // A DOM click retains the browser's user activation; a deferred Unity call does not.
  const doc = global.document;
  let ready = false, root, launcher, notice, noticeText, noticeTimer;
  const fullscreen = () => doc.fullscreenElement || doc.webkitFullscreenElement;
  const standalone = () => global.navigator.standalone === true || global.matchMedia?.('(display-mode: standalone)').matches;
  const blocked = () => doc.documentElement.hasAttribute('data-hiplin-sphere-clean-view') || doc.documentElement.hasAttribute('data-hiplin-arcade');
  function sync() {
    if (!root) return;
    root.hidden = !ready || blocked();
    if (root.hidden) hideNotice();
    const active = !!fullscreen();
    launcher.setAttribute('aria-pressed', String(active));
    launcher.setAttribute('aria-label', active ? '全画面表示を終了' : '全画面表示');
    launcher.title = active ? '全画面表示を終了' : '全画面表示';
    launcher.dataset.active = String(active);
  }
  function hideNotice() {
    if (notice) notice.hidden = true;
    global.clearTimeout(noticeTimer);
  }
  function showNotice(message) {
    noticeText.textContent = message;
    notice.hidden = false;
    global.clearTimeout(noticeTimer);
    noticeTimer = global.setTimeout(hideNotice, 20000);
  }
  function fallback() {
    if (standalone()) return showNotice('ホーム画面から全画面で表示しています。終了するにはホーム画面へ戻ってください。');
    const apple = /iPhone|iPad|iPod/i.test(global.navigator.userAgent) || (global.navigator.platform === 'MacIntel' && global.navigator.maxTouchPoints > 1);
    showNotice(apple
      ? 'このブラウザでは全画面にできません。Safariの共有 →「ホーム画面に追加」から起動してください。「Webアプリとして開く」がある場合はオンにします。'
      : 'このブラウザでは全画面にできません。対応するブラウザで開くか、PCではブラウザの「全画面表示」をお使いください。');
  }
  function toggle() {
    hideNotice();
    try {
      let result;
      if (fullscreen()) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (!exit) { fallback(); return; }
        result = exit.call(doc);
      } else {
        const page = doc.documentElement;
        const request = page.requestFullscreen || page.webkitRequestFullscreen;
        const enabled = page.requestFullscreen ? doc.fullscreenEnabled !== false : doc.webkitFullscreenEnabled !== false;
        if (!request || !enabled) { fallback(); return; }
        // Fullscreen the page, so chat, settings and the exit icon stay with the canvas.
        result = request.call(page);
      }
      Promise.resolve(result).then(sync).catch(fallback);
    } catch (_) { fallback(); }
  }
  function install() {
    if (root) { sync(); return; }
    const style = doc.createElement('style');
    style.textContent = `
      #hiplin-display[hidden], #hiplin-fullscreen-notice[hidden] { display:none!important; }
      #hiplin-display { position:fixed;inset:0;z-index:19;pointer-events:none;font:14px system-ui,sans-serif; }
      #hiplin-fullscreen { position:fixed;right:calc(58px + env(safe-area-inset-right));top:calc(12px + env(safe-area-inset-top));width:44px;height:44px;padding:4px;border:0;background:transparent;color:#fff;cursor:pointer;pointer-events:auto;touch-action:manipulation; }
      #hiplin-fullscreen svg { display:block;width:36px;height:36px;box-sizing:border-box;padding:8px;border:1px solid #91b9a880;border-radius:50%;background:#142825a8; }
      #hiplin-fullscreen .contract, #hiplin-fullscreen[data-active="true"] .expand { display:none; }
      #hiplin-fullscreen[data-active="true"] .contract { display:block; }
      #hiplin-fullscreen:focus-visible, #hiplin-fullscreen-notice button:focus-visible { outline:3px solid #ffe398;outline-offset:2px; }
      #hiplin-fullscreen-notice { position:fixed;right:max(12px,env(safe-area-inset-right));top:calc(62px + env(safe-area-inset-top));box-sizing:border-box;max-width:min(340px,calc(100vw - 24px));display:flex;align-items:flex-start;gap:8px;padding:12px 8px 12px 14px;border:1px solid #7eaa98;border-radius:12px;background:#142825f5;color:#fff;line-height:1.6;pointer-events:auto;box-shadow:0 8px 28px #0004; }
      #hiplin-fullscreen-notice p { margin:0; }
      #hiplin-fullscreen-notice button { width:32px;min-width:32px;height:32px;border:0;border-radius:50%;background:#ffffff18;color:#fff;font:20px system-ui;cursor:pointer;touch-action:manipulation; }
    `;
    doc.head.append(style);
    root = doc.createElement('section'); root.id = 'hiplin-display'; root.hidden = true;
    root.setAttribute('aria-label', '画面表示');
    launcher = doc.createElement('button'); launcher.id = 'hiplin-fullscreen'; launcher.type = 'button';
    launcher.setAttribute('aria-label', '全画面表示');
    launcher.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path class="expand" d="M7 2H2v5M13 2h5v5M18 13v5h-5M7 18H2v-5"/><path class="contract" d="M2 7h5V2M13 2v5h5M18 13h-5v5M7 18v-5H2"/></svg>';
    notice = doc.createElement('div'); notice.id = 'hiplin-fullscreen-notice'; notice.hidden = true;
    noticeText = doc.createElement('p'); noticeText.setAttribute('role', 'status'); noticeText.setAttribute('aria-live', 'polite');
    const close = doc.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '全画面の案内を閉じる');
    close.addEventListener('click', () => { hideNotice(); launcher.focus(); });
    notice.append(noticeText, close); root.append(launcher, notice); doc.body.append(root);
    launcher.addEventListener('click', toggle);
    // Do not let a UI press start a movement/camera gesture in Unity.
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'keydown', 'keyup']) root.addEventListener(type, event => event.stopPropagation());
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && !notice.hidden) { hideNotice(); launcher.focus(); } });
    doc.addEventListener('fullscreenchange', sync);
    doc.addEventListener('webkitfullscreenchange', sync);
    // Ignore another element's (for example a video player's) fullscreen errors.
    const failed = event => { if (event.target === doc.documentElement && !root.hidden) fallback(); };
    doc.addEventListener('fullscreenerror', failed);
    doc.addEventListener('webkitfullscreenerror', failed);
    new MutationObserver(sync).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-hiplin-sphere-clean-view', 'data-hiplin-arcade'] });
    sync();
  }
  global.HiplinDisplay = { ready() { ready = true; if (doc.body) install(); } };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})(window);
