const { useState, useEffect, useRef, useCallback } = React;

// Set this to your deployed Worker URL after `wrangler deploy`.
const API_URL = 'https://snehal-leadgen-api.clientsnehalprinters.workers.dev';

function api(token, path, opts = {}) {
  return fetch(API_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
}

// Generic "poll this every N ms while `active` is true" hook. Used everywhere
// so every tab reflects the backend live instead of needing a manual refresh —
// e.g. Leads/Outreach/History update themselves as the pipeline (manual runs
// or the daily 10AM cron) produces new data, even if you never touch the tab.
function usePolling(fn, intervalMs, active) {
  const savedFn = useRef(fn);
  savedFn.current = fn;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try { await savedFn.current(); } catch (e) { /* transient errors are fine, next tick retries */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs, active]);
}

const STEP_LABELS = {
  queued: 'Queued...',
  searching: 'Searching Pune MIDC area (Tavily)...',
  analyzing: 'AI is checking which hits are real, in-area companies...',
  scraping: 'Looking for a real email on the strongest match...',
  drafting: 'Drafting one outreach email for approval...',
  notifying: 'Sending you an approval-request email...',
  completed: 'Done.',
};

function escapeHtml(str) { return String(str || ''); } // React escapes by default; kept as a no-op for clarity at call sites.

