// Set this to your deployed Worker URL after `wrangler deploy`.
const API_URL = 'https://snehal-leadgen-api.clientsnehalprinters.workers.dev';

const state = { token: localStorage.getItem('token') || null, user: null };

function api(path, opts = {}) {
  return fetch(API_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
}

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

async function boot() {
  if (!state.token) return show('login-screen');
  try {
    const { user } = await api('/api/me');
    state.user = user;
    document.getElementById('user-email').textContent = user.email;
    show('app-screen');
    await loadAreas();
    await loadProducts();
    await loadRuns();
  } catch {
    localStorage.removeItem('token');
    state.token = null;
    show('login-screen');
  }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    await boot();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('token');
  state.token = null;
  show('login-screen');
});

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'leads') loadLeads();
    if (btn.dataset.tab === 'outreach') loadOutreach();
    if (btn.dataset.tab === 'products') loadProducts(true);
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'settings') loadSettings();
  });
});

// ---- Products ----
async function loadProducts(renderTable) {
  const { products } = await api('/api/products');
  const select = document.getElementById('product-select');
  select.innerHTML = products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  if (renderTable) {
    const tbody = document.querySelector('#products-table tbody');
    tbody.innerHTML = products
      .map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.source}</td><td>${p.url ? `<a href="${p.url}" target="_blank">link</a>` : '-'}</td></tr>`)
      .join('');
  }
}

document.getElementById('scrape-products-btn').addEventListener('click', async () => {
  const btn = document.getElementById('scrape-products-btn');
  btn.textContent = 'Scanning...';
  try {
    const res = await api('/api/products/scrape', { method: 'POST', body: JSON.stringify({ url: 'https://snehalprinters.in/' }) });
    await loadProducts();
    alert(`Found ${res.total_found} products on site, added ${res.inserted.length} new.`);
  } catch (e) {
    alert('Scrape failed: ' + e.message);
  }
  btn.textContent = 'Re-scan snehalprinters.in for products';
});

document.getElementById('add-product-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-product-name').value.trim();
  const keywords = document.getElementById('new-product-keywords').value.trim();
  if (!name) return;
  await api('/api/products', { method: 'POST', body: JSON.stringify({ name, keywords }) });
  document.getElementById('new-product-name').value = '';
  document.getElementById('new-product-keywords').value = '';
  await loadProducts();
});

// ---- Areas ----
async function loadAreas() {
  const { areas } = await api('/api/areas');
  document.getElementById('area-select').innerHTML = areas.map((a) => `<option value="${a}">${a}</option>`).join('');
}

// ---- Run pipeline ----
const STEP_LABELS = {
  queued: 'Queued...',
  searching: 'Searching Pune MIDC area (Tavily)...',
  analyzing: 'AI is checking which hits are real, in-area companies...',
  scraping: 'Finding company contact emails...',
  drafting: 'Drafting outreach emails for approval...',
  notifying: 'Sending you an approval-request email...',
  completed: 'Done.',
};

document.getElementById('run-btn').addEventListener('click', async () => {
  const product_id = document.getElementById('product-select').value;
  const area = document.getElementById('area-select').value;
  const statusEl = document.getElementById('run-status');
  const wrap = document.getElementById('progress-wrap');
  const bar = document.getElementById('progress-bar');
  if (!product_id) return (statusEl.textContent = 'Add or select a product first.');

  wrap.classList.remove('hidden');
  bar.style.width = '5%';
  statusEl.textContent = STEP_LABELS.queued;
  document.getElementById('run-btn').disabled = true;

  // Fire the run, and poll /api/runs (latest run for this product) for live progress
  // while it's in flight, since the request itself blocks until fully done.
  const runPromise = api('/api/leadgen/run', { method: 'POST', body: JSON.stringify({ product_id, area }) });
  let polling = true;
  (async function poll() {
    while (polling) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const { runs } = await api('/api/runs');
        const latest = runs.find((r) => String(r.product_id) === String(product_id));
        if (latest) {
          bar.style.width = (latest.progress_pct || 5) + '%';
          statusEl.textContent = STEP_LABELS[latest.progress_step] || latest.progress_step;
        }
      } catch {}
    }
  })();

  try {
    const res = await runPromise;
    polling = false;
    bar.style.width = '100%';
    statusEl.textContent = `Done. ${res.leads_found} new leads found (scanned ${res.hits_scanned} search hits across ${res.queries_used} queries).`;
    await loadRuns();
  } catch (e) {
    polling = false;
    statusEl.textContent = 'Error: ' + e.message;
  }
  document.getElementById('run-btn').disabled = false;
});

async function loadRuns() {
  const { runs } = await api('/api/runs');
  document.querySelector('#runs-table tbody').innerHTML = runs
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.product_name || '-')}</td><td>${r.area}</td><td>${r.status}</td><td>${r.leads_found}</td><td>${r.started_at}</td></tr>`
    )
    .join('');
}

