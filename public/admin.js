// ============================================================
// Admin panel logika
// ============================================================

const API = {
  async req(method, url, body) {
    const opts = { method, headers: {}, credentials: 'include' };
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
  post: (u, b) => API.req('POST', u, b),
  delete: u => API.req('DELETE', u)
};

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
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

function fmtDate(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('sr-RS', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch(e) { return s; }
}

function fmtDateOnly(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('sr-RS');
  } catch(e) { return s; }
}

// ============================================================
// LOGIN
// ============================================================

async function tryLogin() {
  try {
    await API.get('/api/admin/check');
    enterAdmin();
  } catch(e) {
    $('#admin-login').hidden = false;
    $('#admin-panel').hidden = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#admin-login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const err = $('#admin-error');
    err.hidden = true;
    try {
      await API.post('/api/admin/login', { password: fd.get('password') });
      enterAdmin();
    } catch(ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $('#admin-logout').addEventListener('click', async () => {
    await API.post('/api/admin/logout');
    location.reload();
  });

  $('#add-user-form').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = $('#add-error');
    const okEl = $('#add-success');
    errEl.hidden = true;
    okEl.hidden = true;
    
    const payload = {
      name: fd.get('name'),
      email: fd.get('email'),
      phone: fd.get('phone'),
      password: fd.get('password'),
      expires_at: fd.get('expires_at') || null
    };
    
    try {
      await API.post('/api/admin/users', payload);
      okEl.textContent = `Полазник ${payload.name} додат успешно. Имејл: ${payload.email} · Лозинка: ${payload.password}`;
      okEl.hidden = false;
      e.target.reset();
      loadUsers();
      loadOverview();
    } catch(ex) {
      errEl.textContent = ex.message;
      errEl.hidden = false;
    }
  });

  $('#modal-close').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', closeModal);

  tryLogin();
});

// ============================================================
// PANEL
// ============================================================

function enterAdmin() {
  $('#admin-login').hidden = true;
  $('#admin-panel').hidden = false;
  loadOverview();
  loadRequests();
  loadUsers();
  loadHardest();
  // Refresh zahteva svakih 30 sec da admin vidi nove brzo
  setInterval(loadRequests, 30000);
}

async function loadRequests() {
  try {
    const { requests } = await API.get('/api/admin/signup-requests');
    $('#requests-count').textContent = requests.length;
    
    // Highlight kad ima novih
    const section = $('#requests-section');
    if (requests.length > 0) {
      section.setAttribute('open', '');
      section.classList.add('has-pending');
    } else {
      section.classList.remove('has-pending');
    }
    
    const list = $('#requests-list');
    if (!requests.length) {
      list.innerHTML = '<p class="loading">Нема нових захтева.</p>';
      return;
    }
    
    list.innerHTML = '';
    requests.forEach(r => list.appendChild(renderRequest(r)));
  } catch(e) { console.error(e); }
}

function renderRequest(r) {
  const div = document.createElement('div');
  div.className = 'request-card';
  div.innerHTML = `
    <div class="request-info">
      <div class="user-name-row">
        <span class="user-name-big">${escapeHtml(r.name)}</span>
        <span class="badge badge-pending">Чека</span>
      </div>
      <div class="user-email">${escapeHtml(r.email)} · 📱 ${escapeHtml(r.phone)}</div>
      <div class="user-meta">
        <span><strong>Послато:</strong> ${fmtDate(r.requested_at)}</span>
      </div>
      ${r.note ? `<div class="request-note"><strong>Напомена:</strong> ${escapeHtml(r.note)}</div>` : ''}
    </div>
    <div class="request-actions">
      <button class="btn btn-primary" data-act="approve" data-id="${r.id}" data-name="${escapeHtml(r.name)}">✓ Одобри</button>
      <button class="btn btn-danger" data-act="reject" data-id="${r.id}" data-name="${escapeHtml(r.name)}">✗ Одбиј</button>
    </div>
  `;
  
  div.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleRequestAction(btn.dataset.act, btn));
  });
  
  return div;
}

async function handleRequestAction(act, btn) {
  const id = btn.dataset.id;
  const name = btn.dataset.name;
  
  try {
    if (act === 'approve') {
      // Pitaj za datum isteka
      openApproveModal(id, name);
      return;
    } else if (act === 'reject') {
      if (!confirm(`Одбити захтев од ${name}?\nКорисник ће бити обавештен да захтев није прихваћен.`)) return;
      await API.post(`/api/admin/signup-requests/${id}/reject`);
      toast('Захтев одбијен.', 'success');
    }
    loadRequests();
    loadOverview();
  } catch(e) {
    toast(e.message, 'error');
  }
}

