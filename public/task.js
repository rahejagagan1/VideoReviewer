/* User task flow: info popup -> instructions -> locked video -> questions -> thanks */
(() => {
  const $ = (id) => document.getElementById(id);
  const taskId = location.pathname.split('/').pop();
  const storeKey = `vr_task_${taskId}`;

  // Adding "?reset" to the task link wipes this browser's saved progress and
  // starts the flow from the beginning — handy for testing.
  if (new URLSearchParams(location.search).has('reset')) {
    localStorage.removeItem(storeKey);
    location.replace(location.pathname);
    return;
  }

  let task = null;
  let player = null;
  let playerReady = false;
  let duration = 0;
  let maxWatched = 0; // furthest legitimate playback point
  let lastTime = 0;
  let lastProgressSave = 0;
  let watchdog = null;
  let videoDone = false;
  let seekUnlocked = false; // becomes true after one full watch-through
  let formQuestions = []; // asked in the feedback form after the video
  let sections = []; // question sections popped up during the video
  let quizOpen = false;
  let currentSection = null;

  const state = loadState();

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(storeKey)) || {};
    } catch {
      return {};
    }
  }
  function saveState(patch) {
    Object.assign(state, patch);
    localStorage.setItem(storeKey, JSON.stringify(state));
  }

  const stages = ['loading', 'notfound', 'instructions', 'thumbs', 'video', 'questions', 'thanks'];
  function showStage(name) {
    stages.forEach((s) => $(`stage-${s}`).classList.toggle('hidden', s !== name));
    document.body.classList.toggle('video-mode', name === 'video');
    window.scrollTo(0, 0);
  }

  async function api(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- boot ----------

  (async () => {
    try {
      task = await api(`/api/tasks/${taskId}`);
    } catch {
      showStage('notfound');
      return;
    }
    document.title = `${task.title} — Video Review Task`;
    formQuestions = task.questions;
    sections = (task.sections || []).slice().sort((a, b) => a.atSeconds - b.atSeconds);
    $('instrTitle').textContent = task.title;
    $('videoTitle').textContent = task.title;
    $('instrBody').textContent =
      task.instructions && task.instructions.trim()
        ? task.instructions
        : `Welcome, and thank you for taking part in this video review!

Please read these instructions carefully before you start:

1. Watch the video carefully. You can play, pause, rewind and fast-forward at any time.
2. Questions will pop up over the video at certain moments. Answer them to continue watching.
3. Turn your sound on and watch in a quiet place so you don't miss anything.
4. Don't worry about interruptions. If the page reloads, your progress is saved and the video continues from where you left off (on this same device and browser).
5. When the video ends, press "Next" to open the feedback questions.
6. Press "Next" when you are ready, then answer the questions. Questions marked with * are required.
7. Be honest. There are no right or wrong answers. We want your genuine opinion.
8. You can submit only once, so review your answers before pressing "Submit feedback".

When you're ready, tick the box below and press "Play Video".`;

    if (state.done) {
      $('thanksMsg').textContent = 'You have already completed this task from this browser. Thank you!';
      showStage('thanks');
    } else if (state.submissionId && state.watched) {
      // Already watched the full video: restore whichever page they were on —
      // the feedback form if they had moved on, otherwise the unlocked player.
      if (state.stage === 'questions') {
        renderQuestions();
        showStage('questions');
      } else {
        showStage('video');
        initPlayer();
      }
    } else if (state.submissionId && (state.accepted || state.videoTime > 0)) {
      // Page was reloaded mid-flow: back to the thumbnail page or the player
      // (which resumes from the last saved position).
      goAfterInstructions();
    } else if (state.submissionId) {
      showStage('instructions');
    } else {
      showStage('loading');
      $('infoModal').classList.remove('hidden');
    }
  })();

  // ---------- info popup ----------

  $('infoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('infoError').textContent = '';
    try {
      const { submissionId } = await api(`/api/tasks/${taskId}/start`, {
        name: $('fName').value,
        email: $('fEmail').value,
        county: $('fCounty').value,
        country: $('fCountry').value,
      });
      saveState({ submissionId });
      $('infoModal').classList.add('hidden');
      showStage('instructions');
    } catch (err) {
      $('infoError').textContent = err.message;
    }
  });

  // ---------- instructions ----------

  $('acceptCheck').addEventListener('change', () => {
    $('playVideoBtn').disabled = !$('acceptCheck').checked;
  });

  $('playVideoBtn').addEventListener('click', () => {
    saveState({ accepted: true });
    goAfterInstructions();
  });

  // ---------- thumbnail choice ----------

  // After instructions: thumbnail page first (if the task has thumbnails and
  // none was picked yet), otherwise straight to the video.
  function goAfterInstructions() {
    if ((task.thumbnails || []).length && !state.thumbPicked) {
      renderThumbs();
      showStage('thumbs');
    } else {
      showStage('video');
      initPlayer();
    }
  }

  let selectedThumb = null;

  function renderThumbs() {
    const grid = $('thumbGrid');
    grid.innerHTML = '';
    task.thumbnails.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'thumb-option';
      const img = document.createElement('img');
      img.src = t.image;
      img.alt = t.title;
      const title = document.createElement('div');
      title.className = 'thumb-title';
      title.textContent = t.title;
      card.append(img, title);
      card.addEventListener('click', () => {
        selectedThumb = t;
        grid.querySelectorAll('.thumb-option').forEach((el) => el.classList.remove('selected'));
        card.classList.add('selected');
        $('thumbNextBtn').disabled = false;
      });
      grid.appendChild(card);
    });
  }

  $('thumbNextBtn').addEventListener('click', async () => {
    if (!selectedThumb) return;
    $('thumbError').textContent = '';
    $('thumbNextBtn').disabled = true;
    try {
      await api(`/api/submissions/${state.submissionId}/thumbnail`, {
        thumbnailId: selectedThumb.id,
      });
      saveState({ thumbPicked: selectedThumb.id });
      showStage('video');
      initPlayer();
    } catch (err) {
      $('thumbError').textContent = err.message;
      $('thumbNextBtn').disabled = false;
    }
  });

  // ---------- video (locked YouTube player) ----------

  function initPlayer() {
    if (player) return;
    // The pause cover shows the video's own thumbnail (dimmed). If the
    // high-res thumbnail doesn't exist, the lower-res layer shows instead.
    $('bigPlay').style.backgroundImage =
      `linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)),` +
      ` url('https://i.ytimg.com/vi/${task.videoId}/maxresdefault.jpg'),` +
      ` url('https://i.ytimg.com/vi/${task.videoId}/hqdefault.jpg')`;
    // Resume from where the user left off if the page was reloaded mid-video.
    maxWatched = Math.max(0, Number(state.videoTime) || 0);
    lastTime = maxWatched;
    lastProgressSave = maxWatched;
    enableSeekControls();
    if (state.watched) unlockSeeking();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player('yt-player', {
        videoId: task.videoId,
        playerVars: {
          controls: 0,        // no YouTube control bar
          disablekb: 1,       // no keyboard shortcuts (arrows = seek)
          fs: 0,              // no fullscreen button
          rel: 0,
          modestbranding: 1,
          iv_load_policy: 3,  // no annotations
          playsinline: 1,
          origin: location.origin,
          start: Math.floor(maxWatched), // resume point after a reload
        },
        events: {
          onReady: () => {
            playerReady = true;
            duration = player.getDuration() || 0;
            disableCaptions();
            updateBar(maxWatched);
          },
          onStateChange: onPlayerState,
        },
      });
    };
  }

  // Keep YouTube closed captions (CC) off — they can auto-enable from the
  // viewer's YouTube preferences, and captions only load once playback starts,
  // so this runs both on ready and on every play.
  function disableCaptions() {
    try { player.unloadModule('captions'); } catch {}
    try { player.unloadModule('cc'); } catch {}
    try { player.setOption('captions', 'track', {}); } catch {}
    try { player.setOption('cc', 'track', {}); } catch {}
  }

  function onPlayerState(e) {
    if (e.data === YT.PlayerState.PLAYING) {
      setPlayingUI(true);
      duration = player.getDuration() || duration;
      disableCaptions();
      startWatchdog();
    } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
      setPlayingUI(e.data === YT.PlayerState.BUFFERING);
      saveProgress();
    } else if (e.data === YT.PlayerState.ENDED) {
      stopWatchdog();
      setPlayingUI(false);
      updateBar(duration);
      if (!videoDone) {
        // Ask any sections that were placed at (or past) the very end.
        const pending = pendingSection(Infinity);
        if (pending) {
          openQuiz(pending);
          return;
        }
        markWatched(); // first completion reveals the Next button
      }
    }
  }

  function setPlayingUI(playing) {
    $('bigPlay').style.opacity = playing ? '0' : '1';
    $('playPauseBtn').textContent = playing ? '⏸ Pause' : '▶ Play';
  }

  function togglePlay() {
    if (!playerReady || quizOpen) return;
    const s = player.getPlayerState();
    if (s === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  }

  $('videoGuard').addEventListener('click', togglePlay);
  $('playPauseBtn').addEventListener('click', togglePlay);
  $('videoGuard').addEventListener('contextmenu', (e) => e.preventDefault());

  // Pause if the user switches tabs / minimises — they must actually watch.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playerReady && !videoDone) {
      try { player.pauseVideo(); } catch {}
      saveProgress();
    }
  });

  // Last-chance save when the tab is closed or reloaded.
  window.addEventListener('pagehide', saveProgress);

  function startWatchdog() {
    stopWatchdog();
    lastTime = player.getCurrentTime() || 0;
    watchdog = setInterval(() => {
      if (!playerReady) return;
      const t = player.getCurrentTime() || 0;
      // A jump bigger than ~2s means a seek happened (console tricks etc.) —
      // snap back, unless the full video was already watched once.
      if (!seekUnlocked && t > lastTime + 2.5) {
        player.seekTo(Math.min(lastTime, maxWatched), true);
        return;
      }
      lastTime = t;
      if (t > maxWatched) maxWatched = t;
      // Remember progress every few seconds so a reload resumes from here.
      if (maxWatched - lastProgressSave >= 3) saveProgress();
      updateBar(t);
      // Time for an in-video section? Pause and pop it up. This also fires
      // when the user seeks PAST a section's timestamp — sections can't be
      // skipped even with free seeking.
      if (!quizOpen) {
        const s = pendingSection(t);
        if (s) openQuiz(s);
      }
    }, 400);
  }

  function saveProgress() {
    if (videoDone || !playerReady) return;
    lastProgressSave = maxWatched;
    saveState({ videoTime: Math.floor(maxWatched) });
  }

  function stopWatchdog() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateBar(t) {
    const pct = duration ? Math.min(100, (t / duration) * 100) : 0;
    $('progressFill').style.width = pct + '%';
    $('timeLabel').textContent = `${fmt(t)} / ${fmt(duration)}`;
  }

  // ---------- star rating widget (5 stars, half-star steps) ----------

  // datasetKey is 'qid' (feedback form) or 'quizQid' (in-video popup), so the
  // collect functions can find the widget the same way they find inputs.
  function makeStarRating(q, datasetKey) {
    const wrap = document.createElement('div');
    wrap.className = 'star-rating';
    wrap.dataset[datasetKey] = q.id;
    wrap.dataset.value = '';
    const out = document.createElement('span');
    out.className = 'star-rating-value';
    const paint = (v) => {
      wrap.querySelectorAll('.star-fill').forEach((fill, i) => {
        fill.style.width = v - i >= 1 ? '100%' : v - i >= 0.5 ? '50%' : '0%';
      });
    };
    const setValue = (v) => {
      if (String(v) === wrap.dataset.value) v = 0; // click the same star again to clear
      wrap.dataset.value = v ? String(v) : '';
      out.textContent = v ? `${v} / 5` : '';
      paint(v);
    };
    for (let i = 0; i < 5; i++) {
      const star = document.createElement('span');
      star.className = 'star';
      const base = document.createElement('span');
      base.className = 'star-base';
      base.textContent = '★';
      const fill = document.createElement('span');
      fill.className = 'star-fill';
      fill.textContent = '★';
      const left = document.createElement('span');
      left.className = 'star-hit left';
      const right = document.createElement('span');
      right.className = 'star-hit right';
      left.addEventListener('mouseenter', () => paint(i + 0.5));
      right.addEventListener('mouseenter', () => paint(i + 1));
      left.addEventListener('click', () => setValue(i + 0.5));
      right.addEventListener('click', () => setValue(i + 1));
      star.append(base, fill, left, right);
      wrap.appendChild(star);
    }
    wrap.addEventListener('mouseleave', () => paint(Number(wrap.dataset.value) || 0));
    wrap.appendChild(out);
    return wrap;
  }

  // ---------- in-video question sections ----------

  function pendingSection(t) {
    const done = new Set(state.answeredSections || []);
    return sections.find((s) => !done.has(s.id) && s.atSeconds <= t + 0.25);
  }

  function openQuiz(section) {
    quizOpen = true;
    currentSection = section;
    try { player.pauseVideo(); } catch {}
    $('quizLabel').textContent = section.heading;
    $('quizError').textContent = '';
    // Skip is only offered when nothing in the section is required.
    $('quizSkipBtn').classList.toggle('hidden', section.questions.some((q) => q.required));
    $('quizSubmitBtn').disabled = false;
    const body = $('quizBody');
    body.innerHTML = '';
    section.questions.forEach((q, i) => {
      const block = document.createElement('div');
      block.className = 'quiz-q';
      const label = document.createElement('div');
      label.className = 'quiz-q-label';
      label.textContent = `${i + 1}. ${q.label}${q.required ? ' *' : ''}`;
      block.appendChild(label);
      if (q.type === 'mcq' || q.type === 'checkbox') {
        q.options.forEach((opt) => {
          const row = document.createElement('label');
          row.className = 'toggle';
          const inp = document.createElement('input');
          inp.type = q.type === 'mcq' ? 'radio' : 'checkbox';
          inp.name = `quizq_${q.id}`;
          inp.value = opt;
          row.append(inp, document.createTextNode(' ' + opt));
          block.appendChild(row);
        });
      } else if (q.type === 'rating') {
        block.appendChild(makeStarRating(q, 'quizQid'));
      } else if (q.type === 'paragraph') {
        const ta = document.createElement('textarea');
        ta.dataset.quizQid = q.id;
        ta.placeholder = 'Your answer';
        block.appendChild(ta);
      } else {
        const inp = document.createElement('input');
        inp.type = q.type === 'number' ? 'number' : 'text';
        if (q.type === 'number') inp.step = 'any';
        inp.dataset.quizQid = q.id;
        inp.placeholder = 'Your answer';
        block.appendChild(inp);
      }
      body.appendChild(block);
    });
    $('quizOverlay').classList.remove('hidden');
  }

  function collectQuizValue(q) {
    if (q.type === 'mcq') {
      const sel = document.querySelector(`input[name="quizq_${q.id}"]:checked`);
      return sel ? sel.value : '';
    }
    if (q.type === 'checkbox') {
      return [...document.querySelectorAll(`input[name="quizq_${q.id}"]:checked`)]
        .map((i) => i.value)
        .join('; ');
    }
    if (q.type === 'rating') {
      const el = document.querySelector(`.star-rating[data-quiz-qid="${q.id}"]`);
      return (el && el.dataset.value) || '';
    }
    const inp = document.querySelector(`[data-quiz-qid="${q.id}"]`);
    return inp ? inp.value.trim() : '';
  }

  function markSectionDone(id) {
    const arr = state.answeredSections || [];
    if (!arr.includes(id)) arr.push(id);
    saveState({ answeredSections: arr });
  }

  function closeQuizAndContinue() {
    quizOpen = false;
    currentSection = null;
    $('quizOverlay').classList.add('hidden');
    if (!playerReady) return;
    if (player.getPlayerState() === YT.PlayerState.ENDED) {
      // Section was asked at the very end — check for more, then finish up.
      const next = pendingSection(Infinity);
      if (next) return openQuiz(next);
      if (!videoDone) markWatched();
    } else {
      player.playVideo(); // resume where the video paused
    }
  }

  $('quizSubmitBtn').addEventListener('click', async () => {
    const sec = currentSection;
    if (!sec) return;
    const answers = [];
    for (const q of sec.questions) {
      const value = collectQuizValue(q);
      if (q.required && !value) {
        $('quizError').textContent = `Please answer: "${q.label}"`;
        return;
      }
      if (q.type === 'number' && value && isNaN(Number(value))) {
        $('quizError').textContent = `"${q.label}" must be a number.`;
        return;
      }
      answers.push({ questionId: q.id, value });
    }
    $('quizSubmitBtn').disabled = true;
    try {
      await api(`/api/submissions/${state.submissionId}/answer`, { answers });
      markSectionDone(sec.id);
      closeQuizAndContinue();
    } catch (err) {
      $('quizError').textContent = err.message;
      $('quizSubmitBtn').disabled = false;
    }
  });

  $('quizSkipBtn').addEventListener('click', () => {
    if (!currentSection) return;
    markSectionDone(currentSection.id);
    closeQuizAndContinue();
  });

  // First full completion: record it, then hand the user free control.
  async function markWatched() {
    videoDone = true;
    saveState({ watched: true, videoTime: 0 });
    unlockSeeking();
    try {
      await api(`/api/submissions/${state.submissionId}/watched`, {
        watchSeconds: Math.round(maxWatched || duration),
      });
    } catch {}
  }

  // Seek controls are available from the very start.
  function enableSeekControls() {
    seekUnlocked = true;
    $('back10Btn').classList.remove('hidden');
    $('fwd10Btn').classList.remove('hidden');
    $('progressTrack').classList.add('seekable');
  }

  // Called once the video has ended: reveals the way forward.
  function unlockSeeking() {
    enableSeekControls();
    videoDone = true;
    $('nextBtn').classList.remove('hidden');
    $('videoNote').textContent =
      '✅ Video finished! Press "Next" when you are ready for the feedback questions.';
  }

  function seekTo(t) {
    if (!seekUnlocked || !playerReady) return;
    t = Math.max(0, Math.min(duration || 0, t));
    lastTime = t;
    player.seekTo(t, true);
    updateBar(t);
  }

  $('back10Btn').addEventListener('click', () => seekTo((player.getCurrentTime() || 0) - 10));
  $('fwd10Btn').addEventListener('click', () => seekTo((player.getCurrentTime() || 0) + 10));
  $('progressTrack').addEventListener('click', (e) => {
    if (!seekUnlocked || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * duration);
  });

  // Fullscreen on our own player container (YouTube's fullscreen stays blocked).
  $('fullscreenBtn').addEventListener('click', () => {
    const card = $('videoCard');
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      (card.requestFullscreen || card.webkitRequestFullscreen).call(card);
    }
  });
  document.addEventListener('fullscreenchange', () => {
    $('fullscreenBtn').textContent = document.fullscreenElement ? '🗗' : '⛶';
    $('fullscreenBtn').title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  });

  $('nextBtn').addEventListener('click', async () => {
    try { player.pauseVideo(); } catch {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (!task.feedbackEnabled || !formQuestions.length) {
      // Feedback form is turned off: finish the submission right away.
      $('nextBtn').disabled = true;
      try {
        await api(`/api/submissions/${state.submissionId}/answers`, { answers: [] });
        saveState({ done: true });
        showStage('thanks');
      } catch (err) {
        $('videoNote').textContent = err.message;
        $('nextBtn').disabled = false;
      }
      return;
    }
    saveState({ stage: 'questions' });
    renderQuestions();
    showStage('questions');
  });

  $('backToVideoBtn').addEventListener('click', () => {
    saveState({ stage: 'video' });
    showStage('video');
    initPlayer(); // needed when the page was reloaded directly onto the form
  });

  // ---------- keyboard controls (video stage only) ----------

  // Blur player buttons after a click so pressing Space afterwards doesn't
  // re-trigger the focused button on top of the Space shortcut.
  document.querySelectorAll('.player-bar .btn').forEach((b) =>
    b.addEventListener('click', () => b.blur())
  );

  document.addEventListener('keydown', (e) => {
    if ($('stage-video').classList.contains('hidden')) return; // only on the video screen
    if (quizOpen) return; // a question popup is showing
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return; // typing
    if (e.ctrlKey || e.altKey || e.metaKey) return; // leave browser shortcuts alone
    if (!playerReady) return;

    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft': // seekTo() ignores these until the full video was watched
        e.preventDefault();
        seekTo((player.getCurrentTime() || 0) - 5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo((player.getCurrentTime() || 0) + 5);
        break;
      case 'j':
      case 'J':
        seekTo((player.getCurrentTime() || 0) - 10);
        break;
      case 'l':
      case 'L':
        seekTo((player.getCurrentTime() || 0) + 10);
        break;
      case 'f':
      case 'F':
        $('fullscreenBtn').click();
        break;
      case 'm':
      case 'M':
        try {
          player.isMuted() ? player.unMute() : player.mute();
        } catch {}
        break;
    }
  });

  // ---------- questions ----------

  function renderQuestions() {
    const form = $('questionsForm');
    form.innerHTML = '';
    formQuestions.forEach((q, i) => {
      const wrap = document.createElement('div');
      wrap.style.marginBottom = '22px';
      const label = document.createElement('label');
      label.className = 'field-label';
      label.style.fontSize = '15.5px';
      label.innerHTML = `${i + 1}. ${escapeHtml(q.label)} ${q.required ? '<span class="req" style="color:var(--danger)">*</span>' : ''}`;
      wrap.appendChild(label);

      if (q.type === 'text') {
        wrap.appendChild(makeInput('text', q));
      } else if (q.type === 'number') {
        const inp = makeInput('number', q);
        inp.step = 'any';
        wrap.appendChild(inp);
      } else if (q.type === 'rating') {
        wrap.appendChild(makeStarRating(q, 'qid'));
      } else if (q.type === 'paragraph') {
        const ta = document.createElement('textarea');
        ta.dataset.qid = q.id;
        ta.placeholder = 'Your answer';
        wrap.appendChild(ta);
      } else if (q.type === 'mcq' || q.type === 'checkbox') {
        q.options.forEach((opt) => {
          const row = document.createElement('label');
          row.className = 'toggle';
          row.style.display = 'flex';
          row.style.margin = '7px 0';
          const inp = document.createElement('input');
          inp.type = q.type === 'mcq' ? 'radio' : 'checkbox';
          inp.name = `q_${q.id}`;
          inp.value = opt;
          inp.dataset.qid = q.id;
          row.append(inp, document.createTextNode(' ' + opt));
          wrap.appendChild(row);
        });
      }
      form.appendChild(wrap);
    });
  }

  function makeInput(type, q) {
    const inp = document.createElement('input');
    inp.type = type;
    inp.dataset.qid = q.id;
    inp.placeholder = 'Your answer';
    return inp;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function collectAnswers() {
    const answers = [];
    for (const q of formQuestions) {
      let value = '';
      if (q.type === 'mcq') {
        const sel = document.querySelector(`input[name="q_${q.id}"]:checked`);
        value = sel ? sel.value : '';
      } else if (q.type === 'checkbox') {
        const sels = [...document.querySelectorAll(`input[name="q_${q.id}"]:checked`)];
        value = sels.map((s) => s.value).join('; ');
      } else if (q.type === 'rating') {
        const el = document.querySelector(`.star-rating[data-qid="${q.id}"]`);
        value = (el && el.dataset.value) || '';
      } else {
        const inp = document.querySelector(`[data-qid="${q.id}"]`);
        value = inp ? inp.value.trim() : '';
      }
      if (q.required && !value) {
        return { error: `Please answer question: "${q.label}"` };
      }
      answers.push({ questionId: q.id, value });
    }
    return { answers };
  }

  $('submitAnswersBtn').addEventListener('click', async () => {
    $('questionsError').textContent = '';
    const { answers, error } = collectAnswers();
    if (error) {
      $('questionsError').textContent = error;
      return;
    }
    $('submitAnswersBtn').disabled = true;
    try {
      await api(`/api/submissions/${state.submissionId}/answers`, { answers });
      saveState({ done: true });
      showStage('thanks');
    } catch (err) {
      $('questionsError').textContent = err.message;
      $('submitAnswersBtn').disabled = false;
    }
  });
})();
