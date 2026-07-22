// ============================================================
// CPC Obuka — Kategorija C (prevoz tereta)
// Glavni server
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const UAParser = require('ua-parser-js');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'PROMENI_OVO_U_TAJNI_KLJUC';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ADMIN381';

if (JWT_SECRET === 'PROMENI_OVO_U_TAJNI_KLJUC') {
  console.warn('⚠️  UPOZORENJE: JWT_SECRET nije postavljen! Postavi ga u Secrets.');
}

// ============================================================
// BAZA PODATAKA
// ============================================================

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'cpcdata')
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cpc.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password_hash TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    device_fingerprint TEXT,
    user_agent TEXT,
    last_login_at TEXT,
    last_ip TEXT,
    blocked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS signup_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    note TEXT,
    requested_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question_num INTEGER NOT NULL,
    chosen_answer TEXT,
    is_correct INTEGER NOT NULL,
    theme TEXT,
    answered_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(question_num);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    user_agent TEXT,
    ip TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS exam_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    completed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ============================================================
// PITANJA - iz JSON fajla (generisan iz docx-a)
// ============================================================

let QUESTIONS = [];
let THEMES = [];

function loadQuestions() {
  const qPath = path.join(__dirname, 'data', 'questions.json'); // uvek iz app foldera
  if (!fs.existsSync(qPath)) {
    console.warn('⚠️  data/questions.json ne postoji. Pokreni: npm run import-questions');
    return;
  }
  const data = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
  QUESTIONS = data.questions || [];
  THEMES = data.themes || [];
  console.log(`✓ Učitano ${QUESTIONS.length} pitanja u ${THEMES.length} tema`);
}
loadQuestions();

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Static files (samo CSS/JS/HTML, ne i slike - one idu kroz zaštićeni endpoint)
app.use(express.static(path.join(__dirname, 'public'), {
  // Slike nisu dostupne preko statičkog servisa
  setHeaders: (res, filePath) => {
    if (filePath.includes('protected-images')) {
      // Blokiraj direktan pristup
      res.status(403);
    }
  }
}));

// Eksplicitno blokiraj direktan pristup folderu sa slikama
app.use('/protected-images', (req, res) => {
  res.status(403).send('Forbidden');
});

// ============================================================
// AUTH HELPERS
// ============================================================

function deviceFingerprint(req) {
  const ua = req.headers['user-agent'] || '';
  const parser = new UAParser(ua);
  const r = parser.getResult();
  const fp = `${r.browser.name}|${r.browser.major}|${r.os.name}|${r.os.version}|${r.device.model || 'desktop'}`;
  return crypto.createHash('sha256').update(fp).digest('hex').slice(0, 32);
}

function userAgentSummary(req) {
  const ua = req.headers['user-agent'] || '';
  const parser = new UAParser(ua);
  const r = parser.getResult();
  return `${r.browser.name || '?'} ${r.browser.major || ''} / ${r.os.name || '?'} ${r.os.version || ''}`.trim();
}

function clientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function signUserToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
}

function authUser(req, res, next) {
  const token = req.cookies.user_token;
  if (!token) return res.status(401).json({ error: 'Niste prijavljeni' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: 'Nalog ne postoji' });
    if (user.blocked) return res.status(403).json({ error: 'Nalog je blokiran' });
    if (user.expires_at && new Date(user.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Pristup je istekao' });
    }
    // Provera uređaja
    const currentFp = deviceFingerprint(req);
    if (user.device_fingerprint && user.device_fingerprint !== currentFp) {
      return res.status(403).json({ error: 'Nalog se koristi na drugom uređaju. Kontaktirajte administratora.' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token nevažeći' });
  }
}

function authAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: 'Admin pristup obavezan' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Niste admin' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Admin token nevažeći' });
  }
}

