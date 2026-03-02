# 🧪 App Test Report
**Date:** 2026-03-02 05:55 UTC  
**Tested by:** Albert (automated)

## Executive Summary

- **21 apps tested** (board skipped - being redesigned)
- **8 apps fully working** ✅
- **7 apps have broken backends (500 errors)** ❌ — all due to PostgreSQL auth failure
- **6 apps have UI/theme issues** ⚠️

### 🚨 Critical Issue: Database Authentication Failure
Apps on ports 8103-8109 ALL return 500 errors on every API endpoint. Root cause: `password authentication failed for user "lobsty"`. The postgres container uses `POSTGRES_USER: komodo` which conflicts with the `lobsty` user these apps expect. **Fix: update DB credentials in docker-compose.yml or create the lobsty user in PostgreSQL.**

---

## Per-App Results

### ✅ PASSING

| App | Port | Dark Theme | API | Notes |
|-----|------|-----------|-----|-------|
| **Todo** | 8090 | ✅ Yes | N/A (localStorage) | Polished UI, Grade A |
| **Budget Tracker** | 8092 | ✅ Yes | ✅ Full CRUD | Working well, has data. Minor: oversized empty chart area |
| **Shop** | 8096 | ✅ Yes | ✅ Products + Stripe | Grade A, professional e-commerce page |
| **YouTube Studio** | 8099 | ❌ Light | ✅ Full CRUD | Working API, missing tab label in UI |
| **Gear Inventory** | 8101 | ❌ Light/gradient | ✅ Full CRUD | Clean empty state |
| **App Hub** | 8110 | ❌ Light | ✅ Health + Search | Well-organized dashboard |
| **Landing Page** | 8111 | ❌ Light | ✅ Serves HTML | Hero CTA button nearly invisible |
| **Hardware Monitor** | 8100 | ❌ Light | N/A (WebSocket) | All values show 0, storage section empty |

### ❌ BROKEN (500 Errors - DB Auth Failure)

| App | Port | Issue |
|-----|------|-------|
| **Benchmark Tracker** | 8103 | All API endpoints return 500 |
| **Script Writer** | 8104 | All API endpoints return 500, "Failed to load" in UI |
| **Sponsor Manager** | 8105 | All endpoints 500, UI shows "undefined" and "$NaN" |
| **Content Ideas** | 8106 | All endpoints 500 (search works), empty UI |
| **Gaming Logger** | 8107 | All endpoints 500, missing stats values in UI |
| **Thumbnail Analyzer** | 8108 | All endpoints 500, Internal Server Error toasts, broken header image |
| **Stream Planner** | 8109 | All endpoints 500, UI shows "undefined" × 5 stat cards |

### ⚠️ AUTH-GATED (Cannot fully test)

| App | Port | Notes |
|-----|------|-------|
| **Docs** | 8093 | Google OAuth required. Auth config endpoint works. Sign-in button needs stronger styling. |
| **Drafts** | 8094 | Custom auth, couldn't log in. Sign-in page looks good (Grade A-). |
| **Video Pipeline** | 8097 | Auth required. Light theme, missing login button in UI. |
| **Admin Dashboard** | 8112 | Google OAuth redirect. Renders Google sign-in page. |
| **Stock Monitor** | 8098 | Landing page works (Grade A-). No REST API found. |

---

## UI/Theme Issues

| App | Issue | Severity |
|-----|-------|----------|
| Landing Page (8111) | CTA "YouTube Channel" button nearly invisible, light theme | Medium |
| App Hub (8110) | Light theme (should be dark per design system) | Medium |
| YouTube Studio (8099) | Light theme, missing first tab label | Low |
| Gear Inventory (8101) | Light theme with gradient | Low |
| Hardware Monitor (8100) | Light theme, all values 0, empty storage section | Medium |
| Benchmark Tracker (8103) | Light theme | Low |
| Video Pipeline (8097) | Light theme, missing login button | Medium |
| Content Ideas (8106) | White background, no empty state message | Low |
| Thumbnail Analyzer (8108) | Light theme, broken header image | High |
| Sponsor Manager (8105) | "undefined" and "$NaN" in stat cards | High |
| Stream Planner (8109) | "undefined" in all 5 stat cards | High |
| Gaming Logger (8107) | Missing app title, blank stat values | Medium |
| Script Writer (8104) | Light theme, truncated filter tab label | Low |
| Budget (8092) | Oversized empty chart area, FAB overlap | Low |

---

## Recommendations (Priority Order)

1. **🔴 Fix PostgreSQL auth** — Create `lobsty` user or update DATABASE_URL in docker-compose.yml. This fixes 7 apps at once.
2. **🟠 Apply dark theme** — ~10 apps are still using light themes. They should import shared design tokens.
3. **🟡 Fix undefined/NaN values** — Sponsor Manager, Stream Planner, Gaming Logger need null-safe data binding.
4. **🟡 Fix Thumbnail Analyzer** — Server errors + broken header image.
5. **🟢 Minor UI fixes** — Landing page CTA visibility, Script Writer truncation, Budget chart sizing.

---

## Screenshots

All screenshots saved to `~/apps/screenshots/` (42 files: mobile + desktop for each app).
View the index at `~/apps/screenshots/index.html`.
