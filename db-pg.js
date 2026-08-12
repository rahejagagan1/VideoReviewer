/* PostgreSQL backend — used when DATABASE_URL is set (e.g. on the VPS).
   Exposes the same interface as db-sqlite.js, but async. */
const { Pool } = require('pg');
const crypto = require('node:crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Set DATABASE_SSL=require for managed Postgres providers that need TLS.
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
  // Keep a connection warm. The DB is remote, so a fresh connection pays a
  // ~700ms TCP+SSL handshake; by default node-postgres reaps idle clients
  // after 10s, which made the first action after any idle spell (e.g. logging
  // in) feel laggy. Hold the idle client open and TCP-keepalive it instead.
  keepAlive: true,
  idleTimeoutMillis: 0,
  max: 10,
});

// A pooled idle client can be dropped by the remote server/firewall (ECONNRESET).
// node-postgres surfaces that as a pool 'error' event; without this handler an
// unhandled 'error' would crash the whole process. We just log it — the pool
// discards the dead client and opens a fresh one on the next query.
pool.on('error', (err) => {
  console.error('Postgres idle client error (recovered):', err.message);
});

// Heartbeat so at least one connection stays established even if a firewall/NAT
// silently drops idle TCP — the next real query then skips the handshake.
setInterval(() => {
  pool.query('SELECT 1').catch(() => {});
}, 60 * 1000).unref();

// Timestamps are stored as 'YYYY-MM-DD HH:MM:SS' UTC strings, matching the
// SQLite backend so the admin UI and CSV exports look identical.
const NOW_UTC = "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')";

