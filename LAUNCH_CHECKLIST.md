# Launch Checklist — FreeFuelPrice UK

A comprehensive pre-launch checklist for the FreeFuelPrice UK app and backend API.
Track each item before going live on the App Store and Google Play.

---

## 🔧 Backend API

### Infrastructure
- [ ] ECS Fargate cluster is running (`fuelapp-prod-cluster`)
- [ ] ECS service healthy (`fueluk-prod-service`)
- [ ] RDS PostgreSQL instance running with PostGIS enabled
- [ ] AWS Secrets Manager secret `fuelapp/prod/db` populated with all env vars
- [ ] ECR repository exists and latest image pushed
- [ ] CodePipeline connected to GitHub `main` branch
- [ ] ALB (Application Load Balancer) configured with HTTPS
- [ ] ACM SSL certificate `*.freefuelpriceapp.com` issued and attached to ALB
- [ ] Domain `api.freefuelpriceapp.com` pointing to ALB

### API Health
- [ ] `GET /health` returns `{ status: "ok", version: "9.0.0" }`
- [ ] `GET /stations/nearby` returns stations within radius
- [ ] `GET /prices` returns current fuel prices
- [ ] `POST /device/register` registers device token successfully
- [ ] `POST /notifications/subscribe` subscribes to price alerts
- [ ] Rate limiting active (100 req/15min per IP)

### Database
- [ ] All migrations applied (`node src/db/migrate.js`)
- [ ] `stations` table populated with UK fuel stations
- [ ] `prices` table populated with current prices
- [ ] PostGIS spatial indexes active
- [ ] `premium_users` table created

### Security
- [ ] JWT_SECRET set to strong random value
- [ ] CORS configured to allow only app origins
- [ ] Rate limiter enabled in production
- [ ] No sensitive values in source code or logs
- [ ] Helmet.js security headers enabled

---

## 📱 Mobile App (iOS)

### Build & Configuration
- [ ] `app.json` version set to `9.0.0`
- [ ] `eas.json` configured for production build
- [ ] Bundle identifier: `com.freefuelpriceapp.uk`
- [ ] API base URL pointing to `https://api.freefuelpriceapp.com`
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

- [ ] `ROUTE_AWARE_PRICING` — disabled (post-MVP)
- [ ] `PREMIUM_SUBSCRIPTIONS` — disabled (post-MVP)
- [ ] `PRICE_ALERTS` — disabled (post-MVP)
- [ ] `FAVOURITE_STATIONS` — disabled (post-MVP)
- [ ] `TRIP_COST_CALCULATOR` — disabled (post-MVP)
- [ ] `COMMUNITY_REPORTS` — disabled (post-MVP)
- [ ] Core station search — **ENABLED** (MVP)
- [ ] Core price display — **ENABLED** (MVP)
- [ ] Device registration — **ENABLED** (MVP)

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
| Backend API | ❓ Pending | Dev |
| iOS App | ❓ Pending | Dev |
| Android App | ❓ Pending | Dev |
| Database | ❓ Pending | Dev |
| Monitoring | ❓ Pending | Dev |
| Legal | ❓ Pending | Founder |
| App Store | ❓ Pending | Founder |

**Launch Date Target**: TBD

---

*Last updated: Sprint 9 — Domain corrected to freefuelpriceapp.com, bundle IDs updated*
