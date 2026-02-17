# 🦞 Lobsty Apps

Apps deployed on `twray.dev` via Cloudflare Tunnel.

## Apps

| App | URL | Port | Stack |
|-----|-----|------|-------|
| Todo | [todo.twray.dev](https://todo.twray.dev) | 8090 | Static |
| Board | [board.twray.dev](https://board.twray.dev) | 8091 | Node.js + SQLite |
| Budget | [budget.twray.dev](https://budget.twray.dev) | 8092 | Node.js + SQLite |
| Docs | [docs.twray.dev](https://docs.twray.dev) | 8093 | Node.js + PostgreSQL |

## Docs App

Notion-like document editor with user authentication.

### Features

- Email/password and Google OAuth login
- Rich text editor with slash commands, formatting toolbar
- Nested document tree with drag-and-drop icons
- Dark mode, keyboard shortcuts (Ctrl+K search, Ctrl+N new page)
- Per-user document isolation via JWT auth

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (optional) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (optional) |

See `docs/.env.example` for defaults.

### Architecture

```
docs/
  server.js          # Express API (auth + docs CRUD)
  public/index.html  # SPA frontend
  package.json
  Dockerfile
```

The server auto-creates the `docs` database and tables on first startup.

## CI/CD

Pushes to `main` that touch `docs/` or `docker-compose.yml` trigger automatic deployment via GitHub Actions.

### Required GitHub Secrets

| Secret | Value |
|--------|-------|
| `SSH_HOST` | `192.100.2.228` |
| `SSH_USER` | SSH username for the VM |
| `SSH_KEY` | Private SSH key for the VM |

Set these in **Settings > Secrets and variables > Actions** in the GitHub repo.

## Manual Deploy

```bash
# Deploy everything
cd ~/apps
docker compose up -d --build

# Deploy only docs
docker compose up -d --build docs

# View logs
docker logs -f lobsty-docs
```
