(function (root) {
  'use strict';
  // Keep the published shell callbacks compatible without a diagnostics HUD
  // or recurring metrics collection. HiplinLoading owns startup error messages.
  root.HiplinGraphicsTrial = {
    ready() {},
    unsupported() {},
    fail() {}
  };
})(window);
