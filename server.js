const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'live13-data.json');

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'live13')));

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

// RTB Go Proxy — uses Wowza streamlock server
const RTB_BASE = 'https://d1211whpimeups.cloudfront.net';

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.rtbgo.bn/',
      }
    };
    const req = mod.request(opts, (res) => {
      let body = [];
      res.on('data', chunk => body.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body) }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

app.get('/api/rtb', async (req, res) => {
  try {
    const streamPath = req.query.path;
    if (!streamPath) return res.status(400).json({ error: 'missing path param' });

    const targetUrl = RTB_BASE + '/' + streamPath;
    const result = await fetchUrl(targetUrl);

    if (result.status !== 200) {
      return res.status(result.status).send(result.body);
    }

    const contentType = result.headers['content-type'] || '';
    const isPlaylist = contentType.includes('mpegurl') || result.body.slice(0, 20).toString('ascii').includes('#EXTM3U');

    if (isPlaylist) {
      // It's an m3u8 — rewrite URLs, send as text
      const lastSlash = streamPath.lastIndexOf('/');
      const basePath = lastSlash >= 0 ? streamPath.substring(0, lastSlash + 1) : '';

      let body = result.body.toString('utf8');

      // Rewrite chunklist URLs
      body = body.replace(/(chunklist[^\s"']+\.m3u8)/g, (match) => {
        return '/api/rtb?path=' + encodeURIComponent(basePath + match);
      });

      // Rewrite media segment URLs
      body = body.replace(/(media[^\s"']+\.ts)/g, (match) => {
        return '/api/rtb?path=' + encodeURIComponent(basePath + match);
      });

      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache, no-store');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(body);
    } else {
      // Binary data (.ts segments) — send raw buffer, NO string conversion
      res.set('Content-Type', contentType || 'video/mp2t');
      res.set('Cache-Control', 'max-age=10');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(result.body);
    }
  } catch (err) {
    console.error('[RTB Proxy] error:', err.message);
    res.status(502).json({ error: err.message });
  }
});


// NobarLive88 Stream Proxy

app.get('/api/nobar', async (req, res) => {
  try {
    const matchId = req.query.matchId;
    if (!matchId) return res.status(400).json({ error: 'missing matchId' });
    
    // Fetch stream URL from nobarlive88 API
    const apiUrl = 'https://nobarlive88.com/v3/match/getBannerLive';
    const apiReq = https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const matches = json.result || [];
          const match = matches.find(m => m.matchId == matchId && m.liveUrls && m.liveUrls.length > 0);
          if (match) {
            // Find English or original stream
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
            res.status(404).json({ error: 'Match not found or no streams' });
          }
        } catch (e) {
          res.status(500).json({ error: 'Parse error' });
        }
      });
    });
    apiReq.on('error', e => res.status(500).json({ error: e.message }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/nobar/list', (req, res) => {
  try {
    const apiUrl = 'https://nobarlive88.com/v3/match/getBannerLive';
    https.get(apiUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const matches = (json.result || []).filter(m => m.isLive && m.liveUrls && m.liveUrls.length > 0);
          const list = matches.map(m => ({
            id: m.matchId,
            home: m.homeName,
            away: m.awayName,
            score: m.homeScore + '-' + m.awayScore,
            league: m.seriesName,
            time: m.gameTime,
            streams: m.liveUrls.length
          }));
          res.json({ matches: list });
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
  console.log('LIVE13 API running on port ' + PORT);
});

// Esportex Server List API
const esportexUrl = 'https://api.esportex.site/api/streams';

app.get('/api/servers', (req, res) => {
  try {
    https.get(esportexUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const football = json.football || [];
          const matches = football.map(m => ({
            slug: m.slug,
            tag: m.tag,
            league: m.league,
            kickoff: m.kickoff,
            servers: (m.iframes || []).map(s => ({
              name: s.server,
              url: s.url
            }))
          }));
          res.json({ matches });
        } catch (e) {
          res.status(500).json({ error: 'Parse error' });
        }
      });
    }).on('error', e => res.status(500).json({ error: e.message }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
