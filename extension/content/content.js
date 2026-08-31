// content.js - Injected into active web pages for Live Captions and Wispr Flow Voice Dictation

(function () {
  const BACKEND_URL = 'http://localhost:8000';

  // State: Captions Overlay
  let overlayContainer = null;
  let translatedEl = null;
  let originalEl = null;
  let fadeTimeout = null;

  // State: Dictation
  let isDictating = false;
  let dictationStream = null;
  let dictationRecorder = null;
  let dictationChunks = [];
  let dictationPill = null;
  let lastFocusedElement = null;

  // Track currently focused input element across the page
  document.addEventListener('focusin', (e) => {
    if (
      e.target &&
      (e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.isContentEditable ||
        e.target.getAttribute('contenteditable') === 'true')
    ) {
      lastFocusedElement = e.target;
    }
  });

  // -------------------------------------------------------------
  // 1. Live Captions Overlay Logic
  // -------------------------------------------------------------
  function createOverlay() {
    if (document.getElementById('regional-caption-overlay')) {
      overlayContainer = document.getElementById('regional-caption-overlay');
      translatedEl = overlayContainer.querySelector('.rc-translated-text');
      originalEl = overlayContainer.querySelector('.rc-original-text');
      return;
    }

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'regional-caption-overlay';
    overlayContainer.className = 'rc-hidden';

    const box = document.createElement('div');
    box.className = 'rc-caption-box';

    translatedEl = document.createElement('div');
    translatedEl.className = 'rc-translated-text';

    originalEl = document.createElement('div');
    originalEl.className = 'rc-original-text';

    box.appendChild(translatedEl);
    box.appendChild(originalEl);
    overlayContainer.appendChild(box);

    document.body.appendChild(overlayContainer);
  }

  function showCaption(translated, original) {
    createOverlay();

    translatedEl.textContent = translated || '';
    originalEl.textContent = original ? `Original: "${original}"` : '';

    overlayContainer.classList.remove('rc-hidden');

    if (fadeTimeout) {
      clearTimeout(fadeTimeout);
    }

    fadeTimeout = setTimeout(() => {
      if (overlayContainer) {
        overlayContainer.classList.add('rc-hidden');
      }
    }, 6000);
  }

  function clearCaptions() {
    if (fadeTimeout) {
      clearTimeout(fadeTimeout);
      fadeTimeout = null;
    }
    if (overlayContainer) {
      overlayContainer.classList.add('rc-hidden');
      setTimeout(() => {
        if (translatedEl) translatedEl.textContent = '';
        if (originalEl) originalEl.textContent = '';
      }, 400);
    }
  }

  // -------------------------------------------------------------
  // 2. Wispr Flow Voice Dictation & Input Insertion Engine
  // -------------------------------------------------------------
  function createDictationPill() {
    if (document.getElementById('regional-dictation-pill')) {
      dictationPill = document.getElementById('regional-dictation-pill');
      return;
    }

    dictationPill = document.createElement('div');
    dictationPill.id = 'regional-dictation-pill';
    dictationPill.className = 'rc-dictate-pill rc-hidden';
    dictationPill.innerHTML = `
      <div class="rc-dictate-pulse"></div>
      <div class="rc-dictate-content">
        <span class="rc-dictate-title">🎙️ Wispr Dictation Active</span>
        <span class="rc-dictate-status" id="rcDictateStatus">Listening... Press Alt+Shift+V to finish</span>
      </div>
    `;

    document.body.appendChild(dictationPill);
  }

  async function toggleDictation(settings = {}) {
    createDictationPill();

    if (isDictating) {
      await stopDictationAndInject(settings);
    } else {
      await startDictation(settings);
    }
  }

  async function startDictation(settings) {
    try {
      dictationStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      dictationChunks = [];

      const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? { mimeType: 'audio/webm;codecs=opus' }
        : { mimeType: 'audio/webm' };

      dictationRecorder = new MediaRecorder(dictationStream, options);

      dictationRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          dictationChunks.push(e.data);
        }
      };

      dictationRecorder.start();
      isDictating = true;

      // Update UI Pill
      dictationPill.classList.remove('rc-hidden');
      const statusText = dictationPill.querySelector('#rcDictateStatus');
      if (statusText) {
        statusText.textContent = `Listening (${settings.lang || 'Hindi'})... Press Alt+Shift+V to finish`;
      }
    } catch (err) {
      console.error('Dictation mic access error:', err);
      alert('Microphone permission needed for Voice Dictation.');
    }
  }

  async function stopDictationAndInject(settings) {
    if (!isDictating || !dictationRecorder) return;

    const statusText = dictationPill.querySelector('#rcDictateStatus');
    if (statusText) {
      statusText.textContent = 'Polishing & Translating speech...';
    }

    await new Promise((resolve) => {
      dictationRecorder.onstop = resolve;
      dictationRecorder.stop();
    });

    if (dictationStream) {
      dictationStream.getTracks().forEach((t) => t.stop());
      dictationStream = null;
    }

    isDictating = false;

    if (dictationChunks.length === 0) {
      dictationPill.classList.add('rc-hidden');
      return;
    }

    const audioBlob = new Blob(dictationChunks, { type: 'audio/webm' });
    dictationChunks = [];

    const formData = new FormData();
    formData.append('file', audioBlob, 'dictation.webm');
    formData.append('lang', settings.lang || 'hi');
    formData.append('tone', settings.tone || 'casual');
    formData.append('smart_cleanup', settings.smartCleanup !== false ? 'true' : 'false');
    formData.append('glossary', settings.glossary || '');

    try {
      const res = await fetch(`${BACKEND_URL}/api/dictate`, {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      dictationPill.classList.add('rc-hidden');

      if (data.text && data.text.trim()) {
        injectTextIntoActiveElement(data.text.trim());
      }
    } catch (err) {
      console.error('Error submitting dictation:', err);
      if (statusText) {
        statusText.textContent = 'Dictation error (check backend connection)';
      }
      setTimeout(() => dictationPill.classList.add('rc-hidden'), 2000);
    }
  }

  // Smart insertion into Inputs, Textareas, and Rich-Text ContentEditables (WhatsApp, Gmail, ChatGPT, Slack)
  function injectTextIntoActiveElement(text) {
    const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : lastFocusedElement;

    if (!el) {
      navigator.clipboard.writeText(text).catch(() => {});
      showCaption(text, 'Copied to clipboard (no active input found)');
      return;
    }

    el.focus();

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const start = el.selectionStart || el.value.length;
      const end = el.selectionEnd || el.value.length;
      const val = el.value;
      const insert = (start > 0 && !val[start - 1].match(/\s/) ? ' ' : '') + text + ' ';
      el.value = val.substring(0, start) + insert + val.substring(end);
      el.selectionStart = el.selectionEnd = start + insert.length;

      // Dispatch native input & change events for reactive frameworks
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // For rich-text editors (Gmail, WhatsApp Web, Slack, ChatGPT)
      const success = document.execCommand('insertText', false, text + ' ');
      if (!success) {
        el.textContent += (el.textContent ? ' ' : '') + text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      navigator.clipboard.writeText(text).catch(() => {});
      showCaption(text, 'Copied to clipboard');
    }
  }

  // -------------------------------------------------------------
  // 3. Message Listeners
  // -------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SHOW_CAPTION') {
      showCaption(message.translated, message.original);
      sendResponse({ status: 'shown' });
    } else if (message.action === 'CLEAR_CAPTIONS') {
      clearCaptions();
      sendResponse({ status: 'cleared' });
    } else if (message.action === 'TOGGLE_DICTATION') {
      toggleDictation(message.settings || {});
      sendResponse({ status: 'dictation_toggled' });
    }
    return false;
  });
})();
