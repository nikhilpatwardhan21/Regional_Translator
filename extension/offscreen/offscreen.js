// offscreen.js - Handles tab audio capture, playback loopback, and WebSocket streaming

let mediaRecorder = null;
let audioCtx = null;
let mediaStream = null;
let wsConnection = null;
let currentTabId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_OFFSCREEN_CAPTURE') {
    startCapture(message)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('Offscreen start capture error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.action === 'STOP_OFFSCREEN_CAPTURE') {
    stopCapture();
    sendResponse({ success: true });
    return false;
  }
});

async function startCapture({ streamId, lang, tone, smartCleanup, glossary, tabId }) {
  stopCapture(); // Clean up existing session if any

  currentTabId = tabId;

  // 1. Capture stream using tab streamId
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // 2. Audio Pass-through: Re-route captured stream to speakers so user can hear tab audio
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination);

  // 3. Setup WebSocket connection to backend with Wispr Flow parameters
  const params = new URLSearchParams({
    lang: lang || 'hi',
    tone: tone || 'casual',
    smart_cleanup: smartCleanup !== false ? 'true' : 'false',
    glossary: glossary || ''
  });
  const wsUrl = `ws://localhost:8000/ws/translate?${params.toString()}`;
  wsConnection = new WebSocket(wsUrl);

  wsConnection.onopen = () => {
    console.log(`[Offscreen] WebSocket connected to ${wsUrl}`);
  };

  wsConnection.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('[Offscreen] Received translation from backend:', data);
      chrome.runtime.sendMessage({
        action: 'CAPTION_RECEIVED',
        data: data,
        tabId: currentTabId
      });
    } catch (err) {
      console.error('[Offscreen] Error parsing WebSocket message:', err);
    }
  };

  wsConnection.onerror = (err) => {
    console.error('[Offscreen] WebSocket error:', err);
  };

  wsConnection.onclose = () => {
    console.log('[Offscreen] WebSocket closed.');
  };

  // 4. Setup MediaRecorder with Opus codec in WebM container (~4 second chunks)
  const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? { mimeType: 'audio/webm;codecs=opus' }
    : { mimeType: 'audio/webm' };

  mediaRecorder = new MediaRecorder(mediaStream, options);

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.send(event.data);
    }
  };

  mediaRecorder.start(4000); // Send audio chunk every ~4000ms
  console.log('[Offscreen] MediaRecorder started with 4s interval.');
}

function stopCapture() {
  console.log('[Offscreen] Stopping capture session...');

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.warn('Error stopping MediaRecorder:', e);
    }
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioCtx) {
    try {
      audioCtx.close();
    } catch (e) {
      console.warn('Error closing AudioContext:', e);
    }
    audioCtx = null;
  }

  if (wsConnection) {
    try {
      wsConnection.close();
    } catch (e) {
      console.warn('Error closing WebSocket:', e);
    }
    wsConnection = null;
  }

  mediaRecorder = null;
  currentTabId = null;
}
