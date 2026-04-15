# Launch Checklist — FreeFuelPrice UK

A comprehensive pre-launch checklist for the FreeFuelPrice UK app and backend API.
Track each item before going live on the App Store and Google Play.

---

## 🔧 Backend API

### Infrastructure

- [x] ECS Fargate cluster is running (`fuelapp-prod-cluster`)
- [x] ECS service healthy (`fueluk-prod-service`)
- [x] RDS PostgreSQL instance running with PostGIS enabled
- [x] AWS Secrets Manager secret `fuelapp/prod/db` populated with all env vars
- [x] ECR repository exists and latest image pushed
- [x] CodePipeline connected to GitHub `main` branch
- [x] ALB (Application Load Balancer) configured with HTTPS
- [x] ACM SSL certificate `*.freefuelpriceapp.com` issued and attached to ALB
- [x] Domain `api.freefuelpriceapp.com` pointing to ALB

### API Health

- [x] `GET /health` returns `{ status: "ok", version: "9.0.0" }` — confirmed healthy, db connected
- [x] `GET /api/v1/stations/nearby` returns stations within radius — returns 20 stations with prices
- [ ] `GET /prices` returns current fuel prices — price_reports table empty (user-submitted prices)
- [ ] `POST /device/register` registers device token successfully
- [ ] `POST /notifications/subscribe` subscribes to price alerts
- [x] Rate limiting active (100 req/15min per IP)

### Database

- [x] All migrations applied (`node src/db/migrate.js`)
- [x] `stations` table populated with UK fuel stations (2842+ stations)
- [ ] `prices` table populated with current prices
- [x] PostGIS spatial indexes active
- [ ] `premium_users` table created

### Security

- [x] JWT_SECRET set to strong random value
- [x] CORS configured to allow only app origins
- [x] Rate limiter enabled in production
- [x] No sensitive values in source code or logs
- [x] Helmet.js security headers enabled

---

## 📱 Mobile App (iOS)

### Build & Configuration

- [x] `app.json` version set to `9.0.0`
- [x] `eas.json` configured for production build (development/preview/production profiles)
- [x] Bundle identifier: `com.freefuelpriceapp.uk`
- [x] API base URL pointing to `https://api.freefuelpriceapp.com`
- [ ] Push notification entitlements configured
- [x] Location permissions strings set (NSLocationWhenInUseUsageDescription)

### App Store Submission

> ⚠️ **Action needed:** Fill in `eas.json` submit placeholders: `YOUR_APPLE_ID@email.com`, `YOUR_APP_STORE_CONNECT_APP_ID`, `YOUR_APPLE_TEAM_ID`

- [ ] Apple Developer account active
- [ ] App registered in App Store Connect
- [ ] Production build created via `eas build --platform ios --profile production`
- [ ] Build uploaded to App Store Connect via `eas submit`
- [ ] App icon (1024x1024 PNG, no alpha) uploaded
- [ ] Screenshots uploaded for all required device sizes
- [ ] App description, keywords, category filled in
- [ ] Privacy policy URL provided
- [ ] Age rating completed
- [ ] App submitted for review

---

## 🤖 Mobile App (Android)

### Build & Configuration

- [x] `app.json` Android package: `com.freefuelpriceapp.uk`
- [ ] Keystore generated and stored securely
- [ ] Google Maps API key configured (if used)
- [x] Location permissions declared in `app.json` (ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION)

### Google Play Submission

> ⚠️ **Action needed:** Add `google-service-account.json` to repo root before submitting Android

- [ ] Google Play Developer account active
- [ ] App created in Google Play Console
- [ ] Production build created via `eas build --platform android --profile production`
- [ ] AAB (Android App Bundle) uploaded
- [ ] Store listing completed (title, description, screenshots)
- [ ] Content rating questionnaire completed
- [ ] Privacy policy URL provided
- [ ] App submitted for review

---

## 📊 Monitoring & Observability

- [x] CloudWatch Log Group `/ecs/fueluk-prod-api` active
- [x] CloudWatch Alarm for high error rate (`fueluk-prod-5xx-errors` — 5xx > 0)
- [x] CloudWatch Alarm for high latency (p99 > 2s) (`fueluk-prod-alb-p99-latency-high` — p99 > 2s)
- [x] CloudWatch Alarm for ECS high CPU (`fueluk-prod-ecs-cpu-high` — CPU > 80%)
- [x] Uptime monitor configured (e.g. UptimeRobot or AWS Route53 health check)
- [x] Error alerting to email configured (SNS topic: FuelApp-Prod-Alerts → refurb79@gmail.com)

---

## 🔑 Feature Flags (MVP)

All features below must be `enabled: false` at launch unless MVP:

- [x] `ROUTE_AWARE_PRICING` — disabled (post-MVP, env var not set)
- [x] `PREMIUM_SUBSCRIPTIONS` — disabled (post-MVP, env var not set)
- [x] `PRICE_ALERTS` — disabled (post-MVP, env var not set)
- [x] `COMMUNITY_REPORTS` — disabled (post-MVP, env var not set)
- [x] `REWARDS` — disabled (post-MVP, env var not set)
- [x] `MONETIZATION` — disabled (post-MVP, env var not set)
- [x] Core station search — ENABLED (MVP)
- [x] Core price display — ENABLED (MVP)
- [x] Device registration — ENABLED (MVP)

---

## 📝 Legal & Compliance

- [ ] Privacy policy published at public URL
- [ ] Terms of service published at public URL
- [ ] GDPR compliance reviewed (UK data only, anonymised device IDs)
- [ ] App Store privacy nutrition labels completed
- [ ] Google Play data safety section completed

---

## 🚀 Go / No-Go Sign-Off

| Area | Status | Owner |
|------|--------|-------|
| Backend API | ✅ Infrastructure live, API healthy, DB connected , CodePipeline ✅| Dev |
| iOS App | 🟡 Config verified, build not yet triggered | Dev |
| Android App | 🟡 Config verified, build not yet triggered | Dev |
| Database | ✅ Connected, 2842+ stations populated | Dev |
| Monitoring | ✅ CloudWatch alarms (5xx, ECS-CPU, p99) ✅ | Log Group ✅ | CodePipeline ✅ | Uptime monitor (Route53) ✅ | Dev |
| Legal | ❓ Pending | Founder |
| App Store | ❓ Pending | Founder |

Launch Date Target: TBD

---

Last updated: Sprint 10 – Sprint 1 closure ✅ | ECS deployment live ✅ | API verified (health, nearby, cheapest) ✅ | Feature flags MVP-safe ✅ | Mobile shell launch-safe ✅ | DB-backed, no mocks ✅ | Email corrected refurb79@gmail.com ✅ | Next: App Store / Google Play submission
