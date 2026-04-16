# Sprint 1 — Definition of Done Evidence Report

**Audit date:** 2026-04-16
**Auditor:** Agent session (automated verification)
**Scope:** Sprint 1 MVP — product-core execution

---

## Summary

| Status | Count |
|--------|-------|
| Complete | 8 |
| Partial | 1 |
| Blocked | 0 |
| Assumed | 1 |

---

## COMPLETE

### 1. Backend API deployed to production (ECS)
- Cluster: `fueluk-prod` / Service: `fueluk-api` stable on task def rev29.
- Deployment `IG0pntFD-SIZU` rolled out rev17 with race-condition fix, Tesco UA headers, Sainsbury's filter, per-row error handling.
- Health endpoint: `GET /api/v1/meta/last-updated` returns `{"status":"ok","last_updated":"2026-04-16T20:21:50.843Z"}`.

### 2. Real station data in production DB
- `GET /api/v1/stations/nearby?lat=51.5074&lon=-0.1278&radius=5` returns 20 stations with real brands (Tesco, Sainsbury's, Esso, BP, Asda, Applegreen, MFG), postcodes, lat/lon, petrol/diesel/e10 prices, and fresh `last_updated` timestamps.
- CloudWatch logs confirm scheduled sync ingested 3,910 stations; AlertJob cron running.

### 3. Core endpoints live
- `/api/v1/stations/nearby` — geo query, 200 OK, real data.
- `/api/v1/prices/latest` — 200 OK.
- `/api/v1/prices/station/:id` — 200 OK.
- `/api/v1/search?q=tesco` — 200 OK.
- `/api/v1/meta/last-updated` — 200 OK.
- `/api/v1/alerts/:token` — reachable (feature-flagged off in client).

### 4. Feature-flag system in place (guardrails)
- `src/utils/featureFlags.js`: MVP flags (`nearby_stations`, `station_search`, `station_detail`, `fuel_freshness`, `favourites_local`) hard-coded `true`.
- Non-MVP (`price_alerts`, `community_reports`, `route_intelligence`, `rewards_system`, `premium_tier`, `monetization`) env-gated and disabled by default.
- Matches master-doc directive: "Never activate community_reports, route_intelligence, rewards_system, price_alerts, premium_tier in launch builds."

### 5. Mobile app shell wired
- `App.js` uses `NavigationContainer` + `createBottomTabNavigator` + `createNativeStackNavigator`.
- Screens registered: Home, StationDetail, Search, Favourites, Alerts, Settings, Map, Premium (latter two/three gated).
- Expo config (`app.json`) includes iOS `UIBackgroundModes: ["remote-notification"]` entitlement; Android keystore & Maps keys wired.

### 6. Repo hygiene
- `.gitignore` added (commit `20ad705`).
- `LAUNCH_CHECKLIST.md` Day-1 & Day-2 columns ticked with sign-off (commits `0ac8da2`, `5f7b3f5`, `f0ca3aa`).

### 7. GDPR review
- Privacy review line-ticked in LAUNCH_CHECKLIST; no PII stored server-side; alerts use opaque device tokens only.

### 8. Build configuration
- `eas.json` production/preview profiles present.
- `STORE_METADATA.md` populated for iOS & Android store listings.

---

## PARTIAL

### Mobile feature-flag parity
- API feature-flag module verified. Mobile client is expected to mirror flags via `src/config/featureFlags.js`, but that path returns 404 on raw.githubusercontent.com at time of audit.
- **Action:** Confirm mobile-side flag module path (may live under `src/utils/` or `src/lib/` in the mobile repo) before Day-3 submission so gated screens (Premium, Alerts) cannot render in launch build.

---

## ASSUMED

### End-to-end device smoke test
- API endpoints proven live and returning correct shape; shell navigation present in `App.js`.
- No screenshot/recording captured of a physical device rendering StationDetailScreen against live prod data during this audit session.
- **Assumption:** prior Day-2 manual smoke test covered this; recommend one more TestFlight / internal-track build walkthrough before Day-3 store submission.

---

## BLOCKED

None.

---

## Sprint 1 DoD verdict

**PASS with one partial + one assumed item to close before Day-3 store submission.**

Day-1 (Backend) and Day-2 (Mobile shell + entitlements) are signed off in `LAUNCH_CHECKLIST.md`. Proceed to Day-3: resolve mobile feature-flag path, capture device smoke evidence, then package store submission.
