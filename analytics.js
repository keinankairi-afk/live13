/**
 * Live13 Analytics — server-side module
 * =====================================
 * Lightweight, self-hosted analytics designed for a live IPTV streaming site.
 * - POST /api/track  → client beacons (pageview, stream play/pause/error, etc.)
 * - GET  /api/stats  → aggregated stats for the dashboard
 * - GET  /stats      → dashboard HTML
 *
 * Storage:
 *   analytics-data/events-YYYY-MM-DD.jsonl   (one event per line, append-only)
 *   analytics-data/sessions.json             (active session state)
 *
 * Concurrency model: sessions that haven't sent a heartbeat in 90s are pruned.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'analytics-data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL_MS = 90 * 1000;       // 90s without heartbeat = gone
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // forget sessions older than 24h

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------- In-memory state ----------------
let sessions = {};   // sessionId → { firstSeen, lastSeen, meta, events: [] }
let recentEvents = []; // ring buffer, last 500 events (for dashboard)
const RECENT_CAP = 500;

// Load sessions from disk on startup
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[analytics] failed to load sessions:', e.message);
    sessions = {};
  }
}
loadSessions();

// Periodically prune + persist
function persistSessions() {
  const count = Object.keys(sessions).length;
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 0));
    if (count > 0) console.log(`[analytics] persisted ${count} sessions (${sessions && Object.keys(sessions).length} in memory)`);
  } catch (e) {
    console.error('[analytics] failed to persist sessions:', e.message);
  }
}
setInterval(persistSessions, 10 * 1000);
setInterval(pruneSessions, 30 * 1000);

function pruneSessions() {
  const now = Date.now();
  const before = Object.keys(sessions).length;
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    if (now - s.lastSeen > SESSION_TTL_MS) {
      s.endedAt = s.lastSeen;
    }
    if (now - s.firstSeen > SESSION_MAX_AGE_MS) {
      delete sessions[id];
    }
  }
  const after = Object.keys(sessions).length;
  if (before !== after) {
    console.log(`[analytics] pruned ${before - after} expired sessions (${after} active)`);
  }
}

// ---------------- Event logging ----------------
function todayFile() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return path.join(DATA_DIR, `events-${ymd}.jsonl`);
}

function logEvent(sessionId, event, data) {
  const record = {
    t: new Date().toISOString(),
    sid: sessionId,
    event,
    data: data || {}
  };
  // Append to daily log (best-effort)
  try {
    fs.appendFileSync(todayFile(), JSON.stringify(record) + '\n');
  } catch (e) {
    console.error('[analytics] log write failed:', e.message);
  }
  // Push to ring buffer
  recentEvents.push(record);
  if (recentEvents.length > RECENT_CAP) {
    recentEvents.splice(0, recentEvents.length - RECENT_CAP);
  }
}

// ---------------- Geo lookup (free, no external dep) ----------------
// Returns "ID" / "MY" / "US" etc from CF-IPCountry header if behind Cloudflare,
// else from Accept-Language hint, else "ZZ" (unknown).
function guessCountry(req) {
  const cf = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'];
  if (cf && typeof cf === 'string' && cf.length === 2) return cf.toUpperCase();
  const lang = (req.headers['accept-language'] || '').split(',')[0] || '';
  if (lang.includes('id')) return 'ID';
  if (lang.includes('ms')) return 'MY';
  if (lang.includes('en')) return 'US';
  return 'ZZ';
}

// ---------------- Route handlers ----------------
function trackHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sessionId = (req.headers['x-session-id'] || '').trim();
  if (!sessionId || sessionId.length > 80) {
    return res.status(400).json({ error: 'missing X-Session-Id' });
  }

  // Sanitize body
  const body = req.body || {};
  const event = String(body.event || '').slice(0, 40);
  if (!event) return res.status(400).json({ error: 'missing event' });
  const data = body.data && typeof body.data === 'object' ? body.data : {};

  const now = Date.now();
  const country = guessCountry(req);
  const meta = {
    country,
    ref: (req.headers.referer || '').slice(0, 200),
    ua: (req.headers['user-agent'] || '').slice(0, 200)
  };

  // Update session
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      firstSeen: now,
      lastSeen: now,
      meta,
      events: {},
      totalEvents: 0
    };
  }
  const sess = sessions[sessionId];
  sess.lastSeen = now;
  // Merge meta, but only overwrite country if the new hint is more specific
  // (i.e. not the default 'ZZ' fallback). This prevents subsequent events
  // without an Accept-Language header from clobbering an earlier detection.
  if (meta.country && meta.country !== 'ZZ') {
    sess.meta.country = meta.country;
  }
  if (meta.ref) sess.meta.ref = meta.ref;
  if (meta.ua) sess.meta.ua = meta.ua;
  sess.events[event] = (sess.events[event] || 0) + 1;
  sess.totalEvents += 1;

  logEvent(sessionId, event, data);
  res.status(204).end();
}

function statsHandler(req, res) {
  const now = Date.now();

  // Active = last heartbeat within TTL
  const active = Object.entries(sessions).filter(([, s]) => now - s.lastSeen < SESSION_TTL_MS);

  // Today (UTC midnight → now)
  const todayMidnight = new Date();
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const todayStart = todayMidnight.getTime();

  // Aggregate today's events from disk (or ring buffer fallback)
  let todayEvents = [];
  try {
    const f = todayFile();
    if (fs.existsSync(f)) {
      todayEvents = fs.readFileSync(f, 'utf8')
        .split('\n').filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean)
        .filter(e => new Date(e.t).getTime() >= todayStart);
    }
  } catch (e) { /* ignore */ }

  // Event counts (today)
  const eventCounts = {};
  for (const e of todayEvents) {
    eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
  }

  // Unique sessions today
  const todaySids = new Set(todayEvents.map(e => e.sid));
  const totalSessionsToday = todaySids.size;

  // Country distribution
  const byCountry = {};
  for (const sid of todaySids) {
    const c = sessions[sid]?.meta?.country || 'ZZ';
    byCountry[c] = (byCountry[c] || 0) + 1;
  }

  // Hourly buckets (last 24h)
  const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
  for (const e of todayEvents) {
    const h = new Date(e.t).getUTCHours();
    hourly[h].count += 1;
  }

  // Recent errors (last 50)
  const recentErrors = recentEvents
    .filter(e => e.event === 'stream_error')
    .slice(-20)
    .reverse();

  // Stream event stats
  const streamStarts = eventCounts.stream_start || 0;
  const streamErrors = eventCounts.stream_error || 0;
  const streamPauses = eventCounts.stream_pause || 0;
  const errorRate = streamStarts > 0
    ? Math.round((streamErrors / streamStarts) * 1000) / 10
    : 0;

  res.json({
    current_viewers: active.length,
    total_sessions_today: totalSessionsToday,
    total_events_today: todayEvents.length,
    stream: {
      starts: streamStarts,
      pauses: streamPauses,
      errors: streamErrors,
      error_rate_pct: errorRate
    },
    event_counts: eventCounts,
    by_country: byCountry,
    hourly,
    recent_errors: recentErrors,
    server_time: new Date().toISOString()
  });
}

// Health/version probe
function healthHandler(req, res) {
  res.json({
    status: 'ok',
    active_sessions: Object.keys(sessions).length,
    recent_events_buffered: recentEvents.length,
    uptime_s: Math.round(process.uptime())
  });
}

// Mount points — pass the express app
function mount(app) {
  app.post('/api/track', trackHandler);
  app.get('/api/stats', statsHandler);
  app.get('/api/stats/health', healthHandler);
  console.log('[analytics] mounted: POST /api/track, GET /api/stats, GET /api/stats/health');
}

module.exports = { mount, trackHandler, statsHandler, healthHandler };
