# Indian Regional Language Live Captions

Real-time Chrome Extension (Manifest V3) + FastAPI backend that captures audio from any active browser tab, transcribes it using OpenAI Whisper (`whisper-1`), translates it into an Indian regional language using GPT-4o-mini, and renders live translated captions on the web page.

---

## 🏗️ Reference Architecture

```
Tab audio --> chrome.tabCapture --> offscreen document --> chunked WebSocket (~4s)
  --> FastAPI backend --> OpenAI Whisper (STT) --> GPT-4o-mini (Translation)
  --> WebSocket response --> background service worker --> content script --> on-page caption overlay
```

### Key Architectural Feature: Audio Pass-Through
Chrome's `chrome.tabCapture` API mutes the tab audio by default once captured. To ensure the user can still hear the video/audio playing while captions run, the extension's **offscreen document** re-routes the captured `MediaStream` back to the speakers using the Web Audio API:
```js
const audioCtx = new AudioContext();
const source = audioCtx.createMediaStreamSource(capturedStream);
source.connect(audioCtx.destination); // Restores speaker output
```

---

## 🌐 Supported Target Languages

- **Hindi** (हिंदी) - `hi`
- **Marathi** (मराठी) - `mr`
- **Tamil** (தமிழ்) - `ta`
- **Telugu** (తెలుగు) - `te`
- **Kannada** (ಕನ್ನಡ) - `kn`
- **Bengali** (বাংলা) - `bn`
- **Gujarati** (ગુજરાતી) - `gu`
- **Malayalam** (മലയാളം) - `ml`
- **Punjabi** (ਪੰਜਾਬੀ) - `pa`

---

## 🖥️ TranslateSub Web Studio (`frontend/`)

The web studio is an interactive single-page application inspired by **TranslateSub.com**:

- **Video & Audio File Subtitle Studio**:
  - Drag-and-drop video/audio upload (`MP4`, `MP3`, `WAV`, `WebM`).
  - Automatic Speech-to-Text via OpenAI Whisper with timestamp extraction (`verbose_json`).
  - Spoken-register translation via `gpt-4o-mini` into 9 Indian regional languages.
  - Interactive Subtitle Segment Editor with live search/filter.
  - Synchronized HTML5 video player preview with on-video caption overlay.
  - One-click export to **SRT**, **WebVTT (`.vtt`)**, or **Plain Text (`.txt`)**.
- **Live Streaming Captions Studio**:
  - Live microphone or browser tab audio streaming.
  - Real-time Web Audio API visualizer waveform.
  - Live subtitle feed timeline.

Access the Web Studio directly at:
```text
http://localhost:8000/studio
```

---

## 🛠️ Project Structure


```
Regional_Translator/
├── backend/
│   ├── main.py            # FastAPI app with WebSocket /ws/translate endpoint
│   ├── requirements.txt   # Python dependencies
│   └── .env.example       # Example env file with OPENAI_API_KEY
├── extension/
│   ├── manifest.json      # Manifest V3 configuration
│   ├── background.js      # Service worker for message routing & stream ID generation
│   ├── popup/
│   │   ├── popup.html     # Extension popup markup
│   │   ├── popup.js       # Popup interactive logic
│   │   └── popup.css      # Dark glassmorphic popup styling
│   ├── offscreen/
│   │   ├── offscreen.html # Offscreen document container
│   │   └── offscreen.js   # getUserMedia, AudioContext loopback, WebSocket recorder
│   └── content/
│       ├── content.js     # Injected script rendering on-page caption overlay
│       └── content.css    # Styling for bottom-center caption overlay
└── README.md
```

---

## 🚀 Setup & Execution Guide

### 1. Start the Backend

1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```
2. Create and activate a Python virtual environment:
   ```bash
   # Windows (PowerShell)
   python -m venv venv
   .\venv\Scripts\Activate.ps1

   # macOS / Linux
   python3 -m venv venv
   source venv/bin/activate
   ```
3. Install required dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Create a `.env` file from `.env.example` and set your OpenAI API key:
   ```env
   OPENAI_API_KEY=your_actual_openai_api_key
   ```
5. Launch the FastAPI Uvicorn server:
   ```bash
   uvicorn main:app --reload --port 8000
   ```
   The backend will start at `http://localhost:8000`.

---

### 2. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this repository.
5. The **Indian Regional Language Live Captions** extension will appear in your extensions toolbar.

---

### 3. Using Live Captions

1. Open any browser tab playing audio or video (e.g., YouTube, news stream, or podcast).
2. Click the extension icon in the toolbar.
3. Select your target Indian regional language from the dropdown menu (e.g., Hindi, Tamil, Marathi).
4. Click **Start Captions**.
5. **Result**:
   - Tab audio continues playing without muting.
   - Live translated caption overlays appear near the bottom-center of the webpage within 5–10 seconds.
6. Click **Stop Captions** to cleanly stop capture and disconnect WebSockets.

---

## 🔮 Known Limitations & Next Steps

1. **Chunk-Boundary Sentence Truncation**:
   - Fixed 4-second audio chunks can cut off spoken sentences mid-word or mid-phrase across boundaries.
   - *Next step*: Implement dynamic Voice Activity Detection (VAD) or overlapping audio buffers to cut chunks at natural silence pauses.

2. **Latency vs. Accuracy Tuning**:
   - A 4-second chunk size balances API call overhead and responsiveness (5-10 second total delay).
   - *Next step*: Experiment with 2-3 second chunks for faster response, or streaming STT models.

3. **Indian Regional Language Model Swapping**:
   - OpenAI Whisper and GPT-4o-mini handle general Indian regional translations well, but specialized engines like **Bhashini** (Govt of India) or **Sarvam AI** offer superior localized speech recognition and colloquial translation accuracy for Indian languages.
   - *Next step*: Add backend configuration switches to route audio to Bhashini/Sarvam AI APIs.

4. **Text-To-Speech (TTS) Dubbing**:
   - Currently, captions are visual overlays only.
   - *Next step*: Integrate a TTS service (e.g., ElevenLabs or Azure Neural TTS) to generate dubbed audio in the target regional language alongside captions.

5. **Production Deployment & WebSocket Security**:
   - Local testing uses unencrypted WebSockets (`ws://localhost:8000`).
   - *Next step*: For production deployment on AWS/GCP, configure TLS termination and update the extension's WebSocket URL to `wss://your-domain.com`.
