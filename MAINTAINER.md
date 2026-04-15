# FreeFuelPrice UK — Maintainer Guide

This guide covers run commands, module boundaries, feature flags, environment setup, and safe editing patterns for Comet-assisted and manual development sessions.

---

## Repositories

| Repo | Purpose |
|------|--------|
| `freefuelpriceapp/fueluk-prod-api` | Node.js backend API + ingestion pipeline |
| `freefuelpriceapp/fueluk-mobile-app` | React Native (Expo) mobile app |

---

## Backend API — Quick Commands

```bash
# Install dependencies
npm install

# Run locally (development)
node src/server.js

# Run ingestion manually (syncs fuel data from UK brand APIs)
node src/jobs/ingestRunner.js

# Run DB migrations
node src/config/migrate.js

# Run schema creation (first-time setup)
psql $DATABASE_URL -f schema.sql
```

## Environment Variables (Backend)

Copy `.env.example` to `.env` for local dev. In production, all secrets come from AWS Secrets Manager (`fuelapp/prod/db`).

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (local dev) |
| `PORT` | Server port (default 3000) |
| `JWT_SECRET` | JWT signing secret |
| `NODE_ENV` | `development` or `production` |

---

## API Endpoint Contracts

### Health
- `GET /health` → `{ status, version, db, uptime_seconds }`
- `GET /api/v1/status` → API status with version info

### Stations
- `GET /api/v1/stations/nearby?lat=&lon=&radius=&fuel_type=` → 20 nearest stations
- `GET /api/v1/stations/search?q=` → Search by name/postcode/brand
- `GET /api/v1/stations/cheapest?lat=&lon=&radius=&fuel_type=` → Cheapest stations
- `GET /api/v1/stations/:id` → Station detail

### Prices
- `GET /api/v1/prices/station/:id` → Current prices for a station
- `GET /api/v1/prices/:id/history` → Price history
- `GET /api/v1/prices/latest` → Latest prices across all stations
- `POST /api/v1/prices` → Submit user-reported price (feature-flagged)

---

## Feature Flags (Backend)

See `FEATUREFLAGS.md` for full list. All post-MVP features use environment variables.

```bash
# Enable premium (never enable at launch)
PREMIUM_ENABLED=true

# Enable community price reports (never enable at launch - needs moderation)
COMMUNITY_REPORTS_ENABLED=true
```

MVP features that are always on: core station search, nearby, price display.

---

## Module Boundaries

```
src/
  config/         — DB pool, secrets loader, migration runner
  controllers/    — HTTP layer: parse req, call service, return JSON
  services/       — Business logic, never touch req/res
  repositories/   — All SQL queries, no mock data in production
  routes/         — Express router definitions
  middleware/     — Rate limiter, auth, error handler, 404
  jobs/           — Scheduled tasks: ingestion, alerts, retention
  utils/          — Feature flags, helpers
```

**Safe editing rules:**
- Never add mock data in repository methods
- Never bypass the service layer from a controller
- Never commit secrets or real env values
- Always add new features behind a feature flag
- Run migrations before deploying schema changes

---

## Mobile App — Quick Commands

```bash
# Install
npm install

# Start Expo dev server
npx expo start

# Run on iOS simulator
npx expo run:ios

# Run on Android emulator
npx expo run:android

# Build for internal testing (EAS)
npx eas build --platform ios --profile preview
npx eas build --platform android --profile preview

# Build production
npx eas build --platform ios --profile production
npx eas build --platform android --profile production
```

## Mobile Feature Flags

See `src/lib/featureFlags.js`. MVP features are `true`. Future features are `false`.

**Never enable at launch:** `routeIntelligence`, `roadReports`, `communityContributions`, `rewards`, `monetization`.

---

## Production URLs

| Service | URL |
|---------|-----|
| API base | `https://api.freefuelpriceapp.com` |
| Health check | `https://api.freefuelpriceapp.com/health` |
| Privacy policy | `https://freefuelpriceapp.com/privacy` |
| Support | `https://freefuelpriceapp.com/support` |
| Contact email | `refurb79@gmail.com` |

---

## AWS Infrastructure

| Resource | Name |
|----------|------|
| ECS Cluster | `fuelapp-prod-cluster` |
| ECS Service | `fueluk-prod-service` |
| RDS Database | `fuelapp-prod-db` |
| Secrets | `fuelapp/prod/db` |
| ECR Repo | `fueluk-prod-api` |
| ALB | Points to `api.freefuelpriceapp.com` |
| Region | `us-east-1` |

---

## Daily Founder Checklist (End of Session)

- [ ] What files changed today?
- [ ] What now works end-to-end?
- [ ] What remains blocked?
- [ ] Did any AWS/env assumptions change?
- [ ] What is the exact next work block?

---

## Safe Comet Edit Pattern

When starting a new Comet session:
1. State which repo and file you want to edit
2. Confirm the current state before making changes
3. Make one focused change at a time
4. Always commit with a descriptive message
5. Never activate feature flags without explicit sprint approval

---

Last updated: Sprint 9 — Backend v9.0.0 | Mobile v9.0.0
