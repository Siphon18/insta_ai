// server.js â€” JWT + PostgreSQL based backend
const express = require('express');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const { pool, initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const GROQ_API_BASE_URL = process.env.GROQ_API_BASE_URL || 'https://api.groq.com/openai/v1';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const ELEVENLABS_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
const ELEVENLABS_DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const RAPIDAPI_WINDOW_MS = Math.max(parseInt(process.env.RAPIDAPI_RATE_WINDOW_MS || '3600000', 10) || 3600000, 1000);
const RAPIDAPI_GENERATE_LIMIT = Math.max(parseInt(process.env.RAPIDAPI_RATE_LIMIT_GENERATE_PER_WINDOW || '2', 10) || 2, 1);
const RAPIDAPI_POSTS_LIMIT = Math.max(parseInt(process.env.RAPIDAPI_RATE_LIMIT_POSTS_PER_WINDOW || '6', 10) || 6, 1);
const RAPIDAPI_DAILY_BUDGET = Math.max(parseInt(process.env.RAPIDAPI_DAILY_BUDGET || '5', 10) || 5, 1);
const RAPIDAPI_MONTHLY_BUDGET = Math.max(parseInt(process.env.RAPIDAPI_MONTHLY_BUDGET || '145', 10) || 145, 1);
const INSTAGRAM_CACHE_TTL_MS = Math.max(parseInt(process.env.INSTAGRAM_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10) || (6 * 60 * 60 * 1000), 60 * 1000);
const AUTH_LOGIN_WINDOW_MS = Math.max(parseInt(process.env.AUTH_LOGIN_RATE_WINDOW_MS || '900000', 10) || 900000, 1000);
const AUTH_LOGIN_LIMIT = Math.max(parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_PER_WINDOW || '8', 10) || 8, 1);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function validateStartupConfig() {
  const missing = [];
  const required = ['DATABASE_URL', 'GROQ_API_KEY', 'RAPIDAPI_KEY', 'ELEVENLABS_API_KEY', 'JWT_SECRET'];
  for (const key of required) {
    if (!process.env[key] || !String(process.env[key]).trim()) missing.push(key);
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (String(JWT_SECRET).length < 16) {
    throw new Error('JWT_SECRET must be at least 16 characters long.');
  }

  if (IS_PRODUCTION && CORS_ALLOWED_ORIGINS.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS is required in production.');
  }
}

function buildCorsOptions() {
  if (!IS_PRODUCTION || CORS_ALLOWED_ORIGINS.length === 0) {
    return { origin: true };
  }
  return {
    origin: (origin, callback) => {
      // Allow same-origin/curl requests without Origin header
      if (!origin) return callback(null, true);
      if (CORS_ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    }
  };
}

// Primary + fallback models (if one is overloaded, try the other)
const MODEL_PRIMARY = process.env.GROQ_MODEL_PRIMARY || 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || MODEL_PRIMARY;
let activeModelName = MODEL_PRIMARY;

function isRetryableError(err) {
  const msg = err?.message || '';
  return msg.includes('429') || err?.status === 429 || err?.response?.status === 429
    || msg.includes('Resource has been exhausted') || msg.includes('RESOURCE_EXHAUSTED')
    || msg.includes('503') || err?.status === 503 || err?.response?.status === 503
    || msg.includes('Service Unavailable') || msg.includes('high demand')
    || msg.includes('UNAVAILABLE') || msg.includes('overloaded');
}

function switchModel() {
  const newModel = activeModelName === MODEL_PRIMARY ? MODEL_FALLBACK : MODEL_PRIMARY;
  console.log(`[groq] Switching model: ${activeModelName} â†’ ${newModel}`);
  activeModelName = newModel;
  return activeModelName;
}

const { URL } = require('url');

// --- Semaphore: max 2 concurrent Groq calls ---
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) { this.current++; this.queue.shift()(); }
  }
}
const groqSemaphore = new Semaphore(2);

function toGroqMessages(history, prompt, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  if (Array.isArray(history)) {
    history.forEach(item => {
      if (!item || !item.text) return;
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: item.text });
    });
  }
  if (prompt) messages.push({ role: 'user', content: prompt });
  return messages;
}

function extractgroqText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join(' ').trim();
  }
  return '';
}

async function groqChatCompletion({ modelName, messages, generationConfig }) {
  const payload = {
    model: modelName,
    messages,
    stream: false,
    temperature: generationConfig?.temperature ?? 0.7,
    top_p: generationConfig?.topP ?? 0.9,
    max_tokens: generationConfig?.maxOutputTokens ?? 400
  };

  const response = await axios.post(`${GROQ_API_BASE_URL}/chat/completions`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    timeout: 90000
  });
  return extractgroqText(response.data);
}

let elevenLabsClientPromise = null;
let googleOAuthClient = null;
const generatedAudioCache = new Map(); // id -> { buffer, contentType, createdAt }
const AUDIO_CACHE_TTL_MS = 60 * 60 * 1000;

function cleanupAudioCache() {
  const now = Date.now();
  for (const [id, item] of generatedAudioCache.entries()) {
    if (now - item.createdAt > AUDIO_CACHE_TTL_MS) generatedAudioCache.delete(id);
  }
}
setInterval(cleanupAudioCache, 10 * 60 * 1000).unref();

async function getElevenLabsClient() {
  if (!elevenLabsClientPromise) {
    elevenLabsClientPromise = import('@elevenlabs/elevenlabs-js')
      .then(mod => new mod.ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY }));
  }
  return elevenLabsClientPromise;
}

function getGoogleOAuthClient() {
  if (!googleOAuthClient) googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  return googleOAuthClient;
}

async function audioToBuffer(audio) {
  if (!audio) return null;
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof Uint8Array) return Buffer.from(audio);
  if (typeof audio.arrayBuffer === 'function') {
    const arr = await audio.arrayBuffer();
    return Buffer.from(arr);
  }
  if (Symbol.asyncIterator in Object(audio)) {
    const chunks = [];
    for await (const chunk of audio) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return null;
}

function cacheGeneratedAudio(buffer, contentType = 'audio/mpeg') {
  const id = crypto.randomUUID();
  generatedAudioCache.set(id, { buffer, contentType, createdAt: Date.now() });
  return `/api/tts/${id}`;
}

async function persistGeneratedAudio(buffer, contentType = 'audio/mpeg') {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO tts_audio_store (id, audio_data, content_type) VALUES ($1, $2, $3)',
    [id, buffer, contentType]
  );
  return `/api/tts-persist/${id}`;
}

