// ============================================================
// CPC Obuka — Frontend logika
// ============================================================

const API = {
  async req(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Greška na serveru');
    return data;
  },
  get: u => API.req('GET', u),
  post: (u, b) => API.req('POST', u, b)
};

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ============================================================
// STATE
// ============================================================

const state = {
  user: null,
  themes: [],
  total: 0,
  mode: null,
  questions: [],
  currentIdx: 0,
  score: 0,
  answered: false
};

// ============================================================
// PROTECTION LAYER
// ============================================================

function initProtection() {
  // Block right-click
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    toast('Десни клик је онемогућен', 'error');
  });

  // Block common copy / dev tools shortcuts
  document.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    
    // F12, Ctrl+Shift+I/J/C, Ctrl+U
    if (k === 'f12' || 
        (ctrl && e.shiftKey && ['i','j','c'].includes(k)) ||
        (ctrl && k === 'u')) {
      e.preventDefault();
      toast('Алат за програмере није дозвољен', 'error');
      flashCapture();
    }
    
    // Ctrl+P (print), Ctrl+S (save)
    if (ctrl && ['p','s'].includes(k)) {
      e.preventDefault();
      toast('Штампање/чување није дозвољено', 'error');
    }
    
    // Ctrl+C / Ctrl+A unutar pitanja
    if (ctrl && ['c','a'].includes(k)) {
      const sel = window.getSelection().toString();
      if (sel && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
      }
    }
    
    // PrintScreen
    if (k === 'printscreen' || e.code === 'PrintScreen') {
      flashCapture();
      try { navigator.clipboard.writeText(''); } catch(_){}
    }
  });

  // PrintScreen tries to read clipboard (Windows)
  document.addEventListener('keyup', e => {
    if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
      flashCapture();
      try { navigator.clipboard.writeText(''); } catch(_){}
    }
  });

  // Tab blur - hide content when user switches tab
  // Ne aktivira se u iframe (Replit Preview)
  let blurTimer = null;
  window.addEventListener('blur', () => {
    if (!state.user) return;
    if (window.self !== window.top) return; // u iframe-u
    document.getElementById('capture-protection').classList.add('active');
    blurTimer = setTimeout(() => {
      document.getElementById('capture-protection').classList.add('active');
    }, 50);
  });
  window.addEventListener('focus', () => {
    clearTimeout(blurTimer);
    document.getElementById('capture-protection').classList.remove('active');
  });

  // DevTools detection (size-based) - sa toleancijom za male window-e
  let devtoolsOpen = false;
  let detectionEnabled = false;
  
  // Aktiviraj detekciju tek nakon 3 sekunde (da bi browser stabilizovao prozor)
  setTimeout(() => { detectionEnabled = true; }, 3000);
  
  setInterval(() => {
    if (!detectionEnabled) return;
    
    // Preskaže detekciju za:
    // - male prozore (Replit webview, mobilni)
    // - iframe (Replit Preview)
    // - prozore manje od 800px (verovatno embed)
    if (window.innerWidth < 800) return;
    if (window.self !== window.top) return; // u iframe-u
    
    const threshold = 200; // veći threshold da izbegne false positives
    const widthDiff = window.outerWidth - window.innerWidth > threshold;
    const heightDiff = window.outerHeight - window.innerHeight > threshold;
    const isOpen = widthDiff || heightDiff;
    
    if (isOpen && !devtoolsOpen) {
      devtoolsOpen = true;
      document.getElementById('capture-protection').classList.add('active');
      toast('Алат за програмере детектован — садржај сакривен', 'error');
    } else if (!isOpen && devtoolsOpen) {
      devtoolsOpen = false;
      document.getElementById('capture-protection').classList.remove('active');
    }
  }, 1000);

  // Block drag images
  document.addEventListener('dragstart', e => {
    if (e.target.tagName === 'IMG') e.preventDefault();
  });

  // Mobile: detect screenshot via visibility (heuristic - not reliable but helps)
  // Ne aktivira se u iframe (Replit Preview)
  document.addEventListener('visibilitychange', () => {
    if (window.self !== window.top) return;
    if (document.hidden && state.user) {
      document.getElementById('capture-protection').classList.add('active');
    } else {
      document.getElementById('capture-protection').classList.remove('active');
    }
  });
}

