const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;

// Set this to your deployed Worker URL after `wrangler deploy`.
const API_URL = 'https://snehal-leadgen-api.clientsnehalprinters.workers.dev';
function api(token, path, opts = {}) {
  return fetch(API_URL + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {
        Authorization: `Bearer ${token}`
      } : {}),
      ...(opts.headers || {})
    }
  }).then(async res => {
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
      try {
        await savedFn.current();
      } catch (e) {/* transient errors are fine, next tick retries */}
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, active]);
}
const STEP_LABELS = {
  queued: 'Queued...',
  searching: 'Searching Pune MIDC area (Tavily)...',
  analyzing: 'AI is checking which hits are real, in-area companies...',
  scraping: 'Looking for a real email on the strongest match...',
  drafting: 'Drafting one outreach email for approval...',
  notifying: 'Sending you an approval-request email...',
  completed: 'Done.'
};
function escapeHtml(str) {
  return String(str || '');
} // React escapes by default; kept as a no-op for clarity at call sites.

// ---------------- Login ----------------
function Login({
  onLoggedIn
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const data = await api(null, '/api/login', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password
        })
      });
      localStorage.setItem('token', data.token);
      onLoggedIn(data.token, data.user);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "screen"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card login-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand-mark"
  }, "SP"), /*#__PURE__*/React.createElement("h1", null, "Snehal Printers"), /*#__PURE__*/React.createElement("p", {
    className: "brand-sub"
  }, "Est. 1993 · Pimpri-Chinchwad, Pune"), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Lead Generation Dashboard"), /*#__PURE__*/React.createElement("input", {
    type: "email",
    placeholder: "Email",
    autoComplete: "username",
    value: email,
    onChange: e => setEmail(e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    type: "password",
    placeholder: "Password",
    autoComplete: "current-password",
    value: password,
    onChange: e => setPassword(e.target.value),
    onKeyDown: e => e.key === 'Enter' && submit()
  }), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    disabled: busy,
    onClick: submit
  }, busy ? 'Logging in...' : 'Log in'), /*#__PURE__*/React.createElement("p", {
    className: "error"
  }, error)));
}