// ---------------- Login ----------------
function Login({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const data = await api(null, '/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.setItem('token', data.token);
      onLoggedIn(data.token, data.user);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="screen">
      <div className="card login-card">
        <div className="brand-mark">SP</div>
        <h1>Snehal Printers</h1>
        <p className="brand-sub">Est. 1993 · Pimpri-Chinchwad, Pune</p>
        <p className="muted">Lead Generation Dashboard</p>
        <input type="email" placeholder="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input type="password" placeholder="Password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <button className="primary" disabled={busy} onClick={submit}>{busy ? 'Logging in...' : 'Log in'}</button>
        <p className="error">{error}</p>
      </div>
    </div>
  );
}

// ---------------- Run Pipeline tab ----------------
function RunTab({ token, active }) {
  const [products, setProducts] = useState([]);
  const [areas, setAreas] = useState([]);
  const [productId, setProductId] = useState('');
  const [area, setArea] = useState('Pune MIDC');
  const [newName, setNewName] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [runs, setRuns] = useState([]);
  const [runningRunId, setRunningRunId] = useState(null);
  const [runStatus, setRunStatus] = useState(null); // {step, pct, done, error, result}
  const pollTimer = useRef(null);

  const loadProducts = useCallback(async () => {
    const { products } = await api(token, '/api/products');
    setProducts(products);
    setProductId((cur) => cur || (products[0] && String(products[0].id)) || '');
  }, [token]);

  const loadAreas = useCallback(async () => {
    const { areas } = await api(token, '/api/areas');
    setAreas(areas);
  }, [token]);

  const loadRuns = useCallback(async () => {
    const { runs } = await api(token, '/api/runs');
    setRuns(runs);
  }, [token]);

  useEffect(() => { loadProducts(); loadAreas(); loadRuns(); }, [loadProducts, loadAreas, loadRuns]);
  usePolling(loadRuns, 6000, active && !runningRunId); // idle background refresh of the runs table
  usePolling(loadProducts, 15000, active);

  // While a run is in flight, poll that specific run's row for live progress —
  // this is what makes the progress bar move without any page refresh.
  usePolling(async () => {
    if (!runningRunId) return;
    const { run } = await api(token, `/api/runs/${runningRunId}`);
    setRunStatus({ step: run.progress_step, pct: run.progress_pct, status: run.status, leads_found: run.leads_found, error: run.error });
    if (run.status === 'completed' || run.status === 'failed') {
      setRunningRunId(null);
      loadRuns();
    }
  }, 1500, active && !!runningRunId);

  const scrapeProducts = async () => {
    try {
      const res = await api(token, '/api/products/scrape', { method: 'POST', body: JSON.stringify({ url: 'https://snehalprinters.in/' }) });
      await loadProducts();
      alert(`Found ${res.total_found} products on site, added ${res.inserted.length} new.`);
    } catch (e) {
      alert('Scrape failed: ' + e.message);
    }
  };

  const addProduct = async () => {
    if (!newName.trim()) return;
    await api(token, '/api/products', { method: 'POST', body: JSON.stringify({ name: newName.trim(), keywords: newKeywords.trim() }) });
    setNewName(''); setNewKeywords('');
    await loadProducts();
  };

  const runPipeline = async () => {
    if (!productId) return;
    setRunStatus({ step: 'queued', pct: 5 });
    try {
      const res = await api(token, '/api/leadgen/run', { method: 'POST', body: JSON.stringify({ product_id: productId, area }) });
      // The POST above blocks until the run is fully done server-side, but we
      // also kick off polling immediately (runningRunId set from the response)
      // so the bar animates during that wait rather than jumping at the end.
      setRunStatus({ step: 'completed', pct: 100, status: 'completed', leads_found: res.leads_found, result: res });
      loadRuns();
    } catch (e) {
      setRunStatus({ step: 'failed', pct: 0, status: 'failed', error: e.message });
    }
  };

  // Kick off polling the instant we have something running — we don't know the
  // run_id until the POST resolves, so instead poll "latest run for this product"
  // as a lightweight live indicator right after clicking Run.
  const [firing, setFiring] = useState(false);
  const onRunClick = async () => {
    if (!productId || firing) return;
    setFiring(true);
    setRunStatus({ step: 'queued', pct: 5 });
    const before = await api(token, '/api/runs');
    const beforeIds = new Set(before.runs.map((r) => r.id));
    const runPromise = api(token, '/api/leadgen/run', { method: 'POST', body: JSON.stringify({ product_id: productId, area }) });
    // Poll for the new run row to appear, then switch to per-run polling.
    const findNew = setInterval(async () => {
      try {
        const { runs } = await api(token, '/api/runs');
        const mine = runs.find((r) => !beforeIds.has(r.id) && String(r.product_id) === String(productId));
        if (mine) {
          clearInterval(findNew);
          setRunningRunId(mine.id);
        }
      } catch {}
    }, 1000);
    try {
      const res = await runPromise;
      clearInterval(findNew);
      setRunningRunId(null);
      setRunStatus({ step: 'completed', pct: 100, status: 'completed', leads_found: res.leads_found, result: res });
      loadRuns();
    } catch (e) {
      clearInterval(findNew);
      setRunningRunId(null);
      setRunStatus({ step: 'failed', pct: 0, status: 'failed', error: e.message });
    }
    setFiring(false);
  };

  return (
    <section className="tab-panel">
      <div className="card">
        <h2>1. Product</h2>
        <select value={productId} onChange={(e) => setProductId(e.target.value)}>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="ghost small" onClick={scrapeProducts}>Re-scan snehalprinters.in for products</button>

        <div className="add-product">
          <input placeholder="Or add a product manually (name)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input placeholder="Extra keywords (optional)" value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} />
          <button className="small" onClick={addProduct}>Add</button>
        </div>

        <h2>2. Area</h2>
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>

        <p className="muted small-note">Each run returns exactly one lead — the single best-matching, verified-email company found — not a batch.</p>
        <button className="primary" disabled={firing} onClick={onRunClick}>{firing ? 'Running...' : 'Run Lead Generation'}</button>

        {runStatus && (
          <div className="progress-wrap">
            <div className="progress-track"><div className="progress-bar" style={{ width: (runStatus.pct || 0) + '%' }} /></div>
            <p className="muted">
              {runStatus.status === 'failed'
                ? 'Error: ' + runStatus.error
                : runStatus.status === 'completed'
                ? `Done. ${runStatus.leads_found} lead ${runStatus.leads_found === 1 ? '' : 's'} found${runStatus.result ? ` (scanned ${runStatus.result.hits_scanned} hits, ${runStatus.result.candidates_qualified ?? 0} qualified candidates).` : '.'}`
                : STEP_LABELS[runStatus.step] || runStatus.step}
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Recent Runs <span className="live-dot" title="live" /></h2>
        <table>
          <thead><tr><th>Product</th><th>Area</th><th>Status</th><th>Leads</th><th>Started</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.product_name || '-'}</td>
                <td>{r.area}</td>
                <td>{r.status}</td>
                <td>{r.leads_found}</td>
                <td>{r.started_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------- Leads tab ----------------
function LeadsTab({ token, active }) {
  const [leads, setLeads] = useState([]);
  const load = useCallback(async () => {
    const { leads } = await api(token, '/api/leads');
    setLeads(leads);
  }, [token]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 5000, active);

  return (
    <section className="tab-panel">
      <div className="card">
        <h2>Leads <span className="live-dot" /></h2>
        <p className="muted">Every lead here has a real, scraped email — never a guessed one.</p>
        <table>
          <thead><tr><th>Company</th><th>Email</th><th>Phone</th><th>Score</th><th>Why</th><th>Website</th></tr></thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td>{l.company_name || '-'}</td>
                <td>{l.email || '-'}</td>
                <td>{l.phone || '-'}</td>
                <td>{l.relevance_score ?? '-'}</td>
                <td>{l.relevance_reason || '-'}</td>
                <td>{l.website ? <a href={l.website} target="_blank" rel="noreferrer">visit</a> : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------- Outreach approval queue ----------------
function OutreachItem({ token, item, onChanged }) {
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);

  const act = async (fn) => { setBusy(true); try { await fn(); onChanged(); } catch (e) { alert(e.message); } setBusy(false); };

  return (
    <div className="outreach-item">
      <div className="subject">{item.company_name} — {item.email || 'no email found'}</div>
      <input className="edit-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea className="edit-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
      <div className="outreach-actions">
        <button className="primary small" disabled={busy} onClick={() => act(() => api(token, `/api/outreach/${item.id}/approve`, { method: 'POST' }))}>Approve</button>
        <button className="ghost small" disabled={busy} onClick={() => act(() => api(token, `/api/outreach/${item.id}/reject`, { method: 'POST' }))}>Reject</button>
        <button className="ghost small" disabled={busy} onClick={() => act(() => api(token, `/api/outreach/${item.id}`, { method: 'PATCH', body: JSON.stringify({ subject, body }) }))}>Save edits</button>
        <button className="ghost small" disabled={busy} onClick={() => act(() => api(token, `/api/outreach/${item.id}/send`, { method: 'POST' }))}>Send now (if approved)</button>
      </div>
    </div>
  );
}

function OutreachTab({ token, active }) {
  const [items, setItems] = useState([]);
  const load = useCallback(async () => {
    const { outreach } = await api(token, '/api/outreach?status=pending');
    setItems(outreach);
  }, [token]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 5000, active);

  return (
    <section className="tab-panel">
      <div className="card">
        <h2>Pending Approval <span className="live-dot" /></h2>
        {items.length === 0 && <p className="muted">Nothing pending.</p>}
        {items.map((o) => <OutreachItem key={o.id} token={token} item={o} onChanged={load} />)}
      </div>
    </section>
  );
}

// ---------------- Products tab ----------------
function ProductsTab({ token, active }) {
  const [products, setProducts] = useState([]);
  const load = useCallback(async () => {
    const { products } = await api(token, '/api/products');
    setProducts(products);
  }, [token]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 15000, active);

  return (
    <section className="tab-panel">
      <div className="card">
        <h2>All Products</h2>
        <table>
          <thead><tr><th>Name</th><th>Source</th><th>URL</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.source}</td>
                <td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">link</a> : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------- History tab ----------------
function HistoryTab({ token, active }) {
  const [history, setHistory] = useState([]);
  const load = useCallback(async () => {
    const { history } = await api(token, '/api/history');
    setHistory(history);
  }, [token]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 8000, active);

  return (
    <section className="tab-panel">
      <div className="card">
        <h2>History <span className="live-dot" /></h2>
        <p className="muted">Every run, manual or automatic (daily 10 AM IST), with results.</p>
        <table>
          <thead><tr><th>Product</th><th>Area</th><th>Trigger</th><th>Status</th><th>Leads</th><th>Sent</th><th>Started</th></tr></thead>
          <tbody>
            {history.map((r) => (
              <tr key={r.id}>
                <td>{r.product_name || '-'}</td>
                <td>{r.area}</td>
                <td>{r.trigger}</td>
                <td>{r.status}</td>
                <td>{r.lead_count}</td>
                <td>{r.sent_count}</td>
                <td>{r.started_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------- Settings tab ----------------
function SettingsTab({ token }) {
  const [approvalEmail, setApprovalEmail] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    api(token, '/api/settings').then(({ settings }) => setApprovalEmail(settings.approval_email || ''));
  }, [token]);

  const save = async () => {
    try {
      await api(token, '/api/settings', { method: 'POST', body: JSON.stringify({ approval_email: approvalEmail }) });
      setStatus('Saved.');
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
  };

  return (
    <section className="tab-panel">
      <div className="card">
        <h2>Settings</h2>
        <label className="muted">Send approval-request emails to</label>
        <input type="email" placeholder="you@snehalprinters.in" value={approvalEmail} onChange={(e) => setApprovalEmail(e.target.value)} />
        <p className="muted">Every morning at 10:00 AM IST the pipeline runs automatically for all active products across the whole Pune MIDC belt. Each run produces at most one lead (the strongest match with a verified email). Once a new outreach draft is ready, an email is sent here asking you to review and approve it.</p>
        <button className="primary" onClick={save}>Save</button>
        <p className="muted">{status}</p>
      </div>
    </section>
  );
}

// ---------------- App shell ----------------
const TABS = [
  { id: 'run', label: 'Run Pipeline', Comp: RunTab },
  { id: 'leads', label: 'Leads', Comp: LeadsTab },
  { id: 'outreach', label: 'Approval Queue', Comp: OutreachTab },
  { id: 'products', label: 'Products', Comp: ProductsTab },
  { id: 'history', label: 'History', Comp: HistoryTab },
  { id: 'settings', label: 'Settings', Comp: SettingsTab },
];

function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || null);
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('run');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!token) { setReady(true); return; }
    api(token, '/api/me').then(({ user }) => { setUser(user); setReady(true); })
      .catch(() => { localStorage.removeItem('token'); setToken(null); setReady(true); });
  }, [token]);

  if (!ready) return null;

  if (!token || !user) {
    return <Login onLoggedIn={(t, u) => { setToken(t); setUser(u); }} />;
  }

  const logout = () => { localStorage.removeItem('token'); setToken(null); setUser(null); };

  return (
    <div className="screen">
      <header>
        <h1>Snehal Printers — Lead Gen</h1>
        <div>
          <span className="muted">{user.email}</span>
          <button className="ghost" onClick={logout}>Log out</button>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'tab-btn' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>

      {TABS.map(({ id, Comp }) => (
        <div key={id} style={{ display: tab === id ? 'block' : 'none' }}>
          <Comp token={token} active={tab === id} />
        </div>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
