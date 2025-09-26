import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import sqlite3 from 'sqlite3';
import bcrypt from 'bcrypt';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { sendMail } from './utils/mailer.js';

dotenv.config();

console.log('SMTP ENV:', {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER,
  secure: process.env.SMTP_SECURE,
});


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// --- Ensure uploads dir exists ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- SQLite ---
const dbFile = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headline TEXT,
    strap TEXT,
    image_path TEXT NOT NULL,
    image_alt TEXT,
    language TEXT DEFAULT 'en',
    link_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // NEW: Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor', -- 'admin' | 'editor'
    languages TEXT NOT NULL DEFAULT 'en', -- comma list: en,hi
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

  // NEW: Logins table
  db.run(`CREATE TABLE IF NOT EXISTS logins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip TEXT,
    user_agent TEXT
  )`);

// Track successful logins
db.run(`CREATE TABLE IF NOT EXISTS logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

// Track important actions
db.run(`CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,          -- 'create' | 'edit' | 'delete'
  post_id INTEGER,
  meta TEXT,                     -- JSON blob for extras
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);


// Ensure 'blocked' column exists (safe on repeated runs)
db.run(`ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`, (err) => {
  if (err && !/duplicate column/i.test(err.message)) {
    console.error('Could not add users.blocked column:', err.message);
  }
});


// Seed an admin automatically the first time if table is empty
function seedAdminIfEmpty() {
  db.get('SELECT COUNT(*) AS c FROM users', [], async (err, row) => {
    if (err) return console.error('Seed admin check failed:', err);
    if (row.c > 0) return;
    const username = process.env.ADMIN_USER || 'admin';
    const email = process.env.ADMIN_EMAIL || null;
    const pass = process.env.ADMIN_PASS || 'admin123';
    const hash = await bcrypt.hash(pass, 10);
    db.run(
      'INSERT INTO users (username,email,password_hash,role,languages) VALUES (?,?,?,?,?)',
      [username, email, hash, 'admin', 'en,hi,te,ml,ta,kn,bn,gu,mr'],
      (e) => {
        if (e) console.error('Seed admin insert failed:', e);
        else console.log(`Seeded admin user "${username}"`);
      }
    );
  });
}
seedAdminIfEmpty();

// --- Session & parsers ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'devsecret',
  resave: false,
  saveUninitialized: false
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Static ---
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// --- Views ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Multer ---
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });


// --- Helpers & RBAC ---
const ALL_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'te', label: 'Telugu' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'ta', label: 'Tamil' },
  { code: 'kn', label: 'Kannada' },
  { code: 'bn', label: 'Bangla' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'mr', label: 'Marathi' },
];

const pickUserLangs = (req) => {
  const arr = req.session?.user?.languages || ['en'];
  return Array.isArray(arr) ? arr : String(arr).split(',').map(s => s.trim()).filter(Boolean);
};
const isAdmin = (req) => req.session?.user?.role === 'admin';
const userCanUseLang = (req, lang) => isAdmin(req) || pickUserLangs(req).includes(lang);
const genPassword = (len = 12) =>
  [...cryptoRandom(len)].join('');

function cryptoRandom(n) {
  // URL-safe random string (A-Z a-z 0-9)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out = [];
  while (out.length < n) {
    const rnd = Math.floor(Math.random() * chars.length);
    out.push(chars[rnd]);
  }
  return out;
}

// flash helper
app.use((req, res, next) => {
  res.locals.flash = req.session.flash;
  delete req.session.flash;
  res.locals.user = req.session.user || null;
  next();
});

// --- Auth guards ---
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/admin/login');
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(403).send('Forbidden');
}