// ---------------- Run Pipeline tab ----------------
function RunTab({
  token,
  active
}) {
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
    const {
      products
    } = await api(token, '/api/products');
    setProducts(products);
    setProductId(cur => cur || products[0] && String(products[0].id) || '');
  }, [token]);
  const loadAreas = useCallback(async () => {
    const {
      areas
    } = await api(token, '/api/areas');
    setAreas(areas);
  }, [token]);
  const loadRuns = useCallback(async () => {
    const {
      runs
    } = await api(token, '/api/runs');
    setRuns(runs);
  }, [token]);
  useEffect(() => {
    loadProducts();
    loadAreas();
    loadRuns();
  }, [loadProducts, loadAreas, loadRuns]);
  usePolling(loadRuns, 6000, active && !runningRunId); // idle background refresh of the runs table
  usePolling(loadProducts, 15000, active);

  // While a run is in flight, poll that specific run's row for live progress —
  // this is what makes the progress bar move without any page refresh.
  usePolling(async () => {
    if (!runningRunId) return;
    const {
      run
    } = await api(token, `/api/runs/${runningRunId}`);
    setRunStatus({
      step: run.progress_step,
      pct: run.progress_pct,
      status: run.status,
      leads_found: run.leads_found,
      error: run.error
    });
    if (run.status === 'completed' || run.status === 'failed') {
      setRunningRunId(null);
      loadRuns();
    }
  }, 1500, active && !!runningRunId);
  const scrapeProducts = async () => {
    try {
      const res = await api(token, '/api/products/scrape', {
        method: 'POST',
        body: JSON.stringify({
          url: 'https://snehalprinters.in/'
        })
      });
      await loadProducts();
      alert(`Found ${res.total_found} products on site, added ${res.inserted.length} new.`);
    } catch (e) {
      alert('Scrape failed: ' + e.message);
    }
  };
  const addProduct = async () => {
    if (!newName.trim()) return;
    await api(token, '/api/products', {
      method: 'POST',
      body: JSON.stringify({
        name: newName.trim(),
        keywords: newKeywords.trim()
      })
    });
    setNewName('');
    setNewKeywords('');
    await loadProducts();
  };
  const runPipeline = async () => {
    if (!productId) return;
    setRunStatus({
      step: 'queued',
      pct: 5
    });
    try {
      const res = await api(token, '/api/leadgen/run', {
        method: 'POST',
        body: JSON.stringify({
          product_id: productId,
          area
        })
      });
      // The POST above blocks until the run is fully done server-side, but we
      // also kick off polling immediately (runningRunId set from the response)
      // so the bar animates during that wait rather than jumping at the end.
      setRunStatus({
        step: 'completed',
        pct: 100,
        status: 'completed',
        leads_found: res.leads_found,
        result: res
      });
      loadRuns();
    } catch (e) {
      setRunStatus({
        step: 'failed',
        pct: 0,
        status: 'failed',
        error: e.message
      });
    }
  };

  // Kick off polling the instant we have something running — we don't know the
  // run_id until the POST resolves, so instead poll "latest run for this product"
  // as a lightweight live indicator right after clicking Run.
  const [firing, setFiring] = useState(false);
  const onRunClick = async () => {
    if (!productId || firing) return;
    setFiring(true);
    setRunStatus({
      step: 'queued',
      pct: 5
    });
    const before = await api(token, '/api/runs');
    const beforeIds = new Set(before.runs.map(r => r.id));
    const runPromise = api(token, '/api/leadgen/run', {
      method: 'POST',
      body: JSON.stringify({
        product_id: productId,
        area
      })
    });
    // Poll for the new run row to appear, then switch to per-run polling.
    const findNew = setInterval(async () => {
      try {
        const {
          runs
        } = await api(token, '/api/runs');
        const mine = runs.find(r => !beforeIds.has(r.id) && String(r.product_id) === String(productId));
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
      setRunStatus({
        step: 'completed',
        pct: 100,
        status: 'completed',
        leads_found: res.leads_found,
        result: res
      });
      loadRuns();
    } catch (e) {
      clearInterval(findNew);
      setRunningRunId(null);
      setRunStatus({
        step: 'failed',
        pct: 0,
        status: 'failed',
        error: e.message
      });
    }
    setFiring(false);
  };
  return /*#__PURE__*/React.createElement("section", {
    className: "tab-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "1. Product"), /*#__PURE__*/React.createElement("select", {
    value: productId,
    onChange: e => setProductId(e.target.value)
  }, products.map(p => /*#__PURE__*/React.createElement("option", {
    key: p.id,
    value: p.id
  }, p.name))), /*#__PURE__*/React.createElement("button", {
    className: "ghost small",
    onClick: scrapeProducts
  }, "Re-scan snehalprinters.in for products"), /*#__PURE__*/React.createElement("div", {
    className: "add-product"
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Or add a product manually (name)",
    value: newName,
    onChange: e => setNewName(e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    placeholder: "Extra keywords (optional)",
    value: newKeywords,
    onChange: e => setNewKeywords(e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    className: "small",
    onClick: addProduct
  }, "Add")), /*#__PURE__*/React.createElement("h2", null, "2. Area"), /*#__PURE__*/React.createElement("select", {
    value: area,
    onChange: e => setArea(e.target.value)
  }, areas.map(a => /*#__PURE__*/React.createElement("option", {
    key: a,
    value: a
  }, a))), /*#__PURE__*/React.createElement("p", {
    className: "muted small-note"
  }, "Each run returns exactly one lead — the single best-matching, verified-email company found — not a batch."), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    disabled: firing,
    onClick: onRunClick
  }, firing ? 'Running...' : 'Run Lead Generation'), runStatus && /*#__PURE__*/React.createElement("div", {
    className: "progress-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "progress-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "progress-bar",
    style: {
      width: (runStatus.pct || 0) + '%'
    }
  })), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, runStatus.status === 'failed' ? 'Error: ' + runStatus.error : runStatus.status === 'completed' ? `Done. ${runStatus.leads_found} lead ${runStatus.leads_found === 1 ? '' : 's'} found${runStatus.result ? ` (scanned ${runStatus.result.hits_scanned} hits, ${runStatus.result.candidates_qualified ?? 0} qualified candidates).` : '.'}` : STEP_LABELS[runStatus.step] || runStatus.step))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Recent Runs ", /*#__PURE__*/React.createElement("span", {
    className: "live-dot",
    title: "live"
  })), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Product"), /*#__PURE__*/React.createElement("th", null, "Area"), /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", null, "Leads"), /*#__PURE__*/React.createElement("th", null, "Started"))), /*#__PURE__*/React.createElement("tbody", null, runs.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.id
  }, /*#__PURE__*/React.createElement("td", null, r.product_name || '-'), /*#__PURE__*/React.createElement("td", null, r.area), /*#__PURE__*/React.createElement("td", null, r.status), /*#__PURE__*/React.createElement("td", null, r.leads_found), /*#__PURE__*/React.createElement("td", null, r.started_at)))))));
}

