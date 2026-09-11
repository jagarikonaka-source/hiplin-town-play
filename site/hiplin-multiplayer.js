(function (global) {
  'use strict';
  // Browser transport only. All character rendering stays in Unity.
  function roomFor(url) {
    const path = url.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';
    const room = url.searchParams.get('room');
    return path + (room ? '?room=' + encodeURIComponent(room.slice(0, 64)) : '');
  }
  function createClient(options) {
    const location = new URL(options.url);
    const endpoint = new URL(options.endpoint || '/multiplayer', location);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : endpoint.protocol === 'http:' ? 'ws:' : endpoint.protocol;
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || (location.protocol === 'https:' && endpoint.protocol !== 'wss:')) throw new Error('Secure WebSocket endpoint required');
    const Socket = options.WebSocket || global.WebSocket;
    const callback = options.message || function () {};
    const status = options.status || function () {};
    let socket, latest, appearanceKey, joined = false, stopped = false, retry, watchdog;
    let attempt = 0, lastReceived = 0;
    const peers = new Set();
    function connect() {
      if (stopped || !latest) return;
      status('connecting', 0);
      socket = new Socket(endpoint.href);
      const current = socket;
      lastReceived = Date.now();
      socket.onopen = () => {
        if (socket !== current || stopped) return;
        appearanceKey = JSON.stringify(latest.appearance);
        socket.send(JSON.stringify({ type: 'hello', protocol: 1, name: options.name, room: roomFor(location), state: latest.state, appearance: latest.appearance }));
      };
      socket.onmessage = event => {
        if (socket !== current || stopped) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
        if ((data.type === 'welcome' || data.type === 'snapshot') && !Array.isArray(data.players)) return;
        if ((data.type === 'joined' || data.type === 'appearance') && (!data.player || typeof data.player.id !== 'string')) return;
        if (data.type === 'welcome' && typeof data.id !== 'string') return;
        lastReceived = Date.now();
        if (data.type === 'welcome') {
          joined = true; attempt = 0; peers.clear();
          for (const player of data.players) if (player && typeof player.id === 'string' && player.id !== data.id) peers.add(player.id);
        } else if (data.type === 'joined') peers.add(data.player.id);
        else if (data.type === 'left') peers.delete(data.id);
        else if (data.type === 'error') { status(data.reason === 'room-full' ? 'full' : 'offline', 0); }
        if (joined) status('online', peers.size + 1);
        callback(event.data);
      };
      socket.onerror = () => {}; // onclose owns recovery, including handshake failures.
      socket.onclose = event => {
        if (socket !== current || stopped) return;
        joined = false; peers.clear(); callback(JSON.stringify({ type: 'disconnected' }));
        status(event.code === 1013 ? 'full' : 'offline', 0);
        clearInterval(watchdog);
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt++)) + Math.random() * 500;
        retry = setTimeout(connect, delay);
      };
      watchdog = setInterval(() => {
        if (Date.now() - lastReceived > 15000 && socket === current) socket.close();
      }, 2000);
    }
    return {
      chat(text) {
        if (!joined || socket.readyState !== 1 || socket.bufferedAmount > 32768) return false;
        socket.send(JSON.stringify({ type: 'chat', text })); return true;
      },
      update(json) {
        latest = typeof json === 'string' ? JSON.parse(json) : json;
        if (!socket && !stopped) { connect(); return; }
        if (!joined || socket.readyState !== 1 || socket.bufferedAmount > 32768) return;
        const key = JSON.stringify(latest.appearance);
        socket.send(JSON.stringify({ type: 'state', state: latest.state, ...(key !== appearanceKey ? { appearance: latest.appearance } : {}) }));
        appearanceKey = key;
      },
      stop() {
        stopped = true; joined = false; clearTimeout(retry); clearInterval(watchdog);
        if (socket) socket.close(); peers.clear();
      },
      get connected() { return joined; }
    };
  }
  let client, callback, pending, configRetry, generation = 0, displayName, chatUI;
  function setupChat() {
    if (chatUI) return;
    const doc = global.document;
    const root = doc.createElement('section'); root.setAttribute('aria-label', 'ロビーチャット');
    root.style.cssText = 'position:fixed;inset:0;z-index:20;pointer-events:none;font:14px system-ui,sans-serif;--hiplin-paper:url("paper-ui.png");text-shadow:0 1px 0 #fff8';
    const style = doc.createElement('style');
    style.textContent = `
      #hiplin-chat-overlay[hidden], #hiplin-chat-launcher[hidden], #hiplin-chat-unread[hidden] { display:none!important; }
      [aria-label="ロビーチャット"][hidden] { display:none!important; }
      #hiplin-chat-launcher { position:fixed;right:calc(12px + env(safe-area-inset-right));top:calc(12px + env(safe-area-inset-top));width:44px;height:44px;padding:4px;border:4px solid transparent;box-sizing:border-box;border-radius:4px;background:#f5ead5 var(--hiplin-paper) center/700px;color:#40362b;box-shadow:inset 1px 1px 3px #6d553133,0 2px 4px #0003;cursor:pointer;pointer-events:auto;touch-action:manipulation;font:20px system-ui;line-height:26px; }
      #hiplin-chat-unread { position:absolute;right:0;top:0;width:7px;height:7px;border-radius:50%;background:#a44529;border:2px solid #f7efde; }
      #hiplin-chat-overlay { position:fixed;inset:0;box-sizing:border-box;padding:16px max(16px,env(safe-area-inset-right)) 16px max(16px,env(safe-area-inset-left));display:grid;place-items:center;background:#20170faa;pointer-events:auto; }
      #hiplin-chat-panel { width:min(380px,100%);max-height:100%;overflow:auto;box-sizing:border-box;padding:16px;border:1px solid #bdab8c;border-radius:4px;background:#f5ead5 var(--hiplin-paper) center/700px;color:#40362b;box-shadow:0 12px 48px #0006; }
      #hiplin-chat-panel button { min-height:44px;cursor:pointer;touch-action:manipulation; }
      #hiplin-chat-panel input { box-sizing:border-box;width:100%; }
      #hiplin-chat-launcher:focus-visible, #hiplin-chat-panel :focus-visible { outline:3px solid #a44529;outline-offset:2px; }
    `;
    doc.head.append(style);
    const launcher = doc.createElement('button'); launcher.id = 'hiplin-chat-launcher'; launcher.type = 'button';
    launcher.textContent = '💬'; launcher.title = 'チャットを開く'; launcher.setAttribute('aria-label', 'チャットを開く');
    launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'hiplin-chat-panel');
    const unread = doc.createElement('span'); unread.id = 'hiplin-chat-unread'; unread.hidden = true; unread.setAttribute('aria-hidden', 'true'); launcher.append(unread);
    const overlay = doc.createElement('div'); overlay.id = 'hiplin-chat-overlay'; overlay.hidden = true;
    const panel = doc.createElement('div'); panel.id = 'hiplin-chat-panel'; panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'hiplin-chat-heading');
    const heading = doc.createElement('strong'); heading.textContent = '名前を入力して入室';
    heading.id = 'hiplin-chat-heading';
    heading.style.cssText = 'min-width:0;overflow-wrap:anywhere';
    const header = doc.createElement('div'); header.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;position:sticky;top:-16px;background:#f5ead5 var(--hiplin-paper) center/700px;z-index:1';
    const close = doc.createElement('button'); close.type = 'button'; close.textContent = '閉じる'; close.setAttribute('aria-label', 'チャットを閉じる');
    close.style.cssText = 'flex-shrink:0;padding:4px 8px;border:0;border-radius:6px;background:#e8d8b9 var(--hiplin-paper) center/700px;color:#40362b;box-shadow:inset 1px 1px 3px #6d553133';
    header.append(heading, close);
    const note = doc.createElement('p'); note.textContent = '同じロビーの人に名前とメッセージが表示されます。名前は20文字まで。';
    const status = doc.createElement('div'); status.id = 'hiplin-online';
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'font-size:12px;margin:8px 0;color:#6d5e4d;overflow-wrap:anywhere';
    const log = doc.createElement('div'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
    log.style.cssText = 'max-height:160px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;margin:8px 0';
    const form = doc.createElement('form'); form.style.cssText = 'display:flex;gap:6px';
    const input = doc.createElement('input'); input.maxLength = 40; input.placeholder = '表示名'; input.setAttribute('aria-label', '表示名');
    input.style.cssText = 'min-width:0;flex:1;padding:9px;border:1px solid #bdab8c;border-radius:3px;background:#faf2e1;color:#40362b;font:16px system-ui;box-shadow:inset 1px 1px 3px #6d553126';
    const button = doc.createElement('button'); button.type = 'submit'; button.textContent = '入室';
    button.style.cssText = 'padding:8px;border:0;border-radius:6px;background:#e8d8b9 var(--hiplin-paper) center/700px;color:#71371f;box-shadow:inset 1px 1px 3px #6d553133';
    form.append(input, button); panel.append(header, note, status, log, form); overlay.append(panel); root.append(launcher, overlay); doc.body.append(root);
    let expanded = false, outdoors = false;
    root.hidden = true;
    const blocked = () => !outdoors || doc.documentElement.hasAttribute('data-hiplin-sphere-clean-view') || doc.documentElement.hasAttribute('data-hiplin-arcade');
    const focus = value => { if (callback) callback(JSON.stringify({ type: 'chat-focus', focused: value })); };
    function expand() {
      if (blocked() || expanded) return;
      expanded = true; overlay.hidden = false; launcher.hidden = true; unread.hidden = true;
      launcher.setAttribute('aria-expanded', 'true'); launcher.setAttribute('aria-label', 'チャットを開く');
      focus(true); input.focus(); log.scrollTop = log.scrollHeight;
    }
    function collapse() {
      if (!expanded) return;
      expanded = false; input.blur(); overlay.hidden = true; launcher.hidden = false;
      launcher.setAttribute('aria-expanded', 'false'); focus(false); doc.getElementById('unity-canvas')?.focus();
    }
    launcher.addEventListener('click', expand); close.addEventListener('click', collapse);
    overlay.addEventListener('click', event => { if (event.target === overlay) collapse(); });
    // Pause Unity for the whole dialog, not just while the input has focus.
    // Buttons and the modal backdrop must not leak keys/touches to game controls.
    for (const type of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) root.addEventListener(type, event => event.stopPropagation());
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); collapse(); }
      if (event.key === 'Tab') {
        if (event.shiftKey && doc.activeElement === close) { event.preventDefault(); button.focus(); }
        else if (!event.shiftKey && doc.activeElement === button) { event.preventDefault(); close.focus(); }
      }
    });
    new MutationObserver(() => { if (blocked()) collapse(); }).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-hiplin-sphere-clean-view', 'data-hiplin-arcade'] });
    // iPhone's keyboard changes the visual viewport without resizing the game canvas.
    function fitViewport() {
      const viewport = global.visualViewport;
      if (viewport) {
        overlay.style.top = viewport.offsetTop + 'px'; overlay.style.height = viewport.height + 'px'; overlay.style.bottom = 'auto';
        if (expanded && doc.activeElement === input) input.scrollIntoView({ block: 'nearest' });
      }
    }
    global.visualViewport?.addEventListener('resize', fitViewport);
    global.visualViewport?.addEventListener('scroll', fitViewport); fitViewport();
    const line = text => { const row = doc.createElement('div'); row.textContent = text; log.append(row); while (log.children.length > 100) log.firstChild.remove(); log.scrollTop = log.scrollHeight; };
    input.addEventListener('keydown', event => {
      if (event.isComposing && event.key === 'Enter') event.preventDefault();
    });
    doc.addEventListener('keydown', event => {
      if (blocked() || expanded) return;
      if (event.key === 'Enter' && !event.isComposing && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey &&
          (doc.activeElement === doc.body || doc.activeElement === doc.getElementById('unity-canvas'))) {
        event.preventDefault(); event.stopImmediatePropagation(); expand();
      }
    }, true);
    form.addEventListener('submit', event => {
      event.preventDefault(); const text = input.value.trim();
      if (!displayName) {
        if (!text || [...text].length > 20 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)) { note.textContent = '名前は1〜20文字で入力してください。'; return; }
        displayName = text; heading.textContent = 'ロビーチャット · ' + displayName;
        note.textContent = 'Enterで入力・送信 / Escで閉じる · 履歴はページを閉じるまで';
        input.value = ''; input.maxLength = 400; input.placeholder = 'メッセージ（200文字まで）'; input.setAttribute('aria-label', 'メッセージ'); button.textContent = '送信';
        global.HiplinMultiplayer.start(callback); collapse();
      } else {
        if (!text || [...text].length > 200) { line('200文字以内で入力してください。'); return; }
        if (!client?.chat(text)) { line('接続待ちです。オンラインになってから送信してください。'); return; }
        input.value = ''; input.focus();
      }
    });
    chatUI = { setOutdoor(value) {
      outdoors = value === true;
      if (!outdoors) collapse();
      root.hidden = !outdoors;
    }, receive(data) {
      if (data.type === 'chat') {
        line(data.name + '：' + data.text);
        if (!expanded) { unread.hidden = false; launcher.setAttribute('aria-label', 'チャットを開く（新着メッセージあり）'); }
      }
      if (data.type === 'chat-error') line(data.reason === 'rate-limit' ? '少し待ってから送信してください（10秒に5件まで）。' : 'メッセージを送信できませんでした。');
    } };
  }
  function showStatus(state, count) {
    const badge = global.document.getElementById('hiplin-online');
    if (!badge) return;
    const labels = { online: '● オンライン · ' + count + '人', connecting: '○ みんなの街に接続中', offline: '○ ひとりで散策中 · 再接続しています', full: '○ 満員です · 空きを待っています', unconfigured: '○ ひとりで散策中 · 通信設定を確認してください' };
    const text = state === 'unjoined' ? '○ 未入室 · ひとりで散策できます' : labels[state] || labels.offline;
    if (badge.textContent !== text) badge.textContent = text;
    badge.style.color = state === 'online' ? '#48623c' : '#6d5e4d';
  }
  global.HiplinMultiplayer = {
    createClient, roomFor,
    async start(receiver) {
      this.stop(); const current = ++generation; callback = receiver;
      setupChat();
      if (!displayName) { showStatus('unjoined', 0); return; }
      showStatus('connecting', 0);
      try {
        const response = await global.fetch(new URL('multiplayer-config.json', global.location.href), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Configuration unavailable');
        const config = await response.json();
        if (current !== generation) return;
        client = createClient({ url: global.location.href, endpoint: config.endpoint, name: displayName,
          message: json => { const data = JSON.parse(json); chatUI.receive(data); callback(json); }, status: showStatus });
        if (pending) client.update(pending);
      } catch {
        if (current === generation) {
          showStatus('unconfigured', 0);
          // A sleeping host or a temporary config fetch failure must recover without a page reload.
          configRetry = setTimeout(() => { if (current === generation) global.HiplinMultiplayer.start(receiver); }, 15000);
        }
      }
    },
    update(json) {
      pending = json;
      try { chatUI?.setOutdoor(JSON.parse(json).isOutdoors); } catch (_) { chatUI?.setOutdoor(false); }
      if (client) client.update(json);
    },
    stop() { generation++; clearTimeout(configRetry); if (client) client.stop(); client = null; pending = null; }
  };
  if (global.addEventListener) {
    global.addEventListener('pagehide', () => global.HiplinMultiplayer.stop());
    global.addEventListener('pageshow', event => { if (event.persisted && callback) global.HiplinMultiplayer.start(callback); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