// --- Groq retry helper (reusable, with semaphore + model fallback) ---
async function groqGenerateWithRetry(prompt, retries = 3) {
  await groqSemaphore.acquire();
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const text = await groqChatCompletion({
          modelName: activeModelName,
          messages: [{ role: 'user', content: prompt }],
          generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 400 }
        });
        return String(text || '').trim();
      } catch (err) {
        if (isRetryableError(err) && attempt < retries) {
          // On second retry, switch to fallback model
          if (attempt === 1) switchModel();
          const baseWait = Math.min(10 * Math.pow(2, attempt), 60);
          const jitter = Math.random() * 5;
          const waitSec = baseWait + jitter;
          console.log(`[groq] ${err?.response?.status || err?.status || '429/503'} error, retrying in ${waitSec.toFixed(1)}s with ${activeModelName} (attempt ${attempt + 1}/${retries})...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        } else {
          throw err;
        }
      }
    }
  } finally {
    groqSemaphore.release();
  }
}

// --- Chat send helper (with semaphore + retry + model fallback) ---
async function groqChatWithRetry(prompt, history, generationConfig, systemInstruction, retries = 3) {
  await groqSemaphore.acquire();
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const messages = toGroqMessages(history, prompt, systemInstruction);
        const text = await groqChatCompletion({
          modelName: activeModelName,
          messages,
          generationConfig
        });
        return String(text || '').trim();
      } catch (err) {
        if (isRetryableError(err) && attempt < retries) {
          if (attempt === 1) switchModel();
          const baseWait = Math.min(10 * Math.pow(2, attempt), 60);
          const jitter = Math.random() * 5;
          const waitSec = baseWait + jitter;
          console.log(`[chat] ${err?.response?.status || err?.status || '429/503'} error, retrying in ${waitSec.toFixed(1)}s with ${activeModelName} (attempt ${attempt + 1}/${retries})...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        } else {
          throw err;
        }
      }
    }
  } finally {
    groqSemaphore.release();
  }
}

// --- Voice Configuration ---
const voices = {
  male: [
    { voiceId: process.env.ELEVENLABS_VOICE_MALE_1 || ELEVENLABS_DEFAULT_VOICE_ID, style: 'Conversational', description: 'Warm & friendly' },
    { voiceId: process.env.ELEVENLABS_VOICE_MALE_2 || 'N2lVS1w4EtoT3dr4eOWO', style: 'Conversational', description: 'Professional' },
    { voiceId: process.env.ELEVENLABS_VOICE_MALE_3 || 'ErXwobaYiN019PkySvjV', style: 'Conversational', description: 'Deep & authoritative' }
  ],
  female: [
    { voiceId: process.env.ELEVENLABS_VOICE_FEMALE_1 || 'EXAVITQu4vr4xnSDxMaL', style: 'Conversational', description: 'Natural & clear' },
    { voiceId: process.env.ELEVENLABS_VOICE_FEMALE_2 || 'XrExE9yKIg1WjnnlVkGX', style: 'Conversational', description: 'Young & energetic' },
    { voiceId: process.env.ELEVENLABS_VOICE_FEMALE_3 || 'MF3mGyEYCl7XYWbV9V6O', style: 'Conversational', description: 'Warm & friendly' }
  ]
};

function deriveVoiceStyleProfile(personalityAnalysis = '') {
  const text = String(personalityAnalysis || '').toLowerCase();
  const has = (words) => words.some(w => text.includes(w));

  if (has(['high-energy', 'hype', 'energetic', 'excited', 'playful', 'bold', 'fire'])) {
    return {
      presetName: 'energetic',
      voiceSettings: { stability: 0.32, similarityBoost: 0.78, style: 0.72, speed: 1.06, useSpeakerBoost: true },
      styleLabel: 'Energetic & expressive'
    };
  }

  if (has(['calm', 'reflective', 'soothing', 'mindful', 'gentle', 'soft'])) {
    return {
      presetName: 'calm',
      voiceSettings: { stability: 0.62, similarityBoost: 0.72, style: 0.28, speed: 0.94, useSpeakerBoost: true },
      styleLabel: 'Calm & reflective'
    };
  }

  if (has(['professional', 'business', 'authoritative', 'serious', 'formal'])) {
    return {
      presetName: 'professional',
      voiceSettings: { stability: 0.68, similarityBoost: 0.8, style: 0.2, speed: 0.99, useSpeakerBoost: true },
      styleLabel: 'Professional & clear'
    };
  }

  if (has(['funny', 'sarcastic', 'witty', 'humor', 'jokester'])) {
    return {
      presetName: 'playful',
      voiceSettings: { stability: 0.4, similarityBoost: 0.74, style: 0.6, speed: 1.02, useSpeakerBoost: true },
      styleLabel: 'Playful & witty'
    };
  }

  return {
    presetName: 'balanced',
    voiceSettings: { stability: 0.55, similarityBoost: 0.76, style: 0.38, speed: 1.0, useSpeakerBoost: true },
    styleLabel: 'Balanced conversational'
  };
}

app.use(express.json());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://accounts.google.com", "https://apis.google.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:", "https:"],
      connectSrc: ["'self'", "https:"],
      frameSrc: ["'self'", "https://accounts.google.com"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors(buildCorsOptions()));
app.use(express.static(path.join(__dirname, '../frontend/public'), { index: false }));
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
  }
  return next(err);
});

// Suppress favicon 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'insta_ai_backend',
    time: new Date().toISOString()
  });
});

app.get('/readyz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({
      status: 'ready',
      db: 'ok',
      time: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'not_ready',
      db: 'error'
    });
  }
});


// ======================== JWT Middleware ========================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user; // { id, email }
    next();
  });
}