function flashCapture() {
  const o = document.getElementById('capture-protection');
  o.classList.add('active');
  setTimeout(() => o.classList.remove('active'), 800);
}

function installWatermark(user) {
  const layer = document.getElementById('watermark-layer');
  layer.innerHTML = '';
  layer.classList.add('active');
  
  const text = `${user.email} · ${new Date().toLocaleString('sr-RS')}`;
  
  // Tile across screen
  const tilesX = 5, tilesY = 8;
  for (let x = 0; x < tilesX; x++) {
    for (let y = 0; y < tilesY; y++) {
      const tile = document.createElement('div');
      tile.className = 'watermark-tile';
      tile.textContent = text;
      tile.style.left = `${(x / tilesX) * 100}%`;
      tile.style.top = `${(y / tilesY) * 100}%`;
      layer.appendChild(tile);
    }
  }
}

// ============================================================
// SCREENS
// ============================================================

function showScreen(name) {
  $$('.screen').forEach(s => s.hidden = true);
  $(`#screen-${name}`).hidden = false;
  window.scrollTo(0, 0);
}

// ============================================================
// LOGIN
// ============================================================

async function tryAutoLogin() {
  try {
    const me = await API.get('/api/me');
    state.user = me;
    enterApp();
  } catch (e) {
    showScreen('login');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initProtection();
  
  // ============================================================
  // TAB SWITCHER (login / signup)
  // ============================================================
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
      $('#login-form').hidden = (target !== 'login');
      $('#signup-form').hidden = (target !== 'signup');
    });
  });
  
  // ============================================================
  // SIGNUP FORM
  // ============================================================
  $('#signup-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = $('#signup-error');
    const okEl = $('#signup-success');
    errEl.hidden = true;
    okEl.hidden = true;
    
    try {
      const r = await API.post('/api/signup', {
        name: fd.get('name'),
        email: fd.get('email'),
        phone: fd.get('phone'),
        password: fd.get('password'),
        note: fd.get('note')
      });
      okEl.innerHTML = `✅ <strong>Захтев је успешно послат!</strong><br>${r.message}`;
      okEl.hidden = false;
      e.target.reset();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
  
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = $('#login-error');
    errEl.hidden = true;
    try {
      const r = await API.post('/api/login', {
        email: fd.get('email'),
        password: fd.get('password')
      });
      state.user = r.user;
      enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await API.post('/api/logout');
    state.user = null;
    document.getElementById('watermark-layer').classList.remove('active');
    location.reload();
  });

  // Mode cards
  $$('.mode-card').forEach(card => {
    card.addEventListener('click', () => handleMode(card.dataset.mode));
  });

  // Back buttons
  $$('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.back));
  });

  $('#quiz-back').addEventListener('click', () => {
    if (confirm('Да ли заиста желите да прекинете?')) {
      showScreen('home');
      loadStats();
    }
  });

  $('#result-home').addEventListener('click', () => {
    showScreen('home');
    loadStats();
  });

  $('#result-again').addEventListener('click', () => {
    if (state.mode === 'exam') startExam();
    else if (state.mode === 'mistakes') startMistakes();
    else if (state.mode === 'practice') startPractice(state.lastTheme || 'all');
  });

  $('#btn-next').addEventListener('click', () => {
    state.currentIdx++;
    if (state.currentIdx >= state.questions.length) {
      finishQuiz();
    } else {
      renderQuestion();
    }
  });

  tryAutoLogin();
});

// ============================================================
// HOME
// ============================================================

async function enterApp() {
  $('#user-name').textContent = state.user.name;
  $('#welcome-name').textContent = state.user.name.split(' ')[0] || 'полазниче';
  installWatermark(state.user);
  
  try {
    const t = await API.get('/api/themes');
    state.themes = t.themes;
    state.total = t.total;
    $('#total-count').textContent = `${t.total} пит.`;
  } catch(e) { console.error(e); }
  
  await loadStats();
  showScreen('home');
}

