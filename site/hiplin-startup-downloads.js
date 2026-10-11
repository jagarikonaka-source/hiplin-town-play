(function (global) {
  'use strict';

  // Stream gzip into Unity's one final download buffer. Unity's JS fallback
  // retains the complete compressed file and all inflated chunks before copying
  // them again; its CacheStorage response clone adds another complete download.
  function install(config, expandedSizes, host = global) {
    if (typeof host.fetch !== 'function') return function () {};
    const entries = new Map(Object.entries(expandedSizes).map(([url, size]) => {
      if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024 * 1024) {
        throw new Error('Invalid startup asset size');
      }
      return [new host.URL(url, host.location.href).href, size];
    }));
    const originalFetch = host.fetch;
    const originalCacheControl = config.cacheControl;
    const maxChunkBytes = 4 * 1024 * 1024;
    const canStream = config.hiplinNativeDecompression !== false && typeof host.DecompressionStream === 'function' && typeof host.TransformStream === 'function';
    let streamsAvailable = canStream;
    if (streamsAvailable) {
      try { new host.DecompressionStream('gzip'); } catch (_) { streamsAvailable = false; }
    }
    function absolute(input) {
      return new host.URL(typeof input === 'string' || input instanceof host.URL ? input : input.url, host.location.href).href;
    }
    const useChunks = streamsAvailable && !!config.hiplinStartupManifestUrl &&
      typeof host.ReadableStream === 'function' && typeof host.AbortController === 'function' &&
      !!(host.crypto && host.crypto.subtle && typeof host.crypto.subtle.digest === 'function');
    const session = useChunks ? new host.AbortController() : null;
    const page = new host.URL('.', host.location.href);
    let manifestPromise, cachePromise, cacheWritable = true, active = 0;
    const waiting = [];
    function aborted(signal) {
      if (signal && signal.aborted) {
        if (signal.reason instanceof Error) throw signal.reason;
        const error = new Error('Startup download cancelled');
        error.name = 'AbortError';
        throw error;
      }
    }
    function withSignal(promise, signal) {
      if (!signal) return promise;
      return new Promise((resolve, reject) => {
        function cancel() { try { aborted(signal); } catch (error) { reject(error); } }
        signal.addEventListener('abort', cancel, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
        cancel();
      });
    }
    function acquire(signal) {
      aborted(signal);
      if (active < 3) { active++; return Promise.resolve(); }
      return new Promise((resolve, reject) => {
        const item = { resolve, signal, cancel: () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          try { aborted(signal); } catch (error) { reject(error); }
        } };
        waiting.push(item);
        signal.addEventListener('abort', item.cancel, { once: true });
      });
    }
    async function limited(work, signal) {
      await acquire(signal);
      try { aborted(signal); return await work(); }
      finally {
        active--;
        const next = waiting.shift();
        if (next) {
          next.signal.removeEventListener('abort', next.cancel);
          active++;
          next.resolve();
        }
      }
    }
    // Read into one fixed-size compressed buffer, even if a server ignores its
    // advertised Content-Length. Never retain an entire expanded response.
    async function readChunk(response, bytes, signal) {
      if (response.status !== 200 || !response.body) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new Error('Startup chunk request failed: ' + response.status);
      }
      const output = new Uint8Array(bytes), reader = response.body.getReader();
      let received = 0, complete = false;
      try {
        for (;;) {
          aborted(signal);
          const part = await withSignal(reader.read(), signal);
          if (part.done) break;
          if (received + part.value.byteLength > bytes) throw new Error('Startup chunk exceeds its verified size');
          output.set(part.value, received);
          received += part.value.byteLength;
        }
        if (received !== bytes) throw new Error('Startup chunk download is incomplete');
        complete = true;
        return output;
      } finally {
        if (!complete) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    async function verify(bytes, expected, signal) {
      const digest = await withSignal(host.crypto.subtle.digest('SHA-256', bytes), signal);
      const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== expected) throw new Error('Startup chunk checksum mismatch');
      return bytes;
    }
    function validateManifest(manifest) {
      const hash = /^[a-f0-9]{64}$/;
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length !== entries.size) {
        throw new Error('Invalid startup manifest');
      }
      const assets = new Map();
      for (const asset of manifest.assets) {
        const url = new host.URL(asset.url, page);
        if (url.origin !== page.origin || url.username || url.password || url.hash ||
            !entries.has(url.href) || assets.has(url.href) || !hash.test(asset.sha256) ||
            url.searchParams.get('v') !== asset.sha256 || entries.get(url.href) !== asset.expandedBytes ||
            !Number.isSafeInteger(asset.compressedBytes) || asset.compressedBytes <= 0 || asset.compressedBytes > 1024 * 1024 * 1024 ||
            !Array.isArray(asset.chunks) || !asset.chunks.length || asset.chunks.length > 512) {
          throw new Error('Invalid startup manifest asset');
        }
        let total = 0;
        const seen = new Set();
        const chunks = asset.chunks.map(chunk => {
          if (!chunk || !hash.test(chunk.sha256) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0 || chunk.bytes > maxChunkBytes ||
              typeof chunk.url !== 'string' || !new RegExp('^startup/' + asset.sha256 + '/[0-9]+-' + chunk.sha256 + '\\.bin$').test(chunk.url)) {
            throw new Error('Invalid startup manifest chunk');
          }
          const address = new host.URL(chunk.url, page);
          if (address.origin !== page.origin || !address.pathname.startsWith(page.pathname + 'startup/' + asset.sha256 + '/') || seen.has(address.href)) {
            throw new Error('Invalid startup chunk path');
          }
          seen.add(address.href); total += chunk.bytes;
          return { url: address.href, sha256: chunk.sha256, bytes: chunk.bytes };
        });
        if (total !== asset.compressedBytes) throw new Error('Invalid startup chunk total');
        assets.set(url.href, { chunks, compressedBytes: total });
      }
      return assets;
    }
    function manifest() {
      if (!manifestPromise) manifestPromise = (async () => {
        const url = new host.URL(config.hiplinStartupManifestUrl, page);
        if (url.origin !== page.origin || url.username || url.password || !url.pathname.startsWith(page.pathname)) return null;
        const response = await originalFetch.call(host, url.href, { cache: 'no-cache', signal: session.signal });
        if (!response.ok || !response.body) {
          if (response.body) await response.body.cancel().catch(() => {});
          return null;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '', size = 0;
        try {
          for (;;) {
            const part = await withSignal(reader.read(), session.signal);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 256 * 1024) throw new Error('Startup manifest too large');
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          return validateManifest(JSON.parse(text));
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })().catch(() => null);
      return manifestPromise;
    }
    function cache() {
      // A separate namespace per app path, with only immutable compressed
      // chunks inside. Leave older versions for browser quota eviction; never
      // delete another open game's assets or the player's persistent saves.
      if (!cachePromise) cachePromise = Promise.resolve().then(() =>
        host.caches ? host.caches.open('hiplin-startup-compressed-v1:' + page.pathname) : null
      ).catch(() => null);
      return cachePromise;
    }
    function chunk(entry, signal) {
      return limited(async () => {
        const storage = await withSignal(cache(), signal);
        if (storage) {
          let saved;
          try { saved = await withSignal(storage.match(entry.url), signal); } catch (_) { aborted(signal); }
          if (saved) {
            try { return await verify(await readChunk(saved, entry.bytes, signal), entry.sha256, signal); }
            catch (_) {
              aborted(signal);
              try { await withSignal(storage.delete(entry.url), signal); } catch (_) { aborted(signal); }
            }
          }
        }
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await originalFetch.call(host, entry.url, { signal, cache: attempt ? 'reload' : 'force-cache', credentials: 'same-origin' });
            const bytes = await verify(await readChunk(response, entry.bytes, signal), entry.sha256, signal);
            if (storage && cacheWritable) {
              try {
                await withSignal(storage.put(entry.url, new host.Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength) } })), signal);
              } catch (_) { aborted(signal); cacheWritable = false; }
            }
            return bytes;
          } catch (error) {
            aborted(signal);
            if (attempt >= 2) throw error;
            await withSignal(new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1))), signal);
          }
        }
      }, signal);
    }
    function compressedStream(asset, callerSignal) {
      const controller = new host.AbortController(), slots = new Map();
      let next = 0, scheduled = 0, stopped = false;
      const cancel = () => controller.abort();
      const parents = [session.signal, callerSignal].filter(Boolean);
      for (const signal of parents) {
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }
      function cleanup() {
        stopped = true;
        for (const signal of parents) signal.removeEventListener('abort', cancel);
        slots.clear();
      }
      function fill() {
        // Advance only when the ordered consumer advances, not whenever an
        // out-of-order download completes. At most three slots per asset.
        while (!stopped && scheduled < asset.chunks.length && scheduled < next + 3) {
          const index = scheduled++;
          slots.set(index, chunk(asset.chunks[index], controller.signal).then(bytes => ({ bytes }), error => ({ error })));
        }
      }
      return new host.ReadableStream({
        async pull(output) {
          try {
            aborted(controller.signal);
            fill();
            const result = await slots.get(next);
            aborted(controller.signal);
            if (result.error) throw result.error;
            slots.delete(next++);
            output.enqueue(result.bytes);
            if (next === asset.chunks.length) { cleanup(); output.close(); }
          } catch (error) { cancel(); cleanup(); output.error(error); }
        },
        cancel() { cancel(); cleanup(); }
      }, { highWaterMark: 0 });
    }
    // This controls Unity's extra CacheStorage copy only. The browser's normal
    // HTTP cache still works with the unchanged, content-versioned URLs.
    config.cacheControl = function (url) {
      if (entries.has(absolute(url))) return 'no-store';
      if (originalCacheControl) return originalCacheControl.call(this, url);
      return url === this.dataUrl || /\.bundle(?:\?|$)/.test(url) ? 'must-revalidate' : 'no-store';
    };
    const wrappedFetch = async function (input, init) {
      const address = absolute(input), size = entries.get(address);
      const method = (init && init.method) || (input && input.method) || 'GET';
      const callerSignal = (init && init.signal) || (input && input.signal);
      let response;
      if (useChunks && size && method.toUpperCase() === 'GET') {
        aborted(callerSignal); aborted(session.signal);
        const assets = await withSignal(manifest(), callerSignal);
        aborted(callerSignal); aborted(session.signal);
        if (assets) {
          const asset = assets.get(address);
          response = new host.Response(compressedStream(asset, callerSignal), { headers: { 'Content-Length': String(asset.compressedBytes) } });
        }
      }
      if (!response) response = await originalFetch.call(host, input, init);
      if (!size || method.toUpperCase() !== 'GET' || !streamsAvailable || !response.ok || !response.body) return response;

      // Content-Encoding means the browser has already decoded the body.
      const encodedByServer = response.headers.get('Content-Encoding');
      const body = encodedByServer && encodedByServer !== 'identity'
        ? response.body : response.body.pipeThrough(new host.DecompressionStream('gzip'));
      let received = 0;
      const checked = body.pipeThrough(new host.TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > size) throw new Error('Startup asset exceeds its verified size');
          controller.enqueue(chunk);
        },
        flush() {
          if (received !== size) throw new Error('Startup asset download is incomplete');
        }
      }));
      const headers = new host.Headers(response.headers);
      headers.delete('Content-Encoding');
      // Avoid Unity's estimated size, growth and final slice/copy.
      headers.set('Content-Length', String(size));
      return new host.Response(checked, { status: response.status, statusText: response.statusText, headers });
    };
    host.fetch = wrappedFetch;
    return function restore() {
      if (session) session.abort();
      if (host.fetch === wrappedFetch) host.fetch = originalFetch;
      if (originalCacheControl) config.cacheControl = originalCacheControl;
      else delete config.cacheControl;
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { install };
  else global.HiplinStartupDownloads = { install };
})(typeof window === 'object' ? window : globalThis);
