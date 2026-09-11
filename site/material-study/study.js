(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const subjects = { cafe: 'カフェ', hiplin: 'Hiplin' };
  const modes = {
    current: { label: '現行設定', description: '比較の基準になる画像です。ほかの条件と切り替えて、同じ場所の紙目や反射を見てください。' },
    source: { label: '元画像・非圧縮', description: '対象の元2K画像を非圧縮で参照して再描画したものです。通常の描画画素数を保ち、画像の縮小・圧縮による見え方の変化を切り分けます。' },
    'normal-off': { label: 'Normalによる凹凸なし', description: 'Normal Mapを一時的に無効にした画像です。実際の形状による陰影と、表面の細かな陰影の違いを見分けます。' },
    raking: { label: '斜めからの照明', description: '光の向きを変えた診断画像です。紙目の見え方や反射が、照明の当たり方に左右されるかを確認します。' },
    low: { label: '低画素での描画', description: '通常の縦横半分、720×450を描画先に指定して保存したPNGです。同じ8:5の枠に拡大して、紙目や細かな凹凸の見え方を比較します。元画像の解像度や圧縮とは別の条件です。' }
  };
  const tabs = [...document.querySelectorAll('[data-subject]')];
  const range = $('comparison-slider'), stage = $('comparison-stage');
  let subject = 'cafe', mode = 'current', comparisonGeneration = 0, diagnosticGeneration = 0, dragPointer = null;
  const source = (target, variant) => `images/${target}-${variant}.png`;
  async function loadImage(image, url) {
    image.src = url;
    try { await image.decode(); return image.naturalWidth > 0; } catch { return false; }
  }
  function loading(frame, status) {
    frame.classList.add('is-loading'); frame.classList.remove('is-unavailable'); frame.setAttribute('aria-busy', 'true');
    status.hidden = false; status.textContent = '画像を読み込んでいます…';
  }
  function loaded(frame, status, success) {
    frame.classList.remove('is-loading'); frame.classList.toggle('is-unavailable', !success); frame.setAttribute('aria-busy', 'false');
    status.hidden = success;
    if (!success) status.textContent = '画像を読み込めませんでした。原寸画像のリンクからも確認できます。';
  }
  async function showComparison() {
    const token = ++comparisonGeneration, target = subject, status = $('comparison-status');
    loading(stage, status);
    $('comparison-title').textContent = `${subjects[target]}の変更前と試験版`;
    $('current-image').alt = `${subjects[target]}：現行設定の画像。左側に表示`;
    $('paper-image').alt = `${subjects[target]}：低反射・凹凸1.5倍の試験画像。右側に表示`;
    $('current-original').href = source(target, 'current'); $('paper-original').href = source(target, 'paper');
    const result = await Promise.all([loadImage($('current-image'), source(target, 'current')), loadImage($('paper-image'), source(target, 'paper'))]);
    if (token === comparisonGeneration) loaded(stage, status, result.every(Boolean));
  }
  async function showDiagnostic() {
    const token = ++diagnosticGeneration, target = subject, variant = mode, detail = modes[variant];
    const frame = $('diagnostic-frame'), status = $('diagnostic-status');
    loading(frame, status);
    $('diagnostic-label').textContent = detail.label; $('diagnostic-description').textContent = detail.description;
    $('diagnostic-subject').textContent = `${subjects[target]} / ${detail.label}`;
    $('diagnostic-image').alt = `${subjects[target]}：${detail.label}の補助診断画像`;
    $('diagnostic-original').href = source(target, variant);
    const success = await loadImage($('diagnostic-image'), source(target, variant));
    if (token === diagnosticGeneration) loaded(frame, status, success);
  }
  function selectSubject(next) {
    if (!subjects[next] || subject === next) return;
    subject = next;
    tabs.forEach(tab => { const selected = tab.dataset.subject === subject; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
    $('study-panel').setAttribute('aria-labelledby', `tab-${subject}`);
    $('selection-announcement').textContent = `${subjects[subject]}の比較画像に切り替えました。`;
    showComparison(); showDiagnostic();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectSubject(tab.dataset.subject));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); tabs[next].focus(); selectSubject(tabs[next].dataset.subject);
    });
  });
  document.querySelectorAll('input[name="diagnostic"]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked || !modes[input.value]) return;
    mode = input.value; showDiagnostic();
  }));
  function setSplit(value) {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    range.value = String(next); stage.style.setProperty('--split', `${next}%`);
    $('split-output').textContent = `現行 ${next}% / 試験 ${100 - next}%`;
    range.setAttribute('aria-valuetext', `左の現行${next}%、右の試験${100 - next}%`);
  }
  range.addEventListener('input', () => setSplit(Number(range.value)));
  $('reset-comparison').addEventListener('click', () => setSplit(50));
  function moveBoundary(event) {
    const box = stage.getBoundingClientRect();
    if (box.width) setSplit((event.clientX - box.left) / box.width * 100);
  }
  stage.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    dragPointer = event.pointerId; stage.setPointerCapture(event.pointerId); moveBoundary(event);
  });
  stage.addEventListener('pointermove', event => { if (event.pointerId === dragPointer) moveBoundary(event); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(type, event => {
    if (event.pointerId !== dragPointer) return;
    dragPointer = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  });
  setSplit(50); showComparison(); showDiagnostic();
})();
