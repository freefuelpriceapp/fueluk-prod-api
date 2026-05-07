'use strict';

/**
 * groundtruthRepository.js
 * Data access for receipt_groundtruth table.
 */

const { getPool } = require('../config/db');

/**
 * Insert a single ground-truth row.
 */
async function insertGroundTruth({ brand, postcode_outcode, p_per_l, fuel_type, receipt_date }) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO receipt_groundtruth
       (brand, postcode_outcode, p_per_l, fuel_type, receipt_date, source)
     VALUES ($1, $2, $3, $4, $5, 'user_receipt')
     RETURNING id, ingested_at`,
    [brand, postcode_outcode, p_per_l, fuel_type, receipt_date]
  );
  return result.rows[0];
}

/**
 * Aggregate counts for the diagnostics endpoint.
 */
async function getGroundTruthStats() {
  const pool = getPool();
  const [totalRes, last24hRes, last7dRes, brandRes, outcodeRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM receipt_groundtruth`),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM receipt_groundtruth WHERE ingested_at > NOW() - INTERVAL '24 hours'`),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM receipt_groundtruth WHERE ingested_at > NOW() - INTERVAL '7 days'`),
    pool.query(`
      SELECT brand, COUNT(*)::int AS cnt
      FROM receipt_groundtruth
      GROUP BY brand
      ORDER BY cnt DESC
    `),
    pool.query(`
      SELECT postcode_outcode AS outcode, COUNT(*)::int AS cnt
      FROM receipt_groundtruth
      GROUP BY postcode_outcode
      ORDER BY cnt DESC
      LIMIT 10
    `),
  ]);

  const by_brand = {};
  for (const row of brandRes.rows) {
    by_brand[row.brand] = row.cnt;
  }

  return {
    total: totalRes.rows[0].total,
    last_24h: last24hRes.rows[0].cnt,
    last_7d: last7dRes.rows[0].cnt,
    by_brand,
    by_outcode_top10: outcodeRes.rows.map((r) => ({ outcode: r.outcode, count: r.cnt })),
  };
}

module.exports = { insertGroundTruth, getGroundTruthStats };
