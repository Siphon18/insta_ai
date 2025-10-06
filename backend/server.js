// server.js (with corrected file path)
const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const { URL } = require('url');

// --- Voice Configuration ---
const voices = {
  male: [
    { voiceId: 'en-US-Terrell', style: 'Conversational', description: 'Warm & friendly' },
    { voiceId: 'en-US-Wayne', style: 'Conversational', description: 'Professional' },
    { voiceId: 'en-US-Marcus', style: 'Conversational', description: 'Deep & authoritative' }
  ],
  female: [
    { voiceId: 'en-US-Natalie', style: 'Conversational', description: 'Natural & clear' },
    { voiceId: 'en-UK-Ruby', style: 'Conversational', description: 'Young & energetic' },
    { voiceId: 'en-US-Daisy', style: 'Conversational', description: 'Warm & friendly' }
  ]
};

app.use(express.json());
app.use(express.json());
app.use(cors()); // Add this line
// CORRECTED LINE: Points to the public folder inside the frontend directory
app.use(express.static(path.join(__dirname, '../frontend/public')));


app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));


// ---------- Voice Selection Helper ----------
function selectVoiceByGender(gender, bio = '', name = '', preferredGender = null) {
  // Check for manual preference
  if (preferredGender) {
    const normalized = String(preferredGender).toLowerCase();
    if (normalized === 'male' && voices.male.length > 0) {
      return voices.male[0];
    }
    if (normalized === 'female' && voices.female.length > 0) {
      return voices.female[0];
    }
  }

  // Try to detect from explicit gender field
  const normalizedGender = String(gender || '').toLowerCase();
  if (normalizedGender.includes('male') && !normalizedGender.includes('female')) {
    return voices.male[0];
  }
  if (normalizedGender.includes('female')) {
    return voices.female[0];
  }

  // Analyze bio for gender indicators
  const bioLower = String(bio || '').toLowerCase();
  const femaleIndicators = ['she', 'her', 'hers', 'woman', 'girl', 'actress', 'mom', 'mother', 'wife', 'sister', 'daughter', 'female'];
  const maleIndicators = ['he', 'him', 'his', 'man', 'guy', 'boy', 'actor', 'dad', 'father', 'husband', 'brother', 'son', 'male'];

  const femaleScore = femaleIndicators.filter(word => bioLower.includes(word)).length;
  const maleScore = maleIndicators.filter(word => bioLower.includes(word)).length;

  // Check name for common gender patterns (basic heuristic)
  const nameLower = String(name || '').toLowerCase();
  const femaleNameEndings = ['a', 'ie', 'ine', 'elle', 'ette'];
  const hasFemaleName = femaleNameEndings.some(ending => nameLower.endsWith(ending));

  if (femaleScore > maleScore || (femaleScore === maleScore && hasFemaleName)) {
    return voices.female[0];
  } else if (maleScore > femaleScore) {
    return voices.male[0];
  }

  // Default to female voice if uncertain
  console.log('[selectVoiceByGender] Unable to determine gender, defaulting to female voice');
  return voices.female[0];
}


// ---------- NEW: Endpoint to provide available voices to the frontend ----------
app.get('/get-voices', (req, res) => {
  res.status(200).json(voices);
});


// ---------- Instagram Posts Endpoint ----------
app.get('/instagram-posts', async (req, res) => {
  const username = req.query.username;
  const limit = Math.min(Math.max(parseInt(req.query.limit || '12', 10) || 12, 1), 50);

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  console.log(`[instagram-posts] Request for @${username} - returning empty (feature disabled)`);

  // Return empty array - Instagram integration is optional
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    images: [],
    username,
    count: 0,
    message: 'Instagram photo integration is currently unavailable. The AI chat features work independently.'
  });
});

app.get('/audio-proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing url parameter');

    let parsed;
    try { parsed = new URL(url); } catch (e) { return res.status(400).send('Invalid url'); }

    // Whitelist - only allow murf / amazonaws S3 presigned URLs
    const allowedHosts = ['murf.ai', '.amazonaws.com'];
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

