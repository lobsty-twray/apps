# API Test Results - Part 2
Generated: Mon Mar  2 12:56:33 AM EST 2026

## benchmark-tracker (8103)

  GET http://localhost:8103/api/benchmarks → 500 | {"error":"Failed to fetch benchmarks"}
  GET http://localhost:8103/api/series → 500 | {"error":"Failed to fetch series"}
  GET http://localhost:8103/api/stats → 500 | {"error":"Failed fetch stats"}
  POST http://localhost:8103/api/benchmarks → 500 | {"error":"Failed to create benchmark"}
  (verify created)
  GET http://localhost:8103/api/benchmarks → 500 | {"error":"Failed to fetch benchmarks"}

## script-writer (8104)

  GET http://localhost:8104/api/templates → 500 | {"error":"Failed to fetch templates"}
  GET http://localhost:8104/api/scripts → 500 | {"error":"Failed to fetch scripts"}
  GET http://localhost:8104/api/stats → 500 | {"error":"Failed to get stats"}
  POST http://localhost:8104/api/scripts → 500 | {"error":"Failed to create script"}
  GET http://localhost:8104/api/scripts → 500 | {"error":"Failed to fetch scripts"}

## sponsor-manager (8105)

  GET http://localhost:8105/api/sponsors → 500 | {"error":"Failed to fetch sponsors"}
  GET http://localhost:8105/api/deals → 500 | {"error":"Failed to fetch deals"}
  GET http://localhost:8105/api/stats → 500 | {"error":"Failed to get stats"}
  POST http://localhost:8105/api/sponsors → 500 | {"error":"Failed to create sponsor"}
  GET http://localhost:8105/api/sponsors → 500 | {"error":"Failed to fetch sponsors"}
  POST http://localhost:8105/api/deals → 500 | {"error":"Failed to create deal"}
  GET http://localhost:8105/api/deals → 500 | {"error":"Failed to fetch deals"}

## content-ideas (8106)

  GET http://localhost:8106/api/ideas → 500 | {"error":"Failed to fetch ideas"}
  GET http://localhost:8106/api/stats → 500 | {"error":"Failed to get stats"}
  GET http://localhost:8106/api/search?q=test → 200 | []
  POST http://localhost:8106/api/ideas → 500 | {"error":"Failed to create idea"}
  GET http://localhost:8106/api/ideas → 500 | {"error":"Failed to fetch ideas"}

## gaming-logger (8107)

  GET http://localhost:8107/api/sessions → 500 | {"error":"Failed to fetch sessions"}
  GET http://localhost:8107/api/stats → 500 | {"error":"Failed to get stats"}
  POST http://localhost:8107/api/sessions → 500 | {"error":"Failed to create session"}
  GET http://localhost:8107/api/sessions → 500 | {"error":"Failed to fetch sessions"}

## thumbnail-analyzer (8108)

  GET http://localhost:8108/api/thumbnails → 500 | {"error":"Failed to fetch thumbnails"}
  GET http://localhost:8108/api/templates → 500 | {"error":"Failed to fetch templates"}
  GET http://localhost:8108/api/stats → 500 | {"error":"Failed to get stats"}
  POST http://localhost:8108/api/thumbnails → 500 | {"error":"Failed to create thumbnail"}
  GET http://localhost:8108/api/thumbnails → 500 | {"error":"Failed to fetch thumbnails"}

## stream-planner (8109)

  GET http://localhost:8109/api/streams → 500 | {"error":"Failed to fetch streams"}
  GET http://localhost:8109/api/upcoming → 500 | {"error":"Failed to fetch upcoming streams"}
  GET http://localhost:8109/api/stats → 500 | {"error":"Failed to get stats"}
  POST http://localhost:8109/api/streams → 500 | {"error":"Failed to create stream"}
  GET http://localhost:8109/api/streams → 500 | {"error":"Failed to fetch streams"}

## app-hub (8110)

  GET http://localhost:8110/api/health → 200 | {"https://video-pipeline.twray.dev":false,"https://script-writer.twray.dev":true,"https://youtube-studio.twray.dev":true,"https://thumbnail-analyzer.twray.dev":true,"https://content-ideas.twray.dev":t
  GET http://localhost:8110/api/search?q=test → 200 | {"results":[{"app":"Kanban Board","emoji":"📋","baseUrl":"https://board.twray.dev","items":[{"title":"Review & Polish Landing Page v14","desc":"Review twray.dev/v14/ — ensure it's polished, accura

## landing-page (8111)

  GET http://localhost:8111/ → 200 | <!DOCTYPE html> <html lang="en"> <head> <link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css"> <meta charset="UTF-8"> <meta name="viewport" content="width=device-width, initial-sca
  GET http://localhost:8111/analytics/api/data → 401 | Authentication required

## admin (8112)
No server.js found - app directory does not exist

---

## Summary

| App | Port | Status | Notes |
|-----|------|--------|-------|
| benchmark-tracker | 8103 | ❌ 500 all endpoints | DB auth failure |
| script-writer | 8104 | ❌ 500 all endpoints | DB auth failure |
| sponsor-manager | 8105 | ❌ 500 all endpoints | DB auth failure |
| content-ideas | 8106 | ❌ 500 all endpoints (search 200) | DB auth failure |
| gaming-logger | 8107 | ❌ 500 all endpoints | DB auth failure |
| thumbnail-analyzer | 8108 | ❌ 500 all endpoints | DB auth failure |
| stream-planner | 8109 | ❌ 500 all endpoints | DB auth failure |
| app-hub | 8110 | ✅ Working | health + search both 200 |
| landing-page | 8111 | ✅ Working | HTML serves; analytics needs auth (401) |
| admin | 8112 | ⚠️ No server.js | Directory does not exist (container: lobsty-admin-dashboard) |

## Root Cause

Apps 8103-8109 all fail with: `password authentication failed for user "lobsty"`

The DATABASE_URL uses password from docker-compose.yml but the PostgreSQL container likely has a different password configured. The postgres container env shows `POSTGRES_USER: komodo` which conflicts with the `lobsty` user these apps expect.

**Fix needed:** Either update the postgres password for user `lobsty` or update the DATABASE_URL passwords in docker-compose.yml to match.
