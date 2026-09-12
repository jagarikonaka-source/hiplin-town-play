(function (root) {
  'use strict';
  const doc = root.document;
  const trial = /(?:^|\/)graphics-trial\.html$/.test(root.location.pathname);
  const samples = [];
  let instance, profile, timer, panel, summary, status, output;
  function install() {
    if (panel) return;
    const style = doc.createElement('style');
    style.textContent = '#hiplin-graphics-test{position:fixed;left:max(12px,env(safe-area-inset-left));top:calc(68px + env(safe-area-inset-top));z-index:25;max-width:calc(100vw - 24px);box-sizing:border-box;border:1px solid #987755;border-radius:8px;background:#f5e3c4ee;color:#392b1d;font:12px/1.6 system-ui,sans-serif;padding:6px 10px}#hiplin-graphics-test summary{cursor:pointer;min-height:28px;line-height:28px}#hiplin-graphics-test p{max-width:290px;margin:8px 0}#hiplin-graphics-test a,#hiplin-graphics-test button{display:inline-block;padding:8px;margin:2px;color:#392b1d;border:1px solid #987755;border-radius:4px;background:#fff5df;font:inherit;cursor:pointer}#hiplin-graphics-test textarea{display:block;width:270px;max-width:70vw;height:120px;font:10px monospace}#hiplin-graphics-test textarea[hidden]{display:none}';
    doc.head.append(style);
    panel = doc.createElement('details'); panel.id = 'hiplin-graphics-test';
    summary = doc.createElement('summary'); summary.textContent = trial ? 'Unity寄せ画質テスト · 読み込み中' : '通常画質の比較 · 読み込み中';
    const info = doc.createElement('p'); info.textContent = trial ? '影の精度・柔らかい影・追加ライトの影・隅の陰影を強化した携帯向け試験版です。草の軽量化と圧縮画像は維持しています。' : '現在の通常版と同じ描画です。比較用の計測表示だけを付けています。';
    status = doc.createElement('p'); status.setAttribute('role','status'); status.textContent = 'メモリ表示はUnityのWASM領域のみで、端末全体の使用量ではありません。';
    const normal = doc.createElement('a'); normal.href = './'; normal.textContent = '通常URLへ戻る';
    const compare = doc.createElement('a'); compare.href = trial ? 'graphics-baseline.html' : 'graphics-trial.html'; compare.textContent = trial ? '通常画質で比較' : 'Unity寄せ画質で比較';
    const copy = doc.createElement('button'); copy.type = 'button'; copy.textContent = '計測結果を表示';
    output = doc.createElement('textarea'); output.readOnly = true; output.hidden = true; output.setAttribute('aria-label','比較用の計測結果');
    copy.addEventListener('click',()=>{output.hidden=false;output.value=JSON.stringify({mode:trial?'unity-look':'baseline',textureProfile:profile,wasmOnly:true,samples},null,2);});
    panel.append(summary,info,status,normal,compare,copy,output); doc.body.append(panel);
    for (const event of ['pointerdown','pointerup','touchstart','touchend','click','keydown','keyup']) panel.addEventListener(event,e=>e.stopPropagation());
  }
  function sample() {
    if (!instance || doc.hidden) return;
    try {
      const m = instance.GetMetricsInfo();
      const fps = Number(m.movingAverageFps ?? m.fps);
      const used = Number(m.usedWASMHeapSize), allocated = Number(m.totalWASMHeapSize);
      const item = {seconds:Math.round(root.performance.now()/1000),fps:Number.isFinite(fps)?Math.round(fps*10)/10:null,usedMiB:Number.isFinite(used)?Math.round(used/1048576):null,allocatedMiB:Number.isFinite(allocated)?Math.round(allocated/1048576):null};
      samples.push(item); if(samples.length>120)samples.shift();
      summary.textContent=(trial?'Unity寄せ画質テスト':'通常画質の比較')+' · '+(item.fps===null?'計測不可':item.fps+' FPS');
      status.textContent='圧縮形式: '+profile+' / WASM使用 '+item.usedMiB+' MiB・確保 '+item.allocatedMiB+' MiB。端末全体のメモリではありません。';
    } catch (_) { summary.textContent=(trial?'Unity寄せ画質テスト':'通常画質の比較')+' · 計測非対応'; }
  }
  root.HiplinGraphicsTrial = {
    ready(unity, textureProfile) { install();instance=unity;profile=textureProfile;sample();root.clearInterval(timer);timer=root.setInterval(sample,1000); },
    unsupported() { install();panel.open=true;summary.textContent='この端末は比較版の対象外です';status.textContent='ASTC対応の携帯向け試験版です。「通常URLへ戻る」を使ってください。'; },
    fail() { install();panel.open=true;summary.textContent='比較版の起動に失敗しました'; }
  };
  root.addEventListener('pagehide',()=>root.clearInterval(timer));
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
