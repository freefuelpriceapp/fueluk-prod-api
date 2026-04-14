# Deployment Guide — FreeFuelPrice UK Backend API

## Overview

This document covers the full deployment pipeline for the `fueluk-prod-api` backend service on AWS ECS Fargate via AWS CodePipeline.

---

## Architecture

```
GitHub (main branch)
    └── AWS CodePipeline
            ├── Source: GitHub webhook
            ├── Build: AWS CodeBuild (buildspec.yml)
            │       ├── Docker image built
            │       └── Pushed to AWS ECR
            └── Deploy: ECS Fargate (rolling update)
                    └── Task pulls image from ECR
                            └── Connects to RDS PostgreSQL (PostGIS)
```

---

## Prerequisites

- AWS account with ECS, ECR, RDS, Secrets Manager, CodePipeline, CodeBuild permissions
- Docker installed locally (for local testing)
- Node.js 20+
- PostgreSQL client (psql) for DB migrations
- AWS CLI configured

---

## Environment Variables

All secrets are stored in **AWS Secrets Manager** under the secret name `fuelapp/prod/db`.

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (PostGIS-enabled RDS) |
| `JWT_SECRET` | Secret for signing device tokens |
| `EXPO_ACCESS_TOKEN` | Expo push notification token |
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | Set to `production` |

See `.env.example` for local development template.

---

## Local Development

```bash
# 1. Clone repository
git clone https://github.com/freefuelpriceapp/fueluk-prod-api.git
cd fueluk-prod-api

# 2. Install dependencies
npm install

# 3. Copy environment template
cp .env.example .env
# Fill in your local values

# 4. Run database migrations
node src/db/migrate.js

# 5. Start development server
npm run dev

# Server runs at http://localhost:3000
```

---

## Docker Build (Local)

```bash
# Build image
docker build -t fueluk-prod-api .

# Run container
docker run -p 3000:3000 --env-file .env fueluk-prod-api
```

---

## AWS Deployment Pipeline

### 1. ECR — Container Registry

```bash
# Authenticate Docker with ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Tag and push image
docker tag fueluk-prod-api:latest <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/fueluk-prod-api:latest
docker push <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/fueluk-prod-api:latest
```

### 2. CodePipeline

Pipeline is triggered automatically on push to `main` branch.

Stages:
1. **Source** — GitHub webhook pulls latest commit
2. **Build** — CodeBuild runs `buildspec.yml`:
   - Installs dependencies
   - Runs tests
   - Builds Docker image
   - Pushes to ECR
3. **Deploy** — ECS Fargate rolling deployment
   - New task definition registered
   - Old tasks drained and replaced

### 3. ECS Fargate

- **Cluster**: `fuelapp-prod-cluster`
- **Service**: `fueluk-prod-service`
- **Task Definition**: `fueluk-prod-api`
- **Region**: `us-east-1` (N. Virginia)
- **CPU/Memory**: 256 CPU / 512 MB (scalable)

---

## Database Migrations

Migrations are run manually before deploying breaking schema changes:

```bash
# Connect to RDS via bastion or local tunnel
DATABASE_URL=<production_url> node src/db/migrate.js
```

Schema file: `schema.sql`

---

## Health Check

ECS uses the following health check:

```
GET /health
```

Expected response:
```json
{
  "status": "ok",
  "version": "9.0.0",
  "uptime": 12345
}
```

---

## Rollback

To roll back to a previous deployment:

1. Navigate to ECS → Services → `fueluk-prod-service`
2. Click **Update service**
3. Select previous task definition revision
4. Click **Update**

Or via CLI:
```bash
aws ecs update-service \
  --cluster fuelapp-prod-cluster \
  --service fueluk-prod-service \
  --task-definition fueluk-prod-api:<PREVIOUS_REVISION>
```

---

## Monitoring

- **CloudWatch Logs**: `/ecs/fueluk-prod-api`
- **CloudWatch Metrics**: ECS CPU, Memory, ALB request count
- **Alerts**: Configure CloudWatch Alarms for error rate thresholds

---

## Domain & SSL

- **Domain**: `api.freefuelpriceapp.com`
- **SSL**: AWS ACM certificate `*.freefuelpriceapp.com` (auto-renewing, already issued)
- **Load Balancer**: ALB `fueluk-prod-alb` with HTTPS listener (port 443) → HTTP target (port 3000)
- **DNS**: CNAME `api.freefuelpriceapp.com` → `fueluk-prod-alb-739489501.us-east-1.elb.amazonaws.com`

---

## Rate Limiting

Production rate limit: **100 requests / 15 minutes per IP** (via `express-rate-limit`).

Adjust in `src/middleware/rateLimiter.js` if required.

---

*Last updated: Sprint 9 — Domain corrected to freefuelpriceapp.com*
