'use strict';
const { getPool } = require('./db');

/**
 * migrate.js — Sprint 1 schema migration
 * Idempotent: uses IF NOT EXISTS throughout.
 * Runs automatically on server startup before any traffic.
 */
async function runMigrations() {
  const pool = getPool();
  console.log('Running DB migrations...');

  // Enable PostGIS
  await pool.query('CREATE EXTENSION IF NOT EXISTS postgis;');

  // Create stations table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      id            VARCHAR(50) PRIMARY KEY,
      brand         VARCHAR(100),
      name          VARCHAR(200),
      address       VARCHAR(300),
      postcode      VARCHAR(10),
      lat           DECIMAL(10, 7),
      lng           DECIMAL(10, 7),
      petrol_price  DECIMAL(5, 1),
      diesel_price  DECIMAL(5, 1),
      e10_price     DECIMAL(5, 1),
      last_updated  TIMESTAMP DEFAULT NOW(),
      location      GEOGRAPHY(POINT, 4326)
    );
  `);

  // Spatial index
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_stations_location ON stations USING GIST(location);'
  );

  // last_updated index
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_stations_last_updated ON stations(last_updated);'
  );

  // brand index
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_stations_brand ON stations(brand);'
  );

  // Trigger function to auto-update geography from lat/lng
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_station_location()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
        NEW.location = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::GEOGRAPHY;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Drop and recreate trigger
  await pool.query('DROP TRIGGER IF EXISTS trigger_update_location ON stations;');
  await pool.query(`
    CREATE TRIGGER trigger_update_location
    BEFORE INSERT OR UPDATE ON stations
    FOR EACH ROW
    EXECUTE FUNCTION update_station_location();
  `);

    // Sprint 2: Price history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id          BIGSERIAL PRIMARY KEY,
      station_id  VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      fuel_type   VARCHAR(10) NOT NULL,
      price_pence DECIMAL(5, 1),
      recorded_at TIMESTAMP NOT NULL DEFAULT date_trunc('hour', NOW())
    );
  `);

  // Unique constraint: one snapshot per station per fuel per hour
  await pool.query(`
    ALTER TABLE price_history
      DROP CONSTRAINT IF EXISTS uq_price_history_station_fuel_hour;
  `);
  await pool.query(`
    ALTER TABLE price_history
      ADD CONSTRAINT uq_price_history_station_fuel_hour
      UNIQUE (station_id, fuel_type, recorded_at);
  `);

  // Index for fast lookups by station
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_price_history_station ON price_history(station_id);'
  );

  // Index for time-based queries
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_price_history_recorded_at ON price_history(recorded_at);'
  );


    // Sprint 3: Price alerts table
  await pool.query(`
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
  `);
  await pool.query(`
    ALTER TABLE price_alerts
      DROP CONSTRAINT IF EXISTS uq_alerts_station_fuel_device;
  `);
  await pool.query(`
    ALTER TABLE price_alerts
      ADD CONSTRAINT uq_alerts_station_fuel_device
      UNIQUE (station_id, fuel_type, device_token);
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_alerts_device_token ON price_alerts(device_token) WHERE active = true;'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_alerts_station_fuel ON price_alerts(station_id, fuel_type) WHERE active = true;'
  );

  // Sprint 5: User favourites table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_favourites (
      id           BIGSERIAL PRIMARY KEY,
      device_token VARCHAR(500) NOT NULL,
      station_id   VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      created_at   TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE user_favourites
      DROP CONSTRAINT IF EXISTS uq_user_favourites_device_station;
  `);
  await pool.query(`
    ALTER TABLE user_favourites
      ADD CONSTRAINT uq_user_favourites_device_station
      UNIQUE (device_token, station_id);
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_user_favourites_device_token ON user_favourites(device_token);'
  );

  // Sprint 7: Premium users table
  await pool.query(`
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
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_premium_users_device_token ON premium_users(device_token);'
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_premium_users_expires_at ON premium_users(expires_at) WHERE tier <> 'free';"
  );
  
  // Sprint 6: Price reports table (user-submitted prices)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_reports (
      id          BIGSERIAL PRIMARY KEY,
      station_id  VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      fuel_type   VARCHAR(20) NOT NULL,
      price_pence DECIMAL(5, 1) NOT NULL,
      source      VARCHAR(20) NOT NULL DEFAULT 'user',
      reported_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_price_reports_station ON price_reports(station_id);'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_price_reports_reported_at ON price_reports(reported_at);'
  );

    // Sprint 14: Add source columns to stations table (for gov vs scraped badge)
  await pool.query(`ALTER TABLE stations ADD COLUMN IF NOT EXISTS petrol_source VARCHAR(30) DEFAULT NULL`);
  await pool.query(`ALTER TABLE stations ADD COLUMN IF NOT EXISTS diesel_source VARCHAR(30) DEFAULT NULL`);
  await pool.query(`ALTER TABLE stations ADD COLUMN IF NOT EXISTS e10_source VARCHAR(30) DEFAULT NULL`);

  // Sprint 14: Non-gov prices attribution table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS non_gov_prices (
      id          BIGSERIAL PRIMARY KEY,
      station_id  VARCHAR(50) NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      fuel_type   VARCHAR(20) NOT NULL,
      price_pence DECIMAL(5, 1),
      source      VARCHAR(30) NOT NULL DEFAULT 'scraped',
      scraped_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE non_gov_prices
      DROP CONSTRAINT IF EXISTS uq_non_gov_prices_station_fuel;
  `);
  await pool.query(`
    ALTER TABLE non_gov_prices
      ADD CONSTRAINT uq_non_gov_prices_station_fuel
      UNIQUE (station_id, fuel_type);
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_non_gov_prices_station ON non_gov_prices(station_id);'
  );
  console.log('DB migrations complete.');
}

module.exports = { runMigrations };
