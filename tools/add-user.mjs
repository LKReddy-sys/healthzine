import bcrypt from 'bcrypt';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const db = new sqlite3.Database(path.join(__dirname, '..', 'data.sqlite'));

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const username = args.username || 'editor_en';
const password = args.password || 'pass123';
const role = args.role || 'editor'; // 'admin' or 'editor'
const languages = args.langs || 'en'; // comma separated e.g. "hi" or "en,hi"

const hash = await bcrypt.hash(password, 10);

db.run(
  'INSERT INTO users (username, password_hash, role, languages) VALUES (?, ?, ?, ?)',
  [username, hash, role, languages],
  (err) => {
    if (err) {
      console.error('Failed to insert user:', err.message);
    } else {
      console.log(`User created: ${username} (role=${role}, languages=${languages})`);
    }
    db.close();
  }
);
