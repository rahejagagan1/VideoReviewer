/* Admin dashboard logic */
(() => {
  const $ = (id) => document.getElementById(id);
  const views = ['login', 'tasks', 'editor', 'detail'];

  const DEFAULT_INSTRUCTIONS = `Welcome, and thank you for taking part in this video review.

Your role is to watch the video and share your natural, honest reaction. Please focus on how the video makes you feel, what keeps you interested, and where your attention drops.

1. Find a quiet place and turn your sound on so you don't miss anything.
2. Please watch the video from start to finish. Try not to switch tabs or apps — the video will pause automatically if you do, to make sure nothing is missed.
3. Short questions will appear over the video at certain moments. Answer each one to continue watching — this helps us capture your reaction as it happens.
4. The video controls (skip, rewind and the progress bar) stay locked until you answer the first set of pop-up questions. After you complete that first section, the controls unlock and you can move through the video freely.
5. Your progress is saved automatically. If the page reloads, you'll pick up right where you left off (on this same device and browser).
6. When the video finishes, press "Next" to continue to any remaining questions.
7. There are no right or wrong answers — we simply want your genuine opinion. Questions marked with an asterisk (*) are required.
8. You can submit only once, so please review your answers before you submit.

When you're ready, tick the box below and press "Play Video".`;

  // In-video sections pre-filled into every NEW task's builder. Fully editable
  // (or removable) per task before saving.
  const DEFAULT_SECTIONS = [
    {
      heading: 'INTRO:',
      atTime: '',
      questions: [
        { type: 'paragraph', label: 'Was the introduction engaging?', required: true, options: [] },
        { type: 'paragraph', label: 'Would you continue watching after the first 30 seconds?', required: true, options: [] },
        { type: 'paragraph', label: 'Did the video make you want to watch until the end?', required: true, options: [] },
        { type: 'paragraph', label: 'Which part made you the most curious?', required: true, options: [] },
        { type: 'paragraph', label: 'Which part felt boring or slow?', required: true, options: [] },
        { type: 'rating', label: 'RATING', required: true, options: [] },
      ],
    },
    {
      heading: 'STORY:',
      atTime: '',
      questions: [
        { type: 'paragraph', label: 'At what exact moment did you become interested?', required: true, options: [] },
        { type: 'paragraph', label: 'At what timestamp did your attention start dropping?', required: true, options: [] },
        { type: 'paragraph', label: 'Which section felt too slow or repetitive?', required: true, options: [] },
        { type: 'paragraph', label: 'Was there any moment when you became confused?', required: false, options: [] },
        { type: 'paragraph', label: 'What important question did you expect the documentary to answer?', required: true, options: [] },
        { type: 'paragraph', label: 'Did the documentary answer that question?', required: true, options: [] },
        { type: 'paragraph', label: 'Which scene had the strongest emotional impact?', required: true, options: [] },
        { type: 'paragraph', label: 'Which scene would you remove?', required: true, options: [] },
        { type: 'paragraph', label: 'Did any claim feel exaggerated, unfair, or unsupported?', required: true, options: [] },
        { type: 'paragraph', label: 'Would you recommend it to someone?', required: true, options: [] },
        { type: 'rating', label: 'RATING', required: true, options: [] },
      ],
    },
  ];

  // Fresh deep copy so edits to one new task never bleed into the template.
  const cloneDefaultSections = () =>
    DEFAULT_SECTIONS.map((s) => ({
      heading: s.heading,
      atTime: s.atTime,
      questions: s.questions.map((q) => ({
        type: q.type,
        label: q.label,
        required: q.required,
        options: [...q.options],
      })),
    }));

  const TYPE_LABELS = {
    text: 'Short answer',
    paragraph: 'Paragraph',
    number: 'Number',
    mcq: 'Multiple choice',
    checkbox: 'Checkboxes',
    rating: 'Star rating',
  };

  let editingTaskId = null; // null = creating new
  let editorQuestions = []; // feedback-form questions in the builder
  let editorSections = []; // in-video sections in the builder
  let editorThumbnails = []; // thumbnail-choice entries in the builder
  let defaultQuestions = []; // saved default questions (pre-fill new sections)
  let currentDetailId = null;
  let currentTask = null; // task shown in detail view
  let currentSubs = []; // its submissions, for the answer modal

  function show(view) {
    views.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== view));
    $('logoutBtn').classList.toggle('hidden', view === 'login');
    window.scrollTo(0, 0);
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // "3:15" -> 195, "1:02:03" -> 3723, "90" -> 90. Returns null for empty, NaN for junk.
  function parseTimestamp(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (!/^\d+(:[0-5]?\d){0,2}$/.test(t)) return NaN;
    return t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  function formatTimestamp(seconds) {
    if (seconds == null) return '';
    seconds = Math.floor(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- auth ----------

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    const btn = $('loginBtn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('loginPassword').value } });
      await loadTasks(); // wait for the dashboard data before dropping the spinner
    } catch (err) {
      $('loginError').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    show('login');
  });

  // ---------- task list ----------

  async function loadTasks() {
    let tasks;
    try {
      tasks = await api('/api/admin/tasks');
    } catch {
      show('login');
      return;
    }
    const list = $('taskList');
    if (!tasks.length) {
      list.innerHTML = `<div class="card" style="text-align:center;padding:48px;">
        <h2>No tasks yet</h2>
        <p class="muted">Click "New Task" to create your first video review task.</p>
      </div>`;
    } else {
      list.innerHTML = tasks
        .map(
          (t) => `
        <div class="card">
          <div class="row between">
            <div>
              <h2 style="margin-bottom:4px;">${esc(t.title)}</h2>
              <p class="muted small" style="margin:0;">
                Created ${esc(t.created_at)} UTC ·
                ${t.question_count} question${t.question_count === 1 ? '' : 's'} ·
                <b>${t.submission_count}</b> submission${t.submission_count === 1 ? '' : 's'}
                (${t.completed_count} completed)
              </p>
            </div>
            <div class="row">
              <button class="btn secondary small" data-copy="${t.id}">🔗 Copy link</button>
              <button class="btn small" data-open="${t.id}">Open →</button>
            </div>
          </div>
        </div>`
        )
        .join('');
      list.querySelectorAll('[data-open]').forEach((b) =>
        b.addEventListener('click', () => openDetail(b.dataset.open))
      );
      list.querySelectorAll('[data-copy]').forEach((b) =>
        b.addEventListener('click', () => {
          copyText(taskLink(b.dataset.copy));
          b.textContent = '✓ Copied';
          setTimeout(() => (b.textContent = '🔗 Copy link'), 1500);
        })
      );
    }
    show('tasks');
  }

  function taskLink(id) {
    return `${location.origin}/t/${id}`;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  // ---------- editor ----------

  async function loadDefaults() {
    try {
      defaultQuestions = await api('/api/admin/default-questions');
    } catch {
      defaultQuestions = [];
    }
  }

  $('newTaskBtn').addEventListener('click', async () => {
    editingTaskId = null;
    $('editorTitle').textContent = 'New task';
    $('taskTitle').value = '';
    $('taskVideoUrl').value = '';
    $('taskInstructions').value = DEFAULT_INSTRUCTIONS;
    editorQuestions = [];
    editorSections = cloneDefaultSections();
    editorThumbnails = [];
    $('feedbackToggle').checked = true;
    await loadDefaults();
    openEditorStep(1);
    show('editor');
  });

  $('editorBackBtn').addEventListener('click', () => {
    if (editingTaskId) openDetail(editingTaskId);
    else loadTasks();
  });

  function openEditorStep(step) {
    $('editorStep1').classList.toggle('hidden', step !== 1);
    $('editorStep2').classList.toggle('hidden', step !== 2);
    $('stepPill1').classList.toggle('active', step === 1);
    $('stepPill2').classList.toggle('active', step === 2);
    $('editorError1').textContent = '';
    $('editorError2').textContent = '';
    if (step === 2) {
      renderThumbBuilder();
      renderSectionBuilder();
      renderQuestionBuilder();
    }
  }

  // ---------- thumbnail-choice builder ----------

  $('addThumbBtn').addEventListener('click', () => {
    editorThumbnails.push({ title: '', image: '' });
    renderThumbBuilder();
  });

  // Downscales an uploaded image and returns it as a compact JPEG data URL.
  function readImageFile(file, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxW = 960;
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        cb(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function renderThumbBuilder() {
    const wrap = $('thumbList');
    wrap.innerHTML = '';
    if (!editorThumbnails.length) {
      wrap.innerHTML =
        '<p class="muted small">No thumbnails yet — the thumbnail page will be skipped for users.</p>';
      return;
    }
    editorThumbnails.forEach((t, i) => {
      const card = document.createElement('div');
      card.className = 'thumb-card';

      const preview = document.createElement('div');
      preview.className = 'thumb-preview';
      if (t.image) {
        const img = document.createElement('img');
        img.src = t.image;
        img.alt = t.title || `Thumbnail ${i + 1}`;
        preview.appendChild(img);
      } else {
        preview.textContent = 'No image yet';
      }

      const fields = document.createElement('div');
      fields.className = 'thumb-fields';
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.placeholder = `Thumbnail ${i + 1} title`;
      titleInput.value = t.title;
      titleInput.addEventListener('input', () => (t.title = titleInput.value));
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.placeholder = 'Paste an image URL, or upload a file below';
      urlInput.value = t.image.startsWith('data:') ? '' : t.image;
      urlInput.addEventListener('change', () => {
        t.image = urlInput.value.trim();
        renderThumbBuilder();
      });
      const row = document.createElement('div');
      row.className = 'row';
      const fileBtn = document.createElement('input');
      fileBtn.type = 'file';
      fileBtn.accept = 'image/*';
      fileBtn.addEventListener('change', () => {
        if (fileBtn.files[0])
          readImageFile(fileBtn.files[0], (dataUrl) => {
            t.image = dataUrl;
            renderThumbBuilder();
          });
      });
      const del = document.createElement('button');
      del.className = 'btn danger small';
      del.type = 'button';
      del.textContent = '🗑 Remove';
      del.addEventListener('click', () => {
        editorThumbnails.splice(i, 1);
        renderThumbBuilder();
      });
      row.append(fileBtn, del);
      fields.append(titleInput, urlInput, row);
      card.append(preview, fields);
      wrap.appendChild(card);
    });
  }

  $('editorNextBtn').addEventListener('click', () => {
    if (!$('taskTitle').value.trim()) {
      $('editorError1').textContent = 'Please enter a task title.';
      return;
    }
    if (!$('taskVideoUrl').value.trim()) {
      $('editorError1').textContent = 'Please paste the YouTube video link.';
      return;
    }
    if (editorQuestions.length === 0) addQuestion();
    openEditorStep(2);
  });

  $('editorPrevBtn').addEventListener('click', () => openEditorStep(1));
  $('addQuestionBtn').addEventListener('click', () => {
    addQuestion();
    renderQuestionBuilder();
  });

  function newBlankQuestion() {
    return { type: 'mcq', label: '', required: true, options: ['', ''] };
  }

  function addQuestion() {
    editorQuestions.push(newBlankQuestion());
  }

  function renderQuestionBuilder() {
    renderQuestionCards($('questionList'), editorQuestions, {
      rerender: renderQuestionBuilder,
      showDefault: false,
    });
  }

  // Generic question-card renderer, shared by the form list and each section.
  function renderQuestionCards(wrap, list, opts) {
    const rerender = opts.rerender;
    wrap.innerHTML = '';
    list.forEach((q, i) => {
      const card = document.createElement('div');
      card.className = 'q-card';

      const head = document.createElement('div');
      head.className = 'q-head';
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.placeholder = `Question ${i + 1}`;
      labelInput.value = q.label;
      labelInput.addEventListener('input', () => (q.label = labelInput.value));
      const typeSel = document.createElement('select');
      for (const [val, name] of Object.entries(TYPE_LABELS)) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = name;
        if (q.type === val) o.selected = true;
        typeSel.appendChild(o);
      }
      typeSel.addEventListener('change', () => {
        q.type = typeSel.value;
        if ((q.type === 'mcq' || q.type === 'checkbox') && q.options.length < 2)
          q.options = ['', ''];
        rerender();
      });
      head.append(labelInput, typeSel);
      card.appendChild(head);

      if (q.type === 'mcq' || q.type === 'checkbox') {
        const optsWrap = document.createElement('div');
        optsWrap.className = 'q-options';
        q.options.forEach((opt, oi) => {
          const row = document.createElement('div');
          row.className = 'q-option-row';
          const dot = document.createElement('span');
          dot.className = 'dot' + (q.type === 'checkbox' ? ' square' : '');
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = `Option ${oi + 1}`;
          inp.value = opt;
          inp.addEventListener('input', () => (q.options[oi] = inp.value));
          const del = document.createElement('button');
          del.className = 'icon-btn';
          del.type = 'button';
          del.textContent = '✕';
          del.title = 'Remove option';
          del.addEventListener('click', () => {
            q.options.splice(oi, 1);
            rerender();
          });
          row.append(dot, inp, del);
          optsWrap.appendChild(row);
        });
        const addOpt = document.createElement('button');
        addOpt.type = 'button';
        addOpt.className = 'btn secondary small';
        addOpt.textContent = '＋ Add option';
        addOpt.addEventListener('click', () => {
          q.options.push('');
          rerender();
        });
        optsWrap.appendChild(addOpt);
        card.appendChild(optsWrap);
      } else {
        const hint = document.createElement('p');
        hint.className = 'muted small';
        hint.style.margin = '10px 0 0';
        hint.textContent =
          q.type === 'rating'
            ? 'User will pick a rating out of 5 stars (★★★★★). Half stars allowed.'
            : q.type === 'number'
            ? 'User will type a number.'
            : q.type === 'paragraph'
            ? 'User will type a long answer.'
            : 'User will type a short answer.';
        card.appendChild(hint);
      }

      const foot = document.createElement('div');
      foot.className = 'q-foot';

      const up = document.createElement('button');
      up.className = 'icon-btn';
      up.type = 'button';
      up.textContent = '↑';
      up.title = 'Move up';
      up.disabled = i === 0;
      up.addEventListener('click', () => {
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        rerender();
      });
      const down = document.createElement('button');
      down.className = 'icon-btn';
      down.type = 'button';
      down.textContent = '↓';
      down.title = 'Move down';
      down.disabled = i === list.length - 1;
      down.addEventListener('click', () => {
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        rerender();
      });

      const reqToggle = document.createElement('label');
      reqToggle.className = 'toggle';
      const reqCb = document.createElement('input');
      reqCb.type = 'checkbox';
      reqCb.checked = q.required;
      reqCb.addEventListener('change', () => (q.required = reqCb.checked));
      reqToggle.append(reqCb, document.createTextNode(' Required'));

      const delQ = document.createElement('button');
      delQ.className = 'icon-btn';
      delQ.type = 'button';
      delQ.textContent = '🗑';
      delQ.title = 'Delete question';
      delQ.addEventListener('click', () => {
        list.splice(i, 1);
        rerender();
      });

      foot.append(up, down, reqToggle);
      if (opts.showDefault) {
        const star = document.createElement('button');
        star.className = 'icon-btn';
        star.type = 'button';
        star.textContent = q.defaultId ? '★' : '☆';
        star.style.color = q.defaultId ? '#eab308' : '';
        star.title = q.defaultId
          ? 'Default question — pre-fills new sections (click to remove from defaults)'
          : 'Save as default so it pre-fills future sections';
        star.addEventListener('click', () => toggleDefault(q, rerender));
        foot.appendChild(star);
      }
      foot.appendChild(delQ);
      card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  async function toggleDefault(q, rerender) {
    try {
      if (q.defaultId) {
        await api(`/api/admin/default-questions/${q.defaultId}`, { method: 'DELETE' });
        defaultQuestions = defaultQuestions.filter((d) => d.id !== q.defaultId);
        q.defaultId = null;
      } else {
        if (!q.label.trim()) {
          alert('Write the question text before saving it as a default.');
          return;
        }
        const d = await api('/api/admin/default-questions', {
          method: 'POST',
          body: {
            type: q.type,
            label: q.label.trim(),
            required: q.required,
            options: (q.options || []).map((o) => o.trim()).filter(Boolean),
          },
        });
        defaultQuestions.push(d);
        q.defaultId = d.id;
      }
      rerender();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- in-video section builder ----------

  $('addSectionBtn').addEventListener('click', () => {
    editorSections.push({
      heading: '',
      atTime: '',
      questions: defaultQuestions.map((d) => ({
        type: d.type,
        label: d.label,
        required: d.required,
        options: [...d.options],
        defaultId: d.id,
      })),
    });
    renderSectionBuilder();
  });

  function renderSectionBuilder() {
    const wrap = $('sectionList');
    wrap.innerHTML = '';
    if (!editorSections.length) {
      wrap.innerHTML =
        '<p class="muted small">No sections yet. Click "＋ Add section" to pause the video at a timestamp and ask questions.</p>';
      return;
    }
    editorSections.forEach((sec, i) => {
      const card = document.createElement('div');
      card.className = 'section-card';

      const head = document.createElement('div');
      head.className = 'section-head';
      const headingInput = document.createElement('input');
      headingInput.type = 'text';
      headingInput.placeholder = `Section ${i + 1} heading (e.g. "Quick check")`;
      headingInput.value = sec.heading;
      headingInput.addEventListener('input', () => (sec.heading = headingInput.value));
      const atLabel = document.createElement('span');
      atLabel.className = 'muted small';
      atLabel.textContent = '⏱ at';
      const timeInput = document.createElement('input');
      timeInput.type = 'text';
      timeInput.className = 'q-time-input';
      timeInput.placeholder = 'mm:ss';
      timeInput.value = sec.atTime;
      timeInput.addEventListener('input', () => (sec.atTime = timeInput.value));
      const delSec = document.createElement('button');
      delSec.className = 'icon-btn';
      delSec.type = 'button';
      delSec.textContent = '🗑';
      delSec.title = 'Delete section';
      delSec.addEventListener('click', () => {
        editorSections.splice(i, 1);
        renderSectionBuilder();
      });
      head.append(headingInput, atLabel, timeInput, delSec);
      card.appendChild(head);

      const qwrap = document.createElement('div');
      qwrap.style.marginTop = '12px';
      card.appendChild(qwrap);
      renderQuestionCards(qwrap, sec.questions, {
        rerender: renderSectionBuilder,
        showDefault: true,
      });

      const addQ = document.createElement('button');
      addQ.type = 'button';
      addQ.className = 'btn secondary small';
      addQ.textContent = '＋ Add question to this section';
      addQ.addEventListener('click', () => {
        sec.questions.push(newBlankQuestion());
        renderSectionBuilder();
      });
      card.appendChild(addQ);
      wrap.appendChild(card);
    });
  }

  $('editorSaveBtn').addEventListener('click', async () => {
    $('editorError2').textContent = '';
    const body = {
      title: $('taskTitle').value,
      videoUrl: $('taskVideoUrl').value,
      instructions: $('taskInstructions').value,
    };
    const cleanQ = (q) => ({
      type: q.type,
      required: q.required,
      label: q.label.trim(),
      options: (q.options || []).map((o) => o.trim()).filter(Boolean),
    });
    const questions = editorQuestions.map(cleanQ).filter((q) => q.label);
    const sections = editorSections
      .map((s) => ({
        heading: s.heading.trim(),
        atSeconds: parseTimestamp(s.atTime),
        questions: s.questions.map(cleanQ).filter((q) => q.label),
      }))
      .filter((s) => s.heading || s.questions.length);
    for (const s of sections) {
      if (!s.heading) {
        $('editorError2').textContent = 'Every section needs a heading.';
        return;
      }
      if (s.atSeconds == null || Number.isNaN(s.atSeconds)) {
        $('editorError2').textContent = `Section "${s.heading}" needs a timestamp like 1:00 or 3:15.`;
        return;
      }
      if (!s.questions.length) {
        $('editorError2').textContent = `Section "${s.heading}" needs at least one question.`;
        return;
      }
    }
    const thumbnails = editorThumbnails
      .map((t) => ({ title: (t.title || '').trim(), image: (t.image || '').trim() }))
      .filter((t) => t.title || t.image);
    for (const t of thumbnails) {
      if (!t.title) {
        $('editorError2').textContent = 'Every thumbnail needs a title.';
        return;
      }
      if (!t.image) {
        $('editorError2').textContent = `Thumbnail "${t.title}" needs an image (upload one or paste a URL).`;
        return;
      }
    }
    if (!questions.length && !sections.length && !thumbnails.length) {
      $('editorError2').textContent = 'Add at least one section, feedback question or thumbnail.';
      return;
    }
    try {
      let task;
      if (editingTaskId) {
        task = await api(`/api/admin/tasks/${editingTaskId}`, { method: 'PUT', body });
      } else {
        task = await api('/api/admin/tasks', { method: 'POST', body });
      }
      await api(`/api/admin/tasks/${task.id}/questions`, {
        method: 'PUT',
        body: { questions, sections, thumbnails, feedbackEnabled: $('feedbackToggle').checked },
      });
      openDetail(task.id);
    } catch (err) {
      $('editorError2').textContent = err.message;
    }
  });

  // ---------- detail ----------

  async function openDetail(id) {
    currentDetailId = id;
    let data;
    try {
      data = await api(`/api/admin/tasks/${id}/submissions`);
    } catch (err) {
      alert(err.message);
      loadTasks();
      return;
    }
    const { task, submissions } = data;
    currentTask = task;
    currentSubs = submissions;
    $('detailTitle').textContent = task.title;
    $('detailMeta').innerHTML = `Video: <a href="${esc(task.video_url)}" target="_blank" rel="noopener">${esc(
      task.video_url
    )}</a> · Created ${esc(task.created_at)} UTC · ${task.questions.length} questions`;
    $('detailShareLink').textContent = taskLink(task.id);
    $('exportCsvBtn').href = `/api/admin/tasks/${task.id}/export.xlsx`;
    $('detailSubCount').textContent = submissions.length;

    const table = $('subsTable');
    if (!submissions.length) {
      table.innerHTML = '';
      $('noSubsMsg').textContent = 'No submissions yet. Share the link above to start collecting responses.';
      $('noSubsMsg').classList.remove('hidden');
    } else {
      $('noSubsMsg').classList.add('hidden');
      const badge = (s) =>
        s === 'completed'
          ? '<span class="badge green">Completed</span>'
          : s === 'video_watched'
          ? '<span class="badge orange">Watched video</span>'
          : '<span class="badge gray">Started</span>';
      table.innerHTML =
        `<thead><tr>
          <th></th>
          <th>Name</th><th>Email</th><th>County</th><th>Country</th><th>Status</th>
          <th>Started (UTC)</th><th>Completed (UTC)</th>
          ${task.thumbnails.length ? '<th>Thumbnail</th><th>Thumb Rating</th>' : ''}
        </tr></thead><tbody>` +
        submissions
          .map(
            (s) => `<tr>
          <td><button class="btn secondary small" data-view="${esc(s.id)}">👁 View</button></td>
          <td>${esc(s.name)}</td>
          <td>${esc(s.email)}</td>
          <td>${esc(s.county)}</td>
          <td>${esc(s.country)}</td>
          <td>${badge(s.status)}</td>
          <td>${esc(s.started_at)}</td>
          <td>${esc(s.completed_at || '—')}</td>
          ${task.thumbnails.length ? `<td>${esc(s.thumbnail_title || '—')}</td><td>${s.thumbnail_rating != null ? `${esc(s.thumbnail_rating)} ★` : '—'}</td>` : ''}
        </tr>`
          )
          .join('') +
        '</tbody>';
      table.querySelectorAll('[data-view]').forEach((b) =>
        b.addEventListener('click', () => openSubModal(b.dataset.view))
      );
    }
    show('detail');
  }

  // ---------- submission answers modal ----------

  function openSubModal(subId) {
    const sub = currentSubs.find((s) => s.id === subId);
    if (!sub || !currentTask) return;
    const statusText = { started: 'Started (did not finish video)', video_watched: 'Watched video (no answers yet)', completed: 'Completed' };
    $('subModalTitle').textContent = sub.name;
    $('subModalMeta').innerHTML =
      `${esc(sub.email)} · ${esc(sub.county)}, ${esc(sub.country)}<br>` +
      `${esc(statusText[sub.status] || sub.status)} · Started ${esc(sub.started_at)} UTC` +
      (sub.completed_at ? ` · Completed ${esc(sub.completed_at)} UTC` : '');

    // One answer block.
    let n = 0;
    const renderQ = (q) => {
      const a = sub.answers[q.id];
      const has = a != null && String(a).trim() !== '';
      return `<div class="qa">
        <div class="qa-q">${++n}. ${esc(q.label)}</div>
        <div class="qa-a">${
          has
            ? q.type === 'rating'
              ? `<span style="color:#eab308">★</span> ${esc(a)} / 5`
              : esc(a)
            : '<span class="muted">No answer yet</span>'
        }</div>
      </div>`;
    };

    let html = '';

    // Which thumbnail the user picked (with the actual image).
    if (sub.thumbnail_id != null || sub.thumbnail_title) {
      // Match by id, falling back to title: editing a task recreates thumbnails
      // with new ids, so an older submission's stored id may no longer exist.
      const thumbs = currentTask.thumbnails || [];
      const t =
        thumbs.find((x) => x.id === sub.thumbnail_id) ||
        thumbs.find((x) => x.title === sub.thumbnail_title);
      const title = sub.thumbnail_title || (t && t.title) || '';
      html += `<div class="qa-section">
        <h3 class="qa-section-title">🖼 Thumbnail selected: ${esc(title)}${
          sub.thumbnail_rating != null
            ? ` <span class="muted small">· ⭐ ${esc(sub.thumbnail_rating)} / 5</span>`
            : ''
        }</h3>
        ${t && t.image ? `<div class="qa-thumb-wrap">
          <img class="qa-thumb" src="${esc(t.image)}" alt="selected thumbnail">
          <div class="qa-thumb-overlay"><span>⛶</span></div>
        </div>` : ''}
      </div>`;
    }

    // Answers grouped by in-video section, in the order they appear.
    for (const sec of currentTask.sections || []) {
      if (!sec.questions.length) continue;
      html += `<div class="qa-section">
        <h3 class="qa-section-title">⏱ ${esc(sec.heading)} <span class="muted small">· at ${formatTimestamp(sec.at_seconds)}</span></h3>
        ${sec.questions.map(renderQ).join('')}
      </div>`;
    }

    // Feedback-form questions asked after the video (no section).
    const freeQs = currentTask.questions.filter((q) => q.section_id == null);
    if (freeQs.length) {
      html += `<div class="qa-section">
        <h3 class="qa-section-title">📝 After the video</h3>
        ${freeQs.map(renderQ).join('')}
      </div>`;
    }

    $('subModalBody').innerHTML =
      html || '<p class="muted">This task has no questions.</p>';
    $('subModal').classList.remove('hidden');
  }

  $('subModalClose').addEventListener('click', () => $('subModal').classList.add('hidden'));
  $('subModal').addEventListener('click', (e) => {
    if (e.target.id === 'subModal') $('subModal').classList.add('hidden');
  });

  // Click the selected thumbnail to view it full screen.
  function openLightbox(src) {
    let box = document.getElementById('imgLightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'imgLightbox';
      box.className = 'img-lightbox hidden';
      box.innerHTML = '<img alt="thumbnail full view" />';
      const close = () => box.classList.add('hidden');
      box.addEventListener('click', close);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });
      document.body.appendChild(box);
    }
    box.querySelector('img').src = src;
    box.classList.remove('hidden');
  }
  $('subModalBody').addEventListener('click', (e) => {
    const wrap = e.target.closest('.qa-thumb-wrap');
    if (wrap) openLightbox(wrap.querySelector('img').src);
  });

  $('detailBackBtn').addEventListener('click', loadTasks);
  $('refreshSubsBtn').addEventListener('click', () => openDetail(currentDetailId));
  $('copyLinkBtn').addEventListener('click', () => {
    copyText(taskLink(currentDetailId));
    $('copyLinkBtn').textContent = '✓';
    setTimeout(() => ($('copyLinkBtn').textContent = 'Copy'), 1500);
  });

  $('detailEditBtn').addEventListener('click', async () => {
    const task = await api(`/api/admin/tasks/${currentDetailId}`);
    await loadDefaults();
    editingTaskId = task.id;
    $('editorTitle').textContent = 'Edit task';
    $('taskTitle').value = task.title;
    $('taskVideoUrl').value = task.video_url;
    $('taskInstructions').value = task.instructions || DEFAULT_INSTRUCTIONS;
    const asEditorQ = (q) => ({
      type: q.type,
      label: q.label,
      required: q.required,
      options: [...q.options],
      defaultId:
        (defaultQuestions.find((d) => d.label === q.label && d.type === q.type) || {}).id || null,
    });
    editorQuestions = task.questions.filter((q) => q.section_id == null).map(asEditorQ);
    editorSections = (task.sections || []).map((s) => ({
      heading: s.heading,
      atTime: formatTimestamp(s.at_seconds),
      questions: s.questions.map(asEditorQ),
    }));
    editorThumbnails = (task.thumbnails || []).map((t) => ({ title: t.title, image: t.image }));
    $('feedbackToggle').checked = !!task.feedback_enabled;
    openEditorStep(1);
    show('editor');
  });

  $('detailDeleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this task AND all its submissions? This cannot be undone.')) return;
    await api(`/api/admin/tasks/${currentDetailId}`, { method: 'DELETE' });
    loadTasks();
  });

  // ---------- boot ----------

  (async () => {
    try {
      await api('/api/admin/me');
      loadTasks();
    } catch {
      show('login');
    }
  })();
})();
