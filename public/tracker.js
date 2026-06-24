/*!
 * Live13 Analytics — client tracker
 * =================================
 * Self-contained, ~2KB minified, no dependencies.
 *   <script src="/tracker.js" defer></script>
 *
 * Exposes:
 *   window.live13Tracker.track(event, data)  // manual event
 *   window.live13Tracker.sid                 // session UUID
 *   window.live13Tracker.flush()             // force flush pending events
 *
 * Auto-tracks: page_view (on load), heartbeat (every 30s), unload (on close).
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/track';
  var HEARTBEAT_MS = 30 * 1000;
  var QUEUE_MAX = 50;

  // ---- session id (sticky per browser) ----
  var STORE_KEY = 'live13_sid';
  var sid = null;
  try {
    sid = localStorage.getItem(STORE_KEY);
    if (!sid) {
      // crypto.randomUUID is available in modern browsers; fallback for older
      sid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 's' + Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(STORE_KEY, sid);
    }
  } catch (e) {
    // localStorage might be blocked (Safari private mode etc.)
    sid = 's' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  // ---- common meta attached to every event ----
  function meta() {
    return {
      url: location.pathname,
      href: location.href,
      ref: document.referrer || '',
      vw: window.innerWidth,
      vh: window.innerHeight,
      lang: navigator.language || '',
      conn: (navigator.connection && navigator.connection.effectiveType) || ''
    };
  }

  // ---- queue (so we can batch & retry once) ----
  var queue = [];
  var flushing = false;

  function send(event, data) {
    var payload = { event: event, data: Object.assign({}, meta(), data || {}) };
    queue.push(payload);
    if (queue.length > QUEUE_MAX) queue.shift();
    flush();
  }

  function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    var batch = queue.splice(0, queue.length);

    if (navigator.sendBeacon) {
      try {
        var blob = new Blob(
          batch.map(function (b) { return JSON.stringify(b); }).join('\n'),
          { type: 'application/x-ndjson' }
        );
        if (navigator.sendBeacon(ENDPOINT, blob)) {
          flushing = false;
          return;
        }
      } catch (e) { /* fall through to fetch */ }
    }

    // Fallback: fetch with keepalive
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': sid
      },
      body: JSON.stringify(batch.length === 1 ? batch[0] : { events: batch }),
      keepalive: true
    }).then(
      function () { flushing = false; },
      function () {
        // re-queue on failure
        queue = batch.concat(queue).slice(-QUEUE_MAX);
        flushing = false;
      }
    );
  }

  // ---- public API ----
  var api = {
    sid: sid,
    track: send,
    flush: flush,
    // Convenience helpers for common events
    streamStart: function (channelId) { send('stream_start', { channel: channelId }); },
    streamPause: function () { send('stream_pause'); },
    streamResume: function () { send('stream_resume'); },
    streamEnd: function (watchedMs) { send('stream_end', { watched_ms: watchedMs }); },
    streamError: function (errType, detail) { send('stream_error', { type: errType, detail: detail }); },
    qualityChange: function (level) { send('quality_change', { level: level }); },
    channelSwitch: function (fromId, toId) { send('channel_switch', { from: fromId, to: toId }); }
  };
  window.live13Tracker = api;

  // ---- auto events ----
  // page_view on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { send('page_view'); });
  } else {
    send('page_view');
  }

  // heartbeat while page is open
  setInterval(function () { send('heartbeat'); }, HEARTBEAT_MS);

  // unload beacon
  function unload() {
    try {
      navigator.sendBeacon && navigator.sendBeacon(ENDPOINT,
        new Blob([JSON.stringify({ event: 'unload', data: meta() })],
                 { type: 'application/json' })
      );
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('pagehide', unload);
  window.addEventListener('beforeunload', unload);

  // visibility — count hidden time as break (useful heuristic)
  document.addEventListener('visibilitychange', function () {
    send(document.hidden ? 'tab_hide' : 'tab_show');
  });
})();
