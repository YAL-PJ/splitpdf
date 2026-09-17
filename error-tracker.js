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
 *   for manual reports (e.g. from a "Report issue" button). It returns
 *   a Promise resolving to { ok: true, target: 'apps-script' } when the
 *   Apps Script accepts the report.
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


  // ---------------------------------------------------------------------------
  // SAFE PDF METADATA
  //
  // Why this exists: crash reports land in a Google Sheet as message + stack +
  // user agent + a file NAME. When a crash depends on one particular PDF that
  // is not enough to reproduce it, and the file itself must never leave the
  // browser — 100% client-side processing is the product. So we send a small
  // set of *structural* facts about the file instead.
  //
  // NEVER CAPTURED, DELIBERATELY:
  //   * file bytes (no copies, no slices, no base64, no content hashes)
  //   * page text or any extracted content strings
  //   * images / thumbnails / rendered canvases
  //   * the PDF Info dictionary fields /Title, /Author, /Subject, /Keywords —
  //     these routinely hold real user data (person names, client names, case
  //     or invoice numbers, medical and HR wording). /Producer and /Creator
  //     name *software*, not people, so they are safe and are the single most
  //     useful clue for reproducing a parser bug.
  // If you are unsure whether a new field is safe, leave it out.
  //
  // Cost: we never fully parse the file. We scan a capped window from the head
  // and the tail of the buffer, so counts on a huge PDF are approximate
  // (reported as `truncated=1`). Everything is wrapped so that a malformed
  // PDF, a parse failure or a missing API can never throw out of the reporter:
  // a reporter that crashes while reporting a crash is worse than no metadata.
  // ---------------------------------------------------------------------------

  var META_HEAD_BYTES = 1572864;   // 1.5 MB from the start
  var META_TAIL_BYTES = 262144;    // 256 KB from the end (trailer / Info dict)
  var META_STRING_MAX = 120;       // cap on producer/creator strings

  function toBytes_(input) {
    try {
      if (!input) return null;
      if (input instanceof Uint8Array) return input;
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
      if (input.buffer && typeof input.byteLength === 'number') {
        return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // Bytes -> latin1 text, in chunks so we never blow the argument limit.
  function latin1_(bytes, start, end) {
    var out = '';
    var CHUNK = 8192;
    for (var i = start; i < end; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + CHUNK)));
    }
    return out;
  }

  // Software name from a literal string, e.g. `/Producer (pdf-lib 1.17)`.
  // Hex strings (`/Producer <FEFF...>`) are skipped on purpose: decoding them
  // buys little and risks emitting bytes we have not inspected.
  function infoString_(text, key) {
    try {
      var re = new RegExp('\\/' + key + '\\s*\\(((?:\\\\.|[^\\\\)])*)\\)');
      var m = re.exec(text);
      if (!m) return '';
      var value = m[1].replace(/\\([nrtbf()\\])/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ');
      value = value.replace(/\s+/g, ' ').trim();
      return scrub_(value).slice(0, META_STRING_MAX);
    } catch (_) {
      return '';
    }
  }

  function countMatches_(text, re) {
    var n = 0;
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      n += 1;
      if (m.index === re.lastIndex) re.lastIndex += 1;
      if (n > 200000) break; // sanity stop; approximate is fine
    }
    return n;
  }

  /**
   * Structural, non-identifying facts about a PDF buffer. Never throws.
   * @param {Uint8Array|ArrayBuffer} input raw PDF bytes (never transmitted)
   * @param {{pageCount?:number}} [hints] values the caller already knows
   *        (e.g. pdf.js numPages) — cheaper and more accurate than scanning.
   * @returns {Object} safe fields only; missing/unknown fields are omitted.
   */
  function pdfMetaFromBytes_(input, hints) {
    var meta = {};
    try {
      hints = hints || {};
      var bytes = toBytes_(input);
      if (!bytes || !bytes.length) return meta;

      meta.fileSize = bytes.length;

      var head = latin1_(bytes, 0, Math.min(bytes.length, META_HEAD_BYTES));
      var tailStart = Math.max(Math.min(bytes.length, META_HEAD_BYTES), bytes.length - META_TAIL_BYTES);
      var tail = tailStart < bytes.length ? latin1_(bytes, tailStart, bytes.length) : '';
      var scanned = head + tail;
      var truncated = (head.length + tail.length) < bytes.length;
      if (truncated) meta.truncated = true;

      var version = /%PDF-(\d\.\d)/.exec(head.slice(0, 1024));
      if (version) meta.pdfVersion = version[1];

      // /Linearized lives in the first object of a linearized file.
      meta.isLinearized = head.slice(0, 4096).indexOf('/Linearized') !== -1;

      // /Encrypt is referenced from the trailer dictionary.
      meta.isEncrypted = scanned.indexOf('/Encrypt') !== -1;

      meta.hasAcroForm = scanned.indexOf('/AcroForm') !== -1;

      if (typeof hints.pageCount === 'number' && isFinite(hints.pageCount)) {
        meta.pageCount = hints.pageCount;
      } else {
        var pages = countMatches_(scanned, /\/Type\s*\/Page(?![a-zA-Z])/g);
        if (pages > 0) meta.pageCount = pages;
      }

      // Prefer the trailer's /Size (total objects); else count `N G obj`.
      var size = /\/Size\s+(\d+)/.exec(tail) || /\/Size\s+(\d+)/.exec(scanned);
      if (size) meta.objectCount = parseInt(size[1], 10);
      else {
        var objs = countMatches_(scanned, /\b\d+\s+\d+\s+obj\b/g);
        if (objs > 0) meta.objectCount = objs;
      }

      // Software names only — see the privacy note above.
      var producer = infoString_(tail, 'Producer') || infoString_(head, 'Producer');
      var creator = infoString_(tail, 'Creator') || infoString_(head, 'Creator');
      if (producer) meta.producer = producer;
      if (creator) meta.creator = creator;
    } catch (_) {
      // Best effort only: return whatever we managed to collect.
    }
    return meta;
  }

  /** Same, from a File/Blob. Never throws and never keeps the bytes. */
  function pdfMetaFromFile_(file, hints) {
    try {
      if (!file || typeof file.arrayBuffer !== 'function') return Promise.resolve({});
      return file.arrayBuffer().then(function (buf) {
        return pdfMetaFromBytes_(buf, hints);
      }).catch(function () { return {}; });
    } catch (_) {
      return Promise.resolve({});
    }
  }

  // Flatten to the `key=value;key=value` breadcrumb style the sibling apps use
  // in userNote, e.g. mode=simple;step=mergePDFs;files=2;totalBytes=1476917
  function pdfMetaBreadcrumb_(meta) {
    try {
      if (!meta || typeof meta !== 'object') return '';
      var order = ['pdfVersion', 'fileSize', 'pageCount', 'objectCount', 'isEncrypted', 'isLinearized', 'hasAcroForm', 'producer', 'creator', 'truncated'];
      var parts = [];
      for (var i = 0; i < order.length; i++) {
        var key = order[i];
        if (!(key in meta)) continue;
        var value = meta[key];
        if (value === null || typeof value === 'undefined' || value === '') continue;
        if (typeof value === 'boolean') value = value ? 1 : 0;
        value = String(value).replace(/[;=\r\n]+/g, ' ').trim();
        parts.push(key + '=' + value);
      }
      return parts.join(';');
    } catch (_) {
      return '';
    }
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
      if (!ENDPOINT || !APP_ID) return Promise.resolve({ ok: false, target: 'disabled' });
      if (sentInSession >= SESSION_BUDGET) return Promise.resolve({ ok: false, target: 'throttled' });
      context = context || {};
      if (shouldIgnoreNoise_(err, context)) return Promise.resolve({ ok: false, target: 'ignored' });

      var normalized = normalize_(err);
      var message = scrub_(normalized.message).slice(0, MESSAGE_MAX) || 'Unknown error';
      var stack = scrub_(normalized.stack).slice(0, STACK_MAX);
      var feature = scrub_(context.feature || '');
      var fileName = scrub_(context.fileName || '');
      var code = scrub_(context.code || '');
      var userNote = scrub_(context.userNote || '');

      // Fold safe PDF metadata into the userNote breadcrumb. Accepts either a
      // metadata object (from pdfMeta*) or a pre-built breadcrumb string.
      // Wrapped: a bad value here must not stop the report from being sent.
      try {
        if (context.pdfMeta) {
          var crumb = typeof context.pdfMeta === 'string'
            ? context.pdfMeta
            : pdfMetaBreadcrumb_(context.pdfMeta);
          if (crumb) userNote = userNote ? (userNote.replace(/;\s*$/, '') + ';' + crumb) : crumb;
        }
      } catch (_) {}
      userNote = userNote.slice(0, 500);

      var now = Date.now();
      var fp = fingerprint_(message, feature, fileName, code);
      if (fp === lastFingerprint && now - lastSentAt < DEDUP_WINDOW_MS) return;
      lastFingerprint = fp;
      lastSentAt = now;
      sentInSession += 1;

      var payload = {
        action: 'error_report',
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
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: 'cors'
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (json) {
          if (json && json.ok === false) {
            return { ok: false, target: 'apps-script', error: json.error || 'report rejected' };
          }
          return { ok: true, target: 'apps-script' };
        });
      }).catch(function (fetchErr) {
        return { ok: false, target: 'apps-script', error: String(fetchErr && fetchErr.message || fetchErr) };
      });
    } catch (reporterErr) {
      try { console.warn('Error tracker failed:', reporterErr); } catch (_) {}
      return Promise.resolve({ ok: false, target: 'reporter', error: String(reporterErr && reporterErr.message || reporterErr) });
    }
  }

  // Public API
  window.reportError = send_;
  window.__errorTrackerSessionId = sessionId;

  // Safe PDF metadata helpers. Callers pass the result as `pdfMeta` on a
  // reportError context (or build the breadcrumb themselves). Read the privacy
  // note above before adding any field here.
  window.__errorTrackerPdfMeta = {
    fromBytes: pdfMetaFromBytes_,
    fromFile: pdfMetaFromFile_,
    breadcrumb: pdfMetaBreadcrumb_
  };

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
