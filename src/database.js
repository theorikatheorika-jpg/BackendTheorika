const fs = require("node:fs");
const { Pool } = require("pg");

const connectionString = process.env.SUPABASE_DB_URL;
const caCertificatePath = process.env.SUPABASE_DB_CA_CERT;
const ssl = caCertificatePath
  ? { ca: fs.readFileSync(caCertificatePath, "utf8"), rejectUnauthorized: true }
  : { rejectUnauthorized: false };
const pool = connectionString
  ? new Pool({
    connectionString,
    ssl,
    max: 10,
    connectionTimeoutMillis: 10_000,
  })
  : null;
let connected = false;

async function connectDatabase() {
  if (!pool) return false;
  await pool.query("SELECT 1");
  connected = true;
  return true;
}

async function closeDatabase() {
  connected = false;
  if (pool) await pool.end();
}

async function query(text, values = []) {
  if (!pool) throw new Error("SUPABASE_DB_URL is not configured.");
  try {
    return await pool.query(text, values);
  } catch (error) {
    if (error?.code === "23505") error.code = 11000;
    throw error;
  }
}

function isDatabaseConfigured() {
  return Boolean(pool);
}

function isDatabaseConnected() {
  return connected;
}

module.exports = {
  closeDatabase,
  connectDatabase,
  isDatabaseConfigured,
  isDatabaseConnected,
  query,
};
