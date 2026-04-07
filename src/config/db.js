'use strict';
const { Pool } = require('pg');

let pool;

async function initPool() {
  pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'fuelapp',
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  console.log('PostgreSQL connected:', process.env.DB_HOST);
}

function getPool() {
  if (!pool) throw new Error('DB pool not initialised');
  return pool;
}

module.exports = { initPool, getPool };
