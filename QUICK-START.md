# 🚀 Quick Start Guide - Ray's Content Creator Apps

All apps are now running on your Lobsty VM and accessible at `192.100.2.228:<port>`

## What Got Built

| App | Port | Purpose | Key Features |
|-----|------|---------|--------------|
| 📺 YouTube Studio | 8099 | Video pipeline tracker | Idea → Edit → Publish workflow, stats, CRUD |
| 🖥️ Hardware Monitor | 8100 | Real-time system stats | CPU, GPU, memory, network, storage, temps |
| 🎥 Gear Inventory | 8101 | Tech/camera catalog | Track cameras, lenses, displays, 3D printers |
| 📊 Benchmark Tracker | 8103 | Performance testing | Log scores, track trends, compare hardware |
| ✍️ Script Writer | 8104 | Script management | Templates, word count, version history |
| 💰 Sponsor Manager | 8105 | Deal tracking | Sponsors, deliverables, payments, revenue |
| 💡 Content Ideas | 8106 | Brainstorming board | Kanban workflow, categories, priority |
| 🎮 Gaming Logger | 8107 | Gaming sessions | Track games, extract content ideas |

## Accessing the Apps

**From your machine (on LAN):**
```
http://192.100.2.228:8099
http://192.100.2.228:8100
... and so on
```

**Via Cloudflare Tunnel (from anywhere):**
```bash
bash scripts/cf-tunnel.sh add youtube-studio 8099 http 192.100.2.228
bash scripts/cf-tunnel.sh add hardware-monitor 8100 http 192.100.2.228
bash scripts/cf-tunnel.sh add benchmark-tracker 8103 http 192.100.2.228
bash scripts/cf-tunnel.sh add script-writer 8104 http 192.100.2.228
bash scripts/cf-tunnel.sh add sponsor-manager 8105 http 192.100.2.228
bash scripts/cf-tunnel.sh add content-ideas 8106 http 192.100.2.228
bash scripts/cf-tunnel.sh add gaming-logger 8107 http 192.100.2.228
```

## Database Info

- **Host:** `192.100.2.228:5432`
- **User:** `lobsty`
- **Password:** `***REMOVED***`
- **8 new databases:** one per app

## Managing the Apps

**Start/stop all:**
```bash
cd ~/apps
docker compose up -d           # Start all
docker compose down            # Stop all
docker compose up -d --build   # Rebuild after code changes
```

**View logs:**
```bash
docker compose logs -f youtube-studio
docker compose logs -f <app-name>
```

## Next Steps

1. **Test each app** - Visit each port
2. **Add sample data** - Try creating ideas, logging sessions, etc.
3. **Set up Cloudflare routes** - Make accessible from anywhere
4. **Customize UI** - Adjust colors, logos, terminology
5. **Add integrations** - YouTube API, Stripe, Discord webhooks

## Key Files

- `docker-compose.yml` - All services defined
- `~/apps/<app-name>/server.js` - Backend
- `~/apps/<app-name>/public/index.html` - Frontend
- `OVERNIGHT-BUILD-LOG.md` - Full build details
- `QUICK-START.md` - This file

## Troubleshooting

**App won't start:**
```bash
docker compose logs <app-name>
```

**Reset database:**
```bash
docker exec lobsty-postgres psql -U lobsty -d lobsty_main -c "DROP DATABASE <app_name>;"
docker compose restart <app-name>
```

---

**Built by Lobsty:** 2026-02-19, 5AM-8AM EST 🚀
