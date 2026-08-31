// popup.js - Interactive controls for Chrome extension popup

document.addEventListener('DOMContentLoaded', () => {
  const langSelect = document.getElementById('langSelect');
  const toggleBtn = document.getElementById('toggleBtn');
  const btnText = document.getElementById('btnText');
  const statusBar = document.querySelector('.status-bar');
  const statusText = document.getElementById('statusText');

  let isCapturing = false;
  let activeTabId = null;

  // 1. Initialize UI state from storage & service worker
  chrome.storage.local.get(['lang', 'isCapturing', 'activeTabId'], (res) => {
    if (res.lang) {
      langSelect.value = res.lang;
    }
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
      isCapturing = !!res.isCapturing;
      activeTabId = res.activeTabId || null;
      updateUIState(isCapturing);
    }
  });

  // 2. Handle Language Selection Change
  langSelect.addEventListener('change', () => {
    const selectedLang = langSelect.value;
    chrome.storage.local.set({ lang: selectedLang });
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

      const selectedLang = langSelect.value;
      chrome.runtime.sendMessage(
        { action: 'START_CAPTURE', lang: selectedLang, tabId: activeTab.id },
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

  function updateUIState(capturing) {
    if (capturing) {
      toggleBtn.className = 'btn btn-danger';
      btnText.textContent = 'Stop Captions';
      statusBar.classList.add('active');
      statusText.textContent = 'Capturing Audio & Streaming...';
    } else {
      toggleBtn.className = 'btn btn-primary';
      btnText.textContent = 'Start Captions';
      statusBar.classList.remove('active');
      statusText.textContent = 'Ready';
    }
  }
});
