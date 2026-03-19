#!/usr/bin/env node
const { Client } = require('pg');
require('dotenv').config();

const SOURCE_URL = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL || process.env.NEON_DATABASE_URL;
const BATCH_SIZE = Math.max(parseInt(process.env.MIGRATION_BATCH_SIZE || '500', 10), 100);

const TABLES_IN_ORDER = [
  'users',
  'personas',
  'chat_messages',
  'api_usage_counters'
];

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function ensureTargetSchema(target) {
  await target.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         VARCHAR(255) UNIQUE NOT NULL,
      google_sub    VARCHAR(255),
      password_hash VARCHAR(255) NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await target.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);
  `);
  await target.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique_idx
    ON users (google_sub)
    WHERE google_sub IS NOT NULL;
  `);

  await target.query(`
    CREATE TABLE IF NOT EXISTS personas (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ig_username        VARCHAR(255) NOT NULL,
      name               VARCHAR(255),
      bio                TEXT,
      profile_pic_url    TEXT,
      voice_id           VARCHAR(100),
      voice_style        VARCHAR(100),
      voice_description  VARCHAR(255),
      voice_settings     JSONB,
      system_instruction TEXT NOT NULL,
      is_active          BOOLEAN DEFAULT TRUE,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await target.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;`);
  await target.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS voice_settings JSONB;`);
  await target.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS personas_one_active_per_user_idx
    ON personas (user_id)
    WHERE is_active = TRUE;
  `);
  await target.query(`
    CREATE INDEX IF NOT EXISTS personas_user_created_idx
    ON personas (user_id, created_at DESC);
  `);

  await target.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      role       VARCHAR(10) NOT NULL,
      text       TEXT NOT NULL,
      audio_url  TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await target.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_persona_created_idx
    ON chat_messages (persona_id, created_at ASC);
  `);

  await target.query(`
    CREATE TABLE IF NOT EXISTS api_usage_counters (
      source       VARCHAR(50) NOT NULL,
      period_type  VARCHAR(10) NOT NULL,
      period_key   VARCHAR(20) NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      period_start TIMESTAMPTZ NOT NULL,
      period_end   TIMESTAMPTZ NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (source, period_type, period_key)
    );
  `);
}

async function getColumns(client, tableName) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return result.rows.map(r => r.column_name);
}

async function copyTable(source, target, tableName) {
  const columns = await getColumns(source, tableName);
  if (columns.length === 0) {
    console.log(`[migrate] skip ${tableName}: table missing in source`);
    return;
  }

  const quotedCols = columns.map(quoteIdent).join(', ');
  const sourceResult = await source.query(`SELECT ${quotedCols} FROM ${quoteIdent(tableName)}`);
  const rows = sourceResult.rows;
  if (rows.length === 0) {
    console.log(`[migrate] ${tableName}: 0 rows`);
    return;
  }

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const placeholders = batch.map((row, rowIndex) => {
      const rowPlaceholders = columns.map((col, colIndex) => {
        values.push(row[col]);
        return `$${rowIndex * columns.length + colIndex + 1}`;
      });
      return `(${rowPlaceholders.join(', ')})`;
    });

    const query = `INSERT INTO ${quoteIdent(tableName)} (${quotedCols}) VALUES ${placeholders.join(', ')}`;
    await target.query(query, values);
  }

  console.log(`[migrate] ${tableName}: ${rows.length} rows copied`);
}

async function resetSequence(target, tableName, idColumn = 'id') {
  const seq = `${tableName}_${idColumn}_seq`;
  await target.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${quoteIdent(idColumn)}) FROM ${quoteIdent(tableName)}), 1), true)`,
    [seq]
  );
}

async function main() {
  if (!SOURCE_URL) {
    throw new Error('Missing SOURCE_DATABASE_URL (or DATABASE_URL fallback).');
  }
  if (!TARGET_URL) {
    throw new Error('Missing TARGET_DATABASE_URL (or NEON_DATABASE_URL).');
  }

  const source = new Client({ connectionString: SOURCE_URL });
  const target = new Client({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

  await source.connect();
  await target.connect();

  try {
    console.log('[migrate] connected to source and target');
    await target.query('BEGIN');
    await ensureTargetSchema(target);

    // Start fresh on target
    await target.query('TRUNCATE TABLE chat_messages, personas, users, api_usage_counters RESTART IDENTITY CASCADE');

    for (const table of TABLES_IN_ORDER) {
      await copyTable(source, target, table);
    }

    await resetSequence(target, 'users');
    await resetSequence(target, 'personas');
    await resetSequence(target, 'chat_messages');

    await target.query('COMMIT');
    console.log('[migrate] migration completed successfully');
  } catch (err) {
    await target.query('ROLLBACK');
    console.error('[migrate] failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch(err => {
  console.error('[migrate] fatal:', err.message || err);
  process.exit(1);
});
