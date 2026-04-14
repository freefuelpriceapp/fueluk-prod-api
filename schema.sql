-- Enable PostGIS extension for geographic queries
CREATE EXTENSION IF NOT EXISTS postgis;

-- Stations table
CREATE TABLE IF NOT EXISTS stations (
  id VARCHAR(50) PRIMARY KEY,
  brand VARCHAR(100),
  name VARCHAR(200),
  address VARCHAR(300),
  postcode VARCHAR(10),
  lat DECIMAL(10, 7),
  lng DECIMAL(10, 7),
  petrol_price DECIMAL(5, 1),
  diesel_price DECIMAL(5, 1),
  e10_price DECIMAL(5, 1),
  last_updated TIMESTAMP DEFAULT NOW(),
  location GEOGRAPHY(POINT, 4326)
);

-- Spatial index for nearby queries
CREATE INDEX IF NOT EXISTS idx_stations_location ON stations USING GIST(location);

-- Index on last_updated for sync queries
CREATE INDEX IF NOT EXISTS idx_stations_last_updated ON stations(last_updated);

-- Index on brand
CREATE INDEX IF NOT EXISTS idx_stations_brand ON stations(brand);

-- Index on petrol price (for cheapest queries)
CREATE INDEX IF NOT EXISTS idx_stations_petrol ON stations(petrol_price ASC) WHERE petrol_price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stations_diesel ON stations(diesel_price ASC) WHERE diesel_price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stations_e10 ON stations(e10_price ASC) WHERE e10_price IS NOT NULL;

-- Trigger to auto-update location from lat/lng
CREATE OR REPLACE FUNCTION update_station_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::GEOGRAPHY;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_location ON stations;
CREATE TRIGGER trigger_update_location
  BEFORE INSERT OR UPDATE ON stations
  FOR EACH ROW
  EXECUTE FUNCTION update_station_location();

-- Sprint 2: Price history table for trend data
CREATE TABLE IF NOT EXISTS price_history (
  id           BIGSERIAL PRIMARY KEY,
  station_id   VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  fuel_type    VARCHAR(10) NOT NULL,
  price_pence  DECIMAL(5, 1),
  recorded_at  TIMESTAMP NOT NULL DEFAULT date_trunc('hour', NOW())
);

-- Unique constraint: one snapshot per station per fuel per hour
ALTER TABLE price_history
  DROP CONSTRAINT IF EXISTS uq_price_history_station_fuel_hour;
ALTER TABLE price_history
  ADD CONSTRAINT uq_price_history_station_fuel_hour
  UNIQUE (station_id, fuel_type, recorded_at);

-- Index for fast history lookups
CREATE INDEX IF NOT EXISTS idx_price_history_station_id
  ON price_history(station_id, recorded_at DESC);

-- Sprint 3: Price alerts table
CREATE TABLE IF NOT EXISTS price_alerts (
  id                BIGSERIAL PRIMARY KEY,
  station_id        VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  fuel_type         VARCHAR(10) NOT NULL,
  threshold_pence   DECIMAL(5, 1) NOT NULL,
  device_token      VARCHAR(500) NOT NULL,
  platform          VARCHAR(20) NOT NULL DEFAULT 'unknown',
  active            BOOLEAN NOT NULL DEFAULT true,
  last_notified_at  TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP
);

-- Unique: one alert per station/fuel/device combo
ALTER TABLE price_alerts
  DROP CONSTRAINT IF EXISTS uq_alerts_station_fuel_device;
ALTER TABLE price_alerts
  ADD CONSTRAINT uq_alerts_station_fuel_device
  UNIQUE (station_id, fuel_type, device_token);

-- Indexes for alert lookups
CREATE INDEX IF NOT EXISTS idx_alerts_device_token ON price_alerts(device_token) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_alerts_station_fuel ON price_alerts(station_id, fuel_type) WHERE active = true;

-- Sprint 3: Retention comment
-- price_history older than 90 days is purged by the nightly cleanup job (src/jobs/retentionJob.js)

-- Sprint 5: User favourites table (device-token scoped, no account required)
CREATE TABLE IF NOT EXISTS user_favourites (
  id           BIGSERIAL PRIMARY KEY,
  device_token VARCHAR(500) NOT NULL,
  station_id   VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Unique: one favourite per device per station
ALTER TABLE user_favourites
  DROP CONSTRAINT IF EXISTS uq_user_favourites_device_station;
ALTER TABLE user_favourites
  ADD CONSTRAINT uq_user_favourites_device_station
  UNIQUE (device_token, station_id);

-- Index for fast device lookups
CREATE INDEX IF NOT EXISTS idx_user_favourites_device_token
  ON user_favourites(device_token);

-- Sprint 7: Premium users table (device-token scoped subscription tier)
CREATE TABLE IF NOT EXISTS premium_users (
  id              BIGSERIAL PRIMARY KEY,
  device_token    VARCHAR(500) NOT NULL UNIQUE,
  tier            VARCHAR(20)  NOT NULL DEFAULT 'free',
  subscribed_at   TIMESTAMP,
  expires_at      TIMESTAMP,
  receipt_token   VARCHAR(1000),
  platform        VARCHAR(20)  NOT NULL DEFAULT 'unknown',
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Index for fast device token lookups
CREATE INDEX IF NOT EXISTS idx_premium_users_device_token
  ON premium_users(device_token);

-- Index for expiry checks (background job)
CREATE INDEX IF NOT EXISTS idx_premium_users_expires_at
  ON premium_users(expires_at) WHERE tier <> 'free';