// ============================================================
// USER AUTH ENDPOINTS
// ============================================================

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email i lozinka obavezni' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Pogrešan email ili lozinka' });
  if (user.blocked) return res.status(403).json({ error: 'Nalog je blokiran' });
  if (user.expires_at && new Date(user.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Pristup je istekao' });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Pogrešan email ili lozinka' });

  const fp = deviceFingerprint(req);
  const ip = clientIP(req);
  const uaStr = userAgentSummary(req);

  // Lock na jedan uređaj
  if (!user.device_fingerprint) {
    db.prepare('UPDATE users SET device_fingerprint=?, user_agent=?, last_login_at=datetime("now"), last_ip=? WHERE id=?')
      .run(fp, uaStr, ip, user.id);
  } else if (user.device_fingerprint !== fp) {
    return res.status(403).json({
      error: 'Vaš nalog je već vezan za drugi uređaj. Kontaktirajte administratora za reset.'
    });
  } else {
    db.prepare('UPDATE users SET last_login_at=datetime("now"), last_ip=? WHERE id=?').run(ip, user.id);
  }

  const token = signUserToken(user);
  const _isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('user_token', token, {
    httpOnly: true,
    secure: _isHttps,
    sameSite: _isHttps ? 'none' : 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('user_token');
  res.json({ ok: true });
});

app.get('/api/me', authUser, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    expires_at: u.expires_at
  });
});

// ============================================================
// PUBLIC: ZAHTEV ZA REGISTRACIJU
// Polaznik popunjava formu - admin kasnije odobrava
// ============================================================

app.post('/api/signup', (req, res) => {
  const { name, email, phone, password, note } = req.body;
  
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: 'Sva polja su obavezna (ime, имејл, телефон, лозинка)' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Лозинка мора имати најмање 6 знакова' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Унесите исправан имејл' });
  }
  
  const emailNorm = email.trim().toLowerCase();
  
  // Provera - već postoji kao odobreni korisnik?
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
  if (existingUser) {
    return res.status(400).json({ error: 'Овај имејл је већ регистрован. Пријавите се.' });
  }
  
  // Provera - već poslat zahtev?
  const existingReq = db.prepare('SELECT id, status FROM signup_requests WHERE email = ? AND status = ?').get(emailNorm, 'pending');
  if (existingReq) {
    return res.status(400).json({ error: 'Захтев за овај имејл је већ послат и чека одобрење.' });
  }
  
  const hash = bcrypt.hashSync(password, 10);
  
  try {
    db.prepare(`
      INSERT INTO signup_requests (name, email, phone, password_hash, note)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), emailNorm, phone.trim(), hash, (note || '').trim() || null);
    
    res.json({ 
      ok: true, 
      message: 'Ваш захтев је послат. Сачекајте одобрење администратора. Бићете обавештени телефоном или имејлом.'
    });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Захтев за овај имејл већ постоји' });
    }
    res.status(500).json({ error: e.message });
  }
});

// Status zahteva (provera nakon slanja)
app.get('/api/signup/status/:email', (req, res) => {
  const email = req.params.email.trim().toLowerCase();
  const req_ = db.prepare('SELECT status, requested_at FROM signup_requests WHERE email = ? ORDER BY requested_at DESC LIMIT 1').get(email);
  if (!req_) return res.json({ status: 'none' });
  res.json({ status: req_.status, requested_at: req_.requested_at });
});

// ============================================================
// ZAŠTIĆENI ENDPOINT ZA SLIKE
// Slike se serviraju samo prijavljenim korisnicima
// Dodaje hash-based zaštitu - URL svake slike je vezan za korisnika
// ============================================================

app.get('/img/:filename', authUser, (req, res) => {
  const filename = req.params.filename;
  
  // Sigurnosna provera - sprečava ../ napade
  if (!/^[a-zA-Z0-9_\-]+\.(png|jpg|jpeg|webp)$/i.test(filename)) {
    return res.status(400).send('Bad filename');
  }
  
  // Referer check - slika mora biti tražena sa naše stranice (sprečava hotlinking)
  const referer = req.get('referer') || '';
  const host = req.get('host') || '';
  if (referer && !referer.includes(host)) {
    return res.status(403).send('Forbidden');
  }
  
  const imgPath = path.join(__dirname, 'public', 'protected-images', filename);
  
  if (!fs.existsSync(imgPath)) {
    return res.status(404).send('Not found');
  }
  
  // Zabranjuje cache-ovanje - svaki put traži ponovo (i provera login-a)
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // Sprečava embedding u druge sajtove (clickjacking)
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  // Sprečava browser da prikače sliku u download
  res.setHeader('Content-Disposition', 'inline');
  
  // Log pristup slici (za detekciju masovnog skidanja)
  console.log(`[IMG] ${req.user.email} → ${filename}`);
  
  res.sendFile(imgPath);
});

// ============================================================
// PITANJA API
// ============================================================

app.get('/api/themes', authUser, (req, res) => {
  // Vrati teme sa brojem pitanja
  const themesWithCount = THEMES.map(t => ({
    name: t.name,
    count: QUESTIONS.filter(q => q.theme === t.name).length
  }));
  res.json({ themes: themesWithCount, total: QUESTIONS.length });
});

// Vraća listu nasumičnih pitanja (za vežbu ili ispit)
app.post('/api/questions/batch', authUser, (req, res) => {
  const { theme, count = 10, mode = 'practice' } = req.body;

  let pool = QUESTIONS;
  if (theme && theme !== 'all') {
    pool = QUESTIONS.filter(q => q.theme === theme);
  }

  if (mode === 'mistakes') {
    // Vrati samo pitanja gde je polaznik grešio
    const userMistakes = db.prepare(`
      SELECT question_num, COUNT(*) as wrong_count
      FROM attempts
      WHERE user_id = ? AND is_correct = 0
      GROUP BY question_num
      ORDER BY wrong_count DESC
    `).all(req.user.id);
    const mistakeNums = new Set(userMistakes.map(m => m.question_num));
    pool = pool.filter(q => mistakeNums.has(q.num));
  }

  // Shuffle
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count);

  // Ukloni tačan odgovor i obrazloženje iz odgovora (poslaće se nakon odgovaranja)
  const sanitized = shuffled.map(q => ({
    num: q.num,
    title: q.title,
    options: q.options,
    image_url: q.image_url || null,
    theme: q.theme
  }));

  res.json({ questions: sanitized });
});

// Polaznik daje odgovor - server vraća tačnost + obrazloženje
app.post('/api/answer', authUser, (req, res) => {
  const { num, chosen } = req.body;
  const q = QUESTIONS.find(x => x.num === num);
  if (!q) return res.status(404).json({ error: 'Pitanje ne postoji' });

  const isCorrect = chosen === q.correct ? 1 : 0;

  db.prepare(`
    INSERT INTO attempts (user_id, question_num, chosen_answer, is_correct, theme)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.id, num, chosen, isCorrect, q.theme);

  res.json({
    correct: q.correct,
    correct_text: q.options[q.correct],
    explanation: q.explanation,
    is_correct: !!isCorrect
  });
});