// ---- Leads ----
async function loadLeads() {
  const { leads } = await api('/api/leads');
  document.querySelector('#leads-table tbody').innerHTML = leads
    .map(
      (l) => `<tr>
        <td>${escapeHtml(l.company_name || '-')}</td>
        <td>${l.email || '-'} ${l.email_source === 'pattern_guess' ? '<span class="badge">guessed</span>' : ''}</td>
        <td>${l.phone || '-'}</td>
        <td>${l.relevance_score ?? '-'}</td>
        <td>${escapeHtml(l.relevance_reason || '-')}</td>
        <td>${l.website ? `<a href="${l.website}" target="_blank">visit</a>` : '-'}</td>
      </tr>`
    )
    .join('');
}

// ---- Outreach approval queue ----
async function loadOutreach() {
  const { outreach } = await api('/api/outreach?status=pending');
  const list = document.getElementById('outreach-list');
  if (!outreach.length) {
    list.innerHTML = '<p class="muted">Nothing pending.</p>';
    return;
  }
  list.innerHTML = outreach
    .map(
      (o) => `
    <div class="outreach-item" data-id="${o.id}">
      <div class="subject">${escapeHtml(o.company_name)} — ${o.email || 'no email found'}</div>
      <input class="edit-subject" value="${escapeHtml(o.subject)}" />
      <textarea class="edit-body">${escapeHtml(o.body)}</textarea>
      <div class="outreach-actions">
        <button class="primary approve-btn small">Approve</button>
        <button class="ghost reject-btn small">Reject</button>
        <button class="ghost save-btn small">Save edits</button>
        <button class="ghost send-btn small">Send now (if approved)</button>
      </div>
    </div>`
    )
    .join('');

  list.querySelectorAll('.outreach-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('.approve-btn').addEventListener('click', async () => {
      await api(`/api/outreach/${id}/approve`, { method: 'POST' });
      loadOutreach();
    });
    item.querySelector('.reject-btn').addEventListener('click', async () => {
      await api(`/api/outreach/${id}/reject`, { method: 'POST' });
      loadOutreach();
    });
    item.querySelector('.save-btn').addEventListener('click', async () => {
      const subject = item.querySelector('.edit-subject').value;
      const body = item.querySelector('.edit-body').value;
      await api(`/api/outreach/${id}`, { method: 'PATCH', body: JSON.stringify({ subject, body }) });
      alert('Saved.');
    });
    item.querySelector('.send-btn').addEventListener('click', async () => {
      try {
        await api(`/api/outreach/${id}/send`, { method: 'POST' });
        alert('Sent.');
        loadOutreach();
      } catch (e) {
        alert('Send failed: ' + e.message);
      }
    });
  });
}

// ---- History ----
async function loadHistory() {
  const { history } = await api('/api/history');
  document.querySelector('#history-table tbody').innerHTML = history
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.product_name || '-')}</td>
        <td>${r.area}</td>
        <td>${r.trigger}</td>
        <td>${r.status}</td>
        <td>${r.lead_count}</td>
        <td>${r.sent_count}</td>
        <td>${r.started_at}</td>
      </tr>`
    )
    .join('');
}

// ---- Settings ----
async function loadSettings() {
  const { settings } = await api('/api/settings');
  document.getElementById('approval-email').value = settings.approval_email || '';
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const approval_email = document.getElementById('approval-email').value.trim();
  const statusEl = document.getElementById('settings-status');
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ approval_email }) });
    statusEl.textContent = 'Saved.';
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
  }
});

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
