const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const store = require('./db');

const app = express();
const PORT = process.env.PORT || 4400;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Generous limit: thumbnail images are uploaded as data URLs inside JSON.
app.use(express.json({ limit: '30mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    // Always revalidate so browsers pick up updated scripts/styles immediately.
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

// ---------- helpers ----------

const sessions = new Set();

// Wraps async route handlers so thrown/rejected errors hit the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req).admin_session;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Not authorized' });
}

function extractVideoId(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?]+)/);
      if (m) return m[2];
    }
    return null;
  } catch {
    return null;
  }
}

const QUESTION_TYPES = new Set(['text', 'paragraph', 'number', 'mcq', 'checkbox', 'rating']);

// Star ratings go from 0.5 to 5 in half-star steps.
function isValidRating(v) {
  const n = Number(v);
  return !isNaN(n) && n >= 0.5 && n <= 5 && (n * 2) % 1 === 0;
}

function validateQuestions(questions) {
  if (!Array.isArray(questions)) return 'Invalid questions.';
  for (const q of questions) {
    if (!QUESTION_TYPES.has(q.type)) return `Unknown question type: ${q.type}`;
    if (!q.label || !String(q.label).trim()) return 'Every question needs a label.';
    if ((q.type === 'mcq' || q.type === 'checkbox')) {
      const opts = (q.options || []).map((o) => String(o).trim()).filter(Boolean);
      if (opts.length < 2) return `"${q.label}" needs at least 2 options.`;
      q.options = opts;
    } else {
      q.options = [];
    }
    q.label = String(q.label).trim();
    q.required = q.required !== false;
  }
  return null;
}

function validateSections(sections) {
  if (!Array.isArray(sections)) return 'Invalid sections.';
  for (const s of sections) {
    if (!s.heading || !String(s.heading).trim()) return 'Every section needs a heading.';
    s.heading = String(s.heading).trim();
    s.atSeconds = Number(s.atSeconds);
    if (isNaN(s.atSeconds) || s.atSeconds < 0)
      return `Section "${s.heading}" needs a valid video timestamp.`;
    if (!Array.isArray(s.questions) || s.questions.length === 0)
      return `Section "${s.heading}" needs at least one question.`;
    const err = validateQuestions(s.questions);
    if (err) return err;
  }
  return null;
}

function validateThumbnails(thumbnails) {
  if (!Array.isArray(thumbnails)) return 'Invalid thumbnails.';
  for (const t of thumbnails) {
    if (!t.title || !String(t.title).trim()) return 'Every thumbnail needs a title.';
    if (!t.image || !String(t.image).trim()) return `Thumbnail "${t.title}" needs an image.`;
    t.title = String(t.title).trim();
    t.image = String(t.image).trim();
  }
  return null;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- admin auth ----------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.add(token);
  res.setHeader(
    'Set-Cookie',
    `admin_session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 7}; SameSite=Lax`
  );
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req).admin_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

// ---------- admin: tasks ----------

app.get('/api/admin/tasks', requireAdmin, ah(async (req, res) => {
  res.json(await store.listTasks());
}));

app.post('/api/admin/tasks', requireAdmin, ah(async (req, res) => {
  const { title, videoUrl, instructions } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
  const videoId = extractVideoId(videoUrl || '');
  if (!videoId) return res.status(400).json({ error: 'That does not look like a valid YouTube link.' });
  const task = await store.createTask({
    title: String(title).trim(),
    videoUrl: String(videoUrl).trim(),
    videoId,
    instructions: String(instructions || ''),
  });
  res.json(task);
}));

app.get('/api/admin/tasks/:id', requireAdmin, ah(async (req, res) => {
  const task = await store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
}));

app.put('/api/admin/tasks/:id', requireAdmin, ah(async (req, res) => {
  const existing = await store.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  const { title, videoUrl, instructions } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required.' });
  const videoId = extractVideoId(videoUrl || '');
  if (!videoId) return res.status(400).json({ error: 'That does not look like a valid YouTube link.' });
  res.json(
    await store.updateTask(req.params.id, {
      title: String(title).trim(),
      videoUrl: String(videoUrl).trim(),
      videoId,
      instructions: String(instructions || ''),
    })
  );
}));

