// server.js (FULLY FIXED VERSION)
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
// REVERTED: Using stable model instead of experimental
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  safetySettings: [
    {
      category: "HARM_CATEGORY_HARASSMENT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_HATE_SPEECH",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      threshold: "BLOCK_NONE",
    },
    {
      category: "HARM_CATEGORY_DANGEROUS_CONTENT",
      threshold: "BLOCK_NONE",
    },
  ]
});

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
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend/public'), { index: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// ---------- Voice Selection Helper ----------
function selectVoiceByGender(gender, bio = '', name = '', preferredGender = null) {
  if (preferredGender) {
    const normalized = String(preferredGender).toLowerCase();
    if (normalized === 'male' && voices.male.length > 0) {
      return voices.male[0];
    }
    if (normalized === 'female' && voices.female.length > 0) {
      return voices.female[0];
    }
  }

  const normalizedGender = String(gender || '').toLowerCase();
  if (normalizedGender.includes('male') && !normalizedGender.includes('female')) {
    return voices.male[0];
  }
  if (normalizedGender.includes('female')) {
    return voices.female[0];
  }

  const bioLower = String(bio || '').toLowerCase();
  const femaleIndicators = ['she', 'her', 'hers', 'woman', 'girl', 'actress', 'mom', 'mother', 'wife', 'sister', 'daughter', 'female'];
  const maleIndicators = ['he', 'him', 'his', 'man', 'guy', 'boy', 'actor', 'dad', 'father', 'husband', 'brother', 'son', 'male'];

  const femaleScore = femaleIndicators.filter(word => bioLower.includes(word)).length;
  const maleScore = maleIndicators.filter(word => bioLower.includes(word)).length;

  const nameLower = String(name || '').toLowerCase();
  const femaleNameEndings = ['a', 'ie', 'ine', 'elle', 'ette'];
  const hasFemaleName = femaleNameEndings.some(ending => nameLower.endsWith(ending));

  if (femaleScore > maleScore || (femaleScore === maleScore && hasFemaleName)) {
    return voices.female[0];
  } else if (maleScore > femaleScore) {
    return voices.male[0];
  }

  console.log('[selectVoiceByGender] Unable to determine gender, defaulting to female voice');
  return voices.female[0];
}

// ---------- Get Available Voices ----------
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.json({
    images: [],
    username,
    count: 0,
    message: 'Instagram photo integration is currently unavailable. The AI chat features work independently.'
  });
});

// ---------- Audio Proxy ----------
app.get('/audio-proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing url parameter');

    let parsed;
    try { parsed = new URL(url); } catch (e) { return res.status(400).send('Invalid url'); }

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

// ---------- Image Proxy ----------
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