// ======================== Auth Endpoints ========================
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    // Check existing
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.toLowerCase().trim(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('[signup] error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.post('/api/auth/login', authLoginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('[login] error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.get('/api/auth/google/config', (req, res) => {
  const enabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID.trim());
  res.status(200).json({ enabled, clientId: enabled ? GOOGLE_CLIENT_ID : null });
});

app.post('/api/auth/google', authLoginLimiter, async (req, res) => {
  const credential = String(req.body?.credential || '').trim();
  if (!credential) return res.status(400).json({ error: 'Google credential is required.' });
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth is not configured on this server.' });

  try {
    const ticket = await getGoogleOAuthClient().verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = String(payload?.email || '').toLowerCase().trim();
    const googleSub = String(payload?.sub || '').trim();
    const emailVerified = payload?.email_verified === true;

    if (!email || !googleSub || !emailVerified) {
      return res.status(400).json({ error: 'Invalid Google account payload.' });
    }

    let user = null;
    const byGoogle = await pool.query(
      'SELECT id, email, google_sub FROM users WHERE google_sub = $1',
      [googleSub]
    );
    if (byGoogle.rows.length > 0) {
      user = byGoogle.rows[0];
    } else {
      const byEmail = await pool.query(
        'SELECT id, email, google_sub FROM users WHERE email = $1',
        [email]
      );

      if (byEmail.rows.length > 0) {
        const existing = byEmail.rows[0];
        if (existing.google_sub && existing.google_sub !== googleSub) {
          return res.status(409).json({ error: 'This email is linked to a different Google account.' });
        }
        const updated = await pool.query(
          'UPDATE users SET google_sub = $1 WHERE id = $2 RETURNING id, email, google_sub',
          [googleSub, existing.id]
        );
        user = updated.rows[0];
      } else {
        const generatedPasswordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
        const created = await pool.query(
          'INSERT INTO users (email, password_hash, google_sub) VALUES ($1, $2, $3) RETURNING id, email, google_sub',
          [email, generatedPasswordHash, googleSub]
        );
        user = created.rows[0];
      }
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('[google-auth] error:', err?.message || err);
    res.status(401).json({ error: 'Google authentication failed. Please try again.' });
  }
});

// ---------- Verify Token ----------
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// ======================== Voice Selection Helper ========================
// Gender detection now combined into personality analysis (single Groq call)
// This is the fallback if name-based heuristic fails
function guessGenderFromName(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim().split(/\s+/)[0];
  // Common endings heuristic
  const femaleEndings = ['a', 'ie', 'ey', 'ine', 'elle', 'ette', 'ina', 'isa', 'ita'];
  const maleNames = ['james','john','robert','michael','david','chris','daniel','mark','paul','andrew','kevin','brian','steve','jason','ryan','matt','jake','kyle','tyler','nick','alex','max','ben','sam','tom','jack','joe','leo','ian'];
  const femaleNames = ['mary','emma','olivia','sophia','isabella','mia','charlotte','emily','jessica','sarah','ashley','taylor','lisa','nicole','rachel','anna','maria','julia','grace','chloe','lily','kim','jen','kate','natalie','kylie'];
  if (maleNames.includes(lower)) return 'male';
  if (femaleNames.includes(lower)) return 'female';
  for (const ending of femaleEndings) { if (lower.endsWith(ending) && lower.length > 3) return 'female'; }
  return null;
}

async function selectVoiceByGender(name, bio, username, preferredGender = null) {
  if (preferredGender) {
    const normalized = String(preferredGender).toLowerCase();
    if (normalized === 'male' && voices.male.length > 0) return voices.male[0];
    if (normalized === 'female' && voices.female.length > 0) return voices.female[0];
  }

  // Try name-based heuristic first (no API call)
  const nameGuess = guessGenderFromName(name);
  if (nameGuess) {
    console.log(`[selectVoiceByGender] Name heuristic: @${username} -> ${nameGuess}`);
    return nameGuess === 'female' ? voices.female[0] : voices.male[0];
  }

  // Fallback: will be detected during personality analysis (combined call)
  console.log(`[selectVoiceByGender] Name heuristic inconclusive for @${username}, will use personality analysis`);
  return null; // caller will handle via combined analysis
}


// ======================== Public Endpoints ========================
app.get('/get-voices', (req, res) => {
  res.status(200).json(voices);
});

function normalizeIgUsername(username) {
  return String(username || '').replace(/^@+/, '').trim().toLowerCase();
}

function extractPostsFromProfile(profileData, limit = 12) {
  const edges = (profileData?.edge_owner_to_timeline_media?.edges || []).slice(0, limit);
  return edges.map(edge => {
    const node = edge?.node || edge || {};
    return {
      id: node.id || node.shortcode || null,
      image_url: node.display_url || node.thumbnail_src || '',
      caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
      like_count: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
      comment_count: node.edge_media_to_comment?.count || 0,
      taken_at: node.taken_at_timestamp || 0,
      media_type: node.is_video ? 2 : 1
    };
  }).filter(post => Boolean(post.id || post.image_url));
}

async function readInstagramCache(username) {
  const igUsername = normalizeIgUsername(username);
  const result = await pool.query(
    `SELECT ig_username, full_name, biography, profile_pic_url, profile_pic_url_hd,
            profile_payload, posts_payload, fetched_at
     FROM instagram_profile_cache
     WHERE ig_username = $1
     LIMIT 1`,
    [igUsername]
  );
  return result.rows[0] || null;
}

async function upsertInstagramCache(profileData) {
  const igUsername = normalizeIgUsername(profileData?.username);
  if (!igUsername) return;
  const posts = extractPostsFromProfile(profileData, 50);
  await pool.query(
    `INSERT INTO instagram_profile_cache (
       ig_username, full_name, biography, profile_pic_url, profile_pic_url_hd,
       profile_payload, posts_payload, fetched_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW(), NOW())
     ON CONFLICT (ig_username)
     DO UPDATE SET
       full_name = EXCLUDED.full_name,
       biography = EXCLUDED.biography,
       profile_pic_url = EXCLUDED.profile_pic_url,
       profile_pic_url_hd = EXCLUDED.profile_pic_url_hd,
       profile_payload = EXCLUDED.profile_payload,
       posts_payload = EXCLUDED.posts_payload,
       fetched_at = NOW(),
       updated_at = NOW()`,
    [
      igUsername,
      profileData?.full_name || null,
      profileData?.biography || null,
      profileData?.profile_pic_url || null,
      profileData?.profile_pic_url_hd || profileData?.profile_pic_url || null,
      JSON.stringify(profileData || {}),
      JSON.stringify(posts)
    ]
  );
}

async function fetchInstagramProfileFromRapidApi(username, req, rateLimitKind = 'posts') {
  const limiter = rateLimitKind === 'generate'
    ? {
        prefix: 'rapidapi-generate',
        limit: RAPIDAPI_GENERATE_LIMIT,
        windowMs: RAPIDAPI_WINDOW_MS,
        userScoped: true,
        message: "Sorry, we're getting a lot of requests right now. Please wait a bit and try generating again."
      }
    : {
        prefix: 'rapidapi-posts',
        limit: RAPIDAPI_POSTS_LIMIT,
        windowMs: RAPIDAPI_WINDOW_MS,
        userScoped: false,
        message: "Sorry, we've hit the profile fetch limit for now. Please wait a bit and try again."
      };

  const memoryLimit = checkInMemoryRateLimit(req, limiter);
  if (!memoryLimit.allowed) {
    const err = new Error(memoryLimit.message);
    err.statusCode = 429;
    err.retryAfterSec = memoryLimit.retryAfterSec;
    throw err;
  }

  const budget = await consumeRapidApiBudget();
  if (!budget.allowed) {
    const err = new Error(budget.error);
    err.statusCode = budget.statusCode || 429;
    err.retryAfterSec = budget.retryAfterSec;
    throw err;
  }

  const profileRes = await axios.get('https://instagram-looter2.p.rapidapi.com/profile', {
    params: { username: normalizeIgUsername(username) },
    headers: {
      'x-rapidapi-key': process.env.RAPIDAPI_KEY,
      'x-rapidapi-host': 'instagram-looter2.p.rapidapi.com'
    }
  });

  const profileData = profileRes.data || {};
  if (!profileData.username) profileData.username = normalizeIgUsername(username);
  await upsertInstagramCache(profileData);
  return profileData;
}

async function getInstagramProfileWithCache(username, req, options = {}) {
  const { allowStaleOnError = true, cacheTtlMs = INSTAGRAM_CACHE_TTL_MS, rateLimitKind = 'posts' } = options;
  const igUsername = normalizeIgUsername(username);
  const cacheRow = await readInstagramCache(igUsername);
  const now = Date.now();

  if (cacheRow?.profile_payload && cacheRow?.fetched_at) {
    const ageMs = now - new Date(cacheRow.fetched_at).getTime();
    if (!Number.isNaN(ageMs) && ageMs <= cacheTtlMs) {
      return { profileData: cacheRow.profile_payload, source: 'cache', stale: false };
    }
  }

  try {
    const profileData = await fetchInstagramProfileFromRapidApi(igUsername, req, rateLimitKind);
    return { profileData, source: 'rapidapi', stale: false };
  } catch (err) {
    if (allowStaleOnError && cacheRow?.profile_payload) {
      console.warn(`[instagram-cache] using stale cache for @${igUsername} due to fetch error: ${err.message}`);
      return { profileData: cacheRow.profile_payload, source: 'cache', stale: true };
    }
    throw err;
  }
}


// ---------- Instagram Posts Endpoint (instagram-looter2) ----------
app.get('/instagram-posts', async (req, res) => {
  const username = normalizeIgUsername(req.query.username);
  const limit = Math.min(Math.max(parseInt(req.query.limit || '12', 10) || 12, 1), 50);

  if (!username) return res.status(400).json({ error: 'Username is required' });

  try {
    const profileResult = await getInstagramProfileWithCache(username, req, {
      allowStaleOnError: true,
      cacheTtlMs: INSTAGRAM_CACHE_TTL_MS,
      rateLimitKind: 'posts'
    });
    const profileData = profileResult.profileData || {};
    const posts = extractPostsFromProfile(profileData, limit);

    console.log(`[instagram-posts] Found ${posts.length} posts for @${username}`);
    res.json({
      posts,
      username,
      count: posts.length,
      cached: profileResult.source === 'cache',
      stale: profileResult.stale === true,
      ...(posts.length === 0 && { message: `No posts found for @${username}.` })
    });
  } catch (error) {
    const status = error.statusCode || error.response?.status;
    console.error(`[instagram-posts] Error for @${username}: ${status || error.message}`);

    if (status === 429) {
      const retryAfterSec = Math.max(parseInt(error.retryAfterSec || error.response?.headers?.['retry-after'] || '60', 10) || 60, 1);
      return res.status(429).json({
        posts: [],
        username,
        count: 0,
        error: "Sorry, we're temporarily rate-limited while fetching Instagram posts. Please wait and try again.",
        retryAfterSec
      });
    }

    if (status === 500 || status === 404) {
      return res.json({
        posts: [],
        username,
        count: 0,
        message: `@${username}'s posts are unavailable. The account may be private.`
      });
    }

    res.json({
      posts: [],
      username,
      count: 0,
      message: 'Could not load Instagram posts at this time.'
    });
  }
});

app.get('/audio-proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing url parameter');

    let parsed;
    try { parsed = new URL(url); } catch (e) { return res.status(400).send('Invalid url'); }

    const allowedHosts = ['elevenlabs.io', '.amazonaws.com'];
    const ok = allowedHosts.some(h => parsed.hostname.endsWith(h) || parsed.hostname.includes(h));
    if (!ok) return res.status(403).send('Host not allowed');

    const upstream = await axios.get(url, { responseType: 'stream' });
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    res.setHeader('Access-Control-Allow-Origin', '*');
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[audio-proxy] error', err?.response?.data || err.message || err);
    res.status(500).send('Proxy error');
  }
});