app.put('/api/admin/tasks/:id/questions', requireAdmin, ah(async (req, res) => {
  const task = await store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const questions = (req.body || {}).questions || [];
  const sections = (req.body || {}).sections || [];
  const thumbnails = (req.body || {}).thumbnails || [];
  const feedbackEnabled = (req.body || {}).feedbackEnabled !== false;
  const err =
    validateQuestions(questions) || validateSections(sections) || validateThumbnails(thumbnails);
  if (err) return res.status(400).json({ error: err });
  if (!questions.length && !sections.length && !thumbnails.length)
    return res.status(400).json({ error: 'Add at least one question, section or thumbnail.' });
  await store.replaceQuestions(req.params.id, questions, sections, thumbnails, feedbackEnabled);
  res.json(await store.getTask(req.params.id));
}));

// ---------- admin: default section questions ----------

app.get('/api/admin/default-questions', requireAdmin, ah(async (req, res) => {
  res.json(await store.listDefaultQuestions());
}));

app.post('/api/admin/default-questions', requireAdmin, ah(async (req, res) => {
  const q = req.body || {};
  const err = validateQuestions([q]);
  if (err) return res.status(400).json({ error: err });
  res.json(await store.addDefaultQuestion(q));
}));

app.delete('/api/admin/default-questions/:id', requireAdmin, ah(async (req, res) => {
  await store.deleteDefaultQuestion(Number(req.params.id));
  res.json({ ok: true });
}));

app.delete('/api/admin/tasks/:id', requireAdmin, ah(async (req, res) => {
  await store.deleteTask(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/admin/tasks/:id/submissions', requireAdmin, ah(async (req, res) => {
  const task = await store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task, submissions: await store.listSubmissions(req.params.id) });
}));

app.get('/api/admin/tasks/:id/export.csv', requireAdmin, ah(async (req, res) => {
  const task = await store.getTask(req.params.id);
  if (!task) return res.status(404).send('Task not found');
  const subs = await store.listSubmissions(req.params.id);
  const header = [
    'Name', 'Email', 'County', 'Country', 'Status',
    'Started At (UTC)', 'Completed At (UTC)', 'Watch Seconds',
    ...(task.thumbnails.length ? ['Thumbnail Chosen'] : []),
    ...task.questions.map((q) => q.label),
  ];
  const rows = subs.map((s) => [
    s.name, s.email, s.county, s.country, s.status,
    s.started_at, s.completed_at || '', Math.round(s.watch_seconds),
    ...(task.thumbnails.length ? [s.thumbnail_title || ''] : []),
    ...task.questions.map((q) => s.answers[q.id] ?? ''),
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${task.title.replace(/[^\w\- ]+/g, '')}-submissions.csv"`
  );
  res.send('\uFEFF' + csv);
}));

// ---------- public: user flow ----------

app.get('/api/tasks/:id', ah(async (req, res) => {
  const task = await store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const pubQ = (q) => ({
    id: q.id,
    type: q.type,
    label: q.label,
    required: q.required,
    options: q.options,
  });
  res.json({
    id: task.id,
    title: task.title,
    videoId: task.video_id,
    instructions: task.instructions,
    // Whether the feedback form is shown after the video:
    feedbackEnabled: !!task.feedback_enabled,
    // Thumbnails the user picks from before the video (empty = skip that page):
    thumbnails: task.thumbnails.map((t) => ({ id: t.id, title: t.title, image: t.image })),
    // Questions asked in the feedback form after the video:
    questions: task.questions.filter((q) => q.section_id == null).map(pubQ),
    // Sections popped up during the video at their timestamp:
    sections: task.sections.map((s) => ({
      id: s.id,
      heading: s.heading,
      atSeconds: s.at_seconds,
      questions: s.questions.map(pubQ),
    })),
  });
}));

app.post('/api/tasks/:id/start', ah(async (req, res) => {
  const task = await store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const { name, email, county, country } = req.body || {};
  for (const [field, value] of Object.entries({ name, email, county, country })) {
    if (!value || !String(value).trim())
      return res.status(400).json({ error: `${field} is required.` });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  const sub = await store.createSubmission(req.params.id, {
    name: String(name).trim(),
    email: String(email).trim(),
    county: String(county).trim(),
    country: String(country).trim(),
  });
  res.json({ submissionId: sub.id });
}));

// Records which thumbnail the user picked on the thumbnail page.
app.post('/api/submissions/:sid/thumbnail', ah(async (req, res) => {
  const sub = await store.getSubmission(req.params.sid);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'completed')
    return res.status(400).json({ error: 'This submission was already completed.' });
  const task = await store.getTask(sub.task_id);
  const thumbnailId = Number((req.body || {}).thumbnailId);
  const thumb = task.thumbnails.find((t) => t.id === thumbnailId);
  if (!thumb) return res.status(400).json({ error: 'Unknown thumbnail.' });
  await store.setSubmissionThumbnail(sub.id, thumb.id, thumb.title);
  res.json({ ok: true });
}));

app.post('/api/submissions/:sid/watched', ah(async (req, res) => {
  const sub = await store.getSubmission(req.params.sid);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  const watchSeconds = Number((req.body || {}).watchSeconds) || 0;
  await store.markVideoWatched(req.params.sid, watchSeconds);
  res.json({ ok: true });
}));

// Saves answers immediately — used by the in-video section popups, so the
// answers are recorded even if the user never finishes the task.
// Accepts {questionId, value} for one answer or {answers: [{questionId, value}]}.
app.post('/api/submissions/:sid/answer', ah(async (req, res) => {
  const sub = await store.getSubmission(req.params.sid);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'completed')
    return res.status(400).json({ error: 'This submission was already completed.' });
  const task = await store.getTask(sub.task_id);
  const body = req.body || {};
  const answers = Array.isArray(body.answers)
    ? body.answers
    : [{ questionId: body.questionId, value: body.value }];
  for (const a of answers) {
    const q = task.questions.find((x) => x.id === Number(a.questionId));
    if (!q) return res.status(400).json({ error: 'Unknown question.' });
    if (q.required && (a.value == null || String(a.value).trim() === ''))
      return res.status(400).json({ error: `"${q.label}" is required.` });
    if (q.type === 'number' && a.value != null && String(a.value).trim() !== '' && isNaN(Number(a.value)))
      return res.status(400).json({ error: `"${q.label}" must be a number.` });
    if (q.type === 'rating' && a.value != null && String(a.value).trim() !== '' && !isValidRating(a.value))
      return res.status(400).json({ error: `"${q.label}" must be a star rating between 0.5 and 5.` });
  }
  for (const a of answers) {
    await store.upsertAnswer(sub.id, Number(a.questionId), a.value == null ? '' : String(a.value));
  }
  res.json({ ok: true });
}));

