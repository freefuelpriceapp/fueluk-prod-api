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
- [ ] CodePipeline connected to GitHub `main` branch
- [x] ALB (Application Load Balancer) configured with HTTPS
- [x] ACM SSL certificate `*.freefuelpriceapp.com` issued and attached to ALB
- [x] Domain `api.freefuelpriceapp.com` pointing to ALB

### API Health

- [x] `GET /health` returns `{ status: "ok", version: "9.0.0" }`
- [x] `GET /stations/nearby` returns stations within radius
- [ ] `GET /prices` returns current fuel prices
- [ ] `POST /device/register` registers device token successfully
- [ ] `POST /notifications/subscribe` subscribes to price alerts
- [x] Rate limiting active (100 req/15min per IP)

### Database

- [x] All migrations applied (`node src/db/migrate.js`)
- [x] `stations` table populated with UK fuel stations
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

- [ ] `app.json` version set to `9.0.0`
- [ ] `eas.json` configured for production build
- [ ] Bundle identifier: `com.freefuelpriceapp.uk`
- [x] API base URL pointing to `https://api.freefuelpriceapp.com`
- [ ] Push notification entitlements configured
- [ ] Location permissions strings set (NSLocationWhenInUseUsageDescription)

### App Store Submission

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

- [ ] `app.json` Android package: `com.freefuelpriceapp.uk`
- [ ] Keystore generated and stored securely
- [ ] Google Maps API key configured (if used)
- [ ] Location permissions declared in `app.json`

### Google Play Submission

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

- [ ] CloudWatch Log Group `/ecs/fueluk-prod-api` active
- [ ] CloudWatch Alarm for high error rate (5xx > 5%)
- [ ] CloudWatch Alarm for high latency (p99 > 2s)
- [ ] CloudWatch Alarm for ECS service unhealthy tasks
- [ ] Uptime monitor configured (e.g. UptimeRobot or AWS Route53 health check)
- [ ] Error alerting to email/Slack configured

---

## 🔑 Feature Flags (MVP)

All features below must be `enabled: false` at launch unless MVP:

- `ROUTE_AWARE_PRICING` — disabled (post-MVP)
- `PREMIUM_SUBSCRIPTIONS` — disabled (post-MVP)
- `PRICE_ALERTS` — disabled (post-MVP)
- `FAVOURITE_STATIONS` — disabled (post-MVP)
- `TRIP_COST_CALCULATOR` — disabled (post-MVP)
- `COMMUNITY_REPORTS` — disabled (post-MVP)
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
| Backend API | ✅ Infrastructure live, API healthy | Dev |
| iOS App | ❓ Pending | Dev |
| Android App | ❓ Pending | Dev |
| Database | ✅ Connected, stations populated | Dev |
| Monitoring | ❓ Pending | Dev |
| Legal | ❓ Pending | Founder |
| App Store | ❓ Pending | Founder |

Launch Date Target: TBD

---

Last updated: Sprint 9 — Backend API verified live ✅ (api.freefuelpriceapp.com healthy, db connected, 2842+ stations, task def rev 17)