function openApproveModal(id, name) {
  // Default datum isteka: 60 dana
  const defaultExpiry = new Date();
  defaultExpiry.setDate(defaultExpiry.getDate() + 60);
  const defaultDate = defaultExpiry.toISOString().slice(0, 10);
  
  openModal(`Одобри захтев: ${name}`, `
    <form id="approve-form">
      <p style="color:var(--text-secondary);margin-bottom:16px;font-size:14px;">
        Полазник ће моћи да се пријави са имејлом и лозинком које је регистровао.
      </p>
      <label class="field">
        <span>Датум истека приступа</span>
        <input type="date" name="expires_at" value="${defaultDate}">
      </label>
      <p style="color:var(--text-tertiary);font-size:12px;margin-bottom:16px;">
        Празно = без рока истека. Препоручено: 60 дана за периодичну обуку.
      </p>
      <button type="submit" class="btn btn-primary btn-block">✓ Одобри полазника</button>
    </form>
  `);
  
  $('#approve-form').addEventListener('submit', async e => {
    e.preventDefault();
    const d = new FormData(e.target).get('expires_at');
    try {
      await API.post(`/api/admin/signup-requests/${id}/approve`, { expires_at: d || null });
      toast(`Полазник ${name} одобрен и активиран.`, 'success');
      closeModal();
      loadRequests();
      loadUsers();
      loadOverview();
    } catch(ex) { toast(ex.message, 'error'); }
  });
}