// Statistika polaznika
app.get('/api/stats', authUser, (req, res) => {
  const userId = req.user.id;

  const overall = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(is_correct) as correct
    FROM attempts WHERE user_id = ?
  `).get(userId);

  const byTheme = db.prepare(`
    SELECT theme, COUNT(*) as total, SUM(is_correct) as correct
    FROM attempts WHERE user_id = ?
    GROUP BY theme
  `).all(userId);

  const topMistakes = db.prepare(`
    SELECT question_num, COUNT(*) as wrong_count
    FROM attempts WHERE user_id = ? AND is_correct = 0
    GROUP BY question_num
    ORDER BY wrong_count DESC, MAX(answered_at) DESC
    LIMIT 10
  `).all(userId);

  const mistakesWithTitle = topMistakes.map(m => {
    const q = QUESTIONS.find(x => x.num === m.question_num);
    return {
      num: m.question_num,
      title: q ? q.title : '(nepoznato)',
      wrong_count: m.wrong_count
    };
  });

  const mistakesCount = db.prepare(`
    SELECT COUNT(DISTINCT question_num) as cnt
    FROM attempts WHERE user_id = ? AND is_correct = 0
  `).get(userId).cnt;

  res.json({
    total: overall.total || 0,
    correct: overall.correct || 0,
    accuracy: overall.total ? Math.round((overall.correct / overall.total) * 100) : 0,
    by_theme: byTheme,
    top_mistakes: mistakesWithTitle,
    mistakes_count: mistakesCount
  });
});

// Submit rezultata ispita
app.post('/api/exam/submit', authUser, (req, res) => {
  const { score, total } = req.body;
  if (typeof score !== 'number' || typeof total !== 'number') {
    return res.status(400).json({ error: 'Loši podaci' });
  }
  const passed = (score / total) >= 0.75 ? 1 : 0;
  db.prepare('INSERT INTO exam_results (user_id, score, total, passed) VALUES (?, ?, ?, ?)')
    .run(req.user.id, score, total, passed);
  res.json({ ok: true, passed: !!passed });
});

app.get('/api/exam/history', authUser, (req, res) => {
  const history = db.prepare(`
    SELECT score, total, passed, completed_at
    FROM exam_results WHERE user_id = ?
    ORDER BY completed_at DESC LIMIT 20
  `).all(req.user.id);
  res.json({ history });
});

// ============================================================
// ADMIN API
// ============================================================

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Pogrešna admin lozinka' });
  }
  const token = signAdminToken();
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/check', authAdmin, (req, res) => res.json({ ok: true }));

// ============================================================
// ADMIN: UPRAVLJANJE ZAHTEVIMA ZA REGISTRACIJU
// ============================================================

app.get('/api/admin/signup-requests', authAdmin, (req, res) => {
  const requests = db.prepare(`
    SELECT id, name, email, phone, note, requested_at, status
    FROM signup_requests
    WHERE status = 'pending'
    ORDER BY requested_at DESC
  `).all();
  res.json({ requests });
});

// Odobravanje zahteva - kreira pravi user nalog
app.post('/api/admin/signup-requests/:id/approve', authAdmin, (req, res) => {
  const { expires_at } = req.body;
  const reqRow = db.prepare('SELECT * FROM signup_requests WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!reqRow) return res.status(404).json({ error: 'Zahtev ne postoji ili je već obrađen' });
  
  // Provera da li već postoji user sa istim email-om
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(reqRow.email);
  if (existing) {
    return res.status(400).json({ error: 'Korisnik sa ovim email-om već postoji' });
  }
  
  // Kreiraj user
  try {
    db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(reqRow.name, reqRow.email, reqRow.phone, reqRow.password_hash, expires_at || null);
    
    // Označi zahtev kao odobren
    db.prepare('UPDATE signup_requests SET status = ? WHERE id = ?').run('approved', req.params.id);
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Odbijanje zahteva
app.post('/api/admin/signup-requests/:id/reject', authAdmin, (req, res) => {
  const result = db.prepare('UPDATE signup_requests SET status = ? WHERE id = ? AND status = ?').run('rejected', req.params.id, 'pending');
  if (result.changes === 0) return res.status(404).json({ error: 'Zahtev ne postoji' });
  res.json({ ok: true });
});

// Brisanje zahteva (potpuno)
app.delete('/api/admin/signup-requests/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM signup_requests WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Lista polaznika sa statistikama
app.get('/api/admin/users', authAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.expires_at, u.created_at,
           u.last_login_at, u.last_ip, u.user_agent, u.blocked, u.device_fingerprint,
           (SELECT COUNT(*) FROM attempts WHERE user_id = u.id) as attempts,
           (SELECT SUM(is_correct) FROM attempts WHERE user_id = u.id) as correct
    FROM users u
    ORDER BY u.created_at DESC
  `).all();

  const enriched = users.map(u => {
    const accuracy = u.attempts ? Math.round((u.correct / u.attempts) * 100) : 0;

    const topMistakes = db.prepare(`
      SELECT question_num, COUNT(*) as c
      FROM attempts WHERE user_id = ? AND is_correct = 0
      GROUP BY question_num ORDER BY c DESC LIMIT 5
    `).all(u.id);

    const mistakeTitles = topMistakes.map(m => {
      const q = QUESTIONS.find(x => x.num === m.question_num);
      return {
        num: m.question_num,
        title: q ? q.title.slice(0, 80) : '?',
        count: m.c
      };
    });

    return {
      ...u,
      accuracy,
      has_device: !!u.device_fingerprint,
      top_mistakes: mistakeTitles
    };
  });

  res.json({ users: enriched });
});

