const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    video_url TEXT NOT NULL,
    video_id TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating')),
    label TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    options TEXT NOT NULL DEFAULT '[]',
    at_seconds REAL
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    county TEXT NOT NULL,
    country TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','video_watched','completed')),
    watch_seconds REAL NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    heading TEXT NOT NULL,
    at_seconds REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS default_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating')),
    label TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    options TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS thumbnails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    image TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id, position);
  CREATE INDEX IF NOT EXISTS idx_sections_task ON sections(task_id, at_seconds);
  CREATE INDEX IF NOT EXISTS idx_thumbnails_task ON thumbnails(task_id, position);
  CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_answers_submission ON answers(submission_id);
`);

// Older databases miss newer columns — add them.
{
  const cols = db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
  if (!cols.includes('at_seconds')) db.exec('ALTER TABLE questions ADD COLUMN at_seconds REAL');
  if (!cols.includes('section_id'))
    db.exec('ALTER TABLE questions ADD COLUMN section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE');
  const taskCols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('feedback_enabled'))
    db.exec('ALTER TABLE tasks ADD COLUMN feedback_enabled INTEGER NOT NULL DEFAULT 1');
  const subCols = db.prepare('PRAGMA table_info(submissions)').all().map((c) => c.name);
  if (!subCols.includes('thumbnail_id'))
    db.exec('ALTER TABLE submissions ADD COLUMN thumbnail_id INTEGER');
  if (!subCols.includes('thumbnail_title'))
    db.exec('ALTER TABLE submissions ADD COLUMN thumbnail_title TEXT');
  if (!subCols.includes('thumbnail_rating'))
    db.exec('ALTER TABLE submissions ADD COLUMN thumbnail_rating REAL');
  if (!subCols.includes('phone'))
    db.exec("ALTER TABLE submissions ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  const secCols = db.prepare('PRAGMA table_info(sections)').all().map((c) => c.name);
  if (!secCols.includes('allow_back'))
    db.exec('ALTER TABLE sections ADD COLUMN allow_back INTEGER NOT NULL DEFAULT 0');
}

// Older databases have a type CHECK that predates 'rating'. SQLite can't alter
// a CHECK constraint, so the affected tables are rebuilt with the wider one.
{
  const tableSql = (name) =>
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).sql;
  if (!tableSql('questions').includes("'rating'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE questions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating')),
        label TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        options TEXT NOT NULL DEFAULT '[]',
        at_seconds REAL,
        section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE
      );
      INSERT INTO questions_new (id, task_id, position, type, label, required, options, at_seconds, section_id)
        SELECT id, task_id, position, type, label, required, options, at_seconds, section_id FROM questions;
      DROP TABLE questions;
      ALTER TABLE questions_new RENAME TO questions;
      CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id, position);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }
  if (!tableSql('default_questions').includes("'rating'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE default_questions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating')),
        label TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        options TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO default_questions_new (id, type, label, required, options)
        SELECT id, type, label, required, options FROM default_questions;
      DROP TABLE default_questions;
      ALTER TABLE default_questions_new RENAME TO default_questions;
      COMMIT;
    `);
  }
}

// Starter defaults for section questions (only when none exist yet).
const SEED_DEFAULTS = [
  { type: 'mcq', label: 'How engaging was this section?', required: true, options: ['Very engaging', 'Engaging', 'Neutral', 'Boring'] },
  { type: 'mcq', label: 'Was this section easy to understand?', required: true, options: ['Yes, fully', 'Partly', 'No'] },
  { type: 'number', label: 'Rate this section from 1 to 10', required: true, options: [] },
  { type: 'paragraph', label: 'Any comments about this section?', required: false, options: [] },
];
{
  const n = db.prepare('SELECT COUNT(*) AS c FROM default_questions').get().c;
  if (n === 0) {
    const ins = db.prepare(
      'INSERT INTO default_questions (type, label, required, options) VALUES (?, ?, ?, ?)'
    );
    for (const d of SEED_DEFAULTS) ins.run(d.type, d.label, d.required ? 1 : 0, JSON.stringify(d.options));
  }
}

function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// ---------- tasks ----------

function createTask({ title, videoUrl, videoId, instructions }) {
  const id = newId(6);
  db.prepare(
    'INSERT INTO tasks (id, title, video_url, video_id, instructions) VALUES (?, ?, ?, ?, ?)'
  ).run(id, title, videoUrl, videoId, instructions || '');
  return getTask(id);
}

