/**
 * Shared error tracker for Yanis L.'s PDF tools.
 *
 * USAGE
 *   Before loading this script, set window.__ERROR_TRACKER_CONFIG with the
 *   shared Apps Script /exec URL and the app id:
 *
 *     <script>
 *       window.__ERROR_TRACKER_CONFIG = {
 *         endpoint: 'https://script.google.com/macros/s/AKfycbz.../exec',
 *         app: 'freemergepdf',   // or splitpdf | converttopdf | compresspdf
 *         appVersion: '2026-05-25'   // optional
 *       };
 *     </script>
 *     <script src="error-tracker.js" defer></script>
 *
 *   Also exposes window.reportError(err, { feature, userNote, fileName, code })
 *   for manual reports (e.g. from a "Report issue" button).
 *
 *   Posts as text/plain JSON to avoid CORS preflight. Fire-and-forget; any
 *   failure inside the tracker is swallowed so user flows aren't affected.
 */

(function () {
  var cfg = (typeof window !== 'undefined' && window.__ERROR_TRACKER_CONFIG) || {};
  var ENDPOINT = cfg.endpoint || '';
  var APP_ID = cfg.app || '';
  var APP_VERSION = cfg.appVersion || '';

  // Limits + throttling
  var STACK_MAX = 1800;
  var MESSAGE_MAX = 500;
  var DEDUP_WINDOW_MS = 8000;
  var SESSION_BUDGET = 30;       // hard cap on reports per session

  // Per-session state
  var sessionId = readSessionId_();
  var sentInSession = 0;
  var lastFingerprint = '';
  var lastSentAt = 0;

  function readSessionId_() {
    try {
      var key = '__error_tracker_session__';
      var existing = sessionStorage.getItem(key);
      if (existing) return existing;
      var fresh = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, fresh);
      return fresh;
    } catch (_) {
      return 's_' + Date.now().toString(36);
    }
  }

  function isSameOriginUrl_(url) {
    try {
      if (!url) return true;
      var parsed = new URL(url, window.location.href);
      return parsed.origin === window.location.origin;
    } catch (_) {
      return true;
    }
  }

  // Noise filter built from freemergepdf production traffic.
  // Keep this list in sync across apps; most noise is shared (ads, analytics, extensions).
  function shouldIgnoreNoise_(err, context) {
    var message = String((err && err.message) || '').toLowerCase();
    var stack = String((err && err.stack) || '').toLowerCase();
    var url = String((context && context.url) || '').toLowerCase();
    var feature = String((context && context.feature) || '').toLowerCase();
    var joined = message + ' ' + stack + ' ' + url;

    // Cross-origin script errors stripped by the browser — no actionable info.
    if (message.trim() === 'script error.') return true;

    // Browser extension noise (we can't fix what we can't see).
    if (joined.indexOf('chrome-extension://') !== -1) return true;
    if (joined.indexOf('moz-extension://') !== -1) return true;
    if (joined.indexOf('safari-web-extension://') !== -1) return true;
    if (joined.indexOf('chrome.runtime.lasterror') !== -1) return true;
    if (stack.indexOf('/scripts/inpage.js') !== -1 && stack.indexOf('extension://') !== -1) return true;
    if (joined.indexOf('failed to connect to metamask') !== -1) return true;

    // Third-party ads/analytics widgets (Mediavine, Grow, UID2, prebid, etc.).
    if (joined.indexOf('uid2 sdk failed to load') !== -1) return true;
    if (joined.indexOf('cdn.prod.uidapi.com') !== -1) return true;
    if (joined.indexOf('faves.grow.me') !== -1) return true;
    if (joined.indexOf('scripts.scriptwrapper.com') !== -1) return true;
    if (joined.indexOf('scripts.journeymv.com') !== -1) return true;
    if (joined.indexOf('/tags/optable/') !== -1) return true;
    if (joined.indexOf('api.receptivity.io') !== -1 && message.indexOf("can't find variable: webassembly") !== -1) return true;
    if (joined.indexOf('rxconnector.js') !== -1 && message.indexOf("can't find variable: webassembly") !== -1) return true;
    if (joined.indexOf('attestation check for topics') !== -1) return true;
    if (joined.indexOf('getuid?gdpr=') !== -1 && joined.indexOf('failed to load resource') !== -1) return true;
    if (joined.indexOf('google-analytics.com/g/collect') !== -1 && message.indexOf('failed to fetch') !== -1) return true;

    // Recurrent unactionable promise rejections.
    if (feature === 'unhandledrejection' && message.indexOf('failed validating event') !== -1) return true;
    if (feature === 'unhandledrejection' && message.indexOf('failed parsing identifiers') !== -1) return true;
    if (feature === 'unhandledrejection' && message.indexOf('signal is aborted without reason') !== -1) return true;
    if (feature === 'unhandledrejection' && !stack && (message === 'load failed' || message === 'fetch is aborted')) return true;
    if (message.indexOf('importing a module script failed') !== -1) return true;
    if (message.indexOf('unknown rejection') !== -1 && stack.indexOf('webkit-masked-url://hidden/') !== -1) return true;
    if (feature === 'unhandledrejection' && stack.indexOf('webkit-masked-url://hidden/') !== -1) return true;
    if (feature === 'unhandledrejection' && /^error:\s*[a-z]{1,3}$/i.test(message)) return true;
    if (feature === 'unhandledrejection' && message.indexOf('object not found matching id:') !== -1) return true;
    if (feature === 'unhandledrejection' && message.indexOf('no listener: tabs:outgoing.message.ready') !== -1) return true;

    // Anonymous browser-injected snippets.
    if (message.indexOf('n0_ is not defined') !== -1 && stack.indexOf('at injfunc (<anonymous>') !== -1) return true;

    // Best-effort analytics calls failing under blockers/offline.
    if (message.indexOf('failed to fetch') !== -1 && stack.indexOf('postuserdata') !== -1) return true;
    if (feature === 'unhandledrejection' && message.indexOf('failed to fetch') !== -1 && stack.indexOf('<anonymous>') !== -1) return true;

    return false;
  }

  function scrub_(text) {
    return String(text || '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]');
  }

  function normalize_(err) {
    if (err instanceof Error) {
      return { message: err.message, stack: err.stack || '' };
    }
    if (err && typeof err === 'object') {
      if (typeof err.message === 'string') return { message: err.message, stack: err.stack || '' };
      try { return { message: JSON.stringify(err), stack: '' }; } catch (_) { return { message: String(err), stack: '' }; }
    }
    return { message: String(err == null ? 'Unknown error' : err), stack: '' };
  }

  function fingerprint_(message, feature, fileName, code) {
    return [message, feature || '', fileName || '', code || ''].join('|');
  }

  function send_(err, context) {
    try {
      if (!ENDPOINT || !APP_ID) return;
      if (sentInSession >= SESSION_BUDGET) return;
      context = context || {};
      if (shouldIgnoreNoise_(err, context)) return;

      var normalized = normalize_(err);
      var message = scrub_(normalized.message).slice(0, MESSAGE_MAX) || 'Unknown error';
      var stack = scrub_(normalized.stack).slice(0, STACK_MAX);
      var feature = scrub_(context.feature || '');
      var fileName = scrub_(context.fileName || '');
      var code = scrub_(context.code || '');
      var userNote = scrub_(context.userNote || '').slice(0, 500);

      var now = Date.now();
      var fp = fingerprint_(message, feature, fileName, code);
      if (fp === lastFingerprint && now - lastSentAt < DEDUP_WINDOW_MS) return;
      lastFingerprint = fp;
      lastSentAt = now;
      sentInSession += 1;

      var payload = {
        type: 'error',
        app: APP_ID,
        feature: feature,
        code: code,
        message: message,
        stack: stack,
        url: context.url || window.location.pathname + window.location.search,
        userAgent: (navigator && navigator.userAgent) || '',
        sessionId: sessionId,
        fileName: fileName,
        userNote: userNote,
        appVersion: APP_VERSION
      };

      // keepalive so we still send on page unload
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: 'cors'
      }).catch(function () { /* fire-and-forget */ });
    } catch (reporterErr) {
      try { console.warn('Error tracker failed:', reporterErr); } catch (_) {}
    }
  }

  // Public API
  window.reportError = send_;
  window.__errorTrackerSessionId = sessionId;

  // Global handlers
  window.addEventListener('error', function (event) {
    if ((event && event.message ? String(event.message) : '').trim().toLowerCase() === 'script error.') return;
    if (event && event.filename && !isSameOriginUrl_(event.filename)) return;
    var err = (event && event.error) || new Error((event && event.message) || 'Unknown window error');
    send_(err, {
      feature: 'window.error',
      url: (event && event.filename) || (window.location.pathname + window.location.search)
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason instanceof Error
      ? event.reason
      : new Error(String((event && event.reason) || 'Unknown rejection'));
    send_(reason, {
      feature: 'unhandledrejection',
      url: window.location.pathname + window.location.search
    });
  });
})();