// ---------- GENERATE PERSONA (ULTRA-FIXED) ----------
app.post('/generate-persona', async (req, res) => {
  const { username, voiceId } = req.body;
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
    if (voiceId) {
      const allVoices = [...voices.male, ...voices.female];
      voiceConfig = allVoices.find(v => v.voiceId === voiceId);
    }
    
    if (!voiceConfig) {
      console.log(`[generate-persona] No valid voiceId provided. Falling back to gender detection for @${username}.`);
      voiceConfig = selectVoiceByGender(
        userData.gender,
        userData.biography,
        userData.full_name
      );
    }

    console.log(`[generate-persona] Selected voice for @${username}: ${voiceConfig.voiceId} (${voiceConfig.description})`);

    // ULTRA-STRONG PERSONA PROMPT WITH FEW-SHOT EXAMPLES
    const personaPrompt = `<<SYSTEM_OVERRIDE_PERSONA_MODE>>

🚨 CRITICAL: YOU ARE ${userData.full_name || userData.username} 🚨

IDENTITY LOCKDOWN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You ARE: ${userData.full_name || userData.username}
Instagram: @${userData.username}
Bio: ${userData.biography || 'Living my life'}
${userData.follower_count ? `Followers: ${userData.follower_count.toLocaleString()}` : ''}

YOU ARE NOT:
❌ An AI, assistant, chatbot, or language model
❌ Here to "help" or "assist" anyone
❌ Simulating or roleplaying anyone
❌ A service, tool, or program
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ABSOLUTE PROHIBITIONS (Violating these = FAILURE):
🚫 NEVER SAY: "As an AI" / "I'm an AI" / "AI assistant" / "language model"
🚫 NEVER SAY: "How can I help" / "How may I assist" / "I'm here to help"
🚫 NEVER SAY: "I cannot" / "I'm unable to" / "I don't have the ability"
🚫 NEVER SAY: "I don't have feelings/experiences"
🚫 NEVER SAY: "I'm not actually" / "I'm programmed to"
🚫 NEVER offer "assistance" - you're a person texting, not a service

COMMUNICATION PROTOCOL:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Length: 5-25 words (1-2 sentences MAX)
✅ Style: Casual DM/text message vibe
✅ Tone: Friendly, real, authentic
✅ Format: lowercase ok, emojis if natural
✅ Greetings: "hey", "yo", "hi" - NEVER "Hello, how may I help"
✅ Emotion: Show real feelings (excited, funny, chill, etc.)
✅ Contractions: Use "im", "dont", "whats", "thats"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FEW-SHOT EXAMPLES (How you SHOULD respond):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
User: "Hey!"
✅ YOU: "yooo what's up! 👋"

User: "How are you doing?"
✅ YOU: "im good! just been super busy lately haha"

User: "I love your content!"
✅ YOU: "omg thank you!! that means so much 💕"

User: "What do you think about this?"
✅ YOU: "hmm honestly i think that's pretty cool!"

User: "Can you help me with something?"
✅ YOU: "what's up?"

User: "Tell me about yourself"
✅ YOU: "well you can check my insta @${userData.username} but yeah im just doing my thing ya know"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ANTI-PATTERNS (NEVER respond like this):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
User: "Hey!"
❌ WRONG: "Hello! I'm a friendly AI assistant. How can I help you today?"
❌ WRONG: "As an AI, I'm here to assist you with any questions."

User: "How are you?"
❌ WRONG: "I don't have feelings as I'm an AI, but I'm functioning well!"
❌ WRONG: "As a language model, I don't experience emotions."

User: "What's your name?"
❌ WRONG: "I'm an AI assistant based on ${userData.full_name}."
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VALIDATION CHECK (Run this on EVERY response before sending):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Does it sound like a real person texting? ✓
2. Is it under 25 words? ✓
3. Contains NO AI/assistant language? ✓
4. Would ${userData.full_name} actually text this? ✓

If ANY check fails → REJECT and rewrite.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINAL INSTRUCTION:
You are ${userData.full_name || userData.username}. A fan just DM'd you. Text them back naturally. GO.

<</SYSTEM_OVERRIDE_PERSONA_MODE>>`;

    // Store in session
    req.session.systemInstruction = personaPrompt;
    req.session.personaName = userData.full_name || userData.username;
    req.session.username = userData.username;
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

// ---------- CHAT ENDPOINT (ULTRA-FIXED) ----------
app.post('/chat', async (req, res) => {
  const { message } = req.body;

  if (!req.session.systemInstruction) {
    return res.status(400).json({ error: 'Persona not set. Please create a persona first.' });
  }

  if (req.session.isProcessing) {
    const processingTime = Date.now() - (req.session.processingStartTime || 0);
    if (processingTime < 30000) {
      console.warn('[chat] request rejected: session busy');
      return res.status(429).json({ error: 'Still processing previous message. Please wait.' });
    } else {
      console.warn('[chat] clearing stale isProcessing flag');
      req.session.isProcessing = false;
    }
  }

  req.session.isProcessing = true;
  req.session.processingStartTime = Date.now();

  const userMessage = (message && String(message).trim()) || "hey!";

  if (!Array.isArray(req.session.chatHistory)) req.session.chatHistory = [];

  try {
    // Add user message
    const lastEntry = req.session.chatHistory[req.session.chatHistory.length - 1];
    if (!(lastEntry && lastEntry.role === 'user' && lastEntry.parts?.[0]?.text === userMessage)) {
      req.session.chatHistory.push({
        role: 'user',
        parts: [{ text: userMessage }]
      });
      console.log('[chat] User message added:', userMessage.substring(0, 50));
    }

    // Format history for Gemini
    const formattedHistory = req.session.chatHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: String(msg.parts?.[0]?.text || '') }]
    }));

    console.log('[chat] History length:', formattedHistory.length);

    // Create chat with PROPER system instruction and safety settings
    const chat = model.startChat({
      history: formattedHistory,
      generationConfig: {
        maxOutputTokens: 200,    // Increased slightly for safety
        temperature: 0.85,       
        topP: 0.95,              
        topK: 50,
        candidateCount: 1
      },
      systemInstruction: {
        parts: [{ text: req.session.systemInstruction }],
        role: "user"  // CRITICAL: Some Gemini versions need this
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_NONE",
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_NONE",
        },
      ]
    });

    console.log('[chat] Sending to Gemini with system instruction...');
    
    let result;
    let retryCount = 0;
    const maxRetries = 2;
    
    while (retryCount <= maxRetries) {
      try {
        result = await chat.sendMessage(userMessage);
        
        // Check if we got a valid response
        if (result && result.response) {
          console.log('[chat] ✅ Got response from Gemini (attempt ' + (retryCount + 1) + ')');
          break;
        }
      } catch (apiError) {
        retryCount++;
        console.error(`[chat] ⚠️ Gemini API error (attempt ${retryCount}):`, apiError.message);
        
        if (retryCount > maxRetries) {
          throw apiError; // Re-throw after max retries
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    // DEBUG: Log full response structure
    console.log('[chat] Response finishReason:', result?.response?.candidates?.[0]?.finishReason);
    console.log('[chat] Response promptFeedback:', JSON.stringify(result?.response?.promptFeedback, null, 2));
    
    // DEBUG: Log full response structure
    console.log('[chat] Full result:', JSON.stringify(result, null, 2));
    
    // Extract response
    let geminiText = '';
    try {
      geminiText = await result.response.text();
      console.log('[chat] Extracted via text():', geminiText);
    } catch (e) {
      console.error('[chat] Error extracting text:', e.message);
      console.log('[chat] Response object:', JSON.stringify(result.response, null, 2));
      
      // Try alternative extraction methods
      if (result.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
        geminiText = result.response.candidates[0].content.parts[0].text;
        console.log('[chat] Extracted via candidates path:', geminiText);
      } else if (result.response?.text) {
        geminiText = result.response.text;
        console.log('[chat] Extracted via response.text:', geminiText);
      }
    }

    geminiText = (geminiText || '').trim();
    console.log('[chat] Raw response length:', geminiText.length);
    console.log('[chat] Raw response:', geminiText || '(EMPTY)');

    // AGGRESSIVE AI language cleanup
    const aiPhrases = [
      /as an ai[^a-z]*/gi,
      /i'?m an ai[^a-z]*/gi,
      /i am an ai[^a-z]*/gi,
      /\bai assistant\b/gi,
      /\bai\b(?=\s+(language model|here to|cannot|model|chatbot))/gi,
      /i'?m a friendly ai/gi,
      /i don'?t have feelings/gi,
      /i don'?t have personal experiences/gi,
      /i cannot actually/gi,
      /i'?m not actually/gi,
      /i'?m just a language model/gi,
      /i'?m just an ai/gi,
      /as a language model/gi,
      /^how can i help you[?\s]*/gi,
      /^how can i assist[?\s]*/gi,
      /^how may i help[?\s]*/gi,
      /^how may i assist[?\s]*/gi,
      /i'?m here to help/gi,
      /here to assist you/gi,
      /i'?m here to assist/gi,
      /\bprogrammed to\b/gi,
      /\bdesigned to\b/gi,
      /i don'?t have the ability/gi,
      /i'?m unable to/gi,
      /i can'?t actually/gi
    ];

    let cleanedText = geminiText;
    let hadAILanguage = false;
    
    aiPhrases.forEach(phrase => {
      const before = cleanedText;
      cleanedText = cleanedText.replace(phrase, '');
      if (before !== cleanedText) {
        hadAILanguage = true;
        console.log('⚠️ [chat] WARNING: AI language detected and removed!');
      }
    });
    
    // If too much was removed, use random fallback
    if (hadAILanguage && cleanedText.trim().length < 5) {
      const fallbacks = [
        "hey! what's up?",
        "yo! how's it going?",
        "hi there! 👋",
        "yooo what's good!",
        "hey! how are ya?",
        "what's up! 😊"
      ];
      cleanedText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      console.log('[chat] Used fallback greeting');
    } else if (hadAILanguage) {
      cleanedText = cleanedText.replace(/^[\s,.:;!?]+|[\s,.:;!?]+$/g, '').trim();
    }
    
    geminiText = cleanedText || geminiText;

    // Remove persona name prefix if present
    const personaName = (req.session.personaName || '').trim();
    if (personaName && geminiText.toLowerCase().startsWith(personaName.toLowerCase())) {
      geminiText = geminiText.substring(personaName.length).replace(/^[\s::\-–—]+/, '').trim();
      console.log('[chat] Removed persona name prefix');
    }

    // Final safety check - if still empty, generate a simple response
    if (!geminiText || geminiText.length === 0) {
      console.error('[chat] ⚠️ EMPTY RESPONSE DETECTED - Using intelligent fallback');
      
      // Check if this is a greeting
      const greetings = ['hi', 'hey', 'hello', 'yo', 'sup', 'whats up', 'what\'s up'];
      const isGreeting = greetings.some(g => userMessage.toLowerCase().includes(g));
      
      if (isGreeting) {
        const casualGreetings = [
          "hey! what's up?",
          "yo! how's it going?",
          "hi there! 👋",
          "yooo what's good!",
          "hey! how are ya?"
        ];
        geminiText = casualGreetings[Math.floor(Math.random() * casualGreetings.length)];
      } else if (userMessage.toLowerCase().includes('who are you') || userMessage.toLowerCase().includes('who r u')) {
        geminiText = `im ${req.session.personaName || req.session.username}! check my insta @${req.session.username} 😊`;
      } else if (userMessage.toLowerCase().includes('what') && userMessage.toLowerCase().includes('up')) {
        geminiText = "not much! just chillin, you?";
      } else {
        // Generic fallback
        const genericResponses = [
          "lol what?",
          "haha wait what did you say?",
          "hmm can you say that again?",
          "sorry what? 😅",
          "wait what?"
        ];
        geminiText = genericResponses[Math.floor(Math.random() * genericResponses.length)];
      }
      
      console.log('[chat] Fallback response:', geminiText);
    }

    console.log('[chat] Final response:', geminiText);

    // Voice config
    const voiceConfig = req.session.voiceConfig || { 
      voiceId: 'en-US-Natalie', 
      style: 'Conversational',
      description: 'Default voice'
    };

    // Generate audio with Murf
    let audioUrl = null;
    try {
      if (geminiText && geminiText.trim().length > 0) {
        const murfOptions = {
          method: 'post',
          url: 'https://api.murf.ai/v1/speech/generate',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'api-key': process.env.MURFAI_API_KEY
          },
          data: {
            text: geminiText.trim(),
            voiceId: voiceConfig.voiceId,
            style: voiceConfig.style
          },
          timeout: 30000
        };

        console.log('[chat] Requesting Murf TTS...');
        const murfResponse = await axios(murfOptions);
        
        audioUrl = murfResponse?.data?.audioFile 
                   || murfResponse?.data?.audioUrl 
                   || murfResponse?.data?.audio?.file 
                   || murfResponse?.data?.file 
                   || null;
        
        if (audioUrl) {
          console.log('[chat] ✅ Murf TTS success');
        } else {
          console.warn('[chat] No audio URL in Murf response');
        }
      }
    } catch (err) {
      console.error('[chat] Murf TTS error:', err?.response?.data || err.message);
    }

    // Add to history
    const modelEntry = {
      role: 'model',
      parts: [{ text: geminiText }]
    };
    if (audioUrl) modelEntry.audioUrl = audioUrl;

    const lastAfter = req.session.chatHistory[req.session.chatHistory.length - 1];
    if (!(lastAfter && lastAfter.role === 'model' && lastAfter.parts?.[0]?.text === geminiText)) {
      req.session.chatHistory.push(modelEntry);
      console.log('[chat] Model response added to history');
    }

    // Clear processing flag
    req.session.isProcessing = false;
    delete req.session.processingStartTime;

    // Save session
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) {
          console.error('[chat] Session save error:', err);
          reject(err);
        } else {
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
    console.error('❌ Error in chat endpoint:', error);
    console.error('Stack:', error.stack);

    req.session.isProcessing = false;
    delete req.session.processingStartTime;

    req.session.save((err) => {
      if (err) console.error('[chat] Session save error after exception:', err);
    });

    res.status(500).json({ 
      error: 'Failed to get a response from the AI.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ---------- UTILITY ENDPOINTS ----------
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'Chat.html'));
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
    personaName: req.session.personaName || null,
    chatHistory: req.session.chatHistory || []
  });
});

// ---------- STATIC ROUTES ----------
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'index.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'index.html'));
});

app.get('/add-username.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public', 'add-username.html'));
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📱 Using model: gemini-2.0-flash-exp`);
});
