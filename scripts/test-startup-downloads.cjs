const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { install } = require('../site/hiplin-startup-downloads.js');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const raw = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + (i >> 3)) % 256));
const packed = zlib.gzipSync(raw);
const base = 'https://example.test/hiplin-town-play/';

function fixture(options = {}) {
  const assetHash = sha(packed);
  const asset = 'Build/UnityTrial/HiplinTownWebGL.data.unityweb?v=' + assetHash;
  const manifestUrl = 'hiplin-startup-manifest.json?v=' + assetHash;
  const chunkSize = 128, chunks = [], bodies = new Map();
  for (let i = 0; i < packed.length; i += chunkSize) {
    const bytes = packed.subarray(i, i + chunkSize), digest = sha(bytes);
    const url = 'startup/' + assetHash + '/' + String(chunks.length).padStart(3, '0') + '-' + digest + '.bin';
    chunks.push({ url, sha256: digest, bytes: bytes.length }); bodies.set(new URL(url, base).href, bytes);
  }
  const manifest = { schemaVersion: 1, assets: [{ url: asset, sha256: assetHash, compressedBytes: packed.length, expandedBytes: raw.length, chunks }] };
  for (const suffix of (options.extraAssets ? ['wasm.unityweb', 'framework.js.unityweb'] : [])) {
    manifest.assets.push({ ...manifest.assets[0], url: asset.replace('data.unityweb', suffix) });
  }
  const assetUrls = manifest.assets.map(entry => entry.url);
  const saved = options.saved || new Map(), counts = new Map(), names = [];
  const stats = { manifests: 0, original: 0, requests: [], writes: 0, deletes: 0, active: 0, peak: 0 };
  const storage = {
    async match(url) { const value = saved.get(url); return value ? new Response(value) : undefined; },
    async put(url, response) {
      stats.writes++;
      if (options.quota) throw new Error('Quota exceeded');
      saved.set(url, Buffer.from(await response.arrayBuffer()));
    },
    async delete(url) { stats.deletes++; return saved.delete(url); }
  };
  const host = {
    URL, Headers, Response, ReadableStream, TransformStream, DecompressionStream, AbortController,
    crypto: crypto.webcrypto, location: { href: base + 'graphics-trial.html' },
    caches: options.noCache ? undefined : { async open(name) { names.push(name); if (options.cacheDenied) throw new Error('Denied'); return storage; } },
    async fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' ? input : input.url, base).href;
      if (url === new URL(manifestUrl, base).href) {
        stats.manifests++;
        if (options.manifestFailure) throw new Error('Manifest unavailable');
        return new Response(JSON.stringify(options.manifestOverride || manifest), { status: options.manifestStatus || 200 });
      }
      if (assetUrls.some(address => url === new URL(address, base).href)) {
        stats.original++;
        const response = options.originalResponse ? options.originalResponse() : new Response(packed);
        response.clone = () => { throw new Error('Whole response must not be cloned'); };
        return response;
      }
      if (!bodies.has(url)) return new Response('unrelated');
      stats.requests.push(url); stats.active++; stats.peak = Math.max(stats.peak, stats.active);
      const attempt = (counts.get(url) || 0) + 1; counts.set(url, attempt);
      try {
        const result = options.chunk ? await options.chunk({ url, init, attempt, chunks, bodies, stats }) : undefined;
        return result || new Response(bodies.get(url));
      } finally { stats.active--; }
    }
  };
  if (options.noStreams) host.DecompressionStream = undefined;
  if (options.noCrypto) host.crypto = undefined;
  const config = { dataUrl: asset, hiplinStartupManifestUrl: manifestUrl };
  if (options.legacy) delete config.hiplinStartupManifestUrl;
  const original = host.fetch;
  const restore = install(config, Object.fromEntries(assetUrls.map(url => [url, raw.length])), host);
  return { host, config, restore, original, asset, assetUrls, manifest, chunks, bodies, saved, stats, counts, names,
    async download(init) { return Buffer.from(await (await host.fetch(asset, init)).arrayBuffer()); } };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('cold compressed chunks produce exact original bytes and are cached under an app namespace', async () => {
  const f = fixture();
  assert.deepEqual(await f.download(), raw);
  assert.equal(f.stats.original, 0); assert.equal(f.stats.manifests, 1);
  assert.equal(f.stats.requests.length, f.chunks.length);
  assert.equal(f.stats.writes, f.chunks.length);
  assert.ok(f.stats.peak <= 3); assert.equal(f.config.cacheControl(f.asset), 'no-store');
  assert.deepEqual(f.names, ['hiplin-startup-compressed-v1:/hiplin-town-play/']);
  for (const value of f.saved.values()) assert.ok(value.length <= 128);
  f.restore(); assert.equal(f.host.fetch, f.original); assert.equal(f.config.cacheControl, undefined);
});