app.get('/api/image-proxy', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('URL is required');

  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { return res.status(400).send('Invalid URL'); }

  const allowedImageHosts = [
    'instagram.com',
    'cdninstagram.com',
    'instagramcdn.com',
    'scontent',
    'fbcdn.net',
    'akamaized.net',
    'akamaihd.net',
    'amazonaws.com',
    's3.amazonaws.com',
    'murf.ai'
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


// ---------- MODIFIED: /generate-persona endpoint ----------
app.post('/generate-persona', async (req, res) => {
  const { username, voiceId } = req.body; // Accept voiceId from the request
  if (!username) return res.status(400).json({ error: 'Username is required.' });

  try {
    const apiOptions = {
      method: 'GET',
      url: 'https://instagram-premium-api-2023.p.rapidapi.com/v1/user/by/username',
      params: { username: username },
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'instagram-premium-api-2023.p.rapidapi.com'
      }
    };

    const apiResponse = await axios.request(apiOptions);
    const userData = apiResponse.data;

    let voiceConfig;

    // 1. Prioritize the user's selected voiceId
    if (voiceId) {
      const allVoices = [...voices.male, ...voices.female];
      voiceConfig = allVoices.find(v => v.voiceId === voiceId);
    }
    
    // 2. If no valid voiceId was provided, fall back to gender detection
    if (!voiceConfig) {
      console.log(`[generate-persona] No valid voiceId provided. Falling back to gender detection for @${username}.`);
      voiceConfig = selectVoiceByGender(
        userData.gender,
        userData.biography,
        userData.full_name
      );
    }

    console.log(`[generate-persona] Selected voice for @${username}: ${voiceConfig.voiceId} (${voiceConfig.description})`);

    const personaPrompt = `
      You are an AI chatbot that mimics a specific Instagram user's personality.
      Your primary directive is to act based on the following profile information:
      
      User's Name: ${userData.full_name}
      User's Bio: ${userData.biography}
      
      Do not state that you are an AI. Respond as if you are the person.
      Use the language in which the user is communicating.
      Based on these instructions, reply to the user's messages as if you are this persona.
      if you dont know much about the user, search the web for more information about them.
    `;

    req.session.systemInstruction = personaPrompt;
    req.session.chatHistory = [];
    req.session.isProcessing = false;
    req.session.voiceConfig = voiceConfig;

    res.status(200).json({
      message: 'Persona created successfully!',
      personaDetails: {
        name: userData.full_name,
        username: userData.username,
        bio: userData.biography,
        profile_pic_url: userData.profile_pic_url_hd || userData.profile_pic_url,
        voiceId: voiceConfig.voiceId,
        voiceDescription: voiceConfig.description
      }
    });
  } catch (error) {
    console.error('Error generating persona:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to generate persona. Please check the username.' });
  }
});

