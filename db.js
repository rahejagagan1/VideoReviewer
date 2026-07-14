/* Storage backend selector:
   - DATABASE_URL set (e.g. on the VPS)  -> PostgreSQL  (db-pg.js)
   - otherwise                            -> local SQLite file (db-sqlite.js)
   Both expose the same functions; callers just `await` them. */
if (process.env.DATABASE_URL) {
  console.log('Storage: PostgreSQL (DATABASE_URL is set)');
  module.exports = require('./db-pg');
} else {
  console.log('Storage: local SQLite file (data.sqlite)');
  module.exports = require('./db-sqlite');
}