test('a new install reuses compressed cache without asset network requests', async () => {
  const first = fixture(); await first.download(); first.restore();
  const second = fixture({ saved: first.saved });
  assert.deepEqual(await second.download(), raw);
  assert.equal(second.stats.original, 0); assert.equal(second.stats.requests.length, 0); assert.equal(second.stats.writes, 0);
  second.restore();
});

for (const options of [{ noCache: true }, { cacheDenied: true }, { quota: true }]) {
  test('unavailable cache or quota failure still completes: ' + JSON.stringify(options), async () => {
    const f = fixture(options); assert.deepEqual(await f.download(), raw);
    assert.equal(f.stats.original, 0); assert.equal(f.stats.requests.length, f.chunks.length); f.restore();
  });
}

test('bad cached bytes are deleted and redownloaded instead of entering Unity', async () => {
  const f = fixture();
  f.saved.set(new URL(f.chunks[0].url, base).href, Buffer.alloc(f.chunks[0].bytes));
  assert.deepEqual(await f.download(), raw);
  assert.equal(f.stats.deletes, 1); assert.equal(f.stats.requests.length, f.chunks.length); f.restore();
});

test('retry is limited to the damaged chunk and cache bypasses a bad HTTP cached response', async () => {
  const seen = [];
  const f = fixture({ chunk({ url, attempt, chunks, init }) {
    if (url.endsWith(chunks[1].url)) {
      seen.push(init.cache);
      if (attempt === 1) return new Response(Buffer.alloc(chunks[1].bytes));
      if (attempt === 2) return new Response('temporary', { status: 503 });
    }
  } });
  assert.deepEqual(await f.download(), raw);
  assert.deepEqual(seen, ['force-cache', 'reload', 'reload']);
  assert.equal(f.stats.requests.length, f.chunks.length + 2); f.restore();
});

test('persistent chunk failures stop after three attempts without full-asset fallback', async () => {
  const f = fixture({ chunk: () => new Response('failed', { status: 503 }) });
  await assert.rejects(f.download(), /request failed/);
  assert.equal(f.stats.original, 0);
  assert.ok([...f.counts.values()].every(value => value <= 3)); f.restore();
});

test('a slow first chunk does not allow the completed lookahead window to grow', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ async chunk({ url, chunks }) { if (url.endsWith(chunks[0].url)) await gate; } });
  const result = f.download(); await sleep(35);
  assert.equal(f.stats.requests.length, 3);
  await sleep(35); assert.equal(f.stats.requests.length, 3);
  release(); assert.deepEqual(await result, raw);
  assert.ok(f.stats.peak <= 3); f.restore();
});

test('concurrent data, wasm, and framework share one three-request global limit', async () => {
  const f = fixture({ extraAssets: true, noCache: true, async chunk() { await sleep(8); } });
  const results = await Promise.all(f.assetUrls.map(async url => Buffer.from(await (await f.host.fetch(url)).arrayBuffer())));
  for (const bytes of results) assert.deepEqual(bytes, raw);
  assert.equal(f.stats.peak, 3); assert.equal(f.stats.manifests, 1);
  assert.equal(f.stats.requests.length, f.chunks.length * 3); f.restore();
});

test('cancelled queued work never starts after another asset finishes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ extraAssets: true, noCache: true, async chunk() { await gate; } });
  const first = f.download(); await sleep(15);
  const controller = new AbortController();
  const second = f.host.fetch(f.assetUrls[1], { signal: controller.signal }).then(response => response.arrayBuffer());
  await sleep(15); controller.abort(); await assert.rejects(second, /abort|cancel/i);
  release(); assert.deepEqual(await first, raw);
  assert.equal(f.stats.requests.length, f.chunks.length); assert.equal(f.stats.active, 0); f.restore();
});

test('oversized and truncated chunks are retried without emitting unverified bytes', async () => {
  for (const oversized of [true, false]) {
    const f = fixture({ chunk({ url, attempt, chunks, bodies }) {
      if (url.endsWith(chunks[0].url) && attempt === 1) {
        return new Response(Buffer.alloc(chunks[0].bytes + (oversized ? 1 : -1)), { headers: { 'Content-Length': String(chunks[0].bytes) } });
      }
    } });
    assert.deepEqual(await f.download(), raw); assert.equal(f.stats.requests.length, f.chunks.length + 1); f.restore();
  }
});

