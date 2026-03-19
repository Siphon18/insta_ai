# AI Persona Chat

Create a chatbot that mimics the personality of any Instagram user.  
The app analyzes public Instagram profile context, builds a persona, and lets users chat in text and voice.

## Features

- Persona generation from public Instagram username input
- Text chat with memory and persona-styled responses
- Voice chat using ElevenLabs text-to-speech
- Voice style presets derived from persona personality
- Persona persistence in PostgreSQL
- JWT auth with email/password and Google OAuth
- RapidAPI request limiting and usage tracking
- Health and readiness endpoints for deployment checks

## Tech Stack

- Backend: Node.js, Express, PostgreSQL, JWT
- LLM: Groq chat completions API
- Voice: ElevenLabs API
- Frontend: HTML, Tailwind CSS, JavaScript
- Graphics/animation: Three.js (landing page visual layer)
- Integrations: RapidAPI (Instagram profile source), Google Identity Services

## Project Structure

- `backend/`
- `frontend/public/`

## Environment Variables (backend/.env)

Required:

```env
DATABASE_URL=postgresql://...
GROQ_API_KEY=...
RAPIDAPI_KEY=...
ELEVENLABS_API_KEY=...
JWT_SECRET=your-strong-secret
```

Recommended:

```env
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GROQ_API_BASE_URL=https://api.groq.com/openai/v1
GROQ_MODEL_PRIMARY=llama-3.3-70b-versatile
GROQ_MODEL_FALLBACK=llama-3.1-8b-instant
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
```

Deployment/CORS:

```env
CORS_ALLOWED_ORIGINS=https://your-frontend-domain.vercel.app
```

## Local Setup

1. Clone the repo

```bash
git clone https://github.com/Siphon18/insta_ai.git
cd insta_ai
```

2. Install backend dependencies

```bash
cd backend
npm install
```

3. Create `backend/.env` using `backend/.env.example`

4. Start backend

```bash
npm start
```

5. Open:

```text
http://localhost:3000
```

## Google OAuth Notes

- Frontend shows Google sign-in on `login.html`.
- Backend endpoint `GET /api/auth/google/config` must return `enabled: true`.
- Add your frontend domain to Google OAuth "Authorized JavaScript origins".

## Database Migration to Neon

Script included:

```bash
npm run migrate:neon
```

Migration env options:

```env
SOURCE_DATABASE_URL=postgresql://source...
TARGET_DATABASE_URL=postgresql://neon...
```

Fallback behavior:

- Source defaults to `DATABASE_URL`
- Target defaults to `NEON_DATABASE_URL`

## API Health Endpoints

- `GET /healthz`
- `GET /readyz`

