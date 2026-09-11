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
    const canStream = config.hiplinNativeDecompression !== false && typeof host.DecompressionStream === 'function' && typeof host.TransformStream === 'function';
    let streamsAvailable = canStream;
    if (streamsAvailable) {
      try { new host.DecompressionStream('gzip'); } catch (_) { streamsAvailable = false; }
    }
    function absolute(input) {
      return new host.URL(typeof input === 'string' || input instanceof host.URL ? input : input.url, host.location.href).href;
    }
    // This controls Unity's extra CacheStorage copy only. The browser's normal
    // HTTP cache still works with the unchanged, content-versioned URLs.
    config.cacheControl = function (url) {
      if (entries.has(absolute(url))) return 'no-store';
      if (originalCacheControl) return originalCacheControl.call(this, url);
      return url === this.dataUrl || /\.bundle(?:\?|$)/.test(url) ? 'must-revalidate' : 'no-store';
    };
    const wrappedFetch = async function (input, init) {
      const size = entries.get(absolute(input));
      const method = (init && init.method) || (input && input.method) || 'GET';
      const response = await originalFetch.call(host, input, init);
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
      if (host.fetch === wrappedFetch) host.fetch = originalFetch;
      if (originalCacheControl) config.cacheControl = originalCacheControl;
      else delete config.cacheControl;
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { install };
  else global.HiplinStartupDownloads = { install };
})(typeof window === 'object' ? window : globalThis);