// --- Routes ---
// Frontend index
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Posts API (infinite scroll)
app.get('/api/posts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
  const cursor = parseInt(req.query.cursor || '0', 10);
  const lang = req.query.lang || null;

  let q = 'SELECT * FROM posts';
  const p = [];
  if (lang) { q += ' WHERE language = ?'; p.push(lang); }
  if (cursor > 0) {
    q += lang ? ' AND id < ?' : ' WHERE id < ?';
    p.push(cursor);
  }
  q += ' ORDER BY id DESC LIMIT ?';
  p.push(limit);

  db.all(q, p, (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB_ERROR' });
    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    const base = `${req.protocol}://${req.get('host')}`;
    const items = rows.map(r => ({
      id: r.id,
      headline: r.headline,
      strap: r.strap,
      imageUrl: `${base}/` + r.image_path.replace(/^\/?/, ''),
      imageAlt: r.image_alt || '',
      language: r.language || 'en',
      linkUrl: r.link_url || null,
      createdAt: r.created_at,
      shareUrl: `${base}/post/${r.id}`
    }));
    res.json({ items, nextCursor });
  });
});

// Available languages
app.get('/api/languages', (_req, res) => {
  db.all('SELECT DISTINCT language FROM posts', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map(r => r.language));
  });
});

// Share page
app.get('/post/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM posts WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Post not found');

    // ✅ Prefer BASE_URL from .env, else fallback to request host
    const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    res.render('share', {
      post: {
        ...row,
        imageUrl: `${base}/` + row.image_path.replace(/^\/?/, ''),
        shareUrl: `${base}/post/${row.id}`
      }
    });
  });
});


// --- Login/Logout (DB-based) ---
app.get('/admin/login', (_req, res) => res.render('login', { error: null }));

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, u) => {
    if (err) return res.status(500).render('login', { error: 'DB error' });
    if (!u) return res.status(401).render('login', { error: 'Invalid credentials' });
    if (u.blocked) {
      return res.status(403).render('login', { error: 'Account blocked by admin' });
    }
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).render('login', { error: 'Invalid credentials' });
    req.session.user = {
      id: u.id,
      username: u.username,
      role: u.role,
      languages: u.languages.split(',').map(s => s.trim()).filter(Boolean)
    };
  db.run(
    'INSERT INTO logins (user_id, ip, user_agent) VALUES (?, ?, ?)',
    [u.id, req.ip, req.get('User-Agent')]
  );
    res.redirect('/admin');
  });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Dashboard (filtered by user languages). Also shows user-management for admins ---
app.get('/admin', requireAuth, (req, res) => {
  const allowed = pickUserLangs(req);
  const requested = req.query.lang;
  const currentLang = requested && allowed.includes(requested) ? requested : (allowed[0] || 'en');

  db.all('SELECT * FROM posts WHERE language = ? ORDER BY id DESC', [currentLang], (err, rows) => {
    if (err) return res.status(500).send('DB error');

    const tabLangs = ALL_LANGS.filter(l => allowed.includes(l.code));
    const allLangs = ALL_LANGS; // for admin user creation form

    if (!isAdmin(req)) {
      return res.render('dashboard', { posts: rows, currentLang, languages: tabLangs, allLangs: tabLangs });
    }

    // If admin, also fetch user list to show in dashboard
    db.all('SELECT id, username, email, role, languages, created_at FROM users ORDER BY id DESC', [], (e2, users) => {
      if (e2) return res.status(500).send('DB error (users)');
      res.render('dashboard', { posts: rows, currentLang, languages: tabLangs, allLangs, users });
    });
  });
});

// --- Create Post ---
app.get('/admin/create', requireAuth, (req, res) => {
  let choices;

  if (isAdmin(req)) {
    // Admin sees all languages
    choices = ALL_LANGS;
  } else {
    // Editor sees only their assigned languages
    const allowed = pickUserLangs(req);
    choices = ALL_LANGS.filter(l => allowed.includes(l.code));
  }

  res.render('create', {
    languages: choices,
    isAdmin: isAdmin(req)  // pass flag to EJS
  });
});