app.post('/api/submissions/:sid/answers', ah(async (req, res) => {
  const sub = await store.getSubmission(req.params.sid);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });
  if (sub.status === 'completed')
    return res.status(400).json({ error: 'This submission was already completed.' });
  const task = await store.getTask(sub.task_id);
  const answers = (req.body || {}).answers || [];
  const byQuestion = new Map(answers.map((a) => [Number(a.questionId), a.value]));
  // When the feedback form is turned off, the video's end completes the
  // submission directly — no form questions to enforce.
  if (task.feedback_enabled) {
    for (const q of task.questions) {
      if (q.section_id != null || q.at_seconds != null) continue; // answered during the video
      const v = byQuestion.get(q.id);
      if (q.required && (v == null || String(v).trim() === ''))
        return res.status(400).json({ error: `"${q.label}" is required.` });
      if (q.type === 'number' && v != null && String(v).trim() !== '' && isNaN(Number(v)))
        return res.status(400).json({ error: `"${q.label}" must be a number.` });
      if (q.type === 'rating' && v != null && String(v).trim() !== '' && !isValidRating(v))
        return res.status(400).json({ error: `"${q.label}" must be a star rating between 0.5 and 5.` });
    }
  }
  const clean = task.questions
    .filter((q) => byQuestion.has(q.id))
    .map((q) => ({ questionId: q.id, value: byQuestion.get(q.id) }));
  await store.completeSubmission(sub.id, clean);
  res.json({ ok: true });
}));

// ---------- pages ----------

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/t/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'task.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// Central error handler: log details, return a generic message.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error, please try again.' });
});

store.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Video Reviewer Platform running at http://localhost:${PORT}`);
      console.log(`Admin dashboard:  http://localhost:${PORT}/admin`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise the database:', err.message);
    process.exit(1);
  });
