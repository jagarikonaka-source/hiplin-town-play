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
        lastReceived = Date.now();
        if (data.type === 'welcome') {
          joined = true; attempt = 0; peers.clear();
          for (const player of data.players) peers.add(player.id);
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
    const panel = doc.createElement('section');
    panel.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:20;width:min(340px,calc(100vw - 24px));padding:12px;box-sizing:border-box;background:#142825eF;color:#fff;border-radius:12px;font:14px system-ui,sans-serif';
    panel.setAttribute('aria-label', 'ロビーチャット');
    const heading = doc.createElement('strong'); heading.textContent = '名前を入力して入室';
    const note = doc.createElement('p'); note.textContent = '同じロビーの人に名前とメッセージが表示されます。名前は20文字まで。';
    const log = doc.createElement('div'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
    log.style.cssText = 'max-height:160px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;margin:8px 0';
    const form = doc.createElement('form'); form.style.cssText = 'display:flex;gap:6px';
    const input = doc.createElement('input'); input.maxLength = 40; input.placeholder = '表示名'; input.setAttribute('aria-label', '表示名');
    input.style.cssText = 'min-width:0;flex:1;padding:9px;border:1px solid #7eaa98;border-radius:6px;font:16px system-ui';
    const button = doc.createElement('button'); button.type = 'submit'; button.textContent = '入室';
    button.style.cssText = 'padding:8px;border:0;border-radius:6px;background:#a9dfc1;color:#142825';
    form.append(input, button); panel.append(heading, note, log, form); doc.body.append(panel);
    const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.textContent = '閉じる';
    toggle.style.cssText = 'float:right;border:0;background:transparent;color:#b9e9d3;cursor:pointer';
    toggle.setAttribute('aria-label', 'チャットを折りたたむ'); panel.insertBefore(toggle, heading);
    let collapsed = false;
    function expand() { collapsed = false; note.hidden = log.hidden = form.hidden = false; form.style.display = 'flex'; toggle.textContent = '閉じる'; }
    toggle.addEventListener('click', () => {
      if (collapsed) { expand(); return; }
      input.blur(); collapsed = true; note.hidden = log.hidden = form.hidden = true; form.style.display = 'none'; toggle.textContent = '開く';
    });
    const focus = value => { if (callback) callback(JSON.stringify({ type: 'chat-focus', focused: value })); };
    input.addEventListener('focus', () => focus(true));
    input.addEventListener('blur', () => focus(false));
    panel.addEventListener('keydown', event => event.stopPropagation());
    panel.addEventListener('keyup', event => event.stopPropagation());
    const line = text => { const row = doc.createElement('div'); row.textContent = text; log.append(row); while (log.children.length > 100) log.firstChild.remove(); log.scrollTop = log.scrollHeight; };
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); input.blur(); doc.getElementById('unity-canvas')?.focus(); }
      if (event.isComposing && event.key === 'Enter') event.preventDefault();
    });
    doc.addEventListener('keydown', event => {
      if (doc.documentElement.hasAttribute('data-hiplin-sphere-clean-view') || doc.documentElement.hasAttribute('data-hiplin-arcade')) return;
      if (event.key === 'Enter' && doc.activeElement !== input && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); expand(); input.focus(); }
    }, true);
    form.addEventListener('submit', event => {
      event.preventDefault(); const text = input.value.trim();
      if (!displayName) {
        if (!text || [...text].length > 20 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(text)) { note.textContent = '名前は1〜20文字で入力してください。'; return; }
        displayName = text; heading.textContent = 'ロビーチャット · ' + displayName;
        note.textContent = 'Enterで入力・送信 / Escで戻る · 履歴はこの画面を閉じるまで';
        input.value = ''; input.maxLength = 400; input.placeholder = 'メッセージ（200文字まで）'; input.setAttribute('aria-label', 'メッセージ'); button.textContent = '送信';
        global.HiplinMultiplayer.start(callback); input.blur();
      } else {
        if (!text || [...text].length > 200) { line('200文字以内で入力してください。'); return; }
        if (!client?.chat(text)) { line('接続待ちです。オンラインになってから送信してください。'); return; }
        input.value = '';
      }
    });
    chatUI = { receive(data) {
      if (data.type === 'chat') line(data.name + '：' + data.text);
      if (data.type === 'chat-error') line(data.reason === 'rate-limit' ? '少し待ってから送信してください（10秒に5件まで）。' : 'メッセージを送信できませんでした。');
    } };
  }
  function showStatus(state, count) {
    let badge = global.document.getElementById('hiplin-online');
    if (!badge) {
      badge = global.document.createElement('div'); badge.id = 'hiplin-online';
      badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
      badge.style.cssText = 'position:fixed;right:max(14px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));z-index:5;padding:8px 12px;border-radius:18px;background:#15272cdd;color:#dfebe8;font:12px system-ui,sans-serif;pointer-events:none;';
      global.document.body.appendChild(badge);
    }
    const labels = { online: '● オンライン · ' + count + '人', connecting: '○ みんなの街に接続中', offline: '○ ひとりで散策中 · 再接続しています', full: '○ 満員です · 空きを待っています', unconfigured: '○ ひとりで散策中 · 通信設定を確認してください' };
    const text = state === 'unjoined' ? '○ 名前を入力して入室してください' : labels[state] || labels.offline;
    if (badge.textContent !== text) badge.textContent = text;
    badge.style.color = state === 'online' ? '#9be3c5' : '#dfebe8';
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
    update(json) { pending = json; if (client) client.update(json); },
    stop() { generation++; clearTimeout(configRetry); if (client) client.stop(); client = null; pending = null; }
  };
  if (global.addEventListener) {
    global.addEventListener('pagehide', () => global.HiplinMultiplayer.stop());
    global.addEventListener('pageshow', event => { if (event.persisted && callback) global.HiplinMultiplayer.start(callback); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
