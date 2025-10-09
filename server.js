// server.js
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import bcrypt from 'bcrypt';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { sendMail } from './utils/mailer.js';
import db, { initSchema, usingPostgres } from './db.js';

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
// Local:  ./uploads    | Render: /tmp/uploads
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// --- Sessions ---
import session from "express-session";
import pgSession from "connect-pg-simple";
import pkg from "pg";
const { Pool } = pkg;

const pgSessionStore = pgSession(session);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const isProduction = process.env.NODE_ENV === "production";

app.set("trust proxy", 1); // needed for secure cookies behind proxies (Vercel, Render)

app.use(
  session({
    store: new pgSessionStore({
      pool,
      tableName: "session",
    }),
    secret: process.env.SESSION_SECRET || "devsecret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,       // HTTPS only in prod, not locally
      sameSite: isProduction ? "lax" : "lax", // 'lax' avoids cross-site rejection
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);


// Keep your existing middleware after this
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

function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  while (out.length < len) {
    out += chars[Math.floor(Math.random() * chars.length)];
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

    const base = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    if (row.link_url) return res.redirect(row.link_url);

    res.render('share', {
      post: {
        ...row,
        imageUrl: `${base}/` + row.image_path.replace(/^\/?/, ''),
        shareUrl: `${base}/post/${row.id}`
      }
    });
  });
});

// --- Login/Logout ---
app.get('/admin/login', (_req, res) => res.render('login', { error: null }));

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, u) => {
    if (err) return res.status(500).render('login', { error: 'DB error' });
    if (!u) return res.status(401).render('login', { error: 'Invalid credentials' });
    if (u.blocked) return res.status(403).render('login', { error: 'Account blocked by admin' });
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

// --- Dashboard ---
app.get('/admin', requireAuth, (req, res) => {
  const allowed = pickUserLangs(req);
  const requested = req.query.lang;
  const currentLang = requested && allowed.includes(requested) ? requested : (allowed[0] || 'en');

  db.all('SELECT * FROM posts WHERE language = ? ORDER BY id DESC', [currentLang], (err, rows) => {
    if (err) return res.status(500).send('DB error');

    const tabLangs = ALL_LANGS.filter(l => allowed.includes(l.code));
    const allLangs = ALL_LANGS;

    if (!isAdmin(req)) {
      return res.render('dashboard', { posts: rows, currentLang, languages: tabLangs, allLangs: tabLangs });
    }

    db.all('SELECT id, username, email, role, languages, created_at FROM users ORDER BY id DESC', [], (e2, users) => {
      if (e2) return res.status(500).send('DB error (users)');
      res.render('dashboard', { posts: rows, currentLang, languages: tabLangs, allLangs, users });
    });
  });
});

// --- Create Post ---
app.get('/admin/create', requireAuth, (req, res) => {
  let choices;
  if (isAdmin(req)) choices = ALL_LANGS;
  else choices = ALL_LANGS.filter(l => pickUserLangs(req).includes(l.code));
  res.render('create', { languages: choices, isAdmin: isAdmin(req) });
});

app.post('/admin/create', requireAuth, upload.single('image'), (req, res) => {
  const { headline, strap, imageAlt, language, linkUrl } = req.body;
  const lang = language || 'en';
  if (!req.file) return res.status(400).send('Image is required');
  if (!userCanUseLang(req, lang)) return res.status(403).send('Forbidden');

  const image_path = path.join('uploads', req.file.filename).replace(/\\/g, '/');

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
    req.session.user.id,
    function (err) {
      if (err) return res.status(500).send('DB error');
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
app.get('/admin/delete/:id', requireAuth, requireAdmin, (req, res) => {
  const postId = req.params.id;
  db.run('DELETE FROM posts WHERE id = ?', [postId], (err) => {
    if (err) return res.status(500).send('DB error');
    db.run(
      `INSERT INTO activities (user_id, action, post_id, meta)
       VALUES (?, 'delete', ?, NULL)`,
      [req.session.user.id, postId]
    );
    res.redirect('/admin');
  });
});

// Create editor (admin only) – auto-generate password, optional email
app.post(
  "/admin/users/create",
  requireAuth,
  (req, res, next) => (isAdmin(req) ? next() : res.status(403).send("Forbidden")),
  async (req, res) => {
    try {
      const { username, email } = req.body;
      let langs = req.body.languages || "en";
      if (Array.isArray(langs)) langs = langs.join(",");

      // Generate password
      const passwordPlain = genPassword(12);
      const password_hash = await bcrypt.hash(passwordPlain, 10);

      // Insert user
      db.run(
        "INSERT INTO users (username,email,password_hash,role,languages) VALUES (?,?,?,?,?)",
        [username.trim(), email || null, password_hash, "editor", langs],
        async (err) => {
          if (err) {
            console.error("User creation failed:", err.message);
            req.session.flash = {
              error: "Could not create user (username may already exist).",
            };
            return res.redirect("/admin");
          }

          // Send email (if configured)
          if (email) {
            try {
              await sendMail(
                email,
                "Your CMS account",
                `Hello ${username},

An account was created for you.

Login URL: ${process.env.BASE_URL || req.protocol + "://" + req.get("host")}/admin/login
Username: ${username}
Password: ${passwordPlain}

Languages: ${langs}

For security, please log in and change your password.

Thanks`
              );
            } catch (mailErr) {
              console.error("Email sending failed:", mailErr.message);
            }
          }

          // ✅ Store one-time password in flash and show in dashboard
          req.session.flash = {
            createdUser: {
              username,
              email: email || "-",
              password: passwordPlain,
              languages: langs,
            },
          };

          return res.redirect("/admin");
        }
      );
    } catch (e) {
      console.error("Unexpected error in user creation:", e);
      req.session.flash = { error: "Unexpected error creating user" };
      return res.redirect("/admin");
    }
  }
);


// --- Change password ---
app.get('/admin/password', requireAuth, (req, res) => {
  res.render('password', { error: null, success: null });
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

// --- Manage Editors ---
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

app.get('/admin/users/delete/:id', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).send('DB error');
    res.redirect('/admin/users');
  });
});

// --- Activity dashboard ---
app.get('/admin/activity', requireAuth, requireAdmin, (req, res) => {
  const qLogins = `
    SELECT l.login_time, l.ip, l.user_agent, u.username, u.role, u.languages
    FROM logins l
    JOIN users u ON u.id = l.user_id
    ORDER BY l.login_time DESC
    LIMIT 100
  `;
  const qCounts = `
    SELECT u.id, u.username, u.role, u.languages, COUNT(p.id) AS posts_created
    FROM users u
    LEFT JOIN posts p ON p.created_by = u.id
    GROUP BY u.id
    ORDER BY posts_created DESC, u.username ASC
  `;
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
        res.render('activity', { logins, counts, activity });
      });
    });
  });
});

// --- 404 ---
app.use((req, res) => res.status(404).send(`Not found: ${req.path}`));

// --- Init & seed ---
async function seedAdminIfEmpty() {
  db.get('SELECT COUNT(*) AS c FROM users', [], async (err, row) => {
    if (err) return console.error('Seed admin check failed:', err);
    if (row && row.c > 0) return;
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

(async () => {
  try {
    await initSchema();   // ✅ Single schema init from db.js
    seedAdminIfEmpty();   // ✅ Only seed if needed
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  } catch (e) {
    console.error('Failed to init DB schema:', e);
    process.exit(1);
  }
})();
