const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'live13-data.json');

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());

// Cache for external API calls
let nobarCache = { data: null, ts: 0 };
let serversCache = { data: null, ts: 0 };
const CACHE_TTL = 30000; // 30 seconds

// Serve static files with caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '0',
  etag: true,
  lastModified: true
}));
// Fallback: serve from parent live13 directory
app.use(express.static(path.join(__dirname, '..', 'live13'), {
  maxAge: '0',
  etag: true,
  lastModified: true
}));

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return { matches: [], channels: [], settings: {} }; }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// API routes
app.get('/api/data', (req, res) => res.json(loadData()));
app.get('/api/matches', (req, res) => res.json(loadData().matches || []));
app.get('/api/channels', (req, res) => res.json(loadData().channels || []));
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.post('/api/data', (req, res) => {
  const merged = { ...loadData(), ...req.body };
  saveData(merged);
  res.json({ success: true });
});
app.post('/api/matches', (req, res) => {
  const data = loadData();
  data.matches = req.body;
  saveData(data);
  res.json({ success: true });
});

// Generic HLS proxy
function proxyHls(targetUrl, referer, res) {
  const parsed = new URL(targetUrl);
  const mod = parsed.protocol === 'https:' ? https : http;
  const opts = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(referer ? { 'Referer': referer } : {})
    }
  };
  const req = mod.request(opts, (upstream) => {
    let body = [];
    upstream.on('data', chunk => body.push(chunk));
    upstream.on('end', () => {
      const contentType = upstream.headers['content-type'] || '';
      let data = Buffer.concat(body);
      if (contentType.includes('mpegurl') || data.toString('utf8').includes('#EXTM3U')) {
        let text = data.toString('utf8');
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        text = text.replace(/(chunklist[^\s"'\n]+)/g, (m) => '/api/proxy?url=' + encodeURIComponent(baseUrl + m) + (referer ? '&ref=' + encodeURIComponent(referer) : ''));
        text = text.replace(/(media[^\s"'\n]+\.ts)/g, (m) => '/api/proxy?url=' + encodeURIComponent(baseUrl + m) + (referer ? '&ref=' + encodeURIComponent(referer) : ''));
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        data = Buffer.from(text);
      } else if (contentType) {
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=3600');
      }
      res.set('Access-Control-Allow-Origin', '*');
      res.send(data);
    });
  });
  req.on('error', (e) => {
    console.error('[RTB Proxy] error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  });
  req.on('timeout', () => {
    req.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'timeout' });
  });
  req.end();
}

app.get('/api/proxy', (req, res) => {
  const url = req.query.url;
  const ref = req.query.ref;
  if (!url) return res.status(400).json({ error: 'missing url' });
  proxyHls(url, ref, res);
});

// NobarLive88 API with caching
app.get('/api/nobar', async (req, res) => {
  const matchId = req.query.matchId;
  if (!matchId) return res.status(400).json({ error: 'missing matchId' });

  try {
    let data = nobarCache.data;
    if (!data || Date.now() - nobarCache.ts > CACHE_TTL) {
      const r = await fetch('https://nobarlive88.com/v3/match/getBannerLive', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      data = await r.json();
      nobarCache = { data, ts: Date.now() };
    }

    const matches = data.result || [];
    const match = matches.find(m => m.matchId == matchId && m.liveUrls && m.liveUrls.length > 0);
    if (match) {
      const stream = match.liveUrls.find(s => s.language === 'en_US') ||
                     match.liveUrls.find(s => s.language === 'original') ||
                     match.liveUrls[0];
      res.json({
        url: stream.liveUrl,
        flv: stream.liveUrlFlv,
        match: match.homeName + ' vs ' + match.awayName,
        score: match.homeScore + '-' + match.awayScore,
        league: match.seriesName
      });
    } else {
      res.status(404).json({ error: 'Match not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/nobar/list', async (req, res) => {
  try {
    let data = nobarCache.data;
    if (!data || Date.now() - nobarCache.ts > CACHE_TTL) {
      const r = await fetch('https://nobarlive88.com/v3/match/getBannerLive', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      data = await r.json();
      nobarCache = { data, ts: Date.now() };
    }

    const matches = (data.result || []).filter(m => m.isLive && m.liveUrls && m.liveUrls.length > 0);
    const list = matches.map(m => ({
      id: m.matchId,
      home: m.homeName,
      away: m.awayName,
      score: m.homeScore + '-' + m.awayScore,
      league: m.seriesName,
      time: m.gameTime,
      streams: m.liveUrls.length
    }));
    res.json({ matches: list, cached: Date.now() - nobarCache.ts < CACHE_TTL });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Esportex Server List with caching
app.get('/api/servers', (req, res) => {
  try {
    if (serversCache.data && Date.now() - serversCache.ts < CACHE_TTL) {
      return res.json(serversCache.data);
    }

    https.get('https://api.esportex.site/api/streams', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const football = json.football || [];
          const result = {
            matches: football.map(m => ({
              slug: m.slug,
              tag: m.tag,
              league: m.league,
              kickoff: m.kickoff,
              servers: (m.iframes || []).map(s => ({
                name: s.server,
                url: s.url
              }))
            }))
          };
          serversCache = { data: result, ts: Date.now() };
          res.json(result);
        } catch (e) {
          res.status(500).json({ error: 'Parse error' });
        }
      });
    }).on('error', e => res.status(500).json({ error: e.message }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LIVE13 API running on port ${PORT}`);
});
