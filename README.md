# FreeFuelPrice UK — Backend API

> Route-aware UK fuel price API powering the FreeFuelPrice iOS & Android app.

[![Node.js](https://img.shields.io/badge/Node.js-20-green)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-PostGIS-blue)](https://postgis.net)
[![AWS ECS](https://img.shields.io/badge/Deploy-AWS%20ECS-orange)](https://aws.amazon.com/ecs)

---

## Overview

This is the production backend API for FreeFuelPrice UK. It ingests live fuel price data from major UK supermarket and fuel brand feeds, stores it in a PostGIS-enabled PostgreSQL database, and exposes a RESTful API consumed by the mobile app.

**API Base URL:** `https://api.freefuelprice.co.uk`

---

## Architecture

```
GitHub → AWS CodePipeline → CodeBuild → ECR → ECS Fargate
                                              ↓
                                       RDS PostgreSQL (PostGIS)
                                              ↓
                                       AWS Secrets Manager
```

---

## API Endpoints

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health, DB status, version, uptime |

### Stations
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/stations/nearby` | Stations near lat/lng (radius, fuel_type filter) |
| GET | `/api/v1/stations/search` | Search by postcode, town, or name |
| GET | `/api/v1/stations/:id` | Single station with full price detail |
| GET | `/api/v1/stations/cheapest` | Cheapest stations near a location |

### Prices
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/prices/station/:id` | Price records for a station |
| POST | `/api/v1/prices/submit` | Submit a crowd-sourced price |
| GET | `/api/v1/prices/latest` | Latest submitted prices |

### Meta
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/meta/status` | Ingestion status and data freshness |
| GET | `/api/v1/meta/ingestion-runs` | Recent ingestion run history |

### Alerts
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/alerts` | Create price threshold alert |
| GET | `/api/v1/alerts` | Get alerts for a device token |
| DELETE | `/api/v1/alerts/:id` | Delete an alert |

### Favourites
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/favourites` | Get favourites for device token |
| POST | `/api/v1/favourites` | Add a favourite station |
| DELETE | `/api/v1/favourites/:id` | Remove a favourite |

### Premium
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/premium/register` | Register premium subscription |
| GET | `/api/v1/premium/status` | Check premium status |
| POST | `/api/v1/premium/cancel` | Cancel subscription |

---

## Local Development

### Prerequisites
- Node.js 20+
- PostgreSQL 14+ with PostGIS extension
- AWS CLI (for Secrets Manager in production)

### Setup

```bash
git clone https://github.com/freefuelpriceapp/fueluk-prod-api.git
cd fueluk-prod-api
npm install
cp .env.example .env
# Edit .env with your local DB credentials
node src/server.js
```

### Environment Variables

See `.env.example` for all required variables. In production, DB credentials are loaded from AWS Secrets Manager.

---

## Deployment

See `DEPLOYMENT.md` for the full AWS infrastructure setup guide.

Deployment pipeline:
1. Push to `main` branch
2. CodePipeline triggers CodeBuild
3. Docker image built and pushed to ECR
4. ECS service updated with new image definition

---

## Background Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `govFuelData` (ingest) | Every 4 hours | Fetches live prices from 15 UK brand feeds |
| `ingestRunner` | On startup | Immediate first sync |
| `alertJob` | Every 30 min | Checks price thresholds, sends Expo push notifications |
| `retentionJob` | Nightly 2am | Purges `price_history` older than 90 days |

---

## Data Sources

Fuel prices are fetched from official brand JSON feeds including: Applegreen, Asda, BP, Co-op, Esso, JET, Morrisons, Moto, Motor Fuel Group, Rontec, Sainsbury's, SGN, Shell, Tesco.

---

## Feature Flags

See `FEATUREFLAGS.md` for the full flag registry. All non-MVP features are disabled at launch.

---

## Tech Stack

- **Runtime:** Node.js 20 (Alpine Docker)
- **Framework:** Express.js
- **Database:** PostgreSQL + PostGIS (AWS RDS)
- **Auth:** Device token (anonymous, no account required)
- **Notifications:** Expo Push Notification Service
- **Infrastructure:** AWS ECS Fargate, ECR, RDS, Secrets Manager, CodePipeline
- **Rate Limiting:** express-rate-limit (100 req/15min per IP)

---

## Licence

Private — FreeFuelPrice UK. All rights reserved.
