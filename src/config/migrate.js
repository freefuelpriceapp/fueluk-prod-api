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

  console.log('DB migrations complete.');
}

module.exports = { runMigrations };