test('AbortSignal aborts running downloads and drains queued chunk work', async () => {
  let aborts = 0;
  const f = fixture({ chunk({ init }) { return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborts++; reject(new Error('aborted fetch')); }, { once: true });
  }); } });
  const controller = new AbortController();
  const result = f.download({ signal: controller.signal }); await sleep(25);
  controller.abort(); await assert.rejects(result, /abort|cancel/i);
  await sleep(25); assert.equal(aborts, 3); assert.equal(f.stats.requests.length, 3); assert.equal(f.stats.active, 0); f.restore();
});

test('cancelling the output body cancels the compressed input downloads', async () => {
  let aborts = 0;
  const f = fixture({ chunk({ init }) { return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborts++; reject(new Error('aborted fetch')); }, { once: true });
  }); } });
  const response = await f.host.fetch(f.asset); await sleep(25);
  await response.body.cancel(); await sleep(25);
  assert.equal(aborts, 3); assert.equal(f.stats.active, 0); f.restore();
});

test('restore cancels in-flight optimization and preserves a subsequent fetch replacement', async () => {
  const f = fixture({ chunk({ init }) { return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted fetch')), { once: true });
  }); } });
  const result = f.download(); await sleep(25);
  const later = () => {}; f.host.fetch = later; f.restore();
  await assert.rejects(result, /abort|cancel/i); assert.equal(f.host.fetch, later);
});

test('missing manifest falls back before any compressed chunks are requested', async () => {
  for (const options of [{ manifestFailure: true }, { manifestStatus: 404 }]) {
    const f = fixture(options); assert.deepEqual(await f.download(), raw);
    assert.equal(f.stats.original, 1); assert.equal(f.stats.requests.length, 0); f.restore();
  }
});

test('invalid manifests cannot fetch arbitrary paths, wrong versions, wrong sizes, or giant chunks', async () => {
  const seed = fixture(); const template = seed.manifest; seed.restore();
  const mutations = [
    m => { m.schemaVersion = 2; },
    m => { m.assets[0].url = 'https://other.test/data?v=' + m.assets[0].sha256; },
    m => { m.assets[0].sha256 = 'a'.repeat(64); },
    m => { m.assets[0].expandedBytes++; },
    m => { m.assets[0].compressedBytes++; },
    m => { m.assets[0].chunks[0].url = '../private/file'; },
    m => { m.assets[0].chunks[0].url += '?anything'; },
    m => { m.assets[0].chunks[0].bytes = 4 * 1024 * 1024 + 1; },
    m => { m.assets.push(m.assets[0]); }
  ];
  for (const mutate of mutations) {
    const m = structuredClone(template); mutate(m);
    const f = fixture({ manifestOverride: m }); assert.deepEqual(await f.download(), raw);
    assert.equal(f.stats.original, 1); assert.equal(f.stats.requests.length, 0); f.restore();
  }
});

test('server-decoded original response is not double-decompressed during manifest fallback', async () => {
  const f = fixture({ manifestFailure: true, originalResponse: () => new Response(raw, { headers: { 'Content-Encoding': 'gzip' } }) });
  assert.deepEqual(await f.download(), raw); f.restore();
});

test('HTTP compression on a static chunk does not change its gzip concatenation semantics', async () => {
  const f = fixture({ chunk({ url, bodies }) { return new Response(bodies.get(url), { headers: { 'Content-Encoding': 'gzip' } }); } });
  assert.deepEqual(await f.download(), raw); f.restore();
});

test('legacy install and missing WebCrypto use original download with native exact expansion', async () => {
  for (const options of [{ legacy: true }, { noCrypto: true }]) {
    const f = fixture(options); assert.deepEqual(await f.download(), raw);
    assert.equal(f.stats.manifests, 0); assert.equal(f.stats.original, 1); f.restore();
  }
});

test('old browsers receive the original gzip for Unity fallback', async () => {
  const f = fixture({ noStreams: true }); assert.deepEqual(await f.download(), packed);
  assert.equal(f.stats.manifests, 0); assert.equal(f.stats.original, 1); f.restore();
});

test('unrelated requests pass through, with no manifest lookup', async () => {
  const f = fixture(); assert.equal(await (await f.host.fetch('https://example.test/music.mp3')).text(), 'unrelated');
  assert.equal(f.stats.manifests, 0); assert.equal(f.stats.requests.length, 0); f.restore();
});
