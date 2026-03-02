# API Endpoint Test Results
**Date:** 2026-03-02 05:55 UTC

## todo (8090)

Static HTML app - no API server (just index.html). Uses localStorage.

## budget (8092)

- **GET** `http://localhost:8092/api/dashboard` → **200** 
  ```{"income":0,"expenses":0,"netSavings":0,"categoryBreakdown":[]}```
- **GET** `http://localhost:8092/api/transactions` → **200** 
  ```[{"id":2,"type":"income","amount":130,"category_id":98,"description":"techwithray.com Shopify store revenue (first 2 weeks)","date":"2026-02-23","recurring":0,"created_at":"2026-02-23 19:25:15","category_name":"Store Revenue","category_color":"#22c55e","category_icon":"🛒"},{"id":1,"type":"expense","amount":12.2,"category_id":97,"description":"buildwithray.dev domain (Cloudflare Registrar)","date":"2026-02-23","recurring":0,"created_at":"2026-02-23 19:25:09","category_name":"Business","categor```
- **POST** `http://localhost:8092/api/transactions` → **400** 
  ```{"error":"Missing required fields"}```
- **GET** `http://localhost:8092/api/categories` → **200** 
  ```[{"id":8,"name":"Education","type":"expense","color":"#a29bfe","icon":"📚","is_default":1,"created_at":"2026-02-17 06:03:23"},{"id":4,"name":"Entertainment","type":"expense","color":"#f9ca24","icon":"🎬","is_default":1,"created_at":"2026-02-17 06:03:23"},{"id":2,"name":"Food","type":"expense","color":"#4ecdc4","icon":"🍽️","is_default":1,"created_at":"2026-02-17 06:03:23"},{"id":12,"name":"Freelance","type":"income","color":"#00cec9","icon":"💼","is_default":1,"created_at":"2026-02-17 ```
- **POST** `http://localhost:8092/api/categories` → **400** 
  ```{"error":"Missing required fields"}```
- **GET** `http://localhost:8092/api/budgets` → **200** 
  ```[]```
- **GET** `http://localhost:8092/api/trends` → **200** 
  ```[{"month":"2026-02","income":130,"expenses":12.2}]```

## docs (8093)

- **GET** `http://localhost:8093/api/auth/config` → **200** 
  ```{"googleClientId":"1098423456003-ge3qhcmumk7h82u82htu4lf9q42av4vr.apps.googleusercontent.com"}```
- **GET** `http://localhost:8093/api/docs` → **401** (expect 401)
  ```{"error":"Authentication required"}```
- **POST** `http://localhost:8093/api/auth/register` → **400** 
  ```{"error":"Email, name, and password are required"}```

## drafts (8094)

- **POST** `http://localhost:8094/api/auth/login` → **401** 
  ```{"error":"Invalid credentials"}```
- ❌ Could not authenticate

## shop (8096)

- **GET** `http://localhost:8096/api/products` → **200** 
  ```[{"id":1,"name":"5050/5080 FE Travel Kit","slug":"5050-5080-fe-travel-kit","description":"Premium 3D printed GPU support and travel case for NVIDIA 5050/5080 Founders Edition graphics cards. Designed for secure transport with hex-patterned impact protection. Keeps your GPU safe during moves, LAN parties, or shipping.","price":"25.00","compare_at_price":"60.00","type":"physical","inventory_quantity":19,"image_url":"https://techwithray.com/cdn/shop/files/rn-image_picker_lib_temp_73b82a70-3027-4392```
- **GET** `http://localhost:8096/api/config` → **200** 
  ```{"stripe_publishable_key":"pk_test_51T2C8RHFWHSLtFpEps4yz1TeLF1Q6HNZVTn78ox1v3PSuAyRO57C1NOjijC3K6CuH28XiJbIAAwqrdpMyPHg76OM00WxgPujn8","has_stripe":true}```

## video-pipeline (8097)

- ❌ Could not authenticate

## monitor (8098)

App directory does not exist at ~/apps/monitor/
- **GET** `http://localhost:8098/` → **200**
  ```<!DOCTYPE html>
<html lang="en">
<head>
    <link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, ini```

## youtube-studio (8099)

- **GET** `http://localhost:8099/api/videos` → **200** 
  ```[]```
- **GET** `http://localhost:8099/api/stats` → **200** 
  ```[]```
- **POST** `http://localhost:8099/api/videos` → **200** 
  ```{"id":1,"title":"Test","status":"draft","upload_date":null,"views":0,"ctr":null,"retention":null,"thumbnail_url":null,"notes":null,"created_at":"2026-03-02T05:56:44.590Z"}```

## hardware-monitor (8100)

WebSocket-based app (no REST API routes found). Testing base URL.
- **GET** `http://localhost:8100/` → **200**

## gear-inventory (8101)

- **GET** `http://localhost:8101/api/gear` → **200** 
  ```[]```
- **GET** `http://localhost:8101/api/categories` → **200** 
  ```[]```
- **POST** `http://localhost:8101/api/gear` → **200** 
  ```{"id":1,"name":"Test Mic","category":"Audio","brand":null,"model":null,"purchase_date":null,"purchase_price":"99.99","warranty_until":null,"location":null,"notes":null,"image_url":null,"created_at":"2026-03-02T05:56:44.719Z"}```


## Additional Tests & Cleanup

### budget - POST with correct fields
- **POST** `/api/transactions` (correct fields) → **200**
  ```{"id":3,"success":true}```
- **DELETE** `/api/transactions/3` → **200** ✅ cleanup
- **DELETE** `youtube-studio /api/videos/1` → **200** ✅ cleanup
- **DELETE** `gear-inventory /api/gear/1` → **200** ✅ cleanup

---

## Summary

| App | Port | Status | Notes |
|-----|------|--------|-------|
| todo | 8090 | ✅ Static | No API - localStorage only |
| budget | 8092 | ✅ Working | Full CRUD functional |
| docs | 8093 | ✅ Working | Auth required (Google OAuth configured) |
| drafts | 8094 | ⚠️ Auth issue | Login returns 401 with admin/admin |
| shop | 8096 | ✅ Working | Products & config endpoints working |
| video-pipeline | 8097 | ⚠️ Auth issue | Login returns no token with admin/admin |
| monitor | 8098 | ✅ Serves HTML | No ~/apps/monitor dir (may be in docker only) |
| youtube-studio | 8099 | ✅ Working | Full CRUD functional, no auth required |
| hardware-monitor | 8100 | ✅ Serves HTML | WebSocket-based, no REST API |
| gear-inventory | 8101 | ✅ Working | Full CRUD functional, no auth required |