const ready = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      video_id TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ${NOW_UTC}
    );

    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating')),
      label TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      options TEXT NOT NULL DEFAULT '[]',
      at_seconds DOUBLE PRECISION
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      county TEXT NOT NULL,
      country TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','video_watched','completed')),
      watch_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT ${NOW_UTC},
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS answers (
      id SERIAL PRIMARY KEY,
      submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sections (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      heading TEXT NOT NULL,
      at_seconds DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS default_questions (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating')),
      label TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      options TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS thumbnails (
      id SERIAL PRIMARY KEY,
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
  // Databases created before newer columns existed get them added.
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS at_seconds DOUBLE PRECISION');
  // Lets a section offer a "go back to re-watch" (cancel) button.
  await pool.query('ALTER TABLE sections ADD COLUMN IF NOT EXISTS allow_back INTEGER NOT NULL DEFAULT 0');
  await pool.query(
    'ALTER TABLE questions ADD COLUMN IF NOT EXISTS section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE'
  );
  await pool.query(
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS feedback_enabled INTEGER NOT NULL DEFAULT 1'
  );
  await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS thumbnail_id INTEGER');
  await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS thumbnail_title TEXT');
  await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS thumbnail_rating DOUBLE PRECISION');
  await pool.query("ALTER TABLE submissions ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''");
  // Databases created before the 'rating' question type get their CHECK widened.
  for (const t of ['questions', 'default_questions']) {
    await pool.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_type_check`);
    await pool.query(
      `ALTER TABLE ${t} ADD CONSTRAINT ${t}_type_check
       CHECK (type IN ('text','paragraph','number','mcq','checkbox','rating'))`
    );
  }

  // Starter defaults for section questions (only when none exist yet).
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM default_questions');
  if (rows[0].c === 0) {
    const seed = [
      { type: 'mcq', label: 'How engaging was this section?', required: 1, options: ['Very engaging', 'Engaging', 'Neutral', 'Boring'] },
      { type: 'mcq', label: 'Was this section easy to understand?', required: 1, options: ['Yes, fully', 'Partly', 'No'] },
      { type: 'number', label: 'Rate this section from 1 to 10', required: 1, options: [] },
      { type: 'paragraph', label: 'Any comments about this section?', required: 0, options: [] },
    ];
    for (const d of seed) {
      await pool.query(
        'INSERT INTO default_questions (type, label, required, options) VALUES ($1, $2, $3, $4)',
        [d.type, d.label, d.required, JSON.stringify(d.options)]
      );
    }
  }
})();

function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function mapQuestion(q) {
  return { ...q, required: !!q.required, options: JSON.parse(q.options) };
}

// ---------- tasks ----------

async function createTask({ title, videoUrl, videoId, instructions }) {
  const id = newId(6);
  await pool.query(
    'INSERT INTO tasks (id, title, video_url, video_id, instructions) VALUES ($1, $2, $3, $4, $5)',
    [id, title, videoUrl, videoId, instructions || '']
  );
  return getTask(id);
}

async function updateTask(id, { title, videoUrl, videoId, instructions }) {
  await pool.query(
    'UPDATE tasks SET title = $1, video_url = $2, video_id = $3, instructions = $4 WHERE id = $5',
    [title, videoUrl, videoId, instructions || '', id]
  );
  return getTask(id);
}

async function getTask(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  const task = rows[0];
  if (!task) return null;
  const q = await pool.query('SELECT * FROM questions WHERE task_id = $1 ORDER BY position', [id]);
  task.questions = q.rows.map(mapQuestion);
  const s = await pool.query(
    'SELECT * FROM sections WHERE task_id = $1 ORDER BY at_seconds, position',
    [id]
  );
  task.sections = s.rows.map((sec) => ({
    ...sec,
    questions: task.questions.filter((qq) => qq.section_id === sec.id),
  }));
  const t = await pool.query(
    'SELECT * FROM thumbnails WHERE task_id = $1 ORDER BY position',
    [id]
  );
  task.thumbnails = t.rows;
  return task;
}

async function listTasks() {
  const { rows } = await pool.query(
    `SELECT t.*,
      (SELECT COUNT(*)::int FROM questions q WHERE q.task_id = t.id) AS question_count,
      (SELECT COUNT(*)::int FROM submissions s WHERE s.task_id = t.id) AS submission_count,
      (SELECT COUNT(*)::int FROM submissions s WHERE s.task_id = t.id AND s.status = 'completed') AS completed_count
     FROM tasks t ORDER BY t.created_at DESC`
  );
  return rows;
}

async function deleteTask(id) {
  await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
}

// Applies the builder's questions/sections/thumbnails to a task. Rows that carry
// an existing id are UPDATED in place (so their submitted answers are kept);
// rows without an id are inserted; rows no longer present are deleted. Only genuinely
// removed questions lose their answers (via ON DELETE CASCADE) — editing a label,
// reordering, or retiming a section no longer wipes existing responses.
async function replaceQuestions(taskId, questions, sections = [], thumbnails = [], feedbackEnabled = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE tasks SET feedback_enabled = $1 WHERE id = $2', [
      feedbackEnabled ? 1 : 0, taskId,
    ]);

    // ---- thumbnails (ids preserved so submissions' thumbnail_id stays valid) ----
    const keepThumbIds = thumbnails.filter((t) => t.id).map((t) => Number(t.id));
    await client.query(
      'DELETE FROM thumbnails WHERE task_id = $1 AND NOT (id = ANY($2::int[]))',
      [taskId, keepThumbIds]
    );
    for (let ti = 0; ti < thumbnails.length; ti++) {
      const t = thumbnails[ti];
      if (t.id) {
        await client.query(
          'UPDATE thumbnails SET position = $1, title = $2, image = $3 WHERE id = $4 AND task_id = $5',
          [ti, t.title, t.image, Number(t.id), taskId]
        );
      } else {
        await client.query(
          'INSERT INTO thumbnails (task_id, position, title, image) VALUES ($1, $2, $3, $4)',
          [taskId, ti, t.title, t.image]
        );
      }
    }

    // ---- sections (upsert; remember each one's db id for its questions) ----
    const sorted = [...sections].sort((a, b) => a.atSeconds - b.atSeconds);
    const keepSectionIds = [];
    for (let si = 0; si < sorted.length; si++) {
      const s = sorted[si];
      if (s.id) {
        await client.query(
          'UPDATE sections SET position = $1, heading = $2, at_seconds = $3, allow_back = $4 WHERE id = $5 AND task_id = $6',
          [si, s.heading, Number(s.atSeconds), s.allowBack ? 1 : 0, Number(s.id), taskId]
        );
        s._dbId = Number(s.id);
      } else {
        const { rows } = await client.query(
          'INSERT INTO sections (task_id, position, heading, at_seconds, allow_back) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [taskId, si, s.heading, Number(s.atSeconds), s.allowBack ? 1 : 0]
        );
        s._dbId = rows[0].id;
      }
      keepSectionIds.push(s._dbId);
    }

    // ---- questions (upsert in place; delete removed) ----
    const incoming = [];
    let pos = 0;
    for (const s of sorted) for (const q of s.questions) incoming.push({ q, sectionId: s._dbId, pos: pos++ });
    for (const q of questions) incoming.push({ q, sectionId: null, pos: pos++ });

    const keepQIds = incoming.filter((x) => x.q.id).map((x) => Number(x.q.id));
    await client.query(
      'DELETE FROM questions WHERE task_id = $1 AND NOT (id = ANY($2::int[]))',
      [taskId, keepQIds]
    );
    for (const { q, sectionId, pos } of incoming) {
      const opts = JSON.stringify(q.options || []);
      if (q.id) {
        await client.query(
          `UPDATE questions SET position = $1, type = $2, label = $3, required = $4,
             options = $5, at_seconds = $6, section_id = $7 WHERE id = $8 AND task_id = $9`,
          [pos, q.type, q.label, q.required ? 1 : 0, opts, null, sectionId, Number(q.id), taskId]
        );
      } else {
        await client.query(
          `INSERT INTO questions (task_id, position, type, label, required, options, at_seconds, section_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [taskId, pos, q.type, q.label, q.required ? 1 : 0, opts, null, sectionId]
        );
      }
    }

    // Remove sections the user deleted (safe: kept questions already re-pointed above).
    await client.query(
      'DELETE FROM sections WHERE task_id = $1 AND NOT (id = ANY($2::int[]))',
      [taskId, keepSectionIds]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------- default section questions ----------

async function listDefaultQuestions() {
  const { rows } = await pool.query('SELECT * FROM default_questions ORDER BY id');
  return rows.map(mapQuestion);
}

async function addDefaultQuestion({ type, label, required, options }) {
  const { rows } = await pool.query(
    'INSERT INTO default_questions (type, label, required, options) VALUES ($1, $2, $3, $4) RETURNING *',
    [type, label, required ? 1 : 0, JSON.stringify(options || [])]
  );
  return mapQuestion(rows[0]);
}

async function deleteDefaultQuestion(id) {
  await pool.query('DELETE FROM default_questions WHERE id = $1', [id]);
}

// ---------- submissions ----------

async function createSubmission(taskId, { name, email, phone, county, country }) {
  const id = newId(9);
  const { rows } = await pool.query(
    'INSERT INTO submissions (id, task_id, name, email, phone, county, country) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [id, taskId, name, email, phone || '', county, country]
  );
  return rows[0];
}

async function getSubmission(id) {
  const { rows } = await pool.query('SELECT * FROM submissions WHERE id = $1', [id]);
  return rows[0] || null;
}

// Question ids this submission already has answers for — lets the client
// rebuild which in-video sections are done after a reload, so answered
// sections are never asked twice even if the browser lost its local state.
async function getAnsweredQuestionIds(id) {
  const { rows } = await pool.query(
    'SELECT question_id FROM answers WHERE submission_id = $1',
    [id]
  );
  return rows.map((r) => r.question_id);
}

async function markVideoWatched(id, watchSeconds) {
  await pool.query(
    "UPDATE submissions SET status = 'video_watched', watch_seconds = $1 WHERE id = $2 AND status = 'started'",
    [watchSeconds, id]
  );
}

// Records which thumbnail the user picked (title is snapshotted so the
// choice survives later edits to the task's thumbnails).
async function setSubmissionThumbnail(id, thumbnailId, title, rating) {
  await pool.query(
    'UPDATE submissions SET thumbnail_id = $1, thumbnail_title = $2, thumbnail_rating = $3 WHERE id = $4',
    [thumbnailId, title, rating ?? null, id]
  );
}

// Stores/overwrites one answer immediately (used for in-video timed questions).
async function upsertAnswer(submissionId, questionId, value) {
  await pool.query('DELETE FROM answers WHERE submission_id = $1 AND question_id = $2', [
    submissionId, questionId,
  ]);
  await pool.query('INSERT INTO answers (submission_id, question_id, value) VALUES ($1, $2, $3)', [
    submissionId, questionId, String(value),
  ]);
}

async function completeSubmission(id, answers) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Only replace the answers being submitted, so answers already saved during
    // the video (timed questions) are kept.
    for (const a of answers) {
      await client.query('DELETE FROM answers WHERE submission_id = $1 AND question_id = $2', [
        id, a.questionId,
      ]);
      await client.query(
        'INSERT INTO answers (submission_id, question_id, value) VALUES ($1, $2, $3)',
        [id, a.questionId, String(a.value)]
      );
    }
    await client.query(
      `UPDATE submissions SET status = 'completed', completed_at = ${NOW_UTC} WHERE id = $1`,
      [id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listSubmissions(taskId) {
  const { rows: subs } = await pool.query(
    'SELECT * FROM submissions WHERE task_id = $1 ORDER BY started_at DESC',
    [taskId]
  );
  const { rows: allAnswers } = await pool.query(
    `SELECT a.submission_id, a.question_id, a.value
     FROM answers a JOIN submissions s ON s.id = a.submission_id
     WHERE s.task_id = $1`,
    [taskId]
  );
  const bySub = new Map();
  for (const a of allAnswers) {
    if (!bySub.has(a.submission_id)) bySub.set(a.submission_id, {});
    bySub.get(a.submission_id)[a.question_id] = a.value;
  }
  return subs.map((s) => ({ ...s, answers: bySub.get(s.id) || {} }));
}

module.exports = {
  ready,
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