async function loadStats() {
  try {
    const s = await API.get('/api/stats');
    $('#stat-attempts').textContent = s.total;
    $('#stat-accuracy').textContent = s.total ? `${s.accuracy}%` : '—';
    $('#stat-mistakes').textContent = s.mistakes_count;
    $('#mistakes-count').textContent = `${s.mistakes_count} пит.`;
    state.lastStats = s;
  } catch(e) { console.error(e); }
}

// ============================================================
// MODE DISPATCH
// ============================================================

function handleMode(mode) {
  state.mode = mode;
  if (mode === 'practice') showThemes();
  else if (mode === 'exam') startExam();
  else if (mode === 'mistakes') startMistakes();
  else if (mode === 'progress') showProgress();
}

// ============================================================
// THEMES PICKER
// ============================================================

function showThemes() {
  const list = $('#theme-list');
  list.innerHTML = '';
  
  // "All" option
  const allBtn = document.createElement('button');
  allBtn.className = 'theme-row theme-row-all';
  allBtn.innerHTML = `
    <span class="theme-row-name">🎲 Све теме (насумично)</span>
    <span class="theme-row-count">${state.total}</span>
  `;
  allBtn.addEventListener('click', () => startPractice('all'));
  list.appendChild(allBtn);
  
  state.themes.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'theme-row';
    btn.innerHTML = `
      <span class="theme-row-name">${escapeHtml(t.name)}</span>
      <span class="theme-row-count">${t.count}</span>
    `;
    btn.addEventListener('click', () => startPractice(t.name));
    list.appendChild(btn);
  });
  
  showScreen('themes');
}

// ============================================================
// QUIZ MODES
// ============================================================

async function startPractice(theme) {
  state.lastTheme = theme;
  $('#quiz-mode-label').textContent = 'Вежба';
  const r = await API.post('/api/questions/batch', { theme, count: 20, mode: 'practice' });
  if (!r.questions.length) {
    alert('Нема питања за изабрану област.');
    return;
  }
  startQuiz(r.questions);
}

async function startExam() {
  $('#quiz-mode-label').textContent = 'Испит';
  const r = await API.post('/api/questions/batch', { count: 30, mode: 'practice' });
  if (r.questions.length < 30) {
    alert('Нема довољно питања за испит.');
    return;
  }
  startQuiz(r.questions);
}

async function startMistakes() {
  $('#quiz-mode-label').textContent = 'Грешке';
  const r = await API.post('/api/questions/batch', { count: 30, mode: 'mistakes' });
  if (!r.questions.length) {
    alert('Немате забележених грешака. Прво вежбајте!');
    showScreen('home');
    return;
  }
  startQuiz(r.questions);
}

function startQuiz(questions) {
  state.questions = questions;
  state.currentIdx = 0;
  state.score = 0;
  $('#quiz-total').textContent = questions.length;
  showScreen('quiz');
  renderQuestion();
}

function renderQuestion() {
  const q = state.questions[state.currentIdx];
  state.answered = false;
  
  $('#quiz-index').textContent = state.currentIdx + 1;
  $('#progress-fill').style.width = `${((state.currentIdx) / state.questions.length) * 100}%`;
  
  $('#quiz-theme').textContent = q.theme || '';
  $('#quiz-question').textContent = q.title;
  
  const img = $('#quiz-image');
  if (q.image_url) {
    img.src = q.image_url;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.src = '';
  }
  
  const optsContainer = $('#quiz-options');
  optsContainer.innerHTML = '';
  
  const letters = ['а','б','в','г'];
  letters.forEach(letter => {
    if (!q.options[letter]) return;
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.innerHTML = `
      <span class="option-letter">${letter}</span>
      <span class="option-text">${escapeHtml(q.options[letter])}</span>
    `;
    btn.addEventListener('click', () => answer(letter, btn));
    optsContainer.appendChild(btn);
  });
  
  $('#quiz-explanation').hidden = true;
}