app.get('/api/tts/:id', (req, res) => {
  const item = generatedAudioCache.get(req.params.id);
  if (!item) return res.status(404).send('Audio not found or expired');
  res.setHeader('Content-Type', item.contentType || 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(item.buffer);
});

app.get('/api/tts-persist/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT audio_data, content_type FROM tts_audio_store WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).send('Audio not found');
    const row = result.rows[0];
    res.setHeader('Content-Type', row.content_type || 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(row.audio_data);
  } catch (err) {
    console.error('[api/tts-persist] error', err?.message || err);
    res.status(500).send('Audio fetch error');
  }
});

app.get('/api/image-proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('URL is required');

  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { return res.status(400).send('Invalid URL'); }

  const allowedImageHosts = [
    'instagram.com', 'cdninstagram.com', 'instagramcdn.com', 'scontent',
    'fbcdn.net', 'akamaized.net', 'akamaihd.net', 'amazonaws.com',
    's3.amazonaws.com', 'elevenlabs.io'
  ];

  const hostAllowed = hostname => allowedImageHosts.some(f => hostname.includes(f));
  const isInstagramPostPage = parsed.hostname.includes('instagram.com') && /^\/p\/|^\/tv\/|^\/reel\//.test(parsed.pathname);

  try {
    let finalImageUrl = null;

    if (isInstagramPostPage) {
      const pageResp = await axios.get(rawUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 15000
      });
      const html = pageResp.data || '';

      const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (ogMatch && ogMatch[1]) finalImageUrl = ogMatch[1];

      if (!finalImageUrl) {
        const dj = html.match(/"display_url":"(https:[^"]+)"/);
        if (dj && dj[1]) finalImageUrl = dj[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      }

      if (!finalImageUrl) {
        const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
        if (ldMatch && ldMatch[1]) {
          try {
            const ld = JSON.parse(ldMatch[1]);
            if (ld && ld.image) {
              if (typeof ld.image === 'string') finalImageUrl = ld.image;
              else if (Array.isArray(ld.image) && ld.image.length) finalImageUrl = ld.image[0];
              else if (ld.image && ld.image.url) finalImageUrl = ld.image.url;
            }
          } catch (e) { }
        }
      }

      if (!finalImageUrl) {
        const disp = html.match(/"display_url":"(https:[^"]+)"/);
        if (disp && disp[1]) finalImageUrl = disp[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
      }

      if (!finalImageUrl) {
        console.warn('[api/image-proxy] could not extract image from instagram page', rawUrl);
        return res.status(502).send('Could not extract image from Instagram page');
      }

      try { finalImageUrl = new URL(finalImageUrl).toString(); } catch (e) { }
    } else {
      finalImageUrl = rawUrl;
    }

    const finalHost = new URL(finalImageUrl).hostname;
    if (!hostAllowed(finalHost)) {
      console.warn('[api/image-proxy] final host not allowed', finalHost, finalImageUrl);
      return res.status(403).send('Host not allowed for proxied images');
    }

    const upstream = await axios.get(finalImageUrl, { responseType: 'stream', timeout: 20000 });

    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    if (upstream.headers['cache-control']) res.setHeader('Cache-Control', upstream.headers['cache-control']);
    res.setHeader('Access-Control-Allow-Origin', '*');

    upstream.data.pipe(res);
    upstream.data.on('error', (err) => {
      console.error('[api/image-proxy] upstream stream error', err?.message || err);
      try { res.destroy(); } catch (e) { }
    });
  } catch (err) {
    console.error('[api/image-proxy] error', err?.response?.status, err?.message || err);
    if (err?.response?.status === 403) return res.status(403).send('Forbidden by upstream host');
    return res.status(502).send('Failed to proxy image');
  }
});

// Backward-compatible alias for older frontend URLs
app.get('/image-proxy', (req, res) => {
  const q = new URLSearchParams(req.query || {}).toString();
  return res.redirect(307, `/api/image-proxy${q ? `?${q}` : ''}`);
});


// ======================== Protected Endpoints ========================