function updateTask(id, { title, videoUrl, videoId, instructions }) {
  db.prepare(
    'UPDATE tasks SET title = ?, video_url = ?, video_id = ?, instructions = ? WHERE id = ?'
  ).run(title, videoUrl, videoId, instructions || '', id);
  return getTask(id);
}

function mapQuestion(q) {
  return { ...q, required: !!q.required, options: JSON.parse(q.options) };
}

function getTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;
  task.questions = db
    .prepare('SELECT * FROM questions WHERE task_id = ? ORDER BY position')
    .all(id)
    .map(mapQuestion);
  task.sections = db
    .prepare('SELECT * FROM sections WHERE task_id = ? ORDER BY at_seconds, position')
    .all(id)
    .map((s) => ({ ...s, questions: task.questions.filter((q) => q.section_id === s.id) }));
  task.thumbnails = db
    .prepare('SELECT * FROM thumbnails WHERE task_id = ? ORDER BY position')
    .all(id);
  return task;
}

function listTasks() {
  return db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM questions q WHERE q.task_id = t.id) AS question_count,
        (SELECT COUNT(*) FROM submissions s WHERE s.task_id = t.id) AS submission_count,
        (SELECT COUNT(*) FROM submissions s WHERE s.task_id = t.id AND s.status = 'completed') AS completed_count
       FROM tasks t ORDER BY t.created_at DESC`
    )
    .all();
}

function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// Rows carrying an existing id are UPDATED in place (keeping their answers);
// rows without an id are inserted; rows no longer present are deleted. Only truly
// removed questions lose their answers (ON DELETE CASCADE) — editing a label,
// reordering, or retiming a section no longer wipes existing responses.
function replaceQuestions(taskId, questions, sections = [], thumbnails = [], feedbackEnabled = true) {
  const deleteMissing = (table, keepIds) => {
    if (keepIds.length) {
      const ph = keepIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM ${table} WHERE task_id = ? AND id NOT IN (${ph})`).run(taskId, ...keepIds);
    } else {
      db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
    }
  };

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE tasks SET feedback_enabled = ? WHERE id = ?').run(
      feedbackEnabled ? 1 : 0, taskId
    );

    // ---- thumbnails (ids preserved so submissions' thumbnail_id stays valid) ----
    deleteMissing('thumbnails', thumbnails.filter((t) => t.id).map((t) => Number(t.id)));
    const insT = db.prepare('INSERT INTO thumbnails (task_id, position, title, image) VALUES (?, ?, ?, ?)');
    const updT = db.prepare('UPDATE thumbnails SET position = ?, title = ?, image = ? WHERE id = ? AND task_id = ?');
    thumbnails.forEach((t, i) => {
      if (t.id) updT.run(i, t.title, t.image, Number(t.id), taskId);
      else insT.run(taskId, i, t.title, t.image);
    });

    // ---- sections (upsert; remember each one's db id for its questions) ----
    const insS = db.prepare('INSERT INTO sections (task_id, position, heading, at_seconds, allow_back) VALUES (?, ?, ?, ?, ?)');
    const updS = db.prepare('UPDATE sections SET position = ?, heading = ?, at_seconds = ?, allow_back = ? WHERE id = ? AND task_id = ?');
    const sorted = [...sections].sort((a, b) => a.atSeconds - b.atSeconds);
    const keepSectionIds = [];
    sorted.forEach((s, si) => {
      if (s.id) {
        updS.run(si, s.heading, Number(s.atSeconds), s.allowBack ? 1 : 0, Number(s.id), taskId);
        s._dbId = Number(s.id);
      } else {
        s._dbId = Number(insS.run(taskId, si, s.heading, Number(s.atSeconds), s.allowBack ? 1 : 0).lastInsertRowid);
      }
      keepSectionIds.push(s._dbId);
    });

    // ---- questions (upsert in place; delete removed) ----
    const incoming = [];
    let pos = 0;
    for (const s of sorted) for (const q of s.questions) incoming.push({ q, sectionId: s._dbId, pos: pos++ });
    for (const q of questions) incoming.push({ q, sectionId: null, pos: pos++ });

    deleteMissing('questions', incoming.filter((x) => x.q.id).map((x) => Number(x.q.id)));
    const insQ = db.prepare('INSERT INTO questions (task_id, position, type, label, required, options, at_seconds, section_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const updQ = db.prepare('UPDATE questions SET position = ?, type = ?, label = ?, required = ?, options = ?, at_seconds = ?, section_id = ? WHERE id = ? AND task_id = ?');
    for (const { q, sectionId, pos } of incoming) {
      const opts = JSON.stringify(q.options || []);
      if (q.id) updQ.run(pos, q.type, q.label, q.required ? 1 : 0, opts, null, sectionId, Number(q.id), taskId);
      else insQ.run(taskId, pos, q.type, q.label, q.required ? 1 : 0, opts, null, sectionId);
    }

    // Remove sections the user deleted (safe: kept questions already re-pointed above).
    deleteMissing('sections', keepSectionIds);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- default section questions ----------

function listDefaultQuestions() {
  return db.prepare('SELECT * FROM default_questions ORDER BY id').all().map(mapQuestion);
}

function addDefaultQuestion({ type, label, required, options }) {
  const r = db.prepare(
    'INSERT INTO default_questions (type, label, required, options) VALUES (?, ?, ?, ?)'
  ).run(type, label, required ? 1 : 0, JSON.stringify(options || []));
  return mapQuestion(
    db.prepare('SELECT * FROM default_questions WHERE id = ?').get(r.lastInsertRowid)
  );
}

function deleteDefaultQuestion(id) {
  db.prepare('DELETE FROM default_questions WHERE id = ?').run(id);
}

// ---------- submissions ----------

function createSubmission(taskId, { name, email, phone, county, country }) {
  const id = newId(9);
  db.prepare(
    'INSERT INTO submissions (id, task_id, name, email, phone, county, country) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, name, email, phone || '', county, country);
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
}

function getSubmission(id) {
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
}

// Question ids this submission already has answers for — lets the client
// rebuild which in-video sections are done after a reload, so answered
// sections are never asked twice even if the browser lost its local state.
function getAnsweredQuestionIds(id) {
  return db
    .prepare('SELECT question_id FROM answers WHERE submission_id = ?')
    .all(id)
    .map((r) => r.question_id);
}

function markVideoWatched(id, watchSeconds) {
  db.prepare(
    "UPDATE submissions SET status = 'video_watched', watch_seconds = ? WHERE id = ? AND status = 'started'"
  ).run(watchSeconds, id);
}

// Records which thumbnail the user picked (title is snapshotted so the
// choice survives later edits to the task's thumbnails).
function setSubmissionThumbnail(id, thumbnailId, title, rating) {
  db.prepare(
    'UPDATE submissions SET thumbnail_id = ?, thumbnail_title = ?, thumbnail_rating = ? WHERE id = ?'
  ).run(thumbnailId, title, rating ?? null, id);
}

// Stores/overwrites one answer immediately (used for in-video timed questions).
function upsertAnswer(submissionId, questionId, value) {
  db.prepare('DELETE FROM answers WHERE submission_id = ? AND question_id = ?').run(
    submissionId, questionId
  );
  db.prepare('INSERT INTO answers (submission_id, question_id, value) VALUES (?, ?, ?)').run(
    submissionId, questionId, String(value)
  );
}

function completeSubmission(id, answers) {
  // Only replace the answers being submitted, so answers already saved during
  // the video (timed questions) are kept.
  for (const a of answers) upsertAnswer(id, a.questionId, a.value);
  db.prepare(
    "UPDATE submissions SET status = 'completed', completed_at = datetime('now') WHERE id = ?"
  ).run(id);
}

function listSubmissions(taskId) {
  const subs = db
    .prepare('SELECT * FROM submissions WHERE task_id = ? ORDER BY started_at DESC')
    .all(taskId);
  const answerStmt = db.prepare('SELECT question_id, value FROM answers WHERE submission_id = ?');
  return subs.map((s) => {
    const answers = {};
    for (const a of answerStmt.all(s.id)) answers[a.question_id] = a.value;
    return { ...s, answers };
  });
}

module.exports = {
  ready: Promise.resolve(), // schema is created synchronously above
  createTask,
  updateTask,
  getTask,
  listTasks,
  deleteTask,
  replaceQuestions,
  listDefaultQuestions,
  addDefaultQuestion,
  deleteDefaultQuestion,
  createSubmission,
  getSubmission,
  getAnsweredQuestionIds,
  markVideoWatched,
  setSubmissionThumbnail,
  upsertAnswer,
  completeSubmission,
  listSubmissions,
};
