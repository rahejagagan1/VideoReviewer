/* One-time migration: copies everything from the local data.sqlite file into
   a PostgreSQL database (preserving all IDs, so old task links keep working).

   Usage:
     node scripts/migrate-to-postgres.js "postgres://user:password@host:5432/dbname"
   or set DATABASE_URL and run without arguments.

   Safe to re-run: rows that already exist in Postgres are skipped. */

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) {
  console.error('Give the Postgres connection string as an argument or set DATABASE_URL.');
  process.exit(1);
}

const sqlite = new DatabaseSync(path.join(__dirname, '..', 'data.sqlite'));
const pool = new Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  // Ensure the schema exists (db-pg.js creates it on load).
  process.env.DATABASE_URL = url;
  await require('../db-pg').ready;

  const tasks = sqlite.prepare('SELECT * FROM tasks').all();
  const questions = sqlite.prepare('SELECT * FROM questions').all();
  const submissions = sqlite.prepare('SELECT * FROM submissions').all();
  const answers = sqlite.prepare('SELECT * FROM answers').all();

  let copied = { tasks: 0, questions: 0, submissions: 0, answers: 0 };

  for (const t of tasks) {
    const r = await pool.query(
      `INSERT INTO tasks (id, title, video_url, video_id, instructions, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [t.id, t.title, t.video_url, t.video_id, t.instructions, t.created_at]
    );
    copied.tasks += r.rowCount;
  }

  for (const q of questions) {
    const r = await pool.query(
      `INSERT INTO questions (id, task_id, position, type, label, required, options)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [q.id, q.task_id, q.position, q.type, q.label, q.required, q.options]
    );
    copied.questions += r.rowCount;
  }

  for (const s of submissions) {
    const r = await pool.query(
      `INSERT INTO submissions (id, task_id, name, email, county, country, status, watch_seconds, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.task_id, s.name, s.email, s.county, s.country, s.status, s.watch_seconds, s.started_at, s.completed_at]
    );
    copied.submissions += r.rowCount;
  }

  for (const a of answers) {
    const r = await pool.query(
      `INSERT INTO answers (id, submission_id, question_id, value)
       VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [a.id, a.submission_id, a.question_id, a.value]
    );
    copied.answers += r.rowCount;
  }

  // Move the auto-increment sequences past the copied IDs.
  await pool.query(
    "SELECT setval(pg_get_serial_sequence('questions','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM questions), 1))"
  );
  await pool.query(
    "SELECT setval(pg_get_serial_sequence('answers','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM answers), 1))"
  );

  console.log('Migration complete. New rows copied:', copied);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