app.post('/admin/create', requireAuth, upload.single('image'), (req, res) => {
  const { headline, strap, imageAlt, language, linkUrl } = req.body;
  const lang = language || 'en';
  if (!req.file) return res.status(400).send('Image is required');
  if (!userCanUseLang(req, lang)) return res.status(403).send('Forbidden');

  const image_path = path.join('uploads', req.file.filename).replace(/\\/g, '/');

  // NOTE: now includes created_by
  const stmt = db.prepare(`
    INSERT INTO posts (headline, strap, image_path, image_alt, language, link_url, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    headline || null,
    strap || null,
    image_path,
    imageAlt || null,
    lang,
    linkUrl || null,
    req.session.user.id,                      // <-- who created it
    function (err) {
      if (err) return res.status(500).send('DB error');

      // Log activity
      db.run(
        `INSERT INTO activities (user_id, action, post_id, meta)
         VALUES (?, 'create', ?, ?)`,
        [req.session.user.id, this.lastID, JSON.stringify({ language: lang })]
      );

      res.redirect('/admin?lang=' + lang);
    }
  );
});


// --- Edit Post ---
app.get('/admin/edit', requireAuth, (_req, res) => res.redirect('/admin'));

app.get('/admin/edit/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM posts WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Post not found');
    if (!userCanUseLang(req, row.language)) return res.status(403).send('Forbidden');
    const choices = ALL_LANGS.filter(l => isAdmin(req) || pickUserLangs(req).includes(l.code));
    res.render('edit', { post: row, languages: choices });
  });
});

app.post('/admin/edit/:id', requireAuth, upload.single('image'), (req, res) => {
  const id = req.params.id;
  const { headline, strap, imageAlt, language, linkUrl } = req.body;
  const newLang = language || 'en';

  db.get('SELECT * FROM posts WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Post not found');
    if (!userCanUseLang(req, row.language) || !userCanUseLang(req, newLang)) return res.status(403).send('Forbidden');

    let q = `UPDATE posts SET headline = ?, strap = ?, image_alt = ?, language = ?, link_url = ?`;
    const p = [headline || null, strap || null, imageAlt || null, newLang, linkUrl || null];
    if (req.file) {
      const image_path = path.join('uploads', req.file.filename).replace(/\\/g, '/');
      q += `, image_path = ?`;
      p.push(image_path);
    }
    q += ` WHERE id = ?`;
    p.push(id);

    db.run(q, p, (e2) => {
      if (e2) return res.status(500).send('DB error');
      res.redirect('/admin?lang=' + newLang);
    });
  });
});


// --- Delete Post (admin only) ---
app.get(
  '/admin/delete/:id',
  requireAuth,
  (req, res, next) => (isAdmin(req) ? next() : res.status(403).send('Forbidden')),
  (req, res) => {
    const postId = req.params.id;

    db.run('DELETE FROM posts WHERE id = ?', [postId], (err) => {
      if (err) return res.status(500).send('DB error');

      // ✅ Log the delete activity here
      db.run(
        `INSERT INTO activities (user_id, action, post_id, meta)
         VALUES (?, 'delete', ?, NULL)`,
        [req.session.user.id, postId]
      );

      res.redirect('/admin');
    });
  }
);


// Create editor (admin only) – auto-generate password, optional email
app.post('/admin/users/create', requireAuth, (req, res, next) => isAdmin(req) ? next() : res.status(403).send('Forbidden'), async (req, res) => {
  const { username, email } = req.body;
  let langs = req.body.languages || 'en';
  // languages can be array or string
  if (Array.isArray(langs)) langs = langs.join(',');
  const passwordPlain = genPassword(12);
  const password_hash = await bcrypt.hash(passwordPlain, 10);

  db.run(
    'INSERT INTO users (username,email,password_hash,role,languages) VALUES (?,?,?,?,?)',
    [username.trim(), email || null, password_hash, 'editor', langs],
    async (err) => {
      if (err) {
        req.session.flash = { error: 'Could not create user (username may already exist).' };
        return res.redirect('/admin');
      }

      // Try sending email (if SMTP configured and email provided)
      if (email) {
  await sendMail(
    email,
    'Your CMS account',
    `Hello ${username},

An account was created for you.

Login URL: ${req.protocol}://${req.get('host')}/admin/login
Username: ${username}
Password: ${passwordPlain}

Languages: ${langs}

For security, please log in and change your password.

Thanks`
  );
}

      // One-time show on dashboard
      req.session.flash = {
        createdUser: { username, email: email || '-', password: passwordPlain, languages: langs }
      };
      res.redirect('/admin');
    }
  );
});

// Change own password (admin & editors)
app.get('/admin/password', requireAuth, (req, res) => {
  res.render('password', { error: null, success: null });
});


      // Block an editor (admin only)
      app.get('/admin/users/block/:id', requireAuth, requireAdmin, (req, res) => {
        db.run('UPDATE users SET blocked = 1 WHERE id = ?', [req.params.id], (err) => {
          if (err) return res.status(500).send('DB error');
          res.redirect('/admin/users');
        });
      });

      // Unblock an editor (admin only)
      app.get('/admin/users/unblock/:id', requireAuth, requireAdmin, (req, res) => {
        db.run('UPDATE users SET blocked = 0 WHERE id = ?', [req.params.id], (err) => {
          if (err) return res.status(500).send('DB error');
          res.redirect('/admin/users');
        });
      });

      // Delete an editor (admin only)
    app.get('/admin/users/delete/:id', requireAuth, requireAdmin, (req, res) => {
      db.run('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).send('DB error');
        res.redirect('/admin/users');
      });
    });


  app.post('/admin/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const uid = req.session.user.id;
  db.get('SELECT * FROM users WHERE id = ?', [uid], async (err, u) => {
    if (err || !u) return res.status(500).render('password', { error: 'User not found', success: null });
    const ok = await bcrypt.compare(currentPassword, u.password_hash);
    if (!ok) return res.render('password', { error: 'Current password is incorrect', success: null });
    const hash = await bcrypt.hash(newPassword, 10);
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, uid], (e2) => {
      if (e2) return res.status(500).render('password', { error: 'Could not update password', success: null });
      res.render('password', { error: null, success: 'Password updated successfully' });
    });
  });
});

// --- Manage Editors (separate page) ---
app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
  db.all(
    'SELECT id, username, email, role, languages, blocked, created_at FROM users ORDER BY id DESC',
    [],
    (err, users) => {
      if (err) return res.status(500).send('DB error (users)');
      res.render('users', { users, allLangs: ALL_LANGS });
    }
  );
});

// Block/unblock editors
app.get('/admin/users/block/:id', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE users SET blocked = 1 WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).send('DB error');
    res.redirect('/admin/users');
  });
});

app.get('/admin/users/unblock/:id', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE users SET blocked = 0 WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).send('DB error');
    res.redirect('/admin/users');
  });
});

// Admin Activity dashboard
app.get('/admin/activity', requireAuth, requireAdmin, (req, res) => {
  // 1) Recent logins
  const qLogins = `
    SELECT l.login_time, l.ip, l.user_agent, u.username, u.role, u.languages
    FROM logins l
    JOIN users u ON u.id = l.user_id
    ORDER BY l.login_time DESC
    LIMIT 100
  `;

  // 2) Post counts by creator
  const qCounts = `
    SELECT u.id, u.username, u.role, u.languages, COUNT(p.id) AS posts_created
    FROM users u
    LEFT JOIN posts p ON p.created_by = u.id
    GROUP BY u.id
    ORDER BY posts_created DESC, u.username ASC
  `;

  // 3) Recent activity stream
  const qActivity = `
    SELECT a.created_at, a.action, a.post_id, a.meta, u.username
    FROM activities a
    JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC
    LIMIT 100
  `;

  db.all(qLogins, [], (e1, logins) => {
    if (e1) return res.status(500).send('DB error (logins)');

    db.all(qCounts, [], (e2, counts) => {
      if (e2) return res.status(500).send('DB error (counts)');

      db.all(qActivity, [], (e3, activity) => {
        if (e3) return res.status(500).send('DB error (activity)');

        res.render('activity', {
          logins,
          counts,
          activity
        });
      });
    });
  });
});


// --- 404 ---
app.use((req, res) => res.status(404).send(`Not found: ${req.path}`));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
