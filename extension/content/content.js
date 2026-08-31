// content.js - Injected into active web pages to display live captions

(function () {
  let overlayContainer = null;
  let translatedEl = null;
  let originalEl = null;
  let fadeTimeout = null;

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

    // Remove hidden class to trigger fade-in animation
    overlayContainer.classList.remove('rc-hidden');

    // Reset 6-second auto-fade timer
    if (fadeTimeout) {
      clearTimeout(fadeTimeout);
    }

    fadeTimeout = setTimeout(() => {
      if (overlayContainer) {
        overlayContainer.classList.add('rc-hidden');
      }
    }, 6000); // Auto-fade after 6 seconds of inactivity
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SHOW_CAPTION') {
      showCaption(message.translated, message.original);
      sendResponse({ status: 'shown' });
    } else if (message.action === 'CLEAR_CAPTIONS') {
      clearCaptions();
      sendResponse({ status: 'cleared' });
    }
    return false;
  });
})();
