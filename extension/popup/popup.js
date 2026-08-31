// popup.js - Interactive controls for Chrome extension popup with Wispr Flow settings

document.addEventListener('DOMContentLoaded', () => {
  const langSelect = document.getElementById('langSelect');
  const toneSelect = document.getElementById('toneSelect');
  const smartCleanupToggle = document.getElementById('smartCleanupToggle');
  const glossaryInput = document.getElementById('glossaryInput');
  const toggleBtn = document.getElementById('toggleBtn');
  const btnText = document.getElementById('btnText');
  const dictateBtn = document.getElementById('dictateBtn');
  const statusBar = document.querySelector('.status-bar');
  const statusText = document.getElementById('statusText');

  let isCapturing = false;
  let activeTabId = null;

  // 1. Initialize UI state from storage & service worker
  chrome.storage.local.get(['lang', 'tone', 'smartCleanup', 'glossary', 'isCapturing', 'activeTabId'], (res) => {
    if (res.lang) langSelect.value = res.lang;
    if (res.tone) toneSelect.value = res.tone;
    if (res.smartCleanup !== undefined) smartCleanupToggle.checked = res.smartCleanup;
    if (res.glossary) glossaryInput.value = res.glossary;

    if (res.isCapturing) {
      isCapturing = true;
      activeTabId = res.activeTabId;
      updateUIState(true);
    } else {
      updateUIState(false);
    }
  });

  // Query background for fresh status
  chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (res) => {
    if (res) {
      if (res.lang) langSelect.value = res.lang;
      if (res.tone) toneSelect.value = res.tone;
      if (res.smartCleanup !== undefined) smartCleanupToggle.checked = res.smartCleanup;
      if (res.glossary) glossaryInput.value = res.glossary;

      isCapturing = !!res.isCapturing;
      activeTabId = res.activeTabId || null;
      updateUIState(isCapturing);
    }
  });

  // 2. Handle Settings Changes
  langSelect.addEventListener('change', () => {
    chrome.storage.local.set({ lang: langSelect.value });
  });

  toneSelect.addEventListener('change', () => {
    chrome.storage.local.set({ tone: toneSelect.value });
  });

  smartCleanupToggle.addEventListener('change', () => {
    chrome.storage.local.set({ smartCleanup: smartCleanupToggle.checked });
  });

  glossaryInput.addEventListener('input', () => {
    chrome.storage.local.set({ glossary: glossaryInput.value });
  });

  // 3. Handle Start/Stop Captions Toggle Button
  toggleBtn.addEventListener('click', async () => {
    toggleBtn.disabled = true;

    if (isCapturing) {
      // STOP Captions
      chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }, (res) => {
        toggleBtn.disabled = false;
        if (res && res.success) {
          isCapturing = false;
          activeTabId = null;
          updateUIState(false);
        } else {
          console.error('Failed to stop capture:', res ? res.error : 'Unknown error');
        }
      });
    } else {
      // START Captions
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) {
        alert('No active browser tab found.');
        toggleBtn.disabled = false;
        return;
      }

      chrome.runtime.sendMessage(
        {
          action: 'START_CAPTURE',
          lang: langSelect.value,
          tone: toneSelect.value,
          smartCleanup: smartCleanupToggle.checked,
          glossary: glossaryInput.value,
          tabId: activeTab.id
        },
        (res) => {
          toggleBtn.disabled = false;
          if (res && res.success) {
            isCapturing = true;
            activeTabId = activeTab.id;
            updateUIState(true);
          } else {
            alert('Failed to start capture: ' + ((res && res.error) || 'Please ensure target tab has audio playing.'));
          }
        }
      );
    }
  });

  // 4. Handle Voice Dictation Button
  dictateBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'TRIGGER_DICTATION_FROM_POPUP' }, () => {
      window.close(); // Close popup so user can focus on the webpage input
    });
  });

  function updateUIState(capturing) {
    if (capturing) {
      toggleBtn.className = 'btn btn-danger';
      btnText.textContent = 'Stop Captions';
      statusBar.classList.add('active');
      statusText.textContent = 'Capturing Audio & Streaming...';
    } else {
      toggleBtn.className = 'btn btn-primary';
      btnText.textContent = 'Start Tab Captions';
      statusBar.classList.remove('active');
      statusText.textContent = 'Ready';
    }
  }
});
