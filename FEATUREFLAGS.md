# Feature Flags — FreeFuelPrice UK

This document describes all feature flags used across the backend API and mobile app.
Feature flags control which capabilities are active at launch vs dormant for future sprints.

---

## How Feature Flags Work

### Backend (`src/utils/featureFlags.js`)

Flags are read at runtime from environment variables, falling back to safe defaults.
All non-MVP features default to `false`.

```js
const flags = require('./src/utils/featureFlags');
if (flags.isEnabled('ROUTE_INTELLIGENCE')) { ... }
```

### Mobile (`src/lib/featureFlags.js`)

Flags are defined as a static config object. Set to `true` to enable in a build.
All non-MVP flags are `false` at launch.

---

## Current Flag Registry

| Flag | Backend | Mobile | Default | Sprint | Description |
|------|---------|--------|---------|--------|--------------|
| `NEARBY_STATIONS` | ✅ | ✅ | `true` | 1 | Core nearby station list |
| `STATION_SEARCH` | ✅ | ✅ | `true` | 1 | Postcode/town search |
| `STATION_DETAIL` | ✅ | ✅ | `true` | 1 | Individual station page |
| `FUEL_FILTERS` | ✅ | ✅ | `true` | 1 | Petrol/diesel/E10 filter tabs |
| `FAVOURITES` | ✅ | ✅ | `true` | 5 | Device-local saved stations |
| `PRICE_ALERTS` | ✅ | ✅ | `true` | 4 | Price threshold push alerts |
| `PRICE_HISTORY` | ✅ | ✅ | `true` | 2 | Hourly price chart per station |
| `MAP_VIEW` | ✅ | ✅ | `true` | 6 | Map screen with station pins |
| `PREMIUM_TIER` | ✅ | ✅ | `true` | 7 | Premium subscription flow |
| `ROUTE_INTELLIGENCE` | ❌ | ❌ | `false` | Future | Route-aware fuel stop recommendations |
| `ROAD_REPORTS` | ❌ | ❌ | `false` | Future | Community hazard/traffic reports |
| `REWARDS` | ❌ | ❌ | `false` | Future | Loyalty/savings rewards programme |
| `MONETIZATION` | ❌ | ❌ | `false` | Future | In-app advertising or sponsorship |

---

## How to Enable a Feature

### Backend

In `.env` or AWS Secrets Manager:
```
FEATURE_ROUTE_INTELLIGENCE=true
```

Or via environment in ECS task definition.

### Mobile

In `src/lib/featureFlags.js`:
```js
export const FLAGS = {
  ROUTE_INTELLIGENCE: false, // change to true to enable
};
```

> **Rule:** Never activate a future feature in a launch build without an explicit sprint decision.
> All dormant features must remain invisible in app navigation and API responses.

---

## Adding a New Feature Flag

1. Add the flag to `src/utils/featureFlags.js` (backend) with `false` default.
2. Add the flag to `src/lib/featureFlags.js` (mobile) with `false` default.
3. Add a row to the table above.
4. Wrap all code for the feature in `if (flags.isEnabled('FLAG_NAME'))` guards.
5. Never wire dormant features into live navigation or route handlers.

---

## Module Ownership

Each future feature has a reserved module folder:

- `src/features/routeIntelligence/` — backend
- `src/features/roadReports/` — backend
- `src/features/rewards/` — backend
- `src/screens/RouteScreen.js` — mobile (placeholder only)

These folders exist as empty scaffolds. Do not add logic to them until the sprint explicitly activates them.