// ---------------- Leads tab ----------------
function LeadsTab({
  token,
  active
}) {
  const [leads, setLeads] = useState([]);
  const load = useCallback(async () => {
    const {
      leads
    } = await api(token, '/api/leads');
    setLeads(leads);
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, 5000, active);
  return /*#__PURE__*/React.createElement("section", {
    className: "tab-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Leads ", /*#__PURE__*/React.createElement("span", {
    className: "live-dot"
  })), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Every lead here has a real, scraped email — never a guessed one."), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Company"), /*#__PURE__*/React.createElement("th", null, "Email"), /*#__PURE__*/React.createElement("th", null, "Phone"), /*#__PURE__*/React.createElement("th", null, "Score"), /*#__PURE__*/React.createElement("th", null, "Why"), /*#__PURE__*/React.createElement("th", null, "Website"))), /*#__PURE__*/React.createElement("tbody", null, leads.map(l => /*#__PURE__*/React.createElement("tr", {
    key: l.id
  }, /*#__PURE__*/React.createElement("td", null, l.company_name || '-'), /*#__PURE__*/React.createElement("td", null, l.email || '-'), /*#__PURE__*/React.createElement("td", null, l.phone || '-'), /*#__PURE__*/React.createElement("td", null, l.relevance_score ?? '-'), /*#__PURE__*/React.createElement("td", null, l.relevance_reason || '-'), /*#__PURE__*/React.createElement("td", null, l.website ? /*#__PURE__*/React.createElement("a", {
    href: l.website,
    target: "_blank",
    rel: "noreferrer"
  }, "visit") : '-')))))));
}

