// db.js
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import pg from "pg";
import fs from "fs";

const isPg = !!process.env.DATABASE_URL;

function toPg(sql) {
  // Convert all '?' placeholders to $1, $2, $3 ... for Postgres
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let db;
let pool;

if (isPg) {
  const { Pool } = pg;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Render PG
  });

  db = {
    run(sql, params = [], cb = () => {}) {
      pool
        .query(toPg(sql), params)
        .then(() => cb(null))
        .catch((e) => cb(e));
    },
    get(sql, params = [], cb = () => {}) {
      // LIMIT 1 to mimic sqlite's .get()
      pool
        .query(toPg(sql) + " LIMIT 1", params)
        .then((r) => cb(null, r.rows[0]))
        .catch((e) => cb(e));
    },
    all(sql, params = [], cb = () => {}) {
      pool
        .query(toPg(sql), params)
        .then((r) => cb(null, r.rows))
        .catch((e) => cb(e));
    },
    prepare(sql) {
      // emulate sqlite's stmt.run(...) with lastID
      return {
        run(...args) {
          const maybeCb = args[args.length - 1];
          const cb = typeof maybeCb === "function" ? maybeCb : () => {};
          const params = typeof maybeCb === "function" ? args.slice(0, -1) : args;

          pool
            .query(toPg(sql) + " RETURNING id", params)
            .then((r) => {
              // emulate sqlite's this.lastID
              cb.call({ lastID: r.rows?.[0]?.id }, null);
            })
            .catch((e) => cb(e));
        },
      };
    },
  };
} else {
  // SQLite for local dev
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dbFile = process.env.SQLITE_FILE || path.join(__dirname, "data.sqlite");
  const dbDir = path.dirname(dbFile);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  db = new sqlite3.Database(dbFile);
}

export const initSchema = async () => {
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, (e) => (e ? reject(e) : resolve())));

  if (isPg) {
    // PostgreSQL DDL
    await run(`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      headline TEXT,
      strap TEXT,
      image_path TEXT NOT NULL,
      image_alt TEXT,
      language TEXT DEFAULT 'en',
      link_url TEXT,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      languages TEXT NOT NULL DEFAULT 'en',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS logins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      post_id INTEGER,
      meta TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked INTEGER NOT NULL DEFAULT 0`);
    await run(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS created_by INTEGER`);
  } else {
    // SQLite DDL
    await run(`CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT,
      strap TEXT,
      image_path TEXT NOT NULL,
      image_alt TEXT,
      language TEXT DEFAULT 'en',
      link_url TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      languages TEXT NOT NULL DEFAULT 'en',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS logins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      login_time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      post_id INTEGER,
      meta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Safe repeated ALTER
    db.run(`ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`, (err) => {
      if (err && !/duplicate column/i.test(err.message)) {
        console.error("Could not add users.blocked column:", err.message);
      }
    });
    db.run(`ALTER TABLE posts ADD COLUMN created_by INTEGER`, (err) => {
      if (err && !/duplicate column/i.test(err.message)) {
        console.error("Could not add posts.created_by column:", err.message);
      }
    });
  }
};

export const usingPostgres = isPg;
export default db;