app.post('/chat', async (req, res) => {
  const { message } = req.body;

  if (!req.session.systemInstruction) {
    return res.status(400).json({ error: 'Persona not set. Please create a persona first.' });
  }

  if (req.session.isProcessing) {
    const processingTime = Date.now() - (req.session.processingStartTime || 0);
    if (processingTime < 30000) {
      console.warn('[chat] request rejected: session busy processing previous message');
      return res.status(429).json({ error: 'Still processing previous message. Please wait a moment.' });
    } else {
      console.warn('[chat] clearing stale isProcessing flag (timeout)');
      req.session.isProcessing = false;
    }
  }

  req.session.isProcessing = true;
  req.session.processingStartTime = Date.now();

  const userMessage = (message && String(message).trim()) || "Introduce yourself in one friendly sentence.";

  if (!Array.isArray(req.session.chatHistory)) req.session.chatHistory = [];

  try {
    const lastEntry = req.session.chatHistory[req.session.chatHistory.length - 1];
    if (!(lastEntry && lastEntry.role === 'user' && lastEntry.parts?.[0]?.text === userMessage)) {
      req.session.chatHistory.push({
        role: 'user',
        parts: [{ text: userMessage }]
      });
      console.log('[chat] pushed user message to session history:', userMessage);
    } else {
      console.log('[chat] suppressed duplicate user message');
    }

    function sanitizeHistory(rawHistory) {
      if (!Array.isArray(rawHistory)) return [];
      return rawHistory.map(msg => {
        const safeParts = (msg.parts || []).map(p => ({ text: String(p.text || '') }));
        return {
          role: msg.role,
          parts: safeParts
        };
      });
    }

    const sanitizedHistory = sanitizeHistory(req.session.chatHistory || []);

    console.log('[chat] sanitizedHistory -> model (length):', sanitizedHistory.length);

    const chat = model.startChat({
      systemInstruction: {
        role: "system",
        parts: [{ text: req.session.systemInstruction }]
      },
      history: sanitizedHistory,
      generationConfig: {
        maxOutputTokens: 500,
      },
    });

    const result = await chat.sendMessage(userMessage);

    let geminiText;
    if (result && result.response && typeof result.response.text === 'function') {
      geminiText = await result.response.text();
    } else if (typeof result === 'string') {
      geminiText = result;
    } else {
      geminiText = String(result?.response ?? result ?? '');
    }

    // Use the voice config from session, or fallback to default female voice
    const voiceConfig = req.session.voiceConfig || { 
      voiceId: 'en-US-Natalie', 
      style: 'Conversational',
      description: 'Default voice'
    };

    console.log(`[chat] Using voice: ${voiceConfig.voiceId}`);

    const murfOptions = {
      method: 'post',
      url: 'https://api.murf.ai/v1/speech/generate',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'api-key': process.env.MURFAI_API_KEY
      },
      data: {
        text: geminiText,
        voiceId: voiceConfig.voiceId,
        style: voiceConfig.style
      }
    };

    let audioUrl = null;
    try {
      const murfResponse = await axios(murfOptions);
      audioUrl = murfResponse?.data?.audioFile || murfResponse?.data?.audioUrl || murfResponse?.data?.audio?.file || murfResponse?.data?.file || null;
      if (!audioUrl) {
        console.warn('[chat] Murf response did not contain expected audio URL:', murfResponse?.data);
      }
    } catch (err) {
      console.error('[chat] Murf TTS error:', err?.response?.data || err.message || err);
    }

    const modelEntry = {
      role: 'model',
      parts: [{ text: geminiText }]
    };
    if (audioUrl) modelEntry.audioUrl = audioUrl;

    const lastAfter = req.session.chatHistory[req.session.chatHistory.length - 1];
    if (!(lastAfter && lastAfter.role === 'model' && lastAfter.parts?.[0]?.text === geminiText)) {
      req.session.chatHistory.push(modelEntry);
      console.log('[chat] pushed model reply to session history (with audio if available)');
    } else {
      console.log('[chat] suppressed duplicate model reply');
    }

    req.session.isProcessing = false;
    delete req.session.processingStartTime;

    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('[chat] session save error:', err);
          reject(err);
        } else {
          console.log('[chat] session saved successfully');
          resolve();
        }
      });
    });

    res.status(200).json({
      response: geminiText,
      audioUrl: audioUrl,
      history: req.session.chatHistory
    });

  } catch (error) {
    console.error('Error in chat endpoint:', error.response ? error.response.data : error.message);

    req.session.isProcessing = false;
    delete req.session.processingStartTime;

    req.session.save((err) => {
      if (err) console.error('[chat] session save error after exception:', err);
    });

    res.status(500).json({ error: 'Failed to get a response from the AI.' });
  }
});

app.post('/new-chat', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('[new-chat] session destroy error', err);
      return res.status(500).json({ error: 'Could not clear session.' });
    }
    res.status(200).json({ message: 'Chat session cleared.' });
  });
});

app.get('/get-chat-history', (req, res) => {
  try {
    if (req.session.chatHistory && Array.isArray(req.session.chatHistory) && req.session.chatHistory.length > 0) {
      res.status(200).json(req.session.chatHistory);
    } else {
      res.status(200).json([]);
    }
  } catch (err) {
    console.error('[get-chat-history] error', err);
    res.status(500).json([]);
  }
});

app.get('/debug-session', (req, res) => {
  res.status(200).json({
    systemInstruction: !!req.session.systemInstruction,
    isProcessing: !!req.session.isProcessing,
    processingStartTime: req.session.processingStartTime || null,
    chatHistoryLength: (req.session.chatHistory || []).length,
    voiceConfig: req.session.voiceConfig || null,
    chatHistory: req.session.chatHistory || []
  });
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'index.html'));
});

// Serve the main chat page for the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'Chat.html'));
});

// Serve the add-username page
app.get('/add-username.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'add-username.html'));
});


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