// ---------------- Outreach approval queue ----------------
function OutreachItem({
  token,
  item,
  onChanged
}) {
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);
  const act = async fn => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      alert(e.message);
    }
    setBusy(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "outreach-item"
  }, /*#__PURE__*/React.createElement("div", {
    className: "subject"
  }, item.company_name, " — ", item.email || 'no email found'), /*#__PURE__*/React.createElement("input", {
    className: "edit-subject",
    value: subject,
    onChange: e => setSubject(e.target.value)
  }), /*#__PURE__*/React.createElement("textarea", {
    className: "edit-body",
    value: body,
    onChange: e => setBody(e.target.value),
    rows: 8
  }), /*#__PURE__*/React.createElement("div", {
    className: "outreach-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "primary small",
    disabled: busy,
    onClick: () => act(() => api(token, `/api/outreach/${item.id}/approve`, {
      method: 'POST'
    }))
  }, "Approve"), /*#__PURE__*/React.createElement("button", {
    className: "ghost small",
    disabled: busy,
    onClick: () => act(() => api(token, `/api/outreach/${item.id}/reject`, {
      method: 'POST'
    }))
  }, "Reject"), /*#__PURE__*/React.createElement("button", {
    className: "ghost small",
    disabled: busy,
    onClick: () => act(() => api(token, `/api/outreach/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        subject,
        body
      })
    }))
  }, "Save edits"), /*#__PURE__*/React.createElement("button", {
    className: "ghost small",
    disabled: busy,
    onClick: () => act(() => api(token, `/api/outreach/${item.id}/send`, {
      method: 'POST'
    }))
  }, "Send now (if approved)")));
}
function OutreachTab({
  token,
  active
}) {
  const [items, setItems] = useState([]);
  const load = useCallback(async () => {
    const {
      outreach
    } = await api(token, '/api/outreach?status=pending');
    setItems(outreach);
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, 5000, active);
  return /*#__PURE__*/React.createElement("section", {
    className: "tab-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Pending Approval ", /*#__PURE__*/React.createElement("span", {
    className: "live-dot"
  })), items.length === 0 && /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Nothing pending."), items.map(o => /*#__PURE__*/React.createElement(OutreachItem, {
    key: o.id,
    token: token,
    item: o,
    onChanged: load
  }))));
}

// ---------------- Products tab ----------------
function ProductsTab({
  token,
  active
}) {
  const [products, setProducts] = useState([]);
  const load = useCallback(async () => {
    const {
      products
    } = await api(token, '/api/products');
    setProducts(products);
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, 15000, active);
  return /*#__PURE__*/React.createElement("section", {
    className: "tab-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "All Products"), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Name"), /*#__PURE__*/React.createElement("th", null, "Source"), /*#__PURE__*/React.createElement("th", null, "URL"))), /*#__PURE__*/React.createElement("tbody", null, products.map(p => /*#__PURE__*/React.createElement("tr", {
    key: p.id
  }, /*#__PURE__*/React.createElement("td", null, p.name), /*#__PURE__*/React.createElement("td", null, p.source), /*#__PURE__*/React.createElement("td", null, p.url ? /*#__PURE__*/React.createElement("a", {
    href: p.url,
    target: "_blank",
    rel: "noreferrer"
  }, "link") : '-')))))));
}

// ---------------- History tab ----------------
function HistoryTab({
  token,
  active
}) {
  const [history, setHistory] = useState([]);
  const load = useCallback(async () => {
    const {
      history
    } = await api(token, '/api/history');
    setHistory(history);
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, 8000, active);
  return /*#__PURE__*/React.createElement("section", {
    className: "tab-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "History ", /*#__PURE__*/React.createElement("span", {
    className: "live-dot"
  })), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Every run, manual or automatic (daily 10 AM IST), with results."), /*#__PURE__*/React.createElement("table", null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "Product"), /*#__PURE__*/React.createElement("th", null, "Area"), /*#__PURE__*/React.createElement("th", null, "Trigger"), /*#__PURE__*/React.createElement("th", null, "Status"), /*#__PURE__*/React.createElement("th", null, "Leads"), /*#__PURE__*/React.createElement("th", null, "Sent"), /*#__PURE__*/React.createElement("th", null, "Started"))), /*#__PURE__*/React.createElement("tbody", null, history.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.id
  }, /*#__PURE__*/React.createElement("td", null, r.product_name || '-'), /*#__PURE__*/React.createElement("td", null, r.area), /*#__PURE__*/React.createElement("td", null, r.trigger), /*#__PURE__*/React.createElement("td", null, r.status), /*#__PURE__*/React.createElement("td", null, r.lead_count), /*#__PURE__*/React.createElement("td", null, r.sent_count), /*#__PURE__*/React.createElement("td", null, r.started_at)))))));
}

// ---------------- Settings tab ----------------
function SettingsTab({
  token
}) {
  const [approvalEmail, setApprovalEmail] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    api(token, '/api/settings').then(({
      settings
    }) => setApprovalEmail(settings.approval_email || ''));
  }, [token]);
  const save = async () => {
    try {
      await api(token, '/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          approval_email: approvalEmail
        })
      });
      setStatus('Saved.');
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
  };
  return /*#__PURE__*/React.createElement("section", {
    className: "tab-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("h2", null, "Settings"), /*#__PURE__*/React.createElement("label", {
    className: "muted"
  }, "Send approval-request emails to"), /*#__PURE__*/React.createElement("input", {
    type: "email",
    placeholder: "you@snehalprinters.in",
    value: approvalEmail,
    onChange: e => setApprovalEmail(e.target.value)
  }), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, "Every morning at 10:00 AM IST the pipeline runs automatically for all active products across the whole Pune MIDC belt. Each run produces at most one lead (the strongest match with a verified email). Once a new outreach draft is ready, an email is sent here asking you to review and approve it."), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    onClick: save
  }, "Save"), /*#__PURE__*/React.createElement("p", {
    className: "muted"
  }, status)));
}

// ---------------- App shell ----------------
const TABS = [{
  id: 'run',
  label: 'Run Pipeline',
  Comp: RunTab
}, {
  id: 'leads',
  label: 'Leads',
  Comp: LeadsTab
}, {
  id: 'outreach',
  label: 'Approval Queue',
  Comp: OutreachTab
}, {
  id: 'products',
  label: 'Products',
  Comp: ProductsTab
}, {
  id: 'history',
  label: 'History',
  Comp: HistoryTab
}, {
  id: 'settings',
  label: 'Settings',
  Comp: SettingsTab
}];
function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || null);
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('run');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!token) {
      setReady(true);
      return;
    }
    api(token, '/api/me').then(({
      user
    }) => {
      setUser(user);
      setReady(true);
    }).catch(() => {
      localStorage.removeItem('token');
      setToken(null);
      setReady(true);
    });
  }, [token]);
  if (!ready) return null;
  if (!token || !user) {
    return /*#__PURE__*/React.createElement(Login, {
      onLoggedIn: (t, u) => {
        setToken(t);
        setUser(u);
      }
    });
  }
  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "screen"
  }, /*#__PURE__*/React.createElement("header", null, /*#__PURE__*/React.createElement("h1", null, "Snehal Printers — Lead Gen"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "muted"
  }, user.email), /*#__PURE__*/React.createElement("button", {
    className: "ghost",
    onClick: logout
  }, "Log out"))), /*#__PURE__*/React.createElement("nav", {
    className: "tabs"
  }, TABS.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    className: 'tab-btn' + (tab === t.id ? ' active' : ''),
    onClick: () => setTab(t.id)
  }, t.label))), TABS.map(({
    id,
    Comp
  }) => /*#__PURE__*/React.createElement("div", {
    key: id,
    style: {
      display: tab === id ? 'block' : 'none'
    }
  }, /*#__PURE__*/React.createElement(Comp, {
    token: token,
    active: tab === id
  }))));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));