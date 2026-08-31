// background.js - Service Worker for Indian Regional Language Live Captions

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

async function hasOffscreenDocument() {
  if ('hasDocument' in chrome.offscreen) {
    return await chrome.offscreen.hasDocument();
  }
  // Fallback for older Chrome versions if needed
  const matchedClients = await clients.matchAll();
  return matchedClients.some(c => c.url.includes(OFFSCREEN_DOCUMENT_PATH));
}

async function setupOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Capture browser tab audio for transcription and translation'
    });
  }
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
  } catch (err) {
    // Ignore error if script is already present or tab cannot be scripted (e.g. chrome:// tabs)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_CAPTURE') {
    handleStartCapture(message).then(sendResponse).catch(err => {
      console.error('Error in START_CAPTURE:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // Asynchronous response
  }

  if (message.action === 'STOP_CAPTURE') {
    handleStopCapture().then(sendResponse).catch(err => {
      console.error('Error in STOP_CAPTURE:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'CAPTION_RECEIVED') {
    const { data, tabId } = message;
    if (tabId && data) {
      chrome.tabs.sendMessage(tabId, {
        action: 'SHOW_CAPTION',
        original: data.original,
        translated: data.translated
      }).catch(err => {
        // Tab might have navigated or closed
      });
    }
    return false;
  }

  if (message.action === 'GET_STATUS') {
    chrome.storage.local.get(['isCapturing', 'activeTabId', 'lang'], (res) => {
      sendResponse(res);
    });
    return true;
  }
});

async function handleStartCapture({ lang, tabId }) {
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab found.');
    tabId = tab.id;
  }

  // 1. Get media stream ID for the target tab
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(id);
      }
    });
  });

  // 2. Ensure content script is ready
  await ensureContentScriptInjected(tabId);

  // 3. Ensure offscreen document is initialized
  await setupOffscreenDocument();

  // 4. Update stored capture state
  await chrome.storage.local.set({
    isCapturing: true,
    activeTabId: tabId,
    lang: lang || 'hi'
  });

  // 5. Tell offscreen document to begin recording & audio playback
  await chrome.runtime.sendMessage({
    action: 'START_OFFSCREEN_CAPTURE',
    streamId,
    lang: lang || 'hi',
    tabId
  });

  return { success: true, tabId };
}

async function handleStopCapture() {
  const { activeTabId } = await chrome.storage.local.get(['activeTabId']);

  // 1. Notify offscreen document to stop capture & WS
  try {
    await chrome.runtime.sendMessage({ action: 'STOP_OFFSCREEN_CAPTURE' });
  } catch (e) {
    // Ignore if offscreen doc is not listening
  }

  // 2. Notify content script to clear captions overlay
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: 'CLEAR_CAPTIONS' }).catch(() => {});
  }

  // 3. Update storage
  await chrome.storage.local.set({ isCapturing: false, activeTabId: null });

  return { success: true };
}
