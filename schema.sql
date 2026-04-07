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
