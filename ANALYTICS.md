# Live13 Analytics — Deploy Guide

## File yang ditambah / diubah

| File | Status | Tujuan |
|---|---|---|
| `live13-api/analytics.js` | **NEW** | Server module: `/api/track`, `/api/stats`, `/api/stats/health` |
| `live13-api/public/tracker.js` | **NEW** | Client tracker (auto-load di setiap page) |
| `live13-api/public/stats.html` | **NEW** | Dashboard UI di `/stats` |
| `live13-api/public/index.html` | MODIFIED (sync dari `~/live13/`) | Tambah script tag + event hooks |
| `live13-api/server.js` | MODIFIED | Mount analytics + route `/stats` |
| `live13/index.html` | MODIFIED | Sama: tambah script tag + event hooks |

## Storage di server

- `~/live13-api/analytics-data/events-YYYY-MM-DD.jsonl` — append-only daily log
- `~/live13-api/analytics-data/sessions.json` — active session state (auto-persist 10s)

## Cara deploy ke VPS

```bash
# Di local (kalo belum di-push)
cd ~/live13-api
git add -A
git commit -m "Add live13 analytics: tracker + dashboard"
git push origin main

# Di VPS (via SSH)
cd ~/live13-api
git pull origin main
# PENTING: sync parent live13/ ke public/ (existing LIVE13 workflow)
cp ../live13/index.html public/index.html
# Restart API (PM2)
pm2 restart live13-api
# Verify
curl -s https://live13.my.id/api/stats/health
curl -s https://live13.my.id/stats
```

## Endpoints

| URL | Method | Purpose |
|---|---|---|
| `/api/track` | POST | Client beacon (auto-fired) |
| `/api/stats` | GET | JSON aggregated stats (for dashboard) |
| `/api/stats/health` | GET | Quick health/version probe |
| `/stats` | GET | Dashboard HTML (auto-refresh 5s) |
| `/tracker.js` | GET | Client tracker script (served static) |

## Events tracked (automatic)

- `page_view` — every page load
- `heartbeat` — every 30s while page is open
- `tab_hide` / `tab_show` — visibility change
- `unload` — page close
- `stream_start` — first `playing` event after page load
- `stream_pause` / `stream_resume` — player state changes
- `stream_end` — video ended
- `stream_error` — HLS fatal error (throttled 1/2s)
- `stream_buffer` — buffering events
- `channel_switch` — stream URL changed
- `mute_toggle` / `fullscreen_enter` / `pip_toggle` / `mini_player_toggle`

## Optional: Telegram bot `/stats` command

Bisa ditambahin di `@Trademonitoring1bot` — panggil `GET /api/stats`, format ringkas, kirim ke chat. Bilang aja kalo mau gw tambahin.

## Cost

- **Self-hosted** — no external service
- Disk: ~1KB per 100 events → ~5MB/bulan untuk traffic 100K event
- CPU: negligible (in-memory + append-only file)
- Memory: ~1KB per active session × concurrent viewers
