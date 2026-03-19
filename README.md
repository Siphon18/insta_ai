# ðŸ¤– AI Persona Chat

Create a chatbot that mimics the personality of any Instagram user. This application uses AI to analyze an Instagram profile and generate a conversational AI that you can interact with via text and voice.

![AI Persona Chat](https://i.imgur.com/your-screenshot-1.png) ## âœ¨ Features

-   **ðŸ‘¤ Persona Generation**: Enter any public Instagram username to create an AI persona. The AI will adopt the user's name, bio, and attempt to match their personality.
-   **ðŸ’¬ Text Chat**: A classic chat interface for conversing with the generated AI persona.
-   **ðŸŽ¤ Voice Chat**: An immersive, full-screen voice chat experience. Speak to the AI and hear its responses in a synthesized voice.
-   **ðŸ—£ï¸ Voice Selection**: Choose a specific voice for the AI or let it auto-detect the best voice based on the profile's gender cues.
-   **ðŸ–¼ï¸ Dynamic Profile Display**: The chat interface displays the Instagram user's profile picture, name, bio, and selected voice.
-   **ðŸš€ Built with Modern Tools**: Powered by xAI Grok for intelligent and context-aware chat responses and ElevenLabs for realistic text-to-speech.

## ðŸ¤” How It Works

1.  **Enter Username**: You start by providing an Instagram username on the "Add Username" page.
2.  **Fetch Profile**: The backend server uses an Instagram API to fetch the public profile information of the user, including their full name, bio, and profile picture.
3.  **Generate Persona**: This information is then passed to the xAI Grok model with a carefully crafted prompt, instructing it to act as an AI chatbot that mimics the personality of that user.
4.  **Confirm Persona**: The fetched profile details are displayed for your confirmation.
5.  **Start Chatting**: Once confirmed, you can start a conversation with the AI persona through either a text-based or a voice-based interface. The chat history is maintained within your session.

## ðŸ› ï¸ Technologies Used

-   **Backend**: Node.js, Express.js, PostgreSQL, JWT Authentication
-   **AI & Machine Learning**:
    -   xAI Grok API for the core chat logic.
    -   ElevenLabs for high-quality text-to-speech.
-   **Frontend**: HTML, Tailwind CSS, JavaScript
-   **APIs**:
    -   RapidAPI for Instagram user data.
    -   Web Speech API for voice recognition in the browser.
-   **3D/Graphics**: Three.js for the audio visualizer in the voice chat.

## âš™ï¸ Setup and Installation

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/your-username/insta-ai.git](https://github.com/your-username/insta-ai.git)
    cd insta-ai
    ```

2.  **Install backend dependencies:**
    ```bash
    cd backend
    npm install
    ```

3.  **Configure API Keys:**
    Create a `.env` file in the `backend` directory and add the following keys:

    ```env
    XAI_API_KEY=your_xai_api_key
    RAPIDAPI_KEY=your_rapidapi_key
    ELEVENLABS_API_KEY=your_elevenlabs_api_key
    DATABASE_URL=postgresql://user:password@localhost:5432/insta_ai
    JWT_SECRET=your_strong_random_secret
    ```

    > **Note:** You need a running PostgreSQL instance. The app will auto-create tables on first start.

4.  **Run the server:**
    ```bash
    npm start
    ```
    The application will be running at `http://localhost:3000`.

## ðŸš€ Usage

1.  Open your browser and navigate to `http://localhost:3000`.
2.  Click **Get Started** and create an account (or log in).
3.  Enter a public Instagram username and optionally select a voice.
4.  Click **Generate Persona**.
5.  On the confirmation page, review the details and click **Confirm**.
6.  You will be redirected to the chat page where you can start your conversation. You can also switch to the voice chat from there.


