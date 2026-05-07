-- Phase 2B: receipt_groundtruth table
-- Stores anonymous opt-in ground-truth price data from user receipts.
-- No device ID, no IP stored — privacy-first.
-- Index: (postcode_outcode, fuel_type, receipt_date) for aggregation queries.

CREATE TABLE IF NOT EXISTS receipt_groundtruth (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand            VARCHAR(100) NOT NULL,
  postcode_outcode VARCHAR(10)  NOT NULL,
  p_per_l          DECIMAL(6,1) NOT NULL,
  fuel_type        VARCHAR(30)  NOT NULL,
  receipt_date     DATE         NOT NULL,
  ingested_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  source           VARCHAR(30)  NOT NULL DEFAULT 'user_receipt'
);

CREATE INDEX IF NOT EXISTS idx_rgt_outcode_fuel_date
  ON receipt_groundtruth(postcode_outcode, fuel_type, receipt_date DESC);

CREATE INDEX IF NOT EXISTS idx_rgt_ingested_at
  ON receipt_groundtruth(ingested_at DESC);