async function answer(letter, btn) {
  if (state.answered) return;
  state.answered = true;
  
  const q = state.questions[state.currentIdx];
  
  try {
    const r = await API.post('/api/answer', { num: q.num, chosen: letter });
    
    // Mark options
    const optBtns = $$('#quiz-options .option');
    optBtns.forEach(b => b.disabled = true);
    
    const chosenIdx = ['а','б','в','г'].indexOf(letter);
    const correctIdx = ['а','б','в','г'].indexOf(r.correct);
    
    if (r.is_correct) {
      btn.classList.add('correct');
      state.score++;
    } else {
      btn.classList.add('wrong');
      // Show correct
      const correctBtn = optBtns[correctIdx];
      if (correctBtn) correctBtn.classList.add('correct');
    }
    
    $('#explanation-text').textContent = r.explanation || '(без образложења)';
    $('#quiz-explanation').hidden = false;
    $('#progress-fill').style.width = `${((state.currentIdx + 1) / state.questions.length) * 100}%`;
  } catch (e) {
    toast(e.message, 'error');
    state.answered = false;
  }
}

async function finishQuiz() {
  const total = state.questions.length;
  const score = state.score;
  const pct = Math.round((score / total) * 100);
  const passed = pct >= 75;
  
  // Sačuvaj rezultat ako je ispit
  if (state.mode === 'exam') {
    try {
      await API.post('/api/exam/submit', { score, total });
    } catch(e) { console.error(e); }
  }
  
  $('#result-score').textContent = `${score} / ${total}`;
  $('#result-pct').textContent = `${pct}%`;
  
  if (state.mode === 'exam') {
    $('#result-emoji').textContent = passed ? '🏆' : '📚';
    $('#result-title').textContent = passed ? 'Положили сте!' : 'Није положено';
    $('#result-message').textContent = passed
      ? 'Одличан резултат! Спремни сте за испит.'
      : 'За положен испит потребно је минимум 75% тачних. Не одустајте!';
  } else if (state.mode === 'mistakes') {
    $('#result-emoji').textContent = '💪';
    $('#result-title').textContent = 'Свака част!';
    $('#result-message').textContent = `Урадили сте ${score} од ${total} питања на која сте раније грешили.`;
  } else {
    $('#result-emoji').textContent = pct >= 80 ? '🎉' : pct >= 60 ? '👍' : '💪';
    $('#result-title').textContent = pct >= 80 ? 'Браво!' : pct >= 60 ? 'Добро!' : 'Само напред!';
    $('#result-message').textContent = pct >= 80
      ? 'Знате градиво веома добро.'
      : pct >= 60
        ? 'Добар почетак — наставите са вежбом.'
        : 'Прођите образложења и понављајте.';
  }
  
  showScreen('result');
}

// ============================================================
// PROGRESS
// ============================================================

async function showProgress() {
  showScreen('progress');
  const s = await API.get('/api/stats');
  
  $('#progress-overview').innerHTML = `
    <div class="big-pct">${s.total ? s.accuracy : 0}%</div>
    <div class="label">Просечна успешност · ${s.total} одговора</div>
  `;
  
  const tpl = $('#theme-progress-list');
  tpl.innerHTML = '';
  if (!s.by_theme || !s.by_theme.length) {
    tpl.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:20px;">Још нема података. Вежбајте па се вратите.</p>';
  } else {
    s.by_theme.forEach(t => {
      const pct = t.total ? Math.round((t.correct / t.total) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'theme-progress-row';
      row.innerHTML = `
        <div class="name">
          <span>${escapeHtml(t.theme || 'Без теме')}</span>
          <span class="pct">${pct}% (${t.correct}/${t.total})</span>
        </div>
        <div class="theme-progress-bar"><div style="width:${pct}%"></div></div>
      `;
      tpl.appendChild(row);
    });
  }
  
  const ml = $('#mistakes-list');
  ml.innerHTML = '';
  if (!s.top_mistakes || !s.top_mistakes.length) {
    ml.innerHTML = '<p style="color:var(--text-tertiary);text-align:center;padding:20px;">Још нема грешака.</p>';
  } else {
    s.top_mistakes.forEach(m => {
      const row = document.createElement('div');
      row.className = 'mistake-row';
      row.innerHTML = `
        <div class="title">${escapeHtml(m.title.slice(0, 100))}${m.title.length > 100 ? '…' : ''}</div>
        <div class="count">${m.wrong_count}×</div>
      `;
      ml.appendChild(row);
    });
  }
}

// ============================================================
// UTILS
// ============================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3000);
}
