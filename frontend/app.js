// app.js - TranslateSub Web Studio Interactive Logic

document.addEventListener('DOMContentLoaded', () => {
  const BACKEND_BASE = window.location.origin;
  const WS_BASE = window.location.origin.replace(/^http/, 'ws');

  // State
  let activeSegments = [];
  let currentFile = null;
  let liveWebSocket = null;
  let liveMediaRecorder = null;
  let liveMediaStream = null;
  let liveAudioCtx = null;
  let liveAnalyser = null;
  let animFrameId = null;
  let isLiveActive = false;

  // DOM Elements - Navigation & Modes
  const pillFileStudio = document.getElementById('pillFileStudio');
  const pillLiveStudio = document.getElementById('pillLiveStudio');
  const fileStudioMode = document.getElementById('fileStudioMode');
  const liveStudioMode = document.getElementById('liveStudioMode');
  const globalLangSelect = document.getElementById('globalLangSelect');
  const liveTargetLang = document.getElementById('liveTargetLang');

  // DOM Elements - File Studio
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const processingCard = document.getElementById('processingCard');
  const workspaceGrid = document.getElementById('workspaceGrid');
  const mediaPlayer = document.getElementById('mediaPlayer');
  const fileNameBadge = document.getElementById('fileNameBadge');
  const playerSubtitleOverlay = document.getElementById('playerSubtitleOverlay');
  const playerSubTranslated = document.getElementById('playerSubTranslated');
  const playerSubOriginal = document.getElementById('playerSubOriginal');
  const segmentList = document.getElementById('segmentList');
  const segmentCount = document.getElementById('segmentCount');
  const searchInput = document.getElementById('searchInput');
  const exportFormatSelect = document.getElementById('exportFormatSelect');
  const downloadSubBtn = document.getElementById('downloadSubBtn');

  // DOM Elements - Live Studio
  const toggleLiveBtn = document.getElementById('toggleLiveBtn');
  const liveAudioSource = document.getElementById('liveAudioSource');
  const liveStatusBadge = document.getElementById('liveStatusBadge');
  const liveStatusText = document.getElementById('liveStatusText');
  const audioVisualizer = document.getElementById('audioVisualizer');
  const liveFeedTimeline = document.getElementById('liveFeedTimeline');
  const clearLiveFeedBtn = document.getElementById('clearLiveFeedBtn');

  // DOM Elements - Modal
  const extModalBtn = document.getElementById('extModalBtn');
  const extModal = document.getElementById('extModal');
  const closeExtModalBtn = document.getElementById('closeExtModalBtn');
  const gotItBtn = document.getElementById('gotItBtn');

  // -------------------------------------------------------------
  // 1. Navigation & Studio Mode Switcher
  // -------------------------------------------------------------
  pillFileStudio.addEventListener('click', () => {
    pillFileStudio.classList.add('active');
    pillLiveStudio.classList.remove('active');
    fileStudioMode.classList.add('active');
    liveStudioMode.classList.remove('active');
  });

  pillLiveStudio.addEventListener('click', () => {
    pillLiveStudio.classList.add('active');
    pillFileStudio.classList.remove('active');
    liveStudioMode.classList.add('active');
    fileStudioMode.classList.remove('active');
  });

  globalLangSelect.addEventListener('change', () => {
    liveTargetLang.value = globalLangSelect.value;
  });

  liveTargetLang.addEventListener('change', () => {
    globalLangSelect.value = liveTargetLang.value;
  });

  // Modal Handlers
  extModalBtn.addEventListener('click', () => extModal.classList.remove('hidden'));
  closeExtModalBtn.addEventListener('click', () => extModal.classList.add('hidden'));
  gotItBtn.addEventListener('click', () => extModal.classList.add('hidden'));

  // -------------------------------------------------------------
  // 2. File Studio Mode (Upload, Transcribe & Interactive Subtitle Editor)
  // -------------------------------------------------------------
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleFileUpload(fileInput.files[0]);
    }
  });

  async function handleFileUpload(file) {
    currentFile = file;
    dropzone.classList.add('hidden');
    processingCard.classList.remove('hidden');
    workspaceGrid.classList.add('hidden');

    fileNameBadge.textContent = file.name;
    const objectUrl = URL.createObjectURL(file);
    mediaPlayer.src = objectUrl;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('lang', globalLangSelect.value);

    try {
      const response = await fetch(`${BACKEND_BASE}/api/transcribe-file`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      processingCard.classList.add('hidden');

      if (data.error) {
        alert(`Transcription error: ${data.error}`);
        dropzone.classList.remove('hidden');
        return;
      }

      activeSegments = data.segments || [];
      renderSegments(activeSegments);
      workspaceGrid.classList.remove('hidden');

    } catch (err) {
      console.error('File upload failed:', err);
      alert('Failed to connect to backend server. Make sure FastAPI server is running on ' + BACKEND_BASE);
      processingCard.classList.add('hidden');
      dropzone.classList.remove('hidden');
    }
  }

  function renderSegments(segments) {
    segmentList.innerHTML = '';
    segmentCount.textContent = activeSegments.length;

    if (segments.length === 0) {
      segmentList.innerHTML = '<div class="feed-empty-state"><p>No matching subtitles found.</p></div>';
      return;
    }

    segments.forEach((seg) => {
      const card = document.createElement('div');
      card.className = 'segment-card';
      card.dataset.id = seg.id;
      card.dataset.start = seg.start;
      card.dataset.end = seg.end;

      const startTimeStr = formatSecondsToTime(seg.start);
      const endTimeStr = formatSecondsToTime(seg.end);

      card.innerHTML = `
        <div class="segment-header">
          <span class="segment-time">${startTimeStr} - ${endTimeStr}</span>
        </div>
        <div class="segment-orig-text">Original: "${escapeHtml(seg.original)}"</div>
        <input type="text" class="segment-trans-input" value="${escapeHtml(seg.translated || '')}">
      `;

      // Jump to video timestamp on card click
      card.addEventListener('click', (e) => {
        if (!e.target.classList.contains('segment-trans-input')) {
          mediaPlayer.currentTime = seg.start;
          mediaPlayer.play();
        }
      });

      // Update segment translation text on edit safely by segment ID
      const transInput = card.querySelector('.segment-trans-input');
      transInput.addEventListener('input', (e) => {
        const target = activeSegments.find(s => s.id === seg.id);
        if (target) {
          target.translated = e.target.value;
        }
        seg.translated = e.target.value;
      });

      segmentList.appendChild(card);
    });
  }

  // Synchronized Subtitle Overlay during Media Playback
  mediaPlayer.addEventListener('timeupdate', () => {
    const currentTime = mediaPlayer.currentTime;
    const currentSeg = activeSegments.find(s => currentTime >= s.start && currentTime <= s.end);

    // Update segment active highlights
    const cards = segmentList.querySelectorAll('.segment-card');
    cards.forEach(card => {
      const start = parseFloat(card.dataset.start);
      const end = parseFloat(card.dataset.end);
      if (currentTime >= start && currentTime <= end) {
        card.classList.add('active');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        card.classList.remove('active');
      }
    });

    // Update on-player video overlay
    if (currentSeg) {
      playerSubtitleOverlay.classList.remove('hidden');
      playerSubTranslated.textContent = currentSeg.translated || currentSeg.original;
      playerSubOriginal.textContent = `Original: "${currentSeg.original}"`;
    } else {
      playerSubtitleOverlay.classList.add('hidden');
    }
  });

  // Search/Filter Subtitles
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      renderSegments(activeSegments);
      return;
    }
    const filtered = activeSegments.filter(s =>
      (s.original && s.original.toLowerCase().includes(query)) ||
      (s.translated && s.translated.toLowerCase().includes(query))
    );
    renderSegments(filtered);
  });

  // Export Subtitles (SRT, VTT, TXT)
  downloadSubBtn.addEventListener('click', async () => {
    if (activeSegments.length === 0) return;

    const fmt = exportFormatSelect.value;
    try {
      const res = await fetch(`${BACKEND_BASE}/api/export-subtitles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: activeSegments, format: fmt })
      });

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `subtitles.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Error exporting subtitles.');
    }
  });

  // -------------------------------------------------------------
  // 3. Live Stream Captions Studio Mode
  // -------------------------------------------------------------
  toggleLiveBtn.addEventListener('click', async () => {
    if (isLiveActive) {
      stopLiveSession();
    } else {
      startLiveSession();
    }
  });

  async function startLiveSession() {
    const targetLang = liveTargetLang.value;
    const sourceType = liveAudioSource.value;

    try {
      if (sourceType === 'mic') {
        liveMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        liveMediaStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      }

      // Audio Visualizer Setup
      liveAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const sourceNode = liveAudioCtx.createMediaStreamSource(liveMediaStream);
      liveAnalyser = liveAudioCtx.createAnalyser();
      liveAnalyser.fftSize = 64;
      sourceNode.connect(liveAnalyser);
      drawVisualizer();

      // WebSocket Connection
      const wsUrl = `${WS_BASE}/ws/translate?lang=${encodeURIComponent(targetLang)}`;
      liveWebSocket = new WebSocket(wsUrl);

      liveWebSocket.onopen = () => {
        isLiveActive = true;
        updateLiveUI(true);
        startMediaRecorder();
      };

      liveWebSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.error) {
            console.error('WebSocket translation error:', data.error);
            return;
          }
          appendLiveFeedItem(data.original, data.translated);
        } catch (e) {
          console.error('Error parsing live WS payload:', e);
        }
      };

      liveWebSocket.onerror = (err) => {
        console.error('Live WebSocket error:', err);
      };

      liveWebSocket.onclose = () => {
        stopLiveSession();
      };

    } catch (err) {
      console.error('Failed to start live capture session:', err);
      alert('Failed to access audio source. Please check microphone/display capture permissions.');
    }
  }

  function startMediaRecorder() {
    const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : { mimeType: 'audio/webm' };

    liveMediaRecorder = new MediaRecorder(liveMediaStream, options);

    liveMediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && liveWebSocket && liveWebSocket.readyState === WebSocket.OPEN) {
        liveWebSocket.send(event.data);
      }
    };

    liveMediaRecorder.start(4000);
  }

  function stopLiveSession() {
    isLiveActive = false;

    if (liveMediaRecorder && liveMediaRecorder.state !== 'inactive') {
      try { liveMediaRecorder.stop(); } catch (e) {}
    }
    if (liveMediaStream) {
      liveMediaStream.getTracks().forEach(t => t.stop());
      liveMediaStream = null;
    }
    if (liveAudioCtx) {
      try { liveAudioCtx.close(); } catch (e) {}
      liveAudioCtx = null;
    }
    if (liveWebSocket) {
      try { liveWebSocket.close(); } catch (e) {}
      liveWebSocket = null;
    }
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
    }

    updateLiveUI(false);
  }

  function updateLiveUI(active) {
    if (active) {
      toggleLiveBtn.className = 'btn btn-danger btn-lg btn-glow';
      toggleLiveBtn.innerHTML = `Stop Live Session`;
      liveStatusBadge.classList.add('active');
      liveStatusText.textContent = 'Live Captions Active';
    } else {
      toggleLiveBtn.className = 'btn btn-primary btn-lg btn-glow';
      toggleLiveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg> Start Live Session`;
      liveStatusBadge.classList.remove('active');
      liveStatusText.textContent = 'Disconnected';
    }
  }

  function drawVisualizer() {
    if (!liveAnalyser || !audioVisualizer) return;
    const canvas = audioVisualizer;
    
    // Set actual canvas pixel dimensions to match display size
    if (canvas.offsetWidth && canvas.offsetHeight) {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    }

    const ctx = canvas.getContext('2d');
    const bufferLength = liveAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function render() {
      if (!isLiveActive) return;
      animFrameId = requestAnimationFrame(render);
      liveAnalyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
        gradient.addColorStop(0, '#6366F1');
        gradient.addColorStop(1, '#8B5CF6');

        ctx.fillStyle = gradient;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 2;
      }
    }
    render();
  }

  function appendLiveFeedItem(original, translated) {
    const emptyState = liveFeedTimeline.querySelector('.feed-empty-state');
    if (emptyState) emptyState.remove();

    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = `
      <div class="feed-translated">${escapeHtml(translated)}</div>
      <div class="feed-original">Original: "${escapeHtml(original)}"</div>
    `;

    liveFeedTimeline.appendChild(item);
    liveFeedTimeline.scrollTop = liveFeedTimeline.scrollHeight;
  }

  clearLiveFeedBtn.addEventListener('click', () => {
    liveFeedTimeline.innerHTML = '<div class="feed-empty-state"><p>Click "Start Live Session" to stream real-time translated captions.</p></div>';
  });

  // Helpers
  function formatSecondsToTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
});