// --- Helper: get the latest active persona for a user ---
async function getActivePersona(userId) {
  const result = await pool.query(
    'SELECT * FROM personas WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

// --- Helper: get chat history from DB ---
async function getChatHistory(personaId) {
  const result = await pool.query(
    'SELECT role, text, audio_url FROM chat_messages WHERE persona_id = $1 ORDER BY created_at ASC',
    [personaId]
  );
  return result.rows.map(row => ({
    role: row.role,
    parts: [{ text: row.text }],
    ...(row.audio_url ? { audioUrl: row.audio_url } : {})
  }));
}

// --- In-memory processing lock per user (prevents double-sends) ---
const processingUsers = new Map(); // userId -> timestamp
const rateLimitStore = new Map(); // key -> { count, resetAt }

function getClientIp(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
    return xForwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function buildRateLimitKey(prefix, req, userScoped = false) {
  if (userScoped && req.user?.id) return `${prefix}:user:${req.user.id}`;
  return `${prefix}:ip:${getClientIp(req)}`;
}

function checkInMemoryRateLimit(req, options) {
  const { prefix, limit, windowMs, message, userScoped = false } = options;
  const now = Date.now();
  const key = buildRateLimitKey(prefix, req, userScoped);
  const current = rateLimitStore.get(key);

  if (!current || now >= current.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (current.count >= limit) {
    const retryAfterSec = Math.max(Math.ceil((current.resetAt - now) / 1000), 1);
    return {
      allowed: false,
      retryAfterSec,
      message: message || 'Too many requests. Please wait a moment and try again.'
    };
  }

  current.count += 1;
  rateLimitStore.set(key, current);
  return { allowed: true };
}

function applyInMemoryRateLimit(req, res, next, options) {
  const result = checkInMemoryRateLimit(req, options);
  if (result.allowed) return next();
  res.setHeader('Retry-After', String(result.retryAfterSec));
  return res.status(429).json({
    error: result.message,
    retryAfterSec: result.retryAfterSec
  });
}

function rapidApiGenerateLimiter(req, res, next) {
  return applyInMemoryRateLimit(req, res, next, {
    prefix: 'rapidapi-generate',
    limit: RAPIDAPI_GENERATE_LIMIT,
    windowMs: RAPIDAPI_WINDOW_MS,
    userScoped: true,
    message: "Sorry, we're getting a lot of requests right now. Please wait a bit and try generating again."
  });
}

function authLoginLimiter(req, res, next) {
  return applyInMemoryRateLimit(req, res, next, {
    prefix: 'auth-login',
    limit: AUTH_LOGIN_LIMIT,
    windowMs: AUTH_LOGIN_WINDOW_MS,
    userScoped: false,
    message: "Too many login attempts from this network. Please wait and try again."
  });
}

function rapidApiPostsLimiter(req, res, next) {
  return applyInMemoryRateLimit(req, res, next, {
    prefix: 'rapidapi-posts',
    limit: RAPIDAPI_POSTS_LIMIT,
    windowMs: RAPIDAPI_WINDOW_MS,
    userScoped: false,
    message: "Sorry, we've hit the profile fetch limit for now. Please wait a bit and try again."
  });
}

function getUtcDayKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function getUtcMonthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getUtcDayPeriod(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
  return {
    key: getUtcDayKey(date),
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function getUtcMonthPeriod(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return {
    key: getUtcMonthKey(date),
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function isAdminEmail(email) {
  if (!email) return false;
  if (ADMIN_EMAILS.length === 0) return false;
  return ADMIN_EMAILS.includes(String(email).toLowerCase());
}

function secondsUntil(isoDate, now = Date.now()) {
  return Math.max(Math.ceil((new Date(isoDate).getTime() - now) / 1000), 1);
}

async function getUsageCountForPeriod(periodType, periodKey) {
  const result = await pool.query(
    `SELECT count, period_start, period_end
     FROM api_usage_counters
     WHERE source = 'rapidapi' AND period_type = $1 AND period_key = $2
     LIMIT 1`,
    [periodType, periodKey]
  );
  return result.rows[0] || null;
}

async function checkAndConsumeUsage(client, options) {
  const { source, periodType, periodKey, periodStart, periodEnd, limit } = options;
  await client.query(
    `INSERT INTO api_usage_counters (source, period_type, period_key, count, period_start, period_end)
     VALUES ($1, $2, $3, 0, $4, $5)
     ON CONFLICT (source, period_type, period_key) DO NOTHING`,
    [source, periodType, periodKey, periodStart, periodEnd]
  );

  const locked = await client.query(
    `SELECT count, period_end
     FROM api_usage_counters
     WHERE source = $1 AND period_type = $2 AND period_key = $3
     FOR UPDATE`,
    [source, periodType, periodKey]
  );

  const row = locked.rows[0];
  if (!row) {
    throw new Error(`Usage counter missing for ${source}:${periodType}:${periodKey}`);
  }

  if (row.count >= limit) {
    return { allowed: false, retryAfterSec: secondsUntil(row.period_end) };
  }

  await client.query(
    `UPDATE api_usage_counters
     SET count = count + 1, updated_at = NOW()
     WHERE source = $1 AND period_type = $2 AND period_key = $3`,
    [source, periodType, periodKey]
  );

  return { allowed: true };
}

async function consumeRapidApiBudget() {
  const now = new Date();
  const dayPeriod = getUtcDayPeriod(now);
  const monthPeriod = getUtcMonthPeriod(now);
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const monthly = await checkAndConsumeUsage(client, {
      source: 'rapidapi',
      periodType: 'month',
      periodKey: monthPeriod.key,
      periodStart: monthPeriod.start,
      periodEnd: monthPeriod.end,
      limit: RAPIDAPI_MONTHLY_BUDGET
    });

    if (!monthly.allowed) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        statusCode: 429,
        error: "Sorry, we've reached this month's API budget. Please wait until next month.",
        retryAfterSec: monthly.retryAfterSec
      };
    }

    const daily = await checkAndConsumeUsage(client, {
      source: 'rapidapi',
      periodType: 'day',
      periodKey: dayPeriod.key,
      periodStart: dayPeriod.start,
      periodEnd: dayPeriod.end,
      limit: RAPIDAPI_DAILY_BUDGET
    });

    if (!daily.allowed) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        statusCode: 429,
        error: "Sorry, we've reached today's API budget. Please try again later.",
        retryAfterSec: daily.retryAfterSec
      };
    }

    await client.query('COMMIT');
    return { allowed: true };
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {}
    }
    console.error('[consumeRapidApiBudget] error:', err);
    return {
      allowed: false,
      statusCode: 503,
      error: "Sorry, we couldn't check API quota right now. Please try again shortly."
    };
  } finally {
    if (client) client.release();
  }
}

async function rapidApiGlobalBudgetLimiter(req, res, next) {
  const budget = await consumeRapidApiBudget();
  if (budget.allowed) return next();
  if (budget.retryAfterSec) {
    res.setHeader('Retry-After', String(budget.retryAfterSec));
  }
  return res.status(budget.statusCode || 429).json({
    error: budget.error,
    ...(budget.retryAfterSec ? { retryAfterSec: budget.retryAfterSec } : {})
  });
}


// ---------- Generate Persona ----------
app.post('/generate-persona', authenticateToken, async (req, res) => {
  const { username, voiceId } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required.' });

  try {
    // 1. Fetch profile info + posts (DB cache first, RapidAPI on cache miss)
    const profileResult = await getInstagramProfileWithCache(username, req, {
      allowStaleOnError: true,
      cacheTtlMs: INSTAGRAM_CACHE_TTL_MS,
      rateLimitKind: 'generate'
    });
    const userData = profileResult.profileData || {};
    const hdPicUrl = userData.profile_pic_url_hd || userData.profile_pic_url || '';

    // â”€â”€ 2. Extract captions from embedded posts (no extra API call!) â”€â”€
    const edges = userData.edge_owner_to_timeline_media?.edges || [];
    const recentCaptions = edges
      .map(e => e.node?.edge_media_to_caption?.edges?.[0]?.node?.text)
      .filter(Boolean)
      .slice(0, 8);
    console.log(`[generate-persona] Extracted ${recentCaptions.length} captions for @${username} (1 API call)`);

    // â”€â”€ 3. Build profile context â”€â”€
    const followerCount = userData.edge_followed_by?.count || 0;
    const followingCount = userData.edge_follow?.count || 0;
    const mediaCount = userData.edge_owner_to_timeline_media?.count || 0;
    const displayName = userData.full_name || userData.username;
    const followerStr = followerCount
      ? (followerCount >= 1_000_000
          ? (followerCount / 1_000_000).toFixed(1) + 'M'
          : followerCount >= 1_000
            ? (followerCount / 1_000).toFixed(0) + 'K'
            : String(followerCount))
      : 'Unknown';

    const profileContext = [
      `Name: ${displayName}`,
      `Username: @${userData.username}`,
      `Bio: ${userData.biography || 'No bio'}`,
      `Followers: ${followerStr}`,
      followingCount ? `Following: ${followingCount}` : null,
      mediaCount ? `Posts: ${mediaCount}` : null,
      userData.category_name || userData.business_category_name ? `Category: ${userData.category_name || userData.business_category_name}` : null,
      userData.is_verified ? 'Verified: Yes âœ“' : null,
      userData.is_business_account ? 'Account Type: Business/Creator' : null,
      userData.external_url ? `Website: ${userData.external_url}` : null,
    ].filter(Boolean).join('\n');

    const captionsBlock = recentCaptions.length > 0
      ? `\n\nRECENT POST CAPTIONS:\n${recentCaptions.map((c, i) => `${i + 1}. "${c.substring(0, 300)}"`).join('\n')}`
      : '';

    // â”€â”€ 4. Voice pre-selection (try heuristic first, no API call) â”€â”€
    let voiceConfig;
    if (voiceId) {
      const allVoices = [...voices.male, ...voices.female];
      voiceConfig = allVoices.find(v => v.voiceId === voiceId);
    }
    if (!voiceConfig) {
      voiceConfig = await selectVoiceByGender(userData.full_name, userData.biography, userData.username);
    }
    const needGenderFromAnalysis = !voiceConfig; // true if heuristic failed

    // â”€â”€ 5. Single Groq call: personality analysis + gender (if needed) â”€â”€
    let personalityAnalysis = '';
    try {
      const genderLine = needGenderFromAnalysis
        ? '\n6. GENDER: State "GENDER: male" or "GENDER: female" based on the profile.'
        : '';

      const analysisPrompt = `You are an expert personality analyst. Analyze this Instagram profile and their recent posts to build a detailed personality profile. Be specific and creative.

PROFILE:
${profileContext}
${captionsBlock}

Based on this data, provide a concise personality analysis covering:
1. COMMUNICATION STYLE: How do they talk? Formal/casual? Short/long messages? Do they use emojis? Slang? Which language nuances?
2. PERSONALITY TRAITS: Are they funny, serious, motivational, sarcastic, wholesome, edgy, etc.?
3. INTERESTS & PASSIONS: What do they care about most based on their bio and posts?
4. TONE & ENERGY: High-energy hype person? Calm and reflective? Playful jokester?
5. UNIQUE QUIRKS: Any distinctive catchphrases, habits, or communication patterns visible from their posts?${genderLine}

Keep the analysis under 200 words. Be specific, not generic.`;

      const analysisText = await groqGenerateWithRetry(analysisPrompt);

      // Extract gender if we needed it
      if (needGenderFromAnalysis) {
        const genderMatch = analysisText.match(/GENDER:\s*(male|female)/i);
        const detectedGender = genderMatch ? genderMatch[1].toLowerCase() : 'male';
        voiceConfig = detectedGender === 'female' ? voices.female[0] : voices.male[0];
        console.log(`[generate-persona] Gender from analysis: ${detectedGender}`);
        // Remove the gender line from the analysis text
        personalityAnalysis = analysisText.replace(/\n?\d*\.?\s*GENDER:\s*(male|female)/i, '').trim();
      } else {
        personalityAnalysis = analysisText;
      }

      console.log(`[generate-persona] Groq personality analysis for @${username}: ${personalityAnalysis.substring(0, 200)}...`);
    } catch (err) {
      console.log(`[generate-persona] Groq analysis failed for @${username}: ${err.message}`);
      personalityAnalysis = 'Friendly, approachable, and engaging communicator who enjoys connecting with fans.';
      if (!voiceConfig) voiceConfig = voices.male[0]; // safe fallback
    }

    const voiceStyleProfile = deriveVoiceStyleProfile(personalityAnalysis);
    console.log(`[generate-persona] Selected voice for @${username}: ${voiceConfig.voiceId} (${voiceConfig.description}) | style=${voiceStyleProfile.presetName}`);

    // 6. Build the system prompt
    const recentCaptionLines = recentCaptions.length > 0
      ? `\nRecent captions to match tone:\n${recentCaptions.slice(0, 4).map(c => `- "${c.substring(0, 150)}"`).join('\n')}`
      : '';

    const personaPrompt = `You are ${displayName} (@${userData.username}).
You are this person in chat. Do not mention AI, assistant, chatbot, or language model.

Core rules:
- Stay fully in character.
- Keep responses short and natural like Instagram DMs.
- If unsure, say so naturally. Do not invent uncertain facts.
- Be warm, engaging, and consistent with this persona.

Identity context:
${profileContext}

Personality analysis:
${personalityAnalysis}

Style guidance:
- Match this person's tone and word choice.
- Use casual language that feels authentic.
- Ask follow-up questions when natural.
- Keep most replies to 1-3 sentences.${recentCaptionLines}

Final rule: Always respond as ${displayName}.`;

    console.log(`[generate-persona] Persona prompt for @${username} (${personaPrompt.length} chars)`);

    // â”€â”€ 7. Save persona to DB (deactivate old ones, keep them) â”€â”€
    await pool.query('UPDATE personas SET is_active = false WHERE user_id = $1', [req.user.id]);

    const insertResult = await pool.query(
      `INSERT INTO personas (user_id, ig_username, name, bio, profile_pic_url, voice_id, voice_style, voice_description, voice_settings, posts_snapshot, system_instruction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11) RETURNING id`,
      [
        req.user.id,
        userData.username,
        displayName,
        userData.biography || '',
        hdPicUrl,
        voiceConfig.voiceId,
        voiceStyleProfile.presetName,
        `${voiceConfig.description} - ${voiceStyleProfile.styleLabel}`,
        JSON.stringify(voiceStyleProfile.voiceSettings),
        JSON.stringify(extractPostsFromProfile(userData, 24)),
        personaPrompt
      ]
    );

    console.log(`[generate-persona] Persona saved to DB, id=${insertResult.rows[0].id}`);

    res.status(200).json({
      message: 'Persona created successfully!',
      personaDetails: {
        name: displayName,
        username: userData.username,
        bio: userData.biography,
        profile_pic_url: hdPicUrl,
        posts: extractPostsFromProfile(userData, 24),
        voiceId: voiceConfig.voiceId,
        voiceDescription: `${voiceConfig.description} - ${voiceStyleProfile.styleLabel}`,
        voiceStylePreset: voiceStyleProfile.presetName
      }
    });
  } catch (error) {
    console.error('Error generating persona:', error.response ? error.response.data : error.message);

    if ((error.statusCode || error.response?.status) === 429) {
      const retryAfterSec = Math.max(parseInt(error.retryAfterSec || error.response?.headers?.['retry-after'] || '60', 10) || 60, 1);
      return res.status(429).json({
        error: error.message || "Sorry, we're temporarily rate-limited while creating personas. Please wait and try again.",
        retryAfterSec
      });
    }

    res.status(500).json({ error: 'Failed to generate persona. Please check the username.' });
  }
});


// ---------- Chat ----------
app.post('/chat', authenticateToken, async (req, res) => {
  const { message } = req.body;
  const userId = req.user.id;

  const persona = await getActivePersona(userId);
  if (!persona) {
    return res.status(400).json({ error: 'Persona not set. Please create a persona first.' });
  }

  // Simple processing lock (120s to accommodate retries on rate limits)
  const lastProcessing = processingUsers.get(userId);
  if (lastProcessing && (Date.now() - lastProcessing) < 120000) {
    console.warn('[chat] request rejected: user busy');
    return res.status(429).json({ error: 'Still processing previous message. Please wait.' });
  }
  processingUsers.set(userId, Date.now());

  // Truncate long user inputs (max 500 chars)
  let userMessage = (message && String(message).trim()) || '';
  if (userMessage.length > 500) {
    userMessage = userMessage.substring(0, 500);
    console.log('[chat] User message truncated to 500 chars');
  }

  // If empty message, return a canned greeting (NO Groq call)
  if (!userMessage) {
    const greetings = [
      "Hey! What's good?",
      "Yo, what's up?",
      "Hey there! Glad you stopped by.",
      "What's going on?",
      "Hey! How's it going?",
    ];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    // Save greeting to DB so it persists on refresh
    await pool.query(
      'INSERT INTO chat_messages (persona_id, role, text) VALUES ($1, $2, $3)',
      [persona.id, 'model', greeting]
    );
    processingUsers.delete(userId);
    console.log('[chat] Canned greeting (no Groq call)');
    return res.status(200).json({ response: greeting, audioUrl: null, history: await getChatHistory(persona.id) });
  }

  try {
    // Get existing chat history from DB
    const dbHistory = await getChatHistory(persona.id);

    // Add user message to DB
    const lastEntry = dbHistory[dbHistory.length - 1];
    if (!(lastEntry && lastEntry.role === 'user' && lastEntry.parts?.[0]?.text === userMessage)) {
      await pool.query(
        'INSERT INTO chat_messages (persona_id, role, text) VALUES ($1, $2, $3)',
        [persona.id, 'user', userMessage]
      );
      dbHistory.push({ role: 'user', parts: [{ text: userMessage }] });
      console.log('[chat] User message added:', userMessage.substring(0, 50));
    }

    // â”€â”€ HARD CAP: system instruction + last 6 messages â”€â”€
    // If history is long, summarize older messages into a memory block
    const MAX_HISTORY = 6;
    let memoryBlock = '';
    let recentHistory;

    if (dbHistory.length > MAX_HISTORY) {
      // Older messages â†’ compact summary (no API call, just concatenate key points)
      const olderMessages = dbHistory.slice(0, dbHistory.length - MAX_HISTORY);
      memoryBlock = '\n[Previous conversation summary: ' +
        olderMessages.map(m => {
          const text = String(m.parts?.[0]?.text || '').substring(0, 80);
          return `${m.role === 'user' ? 'User' : 'You'}: ${text}`;
        }).join(' | ') + ']\n';
      recentHistory = dbHistory.slice(-MAX_HISTORY);
      console.log(`[chat] History capped: ${dbHistory.length} â†’ ${MAX_HISTORY} recent + memory summary (${olderMessages.length} older msgs)`);
    } else {
      recentHistory = dbHistory;
    }

    // Format for Groq â€” only recent messages
    const formattedHistory = recentHistory.map(msg => ({
      role: msg.role === 'model' ? 'assistant' : 'user',
      text: String(msg.parts?.[0]?.text || '').substring(0, 600)
    }));

    console.log('[chat] History sent to Groq:', formattedHistory.length, 'messages');

    const generationConfig = {
      maxOutputTokens: 400,
      temperature: 0.7,
      topP: 0.9
    };

    // Build prompt â€” system instruction is already set via systemInstruction param
    // Just include memory block (if any) + the user message
    let fullPrompt;
    if (memoryBlock) {
      fullPrompt = `${memoryBlock}\n${userMessage}`;
    } else {
      fullPrompt = userMessage;
    }

    console.log('[chat] Sending to Groq (prompt length:', fullPrompt.length, 'chars)...');

    // Send via semaphore-controlled retry with model fallback
    let groqText = await groqChatWithRetry(fullPrompt, formattedHistory, generationConfig, persona.system_instruction);
    groqText = String(groqText || '').trim();
    console.log('[chat] Response length:', groqText.length);
    console.log('[chat] Response preview:', groqText.substring(0, 100));

    // Clean up AI-like phrases (catch generic assistant responses)
    const aiPhrases = [
      /as an ai\s*/gi, /i'?m an ai\s*/gi, /i'?m a friendly ai\s*/gi,
      /i don'?t have feelings/gi, /i cannot actually/gi, /i'?m not actually/gi,
      /i'?m just a language model/gi, /i don'?t have personal experiences/gi,
      /as a language model/gi, /how can i help you\??/gi, /how can i assist/gi,
      /i'?m here to help[!.]?/gi, /here to assist/gi, /i'?m here to assist/gi,
      /my purpose is to be helpful[^.]*\./gi, /i cannot respond to your request/gi,
      /i'?m not able to generate[^.]*\./gi, /if you have another request[^.]*\./gi,
      /what can i do for you today\??/gi, /i would be happy to assist you[.]?/gi,
      /i'?m here and ready to help[!.]?/gi, /i am not able to[^.]*\./gi,
      /that includes using respectful language[.]?/gi,
      /i'?m sorry,? but i cannot[^.]*\./gi,
    ];
    let cleanedText = groqText;
    aiPhrases.forEach(phrase => { cleanedText = cleanedText.replace(phrase, ''); });
    if (cleanedText.trim().length < 3 && groqText.length > 10) {
      cleanedText = "hey! what's up?";
      console.log('[chat] AI phrases removed too much text, using fallback greeting');
    } else {
      groqText = cleanedText;
    }

    // Remove persona name prefix
    const personaName = (persona.name || '').trim();
    if (personaName && groqText.toLowerCase().startsWith(personaName.toLowerCase())) {
      groqText = groqText.substring(personaName.length).replace(/^[\s:\-—–]+/, '').trim();
      console.log('[chat] Removed persona name prefix');
    }

    if (!groqText || groqText.length === 0) {
      console.error('[chat] Empty response from Groq!');
      groqText = "Hey! Sorry, can you say that again?";
    }

    // Voice config from persona
    const voiceConfig = {
      voiceId: persona.voice_id || ELEVENLABS_DEFAULT_VOICE_ID,
      style: persona.voice_style || 'Conversational',
      description: persona.voice_description || 'Default voice',
      settings: (persona.voice_settings && typeof persona.voice_settings === 'object')
        ? persona.voice_settings
        : deriveVoiceStyleProfile(persona.system_instruction || '').voiceSettings
    };

    console.log(`[chat] Using voice: ${voiceConfig.voiceId}`);

    // Generate audio with ElevenLabs
    let audioUrl = null;
    try {
      if (groqText && groqText.trim().length > 0) {
        console.log('[chat] Requesting ElevenLabs TTS...');
        const elevenLabs = await getElevenLabsClient();
        const audio = await elevenLabs.textToSpeech.convert(voiceConfig.voiceId, {
          text: groqText.trim(),
          modelId: ELEVENLABS_MODEL_ID,
          outputFormat: ELEVENLABS_OUTPUT_FORMAT,
          voiceSettings: voiceConfig.settings
        });
        const audioBuffer = await audioToBuffer(audio);
        if (audioBuffer && audioBuffer.length > 0) {
          // Store in DB-backed persistent audio store so links survive restarts.
          audioUrl = await persistGeneratedAudio(audioBuffer, 'audio/mpeg');
          console.log('[chat] ElevenLabs TTS success');
        } else {
          console.warn('[chat] ElevenLabs TTS returned empty audio');
        }
      }
    } catch (err) {
      console.error('[chat] ElevenLabs TTS error:', err?.response?.data || err.message);
    }

    // Save model message to DB
    await pool.query(
      'INSERT INTO chat_messages (persona_id, role, text, audio_url) VALUES ($1, $2, $3, $4)',
      [persona.id, 'model', groqText, audioUrl]
    );
    console.log('[chat] Model response saved to DB');

    // Clear processing lock
    processingUsers.delete(userId);

    // Return full history
    const fullHistory = await getChatHistory(persona.id);

    res.status(200).json({
      response: groqText,
      audioUrl: audioUrl,
      history: fullHistory
    });

  } catch (error) {
    console.error('Error in chat endpoint:', error.message || error);
    processingUsers.delete(userId);

    if (isRetryableError(error)) {
      return res.status(429).json({
        error: 'The AI is temporarily busy. Please wait a moment and try again.'
      });
    }

    res.status(500).json({
      error: 'Failed to get a response from the AI.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'Chat.html'));
});

app.post('/new-chat', authenticateToken, async (req, res) => {
  try {
    // Deactivate current persona (keep it in library) and clear its chat
    const persona = await getActivePersona(req.user.id);
    if (persona) {
      await pool.query('DELETE FROM chat_messages WHERE persona_id = $1', [persona.id]);
      await pool.query('UPDATE personas SET is_active = false WHERE id = $1', [persona.id]);
    }
    res.status(200).json({ message: 'Chat session cleared.' });
  } catch (err) {
    console.error('[new-chat] error', err);
    res.status(500).json({ error: 'Could not clear session.' });
  }
});

// ---------- Persona Library ----------

// List all personas (global library)
app.get('/api/personas', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (ig_username) id, ig_username, name, bio, profile_pic_url, voice_id, voice_description, created_at,
              (user_id = $1 AND is_active = true) AS is_mine_active
       FROM personas
       ORDER BY ig_username, created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[api/personas] error', err);
    res.status(500).json({ error: 'Could not fetch personas.' });
  }
});

// Activate an existing persona for the current user
app.post('/api/personas/:id/activate', authenticateToken, async (req, res) => {
  try {
    const personaId = parseInt(req.params.id);
    // Check persona exists
    const persona = await pool.query('SELECT * FROM personas WHERE id = $1', [personaId]);
    if (!persona.rows.length) return res.status(404).json({ error: 'Persona not found.' });

    const src = persona.rows[0];

    // Deactivate user's current active persona
    await pool.query('UPDATE personas SET is_active = false WHERE user_id = $1', [req.user.id]);

    // Check if user already has this ig_username persona
    const existing = await pool.query(
      'SELECT id FROM personas WHERE user_id = $1 AND ig_username = $2',
      [req.user.id, src.ig_username]
    );

    let activeId;
    if (existing.rows.length) {
      // Reactivate existing
      activeId = existing.rows[0].id;
      await pool.query('UPDATE personas SET is_active = true WHERE id = $1', [activeId]);
    } else {
      // Clone persona for this user
      const ins = await pool.query(
        `INSERT INTO personas (user_id, ig_username, name, bio, profile_pic_url, voice_id, voice_style, voice_description, voice_settings, posts_snapshot, system_instruction, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,true) RETURNING id`,
        [req.user.id, src.ig_username, src.name, src.bio, src.profile_pic_url, src.voice_id, src.voice_style, src.voice_description, JSON.stringify(src.voice_settings || {}), JSON.stringify(src.posts_snapshot || []), src.system_instruction]
      );
      activeId = ins.rows[0].id;
    }

    const active = await pool.query('SELECT * FROM personas WHERE id = $1', [activeId]);
    const p = active.rows[0];

    res.json({
      message: 'Persona activated!',
      personaDetails: {
        name: p.name,
        username: p.ig_username,
        bio: p.bio,
        profile_pic_url: p.profile_pic_url,
        posts: Array.isArray(p.posts_snapshot) ? p.posts_snapshot : [],
        voiceId: p.voice_id,
        voiceDescription: p.voice_description
      }
    });
  } catch (err) {
    console.error('[api/personas/activate] error', err);
    res.status(500).json({ error: 'Could not activate persona.' });
  }
});

// Delete a persona permanently
app.delete('/api/personas/:id', authenticateToken, async (req, res) => {
  try {
    const personaId = parseInt(req.params.id);
    // Only allow deleting own personas
    await pool.query('DELETE FROM personas WHERE id = $1 AND user_id = $2', [personaId, req.user.id]);
    res.json({ message: 'Persona deleted.' });
  } catch (err) {
    console.error('[api/personas/delete] error', err);
    res.status(500).json({ error: 'Could not delete persona.' });
  }
});

// Delete chat history only (keep persona)
app.delete('/api/chat-history', authenticateToken, async (req, res) => {
  try {
    const persona = await getActivePersona(req.user.id);
    if (persona) {
      await pool.query('DELETE FROM chat_messages WHERE persona_id = $1', [persona.id]);
    }
    res.json({ message: 'Chat history cleared.' });
  } catch (err) {
    console.error('[api/chat-history/delete] error', err);
    res.status(500).json({ error: 'Could not clear chat.' });
  }
});

app.get('/get-chat-history', authenticateToken, async (req, res) => {
  try {
    const persona = await getActivePersona(req.user.id);
    if (!persona) return res.status(200).json([]);
    const history = await getChatHistory(persona.id);
    res.status(200).json(history);
  } catch (err) {
    console.error('[get-chat-history] error', err);
    res.status(500).json([]);
  }
});

app.get('/api/admin/rapidapi-usage', authenticateToken, async (req, res) => {
  try {
    if (!isAdminEmail(req.user?.email)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const now = new Date();
    const dayPeriod = getUtcDayPeriod(now);
    const monthPeriod = getUtcMonthPeriod(now);

    const [dayUsage, monthUsage] = await Promise.all([
      getUsageCountForPeriod('day', dayPeriod.key),
      getUsageCountForPeriod('month', monthPeriod.key)
    ]);

    const dayCount = dayUsage?.count || 0;
    const monthCount = monthUsage?.count || 0;

    res.json({
      source: 'rapidapi',
      nowUtc: now.toISOString(),
      daily: {
        periodKey: dayPeriod.key,
        used: dayCount,
        limit: RAPIDAPI_DAILY_BUDGET,
        remaining: Math.max(RAPIDAPI_DAILY_BUDGET - dayCount, 0),
        resetAt: dayUsage?.period_end || dayPeriod.end
      },
      monthly: {
        periodKey: monthPeriod.key,
        used: monthCount,
        limit: RAPIDAPI_MONTHLY_BUDGET,
        remaining: Math.max(RAPIDAPI_MONTHLY_BUDGET - monthCount, 0),
        resetAt: monthUsage?.period_end || monthPeriod.end
      }
    });
  } catch (err) {
    console.error('[api/admin/rapidapi-usage] error', err);
    res.status(500).json({ error: 'Could not fetch RapidAPI usage.' });
  }
});

// Debug endpoint â€” only available in development
if (process.env.NODE_ENV !== 'production') {
  app.get('/debug-session', authenticateToken, async (req, res) => {
    try {
      const persona = await getActivePersona(req.user.id);
      const history = persona ? await getChatHistory(persona.id) : [];
      res.status(200).json({
        userId: req.user.id,
        hasPersona: !!persona,
        personaName: persona?.name || null,
        voiceConfig: persona ? { voiceId: persona.voice_id, style: persona.voice_style, description: persona.voice_description, settings: persona.voice_settings || null } : null,
        chatHistoryLength: history.length,
        chatHistory: history
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Serve index.html for the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'index.html'));
});


// ======================== Start Server ========================
(async () => {
  try {
    validateStartupConfig();
    await initDB();
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();