async function loadOverview() {
  try {
    const { users } = await API.get('/api/admin/users');
    const active = users.filter(u => !u.blocked && (!u.expires_at || new Date(u.expires_at) > new Date()));
    const totalAttempts = users.reduce((s, u) => s + (u.attempts || 0), 0);
    const totalCorrect = users.reduce((s, u) => s + (u.correct || 0), 0);
    const avgAcc = totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : 0;
    
    $('#admin-overview').innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${users.length}</div>
        <div class="stat-label">Укупно полазника</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${active.length}</div>
        <div class="stat-label">Активних</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalAttempts}</div>
        <div class="stat-label">Укупно одговора</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgAcc}%</div>
        <div class="stat-label">Просечна успешност</div>
      </div>
    `;
  } catch(e) { console.error(e); }
}

async function loadUsers() {
  try {
    const { users } = await API.get('/api/admin/users');
    $('#users-count').textContent = users.length;
    const list = $('#users-list');
    
    if (!users.length) {
      list.innerHTML = '<p class="loading">Још нема полазника. Додајте првог изнад.</p>';
      return;
    }
    
    list.innerHTML = '';
    users.forEach(u => list.appendChild(renderUser(u)));
  } catch(e) {
    toast(e.message, 'error');
  }
}

function renderUser(u) {
  const div = document.createElement('div');
  div.className = 'user-card' + (u.blocked ? ' blocked' : '');
  
  const isExpired = u.expires_at && new Date(u.expires_at) < new Date();
  
  const badges = [];
  if (u.blocked) badges.push('<span class="badge badge-blocked">Блокиран</span>');
  else if (isExpired) badges.push('<span class="badge badge-expired">Истекао</span>');
  else badges.push('<span class="badge badge-active">Активан</span>');
  
  if (u.has_device) badges.push('<span class="badge badge-device">📱 везан уређај</span>');
  else badges.push('<span class="badge badge-nodevice">без уређаја</span>');
  
  const mistakes = u.top_mistakes && u.top_mistakes.length
    ? `<div class="user-mistakes">
        <strong>Топ грешке:</strong> ${u.top_mistakes.map(m => `${escapeHtml(m.title)} (${m.count}×)`).join(' · ')}
       </div>`
    : '';
  
  div.innerHTML = `
    <div class="user-info">
      <div class="user-name-row">
        <span class="user-name-big">${escapeHtml(u.name)}</span>
        ${badges.join(' ')}
      </div>
      <div class="user-email">${escapeHtml(u.email)}${u.phone ? ' · ' + escapeHtml(u.phone) : ''}</div>
      <div class="user-meta">
        <span><strong>Истиче:</strong> ${fmtDateOnly(u.expires_at)}</span>
        <span><strong>Зад. пријава:</strong> ${fmtDate(u.last_login_at)}</span>
        <span><strong>Уређај:</strong> ${escapeHtml(u.user_agent || '—')}</span>
        <span><strong>Питања:</strong> ${u.attempts || 0}</span>
        <span><strong>Успех:</strong> ${u.accuracy || 0}%</span>
      </div>
      ${mistakes}
    </div>
    <div class="user-actions">
      <button class="btn btn-warning" data-act="reset" data-id="${u.id}">Ресет уређаја</button>
      <button class="btn ${u.blocked ? 'btn-primary' : 'btn-warning'}" data-act="toggle" data-id="${u.id}">
        ${u.blocked ? 'Одблокирај' : 'Блокирај'}
      </button>
      <button class="btn btn-ghost" data-act="extend" data-id="${u.id}" data-date="${u.expires_at || ''}">Промени датум</button>
      <button class="btn btn-ghost" data-act="password" data-id="${u.id}">Нова лозинка</button>
      <button class="btn btn-danger" data-act="delete" data-id="${u.id}" data-name="${escapeHtml(u.name)}">Обриши</button>
    </div>
  `;
  
  div.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleAction(btn.dataset.act, btn));
  });
  
  return div;
}

async function handleAction(act, btn) {
  const id = btn.dataset.id;
  try {
    if (act === 'reset') {
      if (!confirm('Ресетовати уређај овог полазника?')) return;
      await API.post(`/api/admin/users/${id}/reset-device`);
      toast('Уређај ресетован — полазник може да се пријави са новог.', 'success');
    } else if (act === 'toggle') {
      await API.post(`/api/admin/users/${id}/toggle-block`);
      toast('Промењен статус.', 'success');
    } else if (act === 'extend') {
      openExtendModal(id, btn.dataset.date);
      return;
    } else if (act === 'password') {
      openPasswordModal(id);
      return;
    } else if (act === 'delete') {
      if (!confirm(`Да ли заиста да обришем полазника ${btn.dataset.name}?\nСви његови подаци ће нестати.`)) return;
      await API.delete(`/api/admin/users/${id}`);
      toast('Полазник обрисан.', 'success');
    }
    loadUsers();
    loadOverview();
  } catch(e) {
    toast(e.message, 'error');
  }
}

// ============================================================
// MODALS
// ============================================================

function openModal(title, bodyHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
}

function openExtendModal(id, currentDate) {
  const date = currentDate ? currentDate.slice(0, 10) : '';
  openModal('Промени датум истека', `
    <form id="extend-form">
      <label class="field">
        <span>Нови датум истека (празно = без истека)</span>
        <input type="date" name="date" value="${date}">
      </label>
      <button type="submit" class="btn btn-primary btn-block">Сачувај</button>
    </form>
  `);
  $('#extend-form').addEventListener('submit', async e => {
    e.preventDefault();
    const d = new FormData(e.target).get('date');
    try {
      await API.post(`/api/admin/users/${id}/extend`, { expires_at: d || null });
      toast('Датум промењен.', 'success');
      closeModal();
      loadUsers();
    } catch(ex) { toast(ex.message, 'error'); }
  });
}

function openPasswordModal(id) {
  openModal('Нова лозинка', `
    <form id="pass-form">
      <label class="field">
        <span>Нова лозинка (мин. 6 знакова)</span>
        <input type="text" name="password" required minlength="6">
      </label>
      <button type="submit" class="btn btn-primary btn-block">Сачувај</button>
    </form>
  `);
  $('#pass-form').addEventListener('submit', async e => {
    e.preventDefault();
    const p = new FormData(e.target).get('password');
    try {
      await API.post(`/api/admin/users/${id}/password`, { password: p });
      toast('Лозинка промењена. Реците полазнику нову.', 'success');
      closeModal();
    } catch(ex) { toast(ex.message, 'error'); }
  });
}

// ============================================================
// HARDEST QUESTIONS
// ============================================================

async function loadHardest() {
  try {
    const { hardest } = await API.get('/api/admin/question-stats');
    const list = $('#hardest-list');
    if (!hardest.length) {
      list.innerHTML = '<p class="loading">Још нема довољно података.</p>';
      return;
    }
    list.innerHTML = '';
    hardest.forEach(h => {
      const row = document.createElement('div');
      row.className = 'hardest-row';
      row.innerHTML = `
        <div>
          <div class="num">Питање #${h.num}</div>
          <div class="title">${escapeHtml(h.title.slice(0, 120))}${h.title.length > 120 ? '…' : ''}</div>
          <div class="theme">${escapeHtml(h.theme || '')}</div>
        </div>
        <div class="acc">${h.accuracy}%<br><span style="font-size:11px;color:var(--text-tertiary);font-weight:400">${h.correct}/${h.total}</span></div>
      `;
      list.appendChild(row);
    });
  } catch(e) { console.error(e); }
}
