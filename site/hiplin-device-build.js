(function (root) {
  "use strict";
  function select(document) {
    var canvas, gl;
    try {
      canvas = (document || root.document).createElement("canvas");
      gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
      if (!gl) return "dxt";
      return gl.getExtension("WEBGL_compressed_texture_astc") ? "astc" : "dxt";
    } catch (_) {
      return "dxt";
    } finally {
      if (gl) {
        try {
          var release = gl.getExtension("WEBGL_lose_context");
          if (release) release.loseContext();
        } catch (_) { /* A lost probe context must not block startup. */ }
      }
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }
  root.HiplinDeviceBuild = { select: select };
  if (typeof module !== "undefined") module.exports = root.HiplinDeviceBuild;
})(typeof window !== "undefined" ? window : globalThis);
