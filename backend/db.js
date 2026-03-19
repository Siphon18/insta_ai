// db.js — PostgreSQL connection pool & table initialisation
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If you need SSL (e.g. Render, Railway) uncomment below:
  // ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error', err);
});

/**
 * Create tables if they don't already exist.
 * Called once at server startup.
 */
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        google_sub    VARCHAR(255),
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique_idx
      ON users (google_sub)
      WHERE google_sub IS NOT NULL;
    `);

    // Personas — multiple personas per user, one active at a time
    await client.query(`
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

    // Ensure is_active column exists (for existing DBs)
    await client.query(`
      ALTER TABLE personas ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    `);
    await client.query(`
      ALTER TABLE personas ADD COLUMN IF NOT EXISTS voice_settings JSONB;
    `);

    // Normalize existing data so only latest active persona per user remains active
    await client.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
        FROM personas
        WHERE is_active = TRUE
      )
      UPDATE personas p
      SET is_active = FALSE
      FROM ranked r
      WHERE p.id = r.id
        AND r.rn > 1;
    `);

    // One active persona per user
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS personas_one_active_per_user_idx
      ON personas (user_id)
      WHERE is_active = TRUE;
    `);

    // Query performance indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS personas_user_created_idx
      ON personas (user_id, created_at DESC);
    `);

    // Chat messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         SERIAL PRIMARY KEY,
        persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        role       VARCHAR(10) NOT NULL,
        text       TEXT NOT NULL,
        audio_url  TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS chat_messages_persona_created_idx
      ON chat_messages (persona_id, created_at ASC);
    `);

    // Persistent TTS audio store (survives server restarts/deploys)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tts_audio_store (
        id           VARCHAR(64) PRIMARY KEY,
        audio_data   BYTEA NOT NULL,
        content_type VARCHAR(100) NOT NULL DEFAULT 'audio/mpeg',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS tts_audio_store_created_idx
      ON tts_audio_store (created_at DESC);
    `);

    // API usage counters (for persistent quota tracking)
    await client.query(`
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

    await client.query('COMMIT');
    console.log('[db] Tables initialised ✓');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[db] initDB error:', err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