// Dodaj polaznika ručno
app.post('/api/admin/users', authAdmin, (req, res) => {
  const { name, email, phone, password, expires_at } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Ime, email i lozinka su obavezni' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Lozinka mora imati najmanje 6 karaktera' });
  }

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare(`
      INSERT INTO users (name, email, phone, password_hash, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name.trim(), email.trim().toLowerCase(), phone || null, hash, expires_at || null);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email već postoji' });
    }
    res.status(500).json({ error: e.message });
  }
});

// Reset uređaja
app.post('/api/admin/users/:id/reset-device', authAdmin, (req, res) => {
  db.prepare('UPDATE users SET device_fingerprint=NULL, user_agent=NULL WHERE id=?')
    .run(req.params.id);
  res.json({ ok: true });
});

// Blokiraj/odblokiraj
app.post('/api/admin/users/:id/toggle-block', authAdmin, (req, res) => {
  const u = db.prepare('SELECT blocked FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Polaznik ne postoji' });
  const newBlocked = u.blocked ? 0 : 1;
  db.prepare('UPDATE users SET blocked=? WHERE id=?').run(newBlocked, req.params.id);
  res.json({ ok: true, blocked: newBlocked });
});

// Promena datuma isteka
app.post('/api/admin/users/:id/extend', authAdmin, (req, res) => {
  const { expires_at } = req.body;
  db.prepare('UPDATE users SET expires_at=? WHERE id=?').run(expires_at || null, req.params.id);
  res.json({ ok: true });
});

// Promena lozinke
app.post('/api/admin/users/:id/password', authAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Lozinka mora imati najmanje 6 karaktera' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, req.params.id);
  res.json({ ok: true });
});

// Brisanje polaznika
app.delete('/api/admin/users/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// CSV export
app.get('/api/admin/users.csv', authAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.name, u.email, u.phone, u.expires_at, u.last_login_at,
           (SELECT COUNT(*) FROM attempts WHERE user_id = u.id) as attempts,
           (SELECT SUM(is_correct) FROM attempts WHERE user_id = u.id) as correct
    FROM users u ORDER BY u.created_at DESC
  `).all();

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['Ime', 'Email', 'Telefon', 'Ističe', 'Zadnja prijava', 'Pitanja', 'Tačno', 'Uspeh %']
  ];
  for (const u of users) {
    const acc = u.attempts ? Math.round((u.correct / u.attempts) * 100) : 0;
    rows.push([u.name, u.email, u.phone, u.expires_at, u.last_login_at, u.attempts, u.correct || 0, acc + '%']);
  }
  const csv = rows.map(r => r.map(escape).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="polaznici-cpc-c.csv"');
  res.send('\uFEFF' + csv); // BOM za Excel
});

// Globalna statistika po pitanjima (admin)
app.get('/api/admin/question-stats', authAdmin, (req, res) => {
  const stats = db.prepare(`
    SELECT question_num, 
           COUNT(*) as total,
           SUM(is_correct) as correct
    FROM attempts GROUP BY question_num
    HAVING total >= 3
    ORDER BY (SUM(is_correct) * 1.0 / COUNT(*)) ASC
    LIMIT 30
  `).all();

  const enriched = stats.map(s => {
    const q = QUESTIONS.find(x => x.num === s.question_num);
    return {
      num: s.question_num,
      title: q ? q.title : '?',
      theme: q ? q.theme : '?',
      total: s.total,
      correct: s.correct,
      accuracy: Math.round((s.correct / s.total) * 100)
    };
  });

  res.json({ hardest: enriched });
});

// ============================================================
// PAGES
// ============================================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Nepostojeća ruta' });
  } else {
    res.redirect('/');
  }
});

// ============================================================
// START
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚛  CPC Obuka — Kategorija C`);
  console.log(`🌐  Server: http://localhost:${PORT}`);
  console.log(`👤  Admin:  http://localhost:${PORT}/admin`);
  console.log(`📊  Pitanja u bazi: ${QUESTIONS.length}\n`);
});
