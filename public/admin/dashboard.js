/* ═══════════════════════════════════════════════════════════════════════
   Free Claude Code Gateway — Dashboard
   Vanilla JS, no build step. Talks to /admin/api/*.
   ═══════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── DOM Shortcuts ──────────────────────────────────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ══════════════════════════════════════════════════════════════════
     SECTION 1 — Formatters & Utilities
     ══════════════════════════════════════════════════════════════════ */
  const fmt = {
    n: (v) => Number(v || 0).toLocaleString(),
    ms: (v) => `${Number(v || 0).toLocaleString()} ms`,
    pct: (v) => `${Number(v || 0).toFixed(1)}%`,
    money: (v) => `$${Number(v || 0).toFixed(4)}`,
    time: (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString();
    },
    relativeTime: (iso) => {
      if (!iso) return '—';
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return '—';
      const diff = Date.now() - t;
      if (diff < 1000) return 'just now';
      if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return `${Math.floor(diff / 86_400_000)}d ago`;
    },
    shortPath: (p) => {
      if (!p) return '';
      const i = p.indexOf('?');
      return i < 0 ? p : `${p.slice(0, i)}?…`;
    },
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* Status class returns 'status-2xx' | 'status-3xx' | 'status-4xx' | 'status-5xx' | 'status-timeout' */
  function statusClass(code) {
    if (code === 0) return 'status-timeout';
    if (code >= 500) return 'status-5xx';
    if (code >= 400) return 'status-4xx';
    if (code >= 300) return 'status-3xx';
    return 'status-2xx';
  }

  /* Human-readable label for status code */
  function statusLabel(code) {
    if (code === 0) return 'Timeout';
    if (code === 200) return 'OK';
    if (code === 201) return 'Created';
    if (code === 204) return 'No Content';
    if (code === 400) return 'Bad Request';
    if (code === 401) return 'Unauthorized';
    if (code === 403) return 'Forbidden';
    if (code === 404) return 'Not Found';
    if (code === 408) return 'Timeout';
    if (code === 413) return 'Too Large';
    if (code === 422) return 'Unprocessable';
    if (code === 429) return 'Rate Limited';
    if (code === 500) return 'Server Error';
    if (code === 502) return 'Bad Gateway';
    if (code === 503) return 'Unavailable';
    if (code === 504) return 'Gateway Timeout';
    if (code >= 500) return 'Server Error';
    if (code >= 400) return 'Client Error';
    return 'OK';
  }

  function truncateId(id) {
    if (!id) return '—';
    return id.length > 12 ? id.slice(0, 12) + '…' : id;
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 2 — Application State
     ══════════════════════════════════════════════════════════════════ */
  const state = {
    view: null,
    requestBuffer: [],
    paused: false,
    bufferedEvents: [],
    requestFilter: { search: '', status: 'all', endpoint: 'all', model: 'all', stream: 'all' },
    sort: { key: 'requestCount', dir: 'desc' },
    modelFilter: { search: '', status: 'all' },
    availableModels: [],
    lastStats: null,
    lastConfig: null,
    chartReq: null,
    chartLat: null,
    mappings: {},
    savedMappings: {},
    selectedMapping: null,
    testedMappings: {},
    failedMappings: {},
    defaultModel: '',
    familyRules: [],
    availableFilter: 'all',
    availableSearch: '',
    diagResults: [],
    lastPgBody: null,
    lastPgResponse: null,
    lastPgCurl: '',
    pgRunning: false,
    sparkReqHistory: [],
    unsavedChanges: false,
    suggestions: [],
    defaultSuggestion: null,
    availableModelsCachedAt: null,
    prefixStyle: null,
    configShell: 'bash',
  };

  /* ══════════════════════════════════════════════════════════════════
     SECTION 3 — Toast Notifications (stacked)
     ══════════════════════════════════════════════════════════════════ */
  function toast(msg, kind = 'ok', title = '', ms = 3500) {
    const container = $('#toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    const iconSvg = {
      ok: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warn: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    }[kind] || '';
    el.innerHTML = `${iconSvg}<div style="flex:1; min-width:0"><div class="toast-title">${escapeHtml(title || (kind === 'ok' ? 'Success' : kind === 'error' ? 'Error' : 'Notice'))}</div><div class="toast-message">${escapeHtml(msg)}</div></div>`;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 4 — API Helper
     ══════════════════════════════════════════════════════════════════ */
  async function api(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`/admin/api${path}`, init);
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 5 — Stagger Animation
     ══════════════════════════════════════════════════════════════════ */
  function staggerView(container) {
    if (!container) return;
    const targets = $$('.kpi-card, .panel, .info-row, .provider-card, .marketplace-card, .checklist-item, .diag-step, .settings-section, .status-header, .alert-row, .failure-item, .route-item', container);
    targets.forEach((el, i) => {
      el.style.animationDelay = `${Math.min(i * 30, 600)}ms`;
      el.classList.remove('stagger-item');
      void el.offsetWidth;
      el.classList.add('stagger-item');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 6 — Sidebar Navigation
     ══════════════════════════════════════════════════════════════════ */
  const viewTitles = {
    overview: ['Overview', 'Monitor requests, latency, models, and provider health in real time.'],
    requests: ['Live Requests', 'Real-time feed of every proxied Claude and OpenAI request.'],
    playground: ['Playground', 'Test requests and inspect the full translation pipeline.'],
    providers: ['Providers', 'Manage upstream AI provider connections and discover integrations.'],
    models: ['Model Router', 'Map Claude model names to provider models with fallback routing.'],
    settings: ['Gateway Settings', 'Configure provider connection, security, rate limits, and behavior.'],
    diagnostics: ['Provider Diagnostics', 'Step-by-step checks for provider connectivity and translation.'],
    context: ['Auto-Compact Context', 'Track token usage, auto-compact conversations, and preserve session state.'],
  };

  function switchView(view) {
    if (!viewTitles[view]) return;
    if (state.view === view) return;
    state.view = view;
    location.hash = view;

    $$('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.getAttribute('data-view') === view);
    });
    $$('.view').forEach((v) => {
      v.hidden = v.getAttribute('data-view') !== view;
    });

    const [title, sub] = viewTitles[view];
    $('#page-title').textContent = title;
    $('#page-subtitle').textContent = sub;

    const viewEl = $(`.view[data-view="${view}"]`);
    staggerView(viewEl);

    if (view === 'models') loadMappings();
    if (view === 'settings') { loadConfig(); loadOperations(); lciLoadStatus(); }

    if (view === 'providers') renderProviders();
    if (view === 'diagnostics') resetDiagnostics();
    if (view === 'context') {
      // Context page loaded via the module's own handler registered with data-view="context" clicks
      // Also call it directly here as a safety net
      if (typeof window.__loadContextPage === 'function') window.__loadContextPage();
    }
    if (view === 'overview') {
      loadStats();
      renderSetupChecklist();
      renderGatewayInfo();
      setTimeout(() => {
        if (state.chartReq) state.chartReq.resize();
        if (state.chartLat) state.chartLat.resize();
      }, 50);
    }
  }

  $$('.nav-item').forEach((n) => {
    n.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(n.getAttribute('data-view'));
      closeMobileMenu();
    });
  });

  window.addEventListener('hashchange', () => {
    const hash = location.hash.replace('#', '') || 'overview';
    if (hash !== state.view) switchView(hash);
  });

  /* ── Mobile menu ─────────────────────────────────────────────────── */
  const mobileBtn = $('#mobile-menu-btn');
  const sidebar = $('#sidebar');
  function closeMobileMenu() { sidebar.classList.remove('open'); }
  if (mobileBtn) {
    mobileBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
  }

  /* ── Persistence pill (subtle, success-styled) ───────────────────── */
  const PERSIST_KEY = 'fcc-gateway-persist-dismissed';
  const persistPill = $('#persist-banner');
  if (persistPill) {
    if (localStorage.getItem(PERSIST_KEY) === '1') persistPill.classList.add('hidden');
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 7 — KPI Cards with Sparklines, Status & Diagnosis
     ══════════════════════════════════════════════════════════════════ */
  const KPI_ICONS = {
    total: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    tokens: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>',
    rpm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    latency: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    cost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>',
  };

  /* Build a compact, status-aware KPI list from a stats payload */
  function buildKpiCards(data) {
    const total = data.totalRequests || 0;
    const errors = data.errorCount || 0;
    const success = data.successCount || 0;
    const errRate = data.errorRate || 0;
    const p50 = data.medianLatencyMs || 0;
    const p95 = data.p95LatencyMs || 0;
    const rpm = data.requestsPerMinute || 0;
    const tokens = data.totalTokens || 0;
    const cost = data.costEstimate || 0;

    /* Helpers to compute health/state */
    const errSev = total === 0 ? 'neutral' : errRate < 1 ? 'good' : errRate < 5 ? 'warn' : 'bad';
    const latSev = total === 0 ? 'neutral' : p95 < 1500 ? 'good' : p95 < 5000 ? 'warn' : 'bad';
    const rpmSev = total === 0 ? 'neutral' : rpm > 0 ? 'good' : 'neutral';

    const arrowUp = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
    const arrowDown = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';

    return [
      {
        label: 'Total Requests',
        value: fmt.n(total),
        sparkKey: 'totalRequests',
        icon: 'blue',
        svg: KPI_ICONS.total,
        color: '#2563EB',
        context: total === 0 ? 'No traffic yet' : `Last 60s: ${fmt.n(rpm)} req/min`,
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'Awaiting traffic' }
          : { tone: 'good', text: 'Receiving traffic' },
        trend: total === 0 ? null : { tone: 'neutral', text: 'All time' },
        valueTone: null,
        showSpark: total > 0,
      },
      {
        label: 'Success Rate',
        value: total === 0 ? '—' : `${(100 - errRate).toFixed(1)}%`,
        sparkKey: 'successCount',
        icon: errSev === 'bad' ? 'red' : 'green',
        svg: KPI_ICONS.success,
        color: errSev === 'bad' ? '#EF4444' : '#10B981',
        context: total === 0 ? 'No data' : `${fmt.n(success)} succeeded`,
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'No data yet' }
          : errSev === 'bad'
            ? { tone: 'bad', text: 'High failure rate' }
            : errSev === 'warn'
              ? { tone: 'warn', text: 'Investigate errors' }
              : { tone: 'good', text: 'Healthy' },
        trend: total === 0 ? null : { tone: 'neutral', text: '2xx' },
        valueTone: errSev === 'bad' ? 'bad' : errSev === 'warn' ? 'warn' : 'good',
        showSpark: total > 0,
      },
      {
        label: 'Error Rate',
        value: total === 0 ? '—' : fmt.pct(errRate),
        sparkKey: 'errorCount',
        icon: errSev === 'bad' ? 'red' : errSev === 'warn' ? 'amber' : 'green',
        svg: KPI_ICONS.error,
        color: errSev === 'bad' ? '#EF4444' : errSev === 'warn' ? '#F59E0B' : '#10B981',
        context: total === 0 ? 'No data' : `${fmt.n(errors)} failed requests`,
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'No data yet' }
          : errSev === 'bad'
            ? { tone: 'bad', text: 'Needs attention' }
            : errSev === 'warn'
              ? { tone: 'warn', text: 'Watch closely' }
              : { tone: 'good', text: 'Within budget' },
        trend: total === 0 ? null : { tone: errSev === 'bad' ? 'down' : errSev === 'warn' ? 'warn' : 'up', text: '4xx + 5xx' },
        valueTone: errSev === 'bad' ? 'bad' : errSev === 'warn' ? 'warn' : null,
        showSpark: total > 0,
      },
      {
        label: 'Total Tokens',
        value: fmt.n(tokens),
        sparkKey: 'totalTokens',
        icon: 'violet',
        svg: KPI_ICONS.tokens,
        color: '#7C3AED',
        context: total === 0
          ? 'In + out combined'
          : `${fmt.n(data.totalInputTokens || 0)} in · ${fmt.n(data.totalOutputTokens || 0)} out`,
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'No usage yet' }
          : cost > 0
            ? { tone: 'neutral', text: `Cost ${fmt.money(cost)}` }
            : { tone: 'neutral', text: 'Set $ rates to track cost' },
        trend: null,
        valueTone: null,
        showSpark: total > 0,
      },
      {
        label: 'Median Latency',
        value: total === 0 ? '—' : fmt.ms(p50),
        sparkKey: 'medianLatencyMs',
        icon: 'blue',
        svg: KPI_ICONS.latency,
        color: '#2563EB',
        context: total === 0 ? 'P50 latency' : `P50 over all requests`,
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'No data' }
          : p50 < 1000
            ? { tone: 'good', text: 'Fast' }
            : p50 < 3000
              ? { tone: 'neutral', text: 'Acceptable' }
              : { tone: 'warn', text: 'Slow' },
        trend: null,
        valueTone: null,
        showSpark: total > 0,
      },
      {
        label: 'P95 Latency',
        value: total === 0 ? '—' : fmt.ms(p95),
        sparkKey: 'p95LatencyMs',
        icon: latSev === 'bad' ? 'red' : latSev === 'warn' ? 'amber' : 'green',
        svg: KPI_ICONS.latency,
        color: latSev === 'bad' ? '#EF4444' : latSev === 'warn' ? '#F59E0B' : '#10B981',
        context: total === 0
          ? '95th percentile'
          : latSev === 'bad' ? 'Investigate provider' : latSev === 'warn' ? 'Could be better' : 'Performing well',
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'No data' }
          : latSev === 'bad'
            ? { tone: 'bad', text: 'Very slow' }
            : latSev === 'warn'
              ? { tone: 'warn', text: 'Above target' }
              : { tone: 'good', text: 'Healthy' },
        trend: null,
        valueTone: latSev === 'bad' ? 'bad' : latSev === 'warn' ? 'warn' : null,
        showSpark: total > 0,
      },
      {
        label: 'Est. Cost',
        value: fmt.money(cost),
        sparkKey: 'costEstimate',
        icon: 'green',
        svg: KPI_ICONS.cost,
        color: '#10B981',
        context: total === 0
          ? 'From pricing config'
          : 'Computed from $/1M rates',
        diagnosis: total === 0
          ? { tone: 'neutral', text: 'No spend yet' }
          : cost > 0
            ? { tone: 'neutral', text: 'Billed to your provider' }
            : { tone: 'neutral', text: 'Set $ rates to enable' },
        trend: null,
        valueTone: null,
        showSpark: total > 0,
      },
      {
        label: 'Req/min',
        value: fmt.n(rpm),
        sparkKey: 'requestsPerMinute',
        icon: rpm > 0 ? 'cyan' : 'slate',
        svg: KPI_ICONS.rpm,
        color: rpm > 0 ? '#06B6D4' : '#475569',
        context: 'Last 60 seconds',
        diagnosis: rpm === 0
          ? { tone: 'neutral', text: 'Idle' }
          : rpm < 5
            ? { tone: 'neutral', text: 'Low traffic' }
            : rpm < 30
              ? { tone: 'good', text: 'Steady' }
              : { tone: 'good', text: 'Busy' },
        trend: rpm > 0 ? { tone: 'up', text: arrowUp } : null,
        valueTone: null,
        showSpark: total > 0,
      },
    ];
  }

  function renderKpiCards(containerId, data) {
    const el = $(containerId);
    if (!el) return;
    const cards = buildKpiCards(data);
    el.innerHTML = cards.map((k) => {
      const valueClass = k.valueTone ? `kpi-value kpi-value-${k.valueTone}` : 'kpi-value';
      const trend = k.trend
        ? `<div class="kpi-trend ${k.trend.tone}">${k.trend.text}</div>`
        : '<div></div>';
      const diagnosis = k.diagnosis
        ? `<div class="kpi-diagnosis ${k.diagnosis.tone}">${escapeHtml(k.diagnosis.text)}</div>`
        : '';
      const spark = k.showSpark
        ? `<div class="kpi-spark" data-spark="${k.sparkKey}"></div>`
        : `<div class="kpi-spark" data-spark-empty="1"></div>`;
      return `<div class="kpi-card kpi-${k.icon} stagger-item">
        <div class="kpi-head">
          <div class="kpi-icon ${k.icon}">${k.svg}</div>
          ${trend}
        </div>
        <div class="kpi-label">${escapeHtml(k.label)}</div>
        <div class="${valueClass}">${k.value}</div>
        <div class="kpi-context">${escapeHtml(k.context)}</div>
        ${diagnosis}
        ${spark}
      </div>`;
    }).join('');
    kpiDefs.length = 0;
    cards.forEach((k) => { if (k.sparkKey) kpiDefs.push({ sparkKey: k.sparkKey, color: k.color }); });
    requestAnimationFrame(() => {
      $$('.kpi-spark[data-spark]').forEach((spark) => {
        const key = spark.getAttribute('data-spark');
        const series = state.sparkReqHistory.map((s) => s[key] || 0);
        spark.innerHTML = renderSparkline(series, getSparkColor(key));
      });
    });
  }

  /* Render a small sparkline SVG given an array of values */
  function renderSparkline(values, color = '#2563EB') {
    if (!values || values.length === 0) {
      return '<svg viewBox="0 0 100 32" preserveAspectRatio="none"><path d="M0,16 L100,16" stroke="var(--border)" stroke-width="1" fill="none" stroke-dasharray="2,2"/></svg>';
    }
    const w = 100, h = 32, pad = 2;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
    const points = values.map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (h - pad * 2) * (1 - (v - min) / range);
      return `${x},${y}`;
    });
    const pathD = points.length > 0 ? `M${points.join(' L')}` : '';
    const areaD = points.length > 0
      ? `M${pad},${h - pad} L${points.join(' L')} L${pad + (values.length - 1) * stepX},${h - pad} Z`
      : '';
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="spark-grad-${color.replace('#', '')}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#spark-grad-${color.replace('#', '')})" />
      <path d="${pathD}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }

  const kpiDefs = [];

  function getSparkColor(key) {
    const def = kpiDefs.find((k) => k.sparkKey === key);
    return def ? def.color : '#2563EB';
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 8 — Charts (Chart.js)
     ══════════════════════════════════════════════════════════════════ */
  const reqHistory = [];
  const latencyBuckets = { '<100ms': 0, '100-300ms': 0, '300-1000ms': 0, '>1000ms': 0 };
  const LATENCY_COLORS = ['#10B981', '#2563EB', '#F59E0B', '#EF4444'];
  const LATENCY_BUCKET_KEYS = ['<100ms', '100-300ms', '300-1000ms', '>1000ms'];

  function initCharts() {
    if (typeof Chart === 'undefined') return;

    const reqCtx = $('#chart-requests');
    if (reqCtx) {
      state.chartReq = new Chart(reqCtx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: 'Requests',
            data: [],
            borderColor: '#2563EB',
            backgroundColor: (ctx) => {
              const c = ctx.chart.ctx.createLinearGradient(0, 0, 0, 200);
              c.addColorStop(0, 'rgba(37, 99, 235, 0.14)');
              c.addColorStop(1, 'rgba(37, 99, 235, 0)');
              return c;
            },
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: '#2563EB',
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2,
            borderWidth: 2,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              titleColor: '#fff',
              bodyColor: '#CBD5E1',
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1,
              padding: 10,
              cornerRadius: 8,
              displayColors: false,
              titleFont: { weight: '600' },
              callbacks: {
                title: (items) => {
                  if (!items || items.length === 0) return '';
                  const idx = items[0].dataIndex;
                  const secondsAgo = (29 - idx) * 2;
                  if (secondsAgo === 0) return 'Now';
                  if (secondsAgo < 60) return `${secondsAgo}s ago`;
                  return `${Math.floor(secondsAgo / 60)}m ${secondsAgo % 60}s ago`;
                },
                label: (ctx) => `${ctx.parsed.y} request${ctx.parsed.y === 1 ? '' : 's'}`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false, drawBorder: false },
              ticks: { display: false },
            },
            y: {
              beginAtZero: true,
              grid: { color: 'rgba(226, 232, 240, 0.5)', drawBorder: false, drawTicks: false },
              ticks: { display: false, padding: 6 },
            },
          },
          animation: { duration: 250 },
        },
      });
    }

    const latCtx = $('#chart-latency');
    if (latCtx) {
      state.chartLat = new Chart(latCtx, {
        type: 'doughnut',
        data: {
          labels: LATENCY_BUCKET_KEYS,
          datasets: [{
            data: [0, 0, 0, 0],
            backgroundColor: LATENCY_COLORS,
            borderColor: '#FFFFFF',
            borderWidth: 2,
            hoverOffset: 6,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '72%',
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              titleColor: '#fff',
              bodyColor: '#CBD5E1',
              padding: 10,
              cornerRadius: 8,
              displayColors: false,
              titleFont: { weight: '600' },
              callbacks: {
                label: (ctx) => {
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct = total === 0 ? 0 : Math.round((ctx.parsed / total) * 100);
                  return `${ctx.label}: ${ctx.parsed} req (${pct}%)`;
                },
              },
            },
          },
          animation: { duration: 300 },
        },
      });
    }
  }

  function updateCharts(entry) {
    if (!entry) return;

    const now = Date.now();
    const ts = new Date(entry.timestamp).getTime();
    reqHistory.push(ts);
    while (reqHistory.length > 0 && reqHistory[0] < now - 60000) reqHistory.shift();

    if (state.chartReq) {
      const bucketSize = 2000;
      const buckets = [];
      for (let t = now - 60000; t <= now; t += bucketSize) {
        const count = reqHistory.filter((v) => v >= t && v < t + bucketSize).length;
        buckets.push(count);
      }
      state.chartReq.data.labels = buckets.map(() => '');
      state.chartReq.data.datasets[0].data = buckets;
      state.chartReq.update('none');
    }

    const lat = entry.latencyMs || 0;
    if (lat < 100) latencyBuckets['<100ms']++;
    else if (lat < 300) latencyBuckets['100-300ms']++;
    else if (lat < 1000) latencyBuckets['300-1000ms']++;
    else latencyBuckets['>1000ms']++;

    if (state.chartLat) {
      state.chartLat.data.datasets[0].data = [
        latencyBuckets['<100ms'],
        latencyBuckets['100-300ms'],
        latencyBuckets['300-1000ms'],
        latencyBuckets['>1000ms'],
      ];
      state.chartLat.update('none');
    }

    renderLatencyLegend();
  }

  function renderLatencyLegend() {
    const el = $('#latency-legend');
    if (!el) return;
    const counts = LATENCY_BUCKET_KEYS.map((k) => latencyBuckets[k]);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) { el.innerHTML = ''; return; }
    el.innerHTML = LATENCY_BUCKET_KEYS.map((k, i) => {
      const c = counts[i];
      if (c === 0) return '';
      return `<span class="latency-legend-item">
        <span class="latency-legend-swatch" style="background:${LATENCY_COLORS[i]}"></span>
        ${escapeHtml(k)}<span class="latency-legend-count">${c}</span>
      </span>`;
    }).filter(Boolean).join('');
  }

  function updateLatencyCenter(p95Ms) {
    const label = $('#latency-center-label');
    const value = $('#latency-center-value');
    if (label) label.textContent = 'P95';
    if (value) {
      if (!Number.isFinite(p95Ms) || p95Ms <= 0) {
        value.innerHTML = '—';
      } else if (p95Ms < 1000) {
        value.innerHTML = `${Math.round(p95Ms)}<span class="donut-unit"> ms</span>`;
      } else {
        value.innerHTML = `${(p95Ms / 1000).toFixed(1)}<span class="donut-unit"> s</span>`;
      }
    }
  }

  function updateLatencyWarning(p95Ms, total) {
    const el = $('#latency-warning');
    if (!el) return;
    if (total < 5) { el.classList.add('hidden'); return; }
    if (p95Ms > 5000) {
      $('#latency-warning-text').textContent = 'Most requests are slower than 5 seconds. Investigate provider quota or model speed.';
      el.classList.remove('hidden');
    } else if (p95Ms > 2000) {
      $('#latency-warning-text').textContent = 'P95 latency is high. Check provider performance.';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  /* ── Empty state management (mutually exclusive) ─────────────── */
  function updateChartEmptyStates() {
    const hasReqData = reqHistory.length > 0;
    const hasLatData = Object.values(latencyBuckets).some((v) => v > 0);

    const reqWrap = $('#chart-requests-wrap');
    const reqEmpty = $('#chart-requests-empty');
    if (reqWrap) reqWrap.style.display = hasReqData ? '' : 'none';
    if (reqEmpty) reqEmpty.classList.toggle('hidden', hasReqData);

    const latWrap = $('#chart-latency-wrap');
    const latLegend = $('#latency-legend');
    const latWarn = $('#latency-warning');
    const latEmpty = $('#chart-latency-empty');
    if (latWrap) latWrap.style.display = hasLatData ? '' : 'none';
    if (latLegend) latLegend.style.display = hasLatData ? '' : 'none';
    if (latWarn) latWarn.style.display = hasLatData ? '' : 'none';
    if (latEmpty) latEmpty.classList.toggle('hidden', hasLatData);
  }

  /* Wire up empty-state buttons */
  ['empty-playground', 'empty-test'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => switchView('playground'));
  });
  const emptyCopyCurl = $('#empty-copy-curl');
  if (emptyCopyCurl) {
    emptyCopyCurl.addEventListener('click', () => {
      copyCurlToClipboard('cURL');
      toast('cURL copied to clipboard', 'ok', 'Copied');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 9 — Stats Overview
     ══════════════════════════════════════════════════════════════════ */
  function captureSparkSnapshot(stats) {
    if (!stats || !stats.overall) return;
    state.sparkReqHistory.push({ ...stats.overall, t: Date.now() });
    if (state.sparkReqHistory.length > 30) state.sparkReqHistory.shift();
  }

  function applyStats(stats) {
    state.lastStats = stats;
    captureSparkSnapshot(stats);
    renderKpiCards('#kpi-grid', stats.overall);
    renderModelTable(stats.perModel);
    renderAlerts(stats);
    renderLatestFailures();
    renderGatewayRoutes();
    updateLatencyCenter(stats.overall.p95LatencyMs);
    updateLatencyWarning(stats.overall.p95LatencyMs, stats.overall.totalRequests);
    updateChartEmptyStates();
    renderSetupChecklist();
  }

  /* ── Operational alerts (driven by stats) ──────────────────── */
  function renderAlerts(stats) {
    const stack = $('#alert-stack');
    if (!stack) return;
    const o = stats.overall || {};
    const perModel = stats.perModel || [];
    const alerts = [];

    if ((o.totalRequests || 0) > 0) {
      const errRate = o.errorRate || 0;
      const errs = o.errorCount || 0;

      if (errRate >= 20) {
        const topFailing = perModel
          .filter((m) => (m.errorCount || 0) > 0)
          .sort((a, b) => (b.errorCount / b.requestCount) - (a.errorCount / a.requestCount))[0];
        const failingName = topFailing ? `<code>${escapeHtml(topFailing.model)}</code>` : 'unknown models';
        alerts.push({
          severity: 'error',
          title: 'High failure rate detected',
          desc: `${errs} of ${o.totalRequests} requests failed. Most failures are from ${failingName}.`,
          actions: [
            { label: 'View Errors', kind: 'outline', action: () => switchView('requests') },
            { label: 'Open Model Router', kind: 'outline', action: () => switchView('models') },
          ],
        });
      } else if (errRate >= 5) {
        alerts.push({
          severity: 'warn',
          title: 'Elevated error rate',
          desc: `${errs} of ${o.totalRequests} requests failed (${fmt.pct(errRate)}). Review recent errors.`,
          actions: [
            { label: 'View Errors', kind: 'outline', action: () => switchView('requests') },
          ],
        });
      }

      const p95 = o.p95LatencyMs || 0;
      if (p95 >= 5000) {
        alerts.push({
          severity: 'error',
          title: 'Provider latency is very high',
          desc: `P95 latency is ${fmt.ms(p95)}. Check provider quota, model speed, or retry policy.`,
          actions: [
            { label: 'Run Diagnostic', kind: 'primary', action: () => { switchView('diagnostics'); setTimeout(() => $('#diag-run')?.click(), 250); } },
          ],
        });
      } else if (p95 >= 2000) {
        alerts.push({
          severity: 'warn',
          title: 'Provider latency is high',
          desc: `P95 latency is ${fmt.ms(p95)}. Check provider performance.`,
          actions: [
            { label: 'Run Diagnostic', kind: 'outline', action: () => { switchView('diagnostics'); setTimeout(() => $('#diag-run')?.click(), 250); } },
          ],
        });
      }
    }

    if (!state.lastConfig?.apiKeySet) {
      alerts.push({
        severity: 'error',
        title: 'Provider API key is missing',
        desc: 'No upstream API key configured. The gateway will reject upstream requests until set.',
        actions: [
          { label: 'Open Settings', kind: 'primary', action: () => switchView('settings') },
        ],
      });
    } else if (!state.lastConfig?.defaultModel) {
      alerts.push({
        severity: 'warn',
        title: 'No default model configured',
        desc: 'Set a default model so unknown client models can fall back gracefully.',
        actions: [
          { label: 'Open Model Router', kind: 'outline', action: () => switchView('models') },
        ],
      });
    }

    stack.innerHTML = alerts.map((a) => {
      const iconMap = {
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      };
      const actionsHtml = (a.actions || []).map((act) =>
        `<button class="btn btn-${act.kind === 'primary' ? 'primary' : 'outline'} btn-sm" type="button">${escapeHtml(act.label)}</button>`
      ).join('');
      return `<div class="alert-row severity-${a.severity}">
        <span class="alert-icon">${iconMap[a.severity] || iconMap.info}</span>
        <div class="alert-content">
          <div class="alert-title">${escapeHtml(a.title)}</div>
          <div class="alert-desc">${a.desc}</div>
        </div>
        <div class="alert-actions" data-alert-actions>${actionsHtml}</div>
      </div>`;
    }).join('');

    /* Wire up alert action buttons */
    Array.from(stack.children).forEach((row, idx) => {
      const a = alerts[idx];
      if (!a || !a.actions) return;
      const btns = row.querySelectorAll('[data-alert-actions] button');
      btns.forEach((btn, i) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          a.actions[i].action?.();
        });
      });
    });
  }

  /* ── Latest Failures (groups recent errors by signature) ────── */
  function renderLatestFailures() {
    const ul = $('#failure-list');
    if (!ul) return;
    const buffer = state.requestBuffer || [];
    const errs = buffer.filter((r) => (r.status || 0) >= 400);
    if (errs.length === 0) {
      ul.innerHTML = '<li class="failure-empty">No failures recorded yet.</li>';
      return;
    }

    /* Group by status + resolvedModel signature */
    const groups = new Map();
    for (const e of errs) {
      const model = e.resolvedModel || e.clientModel || '(unknown)';
      const sig = `${e.status}|${model}`;
      const cur = groups.get(sig) || { status: e.status, model, count: 0, latest: 0, endpoint: e.endpoint, error: e.error };
      cur.count += 1;
      const t = new Date(e.timestamp).getTime();
      if (t > cur.latest) { cur.latest = t; cur.error = e.error; }
      groups.set(sig, cur);
    }
    const top = Array.from(groups.values()).sort((a, b) => b.count - a.count).slice(0, 4);

    ul.innerHTML = top.map((g) => {
      const status = g.status || 0;
      const title = statusLabel(status);
      const fix = failureFix(g);
      const action = failureAction(g);
      return `<li class="failure-item">
        <div class="failure-icon">${failureIcon()}</div>
        <div class="failure-content">
          <div class="failure-title">${escapeHtml(title)} — <code>${escapeHtml(g.model)}</code></div>
          <div class="failure-meta">
            <span>${g.count} request${g.count === 1 ? '' : 's'} failed</span>
            <span>·</span>
            <span>${fmt.relativeTime(new Date(g.latest).toISOString())}</span>
          </div>
          <div class="failure-fix"><strong style="color:var(--text)">Suggested fix:</strong> ${escapeHtml(fix)}</div>
        </div>
        <button class="btn btn-outline btn-sm failure-action" type="button">${escapeHtml(action.label)}</button>
      </li>`;
    }).join('');

    /* Wire action buttons */
    Array.from(ul.querySelectorAll('.failure-item')).forEach((li, i) => {
      const btn = li.querySelector('.failure-action');
      if (btn) btn.addEventListener('click', () => top[i].action.fn());
    });

    function failureIcon() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    }
    function failureFix(g) {
      const s = g.status;
      if (s === 401) return 'Check upstream API key in Settings → Provider Connection.';
      if (s === 403) return 'API key lacks access to this model. Try Sync Models.';
      if (s === 404) return 'Model name is unknown. Update Model Router mapping.';
      if (s === 429) return 'Rate limited. Wait, reduce frequency, or upgrade plan.';
      if (s >= 500) return 'Provider error. Retry after a short delay.';
      if (s === 0) return 'Request timed out. Increase timeout in Settings → Limits.';
      return 'Review the latest error message and provider response.';
    }
    function failureAction(g) {
      const s = g.status;
      if (s === 404) return { label: 'Fix Mapping', fn: () => switchView('models') };
      if (s === 401 || s === 403) return { label: 'Open Settings', fn: () => switchView('settings') };
      if (s === 429) return { label: 'View Errors', fn: () => switchView('requests') };
      return { label: 'View Requests', fn: () => switchView('requests') };
    }
  }

  /* ── Gateway Routes (static list of active endpoints) ────────── */
  function renderGatewayRoutes() {
    const ul = $('#route-list');
    if (!ul) return;
    const base = `${location.protocol}//${location.host}`;
    const routes = [
      { path: '/v1/messages', desc: 'Claude compatible', full: `${base}/v1/messages` },
      { path: '/v1/chat/completions', desc: 'OpenAI compatible', full: `${base}/v1/chat/completions` },
      { path: '/v1/models', desc: 'Model list', full: `${base}/v1/models` },
      { path: '/health', desc: 'Health check', full: `${base}/health` },
    ];
    ul.innerHTML = routes.map((r) => `
      <li class="route-item">
        <span class="route-path">${escapeHtml(r.path)}</span>
        <span class="route-desc">${escapeHtml(r.desc)}</span>
        <span class="route-status">Active</span>
        <button class="route-copy" data-copy="${escapeAttr(r.full)}" aria-label="Copy ${escapeAttr(r.path)}" title="Copy URL">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </li>
    `).join('');
    ul.querySelectorAll('.route-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-copy') || '';
        navigator.clipboard?.writeText(text).then(() => {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        });
      });
    });
  }

  /* ── View all failures (link to requests page) ───────────────── */
  const viewAllFailures = $('#view-all-failures');
  if (viewAllFailures) viewAllFailures.addEventListener('click', () => switchView('requests'));

  function renderModelTable(rows) {
    const tbody = $('#model-tbody');
    if (!rows || rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty-row">No data yet</td></tr>';
      return;
    }
    const search = (state.modelFilter?.search || '').toLowerCase().trim();
    const status = state.modelFilter?.status || 'all';

    let filtered = rows.map((r) => {
      const errRate = r.requestCount === 0 ? 0 : (r.errorCount / r.requestCount) * 100;
      let statusKey = 'healthy';
      if (r.requestCount === 0) statusKey = 'unknown';
      else if (errRate >= 20) statusKey = 'failing';
      else if (r.avgLatencyMs >= 5000) statusKey = 'slow';
      else if (errRate >= 5) statusKey = 'failing';
      return { ...r, errorRate: errRate, statusKey, successCount: r.requestCount - r.errorCount };
    });

    if (search) filtered = filtered.filter((r) => r.model.toLowerCase().includes(search));
    if (status !== 'all') filtered = filtered.filter((r) => r.statusKey === status);

    const sorted = sortRows(filtered, state.sort);
    if (sorted.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty-row">No models match the current filter.</td></tr>';
      return;
    }

    tbody.innerHTML = sorted.map((r) => {
      const statusBadge = (() => {
        const map = {
          healthy: '<span class="badge badge-success">Healthy</span>',
          failing: '<span class="badge badge-error">Failing</span>',
          slow: '<span class="badge badge-warning">Slow</span>',
          unknown: '<span class="badge badge-muted">Unknown</span>',
        };
        return map[r.statusKey] || map.unknown;
      })();
      const errRate = r.errorRate.toFixed(1);
      const errRateColor = r.errorRate >= 5 ? 'var(--err-text)' : r.errorRate >= 1 ? 'var(--warn-text)' : 'var(--text-secondary)';
      return `<tr>
        <td class="model-cell"><code>${escapeHtml(r.model)}</code></td>
        <td class="num provider-cell"><code>${escapeHtml(r.model)}</code></td>
        <td class="num">${fmt.n(r.requestCount)}</td>
        <td class="num hide-sm">${fmt.n(r.successCount)}</td>
        <td class="num">${r.errorCount > 0 ? `<span class="badge badge-error">${fmt.n(r.errorCount)}</span>` : `<span style="color:var(--text-muted)">${fmt.n(0)}</span>`}</td>
        <td class="num hide-sm" style="color:${errRateColor}">${errRate}%</td>
        <td class="num hide-sm">${fmt.n(r.inputTokens)}</td>
        <td class="num hide-sm">${fmt.n(r.outputTokens)}</td>
        <td class="num">${fmt.n(r.avgLatencyMs)} ms</td>
        <td class="hide-sm">${statusBadge}</td>
        <td class="col-action">
          <div class="row-actions">
            <button class="icon-btn" data-act="view" data-model="${escapeAttr(r.model)}" title="View requests" aria-label="View requests">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <button class="icon-btn" data-act="test" data-model="${escapeAttr(r.model)}" title="Test model" aria-label="Test model">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="icon-btn" data-act="edit" data-model="${escapeAttr(r.model)}" title="Edit mapping" aria-label="Edit mapping">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

    /* Wire action buttons */
    tbody.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.getAttribute('data-act');
        const model = btn.getAttribute('data-model');
        if (act === 'view') switchView('requests');
        else if (act === 'test') {
          switchView('playground');
          setTimeout(() => {
            const m = $('#pg-model');
            if (m) m.value = model;
          }, 250);
        } else if (act === 'edit') switchView('models');
      });
    });
  }

  function sortRows(rows, { key, dir }) {
    const out = [...rows];
    const statusOrder = { healthy: 0, slow: 1, failing: 2, unknown: 3 };
    out.sort((a, b) => {
      let av = a[key], bv = b[key];
      if (key === 'status') { av = statusOrder[a.statusKey] ?? 99; bv = statusOrder[b.statusKey] ?? 99; }
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      return dir === 'asc' ? String(av ?? '').localeCompare(String(bv ?? '')) : String(bv ?? '').localeCompare(String(av ?? ''));
    });
    return out;
  }

  $$('#model-table thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort.key = key; state.sort.dir = key === 'model' || key === 'providerModel' || key === 'status' ? 'asc' : 'desc'; }
      $$('#model-table thead th').forEach((x) => x.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      if (state.lastStats) applyStats(state.lastStats);
    });
  });

  /* ── Model table search & status filter ──────────────────────── */
  const modelSearch = $('#model-search');
  if (modelSearch) {
    modelSearch.addEventListener('input', () => {
      state.modelFilter.search = modelSearch.value;
      if (state.lastStats) renderModelTable(state.lastStats.perModel);
    });
  }
  $$('#model-table').forEach(() => {}); // no-op anchor
  document.querySelectorAll('.seg-control [data-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const status = btn.getAttribute('data-status');
      state.modelFilter.status = status;
      btn.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (state.lastStats) renderModelTable(state.lastStats.perModel);
    });
  });

  async function loadStats() {
    try {
      const stats = await api('GET', '/stats');
      applyStats(stats);
      if (stats.inputPricePerMillion !== undefined) {
        $('#input-price').value = stats.inputPricePerMillion;
        $('#output-price').value = stats.outputPricePerMillion;
      }
    } catch (err) {
      console.error('stats load failed', err);
    }
  }

  const clearStatsBtn = $('#clear-stats');
  if (clearStatsBtn) {
    clearStatsBtn.addEventListener('click', async () => {
      if (!confirm('Reset all metrics and clear the in-memory request history?')) return;
      try {
        await api('POST', '/stats/clear');
        toast('Metrics reset', 'ok', 'Cleared');
        await loadStats();
        state.requestBuffer = [];
        state.sparkReqHistory = [];
        renderRequestSummary();
        renderRequestAlert();
        renderRequestTable();
        populateModelFilter();
        reqHistory.length = 0;
        Object.keys(latencyBuckets).forEach((k) => (latencyBuckets[k] = 0));
        if (state.chartReq) { state.chartReq.data.datasets[0].data = []; state.chartReq.update('none'); }
        if (state.chartLat) { state.chartLat.data.datasets[0].data = [0, 0, 0, 0]; state.chartLat.update('none'); }
        renderLatencyLegend();
        updateLatencyCenter(0);
        updateLatencyWarning(0, 0);
        if (state.lastStats) {
          renderAlerts(state.lastStats);
          renderLatestFailures();
        }
        updateChartEmptyStates();
      } catch (err) {
        toast(err.message, 'error', 'Reset failed');
      }
    });
  }

  /* ── Pricing inputs ──────────────────────────────────────────────── */
  ['input-price', 'output-price'].forEach((id) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener('change', async () => {
      try {
        const patch = id === 'input-price'
          ? { inputPricePerMillion: Number(el.value) }
          : { outputPricePerMillion: Number(el.value) };
        await api('PUT', '/config', patch);
        await loadStats();
      } catch (err) { toast(err.message, 'error', 'Update failed'); }
    });
  });

  /* ══════════════════════════════════════════════════════════════════
     SECTION 10 — Setup Checklist
     ══════════════════════════════════════════════════════════════════ */
  async function renderSetupChecklist() {
    const el = $('#setup-checklist');
    const summary = $('#setup-summary');
    if (!el) return;

    const cfg = state.lastConfig || {};
    const checks = [
      { label: 'Gateway running', hint: 'Server is up', ok: true, value: true },
      { label: 'Provider API key configured', hint: 'Set in Settings', ok: !!cfg.apiKeySet, value: cfg.apiKeySet },
      { label: 'Default model set', hint: cfg.defaultModel || 'Configure in Settings', ok: !!cfg.defaultModel, value: !!cfg.defaultModel },
      { label: 'Provider models synced', hint: 'Sync via Model Router', ok: state.availableModels.length > 0, value: state.availableModels.length > 0 },
      { label: 'Run a Playground test', hint: 'Verify end-to-end', ok: (state.lastStats?.overall?.totalRequests || 0) > 0, value: (state.lastStats?.overall?.totalRequests || 0) > 0 },
      { label: 'Connect a coding tool', hint: 'See Command Palette', ok: (state.lastStats?.overall?.totalRequests || 0) > 0, value: (state.lastStats?.overall?.totalRequests || 0) > 0 },
    ];

    const passed = checks.filter((c) => c.ok).length;
    const total = checks.length;
    const pct = Math.round((passed / total) * 100);
    const progressEl = $('#checklist-progress');
    if (progressEl) progressEl.style.width = `${pct}%`;

    if (summary) {
      summary.textContent = passed === total
        ? `Setup complete · ${passed} / ${total} checks passed`
        : `${passed} / ${total} checks passed`;
    }

    el.innerHTML = checks.map((c) => {
      let iconSvg = '';
      if (c.value) {
        iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      } else {
        iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/></svg>';
      }
      return `<li class="checklist-item ${c.value ? 'completed' : ''} stagger-item">
        <span class="check-icon ${c.value ? 'pass' : 'pending'}">${iconSvg}</span>
        <div style="flex:1; min-width:0">
          <div class="checklist-label">${escapeHtml(c.label)}</div>
          <div class="checklist-hint">${escapeHtml(c.hint)}</div>
        </div>
      </li>`;
    }).join('');

    /* Auto-collapse if all checks pass and user hasn't chosen otherwise */
    if (passed === total) {
      const saved = (() => { try { return localStorage.getItem(SETUP_COLLAPSE_KEY); } catch { return null; } })();
      if (saved !== '0') setSetupCollapsed(true);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 11 — Gateway Info Panel
     ══════════════════════════════════════════════════════════════════ */
  async function renderGatewayInfo() {
    const el = $('#gateway-info');
    if (!el) return;

    let version = '—';
    let nodeVer = '—';
    let uptime = '—';
    let envName = '—';
    try {
      const health = await fetch('/health').then((r) => r.json());
      version = health.version || '1.0.0';
      nodeVer = health.nodeVersion || '—';
      uptime = health.uptime ? `${Math.round(health.uptime)}s` : '—';
      envName = health.env || state.lastConfig?.nodeEnv || 'local';
    } catch { /* ignore */ }

    const cfg = state.lastConfig || {};
    const defaultModel = cfg.defaultModel || '—';

    el.innerHTML = `
      <div class="info-row stagger-item"><span class="info-label">Claude Endpoint</span><span class="info-value"><code>/v1/messages</code></span></div>
      <div class="info-row stagger-item"><span class="info-label">OpenAI Endpoint</span><span class="info-value"><code>/v1/chat/completions</code></span></div>
      <div class="info-row stagger-item"><span class="info-label">Models Endpoint</span><span class="info-value"><code>/v1/models</code></span></div>
      <div class="info-row stagger-item"><span class="info-label">Health Endpoint</span><span class="info-value"><code>/health</code></span></div>
      <div class="info-row stagger-item"><span class="info-label">Default Model</span><span class="info-value"><code>${escapeHtml(defaultModel)}</code></span></div>
      <div class="info-row stagger-item"><span class="info-label">Provider</span><span class="info-value">Upstream Provider</span></div>
      <div class="info-row stagger-item"><span class="info-label">Version</span><span class="info-value">v${escapeHtml(version)}</span></div>
      <div class="info-row stagger-item"><span class="info-label">Node.js</span><span class="info-value">${escapeHtml(nodeVer)}</span></div>
      <div class="info-row stagger-item"><span class="info-label">Uptime</span><span class="info-value">${escapeHtml(uptime)}</span></div>
      <div class="info-row stagger-item"><span class="info-label">Environment</span><span class="info-value">${escapeHtml(envName)}</span></div>
    `;
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 12 — Copy Proxy URL
     ══════════════════════════════════════════════════════════════════ */
  function getProxyBase() {
    return `${location.protocol}//${location.host}`;
  }

  function copyCurlToClipboard(label = 'cURL') {
    const curl = `curl -X POST ${getProxyBase()}/v1/messages \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"claude-opus-4-5-20251101","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`;
    navigator.clipboard?.writeText(curl).then(
      () => toast(`${label} copied to clipboard`, 'ok', 'Copied'),
      () => toast('Copy failed', 'error', 'Error')
    );
    return curl;
  }

  const copyProxyBtn = $('#copy-proxy-btn');
  if (copyProxyBtn) {
    copyProxyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(getProxyBase()).then(
        () => toast('Proxy URL copied to clipboard', 'ok', 'Copied'),
        () => toast('Failed to copy', 'error', 'Error')
      );
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 13 — Status Header Actions
     ══════════════════════════════════════════════════════════════════ */
  const headerPlayground = $('#header-playground');
  if (headerPlayground) headerPlayground.addEventListener('click', () => switchView('playground'));

  const headerDiagnostics = $('#header-diagnostics');
  if (headerDiagnostics) {
    headerDiagnostics.addEventListener('click', () => {
      switchView('diagnostics');
      setTimeout(() => $('#diag-run')?.click(), 250);
    });
  }

  const headerCopyProxy = $('#header-copy-proxy');
  if (headerCopyProxy) {
    headerCopyProxy.addEventListener('click', () => {
      navigator.clipboard?.writeText(getProxyBase()).then(
        () => toast('Proxy URL copied to clipboard', 'ok', 'Copied'),
        () => toast('Failed to copy', 'error', 'Error')
      );
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 13b — Collapsible Setup Checklist
     ══════════════════════════════════════════════════════════════════ */
  const setupPanel = $('#setup-panel');
  const setupToggle = $('#setup-toggle');
  const setupBody = $('#setup-body');
  const SETUP_COLLAPSE_KEY = 'fcc-gateway-setup-collapsed';

  function setSetupCollapsed(collapsed) {
    if (!setupPanel || !setupBody || !setupToggle) return;
    setupPanel.classList.toggle('expanded', !collapsed);
    setupBody.classList.toggle('hidden', collapsed);
    setupToggle.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(SETUP_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }
  if (setupToggle) {
    setupToggle.addEventListener('click', () => {
      const expanded = setupPanel?.classList.contains('expanded');
      setSetupCollapsed(!!expanded);
    });
    setupToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setupToggle.click(); }
    });
  }

  /* Apply saved collapse preference once setupPanel exists in DOM */
  if (setupPanel) {
    try {
      const saved = localStorage.getItem(SETUP_COLLAPSE_KEY);
      if (saved === '1') setSetupCollapsed(true);
    } catch { /* ignore */ }
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 14 — Live Request Feed (Compact Production Monitor)
     ══════════════════════════════════════════════════════════════════ */

  /* Latency health classification for cell coloring + side detail. */
  function latencyHealthClass(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'lat-na';
    if (ms < 1000) return 'lat-healthy';
    if (ms < 10000) return 'lat-warn';
    if (ms < 30000) return 'lat-slow';
    return 'lat-critical';
  }
  function latencyHealthLabel(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 1000) return 'healthy';
    if (ms < 10000) return 'slow';
    if (ms < 30000) return 'slow';
    return 'critical';
  }
  function fmtLatencyShort(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }
  function fmtTokensShort(inTok, outTok) {
    const total = (inTok || 0) + (outTok || 0);
    if (total === 0) return '—';
    if (total < 1000) return String(total);
    if (total < 10_000) return `${(total / 1000).toFixed(1)}k`;
    return `${Math.round(total / 1000)}k`;
  }
  function rowSeverityClass(r) {
    if (r.status === 0) return 'row-sev-timeout';
    if (r.status === 429) return 'row-sev-429';
    if (r.status >= 500) return 'row-sev-5xx';
    if (r.status >= 400) return 'row-sev-4xx';
    return 'row-sev-2xx';
  }
  function matchStatusFilter(status, filter) {
    if (filter === 'all') return true;
    if (filter === '2xx') return status >= 200 && status < 300;
    if (filter === '4xx') return status >= 400 && status < 500;
    if (filter === '5xx') return status >= 500;
    if (filter === '429') return status === 429;
    if (filter === 'timeout') return status === 0;
    return true;
  }
  function matchEndpointFilter(endpoint, filter) {
    if (filter === 'all') return true;
    if (filter === 'claude') return (endpoint || '').includes('/v1/messages');
    if (filter === 'openai') return (endpoint || '').includes('/v1/chat/completions');
    if (filter === 'models') return (endpoint || '').includes('/v1/models');
    return true;
  }

  /* Filter the buffer using state.requestFilter */
  function filterRequests() {
    const f = state.requestFilter;
    const search = (f.search || '').toLowerCase().trim();
    if (!search && f.status === 'all' && f.endpoint === 'all' && f.model === 'all' && f.stream === 'all') {
      return state.requestBuffer;
    }
    return state.requestBuffer.filter((r) => {
      if (!matchStatusFilter(r.status, f.status)) return false;
      if (!matchEndpointFilter(r.endpoint, f.endpoint)) return false;
      if (f.model !== 'all') {
        const m = r.resolvedModel || r.clientModel || '';
        if (m !== f.model) return false;
      }
      if (f.stream === 'yes' && !r.streaming) return false;
      if (f.stream === 'no' && r.streaming) return false;
      if (search) {
        const hay = [
          r.id || '',
          r.method || '',
          r.endpoint || '',
          r.clientModel || '',
          r.resolvedModel || '',
          r.provider || '',
          statusLabel(r.status),
        ].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  /* Populate the model filter <select> from the buffer (only top models by frequency) */
  function populateModelFilter() {
    const sel = $('#req-filter-model');
    if (!sel) return;
    const counts = new Map();
    for (const r of state.requestBuffer) {
      const m = r.resolvedModel || r.clientModel;
      if (!m) continue;
      counts.set(m, (counts.get(m) || 0) + 1);
    }
    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30);
    const current = state.requestFilter.model;
    const opts = ['<option value="all">All Models</option>']
      .concat(top.map(([m, c]) => `<option value="${escapeAttr(m)}">${escapeHtml(m)} · ${c}</option>`));
    sel.innerHTML = opts.join('');
    if (current && (current === 'all' || counts.has(current))) sel.value = current;
  }

  /* Render the compact horizontal summary bar with 7 stats */
  function renderRequestSummary() {
    const el = $('#req-summary-bar');
    if (!el) return;
    const buf = state.requestBuffer;
    const total = buf.length;

    if (total === 0) {
      el.innerHTML = `
        <div class="summary-stat"><div class="summary-stat-label">Total</div><div class="summary-stat-value">0</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Success</div><div class="summary-stat-value">0</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Errors</div><div class="summary-stat-value">0</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Error Rate</div><div class="summary-stat-value">—</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Median</div><div class="summary-stat-value">—</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Tokens</div><div class="summary-stat-value">0</div></div>
        <div class="summary-stat"><div class="summary-stat-label">Req/min</div><div class="summary-stat-value">0</div></div>
      `;
      return;
    }

    const errors = buf.filter((r) => r.status >= 400).length;
    const success = total - errors;
    const errRate = (errors / total) * 100;

    /* Latency distribution — sort, take 50th & 95th percentiles */
    const lats = buf.map((r) => r.latencyMs || 0).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const sampleNote = lats.length < 5;
    function pct(arr, p) {
      if (arr.length === 0) return 0;
      const i = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
      return arr[i];
    }
    const median = pct(lats, 50);
    const p95 = pct(lats, 95);

    /* Tokens */
    const inTok = buf.reduce((s, r) => s + (r.inputTokens || 0), 0);
    const outTok = buf.reduce((s, r) => s + (r.outputTokens || 0), 0);
    const totalTok = inTok + outTok;

    /* Req/min (last 60s) */
    const now = Date.now();
    const recent = buf.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return Number.isFinite(t) && (now - t) <= 60_000;
    }).length;

    const errTone = errRate >= 20 ? 'bad' : errRate >= 5 ? 'warn' : 'good';
    const medTone = sampleNote ? '' : median >= 10000 ? 'bad' : median >= 1000 ? 'warn' : 'good';
    const medDisplay = sampleNote ? '—' : fmtLatencyShort(median);
    const medHint = sampleNote ? 'few samples' : `${buf.length} samples`;
    const rpmTone = recent === 0 ? '' : recent < 5 ? '' : 'good';

    el.innerHTML = `
      <div class="summary-stat">
        <div class="summary-stat-label">Total</div>
        <div class="summary-stat-value">${fmt.n(total)}</div>
      </div>
      <div class="summary-stat tone-good">
        <div class="summary-stat-label"><span class="summary-stat-dot"></span>Success</div>
        <div class="summary-stat-value">${fmt.n(success)}</div>
      </div>
      <div class="summary-stat ${errors > 0 ? 'tone-bad' : 'tone-good'}">
        <div class="summary-stat-label"><span class="summary-stat-dot"></span>Errors</div>
        <div class="summary-stat-value">${fmt.n(errors)}</div>
      </div>
      <div class="summary-stat ${errTone ? 'tone-' + errTone : ''}">
        <div class="summary-stat-label">Error Rate</div>
        <div class="summary-stat-value">${errRate.toFixed(1)}<span class="summary-stat-suffix">%</span></div>
      </div>
      <div class="summary-stat ${medTone ? 'tone-' + medTone : ''}" title="${medHint}">
        <div class="summary-stat-label">Median</div>
        <div class="summary-stat-value">${medDisplay}</div>
      </div>
      <div class="summary-stat">
        <div class="summary-stat-label">Tokens</div>
        <div class="summary-stat-value">${totalTok < 1000 ? fmt.n(totalTok) : fmtTokensShort(inTok, outTok)}<span class="summary-stat-suffix">${totalTok >= 1000 ? 'in+out' : ''}</span></div>
      </div>
      <div class="summary-stat ${rpmTone ? 'tone-' + rpmTone : ''}">
        <div class="summary-stat-label">Req/min</div>
        <div class="summary-stat-value">${fmt.n(recent)}<span class="summary-stat-suffix">/ 60s</span></div>
      </div>
    `;
  }

  /* Compact production alert — only when errRate > 20% or 429 present */
  function renderRequestAlert() {
    const stack = $('#req-alert-stack');
    if (!stack) return;
    const buf = state.requestBuffer;
    if (buf.length === 0) { stack.innerHTML = ''; return; }
    const total = buf.length;
    const errors = buf.filter((r) => r.status >= 400).length;
    const errRate = (errors / total) * 100;
    const has429 = buf.some((r) => r.status === 429);

    if (errRate < 20 && !has429) { stack.innerHTML = ''; return; }

    let severity, title, desc;
    if (errRate >= 20) {
      severity = 'error';
      title = 'High failure rate detected';
      desc = `${fmt.n(errors)} of ${fmt.n(total)} requests failed (${errRate.toFixed(1)}%). Review the most recent errors below.`;
    } else if (has429) {
      severity = 'warn';
      title = 'Rate limiting detected';
      desc = `At least one request received a 429. The provider is throttling — consider reducing request frequency or upgrading your plan.`;
    } else {
      return;
    }

    const icon = severity === 'error'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

    stack.innerHTML = `<div class="alert-row severity-${severity}">
      <span class="alert-icon">${icon}</span>
      <div class="alert-content">
        <div class="alert-title">${escapeHtml(title)}</div>
        <div class="alert-desc">${desc}</div>
      </div>
      <div class="alert-actions">
        <button class="btn btn-outline btn-sm" type="button" data-alert-act="filter-errors">Show errors only</button>
        <button class="btn btn-outline btn-sm" type="button" data-alert-act="diagnostic">Run diagnostic</button>
      </div>
    </div>`;

    const errBtn = stack.querySelector('[data-alert-act="filter-errors"]');
    if (errBtn) errBtn.addEventListener('click', () => {
      const sel = $('#req-filter-status');
      if (sel) {
        sel.value = errRate >= 20 ? '5xx' : '429';
        sel.dispatchEvent(new Event('change'));
      }
    });
    const diagBtn = stack.querySelector('[data-alert-act="diagnostic"]');
    if (diagBtn) diagBtn.addEventListener('click', () => {
      switchView('diagnostics');
      setTimeout(() => $('#diag-run')?.click(), 250);
    });
  }

  /* Render the Live Request Feed table with new column order + severity + filters */
  function renderRequestTable() {
    const tbody = $('#request-tbody');
    const emptyEl = $('#request-empty');
    if (!tbody) return;

    if (state.requestBuffer.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    const filtered = filterRequests();
    if (filtered.length === 0) {
      const f = state.requestFilter;
      const isFiltered = f.search || f.status !== 'all' || f.endpoint !== 'all' || f.model !== 'all' || f.stream !== 'all';
      tbody.innerHTML = `<tr><td colspan="10" class="empty-row">
        <div class="in-table-empty">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </div>
          <h4>No requests match these filters</h4>
          <p>${escapeHtml(isFiltered ? 'Try clearing one of the filters above to see more results.' : '')}</p>
          <div class="empty-actions">
            <button class="btn btn-outline btn-sm" type="button" data-clear-filters>Clear filters</button>
          </div>
        </div>
      </td></tr>`;
      const clr = tbody.querySelector('[data-clear-filters]');
      if (clr) clr.addEventListener('click', clearRequestFilters);
      return;
    }

    tbody.innerHTML = filtered.map((r) => {
      const lat = r.latencyMs || 0;
      const latClass = latencyHealthClass(lat);
      const latHealth = latencyHealthLabel(lat);
      const inTok = r.inputTokens || 0;
      const outTok = r.outputTokens || 0;
      const totalTok = inTok + outTok;
      const hasTokens = totalTok > 0;
      const endpointShort = fmt.shortPath(r.endpoint);
      const method = r.method || 'POST';
      const isClaude = (r.endpoint || '').includes('/v1/messages');
      const isOpenAI = (r.endpoint || '').includes('/v1/chat/completions');
      const endpointClass = isClaude ? 'claude' : isOpenAI ? 'openai' : 'other';
      return `<tr class="${rowSeverityClass(r)}" data-id="${escapeAttr(r.id || '')}">
        <td class="col-time">${escapeHtml(fmt.time(r.timestamp))}</td>
        <td class="col-status">
          <span class="status-pill ${statusClass(r.status)}" title="${statusLabel(r.status)}">${r.status || '—'}</span>
        </td>
        <td class="col-endpoint ${endpointClass}"><code>${escapeHtml(endpointShort)}</code></td>
        <td class="col-model ${r.clientModel ? '' : 'empty'}">${escapeHtml(r.clientModel || '—')}</td>
        <td class="col-model mono">${escapeHtml(r.resolvedModel || '—')}</td>
        <td class="col-provider"><span class="mapping-provider-badge">${escapeHtml(r.provider || 'upstream')}</span>${r.cascadedToBackup ? '<span class="badge badge-warning" style="margin-left:4px;font-size:10px" title="Primary model was rate-limited or overloaded — request served by backup model">↻ backup</span>' : ''}</td>
        <td class="col-tokens num">${hasTokens ? fmtTokensShort(inTok, outTok) : '—'}${hasTokens ? `<span class="col-tokens-detail">${fmt.n(inTok)} in · ${fmt.n(outTok)} out</span>` : ''}</td>
        <td class="col-latency ${latClass} num">${fmtLatencyShort(lat)}${latHealth ? `<span class="col-latency-detail">${latHealth}</span>` : ''}</td>
        <td class="col-stream">${r.streaming ? '<span class="stream-pill">stream</span>' : '<span class="stream-pill no">sync</span>'}</td>
        <td class="col-id"><code title="${escapeAttr(r.id || '')}">${escapeHtml(truncateId(r.id))}</code></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = tr.getAttribute('data-id');
        const entry = state.requestBuffer.find((e) => e.id === id);
        if (entry) openDrawer(entry);
      });
    });
  }

  function clearRequestFilters() {
    state.requestFilter = { search: '', status: 'all', endpoint: 'all', model: 'all', stream: 'all' };
    const search = $('#req-search'); if (search) search.value = '';
    const status = $('#req-filter-status'); if (status) status.value = 'all';
    const ep = $('#req-filter-endpoint'); if (ep) ep.value = 'all';
    const model = $('#req-filter-model'); if (model) model.value = 'all';
    const stream = $('#req-filter-stream'); if (stream) stream.value = 'all';
    $$('.filter-select').forEach((s) => s.classList.remove('is-active'));
    renderRequestTable();
  }

  function pushRequestEntry(entry) {
    updateCharts(entry);
    updateChartEmptyStates();

    if (state.paused) {
      state.bufferedEvents.push(entry);
      if (state.bufferedEvents.length > 200) state.bufferedEvents.shift();
      const badge = $('#paused-badge');
      if (badge) { badge.textContent = `${state.bufferedEvents.length} buffered`; badge.classList.remove('hidden'); }
      return;
    }
    state.requestBuffer.unshift(entry);
    if (state.requestBuffer.length > 1000) state.requestBuffer.pop();
    renderRequestSummary();
    renderRequestAlert();
    renderRequestTable();
    populateModelFilter();
    if (state.view === 'overview' && (entry.status || 0) >= 400) {
      renderLatestFailures();
    }
  }

  const pauseBtn = $('#pause-btn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      state.paused = !state.paused;
      const text = $('#pause-text');
      if (state.paused) {
        text.textContent = 'Resume';
        toast('Feed paused — events are buffering', 'warn', 'Paused');
      } else {
        text.textContent = 'Pause';
        const drained = state.bufferedEvents.splice(0, state.bufferedEvents.length);
        for (const e of drained.reverse()) {
          state.requestBuffer.unshift(e);
          if (state.requestBuffer.length > 1000) state.requestBuffer.pop();
        }
        const badge = $('#paused-badge');
        if (badge) badge.classList.add('hidden');
        renderRequestSummary();
        renderRequestAlert();
        renderRequestTable();
        populateModelFilter();
        toast('Feed resumed', 'ok', 'Live');
      }
    });
  }

  /* ── Clear Requests Button ───────────────────────────────────────── */
  const clearRequestsBtn = $('#clear-requests-btn');
  if (clearRequestsBtn) {
    clearRequestsBtn.addEventListener('click', () => {
      if (!confirm('Clear all buffered requests from the live feed?')) return;
      state.requestBuffer = [];
      state.bufferedEvents = [];
      renderRequestSummary();
      renderRequestAlert();
      renderRequestTable();
      populateModelFilter();
      toast('Request buffer cleared', 'ok', 'Cleared');
    });
  }

  /* Empty-state actions for the request feed */
  ['empty-req-playground'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => switchView('playground'));
  });
  const emptyReqClaudeCode = $('#empty-req-claudecode');
  if (emptyReqClaudeCode) {
    emptyReqClaudeCode.addEventListener('click', () => openCopyConfigPanel('claude-code'));
  }
  const emptyReqCurl = $('#empty-req-curl');
  if (emptyReqCurl) {
    emptyReqCurl.addEventListener('click', () => copyCurlToClipboard('cURL test'));
  }

  /* ── Filter toolbar wiring ──────────────────────────────────────── */
  const reqSearch = $('#req-search');
  if (reqSearch) {
    reqSearch.addEventListener('input', () => {
      state.requestFilter.search = reqSearch.value;
      renderRequestTable();
    });
  }
  ['req-filter-status', 'req-filter-endpoint', 'req-filter-model', 'req-filter-stream'].forEach((id) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      const key = id.replace('req-filter-', '');
      state.requestFilter[key] = el.value;
      el.classList.toggle('is-active', el.value !== 'all');
      renderRequestTable();
    });
  });

  /* Initial render of summary + alert (empty state) */
  renderRequestSummary();
  renderRequestAlert();

  async function loadHistoricalRequests() {
    try {
      const data = await api('GET', '/requests');
      if (!data || !data.requests || !data.requests.length) return;
      const entries = data.requests;
      state.requestBuffer = entries;

      const now = Date.now();
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const ts = new Date(e.timestamp).getTime();
        if (Number.isFinite(ts) && now - ts <= 60000) reqHistory.push(ts);
        const lat = e.latencyMs || 0;
        if (lat < 100) latencyBuckets['<100ms']++;
        else if (lat < 300) latencyBuckets['100-300ms']++;
        else if (lat < 1000) latencyBuckets['300-1000ms']++;
        else latencyBuckets['>1000ms']++;
      }
      if (state.chartReq && reqHistory.length > 0) {
        const bucketSize = 2000;
        const buckets = [];
        for (let t = now - 60000; t <= now; t += bucketSize) {
          buckets.push(reqHistory.filter((v) => v >= t && v < t + bucketSize).length);
        }
        state.chartReq.data.labels = buckets.map(() => '');
        state.chartReq.data.datasets[0].data = buckets;
        state.chartReq.update('none');
      }
      if (state.chartLat) {
        state.chartLat.data.datasets[0].data = [
          latencyBuckets['<100ms'], latencyBuckets['100-300ms'],
          latencyBuckets['300-1000ms'], latencyBuckets['>1000ms'],
        ];
        state.chartLat.update('none');
      }
      renderRequestTable();
      renderRequestSummary();
      renderRequestAlert();
      populateModelFilter();
      updateChartEmptyStates();
      renderLatencyLegend();
    } catch (err) {
      console.error('Failed to load historical requests', err);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 15 — SSE (Server-Sent Events)
     ══════════════════════════════════════════════════════════════════ */
  let sseRetryDelay = 1000;
  function connectSSE() {
    const pill = $('#conn-pill');
    const dot = pill ? pill.querySelector('.status-dot') : null;
    const label = pill ? pill.querySelector('span:last-child') : null;
    const sidebarEl = $('#sidebar-status');
    const sidebarDot = sidebarEl ? sidebarEl.querySelector('.status-dot') : null;
    const sidebarLabel = sidebarEl ? sidebarEl.querySelector('span:last-child') : null;

    function setStatus(ok) {
      if (dot) dot.className = ok ? 'status-dot live' : 'status-dot offline';
      if (label) label.textContent = ok ? 'Live' : 'Offline';
      if (sidebarDot) sidebarDot.className = ok ? 'status-dot live' : 'status-dot offline';
      if (sidebarLabel) sidebarLabel.textContent = ok ? 'Gateway Live' : 'Offline';
    }

    const es = new EventSource('/admin/api/events');
    es.onopen = () => { setStatus(true); sseRetryDelay = 1000; };
    es.onerror = () => { setStatus(false); };
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'request' && data.entry) {
          pushRequestEntry(data.entry);
        }
      } catch (err) {
        console.error('sse parse failed', err);
      }
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 16 — Request Detail Drawer (single, no tabs)
     ══════════════════════════════════════════════════════════════════ */
  const drawerOverlay = $('#drawer-overlay');
  const drawerEl = $('#drawer');
  const drawerBody = $('#drawer-body');
  const drawerClose = $('#drawer-close');
  const drawerStatus = $('#drawer-status');
  const drawerSub = $('#drawer-sub');

  function maskAuth(val) {
    if (!val) return '—';
    if (val.length <= 8) return '••••••••';
    return val.slice(0, 4) + '••••' + val.slice(-4);
  }

  function suggestedFix(entry) {
    const s = entry.status;
    if (s === 0) return 'Request timed out before the provider responded. Increase `requestTimeoutMs` in Settings → Limits, or check upstream connectivity.';
    if (s === 401) return 'Authentication failed. Verify your upstream API key in Settings → Provider Connection.';
    if (s === 403) return 'The API key lacks access to this model. Try Sync Models to refresh the available list, or contact your provider.';
    if (s === 404) return 'The model is unknown to the provider. Update the Model Router mapping for this Claude model.';
    if (s === 429) return 'Rate limited by the provider. Wait, reduce request frequency, or upgrade your plan.';
    if (s >= 500) return 'Provider-side error. Retry after a short delay; if it persists, check the provider status page.';
    if (s === 413) return 'Request body too large. Lower `max_tokens` or trim the input in Settings → Limits.';
    if (s === 408) return 'Request timed out server-side. Increase the timeout in Settings → Limits.';
    if (s >= 400) return 'Client-side error. Review the raw error below and the request body sent to the provider.';
    return 'No action needed. The request completed successfully.';
  }

  function openDrawer(entry) {
    const statusPillHtml = `<span class="status-pill ${statusClass(entry.status)}">${entry.status || '—'} ${statusLabel(entry.status)}</span>`;
    if (drawerStatus) drawerStatus.outerHTML = statusPillHtml;
    if (drawerSub) drawerSub.textContent = `${entry.method || 'POST'} ${fmt.shortPath(entry.endpoint)} • ${fmt.relativeTime(entry.timestamp)}`;

    renderDrawerDetails(entry);

    drawerOverlay.classList.remove('hidden');
    drawerEl.classList.remove('hidden');
  }

  /* Render a single, unified request detail view (no tabs) */
  function renderDrawerDetails(entry) {
    let authHeader = '—';
    if (entry.requestHeaders && entry.requestHeaders.authorization) {
      authHeader = maskAuth(entry.requestHeaders.authorization);
    } else if (entry.requestHeaders && entry.requestHeaders['x-api-key']) {
      authHeader = maskAuth(entry.requestHeaders['x-api-key']);
    }
    const inTok = entry.inputTokens || 0;
    const outTok = entry.outputTokens || 0;
    const totalTok = inTok + outTok;
    const isError = (entry.status || 0) >= 400;
    const errMsg = entry.error || (entry.responseBody && (entry.responseBody.error?.message || entry.responseBody.message)) || null;

    const html = `
      <div class="drawer-section">
        <h4>Request Summary</h4>
        <dl class="drawer-kv">
          <dt>Request ID</dt><dd><code>${escapeHtml(entry.id || '—')}</code></dd>
          <dt>Method</dt><dd>${escapeHtml(entry.method || 'POST')}</dd>
          <dt>Endpoint</dt><dd><code>${escapeHtml(fmt.shortPath(entry.endpoint) || '—')}</code></dd>
          <dt>Client IP</dt><dd>${escapeHtml(entry.clientIp || entry.ip || '—')}</dd>
          <dt>Timestamp</dt><dd>${escapeHtml(entry.timestamp || '—')}</dd>
          <dt>Streaming</dt><dd>${entry.streaming ? '<span class="badge badge-info">yes</span>' : '<span style="color:var(--text-muted)">no</span>'}</dd>
          <dt>Authorization</dt><dd><code>${escapeHtml(authHeader)}</code></dd>
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Model Resolution</h4>
        <dl class="drawer-kv">
          <dt>Client Model</dt><dd><code>${escapeHtml(entry.clientModel || '—')}</code></dd>
          <dt>Resolved Model</dt><dd><code>${escapeHtml(entry.resolvedModel || '—')}</code></dd>
          <dt>Provider</dt><dd><span class="mapping-provider-badge">${escapeHtml(entry.provider || 'upstream')}</span></dd>
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Provider Result</h4>
        <dl class="drawer-kv">
          <dt>Status</dt><dd>${entry.status || 0} ${escapeHtml(statusLabel(entry.status))}</dd>
          <dt>Input Tokens</dt><dd>${fmt.n(inTok)}</dd>
          <dt>Output Tokens</dt><dd>${fmt.n(outTok)}</dd>
          <dt>Total Tokens</dt><dd><strong>${fmt.n(totalTok)}</strong></dd>
        </dl>
      </div>
      <div class="drawer-section">
        <h4>Timing</h4>
        <dl class="drawer-kv">
          <dt>Latency</dt><dd>${fmt.ms(entry.latencyMs)} ${latencyHealthLabel(entry.latencyMs) ? `<span style="color:var(--text-muted); font-size:11.5px; margin-left:6px">(${latencyHealthLabel(entry.latencyMs)})</span>` : ''}</dd>
          <dt>Captured</dt><dd>${escapeHtml(fmt.relativeTime(entry.timestamp))}</dd>
        </dl>
      </div>
      ${isError ? `
      <div class="drawer-section">
        <h4>Raw Error</h4>
        ${errMsg ? `<pre class="drawer-raw-error">${escapeHtml(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg, null, 2))}</pre>` : '<p class="help-text">No error message captured.</p>'}
        <div class="drawer-suggestion">
          <strong>Suggested fix</strong>
          ${escapeHtml(suggestedFix(entry))}
        </div>
      </div>
      ` : ''}
    `;
    drawerBody.innerHTML = html;
  }

  function closeDrawer() {
    drawerOverlay.classList.add('hidden');
    drawerEl.classList.add('hidden');
  }

  if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
  if (drawerOverlay) drawerOverlay.addEventListener('click', closeDrawer);

  /* ══════════════════════════════════════════════════════════════════
     SECTION 17 — Command Palette
     ══════════════════════════════════════════════════════════════════ */
  const cmdOverlay = $('#cmd-overlay');
  const cmdInput = $('#cmd-input');
  const cmdList = $('#cmd-list');
  let cmdIdx = 0;

  const ICON_VIEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  const ICON_RUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
  const ICON_TOOLS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>';
  const ICON_DIAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';

  const commands = [
    { section: 'Navigation', label: 'Go to Overview', icon: ICON_VIEW, action: () => switchView('overview') },
    { section: 'Navigation', label: 'Go to Live Requests', icon: ICON_VIEW, action: () => switchView('requests') },
    { section: 'Navigation', label: 'Go to Playground', icon: ICON_VIEW, action: () => switchView('playground') },
    { section: 'Navigation', label: 'Go to Providers', icon: ICON_VIEW, action: () => switchView('providers') },
    { section: 'Navigation', label: 'Go to Model Router', icon: ICON_VIEW, action: () => switchView('models') },
    { section: 'Navigation', label: 'Go to Settings', icon: ICON_VIEW, action: () => switchView('settings') },
    { section: 'Navigation', label: 'Go to Diagnostics', icon: ICON_VIEW, action: () => switchView('diagnostics') },
    { section: 'Actions', label: 'Open Playground', icon: ICON_RUN, action: () => switchView('playground') },
    { section: 'Actions', label: 'Run Full Diagnostic', icon: ICON_DIAG, action: () => { switchView('diagnostics'); setTimeout(() => $('#diag-run')?.click(), 250); } },
    { section: 'Actions', label: 'Test Provider Connection', icon: ICON_RUN, action: () => { switchView('diagnostics'); setTimeout(() => $('#test-connection')?.click(), 250); } },
    { section: 'Actions', label: 'Reset Metrics', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>', action: () => $('#clear-stats')?.click() },
    { section: 'Actions', label: 'Sync Provider Models', icon: ICON_RUN, action: () => { switchView('models'); setTimeout(() => $('#refresh-available')?.click(), 250); } },
    { section: 'Actions', label: 'Save Model Mappings', icon: ICON_COPY, action: () => { switchView('models'); setTimeout(() => $('#save-mappings')?.click(), 250); } },
    { section: 'Copy', label: 'Copy Proxy URL', icon: ICON_COPY, action: () => { navigator.clipboard?.writeText(getProxyBase()); toast('Proxy URL copied', 'ok', 'Copied'); } },
    { section: 'Copy', label: 'Copy cURL Test', icon: ICON_COPY, action: () => copyCurlToClipboard('cURL test') },
    { section: 'Copy', label: 'Copy Claude Code Config', icon: ICON_COPY, action: () => openCopyConfigPanel('claude-code') },
    { section: 'Copy', label: 'Copy Cline Config', icon: ICON_COPY, action: () => openCopyConfigPanel('cline') },
    { section: 'Copy', label: 'Copy Roo Code Config', icon: ICON_COPY, action: () => openCopyConfigPanel('roo-code') },
    { section: 'Copy', label: 'Copy Continue Config', icon: ICON_COPY, action: () => openCopyConfigPanel('continue') },
    { section: 'Copy', label: 'Connect Your Tools…', icon: ICON_TOOLS, action: () => openCopyConfigPanel('claude-code') },
  ];

  let _cmdFiltered = commands;

  function openCmdPalette() {
    cmdOverlay.classList.remove('hidden');
    cmdInput.value = '';
    cmdIdx = 0;
    renderCmdList('');
    setTimeout(() => cmdInput.focus(), 50);
  }
  function closeCmdPalette() { cmdOverlay.classList.add('hidden'); }

  function renderCmdList(query) {
    const q = query.toLowerCase();
    const filtered = commands.filter((c) => c.label.toLowerCase().includes(q) || c.section.toLowerCase().includes(q));
    _cmdFiltered = filtered;
    if (filtered.length === 0) {
      cmdList.innerHTML = '<div class="cmd-empty">No commands found</div>';
      return;
    }
    let lastSection = '';
    cmdList.innerHTML = filtered.map((c, i) => {
      const sectionHeader = c.section !== lastSection ? `<div style="font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); padding:8px 12px 4px">${c.section}</div>` : '';
      lastSection = c.section;
      return sectionHeader + `<div class="cmd-item${i === cmdIdx ? ' active' : ''}" data-idx="${i}"><div class="cmd-item-icon">${c.icon}</div><div class="cmd-item-label">${escapeHtml(c.label)}</div></div>`;
    }).join('');
    cmdList.querySelectorAll('.cmd-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-idx'));
        _cmdFiltered[idx]?.action();
        closeCmdPalette();
      });
    });
  }

  if (cmdInput) {
    cmdInput.addEventListener('input', () => { cmdIdx = 0; renderCmdList(cmdInput.value); });
    cmdInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { cmdIdx = Math.min(cmdIdx + 1, _cmdFiltered.length - 1); renderCmdList(cmdInput.value); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { cmdIdx = Math.max(cmdIdx - 1, 0); renderCmdList(cmdInput.value); e.preventDefault(); }
      else if (e.key === 'Enter') { _cmdFiltered[cmdIdx]?.action(); closeCmdPalette(); }
      else if (e.key === 'Escape') { closeCmdPalette(); }
    });
  }
  if (cmdOverlay) cmdOverlay.addEventListener('click', (e) => { if (e.target === cmdOverlay) closeCmdPalette(); });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openCmdPalette(); }
    if (e.key === 'Escape') { closeCmdPalette(); closeDrawer(); closeCopyConfigPanel(); }
  });

  const searchTrigger = $('#search-trigger');
  if (searchTrigger) {
    searchTrigger.addEventListener('click', () => openCmdPalette());
    searchTrigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCmdPalette(); }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 18 — Config Form
     ══════════════════════════════════════════════════════════════════ */
  async function loadConfig() {
    try {
      const cfg = await api('GET', '/config');
      state.lastConfig = cfg;
      const form = $('#config-form');
      if (!form) return;
      form.elements['bluesmindsBaseUrl'].value = cfg.bluesmindsBaseUrl || '';
      form.elements['defaultModel'].value = cfg.defaultModel || '';
      form.elements['strictModelMapping'].checked = !!cfg.strictModelMapping;
      form.elements['rateLimitPerMinute'].value = cfg.rateLimitPerMinute;
      form.elements['requestTimeoutMs'].value = cfg.requestTimeoutMs;
      form.elements['allowedOrigins'].value = (cfg.allowedOrigins || []).join(', ');
      form.elements['maxBodySize'].value = cfg.maxBodySize || '';
      form.elements['debugLogs'].checked = !!cfg.debugLogs;
      form.elements['bluesmindsApiKey'].value = '';
      form.elements['proxyApiKey'].value = '';
      $('#apikey-set').textContent = cfg.apiKeySet ? '✓ set' : '✗ missing';
      const proxyKeyEl = $('#proxykey-set');
      if (proxyKeyEl) proxyKeyEl.textContent = cfg.proxyApiKeyStatus === 'set' ? '✓ set' : '✗ missing';
      // Update status header model
      const statusModel = $('#status-default-model');
      if (statusModel) statusModel.textContent = cfg.defaultModel || '—';
      // Reset unsaved indicator
      setUnsavedChanges(false);
    } catch (err) {
      toast(`Config load failed: ${err.message}`, 'error', 'Load failed');
    }
  }

  function setUnsavedChanges(unsaved) {
    state.unsavedChanges = unsaved;
    const ind = $('#unsaved-indicator');
    if (ind) ind.classList.toggle('hidden', !unsaved);
  }

  const configForm = $('#config-form');
  if (configForm) {
    configForm.addEventListener('input', () => setUnsavedChanges(true));
    configForm.addEventListener('change', () => setUnsavedChanges(true));
    configForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      const status = $('#config-status');
      const saveBtn = $('#settings-save');
      status.textContent = '';
      status.className = 'status-line';
      saveBtn?.classList.add('btn-loading');

      const allowedOrigins = form.elements['allowedOrigins'].value.split(',').map((s) => s.trim()).filter(Boolean);
      const patch = {
        bluesmindsBaseUrl: form.elements['bluesmindsBaseUrl'].value.trim(),
        defaultModel: form.elements['defaultModel'].value.trim(),
        strictModelMapping: form.elements['strictModelMapping'].checked,
        rateLimitPerMinute: Number(form.elements['rateLimitPerMinute'].value),
        requestTimeoutMs: Number(form.elements['requestTimeoutMs'].value),
        allowedOrigins,
        maxBodySize: form.elements['maxBodySize'].value.trim(),
        debugLogs: form.elements['debugLogs'].checked,
      };
      const apiKey = form.elements['bluesmindsApiKey'].value;
      if (apiKey) patch.bluesmindsApiKey = apiKey;
      const proxyKey = form.elements['proxyApiKey'].value;
      if (proxyKey) patch.proxyApiKey = proxyKey;

      if (!/^https?:\/\//i.test(patch.bluesmindsBaseUrl)) {
        status.textContent = 'Base URL must start with http:// or https://'; status.classList.add('err');
        saveBtn?.classList.remove('btn-loading');
        return;
      }
      if (patch.rateLimitPerMinute < 1 || patch.rateLimitPerMinute > 10000) {
        status.textContent = 'rateLimitPerMinute must be between 1 and 10000'; status.classList.add('err');
        saveBtn?.classList.remove('btn-loading');
        return;
      }
      if (patch.requestTimeoutMs < 1000 || patch.requestTimeoutMs > 600000) {
        status.textContent = 'requestTimeoutMs must be between 1000 and 600000'; status.classList.add('err');
        saveBtn?.classList.remove('btn-loading');
        return;
      }

      try {
        const updated = await api('PUT', '/config', patch);
        status.textContent = '✓ Settings saved successfully'; status.classList.add('ok');
        toast('Settings saved', 'ok', 'Saved');
        form.elements['bluesmindsApiKey'].value = '';
        form.elements['proxyApiKey'].value = '';
        $('#apikey-set').textContent = updated.apiKeySet ? '✓ set' : '✗ missing';
        const proxyKeyEl = $('#proxykey-set');
        if (proxyKeyEl) proxyKeyEl.textContent = updated.proxyApiKeyStatus === 'set' ? '✓ set' : '✗ missing';
        state.lastConfig = updated;
        setUnsavedChanges(false);
        const statusModel = $('#status-default-model');
        if (statusModel) statusModel.textContent = updated.defaultModel || '—';
        // Update restart banner
        updateRestartBanner(updated);
        // Refresh operations
        loadOperations();
      } catch (err) {
        status.textContent = err.message; status.classList.add('err');
        toast(err.message, 'error', 'Save failed');
      } finally {
        saveBtn?.classList.remove('btn-loading');
      }
    });
  }

  /* ── Settings Reset ──────────────────────────────────────────────── */
  const settingsResetBtn = $('#settings-reset');
  if (settingsResetBtn) {
    settingsResetBtn.addEventListener('click', async () => {
      await loadConfig();
      toast('Settings reloaded from server', 'ok', 'Reverted');
    });
  }

  /* ── Settings inline buttons ─────────────────────────────────────── */
  const settingsTestConn = $('#settings-test-conn');
  if (settingsTestConn) {
    settingsTestConn.addEventListener('click', async () => {
      const btn = settingsTestConn;
      const result = $('#settings-test-result');
      btn.classList.add('btn-loading');
      btn.disabled = true;
      result.hidden = false;
      result.className = 'test-result';
      result.innerHTML = '<p style="color:var(--text-muted)">Sending test request…</p>';
      try {
        const data = await api('POST', '/test-connection');
        if (data.success) {
          result.classList.add('ok');
          result.innerHTML = `
            <div class="test-result-head">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>Connected</strong>
            </div>
            <div class="test-result-meta">
              <span>Status: <code>${data.upstreamStatus}</code></span>
              <span>Latency: <code>${fmt.ms(data.latencyMs)}</code></span>
              <span>Model: <code>${escapeHtml(state.lastConfig?.defaultModel || '—')}</code></span>
            </div>
            <pre>${escapeHtml(data.preview || '(empty response)')}</pre>`;
        } else {
          result.classList.add('err');
          result.innerHTML = `
            <div class="test-result-head">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <strong>Connection failed</strong>
            </div>
            <div class="test-result-meta">
              <span>Status: <code>${data.upstreamStatus ?? '—'}</code></span>
              <span>Latency: <code>${fmt.ms(data.latencyMs)}</code></span>
            </div>
            <pre>${escapeHtml(data.error)}</pre>`;
        }
      } catch (err) {
        result.classList.add('err');
        result.innerHTML = `<div class="test-result-head"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><strong>${escapeHtml(err.message)}</strong></div>`;
      } finally {
        btn.classList.remove('btn-loading');
        btn.disabled = false;
      }
    });
  }
  const settingsFetchModels = $('#settings-fetch-models');
  if (settingsFetchModels) {
    settingsFetchModels.addEventListener('click', async () => {
      const btn = settingsFetchModels;
      const result = $('#settings-sync-result');
      btn.classList.add('btn-loading');
      btn.disabled = true;
      result.hidden = false;
      result.className = 'test-result';
      result.innerHTML = '<p style="color:var(--text-muted)">Syncing models from provider…</p>';
      try {
        const data = await api('POST', '/sync-models');
        const models = data.models || [];
        result.classList.add('ok');
        result.innerHTML = `
          <div class="test-result-head">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <strong>${models.length} model${models.length === 1 ? '' : 's'} synced</strong>
          </div>
          <div class="test-result-meta">
            <span>Synced at: <code>${data.syncedAt ? new Date(data.syncedAt).toLocaleTimeString() : '—'}</code></span>
          </div>`;
        // Update available models in Model Router if loaded
        if (typeof renderAvailableModels === 'function') renderAvailableModels();
      } catch (err) {
        result.classList.add('err');
        result.innerHTML = `
          <div class="test-result-head">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <strong>Sync failed</strong>
          </div>
          <pre>${escapeHtml(err.message)}</pre>`;
      } finally {
        btn.classList.remove('btn-loading');
        btn.disabled = false;
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 18b — Operations & Restart Flow
     ══════════════════════════════════════════════════════════════════ */
  async function loadOperations() {
    try {
      const data = await api('GET', '/operations');
      const statusEl = $('#ops-status');
      const pmEl = $('#ops-pm');
      const uptimeEl = $('#ops-uptime');
      const nodeEl = $('#ops-node');
      const unavailEl = $('#ops-unavailable');
      if (statusEl) statusEl.textContent = 'Live';
      if (pmEl) pmEl.textContent = data.processManager === 'pm2' ? `PM2 (${data.pm2AppName || 'app'})` : data.processManager === 'docker' ? 'Docker' : 'Node (direct)';
      if (uptimeEl) uptimeEl.textContent = data.uptimeFormatted || '—';
      if (nodeEl) nodeEl.textContent = data.nodeVersion || '—';
      // Show/hide restart unavailable message
      if (unavailEl) {
        const canRestart = data.processManager === 'pm2' || (data.processManager === 'node' && false);
        unavailEl.classList.toggle('hidden', data.processManager !== 'node');
      }
      // Update restart banner
      updateRestartBanner(data);
    } catch {
      // silently ignore
    }
  }

  function updateRestartBanner(data) {
    const banner = $('#restart-banner');
    const reasonsEl = $('#restart-reasons');
    if (!banner) return;
    if (data && data.restartRequired && data.restartReasons && data.restartReasons.length > 0) {
      banner.classList.remove('hidden');
      if (reasonsEl) reasonsEl.textContent = `Changed: ${data.restartReasons.join(', ')}`;
    } else {
      banner.classList.add('hidden');
    }
  }

  function openRestartModal() {
    const overlay = $('#restart-modal-overlay');
    const reasonsEl = $('#restart-modal-reasons');
    if (overlay) overlay.classList.remove('hidden');
    const cfg = state.lastConfig;
    if (reasonsEl && cfg && cfg.restartReasons && cfg.restartReasons.length > 0) {
      reasonsEl.textContent = `Pending changes: ${cfg.restartReasons.join(', ')}`;
    } else if (reasonsEl) {
      reasonsEl.textContent = '';
    }
  }

  function closeRestartModal() {
    const overlay = $('#restart-modal-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  async function executeRestart() {
    closeRestartModal();
    const overlay = $('#restart-overlay');
    const statusEl = $('#restart-overlay-status');
    if (overlay) overlay.classList.remove('hidden');
    if (statusEl) statusEl.textContent = 'Sending restart signal…';

    try {
      await api('POST', '/restart');
    } catch {
      // Server may already be shutting down
    }

    if (statusEl) statusEl.textContent = 'Waiting for server to come back online…';

    // Poll health until server is back
    const start = Date.now();
    const timeout = 60_000;
    const interval = 1_000;
    let online = false;

    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, interval));
      try {
        const res = await fetch('/health');
        if (res.ok) {
          online = true;
          break;
        }
      } catch {
        // server still down
      }
    }

    if (overlay) overlay.classList.add('hidden');

    if (online) {
      toast('Gateway restarted successfully', 'ok', 'Restarted');
      // Refresh all data
      await loadConfig();
      await loadOperations();
      await loadStats?.();
    } else {
      toast('Gateway did not come back online within 60 seconds. Check terminal/PM2 logs.', 'error', 'Restart timeout');
    }
  }

  // Wire up operations buttons
  const opsRestartBtn = $('#ops-restart-btn');
  if (opsRestartBtn) opsRestartBtn.addEventListener('click', openRestartModal);
  const opsHealthBtn = $('#ops-health-btn');
  if (opsHealthBtn) {
    opsHealthBtn.addEventListener('click', async () => {
      const result = $('#ops-health-result');
      if (!result) return;
      result.hidden = false;
      result.className = 'test-result';
      result.innerHTML = '<p style="color:var(--text-muted)">Checking health…</p>';
      try {
        const res = await fetch('/health');
        const data = await res.json();
        result.classList.add('ok');
        result.innerHTML = `
          <div class="test-result-head">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <strong>Gateway is healthy</strong>
          </div>
          <div class="test-result-meta">
            <span>Name: <code>${escapeHtml(data.name || '—')}</code></span>
            <span>Version: <code>${escapeHtml(data.version || '—')}</code></span>
          </div>`;
      } catch (err) {
        result.classList.add('err');
        result.innerHTML = `
          <div class="test-result-head">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <strong>${escapeHtml(err.message)}</strong>
          </div>`;
      }
    });
  }

  // Wire up restart banner buttons
  const restartGatewayBtn = $('#restart-gateway-btn');
  if (restartGatewayBtn) restartGatewayBtn.addEventListener('click', openRestartModal);
  const restartLaterBtn = $('#restart-later-btn');
  if (restartLaterBtn) restartLaterBtn.addEventListener('click', () => {
    const banner = $('#restart-banner');
    if (banner) banner.classList.add('hidden');
  });

  // Wire up restart modal
  const restartModalClose = $('#restart-modal-close');
  if (restartModalClose) restartModalClose.addEventListener('click', closeRestartModal);
  const restartModalCancel = $('#restart-modal-cancel');
  if (restartModalCancel) restartModalCancel.addEventListener('click', closeRestartModal);
  const restartModalConfirm = $('#restart-modal-confirm');
  if (restartModalConfirm) restartModalConfirm.addEventListener('click', executeRestart);
  const restartModalOverlay = $('#restart-modal-overlay');
  if (restartModalOverlay) {
    restartModalOverlay.addEventListener('click', (ev) => {
      if (ev.target === restartModalOverlay) closeRestartModal();
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 18c — Local Claude Integration (LCI)
     Checks and auto-configures ~/.claude.json to use this proxy.
     ══════════════════════════════════════════════════════════════════ */

  function lciIconSvg(type) {
    if (type === 'ok') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    if (type === 'warn') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
  }

  function renderLciCard(data) {
    const card = $('#lci-status-card');
    const configureBtn = $('#lci-configure-btn');
    if (!card) return;

    let cardClass = 'lci-unconfigured';
    let iconType = 'err';
    let badgeClass = 'err';
    let badgeText = 'Not Configured';
    let titleText = 'Claude Code is NOT using this proxy';
    let descHtml = '';
    let showConfigureBtn = true;

    if (data.configured) {
      cardClass = 'lci-configured';
      iconType = 'ok';
      badgeClass = 'ok';
      badgeText = 'Configured';
      titleText = 'Claude Code is using this proxy';
      showConfigureBtn = false;
    } else if (data.partial) {
      cardClass = 'lci-partial';
      iconType = 'warn';
      badgeClass = 'warn';
      badgeText = 'Different URL';
      titleText = 'Claude Code is pointing to a different proxy';
    } else if (!data.fileExists) {
      titleText = 'No ~/.claude.json found';
      descHtml = `<p class="lci-desc">Click <strong>Auto-Configure Claude</strong> to create it and point Claude Code at this proxy.</p>`;
    } else if (!data.readable) {
      cardClass = 'lci-partial';
      iconType = 'warn';
      badgeClass = 'warn';
      badgeText = 'Read Error';
      titleText = 'Cannot read ~/.claude.json';
      showConfigureBtn = false;
    }

    // Build URL chips
    let urlChips = '';
    if (data.currentBaseUrl && !data.configured) {
      urlChips += `<span class="lci-url-chip warn"><span class="lci-url-chip-dot"></span><span class="lci-url-chip-label">Current:</span>${escapeHtml(data.currentBaseUrl)}</span>`;
    }
    if (data.proxyBaseUrl) {
      const chipClass = data.configured ? 'ok' : '';
      urlChips += `<span class="lci-url-chip ${chipClass}"><span class="lci-url-chip-dot"></span><span class="lci-url-chip-label">Proxy:</span>${escapeHtml(data.proxyBaseUrl)}</span>`;
    }

    // Default description if not set
    if (!descHtml && data.configured) {
      descHtml = `<p class="lci-desc">All Claude Code requests are routed through this gateway. Model: <code>${escapeHtml(data.currentModel || '—')}</code></p>`;
    } else if (!descHtml && data.partial) {
      descHtml = `<p class="lci-desc">Claude Code has a different base URL configured. Click <strong>Auto-Configure Claude</strong> to update it to this proxy.</p>`;
    } else if (!descHtml) {
      descHtml = `<p class="lci-desc">Click <strong>Auto-Configure Claude</strong> to set ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, and ANTHROPIC_MODEL.</p>`;
    }

    card.className = `lci-status-card ${cardClass}`;
    card.innerHTML = `
      <div class="lci-status-card-inner">
        <div class="lci-icon ${iconType}">${lciIconSvg(iconType)}</div>
        <div class="lci-info">
          <div class="lci-title">
            ${escapeHtml(titleText)}
            <span class="lci-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
          </div>
          ${descHtml}
          ${urlChips ? `<div class="lci-url-row">${urlChips}</div>` : ''}
          <div class="lci-path-row" style="margin-top:${urlChips ? '8px' : '0'}">
            <span class="lci-path-label">Config</span>
            <span class="lci-path-value" title="${escapeHtml(data.claudeJsonPath || '')}">${escapeHtml(data.claudeJsonPath || '~/.claude.json')}</span>
          </div>
        </div>
      </div>`;

    if (configureBtn) {
      configureBtn.disabled = !showConfigureBtn;
    }
    const openBtn = $('#lci-open-btn');
    if (openBtn) {
      openBtn.disabled = !data.fileExists;
    }
  }

  async function lciLoadStatus(silent = false) {
    const card = $('#lci-status-card');
    if (!card) return;

    if (!silent) {
      card.className = 'lci-status-card';
      card.innerHTML = `<div class="lci-status-card-inner lci-loading"><span class="lci-spinner"></span><span class="lci-status-text">Checking configuration…</span></div>`;
      const configureBtn = $('#lci-configure-btn');
      if (configureBtn) configureBtn.disabled = true;
    }

    try {
      const data = await api('GET', '/claude-local/status');
      renderLciCard(data);
    } catch (err) {
      if (card) {
        card.className = 'lci-status-card lci-unconfigured';
        card.innerHTML = `<div class="lci-status-card-inner"><div class="lci-icon err">${lciIconSvg('err')}</div><div class="lci-info"><div class="lci-title">Status check failed</div><p class="lci-desc">${escapeHtml(err.message)}</p></div></div>`;
      }
    }
  }

  // Note: lciLoadStatus() is called from switchView() whenever Settings view is opened.

  // Test button
  const lciTestBtn = $('#lci-test-btn');
  if (lciTestBtn) {
    lciTestBtn.addEventListener('click', async () => {
      lciTestBtn.classList.add('btn-loading');
      lciTestBtn.disabled = true;
      const resultEl = $('#lci-result');
      if (resultEl) resultEl.hidden = true;
      try {
        await lciLoadStatus(false);
        toast('Configuration check complete', 'ok', 'LCI Test');
      } finally {
        lciTestBtn.classList.remove('btn-loading');
        lciTestBtn.disabled = false;
      }
    });
  }

  // Open File button
  const lciOpenBtn = $('#lci-open-btn');
  if (lciOpenBtn) {
    lciOpenBtn.addEventListener('click', async () => {
      lciOpenBtn.classList.add('btn-loading');
      lciOpenBtn.disabled = true;
      try {
        await api('POST', '/claude-local/open');
        toast('Opened ~/.claude.json in Notepad', 'ok');
      } catch (err) {
        toast('Failed to open file: ' + err.message, 'err');
      } finally {
        lciOpenBtn.classList.remove('btn-loading');
        lciOpenBtn.disabled = false;
      }
    });
  }

  // Auto-Configure button
  const lciConfigureBtn = $('#lci-configure-btn');
  if (lciConfigureBtn) {
    lciConfigureBtn.addEventListener('click', async () => {
      lciConfigureBtn.classList.add('btn-loading');
      lciConfigureBtn.disabled = true;
      const resultEl = $('#lci-result');
      if (resultEl) {
        resultEl.hidden = false;
        resultEl.className = 'test-result';
        resultEl.innerHTML = `<p style="color:var(--text-muted)">Writing ~/.claude.json…</p>`;
      }
      try {
        const data = await api('POST', '/claude-local/configure');
        if (data.ok) {
          if (resultEl) {
            resultEl.classList.add('ok');
            resultEl.innerHTML = `
              <div class="test-result-head">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <strong>Claude Code configured successfully!</strong>
              </div>
              <div class="test-result-meta">
                <span>File: <code>${escapeHtml(data.claudeJsonPath)}</code></span>
                <span>Base URL: <code>${escapeHtml(data.written?.ANTHROPIC_BASE_URL || '')}</code></span>
                <span>Model: <code>${escapeHtml(data.written?.ANTHROPIC_MODEL || '')}</code></span>
              </div>
              <p style="margin:8px 0 0; font-size:12px; color:var(--text-secondary)">
                Restart Claude Code for the changes to take effect.
              </p>`;
          }
          toast('~/.claude.json updated — restart Claude Code', 'ok', 'Configured!');
          // Refresh status card
          await lciLoadStatus(true);
        }
      } catch (err) {
        if (resultEl) {
          resultEl.classList.add('err');
          resultEl.innerHTML = `
            <div class="test-result-head">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <strong>Configure failed</strong>
            </div>
            <pre>${escapeHtml(err.message)}</pre>`;
        }
        toast(`Auto-configure failed: ${err.message}`, 'error', 'LCI Error');
      } finally {
        lciConfigureBtn.classList.remove('btn-loading');
        // Re-check status to update button state
        await lciLoadStatus(true);
      }
    });
  }

  // Also trigger status load when settings nav item is clicked directly
  const settingsNavItem = document.querySelector('[data-view="settings"]');
  if (settingsNavItem) {
    settingsNavItem.addEventListener('click', () => {
      setTimeout(() => lciLoadStatus(), 100);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 19 — Model Mappings (Router)
     ══════════════════════════════════════════════════════════════════ */

  const RECOMMENDED_MAPPINGS = [
    { claude: 'claude-opus-4-5-20251101', provider: 'moonshotai/kimi-k2.6' },
    { claude: 'claude-haiku-4-5-20251001', provider: 'gpt-5-nano' },
  ];

  function getMappingStatus(originalKey, currentValue) {
    const savedValue = state.savedMappings[originalKey];
    const inSaved = originalKey in state.savedMappings;
    if (!inSaved) return 'unsaved';
    if (savedValue !== currentValue) return 'unsaved';
    const suggestion = state.suggestions.find((s) => s.claudeModel === originalKey);
    if (suggestion && !suggestion.alreadyCorrect) return 'suggested';
    if (state.testedMappings[originalKey]) return 'tested';
    if (state.failedMappings[originalKey]) return 'failed';
    return 'exact';
  }

  function mappingStatusLabel(status) {
    return ({ exact: 'Exact', unsaved: 'Unsaved', suggested: 'Suggested', tested: 'Tested', failed: 'Failed', fallback: 'Fallback' })[status] || 'Exact';
  }

  async function loadMappings() {
    try {
      const data = await api('GET', '/models/mappings');
      state.mappings = data.mappings || {};
      state.savedMappings = { ...(data.mappings || {}) };
      state.defaultModel = data.default || '';
      // Store family rules from backend — these are now real, not hardcoded
      state.familyRules = data.familyRules || [];
      const defaultInput = $('#default-model-input');
      if (defaultInput) defaultInput.value = state.defaultModel;
      renderMappingsTable();
      renderRouterHealth();
      renderFamilyRules();
      renderAutoFallback();
      renderAvailableModels();
    } catch (err) {
      toast(`Mappings load failed: ${err.message}`, 'error', 'Load failed');
    }
  }

  function renderMappingsTable() {
    const tbody = $('#mappings-tbody');
    const emptyEl = $('#mappings-empty');
    const countEl = $('#mapping-count');
    if (!tbody) return;
    const entries = Object.entries(state.mappings || {});
    if (countEl) countEl.textContent = `${entries.length} mapping${entries.length === 1 ? '' : 's'}`;

    if (entries.length === 0) {
      tbody.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      updateSelectedMappingLabel();
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    tbody.innerHTML = entries.map(([k, v]) => {
      const status = getMappingStatus(k, v);
      const isDirty = status === 'unsaved';
      const suggestion = state.suggestions.find((s) => s.claudeModel === k);
      const hasSuggestion = suggestion && !suggestion.alreadyCorrect;
      const isAlreadyCorrect = suggestion && suggestion.alreadyCorrect;
      const badgeHtml = hasSuggestion
        ? `<span class="suggestion-badge" data-suggest="${escapeAttr(suggestion.suggested)}" title="${escapeAttr(suggestion.reason)} (${(suggestion.confidence * 100).toFixed(0)}% confidence) — click to apply">→ ${escapeHtml(suggestion.suggested)}</span>`
        : isAlreadyCorrect
          ? `<span class="suggestion-badge correct" title="Already using the correct provider ID">✓ Correct</span>`
          : '';
      const selected = state.selectedMapping === k ? 'is-selected' : '';
      return `<tr class="mapping-row ${selected}" data-key="${escapeAttr(k)}">
        <td>
          <div class="mapping-input-cell">
            <input class="mapping-input ${isDirty ? 'is-dirty' : ''}" data-field="key" data-original="${escapeAttr(k)}" value="${escapeAttr(k)}" placeholder="claude-opus-4-5-20251101" />
          </div>
        </td>
        <td><span class="mapping-provider-badge">upstream</span></td>
        <td>
          <div class="mapping-input-cell">
            <input class="mapping-input ${isDirty ? 'is-dirty' : ''}" data-field="val" data-original="${escapeAttr(k)}" value="${escapeAttr(v)}" placeholder="moonshotai/kimi-k2.6" list="provider-models-list" />
            ${badgeHtml}
          </div>
        </td>
        <td><span class="mapping-status status-${status}">${mappingStatusLabel(status)}</span></td>
        <td class="col-action">
          <div class="mapping-row-actions">
            <button class="icon-btn" data-row-action="test" data-key="${escapeAttr(k)}" aria-label="Test mapping" title="Test this mapping">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="icon-btn" data-row-action="duplicate" data-key="${escapeAttr(k)}" aria-label="Duplicate mapping" title="Duplicate this mapping">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            </button>
            <button class="icon-btn danger" data-row-action="remove" data-key="${escapeAttr(k)}" aria-label="Remove mapping" title="Remove this mapping">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');

    /* Wire row inputs */
    tbody.querySelectorAll('input.mapping-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const tr = inp.closest('tr');
        const original = inp.getAttribute('data-original');
        const keyInput = tr.querySelector('input[data-field="key"]');
        const valInput = tr.querySelector('input[data-field="val"]');
        const newKey = (keyInput.value || '').trim();
        const newVal = (valInput.value || '').trim();
        if (!newKey || !newVal) {
          inp.classList.remove('is-dirty');
          return;
        }
        const inSaved = original in state.savedMappings;
        const dirty = !inSaved || state.savedMappings[original] !== newVal;
        inp.classList.toggle('is-dirty', dirty);
        rebuildMappingFromTable();
        const statusEl = tr.querySelector('.mapping-status');
        if (statusEl) {
          const newStatus = getMappingStatus(newKey, newVal);
          statusEl.className = `mapping-status status-${newStatus}`;
          statusEl.textContent = mappingStatusLabel(newStatus);
        }
      });
    });

    /* Wire row actions */
    tbody.querySelectorAll('[data-row-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.getAttribute('data-row-action');
        const key = btn.getAttribute('data-key');
        if (act === 'test') testMapping(key);
        else if (act === 'duplicate') duplicateMapping(key);
        else if (act === 'remove') removeMapping(key);
      });
    });

    /* Wire suggestion badge clicks — fill input with suggested value */
    tbody.querySelectorAll('.suggestion-badge[data-suggest]').forEach((badge) => {
      badge.addEventListener('click', () => {
        const suggested = badge.getAttribute('data-suggest');
        const valInput = badge.closest('.mapping-input-cell')?.querySelector('input[data-field="val"]');
        if (valInput && suggested) {
          valInput.value = suggested;
          valInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    });

    /* Wire row selection */
    tbody.querySelectorAll('tr.mapping-row').forEach((tr) => {
      tr.addEventListener('click', (ev) => {
        if (ev.target.closest('input, button, .icon-btn, [data-row-action]')) return;
        selectMappingRow(tr.getAttribute('data-key'));
      });
    });

    updateSelectedMappingLabel();
  }

  function selectMappingRow(key) {
    state.selectedMapping = state.selectedMapping === key ? null : key;
    renderMappingsTable();
  }

  function updateAutoMapButton() {
    const btn = $('#auto-map-btn');
    if (!btn) return;
    const hasModels = state.availableModels.length > 0;
    btn.disabled = !hasModels;
    btn.title = hasModels
      ? 'Suggest provider model IDs based on the synced model list'
      : 'Sync Models first to enable Auto-Map';
  }

  function renderApplySuggestionsBar() {
    const existing = $('#apply-suggestions-bar');
    if (existing) existing.remove();

    const pending = (state.suggestions || []).filter((s) => !s.alreadyCorrect);
    if (pending.length === 0) return;

    const bar = document.createElement('div');
    bar.id = 'apply-suggestions-bar';
    bar.className = 'apply-suggestions-bar stagger-item';
    bar.innerHTML = `
      <span class="apply-suggestions-text">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        <strong>${pending.length} suggestion${pending.length === 1 ? '' : 's'}</strong> ready — click to apply all at once
        ${state.prefixStyle === 'mixed' ? '<span class="badge badge-warning" style="margin-left:8px">Mixed prefixes</span>' : ''}
      </span>
      <div class="apply-suggestions-actions">
        <button class="btn btn-primary btn-sm" id="apply-all-btn" type="button">Apply ${pending.length} suggestion${pending.length === 1 ? '' : 's'}</button>
        <button class="btn btn-ghost btn-sm" id="dismiss-suggestions-btn" type="button">Dismiss</button>
      </div>
    `;

    const panel = $('.router-mappings-panel');
    const tableWrap = panel?.querySelector('.table-wrap');
    if (panel && tableWrap) panel.insertBefore(bar, tableWrap);

    $('#apply-all-btn')?.addEventListener('click', async () => {
      const applyBtn = $('#apply-all-btn');
      if (applyBtn) applyBtn.classList.add('btn-loading');
      try {
        const updated = await api('POST', '/models/apply-suggestions', { acceptAll: true });
        state.mappings = updated.mappings || {};
        state.savedMappings = { ...(updated.mappings || {}) };
        state.defaultModel = updated.default || '';
        state.suggestions = [];
        state.defaultSuggestion = null;
        const defaultInput = $('#default-model-input');
        if (defaultInput) defaultInput.value = state.defaultModel;
        renderMappingsTable();
        renderApplySuggestionsBar();
        renderRouterHealth();
        toast(`${pending.length} mapping${pending.length === 1 ? '' : 's'} updated`, 'ok', 'Applied');
      } catch (err) {
        toast(err.message, 'error', 'Apply failed');
      } finally {
        if (applyBtn) applyBtn.classList.remove('btn-loading');
      }
    });

    $('#dismiss-suggestions-btn')?.addEventListener('click', () => {
      state.suggestions = [];
      state.defaultSuggestion = null;
      renderApplySuggestionsBar();
      renderMappingsTable();
      toast('Suggestions dismissed', 'info', 'Dismissed');
    });
  }

  async function runAutoMap() {
    const btn = $('#auto-map-btn');
    if (btn) btn.classList.add('btn-loading');
    try {
      const data = await api('POST', '/models/auto-map', {
        defaultModel: ($('#default-model-input')?.value || '').trim() || undefined,
      });
      state.suggestions = data.suggestions || [];
      state.defaultSuggestion = data.defaultSuggestion || null;
      state.prefixStyle = data.prefixStyle || null;

      if (data.mixedWarning) {
        toast(data.mixedWarning, 'warn', 'Mixed prefix styles detected');
      }

      renderMappingsTable();
      renderApplySuggestionsBar();

      const pending = state.suggestions.filter((s) => !s.alreadyCorrect).length;
      const correct = state.suggestions.filter((s) => s.alreadyCorrect).length;
      const msg = pending > 0
        ? `${pending} suggestion${pending === 1 ? '' : 's'} found${correct > 0 ? `, ${correct} already correct` : ''}`
        : `All ${correct} mapping${correct === 1 ? '' : 's'} already use correct IDs`;
      toast(msg, pending > 0 ? 'ok' : 'info', 'Auto-Map complete');
    } catch (err) {
      toast(err.message, 'error', 'Auto-Map failed');
    } finally {
      if (btn) btn.classList.remove('btn-loading');
    }
  }

  function updateSelectedMappingLabel() {
    const label = $('#router-selected-label');
    if (!label) return;
    if (state.selectedMapping && state.mappings[state.selectedMapping] !== undefined) {
      label.classList.add('is-visible');
      label.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Selected: <span class="router-selected-key">${escapeHtml(state.selectedMapping)}</span> <button type="button" data-clear-selection aria-label="Clear selection">×</button>`;
      const btn = label.querySelector('[data-clear-selection]');
      if (btn) btn.addEventListener('click', () => { state.selectedMapping = null; renderMappingsTable(); });
    } else {
      label.classList.remove('is-visible');
      label.innerHTML = '';
    }
  }

  function testMapping(key) {
    const v = state.mappings[key];
    if (!v) return;
    toast(`Testing mapping: ${key} → ${v}…`, 'info', 'Test');
    state.testedMappings[key] = Date.now();
    state.failedMappings[key] = false;
    renderMappingsTable();
    switchView('playground');
    setTimeout(() => {
      const pgModel = $('#pg-model');
      if (pgModel) pgModel.value = v;
    }, 250);
  }

  function duplicateMapping(key) {
    const v = state.mappings[key];
    if (v === undefined) return;
    let base = `${key}-copy`;
    let n = 2;
    while (state.mappings[base]) base = `${key}-copy-${n++}`;
    state.mappings[base] = v;
    renderMappingsTable();
  }

  function removeMapping(key) {
    delete state.mappings[key];
    if (state.selectedMapping === key) state.selectedMapping = null;
    renderMappingsTable();
    renderRouterHealth();
    renderAutoFallback();
    renderAvailableModels();
  }

  function rebuildMappingFromTable() {
    const next = {};
    $$('#mappings-tbody tr').forEach((tr) => {
      const k = tr.querySelector('input[data-field="key"]');
      const v = tr.querySelector('input[data-field="val"]');
      if (k && v && k.value.trim() && v.value.trim()) next[k.value.trim()] = v.value.trim();
    });
    state.mappings = next;
    renderRouterHealth();
  }

  function addMappingRow(prefill = {}) {
    const baseName = prefill.claude || `claude-new-model-${Object.keys(state.mappings).length + 1}`;
    let key = baseName;
    let n = 2;
    while (state.mappings[key]) key = `${baseName}-${n++}`;
    state.mappings[key] = prefill.provider || '';
    renderMappingsTable();
  }

  /* ── Router Health ─────────────────────────────────────────────── */
  function renderRouterHealth() {
    const grid = $('#router-health-grid');
    const summary = $('#router-health-summary');
    if (!grid) return;

    const mappings = state.mappings || {};
    const saved = state.savedMappings || {};
    const exactCount = Object.keys(mappings).filter((k) => k in saved && saved[k] === mappings[k]).length;
    const unsavedCount = Object.keys(mappings).filter((k) => !(k in saved) || saved[k] !== mappings[k]).length;
    const buffer = state.requestBuffer || [];
    const unmapped = new Set();
    buffer.forEach((r) => {
      const cm = r.clientModel;
      if (cm && !(cm in mappings)) unmapped.add(cm);
    });
    const unmappedCount = unmapped.size;
    const defaultModel = (state.defaultModel || $('#default-model-input')?.value || '').trim() || '—';

    const tiles = [
      {
        label: 'Exact mappings',
        value: exactCount,
        sub: unsavedCount > 0 ? `${unsavedCount} unsaved` : 'all saved',
        tone: exactCount > 0 ? 'good' : '',
        dot: true,
      },
      {
        label: 'Fallbacks',
        value: '4',
        sub: 'family rules active',
        tone: 'good',
        dot: true,
      },
      {
        label: 'Unmapped',
        value: unmappedCount,
        sub: unmappedCount > 0 ? 'auto-handled' : 'none in recent traffic',
        tone: unmappedCount > 0 ? 'warn' : 'good',
        dot: true,
      },
      {
        label: 'Default model',
        value: '1',
        sub: defaultModel,
        tone: defaultModel && defaultModel !== '—' ? 'good' : 'warn',
        dot: false,
        mono: true,
      },
    ];

    grid.innerHTML = tiles.map((t) => {
      const toneClass = t.tone ? `tone-${t.tone}` : '';
      const subStyle = t.mono ? `style="font-family:var(--mono); font-size:11.5px;"` : '';
      return `<div class="router-health-tile ${toneClass}">
        <div class="router-health-label">${t.dot ? '<span class="router-health-dot"></span>' : ''}${escapeHtml(t.label)}</div>
        <div class="router-health-value">${typeof t.value === 'number' ? t.value : escapeHtml(t.value)}</div>
        <div class="router-health-sub" ${subStyle}>${escapeHtml(t.sub)}</div>
      </div>`;
    }).join('');

    if (summary) {
      const total = Object.keys(mappings).length;
      summary.textContent = `${total} active route${total === 1 ? '' : 's'} · ${unsavedCount > 0 ? `${unsavedCount} pending` : 'synced'}`;
    }
  }

  /* ── Family Routing Rules ─────────────────────────────────────── */
  function renderFamilyRules() {
    const tbody = $('#router-family-tbody');
    if (!tbody) return;
    const defaultModel = (state.defaultModel || $('#default-model-input')?.value || '').trim() || '—';

    // Use live rules from the backend (state.familyRules), falling back to
    // sensible defaults if the API hasn't responded yet.
    const rules = (state.familyRules && state.familyRules.length > 0)
      ? state.familyRules.map((r) => ({
          name: r.name,
          pattern: r.pattern,
          primary: r.primary || defaultModel,
          backup: r.backup || '—',
        }))
      : [
          { name: 'Haiku',        pattern: 'claude*haiku*',  primary: defaultModel, backup: defaultModel },
          { name: 'Sonnet',       pattern: 'claude*sonnet*', primary: defaultModel, backup: defaultModel },
          { name: 'Opus',         pattern: 'claude*opus*',   primary: defaultModel, backup: defaultModel },
          { name: 'Claude Other', pattern: 'claude*',        primary: defaultModel, backup: defaultModel },
          { name: 'Default',      pattern: '*',              primary: defaultModel, backup: '—' },
        ];
    tbody.innerHTML = rules.map((r, i) => `<tr data-rule-index="${i}">
      <td class="router-family-name">${escapeHtml(r.name)}</td>
      <td class="router-family-pattern"><code>${escapeHtml(r.pattern)}</code></td>
      <td class="router-family-primary">
        <input class="mapping-input family-primary-input" data-rule-index="${i}" value="${escapeAttr(r.primary)}" placeholder="provider-model" list="provider-models-list" style="width:100%;min-width:140px" />
      </td>
      <td class="router-family-backup">
        <input class="mapping-input family-backup-input" data-rule-index="${i}" value="${escapeAttr(r.backup === '—' ? '' : r.backup)}" placeholder="backup model (optional)" list="provider-models-list" style="width:100%;min-width:140px" />
      </td>
      <td class="col-action">
        <div class="mapping-row-actions">
          <button class="icon-btn" data-family-action="test" data-family="${escapeAttr(r.name)}" aria-label="Test rule" title="Test rule">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
        </div>
      </td>
    </tr>`).join('');

    tbody.querySelectorAll('[data-family-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.getAttribute('data-family-action');
        const name = btn.getAttribute('data-family');
        const rule = rules.find((r) => r.name === name);
        if (!rule) return;
        if (act === 'test') {
          toast(`Testing family rule: ${name} (${rule.pattern})…`, 'info', 'Test');
          switchView('playground');
          setTimeout(() => {
            const pgModel = $('#pg-model');
            if (pgModel) pgModel.value = rule.primary;
          }, 250);
        }
      });
    });

    /* Wire live edits — update state.familyRules when inputs change */
    tbody.querySelectorAll('.family-primary-input, .family-backup-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = parseInt(inp.getAttribute('data-rule-index') || '0', 10);
        if (!state.familyRules[idx]) return;
        if (inp.classList.contains('family-primary-input')) {
          state.familyRules[idx].primary = inp.value.trim() || state.familyRules[idx].primary;
        } else {
          state.familyRules[idx].backup = inp.value.trim() || undefined;
        }
      });
    });
  }

  /* ── Auto-Fallback Models (compute from request buffer) ─────────── */
  function renderAutoFallback() {
    const body = $('#router-fallback-body');
    const summary = $('#router-fallback-summary');
    if (!body) return;
    const buffer = state.requestBuffer || [];
    const mappings = state.mappings || {};
    const defaultModel = (state.defaultModel || $('#default-model-input')?.value || '').trim() || 'default fallback';

    const groups = new Map();
    buffer.forEach((r) => {
      const cm = r.clientModel;
      if (!cm) return;
      if (cm in mappings) return;
      const cur = groups.get(cm) || { client: cm, requests: 0, errors: 0, latest: 0, status: r.status || 0 };
      cur.requests += 1;
      if ((r.status || 0) >= 400) cur.errors += 1;
      const t = new Date(r.timestamp).getTime();
      if (Number.isFinite(t) && t > cur.latest) cur.latest = t;
      groups.set(cm, cur);
    });
    const rows = Array.from(groups.values()).sort((a, b) => b.requests - a.requests);

    if (summary) {
      summary.textContent = rows.length > 0
        ? `${rows.length} client model${rows.length === 1 ? '' : 's'} resolved by fallback.`
        : 'Models handled automatically by fallback rules.';
    }

    if (rows.length === 0) {
      body.innerHTML = `<div class="router-fallback-empty">
        <span class="router-fallback-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </span>
        <div>
          <strong>No unmapped models detected.</strong>
          <p>All recent model requests are covered by exact mappings or rules.</p>
        </div>
      </div>`;
      return;
    }

    const table = `<div class="table-wrap"><table class="data-table data-table-dense router-fallback-body-table">
      <thead>
        <tr>
          <th>Client Model</th>
          <th>Resolved Model</th>
          <th>Resolution Type</th>
          <th class="num">Requests</th>
          <th class="num">Errors</th>
          <th>Last Seen</th>
          <th class="col-action">Actions</th>
        </tr>
      </thead>
      <tbody>${rows.map((r) => {
        const lastSeen = r.latest ? fmt.relativeTime(new Date(r.latest).toISOString()) : '—';
        return `<tr>
          <td class="router-fallback-model"><code>${escapeHtml(r.client)}</code></td>
          <td class="router-fallback-resolved"><code>${escapeHtml(defaultModel)}</code></td>
          <td><span class="badge badge-warning">Fallback</span></td>
          <td class="router-fallback-num">${fmt.n(r.requests)}</td>
          <td class="router-fallback-num" style="${r.errors > 0 ? 'color:var(--err-text); font-weight:600' : ''}">${fmt.n(r.errors)}</td>
          <td style="color:var(--text-secondary); font-size:12px">${escapeHtml(lastSeen)}</td>
          <td class="col-action">
            <div class="mapping-row-actions">
              <button class="icon-btn" data-fallback-action="create" data-client="${escapeAttr(r.client)}" aria-label="Create permanent mapping" title="Create permanent mapping">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="icon-btn" data-fallback-action="ignore" data-client="${escapeAttr(r.client)}" aria-label="Ignore" title="Ignore">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
    body.innerHTML = table;

    body.querySelectorAll('[data-fallback-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.getAttribute('data-fallback-action');
        const client = btn.getAttribute('data-client');
        if (act === 'create') {
          addMappingRow({ claude: client, provider: defaultModel });
          toast(`Mapping added: ${client} → ${defaultModel}. Click Save Router to apply.`, 'ok', 'Mapping added');
        } else if (act === 'ignore') {
          toast(`Ignored ${client}. Future requests will continue to use fallback.`, 'info', 'Ignored');
        }
      });
    });
  }

  /* ── Available Provider Models (actionable pills with popover) ─── */
  function renderAvailableModels() {
    const body = $('#available-body');
    const label = $('#available-count-label');
    if (!body) return;
    const all = state.availableModels || [];
    const staleLabel = (() => {
      if (!state.availableModelsCachedAt) return '';
      const ageMs = Date.now() - new Date(state.availableModelsCachedAt).getTime();
      const mins = Math.floor(ageMs / 60000);
      const hours = Math.floor(mins / 60);
      if (hours >= 1) return ` — synced ${hours}h ago`;
      if (mins >= 1) return ` — synced ${mins}m ago`;
      return ' — just synced';
    })();
    if (label) label.textContent = `${all.length} synced${staleLabel}`;

    /* Populate autocomplete datalist for Provider Model inputs */
    const dl = document.getElementById('provider-models-list');
    if (dl) {
      dl.innerHTML = all.slice(0, 300).map((id) => `<option value="${escapeAttr(id)}"></option>`).join('');
    }

    if (all.length === 0) {
      body.innerHTML = `<div class="router-available-empty">
        <span class="router-available-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
        </span>
        <div>
          <strong>No provider models synced yet</strong>
          <p>Click <em>Sync Models</em> above to fetch the model list from your provider.</p>
        </div>
      </div>`;
      return;
    }

    const mappedValues = new Set(Object.values(state.mappings || {}));
    const search = (state.availableSearch || '').toLowerCase().trim();
    const filter = state.availableFilter;
    const filtered = all.filter((m) => {
      if (search && !m.toLowerCase().includes(search)) return false;
      if (filter === 'mapped' && !mappedValues.has(m)) return false;
      if (filter === 'unmapped' && mappedValues.has(m)) return false;
      return true;
    });

    if (filtered.length === 0) {
      body.innerHTML = `<div class="router-section-empty">
        <span class="router-section-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </span>
        <span>No provider models match the current filter. Try a different search or filter.</span>
      </div>`;
      return;
    }

    const list = document.createElement('div');
    list.className = 'router-available-list';
    filtered.forEach((m) => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `provider-pill ${mappedValues.has(m) ? 'is-mapped' : ''}`;
      pill.setAttribute('data-provider-model', m);
      pill.textContent = m;
      pill.title = m;
      pill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openProviderPillPopover(pill, m);
      });
      list.appendChild(pill);
    });
    body.innerHTML = '';
    body.appendChild(list);
  }

  /* Popover for provider model pill actions */
  let activePopover = null;
  function openProviderPillPopover(anchor, model) {
    closeProviderPillPopover();
    const selected = state.selectedMapping;
    const mappedValues = new Set(Object.values(state.mappings || {}));
    const isMapped = mappedValues.has(model);

    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.setAttribute('data-popover', 'provider-pill');
    pop.innerHTML = `
      <div class="popover-head">
        <div class="popover-head-label">Provider Model</div>
        <div class="popover-head-value">${escapeHtml(model)}</div>
      </div>
      <button type="button" class="popover-item" data-pp-action="add">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add as new mapping
      </button>
      <button type="button" class="popover-item ${selected ? '' : 'popover-item-disabled'}" data-pp-action="replace" ${selected ? '' : 'disabled'}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 11-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><polyline points="21 3 21 8 16 8"/></svg>
        ${selected ? `Replace selected mapping (<code>${escapeHtml(selected)}</code>)` : 'Replace selected mapping'}
      </button>
      <button type="button" class="popover-item" data-pp-action="default">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Set as default fallback
      </button>
      <div class="popover-sep"></div>
      <button type="button" class="popover-item" data-pp-action="test">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Test this model
      </button>
      <button type="button" class="popover-item" data-pp-action="copy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy model ID
      </button>
    `;
    document.body.appendChild(pop);

    /* Position next to the anchor */
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    anchor.classList.add('is-popover-open');

    pop.querySelectorAll('[data-pp-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-pp-action');
        if (act === 'add') {
          addMappingRow({ provider: model });
          toast(`New mapping row added. Set the Claude model name and click Save Router.`, 'info', 'Mapping added');
        } else if (act === 'replace') {
          if (!state.selectedMapping) {
            toast('Select a mapping row first to replace its target.', 'warn', 'No selection');
            return;
          }
          state.mappings[state.selectedMapping] = model;
          renderMappingsTable();
          renderAutoFallback();
          renderAvailableModels();
          toast(`Replaced "${state.selectedMapping}" → ${model}. Click Save Router to apply.`, 'ok', 'Replaced');
        } else if (act === 'default') {
          const inp = $('#default-model-input');
          if (inp) inp.value = model;
          state.defaultModel = model;
          renderFamilyRules();
          renderRouterHealth();
          renderAutoFallback();
          toast(`Default fallback set to ${model}. Click Save Router to apply.`, 'ok', 'Default updated');
        } else if (act === 'test') {
          toast(`Testing provider model: ${model}…`, 'info', 'Test');
          switchView('playground');
          setTimeout(() => {
            const pgModel = $('#pg-model');
            if (pgModel) pgModel.value = model;
          }, 250);
        } else if (act === 'copy') {
          navigator.clipboard?.writeText(model);
          toast(`Copied: ${model}`, 'ok', 'Copied');
        }
        closeProviderPillPopover();
      });
    });

    activePopover = pop;
    setTimeout(() => {
      document.addEventListener('click', closeProviderPillPopoverOnOutside, { once: true });
    }, 0);
  }
  function closeProviderPillPopover() {
    if (activePopover) {
      activePopover.remove();
      activePopover = null;
    }
    $$('.provider-pill.is-popover-open').forEach((p) => p.classList.remove('is-popover-open'));
  }
  function closeProviderPillPopoverOnOutside(ev) {
    if (activePopover && !activePopover.contains(ev.target) && !ev.target.closest('.provider-pill')) {
      closeProviderPillPopover();
    } else if (activePopover) {
      document.addEventListener('click', closeProviderPillPopoverOnOutside, { once: true });
    }
  }

  /* ── Toolbar actions ──────────────────────────────────────────── */
  const addMappingBtn = $('#add-mapping');
  if (addMappingBtn) {
    addMappingBtn.addEventListener('click', () => {
      rebuildMappingFromTable();
      addMappingRow();
    });
  }

  const saveMappingsBtn = $('#save-mappings');
  if (saveMappingsBtn) {
    saveMappingsBtn.addEventListener('click', async () => {
      rebuildMappingFromTable();
      const status = $('#mappings-status');
      status.textContent = ''; status.className = 'status-line';
      saveMappingsBtn.classList.add('btn-loading');
      try {
        // Save exact mappings + default
        const updated = await api('PUT', '/models/mappings', { mappings: state.mappings, default: $('#default-model-input').value.trim() });
        state.mappings = updated.mappings || {};
        state.savedMappings = { ...(updated.mappings || {}) };
        state.defaultModel = updated.default || '';
        state.suggestions = [];
        state.defaultSuggestion = null;

        // Also save family rules — collect latest values directly from the rendered inputs
        // so we capture any edits the user made in the table before hitting Save Router
        const familyInputRows = document.querySelectorAll('#router-family-tbody tr[data-rule-index]');
        if (familyInputRows.length > 0) {
          const rulesPayload = Array.from(familyInputRows).map((row) => {
            const idx = parseInt(row.getAttribute('data-rule-index') || '0', 10);
            const base = state.familyRules[idx] || {};
            const primaryInp = row.querySelector('.family-primary-input');
            const backupInp = row.querySelector('.family-backup-input');
            const rule = {
              name: base.name || '',
              pattern: base.pattern || '',
              primary: (primaryInp ? primaryInp.value.trim() : '') || base.primary || '',
            };
            const backupVal = backupInp ? backupInp.value.trim() : '';
            if (backupVal) rule.backup = backupVal;
            return rule;
          }).filter((r) => r.name && r.pattern && r.primary);

          if (rulesPayload.length > 0) {
            const rulesUpdated = await api('PUT', '/models/family-rules', rulesPayload);
            state.familyRules = rulesUpdated.familyRules || state.familyRules;
          }
        }

        renderMappingsTable();
        renderApplySuggestionsBar();
        renderRouterHealth();
        renderFamilyRules();
        renderAutoFallback();
        renderAvailableModels();
        status.textContent = '✓ Router saved'; status.classList.add('ok');
        toast('Model router saved (mappings + family rules)', 'ok', 'Saved');

        // ── Auto-snapshot for active provider ──────────────────
        // Silently save the current router state against the active provider
        // so switching away and back restores these exact mappings.
        if (providerState.activeId) {
          api('POST', `/providers/${providerState.activeId}/save-snapshot`).catch(() => {});
        }
      } catch (err) {
        status.textContent = err.message; status.classList.add('err');
        toast(err.message, 'error', 'Save failed');
      } finally {
        saveMappingsBtn.classList.remove('btn-loading');
      }
    });
  }

  const testDefaultBtn = $('#test-default-model');
  if (testDefaultBtn) {
    testDefaultBtn.addEventListener('click', () => {
      switchView('playground');
      setTimeout(() => {
        const pgModel = $('#pg-model');
        const pgMessage = $('#pg-message');
        if (pgModel) pgModel.value = $('#default-model-input')?.value || '';
        if (pgMessage) pgMessage.value = 'Hello from the default model test.';
      }, 250);
    });
  }

  /* Set All to Default — replace every mapping's provider model with the current default fallback */
  const setAllToDefaultBtn = $('#set-all-to-default-btn');
  if (setAllToDefaultBtn) {
    setAllToDefaultBtn.addEventListener('click', () => {
      const defaultValue = ($('#default-model-input')?.value || '').trim();
      if (!defaultValue) {
        toast('Set a Default Fallback Model first.', 'warn', 'Nothing to apply');
        return;
      }
      const count = Object.keys(state.mappings || {}).length;
      if (count === 0) {
        toast('No mappings to update.', 'info', 'Nothing to apply');
        return;
      }
      if (!confirm(`Replace all ${count} mapping(s) with "${defaultValue}"? Click Save Router to persist.`)) return;
      rebuildMappingFromTable();
      for (const key of Object.keys(state.mappings)) {
        state.mappings[key] = defaultValue;
      }
      renderMappingsTable();
      renderRouterHealth();
      toast(`${count} mapping${count === 1 ? '' : 's'} set to "${defaultValue}". Click Save Router to persist.`, 'ok', 'Updated');
    });
  }

  /* Empty-state actions for the mapping table */
  const emptyAddMapping = $('#empty-add-mapping');
  if (emptyAddMapping) {
    emptyAddMapping.addEventListener('click', () => addMappingBtn?.click());
  }
  const emptyAddRecommended = $('#empty-add-recommended');
  if (emptyAddRecommended) {
    emptyAddRecommended.addEventListener('click', () => {
      rebuildMappingFromTable();
      RECOMMENDED_MAPPINGS.forEach((m) => {
        if (!state.mappings[m.claude]) state.mappings[m.claude] = m.provider;
      });
      renderMappingsTable();
      renderRouterHealth();
      renderAutoFallback();
      renderAvailableModels();
      toast(`Added ${RECOMMENDED_MAPPINGS.length} recommended mapping${RECOMMENDED_MAPPINGS.length === 1 ? '' : 's'}. Click Save Router to apply.`, 'ok', 'Added');
    });
  }
  const emptySyncModels = $('#empty-sync-models');
  if (emptySyncModels) {
    emptySyncModels.addEventListener('click', () => $('#refresh-available')?.click());
  }

  /* Default model input live update */
  const defaultModelInput = $('#default-model-input');
  if (defaultModelInput) {
    defaultModelInput.addEventListener('input', () => {
      state.defaultModel = defaultModelInput.value.trim();
      renderFamilyRules();
      renderRouterHealth();
      renderAutoFallback();
    });
  }

  /* Available models toolbar */
  const availableSearch = $('#available-search');
  if (availableSearch) {
    availableSearch.addEventListener('input', () => {
      state.availableSearch = availableSearch.value;
      renderAvailableModels();
    });
  }
  $$('[data-available-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.availableFilter = btn.getAttribute('data-available-filter');
      $$('[data-available-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderAvailableModels();
    });
  });
  const availableDeselect = $('#available-deselect');
  if (availableDeselect) {
    availableDeselect.addEventListener('click', () => {
      state.selectedMapping = null;
      renderMappingsTable();
    });
  }

  /* ── Auto-Map button ─────────────────────────────────────────── */
  const autoMapBtn = $('#auto-map-btn');
  if (autoMapBtn) {
    autoMapBtn.addEventListener('click', () => {
      if (state.availableModels.length > 0) runAutoMap();
    });
  }

  /* ── Fetch available models ──────────────────────────────────────── */
  const refreshAvailableBtn = $('#refresh-available');
  if (refreshAvailableBtn) {
    refreshAvailableBtn.addEventListener('click', async () => {
      const list = $('#available-body');
      const errEl = $('#available-error');
      const label = $('#available-count-label');
      list.innerHTML = '<div class="router-section-empty"><span class="router-section-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg></span>Syncing models from provider…</div>';
      errEl.textContent = '';
      if (label) label.textContent = 'Syncing…';
      refreshAvailableBtn.classList.add('btn-loading');
      try {
        const data = await api('GET', '/models/available');
        state.availableModels = data.models || [];
        state.availableModelsCachedAt = data.syncedAt || null;
        state.suggestions = [];
        state.defaultSuggestion = null;
        renderAvailableModels();
        renderSetupChecklist();
        updateAutoMapButton();
      } catch (err) {
        errEl.textContent = err.message;
        list.innerHTML = '<div class="router-section-empty"><span class="router-section-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></span>Sync failed. Check provider connection.</div>';
        if (label) label.textContent = 'Sync failed';
      } finally {
        refreshAvailableBtn.classList.remove('btn-loading');
      }
    });
  }

  /* ── Export Mappings ─────────────────────────────────────────────── */
  const exportMappingsBtn = $('#export-mappings');
  if (exportMappingsBtn) {
    exportMappingsBtn.addEventListener('click', () => {
      const data = {
        mappings: state.mappings || {},
        default: ($('#default-model-input')?.value || '').trim(),
        exportedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fcc-gateway-mappings-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Mappings exported', 'ok', 'Downloaded');
    });
  }

  /* When the request buffer changes, recompute router-dependent panels */
  const _origPushRequestEntry = pushRequestEntry;
  pushRequestEntry = function (entry) {
    _origPushRequestEntry(entry);
    if (state.view === 'models' || state.view === 'requests') {
      renderRouterHealth();
      renderAutoFallback();
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     SECTION 20 — Connection Test
     ══════════════════════════════════════════════════════════════════ */
  const testConnBtn = $('#test-connection');
  if (testConnBtn) {
    testConnBtn.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const result = $('#test-result');
      btn.classList.add('btn-loading');
      result.hidden = false;
      result.className = 'test-result';
      result.innerHTML = '<p style="color:var(--text-muted)">Sending test request…</p>';
      try {
        const data = await api('POST', '/test-connection');
        if (data.success) {
          result.classList.add('ok');
          result.innerHTML = `
            <div class="test-result-head">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <strong>Connection succeeded</strong>
            </div>
            <div class="test-result-meta">
              <span>Status: <code>${data.upstreamStatus}</code></span>
              <span>Latency: <code>${fmt.ms(data.latencyMs)}</code></span>
            </div>
            <pre>${escapeHtml(data.preview || '(empty response)')}</pre>`;
        } else {
          result.classList.add('err');
          result.innerHTML = `
            <div class="test-result-head">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <strong>Connection failed</strong>
            </div>
            <div class="test-result-meta">
              <span>Status: <code>${data.upstreamStatus ?? '—'}</code></span>
              <span>Latency: <code>${fmt.ms(data.latencyMs)}</code></span>
            </div>
            <pre>${escapeHtml(data.error)}</pre>`;
        }
      } catch (err) {
        result.classList.add('err');
        result.innerHTML = `<div class="test-result-head"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><strong>${escapeHtml(err.message)}</strong></div>`;
      } finally {
        btn.classList.remove('btn-loading');
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 21 — Playground
     ══════════════════════════════════════════════════════════════════ */
  const pgOutput = $('#pg-output');
  const pgMeta = $('#pg-meta');
  const pgResponseStatus = $('#pg-response-status');

  /* Wire up live value display for sliders */
  const sliderBindings = [
    { input: '#pg-temp', val: '#pg-temp-val', decimals: 1 },
    { input: '#pg-maxtok', val: '#pg-maxtok-val', decimals: 0 },
    { input: '#pg-topp', val: '#pg-topp-val', decimals: 2 },
  ];
  sliderBindings.forEach(({ input, val, decimals }) => {
    const inp = $(input);
    const v = $(val);
    if (!inp || !v) return;
    const update = () => {
      v.textContent = Number(inp.value).toFixed(decimals);
      const min = Number(inp.min);
      const max = Number(inp.max);
      const pct = ((inp.value - min) / (max - min)) * 100;
      inp.style.setProperty('--val-pct', pct + '%');
    };
    inp.addEventListener('input', update);
    update();
  });

  function buildPgBody() {
    const endpoint = $('#pg-endpoint').value;
    const model = $('#pg-model').value.trim();
    const system = $('#pg-system').value.trim();
    const message = $('#pg-message').value.trim();
    const temp = Number($('#pg-temp').value);
    const maxTokens = Number($('#pg-maxtok').value);
    const topP = Number($('#pg-topp').value);
    const stream = $('#pg-stream').checked;

    if (endpoint === 'claude') {
      const body = { model, max_tokens: maxTokens, stream };
      if (system) body.system = system;
      body.messages = [{ role: 'user', content: message }];
      if (!isNaN(temp)) body.temperature = temp;
      if (!isNaN(topP) && topP < 1) body.top_p = topP;
      return { url: '/v1/messages', body };
    } else {
      const msgs = [];
      if (system) msgs.push({ role: 'system', content: system });
      msgs.push({ role: 'user', content: message });
      const body = { model, max_tokens: maxTokens, stream, messages: msgs };
      if (!isNaN(temp)) body.temperature = temp;
      if (!isNaN(topP) && topP < 1) body.top_p = topP;
      return { url: '/v1/chat/completions', body };
    }
  }

  function buildPgCurl(endpoint) {
    const { url, body } = buildPgBody();
    return `curl -X POST ${getProxyBase()}${url} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
  }

  function setPgRunning(running) {
    state.pgRunning = running;
    const btn = $('#pg-run');
    if (!btn) return;
    if (running) btn.classList.add('btn-loading');
    else btn.classList.remove('btn-loading');
  }

  function updatePgDebugTabs(body, curl, response) {
    const rawReqEl = $('#pg-debug-req');
    const convertedEl = $('#pg-debug-converted');
    const rawResEl = $('#pg-debug-res');
    const curlEl = $('#pg-debug-curl');

    if (rawReqEl) rawReqEl.textContent = body ? JSON.stringify(body, null, 2) : '// Send a request to see the raw Claude/OpenAI body';
    if (convertedEl) convertedEl.textContent = body ? JSON.stringify(body, null, 2) : '// The translated provider payload will appear here';
    if (rawResEl) rawResEl.textContent = response ? (typeof response === 'string' ? response : JSON.stringify(response, null, 2)) : '// The provider\'s raw response will appear here';
    if (curlEl) curlEl.textContent = curl || '// cURL command will appear here';
  }

  function setPgTab(tab) {
    $$('.pg-debug-tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
    $$('.pg-debug-content').forEach((tc) => tc.classList.toggle('hidden', tc.id !== `tab-${tab}`));
  }

  /* ── Debug tabs switching ────────────────────────────────────────── */
  const debugTabsEl = $('#pg-debug-panel');
  if (debugTabsEl) {
    debugTabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.pg-debug-tab');
      if (!btn) return;
      const tabId = btn.getAttribute('data-tab');
      setPgTab(tabId);
    });
  }

  function renderPgResponse(text, ok = true) {
    if (!pgOutput) return;
    if (pgResponseStatus) {
      pgResponseStatus.className = `pg-response-status ${ok ? 'success' : 'error'}`;
      pgResponseStatus.innerHTML = ok
        ? '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Success'
        : '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/></svg> Error';
    }
    pgOutput.innerHTML = `<pre style="white-space:pre-wrap; word-break:break-word; margin:0; font-family:var(--mono); font-size:13px; line-height:1.7">${escapeHtml(text)}</pre>`;
  }

  function renderPgLoading() {
    if (!pgOutput) return;
    pgOutput.innerHTML = `
      <div class="pg-loading">
        <div class="pg-loading-spinner"></div>
        <div class="pg-loading-text">Sending request…</div>
        <div class="pg-loading-sub">Routing through Free Claude Code Gateway</div>
      </div>
    `;
  }

  /* ── Run Test ────────────────────────────────────────────────────── */
  const pgRunBtn = $('#pg-run');
  if (pgRunBtn) {
    pgRunBtn.addEventListener('click', async () => {
      const model = $('#pg-model').value.trim();
      const message = $('#pg-message').value.trim();
      if (!model || !message) { toast('Model and message are required', 'warn', 'Missing input'); return; }

      const { url, body } = buildPgBody();
      const curl = buildPgCurl(url);
      state.lastPgBody = body;
      state.lastPgCurl = curl;

      renderPgLoading();
      pgMeta.hidden = true;
      if (pgResponseStatus) pgResponseStatus.textContent = '';
      setPgRunning(true);

      updatePgDebugTabs(body, curl, null);

      const start = performance.now();

      try {
        if ($('#pg-stream').checked) {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const latency = Math.round(performance.now() - start);

          if (!res.ok) {
            const errText = await res.text();
            renderPgResponse(errText, false);
            pgMeta.hidden = false;
            $('#pg-latency').textContent = `${latency} ms`;
            $('#pg-status-code').textContent = res.status;
            updatePgDebugTabs(body, curl, errText);
            setPgRunning(false);
            return;
          }

          pgOutput.innerHTML = '';
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullText = '';
          let rawChunks = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            rawChunks += chunk;
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.delta?.text) { fullText += parsed.delta.text; }
                if (parsed.choices?.[0]?.delta?.content) { fullText += parsed.choices[0].delta.content; }
              } catch { /* skip malformed */ }
            }
            renderPgResponse(fullText, true);
            pgOutput.scrollTop = pgOutput.scrollHeight;
          }
          pgMeta.hidden = false;
          $('#pg-latency').textContent = `${latency} ms`;
          $('#pg-status-code').textContent = res.status;
          $('#pg-in-tok').textContent = '—';
          $('#pg-out-tok').textContent = '—';
          $('#pg-cost').textContent = '—';
          state.lastPgResponse = rawChunks;
          updatePgDebugTabs(body, curl, rawChunks);
        } else {
          const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const latency = Math.round(performance.now() - start);
          const data = await res.json().catch(() => ({}));
          state.lastPgResponse = data;

          if (!res.ok) {
            renderPgResponse(JSON.stringify(data, null, 2), false);
          } else {
            let text = '';
            if (data.content?.[0]?.text) {
              text = data.content[0].text;
            } else if (data.choices?.[0]?.message?.content) {
              text = data.choices[0].message.content;
            } else {
              text = JSON.stringify(data, null, 2);
            }
            renderPgResponse(text, true);
          }
          pgMeta.hidden = false;
          $('#pg-latency').textContent = `${latency} ms`;
          $('#pg-status-code').textContent = res.status;
          const inTok = data.usage?.input_tokens || data.usage?.prompt_tokens || 0;
          const outTok = data.usage?.output_tokens || data.usage?.completion_tokens || 0;
          $('#pg-in-tok').textContent = fmt.n(inTok);
          $('#pg-out-tok').textContent = fmt.n(outTok);

          const inputPrice = Number($('#input-price')?.value || 0);
          const outputPrice = Number($('#output-price')?.value || 0);
          const cost = (inTok * inputPrice + outTok * outputPrice) / 1_000_000;
          $('#pg-cost').textContent = cost > 0 ? fmt.money(cost) : '—';

          updatePgDebugTabs(body, curl, data);
        }
      } catch (err) {
        const latency = Math.round(performance.now() - start);
        renderPgResponse(err.message, false);
        pgMeta.hidden = false;
        $('#pg-latency').textContent = `${latency} ms`;
        $('#pg-status-code').textContent = '—';
        updatePgDebugTabs(body, curl, { error: err.message });
      } finally {
        setPgRunning(false);
      }
    });
  }

  /* ── Copy cURL ───────────────────────────────────────────────────── */
  const pgCopyCurlBtn = $('#pg-copy-curl');
  if (pgCopyCurlBtn) {
    pgCopyCurlBtn.addEventListener('click', () => {
      const curl = buildPgCurl();
      navigator.clipboard?.writeText(curl);
      toast('cURL copied to clipboard', 'ok', 'Copied');
    });
  }

  /* ── Copy JSON ───────────────────────────────────────────────────── */
  const pgCopyJsonBtn = $('#pg-copy-json');
  if (pgCopyJsonBtn) {
    pgCopyJsonBtn.addEventListener('click', () => {
      const { body } = buildPgBody();
      navigator.clipboard?.writeText(JSON.stringify(body, null, 2)).then(
        () => toast('JSON copied to clipboard', 'ok', 'Copied'),
        () => toast('Failed to copy', 'error', 'Error')
      );
    });
  }

  /* ── Clear Playground ────────────────────────────────────────────── */
  const pgClearBtn = $('#pg-clear');
  if (pgClearBtn) {
    pgClearBtn.addEventListener('click', () => {
      pgOutput.innerHTML = '<div class="empty-state"><div class="empty-state-icon-lg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></div><h3>Ready to test</h3><p>Configure your request on the left and click Run Request to see the response.</p></div>';
      pgMeta.hidden = true;
      if (pgResponseStatus) pgResponseStatus.textContent = '';
      state.lastPgBody = null;
      state.lastPgResponse = null;
      state.lastPgCurl = '';
      updatePgDebugTabs(null, '', null);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 22 — Providers (full multi-provider management)
     ══════════════════════════════════════════════════════════════════ */

  // Internal providers state
  const providerState = {
    providers: [],   // ProviderSnapshot[]
    activeId: null,  // string | null
  };

  // ── Helpers ───────────────────────────────────────────────────

  function providerInitials(name) {
    if (!name) return '?';
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function providerAvatarColor(id) {
    // Deterministic color from id
    const palette = [
      '#2563EB', '#7C3AED', '#10B981', '#F59E0B',
      '#EF4444', '#06B6D4', '#EC4899', '#6366F1',
    ];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }

  // ── Render active banner ──────────────────────────────────────

  function renderActiveBanner() {
    const banner = $('#provider-active-banner');
    if (!banner) return;
    if (!providerState.activeId) {
      banner.style.display = 'none';
      return;
    }
    const p = providerState.providers.find((x) => x.id === providerState.activeId);
    if (!p) { banner.style.display = 'none'; return; }
    banner.style.display = 'flex';
    const nameEl = $('#provider-active-name');
    const metaEl = $('#provider-active-meta');
    if (nameEl) nameEl.textContent = p.name;
    if (metaEl) metaEl.textContent = `· ${p.defaultModel} · ${p.baseUrl}`;
  }

  // ── Render cards ──────────────────────────────────────────────

  function renderProviderCards() {
    const container = $('#provider-cards');
    const emptyEl = $('#provider-empty');
    if (!container) return;

    if (providerState.providers.length === 0) {
      container.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    container.innerHTML = providerState.providers.map((p) => {
      const isActive = p.id === providerState.activeId;
      const color = providerAvatarColor(p.id);
      const initials = escapeHtml(providerInitials(p.name));

      const activeBadge = isActive
        ? `<span class="provider-active-badge">Live</span>`
        : '';

      const activateOrActive = isActive
        ? `<button class="pc-btn pc-active-indicator" type="button" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Active
           </button>`
        : `<button class="pc-btn pc-activate" data-action="activate" data-id="${escapeAttr(p.id)}" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Set Active
           </button>`;

      return `
        <div class="provider-card stagger-item${isActive ? ' is-active' : ''}" data-id="${escapeAttr(p.id)}">
          <div class="provider-card-body">

            <!-- Header -->
            <div class="provider-card-header">
              <div class="provider-card-avatar" style="background:${color}">${initials}</div>
              <div class="provider-card-meta">
                <div class="provider-card-name-row">
                  <span class="provider-card-name" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</span>
                  ${activeBadge}
                </div>
                <span class="provider-card-url" title="${escapeAttr(p.baseUrl)}">${escapeHtml(p.baseUrl)}</span>
              </div>
            </div>

            <!-- Info chips -->
            <div class="provider-card-info-grid">
              <div class="provider-info-chip">
                <span class="provider-info-chip-label">Default Model</span>
                <span class="provider-info-chip-value" title="${escapeAttr(p.defaultModel)}">${escapeHtml(p.defaultModel) || '—'}</span>
              </div>
              <div class="provider-info-chip">
                <span class="provider-info-chip-label">API Key</span>
                <span class="provider-info-chip-value ${p.apiKeySet ? 'key-set' : 'key-missing'}">
                  ${p.apiKeySet ? escapeHtml(p.apiKeyPreview) : 'Not set'}
                </span>
              </div>
            </div>

            ${p.notes ? `<div class="provider-card-notes-row" title="${escapeAttr(p.notes)}">💬 ${escapeHtml(p.notes)}</div>` : ''}

          </div>

          <!-- Footer action bar -->
          <div class="provider-card-footer">
            ${activateOrActive}
            <button class="pc-btn" data-action="test" data-id="${escapeAttr(p.id)}" type="button" title="Test connection">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              Test
            </button>
            <button class="pc-btn" data-action="sync" data-id="${escapeAttr(p.id)}" type="button" title="Sync models">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
              Sync
            </button>
            <button class="pc-btn" data-action="edit" data-id="${escapeAttr(p.id)}" type="button" title="Edit provider">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="pc-btn pc-delete" data-action="delete" data-id="${escapeAttr(p.id)}" type="button" title="Delete provider">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Bind card actions
    container.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', handleProviderCardAction);
    });
  }

  // ── Card action handler ───────────────────────────────────────

  async function handleProviderCardAction(e) {
    const btn = e.currentTarget;
    const action = btn.getAttribute('data-action');
    const id = btn.getAttribute('data-id');
    if (!action || !id) return;

    if (action === 'activate') {
      btn.disabled = true;
      btn.textContent = 'Activating…';
      try {
        const data = await api('POST', `/providers/${id}/activate`);
        providerState.activeId = data.activeId;
        renderActiveBanner();
        renderProviderCards();
        loadConfig();
        if (typeof window.__refreshProviderSwitcher === 'function') {
          window.__refreshProviderSwitcher();
        }
        if (data.restored) {
          // Snapshot was restored immediately — reload mappings right away
          if (typeof loadMappings === 'function') await loadMappings();
          const p = providerState.providers.find((x) => x.id === id);
          toast(`Switched to ${p?.name || 'provider'}. Your saved mappings have been restored.`, 'ok', 'Provider Restored');
        } else {
          toast(`Switched to provider. Syncing model mappings…`, 'ok', 'Provider Switched');
          // New provider — wait for background remap then reload
          setTimeout(async () => {
            if (typeof loadMappings === 'function') {
              await loadMappings();
              toast('Model Router updated to new provider.', 'ok', 'Mappings Updated');
            }
          }, 2500);
        }
      } catch (err) {
        toast(err.message || 'Failed to activate provider.', 'error');
        btn.disabled = false;
        btn.textContent = 'Set Active';
      }
      return;
    }

    if (action === 'test') {
      const card = btn.closest('.provider-card');
      btn.disabled = true;
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>Testing…';
      try {
        const result = await api('POST', `/providers/${id}/test`);
        if (result.success) {
          toast(`Connected in ${result.latencyMs}ms${result.preview ? ` · "${result.preview.slice(0, 60)}"` : ''}`, 'ok', 'Connection OK');
        } else {
          toast(result.error || 'Connection failed', 'error', 'Test Failed');
        }
      } catch (err) {
        toast(err.message || 'Test request failed.', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Test';      }
      return;
    }

    if (action === 'sync') {
      btn.disabled = true;
      btn.textContent = 'Syncing…';
      try {
        const result = await api('POST', `/providers/${id}/sync-models`);
        if (result.remapped) {
          // Active provider — all mappings + family rules updated
          toast(
            `Synced ${result.models.length} models · all mappings updated to ${escapeHtml(result.target)}`,
            'ok',
            'Sync Complete',
          );
          // Reload Model Router to reflect updated mappings
          if (typeof loadMappings === 'function') await loadMappings();
          // Auto-save snapshot for this provider
          if (providerState.activeId === id) {
            api('POST', `/providers/${id}/save-snapshot`).catch(() => {});
          }
        } else {
          toast(`Synced ${result.models.length} models from provider.`, 'ok', 'Models Synced');
        }
      } catch (err) {
        toast(err.message || 'Sync failed.', 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>Sync';
      }
      return;
    }

    if (action === 'edit') {
      const p = providerState.providers.find((x) => x.id === id);
      if (p) openProviderModal(p);
      return;
    }

    if (action === 'delete') {
      if (!confirm(`Delete provider "${providerState.providers.find((x) => x.id === id)?.name}"?\nThis cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await api('DELETE', `/providers/${id}`);
        providerState.providers = providerState.providers.filter((x) => x.id !== id);
        renderActiveBanner();
        renderProviderCards();
        toast('Provider deleted.', 'ok');
      } catch (err) {
        toast(err.message || 'Delete failed.', 'error');
        btn.disabled = false;
      }
      return;
    }
  }

  // ── Load providers from API ───────────────────────────────────

  async function loadProviders() {
    try {
      const data = await api('GET', '/providers');
      providerState.providers = data.providers || [];
      providerState.activeId = data.activeId || null;
    } catch (err) {
      providerState.providers = [];
      providerState.activeId = null;
    }
    renderActiveBanner();
    renderProviderCards();
    if (typeof window.__refreshProviderSwitcher === 'function') {
      window.__refreshProviderSwitcher();
    }
  }

  // ── Main renderProviders (called on view switch) ──────────────

  function renderProviders() {
    loadProviders();
  }

  // ── Deactivate btn ────────────────────────────────────────────

  const providerDeactivateBtn = $('#provider-deactivate-btn');
  if (providerDeactivateBtn) {
    providerDeactivateBtn.addEventListener('click', async () => {
      try {
        await api('POST', '/providers/deactivate');
        providerState.activeId = null;
        renderActiveBanner();
        renderProviderCards();
        toast('Reverted to .env defaults.', 'info');
        loadConfig();
      } catch (err) {
        toast(err.message || 'Failed to deactivate.', 'error');
      }
    });
  }

  // ── Add Provider btn ──────────────────────────────────────────

  const providerAddBtn = $('#provider-add-btn');
  if (providerAddBtn) providerAddBtn.addEventListener('click', () => openProviderModal(null));

  const providerEmptyAdd = $('#provider-empty-add');
  if (providerEmptyAdd) providerEmptyAdd.addEventListener('click', () => openProviderModal(null));

  // ── Modal open / close ────────────────────────────────────────

  function openProviderModal(provider) {
    const overlay = $('#provider-modal-overlay');
    const title = $('#provider-modal-title');
    const idInput = $('#provider-modal-id');
    const nameInput = $('#pf-name');
    const urlInput = $('#pf-baseurl');
    const keyInput = $('#pf-apikey');
    const modelInput = $('#pf-model');
    const notesInput = $('#pf-notes');
    const keyHint = $('#pf-apikey-hint');
    const testResult = $('#pf-test-result');
    if (!overlay) return;

    if (provider) {
      title.textContent = 'Edit Provider';
      idInput.value = provider.id;
      nameInput.value = provider.name;
      urlInput.value = provider.baseUrl;
      keyInput.value = '';           // never pre-fill key
      keyInput.placeholder = provider.apiKeySet ? '(unchanged — enter new key to replace)' : 'sk-…';
      modelInput.value = provider.defaultModel;
      notesInput.value = provider.notes || '';
      if (keyHint) keyHint.textContent = 'Leave blank to keep existing key.';
    } else {
      title.textContent = 'Add Provider';
      idInput.value = '';
      nameInput.value = '';
      urlInput.value = '';
      keyInput.value = '';
      keyInput.placeholder = 'sk-…';
      modelInput.value = '';
      notesInput.value = '';
      if (keyHint) keyHint.textContent = 'Your API key is stored locally and never sent to the browser in full.';
    }

    if (testResult) { testResult.textContent = ''; testResult.className = 'pf-test-result'; }
    overlay.classList.remove('hidden');
    setTimeout(() => nameInput?.focus(), 80);
    // Reset model combo so stale models from previous session don't show
    if (typeof resetModelCombo === 'function') resetModelCombo();
  }

  function closeProviderModal() {
    const overlay = $('#provider-modal-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  const modalClose = $('#provider-modal-close');
  const pfCancel = $('#pf-cancel-btn');
  const modalOverlay = $('#provider-modal-overlay');

  if (modalClose) modalClose.addEventListener('click', closeProviderModalWithReset);
  if (pfCancel) pfCancel.addEventListener('click', closeProviderModalWithReset);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeProviderModalWithReset();
    });
  }

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOverlay && !modalOverlay.classList.contains('hidden')) {
      closeProviderModalWithReset();
    }
  });

  // ── API Key show/hide ─────────────────────────────────────────

  const pfEyeBtn = $('#pf-apikey-toggle');
  if (pfEyeBtn) {
    pfEyeBtn.addEventListener('click', () => {
      const input = $('#pf-apikey');
      const icon = $('#pf-eye-icon');
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      if (icon) {
        icon.innerHTML = showing
          ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
          : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
      }
    });
  }

  // ── Model combo dropdown helpers ─────────────────────────────

  // Cached models for the current modal session
  let pfFetchedModels = [];

  function renderModelCombo(models, currentValue) {
    const arrow = $('#pf-model-arrow');
    const dropdown = $('#pf-model-dropdown');
    const hint = $('#pf-model-hint');
    if (!arrow || !dropdown) return;

    pfFetchedModels = models || [];

    if (pfFetchedModels.length === 0) {
      arrow.style.display = 'none';
      dropdown.classList.add('hidden');
      return;
    }

    // Show arrow button
    arrow.style.display = 'grid';

    // Update hint
    if (hint) hint.textContent = `${pfFetchedModels.length} models available — select one or type your own.`;

    // Build dropdown HTML
    function buildList(filter) {
      const filtered = filter
        ? pfFetchedModels.filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
        : pfFetchedModels;
      const cur = $('#pf-model')?.value?.trim();
      if (filtered.length === 0) {
        return `<div class="model-combo-empty">No models match "${escapeHtml(filter)}"</div>`;
      }
      return filtered.map((m) => {
        const isSel = m === cur;
        const checkSvg = isSel
          ? `<svg class="model-combo-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
          : `<span style="width:12px;flex-shrink:0"></span>`;
        return `<button class="model-combo-item${isSel ? ' selected' : ''}" data-model="${escapeAttr(m)}" type="button">${checkSvg}${escapeHtml(m)}</button>`;
      }).join('');
    }

    dropdown.innerHTML = `
      <div class="model-combo-search-wrap">
        <input class="model-combo-search" id="pf-model-search" type="text" placeholder="Filter models…" autocomplete="off" />
      </div>
      <div class="model-combo-list" id="pf-model-list">${buildList('')}</div>
      <div class="model-combo-count" id="pf-model-count">${pfFetchedModels.length} models</div>
    `;

    // Search filter
    const searchInput = $('#pf-model-search');
    const listEl = $('#pf-model-list');
    const countEl = $('#pf-model-count');
    if (searchInput && listEl) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        listEl.innerHTML = buildList(q);
        if (countEl) {
          const n = q
            ? pfFetchedModels.filter((m) => m.toLowerCase().includes(q.toLowerCase())).length
            : pfFetchedModels.length;
          countEl.textContent = `${n} of ${pfFetchedModels.length} models`;
        }
        bindComboItems();
      });
    }

    bindComboItems();
  }

  function bindComboItems() {
    const dropdown = $('#pf-model-dropdown');
    if (!dropdown) return;
    dropdown.querySelectorAll('.model-combo-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-model');
        const input = $('#pf-model');
        if (input && val) input.value = val;
        closeModelCombo();
      });
    });
  }

  function openModelCombo() {
    const dropdown = $('#pf-model-dropdown');
    const arrow = $('#pf-model-arrow');
    if (!dropdown || pfFetchedModels.length === 0) return;
    // Re-render to update selected state
    renderModelCombo(pfFetchedModels, $('#pf-model')?.value);
    dropdown.classList.remove('hidden');
    if (arrow) arrow.classList.add('open');
    // Focus the search box
    setTimeout(() => $('#pf-model-search')?.focus(), 50);
  }

  function closeModelCombo() {
    const dropdown = $('#pf-model-dropdown');
    const arrow = $('#pf-model-arrow');
    if (dropdown) dropdown.classList.add('hidden');
    if (arrow) arrow.classList.remove('open');
  }

  // Arrow button toggle
  const pfModelArrow = $('#pf-model-arrow');
  if (pfModelArrow) {
    pfModelArrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = $('#pf-model-dropdown');
      if (dropdown && !dropdown.classList.contains('hidden')) closeModelCombo();
      else openModelCombo();
    });
  }

  // Close combo when clicking outside modal
  document.addEventListener('click', (e) => {
    const combo = $('#pf-model-combo');
    if (combo && !combo.contains(e.target)) closeModelCombo();
  });

  // Also trigger open on input focus if we have models cached
  const pfModelInput = $('#pf-model');
  if (pfModelInput) {
    pfModelInput.addEventListener('focus', () => {
      if (pfFetchedModels.length > 0) openModelCombo();
    });
    pfModelInput.addEventListener('input', () => {
      // Sync filter with search box if dropdown is open
      const dropdown = $('#pf-model-dropdown');
      if (dropdown && !dropdown.classList.contains('hidden')) {
        const search = $('#pf-model-search');
        if (search) {
          search.value = pfModelInput.value;
          search.dispatchEvent(new Event('input'));
        }
      }
    });
  }

  // Reset combo when modal closes
  function resetModelCombo() {
    pfFetchedModels = [];
    const arrow = $('#pf-model-arrow');
    const dropdown = $('#pf-model-dropdown');
    const hint = $('#pf-model-hint');
    if (arrow) { arrow.style.display = 'none'; arrow.classList.remove('open'); }
    if (dropdown) { dropdown.innerHTML = ''; dropdown.classList.add('hidden'); }
    if (hint) hint.textContent = 'Used for connection tests and as the fallback model.';
  }

  // Patch closeProviderModal to also reset combo
  // We do this by overriding the close button and overlay click to also call resetModelCombo.
  // (closeProviderModal is a named function so we wrap the callers instead)
  function closeProviderModalWithReset() {
    closeProviderModal();
    resetModelCombo();
  }

  // ── Test Connection in modal ──────────────────────────────────

  const pfTestBtn = $('#pf-test-btn');
  if (pfTestBtn) {
    pfTestBtn.addEventListener('click', async () => {
      const id = $('#provider-modal-id')?.value?.trim();
      const result = $('#pf-test-result');
      if (!result) return;

      const baseUrl = $('#pf-baseurl')?.value?.trim();
      const apiKey  = $('#pf-apikey')?.value?.trim();
      const modelInput = $('#pf-model');

      if (!baseUrl) { toast('Enter a Base URL first.', 'warn'); return; }

      pfTestBtn.disabled = true;
      result.textContent = 'Fetching models…';
      result.className = 'pf-test-result loading';

      const effectiveKey = apiKey;

      // ── Fetch /models ──────────────────────────────────────────
      // This is the primary connectivity proof: if /models responds with a
      // non-empty list the key and URL are valid.  No need to also hit
      // /chat/completions (which requires knowing a valid model name).
      let fetchedModels = [];
      let modelsOk = false;
      let modelsError = '';
      let latencyMs = 0;

      if (id && !apiKey) {
        // Editing provider with unchanged key — use backend endpoint
        try {
          const start = Date.now();
          const modelsData = await api('POST', `/providers/${id}/sync-models`);
          latencyMs = Date.now() - start;
          fetchedModels = modelsData.models || [];
          modelsOk = true;
        } catch (err) {
          modelsError = err.message || 'Failed to fetch models';
        }
      } else {
        // New provider or key updated — fetch /models directly
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          const start = Date.now();
          const r = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              ...(effectiveKey ? { Authorization: `Bearer ${effectiveKey}` } : {}),
            },
            signal: controller.signal,
          });
          clearTimeout(timer);
          latencyMs = Date.now() - start;

          if (r.ok) {
            const data = await r.json().catch(() => ({}));
            // Handle both { data: [...] } and bare array responses
            const arr = Array.isArray(data?.data)
              ? data.data
              : Array.isArray(data)
                ? data
                : [];
            fetchedModels = arr
              .map((m) => (typeof m === 'string' ? m : m?.id))
              .filter((x) => typeof x === 'string' && x.length > 0);
            modelsOk = true;
          } else {
            const body = await r.json().catch(() => ({}));
            const msg = body?.error?.message || body?.error || `HTTP ${r.status}`;
            modelsError = `${r.status}: ${typeof msg === 'string' ? msg.slice(0, 150) : JSON.stringify(msg).slice(0, 150)}`;
          }
        } catch (err) {
          modelsError = err.name === 'AbortError' ? 'Timeout after 15s' : err.message;
        }
      }

      // ── Update UI ──────────────────────────────────────────────
      if (!modelsOk) {
        result.textContent = `✗ ${modelsError}`;
        result.className = 'pf-test-result err';
        pfTestBtn.disabled = false;
        return;
      }

      if (fetchedModels.length > 0) {
        result.textContent = `✓ ${latencyMs}ms · ${fetchedModels.length} models`;
        result.className = 'pf-test-result ok';

        // Pre-fill model field with first model if still empty
        if (modelInput && !modelInput.value.trim()) {
          modelInput.value = fetchedModels[0];
        }

        renderModelCombo(fetchedModels, modelInput?.value);
        setTimeout(() => openModelCombo(), 120);
      } else {
        // /models succeeded but returned an empty list — still counts as connected
        result.textContent = `✓ Connected · ${latencyMs}ms (no models listed)`;
        result.className = 'pf-test-result ok';
      }

      pfTestBtn.disabled = false;
    });
  }

  // ── Save Provider (Add/Edit) ──────────────────────────────────

  const pfSaveBtn = $('#pf-save-btn');
  if (pfSaveBtn) {
    pfSaveBtn.addEventListener('click', async () => {
      const id = $('#provider-modal-id')?.value?.trim();
      const body = {
        name: $('#pf-name')?.value?.trim(),
        baseUrl: $('#pf-baseurl')?.value?.trim(),
        apiKey: $('#pf-apikey')?.value?.trim(),
        defaultModel: $('#pf-model')?.value?.trim(),
        notes: $('#pf-notes')?.value?.trim() || '',
      };

      pfSaveBtn.disabled = true;
      pfSaveBtn.textContent = 'Saving…';

      try {
        let snap;
        if (id) {
          snap = await api('PUT', `/providers/${id}`, body);
          const idx = providerState.providers.findIndex((p) => p.id === id);
          if (idx >= 0) providerState.providers[idx] = snap;
          toast(`Provider "${snap.name}" updated.`, 'ok');
        } else {
          snap = await api('POST', '/providers', body);
          providerState.providers.push(snap);
          toast(`Provider "${snap.name}" added.`, 'ok');
        }
        closeProviderModalWithReset();
        renderActiveBanner();
        renderProviderCards();
      } catch (err) {
        toast(err.message || 'Save failed.', 'error');
      } finally {
        pfSaveBtn.disabled = false;
        pfSaveBtn.textContent = 'Save Provider';
      }
    });
  }

  // ── Spin animation for test button (reuse) ────────────────────
  const spinStyle = document.createElement('style');
  spinStyle.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
  document.head.appendChild(spinStyle);

  /* ── Topbar Provider Switcher ──────────────────────────────── */
  (function initProviderSwitcher() {
    const switcher = $('#provider-switcher');
    const switcherBtn = $('#provider-switcher-btn');
    const switcherName = $('#provider-switcher-name');
    const switcherMenu = $('#provider-switcher-menu');
    if (!switcher || !switcherBtn || !switcherMenu) return;

    function renderSwitcherMenu() {
      if (providerState.providers.length === 0) {
        switcher.style.display = 'none';
        return;
      }
      switcher.style.display = 'flex';

      // Update button label
      const active = providerState.providers.find((p) => p.id === providerState.activeId);
      if (active) {
        switcherName.textContent = active.name;
      } else {
        switcherName.textContent = '.env defaults';
      }

      // Render menu items
      const checkSvg = `<svg class="provider-switcher-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      const emptySvg = `<span style="width:14px;flex-shrink:0"></span>`;

      let html = '<div class="provider-switcher-header">Switch Provider</div>';
      providerState.providers.forEach((p) => {
        const isActive = p.id === providerState.activeId;
        html += `<button class="provider-switcher-item${isActive ? ' active-item' : ''}" data-switch-id="${escapeAttr(p.id)}" type="button">
          ${isActive ? checkSvg : emptySvg}
          <div style="min-width:0;flex:1">
            <div class="provider-switcher-item-name">${escapeHtml(p.name)}</div>
            <div class="provider-switcher-item-model">${escapeHtml(p.defaultModel)}</div>
          </div>
        </button>`;
      });
      html += '<div class="provider-switcher-divider"></div>';
      if (providerState.activeId) {
        html += `<div class="provider-switcher-footer"><button class="btn btn-ghost btn-sm" style="width:100%;justify-content:center" id="switcher-use-env">Use .env defaults</button></div>`;
      }
      html += `<div class="provider-switcher-footer" style="padding-top:0"><button class="btn btn-outline btn-sm" style="width:100%;justify-content:center" id="switcher-manage">Manage Providers</button></div>`;
      switcherMenu.innerHTML = html;

      // Bind clicks
      switcherMenu.querySelectorAll('[data-switch-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          closeSwitcherMenu();
          const id = btn.getAttribute('data-switch-id');
          if (id === providerState.activeId) return;
          try {
            const data = await api('POST', `/providers/${id}/activate`);
            providerState.activeId = data.activeId;
            renderSwitcherMenu();
            renderActiveBanner();
            renderProviderCards();
            loadConfig();
            if (data.restored) {
              if (typeof loadMappings === 'function') await loadMappings();
              const p = providerState.providers.find((x) => x.id === id);
              toast(`Switched to ${p?.name || 'provider'}. Your saved mappings have been restored.`, 'ok', 'Provider Restored');
            } else {
              const p = providerState.providers.find((x) => x.id === id);
              toast(`Switched to ${p?.name || 'provider'}. Syncing mappings…`, 'ok', 'Provider Switched');
              setTimeout(async () => {
                if (typeof loadMappings === 'function') {
                  await loadMappings();
                  toast('Model Router updated to new provider.', 'ok', 'Mappings Updated');
                }
              }, 2500);
            }
          } catch (err) {
            toast(err.message || 'Failed to switch.', 'error');
          }
        });
      });

      const useEnvBtn = $('#switcher-use-env');
      if (useEnvBtn) {
        useEnvBtn.addEventListener('click', async () => {
          closeSwitcherMenu();
          try {
            await api('POST', '/providers/deactivate');
            providerState.activeId = null;
            renderSwitcherMenu();
            renderActiveBanner();
            renderProviderCards();
            toast('Reverted to .env defaults.', 'info');
            loadConfig();
          } catch (err) {
            toast(err.message || 'Failed.', 'error');
          }
        });
      }

      const manageBtn = $('#switcher-manage');
      if (manageBtn) {
        manageBtn.addEventListener('click', () => {
          closeSwitcherMenu();
          switchView('providers');
        });
      }
    }

    function openSwitcherMenu() {
      renderSwitcherMenu();
      switcherMenu.classList.remove('hidden');
      switcherBtn.setAttribute('aria-expanded', 'true');
    }
    function closeSwitcherMenu() {
      switcherMenu.classList.add('hidden');
      switcherBtn.setAttribute('aria-expanded', 'false');
    }

    switcherBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (switcherMenu.classList.contains('hidden')) openSwitcherMenu();
      else closeSwitcherMenu();
    });

    document.addEventListener('click', (e) => {
      if (!switcher.contains(e.target)) closeSwitcherMenu();
    });

    // Expose refresh function so loadProviders can update it
    window.__refreshProviderSwitcher = renderSwitcherMenu;
  })();

  /* ══════════════════════════════════════════════════════════════════
     SECTION 23 — Diagnostics
     ══════════════════════════════════════════════════════════════════ */
  const diagSteps = [
    {
      id: 'base-url',
      label: 'Validate Base URL',
      description: 'Confirm the upstream base URL is reachable',
      check: async (cfg) => {
        const url = cfg.bluesmindsBaseUrl;
        if (!url || !/^https?:\/\//i.test(url)) {
          return { ok: false, detail: 'Base URL is missing or invalid', error: 'Configuration error' };
        }
        return { ok: true, detail: url, status: 'OK' };
      },
    },
    {
      id: 'api-key',
      label: 'Verify API Key',
      description: 'Confirm the upstream API key is configured',
      check: async (cfg) => {
        if (!cfg.apiKeySet) {
          return { ok: false, detail: 'No API key set', error: 'Authentication required', fix: 'Set PROVIDER_API_KEY in your .env file or update Settings.' };
        }
        return { ok: true, detail: 'API key is configured' };
      },
    },
    {
      id: 'fetch-models',
      label: 'Sync Provider Models',
      description: 'Fetch model catalog from the upstream provider',
      check: async () => {
        try {
          const data = await api('GET', '/models/available');
          const count = (data.models || []).length;
          state.availableModels = data.models || [];
          return { ok: count > 0, detail: count > 0 ? `${count} models available` : 'No models returned', status: `${count}` };
        } catch (err) {
          return {
            ok: false,
            detail: err.message,
            error: 'Model sync failed',
            fix: 'Check provider base URL and API key. Try opening Settings → Test Provider.',
          };
        }
      },
    },
    {
      id: 'test-request',
      label: 'Send Test Request',
      description: 'Send a real "Hello" message through the proxy',
      check: async () => {
        try {
          const data = await api('POST', '/test-connection');
          if (data.success) {
            return { ok: true, detail: `Latency ${fmt.ms(data.latencyMs)} • status ${data.upstreamStatus}`, status: data.upstreamStatus, latency: data.latencyMs };
          }
          let fix = 'Check provider status, model availability, and API quota.';
          if (data.upstreamStatus === 401) fix = 'Update the API key in Settings → Provider Connection.';
          else if (data.upstreamStatus === 403) fix = 'Your account may lack access to this model. Try Sync Models in Model Router.';
          else if (data.upstreamStatus === 404) fix = 'The model name is unknown. Check Model Router mappings.';
          else if (data.upstreamStatus === 429) fix = 'You are rate-limited. Wait and retry, or upgrade your plan.';
          return { ok: false, detail: data.error || 'Request failed', error: `Provider returned ${data.upstreamStatus}`, fix, status: data.upstreamStatus, latency: data.latencyMs };
        } catch (err) {
          return { ok: false, detail: err.message, error: 'Test request failed', fix: 'Verify network and provider status.' };
        }
      },
    },
  ];

  function resetDiagnostics() {
    const timeline = $('#diag-timeline');
    const summary = $('#diag-summary');
    const progress = $('#diag-progress');
    if (!timeline) return;
    summary.hidden = true;
    if (progress) progress.hidden = true;
    state.diagResults = [];
    timeline.innerHTML = diagSteps.map((s, i) => `
      <div class="diag-step" id="diag-${s.id}">
        <div class="diag-dot">${i + 1}</div>
        <div class="diag-info">
          <div class="diag-title">${escapeHtml(s.label)}</div>
          <div class="diag-detail">${escapeHtml(s.description)}</div>
        </div>
      </div>
    `).join('');
  }

  const diagRunBtn = $('#diag-run');
  if (diagRunBtn) {
    diagRunBtn.addEventListener('click', async () => {
      const summary = $('#diag-summary');
      const progress = $('#diag-progress');
      const progressBar = progress ? progress.querySelector('.diag-progress-bar') : null;
      diagRunBtn.classList.add('btn-loading');
      summary.hidden = true;
      if (progress) progress.hidden = false;
      if (progressBar) progressBar.style.width = '0%';

      let allPassed = true;
      let config = {};
      state.diagResults = [];

      try {
        config = await api('GET', '/config');
        state.lastConfig = config;
      } catch { /* proceed anyway */ }

      const total = diagSteps.length;
      for (let i = 0; i < diagSteps.length; i++) {
        const step = diagSteps[i];
        const el = $(`#diag-${step.id}`);
        if (!el) continue;
        el.className = 'diag-step running';
        el.querySelector('.diag-title').textContent = step.label;
        el.querySelector('.diag-detail').innerHTML = '<em style="color:var(--text-muted)">Running…</em>';
        if (progressBar) progressBar.style.width = `${((i) / total) * 100}%`;

        try {
          const result = await step.check(config);
          el.className = `diag-step ${result.ok ? 'pass' : 'fail'}`;
          let detailHtml = `<strong>${escapeHtml(result.detail)}</strong>`;
          if (result.status) detailHtml += ` <span class="status-pill ${statusClass(result.status)}">${result.status}</span>`;
          if (result.latency) detailHtml += ` <span style="color:var(--text-muted)">• ${fmt.ms(result.latency)}</span>`;
          el.querySelector('.diag-detail').innerHTML = detailHtml;
          if (!result.ok) {
            allPassed = false;
            let errorHtml = `<div class="diag-error-panel"><strong>${escapeHtml(result.error || 'Failed')}</strong>${escapeHtml(result.detail || '')}`;
            if (result.fix) {
              errorHtml += `<div style="margin-top:8px; font-size:12px"><strong>Suggested fix:</strong> ${escapeHtml(result.fix)}</div>`;
            }
            errorHtml += '</div>';
            const existing = el.querySelector('.diag-error-panel');
            if (existing) existing.remove();
            el.querySelector('.diag-info').insertAdjacentHTML('beforeend', errorHtml);
          }
          state.diagResults.push({ step: step.label, ok: result.ok, detail: result.detail, status: result.status, latency: result.latency });
        } catch (err) {
          el.className = 'diag-step fail';
          el.querySelector('.diag-detail').innerHTML = `<strong>${escapeHtml(err.message)}</strong>`;
          allPassed = false;
          state.diagResults.push({ step: step.label, ok: false, detail: err.message });
        }
        if (progressBar) progressBar.style.width = `${((i + 1) / total) * 100}%`;
      }

      if (progressBar) progressBar.style.width = '100%';
      summary.hidden = false;
      summary.className = `diag-summary ${allPassed ? 'ok' : 'err'}`;
      const passedCount = state.diagResults.filter((r) => r.ok).length;
      summary.innerHTML = `
        <svg class="diag-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          ${allPassed
            ? '<polyline points="20 6 9 17 4 12"/>'
            : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
        </svg>
        <div>
          <strong>${allPassed ? 'All checks passed' : `${passedCount} of ${total} checks passed`}</strong>
          <div style="font-size:12px; opacity:0.85; font-weight:500; margin-top:2px">${allPassed ? 'Your gateway is healthy and ready to serve traffic.' : 'Review the steps above and apply the suggested fixes.'}</div>
        </div>
      `;
      diagRunBtn.classList.remove('btn-loading');
    });
  }

  /* ── Copy Debug Report ───────────────────────────────────────────── */
  const diagCopyBtn = $('#diag-copy');
  if (diagCopyBtn) {
    diagCopyBtn.addEventListener('click', () => {
      const lines = ['Free Claude Code Gateway — Diagnostic Report', `Date: ${new Date().toISOString()}`, `Gateway URL: ${getProxyBase()}`, ''];
      for (const r of state.diagResults) {
        let line = `${r.ok ? '✓' : '✗'} ${r.step}: ${r.detail}`;
        if (r.status) line += ` [status ${r.status}]`;
        if (r.latency) line += ` (${fmt.ms(r.latency)})`;
        lines.push(line);
      }
      if (state.lastConfig) {
        lines.push('', '--- Configuration ---', `Base URL: ${state.lastConfig.bluesmindsBaseUrl || '—'}`, `Default Model: ${state.lastConfig.defaultModel || '—'}`, `API Key Set: ${state.lastConfig.apiKeySet}`);
      }
      navigator.clipboard?.writeText(lines.join('\n')).then(
        () => toast('Debug report copied', 'ok', 'Copied'),
        () => toast('Failed to copy', 'error', 'Error')
      );
    });
  }

  /* ── Diagnostics Open Settings ───────────────────────────────────── */
  const diagSettingsLink = $('#diag-settings-link');
  if (diagSettingsLink) {
    diagSettingsLink.addEventListener('click', () => switchView('settings'));
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 24 — Copy Config Panel (with shell tabs)
     ══════════════════════════════════════════════════════════════════ */
  const copyConfigOverlay = $('#copy-config-overlay');
  const copyConfigClose = $('#copy-config-close');
  const cfgPre = $('#cfg-pre');
  const cfgCopyBtn = $('#cfg-copy-btn');
  const cfgBaseUrl = $('#cfg-base-url');
  const cfgModel = $('#cfg-model');
  const configShellTabs = $('#config-shell-tabs');

  let _activeTool = 'claude-code';

  function getShellText(tool, shell) {
    const base = getProxyBase();
    const model = state.lastConfig?.defaultModel || 'claude-opus-4-5-20251101';
    const url = base;
    if (tool === 'claude-code') {
      if (shell === 'cmd') return `set ANTHROPIC_BASE_URL=${url}\r\nset ANTHROPIC_AUTH_TOKEN=local-proxy-key\r\nset ANTHROPIC_MODEL=${model}\r\nclaude`;
      if (shell === 'powershell') return `$env:ANTHROPIC_BASE_URL="${url}"\r\n$env:ANTHROPIC_AUTH_TOKEN="local-proxy-key"\r\n$env:ANTHROPIC_MODEL="${model}"\r\nclaude`;
      return `export ANTHROPIC_BASE_URL="${url}"\nexport ANTHROPIC_AUTH_TOKEN="local-proxy-key"\nexport ANTHROPIC_MODEL="${model}"\nclaude`;
    }
    if (tool === 'cline') {
      if (shell === 'cmd') return `# Cline — VS Code settings.json\r\n{\r\n  "cline.apiProvider": "anthropic",\r\n  "cline.anthropicBaseUrl": "${url}",\r\n  "cline.anthropicModelId": "${model}"\r\n}`;
      return `# Cline — VS Code settings.json\n{\n  "cline.apiProvider": "anthropic",\n  "cline.anthropicBaseUrl": "${url}",\n  "cline.anthropicModelId": "${model}"\n}`;
    }
    if (tool === 'roo-code') {
      return `# Roo Code — .roo/settings.json\n{\n  "apiProvider": "anthropic",\n  "anthropicBaseUrl": "${url}",\n  "anthropicModelId": "${model}"\n}`;
    }
    if (tool === 'continue') {
      return `# Continue — .continue/config.json\n{\n  "models": [\n    {\n      "title": "Free Claude Code Gateway",\n      "provider": "anthropic",\n      "model": "${model}",\n      "apiBase": "${url}"\n    }\n  ]\n}`;
    }
    if (tool === 'openai-client') {
      if (shell === 'cmd') return `set OPENAI_BASE_URL=${url}\r\nset OPENAI_API_KEY=local-proxy-key`;
      if (shell === 'powershell') return `$env:OPENAI_BASE_URL="${url}"\n$env:OPENAI_API_KEY="local-proxy-key"`;
      return `export OPENAI_BASE_URL="${url}"\nexport OPENAI_API_KEY="local-proxy-key"`;
    }
    if (tool === 'curl') {
      return `curl -X POST ${url}/v1/messages \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] })}'`;
    }
    return '';
  }

  function renderConfigText() {
    if (!cfgPre) return;
    const text = getShellText(_activeTool, state.configShell);
    cfgPre.textContent = text;
    if (cfgBaseUrl) cfgBaseUrl.textContent = getProxyBase();
    if (cfgModel) cfgModel.textContent = state.lastConfig?.defaultModel || 'claude-opus-4-5-20251101';
  }

  function openCopyConfigPanel(tool) {
    if (!copyConfigOverlay) return;
    _activeTool = tool;
    copyConfigOverlay.classList.remove('hidden');
    $$('.config-tool-card', copyConfigOverlay).forEach((c) => {
      c.classList.toggle('active', c.getAttribute('data-tool') === tool);
    });
    $('#config-fields').classList.remove('hidden');
    renderConfigText();
  }

  function closeCopyConfigPanel() {
    if (copyConfigOverlay) copyConfigOverlay.classList.add('hidden');
  }

  if (copyConfigOverlay) {
    copyConfigOverlay.addEventListener('click', (e) => {
      if (e.target === copyConfigOverlay) closeCopyConfigPanel();
    });
  }
  if (copyConfigClose) copyConfigClose.addEventListener('click', closeCopyConfigPanel);

  $$('.config-tool-card').forEach((card) => {
    card.addEventListener('click', () => {
      _activeTool = card.getAttribute('data-tool');
      $$('.config-tool-card').forEach((c) => c.classList.toggle('active', c === card));
      renderConfigText();
    });
  });

  if (configShellTabs) {
    configShellTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.config-tab');
      if (!btn) return;
      const shell = btn.getAttribute('data-shell');
      state.configShell = shell;
      $$('.config-tab', configShellTabs).forEach((b) => b.classList.toggle('active', b === btn));
      renderConfigText();
    });
  }

  if (cfgCopyBtn) {
    cfgCopyBtn.addEventListener('click', () => {
      const text = cfgPre.textContent;
      navigator.clipboard?.writeText(text).then(
        () => {
          cfgCopyBtn.classList.add('copied');
          cfgCopyBtn.querySelector('span').textContent = 'Copied';
          toast('Configuration copied to clipboard', 'ok', 'Copied');
          setTimeout(() => {
            cfgCopyBtn.classList.remove('copied');
            cfgCopyBtn.querySelector('span').textContent = 'Copy';
          }, 2000);
        },
        () => toast('Failed to copy', 'error', 'Error')
      );
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 25 — Request Table Copy cURL
     ══════════════════════════════════════════════════════════════════ */
  const reqCopyCurl = $('#req-copy-curl');
  if (reqCopyCurl) {
    reqCopyCurl.addEventListener('click', () => {
      if (state.requestBuffer.length === 0) {
        toast('No requests to copy', 'warn', 'Empty feed');
        return;
      }
      const latest = state.requestBuffer[0];
      const base = getProxyBase();
      let curl;
      if (latest.endpoint && latest.endpoint.includes('/v1/messages')) {
        const body = { model: latest.clientModel || latest.resolvedModel || 'claude-opus-4-5-20251101', max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] };
        curl = `curl -X POST ${base}${latest.endpoint} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
      } else {
        const body = { model: latest.clientModel || latest.resolvedModel || 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] };
        curl = `curl -X POST ${base}${latest.endpoint || '/v1/chat/completions'} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'`;
      }
      navigator.clipboard?.writeText(curl);
      toast('cURL copied from latest request', 'ok', 'Copied');
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     SECTION 26 — Secret Toggle (Settings)
     ══════════════════════════════════════════════════════════════════ */
  $$('.secret-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.closest('.secret-input-wrap')?.querySelector('input');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  /* ══════════════════════════════════════════════════════════════════
     SECTION 27 — Boot Sequence
     ══════════════════════════════════════════════════════════════════ */
  async function init() {
    const initialView = location.hash.replace('#', '') || 'overview';

    // Apply initial view immediately (no flash)
    state.view = initialView;
    $$('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.getAttribute('data-view') === initialView);
    });
    $$('.view').forEach((v) => {
      v.hidden = v.getAttribute('data-view') !== initialView;
    });
    const vt = viewTitles[initialView];
    if (vt) {
      $('#page-title').textContent = vt[0];
      $('#page-subtitle').textContent = vt[1];
    }

    try {
      const health = await fetch('/health').then((r) => r.json());
      const version = health.version || '1.0.0';
      const vb = $('#version-badge');
      if (vb) vb.textContent = `v${version}`;
      const cmdVer = $('#cmd-version');
      if (cmdVer) cmdVer.textContent = version;
      const infoNode = $('#info-node');
      if (infoNode && health.nodeVersion) infoNode.textContent = health.nodeVersion;
      const infoUptime = $('#info-uptime');
      if (infoUptime && health.uptime) infoUptime.textContent = `${Math.round(health.uptime)}s`;
    } catch { /* keep default */ }

    try {
      const cfg = await api('GET', '/config');
      state.lastConfig = cfg;
      const eb = $('#env-badge');
      if (eb) eb.textContent = cfg.nodeEnv || 'local';
      const infoEnv = $('#info-env');
      if (infoEnv) infoEnv.textContent = cfg.nodeEnv || 'local';
      const statusModel = $('#status-default-model');
      if (statusModel) statusModel.textContent = cfg.defaultModel || '—';
      const statusProvider = $('#status-provider');
        if (statusProvider) statusProvider.textContent = cfg.bluesmindsBaseUrl ? 'Upstream Provider' : '—';
    } catch { /* ignore */ }

    initCharts();
    await loadHistoricalRequests();

    // Load providers on startup so topbar switcher is always populated
    loadProviders();

    if (initialView === 'overview') {
      await loadStats();
      renderSetupChecklist();
      renderGatewayInfo();
      setTimeout(() => {
        if (state.chartReq) state.chartReq.resize();
        if (state.chartLat) state.chartLat.resize();
      }, 50);
    }

    if (initialView === 'requests') {
      renderRequestTable();
      renderRequestSummary();
      renderRequestAlert();
      populateModelFilter();
    }

    if (initialView === 'providers') renderProviders();
    if (initialView === 'diagnostics') resetDiagnostics();
    if (initialView === 'models') loadMappings();
    if (initialView === 'settings') { loadConfig(); loadOperations(); lciLoadStatus(); }


    const ivEl = $(`.view[data-view="${initialView}"]`);
    staggerView(ivEl);

    connectSSE();
    setInterval(loadStats, 10_000);
  }

  init();
})();

  /* ══════════════════════════════════════════════════════════════════
     SECTION 25 — Auto-Compact Context System
     ══════════════════════════════════════════════════════════════════ */
  (function initContextModule() {

    /* ── Helpers ─────────────────────────────────────────────────── */
    function fmtTokens(n) {
      if (!n) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return Math.round(n / 1_000) + 'K';
      return String(n);
    }
    function fmtTime(iso) {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleTimeString(); } catch { return '—'; }
    }
    function fmtRelative(iso) {
      if (!iso) return '—';
      try {
        const diff = Date.now() - new Date(iso).getTime();
        if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
        return `${Math.floor(diff / 3_600_000)}h ago`;
      } catch { return '—'; }
    }

    function pctClass(pct) {
      if (pct >= 90) return 'danger';
      if (pct >= 70) return 'warn';
      return 'ok';
    }

    /* ── API calls ───────────────────────────────────────────────── */
    async function apiGetContext() {
      const r = await fetch('/admin/api/context');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }
    async function apiGetHistory() {
      const r = await fetch('/admin/api/context/history');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }
    async function apiGetSettings() {
      const r = await fetch('/admin/api/context/settings');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }
    async function apiSaveSettings(patch) {
      const r = await fetch('/admin/api/context/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
      return r.json();
    }
    async function apiCompact(sessionId) {
      const body = sessionId ? { sessionId } : {};
      const r = await fetch('/admin/api/context/compact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
      return r.json();
    }
    async function apiClearAll() {
      const r = await fetch('/admin/api/context/sessions', { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }
    async function apiClearSession(id) {
      const r = await fetch(`/admin/api/context/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

    /* ── Overview Panel (on the Overview page) ───────────────────── */
    function updateOverviewPanel(data) {
      const panel = document.getElementById('ctx-overview-panel');
      if (!panel) return;

      const pct = data.usagePercent || 0;
      const cls = pctClass(pct);

      // Panel state class
      panel.className = `ctx-panel ctx-state-${cls === 'ok' ? 'ok' : cls === 'warn' ? 'warn' : 'danger'}`;

      // Progress bar
      const fill = document.getElementById('ctx-usage-fill');
      const pctText = document.getElementById('ctx-usage-pct-text');
      if (fill) {
        fill.style.width = `${Math.min(100, pct)}%`;
        fill.className = `ctx-usage-fill${cls === 'warn' ? ' ctx-warn' : cls === 'danger' ? ' ctx-danger' : ''}`;
      }
      if (pctText) {
        pctText.textContent = `${pct}%`;
        pctText.className = `ctx-usage-value ${cls}`;
      }

      // Token detail
      const detail = document.getElementById('ctx-tokens-detail');
      if (detail) detail.textContent = `${fmtTokens(data.usedTokens)} / ${fmtTokens(data.maxTokens)} tokens`;

      // Threshold
      const thr = document.getElementById('ctx-threshold-pct');
      if (thr) thr.textContent = data.threshold || 80;

      // Stats
      const statC = document.getElementById('ctx-stat-compactions');
      const statS = document.getElementById('ctx-stat-saved');
      const statSess = document.getElementById('ctx-stat-sessions');
      if (statC) statC.textContent = fmtTokens(data.compactions || 0);
      if (statS) statS.textContent = fmtTokens(data.tokensSaved || 0);
      if (statSess) statSess.textContent = data.activeSessions || 0;

      // Status badge
      const badge = document.getElementById('ctx-overview-status-badge');
      if (badge) {
        if (pct >= 90) {
          badge.textContent = 'High Usage';
          badge.className = 'badge badge-error';
        } else if (pct >= 70) {
          badge.textContent = 'Near Limit';
          badge.className = 'badge badge-warning';
        } else if (data.enabled) {
          badge.textContent = 'Auto ON';
          badge.className = 'badge badge-success';
        } else {
          badge.textContent = 'Auto OFF';
          badge.className = 'badge badge-muted';
        }
      }

      // Nav badge for warning
      const navBadge = document.getElementById('ctx-nav-badge');
      if (navBadge) {
        if (data.sessionsNearLimit > 0) {
          navBadge.textContent = data.sessionsNearLimit;
          navBadge.classList.remove('hidden');
        } else {
          navBadge.classList.add('hidden');
        }
      }

      // Toggle state
      const track = document.getElementById('ctx-toggle-track');
      if (track) {
        if (data.enabled) {
          track.classList.add('on');
          track.setAttribute('aria-checked', 'true');
        } else {
          track.classList.remove('on');
          track.setAttribute('aria-checked', 'false');
        }
      }
    }

    /* ── Main Context Page ───────────────────────────────────────── */
    function updateMainPanel(data) {
      const pct = data.usagePercent || 0;
      const cls = pctClass(pct);

      const panel = document.getElementById('ctx-main-panel');
      if (panel) panel.className = `ctx-panel ctx-state-${cls === 'ok' ? 'ok' : cls === 'warn' ? 'warn' : 'danger'}`;

      const fill = document.getElementById('ctx-main-fill');
      const pctText = document.getElementById('ctx-main-pct-text');
      if (fill) {
        fill.style.width = `${Math.min(100, pct)}%`;
        fill.className = `ctx-usage-fill${cls === 'warn' ? ' ctx-warn' : cls === 'danger' ? ' ctx-danger' : ''}`;
      }
      if (pctText) {
        pctText.textContent = `${pct}%`;
        pctText.className = `ctx-usage-value ${cls}`;
      }

      const detail = document.getElementById('ctx-main-tokens-detail');
      if (detail) detail.textContent = `${fmtTokens(data.usedTokens)} / ${fmtTokens(data.maxTokens)} tokens`;

      const thr = document.getElementById('ctx-main-threshold');
      const keep = document.getElementById('ctx-main-keep');
      if (thr) thr.textContent = data.threshold || 80;
      if (keep) keep.textContent = data.keepRecentMessages || 20;

      const elC = document.getElementById('ctx-main-compactions');
      const elS = document.getElementById('ctx-main-saved');
      const elSess = document.getElementById('ctx-main-sessions');
      const elNear = document.getElementById('ctx-main-near');
      const elLast = document.getElementById('ctx-main-last');
      if (elC) elC.textContent = fmtTokens(data.compactions || 0);
      if (elS) elS.textContent = fmtTokens(data.tokensSaved || 0);
      if (elSess) elSess.textContent = data.activeSessions || 0;
      if (elNear) elNear.textContent = data.sessionsNearLimit || 0;
      if (elLast) elLast.textContent = fmtRelative(data.lastCompactionAt);

      // Toggle
      const mainTrack = document.getElementById('ctx-main-toggle-track');
      const mainLabel = document.getElementById('ctx-main-enabled-label');
      if (mainTrack) {
        if (data.enabled) {
          mainTrack.classList.add('on');
          mainTrack.setAttribute('aria-checked', 'true');
        } else {
          mainTrack.classList.remove('on');
          mainTrack.setAttribute('aria-checked', 'false');
        }
      }
      if (mainLabel) mainLabel.textContent = data.enabled ? 'ON' : 'OFF';
    }

    function renderSessionsTable(sessions) {
      const tbody = document.getElementById('ctx-sessions-tbody');
      if (!tbody) return;
      if (!sessions || sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No active sessions</td></tr>';
        return;
      }
      tbody.innerHTML = sessions.map(s => {
        const pct = s.usagePercent || 0;
        const cls = pctClass(pct);
        const shortId = s.sessionId.slice(0, 24);
        return `<tr>
          <td><code title="${escapeHtml(s.sessionId)}" style="font-size:11px;">${escapeHtml(shortId)}…</code></td>
          <td><code style="font-size:11px;">${escapeHtml(s.model)}</code></td>
          <td>
            <div class="ctx-session-bar">
              <div class="ctx-session-bar-track">
                <div class="ctx-session-bar-fill ${cls}" style="width:${Math.min(100,pct)}%"></div>
              </div>
              <span class="ctx-session-pct ${cls}">${pct}%</span>
            </div>
          </td>
          <td class="num">${s.messageCount || 0}</td>
          <td class="num">${s.compactionCount || 0}</td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" title="Clear session" data-session-clear="${escapeAttr(s.sessionId)}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
            </div>
          </td>
        </tr>`;
      }).join('');

      // Wire clear buttons
      tbody.querySelectorAll('[data-session-clear]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.sessionClear;
          try {
            await apiClearSession(id);
            showToastGlobal('Session cleared', 'success');
            loadContextPage();
          } catch (err) {
            showToastGlobal('Clear failed: ' + err.message, 'error');
          }
        });
      });
    }

    function renderHistoryTable(history) {
      const tbody = document.getElementById('ctx-history-tbody');
      const totalEl = document.getElementById('ctx-hist-total');
      const savedEl = document.getElementById('ctx-hist-saved-total');
      if (totalEl) totalEl.textContent = fmtTokens(history.totalCompactions || 0);
      if (savedEl) savedEl.textContent = fmtTokens(history.totalTokensSaved || 0);
      if (!tbody) return;
      const entries = [...(history.entries || [])].reverse().slice(0, 50);
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No compaction history</td></tr>';
        return;
      }
      tbody.innerHTML = entries.map(e => {
        const lvlClass = `l${e.level}`;
        const lvlLabel = `Level ${e.level}`;
        return `<tr>
          <td style="font-size:11.5px;">${fmtTime(e.compactedAt)}</td>
          <td><span class="ctx-history-level ${lvlClass}">${lvlLabel}</span></td>
          <td class="num" style="font-size:11.5px;">${fmtTokens(e.tokensSaved)}</td>
          <td class="num" style="font-size:11px;color:var(--text-muted);">${fmtTokens(e.tokensBeforeCompaction)} → ${fmtTokens(e.tokensAfterCompaction)}</td>
        </tr>`;
      }).join('');
    }

    function populateSettingsForm(settings) {
      const thr = document.getElementById('ctx-setting-threshold');
      const warn = document.getElementById('ctx-setting-warn');
      const keep = document.getElementById('ctx-setting-keep');
      const ctxsize = document.getElementById('ctx-setting-ctxsize');
      const summary = document.getElementById('ctx-setting-summary');
      if (thr) thr.value = Math.round((settings.compactThreshold || 0.8) * 100);
      if (warn) warn.value = Math.round((settings.warnThreshold || 0.7) * 100);
      if (keep) keep.value = settings.keepRecentMessages || 20;
      if (ctxsize) ctxsize.value = settings.defaultContextSize || 200000;
      if (summary) summary.checked = settings.generateSummary !== false;
    }

    /* ── Load functions ──────────────────────────────────────────── */
    async function loadContextOverview() {
      try {
        const data = await apiGetContext();
        updateOverviewPanel(data);
      } catch { /* silent — overview is non-critical */ }
    }

    async function loadContextPage() {
      try {
        const [data, history, settings] = await Promise.all([
          apiGetContext(),
          apiGetHistory(),
          apiGetSettings(),
        ]);
        updateMainPanel(data);
        updateOverviewPanel(data);
        renderSessionsTable(data.topSessions || []);
        renderHistoryTable(history);
        populateSettingsForm(settings);
      } catch (err) {
        console.warn('[ctx] load error:', err);
      }
    }

    /* ── Toggle auto-compact (overview panel) ───────────────────── */
    async function toggleAutoCompact(track, currentEnabled) {
      const newVal = !currentEnabled;
      try {
        await apiSaveSettings({ enabled: newVal });
        if (newVal) {
          track.classList.add('on'); track.setAttribute('aria-checked', 'true');
        } else {
          track.classList.remove('on'); track.setAttribute('aria-checked', 'false');
        }
        showToastGlobal(`Auto-Compact ${newVal ? 'enabled' : 'disabled'}`, 'success');
        loadContextOverview();
      } catch (err) {
        showToastGlobal('Failed: ' + err.message, 'error');
      }
    }

    /* ── Wire up overview toggle ─────────────────────────────────── */
    const ovToggle = document.getElementById('ctx-toggle-track');
    if (ovToggle) {
      ovToggle.addEventListener('click', () => {
        const enabled = ovToggle.getAttribute('aria-checked') === 'true';
        toggleAutoCompact(ovToggle, enabled);
      });
      ovToggle.addEventListener('keydown', e => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          const enabled = ovToggle.getAttribute('aria-checked') === 'true';
          toggleAutoCompact(ovToggle, enabled);
        }
      });
    }

    /* ── Wire up main page toggle ────────────────────────────────── */
    const mainToggle = document.getElementById('ctx-main-toggle-track');
    if (mainToggle) {
      mainToggle.addEventListener('click', () => {
        const enabled = mainToggle.getAttribute('aria-checked') === 'true';
        toggleAutoCompact(mainToggle, enabled);
      });
    }

    /* ── Compact Now buttons ─────────────────────────────────────── */
    async function doCompact(btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '<svg class="ctx-compacting" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Compacting…';
      btn.disabled = true;
      try {
        const result = await apiCompact();
        if (result.compacted) {
          showToastGlobal(`Compacted! Saved ${fmtTokens(result.previousStats?.usedTokens || 0)} tokens`, 'success');
        } else {
          showToastGlobal(result.message || 'No compaction needed', 'info');
        }
        loadContextOverview();
        if (document.querySelector('.view[data-view="context"]:not([hidden])')) {
          loadContextPage();
        }
      } catch (err) {
        showToastGlobal('Compact failed: ' + err.message, 'error');
      } finally {
        btn.innerHTML = orig;
        btn.disabled = false;
      }
    }

    const ovCompactBtn = document.getElementById('ctx-compact-now-btn');
    if (ovCompactBtn) ovCompactBtn.addEventListener('click', () => doCompact(ovCompactBtn));

    const mainCompactBtn = document.getElementById('ctx-main-compact-btn');
    if (mainCompactBtn) mainCompactBtn.addEventListener('click', () => doCompact(mainCompactBtn));

    /* ── Clear All ───────────────────────────────────────────────── */
    const clearAllBtn = document.getElementById('ctx-clear-all-btn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', async () => {
        if (!confirm('Clear all context sessions? This removes all tracked session data.')) return;
        try {
          await apiClearAll();
          showToastGlobal('All sessions cleared', 'success');
          loadContextPage();
        } catch (err) {
          showToastGlobal('Clear failed: ' + err.message, 'error');
        }
      });
    }

    /* ── Refresh button ──────────────────────────────────────────── */
    const refreshBtn = document.getElementById('ctx-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadContextPage);

    const sessionsRefresh = document.getElementById('ctx-sessions-refresh');
    if (sessionsRefresh) sessionsRefresh.addEventListener('click', loadContextPage);

    /* ── Save Settings ───────────────────────────────────────────── */
    const saveSettingsBtn = document.getElementById('ctx-save-settings-btn');
    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener('click', async () => {
        const thr = parseFloat(document.getElementById('ctx-setting-threshold')?.value || '80') / 100;
        const warn = parseFloat(document.getElementById('ctx-setting-warn')?.value || '70') / 100;
        const keep = parseInt(document.getElementById('ctx-setting-keep')?.value || '20', 10);
        const ctxsize = parseInt(document.getElementById('ctx-setting-ctxsize')?.value || '200000', 10);
        const summary = document.getElementById('ctx-setting-summary')?.checked !== false;

        try {
          await apiSaveSettings({
            compactThreshold: thr,
            warnThreshold: warn,
            keepRecentMessages: keep,
            defaultContextSize: ctxsize,
            generateSummary: summary,
          });
          showToastGlobal('Settings saved', 'success');
          loadContextPage();
        } catch (err) {
          showToastGlobal('Save failed: ' + err.message, 'error');
        }
      });
    }

    /* ── View switch hook ────────────────────────────────────────── */
    // Hook into the existing view navigation to load context data
    document.querySelectorAll('[data-view="context"]').forEach(el => {
      el.addEventListener('click', () => {
        setTimeout(loadContextPage, 50);
      });
    });

    /* ── Helper: show toast without reference to outer scope ──────── */
    function showToastGlobal(msg, type = 'info') {
      // Use the outer scope's showToast if available, else console
      if (typeof showToast === 'function') {
        showToast(msg, type);
      } else {
        console.info(`[ctx toast] ${type}: ${msg}`);
      }
    }

    /* ── Auto-load on page load ──────────────────────────────────── */
    loadContextOverview();

    // Expose for switchView
    window.__loadContextPage = loadContextPage;

    // Refresh overview panel every 15s alongside stats
    setInterval(loadContextOverview, 15_000);

    // Load context page if it is the initial view
    const hash = location.hash.replace('#', '') || 'overview';
    if (hash === 'context') {
      setTimeout(loadContextPage, 100);
    }

  })();
