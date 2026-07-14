/* Tests the database connection the app would use.
   Run with:  npm run test-db   (loads .env automatically) */

const url = process.env.DATABASE_URL;

if (!url) {
  console.log('DATABASE_URL is not set (or still commented out in .env).');
  console.log('=> The app would use the LOCAL data.sqlite file.');
  console.log('');
  console.log('To test your VPS database, edit .env: fill in the password and');
  console.log('VPS IP on the DATABASE_URL line and remove the leading "#".');
  process.exit(1);
}

let host = '(unparseable url)';
try {
  host = new URL(url).host;
} catch {}

console.log(`Connecting to PostgreSQL at ${host} ...`);

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 10000,
});

(async () => {
  const t0 = Date.now();
  const info = await pool.query(
    'SELECT current_database() AS db, current_user AS usr, version() AS ver'
  );
  const ms = Date.now() - t0;
  const { db, usr, ver } = info.rows[0];
  console.log(`✔ Connected in ${ms}ms`);
  console.log(`  Database: ${db}`);
  console.log(`  User:     ${usr}`);
  console.log(`  Server:   ${ver.split(' on ')[0]}`);

  // Make sure the app's tables exist (creates them if this is the first run).
  await require('../db-pg').ready;
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM tasks) AS tasks,
      (SELECT COUNT(*)::int FROM questions) AS questions,
      (SELECT COUNT(*)::int FROM submissions) AS submissions,
      (SELECT COUNT(*)::int FROM answers) AS answers
  `);
  console.log('✔ App tables ready. Current row counts:', counts.rows[0]);
  console.log('');
  console.log('All good — the app will store data in this database.');
  await pool.end();
  process.exit(0);
})().catch((err) => {
  console.error(`✘ Connection FAILED: ${err.message}`);
  console.log('');
  console.log('Common causes:');
  console.log('- Wrong password (or special characters not percent-encoded in the URL)');
  console.log('- Port 5432 not open in the VPS firewall (ufw / provider panel)');
  console.log("- postgresql.conf: listen_addresses not set to '*' (then restart postgres)");
  console.log('- pg_hba.conf: missing "hostssl videoreview gagan 0.0.0.0/0 scram-sha-256" line');
  console.log('- If SSL errors: try removing the DATABASE_SSL=require line in .env');
  process.exit(1);
});
