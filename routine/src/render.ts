import { Pack, ProjectPack, Insights, YieldRatio, Coverage } from './types';
import { diffSignals, DiffedSignal, Status } from './signals';

/**
 * Deterministic, self-contained HTML report (inline CSS + pure-CSS tabs).
 * Two views:
 *   - Business: per-project cards (group by project) with the headline signals
 *     (coverage / what's wrong / proxy bans / cost), each with a vs-yesterday Δ.
 *   - Technical: every raw metric a debugging session would need.
 * AI text comes from `insights`; everything else is rendered straight from the
 * pack. `prev` is yesterday's pack (or null) and drives the Δ-vs-yesterday values.
 */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function num(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function deltaPct(current: number | null, base: number | null): string {
  if (current === null || base === null || base === 0) return '';
  const d = ((current - base) / base) * 100;
  const sign = d >= 0 ? '+' : '';
  const cls = Math.abs(d) >= 25 ? (d < 0 ? 'down' : 'up') : 'flat';
  return `<span class="delta ${cls}">${sign}${d.toFixed(0)}%</span>`;
}

/**
 * Absolute Δ vs yesterday. `goodDown` flips the color so that "fewer is better"
 * metrics (errors, bans, never-processed) go green when they drop.
 */
function deltaAbs(cur: number | null | undefined, prev: number | null | undefined, goodDown = false): string {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return '';
  const d = cur - prev;
  if (d === 0) return `<span class="delta flat">±0</span>`;
  const worse = goodDown ? d > 0 : d < 0;
  const sign = d > 0 ? '+' : '';
  return `<span class="delta ${worse ? 'down' : 'up'}">${sign}${num(d)} vs χθες</span>`;
}

function prevProject(prev: Pack | null | undefined, app: string): ProjectPack | undefined {
  return prev?.projects.find((p) => p.app === app);
}

function activeCoverage(p: ProjectPack): Coverage | undefined {
  return p.active ? p.coverage : p.baseline?.coverage ?? undefined;
}

function baselineYield(p: ProjectPack, key: string): number | null {
  const y = p.baseline?.yields.find((b) => b.key === key);
  return y ? y.perStore : null;
}

function sevRank(s: string): number {
  return s === 'critical' ? 0 : s === 'warn' ? 1 : 2;
}

function findingRow(f: Insights['findings'][number]): string {
  return `
    <div class="finding ${esc(f.severity)}">
      <span class="sev">${esc(f.severity.toUpperCase())}</span>
      <strong>${esc(f.title)}</strong>
      <div class="detail">${esc(f.detail)}</div>
    </div>`;
}

/* --------------------------- change detection --------------------------- */

const STATUS_META: Record<Status, { chip: string; cls: string; rank: number }> = {
  new: { chip: '🆕 NEW', cls: 'st-new', rank: 0 },
  worsened: { chip: '📈 WORSE', cls: 'st-worse', rank: 1 },
  resolved: { chip: '✅ RESOLVED', cls: 'st-ok', rank: 2 },
  improved: { chip: '📉 BETTER', cls: 'st-ok', rank: 3 },
  ongoing: { chip: '⏳ ONGOING', cls: 'st-ong', rank: 4 },
};

function valueChange(s: DiffedSignal): string {
  if (s.status !== 'worsened' && s.status !== 'improved') return '';
  if (s.value === null || s.prevValue === null) return '';
  return ` <span class="muted">(${num(s.prevValue)} → ${num(s.value)})</span>`;
}

function signalRow(s: DiffedSignal): string {
  const m = STATUS_META[s.status];
  return `<div class="sig ${esc(s.severity)}">
    <span class="stchip ${m.cls}">${m.chip}</span>
    <span class="sev">${esc(s.severity.toUpperCase())}</span>
    <span class="scope">${esc(s.scope)}</span>
    <span class="sig-title">${esc(s.title)}${valueChange(s)}</span>
  </div>`;
}

/** Lead section: only what changed vs yesterday (new / worsened / resolved / improved). */
function changesSection(today: Pack, prev: Pack | null | undefined): string {
  const diffed = diffSignals(today, prev ?? null);
  const changed = diffed
    .filter((s) => s.status !== 'ongoing')
    .sort(
      (a, b) =>
        STATUS_META[a.status].rank - STATUS_META[b.status].rank ||
        sevRank(a.severity) - sevRank(b.severity)
    );
  const body = prev
    ? changed.length
      ? changed.map(signalRow).join('')
      : '<p class="muted">Καμία αλλαγή στα σήματα από χθες.</p>'
    : '<p class="muted">Δεν υπάρχει χθεσινό pack για σύγκριση — όλα τα σήματα φαίνονται ως τρέχουσα κατάσταση παρακάτω.</p>';
  return `<div class="banner"><h3>🔔 Τι άλλαξε από χθες</h3>${body}</div>`;
}

/** Collapsed list of unchanged persistent issues, so they don't re-alarm daily. */
function ongoingSection(today: Pack, prev: Pack | null | undefined): string {
  if (!prev) return '';
  const ongoing = diffSignals(today, prev)
    .filter((s) => s.status === 'ongoing')
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  if (!ongoing.length) return '';
  const rows = ongoing
    .map(
      (s) =>
        `<div class="sig-line"><span class="sev">${esc(s.severity.toUpperCase())}</span> <b>${esc(
          s.scope
        )}</b> · ${esc(s.title)}</div>`
    )
    .join('');
  return `<details class="ongoing"><summary>⏳ Γνωστά εκκρεμή (${ongoing.length}) — αμετάβλητα από χθες</summary>${rows}</details>`;
}

/* ----------------------------- business tab ----------------------------- */

function coverageLine(p: ProjectPack): string {
  const c = activeCoverage(p);
  if (!c) return '';
  if (!c.measurable) {
    return `<div class="kv"><span>Coverage</span><span class="muted">δεν μετριέται (το event δεν φέρει store id) · ${num(
      c.processedEvents
    )} events</span></div>`;
  }
  const lossCls = c.neverProcessed && c.neverProcessed > 0 ? 'down' : 'ok';
  return `
    <div class="kv"><span>Stores processed</span><b>${num(c.processedDistinct)}${
    c.universe ? ' / ' + num(c.universe) : ''
  }</b></div>
    <div class="kv"><span>Never processed</span><b class="${lossCls}">${
    c.neverProcessed === null ? '—' : num(c.neverProcessed)
  }</b></div>`;
}

function queueHealthLine(p: ProjectPack): string {
  // worst (smallest cliff / oldest) main queue summary
  const qs = p.queues.filter((q) => (q.visibleMax || 0) > 0 || (q.oldestAgeSec || 0) > 0);
  if (!qs.length) return `<div class="kv"><span>Queues</span><span class="muted">idle / empty</span></div>`;
  return qs
    .map((q) => {
      const oldest = q.oldestAgeSec === null ? '—' : (q.oldestAgeSec / 86400).toFixed(1) + 'd';
      const cliff =
        q.cliffDays === null || q.cliffDays === undefined
          ? ''
          : ` · cliff ${q.cliffDays <= 0 ? '<span class="down">τώρα</span>' : '~' + q.cliffDays.toFixed(1) + 'd'}`;
      const dlq = q.dlq === false ? ' · <span class="down">no DLQ</span>' : '';
      return `<div class="kv"><span>${esc(q.queue)}</span><span>visible ${num(q.visibleMax)} · oldest ${oldest}${cliff}${dlq}</span></div>`;
    })
    .join('');
}

function businessCard(p: ProjectPack, prev: Pack | null | undefined, findings: Insights['findings']): string {
  const pp = prevProject(prev, p.app);
  const status = p.active
    ? `<span class="badge active">RUNNING · μέρα ${p.dayNumber ?? '?'}</span>`
    : `<span class="badge idle">IDLE</span>`;

  const mine = findings
    .filter((f) => f.project && (f.project === p.name || f.project === p.app))
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const findingsHtml = mine.length
    ? `<div class="card-findings">${mine.map(findingRow).join('')}</div>`
    : '';

  // deterministic per-project flags (from balance) — always project-attributed
  const flags = p.balance.flatMap((b) => b.flags);
  const flagsHtml = flags.length
    ? `<div class="flags">${flags.map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</div>`
    : '';

  const proxyPrev = pp?.proxy.totalProxyEvents;
  const errTotal = (p.progress?.errors || []).reduce((s, e) => s + e.count, 0);
  const errPrev = pp?.progress?.errors?.reduce((s, e) => s + e.count, 0);

  const cov = activeCoverage(p);
  const covPrev = pp ? (pp.active ? pp.coverage : pp.baseline?.coverage) : undefined;

  return `
  <div class="card">
    <div class="card-h"><h3>${esc(p.name)}</h3>${status}</div>
    ${findingsHtml}
    ${coverageLine(p)}
    ${
      cov && cov.measurable && cov.neverProcessed !== null
        ? `<div class="kv"><span>Δ never-processed</span><span>${deltaAbs(
            cov.neverProcessed,
            covPrev?.neverProcessed,
            true
          )}</span></div>`
        : ''
    }
    ${
      p.active || errTotal
        ? `<div class="kv"><span>Errors (run)</span><span>${
            errTotal
              ? `<b>${num(errTotal)}</b> ${deltaAbs(errTotal, errPrev, true)}`
              : '<span class="muted">none</span>'
          }</span></div>`
        : ''
    }
    <div class="kv"><span>Proxy bans (24h)</span><span><b>${num(p.proxy.totalProxyEvents)}</b> ${deltaAbs(
    p.proxy.totalProxyEvents,
    proxyPrev,
    true
  )}</span></div>
    ${queueHealthLine(p)}
    ${flagsHtml}
  </div>`;
}

/* ----------------------------- technical tab ----------------------------- */

function yieldsTable(p: ProjectPack): string {
  const rows = (p.progress?.yields || [])
    .map((y: YieldRatio) => {
      const base = baselineYield(p, y.key);
      return `<tr><td>${esc(y.label)}</td><td class="r">${num(y.total)}</td>
        <td class="r">${y.perStore === null ? '—' : y.perStore.toFixed(2)}</td>
        <td class="r">${base === null ? '—' : base.toFixed(2)}</td>
        <td class="r">${deltaPct(y.perStore, base)}</td></tr>`;
    })
    .join('');
  if (!rows) return '';
  return `<table class="t"><thead><tr><th>Yield</th><th class="r">Total</th><th class="r">/store</th><th class="r">base /store</th><th class="r">Δ</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function coverageTable(c: Coverage | undefined): string {
  if (!c) return '';
  return `<table class="t"><tbody>
    <tr><td>Universe (enqueued)</td><td class="r">${num(c.universe)}</td></tr>
    <tr><td>Processed (distinct stores)</td><td class="r">${num(c.processedDistinct)}</td></tr>
    <tr><td>Processed events (raw)</td><td class="r">${num(c.processedEvents)}</td></tr>
    <tr><td>Reprocess ratio</td><td class="r">${c.reprocessRatio === null ? '—' : c.reprocessRatio.toFixed(2) + '×'}</td></tr>
    <tr><td>Never processed</td><td class="r">${c.neverProcessed === null ? (c.measurable ? '—' : 'n/a') : num(c.neverProcessed)}</td></tr>
  </tbody></table>`;
}

function queueTable(p: ProjectPack): string {
  const rows = p.queues
    .map(
      (q) => `<tr><td>${esc(q.queue)}</td><td class="r">${num(q.sent)}</td><td class="r">${num(q.deleted)}</td>
      <td class="r">${num(q.visibleMax)}</td>
      <td class="r">${q.oldestAgeSec === null ? '—' : (q.oldestAgeSec / 86400).toFixed(1) + 'd'}</td>
      <td class="r">${q.cliffDays === null || q.cliffDays === undefined ? '—' : q.cliffDays.toFixed(1) + 'd'}</td>
      <td class="r">${q.dlq === null || q.dlq === undefined ? '—' : q.dlq ? 'yes' : '<span class="down">no</span>'}</td></tr>`
    )
    .join('');
  if (!rows) return '';
  return `<table class="t"><thead><tr><th>Queue</th><th class="r">Sent</th><th class="r">Del</th><th class="r">Vis</th><th class="r">Oldest</th><th class="r">Cliff</th><th class="r">DLQ</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function technicalProject(p: ProjectPack): string {
  const meta: string[] = [];
  if (p.runId) meta.push(`runId ${esc(p.runId)}`);
  if (p.runStartMs) meta.push(`started ${new Date(p.runStartMs).toISOString().slice(0, 16).replace('T', ' ')}`);
  meta.push(p.active ? `active (day ${p.dayNumber ?? '?'})` : 'idle');
  return `
  <div class="card">
    <div class="card-h"><h3>${esc(p.name)}</h3><span class="muted">${meta.join(' · ')}</span></div>
    <h4>Coverage</h4>${coverageTable(activeCoverage(p)) || '<p class="muted">—</p>'}
    ${yieldsTable(p) ? '<h4>Yields</h4>' + yieldsTable(p) : ''}
    <h4>Queues</h4>${queueTable(p) || '<p class="muted">no queues</p>'}
    <h4>Proxy events (24h): ${num(p.proxy.totalProxyEvents)}</h4>
    ${
      p.proxy.byType.length
        ? `<table class="t"><tbody>${p.proxy.byType
            .map((b) => `<tr><td>${esc(b.eventType)}</td><td class="r">${num(b.count)}</td></tr>`)
            .join('')}</tbody></table>`
        : ''
    }
  </div>`;
}

function costSection(pack: Pack, prev: Pack | null | undefined): string {
  const sumByService = (pk: Pack | null | undefined): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const c of pk?.cost.byService || []) m[c.group] = (m[c.group] || 0) + c.amount;
    return m;
  };
  const cur = sumByService(pack);
  const old = sumByService(prev);
  const top = Object.entries(cur)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const rows = top
    .map(
      ([svc, amt]) =>
        `<tr><td>${esc(svc)}</td><td class="r">${amt.toFixed(2)} ${esc(pack.cost.currency)}</td><td class="r">${deltaPct(
          amt,
          old[svc] ?? null
        )}</td></tr>`
    )
    .join('');
  return `<div class="card"><div class="card-h"><h3>Cost (7d, by service)</h3><span class="muted">latest day estimated · Δ vs χθες</span></div>
    <table class="t"><thead><tr><th>Service</th><th class="r">Total</th><th class="r">Δ</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">no cost > 0 in window</td></tr>'}</tbody></table></div>`;
}

function perfSection(pack: Pack): string {
  const rows = pack.perf
    .slice(0, 15)
    .map(
      (f) => `<tr><td>${esc(f.name)}</td><td class="r">${num(f.memoryMB)}</td><td class="r">${num(f.invocations)}</td>
      <td class="r">${f.errorRate === null ? '—' : (f.errorRate * 100).toFixed(0) + '%'}</td>
      <td class="r">${num(f.throttles)}</td>
      <td class="r">${f.durationP99Ms === null ? '—' : (f.durationP99Ms / 1000).toFixed(1) + 's'}</td>
      <td class="r">${num(f.gbSecondsEst, 1)}</td></tr>`
    )
    .join('');
  return `<div class="card"><div class="card-h"><h3>Lambda perf (24h, heavy fns)</h3></div>
    <table class="t"><thead><tr><th>Function</th><th class="r">Mem</th><th class="r">Inv</th><th class="r">Err%</th><th class="r">Thr</th><th class="r">p99</th><th class="r">GB-s</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="muted">no active heavy functions</td></tr>'}</tbody></table></div>`;
}

function overprovisionSection(pack: Pack): string {
  const rows = pack.overprovision
    .filter((r) => r.utilization !== null)
    .sort((a, b) => (a.utilization || 0) - (b.utilization || 0))
    .slice(0, 12)
    .map((r) => {
      const u = (r.utilization || 0) * 100;
      const cls = u > 80 ? 'down' : u < 35 ? 'up' : 'flat';
      return `<tr><td>${esc(r.logGroup.split('/').pop())}</td><td class="r">${num(r.provisionedMB)}</td>
        <td class="r">${num(r.maxUsedMB)}</td><td class="r"><span class="delta ${cls}">${u.toFixed(0)}%</span></td></tr>`;
    })
    .join('');
  return `<div class="card"><div class="card-h"><h3>Memory utilization</h3><span class="muted">&gt;80% bump · &lt;35% over-provisioned</span></div>
    <table class="t"><thead><tr><th>Function</th><th class="r">Prov MB</th><th class="r">Max used</th><th class="r">Util</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">no REPORT data in window</td></tr>'}</tbody></table></div>`;
}

/* ------------------------------- assembly ------------------------------- */

export function renderHtml(pack: Pack, insights: Insights, prev?: Pack | null): string {
  const css = `
  :root{--bg:#0f1419;--card:#1a212b;--line:#2a3340;--txt:#e6edf3;--mut:#8b97a7;--up:#f0883e;--down:#f85149;--ok:#3fb950;--accent:#388bfd}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0}h3{font-size:15px;margin:0}h4{font-size:12.5px;margin:12px 0 4px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
  .muted{color:var(--mut);font-size:12px}.down{color:var(--down)}.ok{color:var(--ok)}
  .wrap{max-width:1000px;margin:0 auto}.head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}
  .banner{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
  .banner .stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}.banner .stat b{font-size:18px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .card-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px}
  .badge{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600;white-space:nowrap}
  .badge.active{background:rgba(63,185,80,.15);color:var(--ok)}.badge.idle{background:#2a3340;color:var(--mut)}
  .kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dotted var(--line)}
  table.t{width:100%;border-collapse:collapse;margin:6px 0;font-size:12.5px}
  table.t th{text-align:left;color:var(--mut);font-weight:600;border-bottom:1px solid var(--line);padding:4px}
  table.t td{padding:4px;border-bottom:1px solid var(--line)}.r{text-align:right}
  .delta{font-weight:700;font-size:11.5px}.delta.up{color:var(--up)}.delta.down{color:var(--down)}.delta.flat{color:var(--mut)}
  .flags{margin:8px 0}.flag{background:rgba(248,81,73,.12);color:var(--down);padding:5px 8px;border-radius:6px;margin:4px 0;font-size:12.5px}
  .card-findings{margin-bottom:8px}
  .insights{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:16px;margin-bottom:14px}
  .finding{padding:8px 0;border-bottom:1px solid var(--line)}.finding:last-child{border-bottom:none}
  .finding .sev{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:8px}
  .finding.critical .sev{background:rgba(248,81,73,.2);color:var(--down)}.finding.warn .sev{background:rgba(240,136,62,.2);color:var(--up)}.finding.info .sev{background:#2a3340;color:var(--mut)}
  .finding .detail{color:var(--mut);font-size:12.5px;margin-top:2px}
  .sig{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--line)}
  .sig:last-child{border-bottom:none}.sig .scope{font-weight:600}.sig-title{flex:1;min-width:160px}
  .stchip{font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;white-space:nowrap}
  .st-new{background:rgba(248,81,73,.18);color:var(--down)}.st-worse{background:rgba(240,136,62,.18);color:var(--up)}
  .st-ok{background:rgba(63,185,80,.15);color:var(--ok)}.st-ong{background:#2a3340;color:var(--mut)}
  .sig .sev{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:#2a3340;color:var(--mut)}
  .sig.critical .sev{background:rgba(248,81,73,.2);color:var(--down)}.sig.warn .sev{background:rgba(240,136,62,.2);color:var(--up)}
  .ongoing{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
  .ongoing summary{cursor:pointer;color:var(--mut);font-weight:600}.sig-line{padding:4px 0;font-size:12.5px;color:var(--mut)}
  .sig-line .sev{font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;background:#2a3340}
  /* pure-css tabs */
  .tabnav{display:flex;gap:6px;margin-bottom:14px}
  .tabnav label{cursor:pointer;padding:7px 16px;border-radius:8px;background:var(--card);border:1px solid var(--line);color:var(--mut);font-weight:600;font-size:13px}
  input[name=tab]{position:absolute;opacity:0;pointer-events:none}
  .panel{display:none}
  #t-biz:checked~.tabnav label[for=t-biz],#t-tech:checked~.tabnav label[for=t-tech]{background:var(--accent);color:#fff;border-color:var(--accent)}
  #t-biz:checked~#p-biz,#t-tech:checked~#p-tech{display:block}`;

  const running = pack.projects.filter((p) => p.active).length;
  const idle = pack.projects.length - running;
  const crit = insights.findings.filter((f) => f.severity === 'critical').length;
  const warn = insights.findings.filter((f) => f.severity === 'warn').length;
  const bannerFindings = insights.findings.filter((f) => !f.project);

  const bizCards = pack.projects.map((p) => businessCard(p, prev, insights.findings)).join('');
  const techProjects = pack.projects.map(technicalProject).join('');

  return `<!DOCTYPE html><html lang="el"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BD Daily Report · ${esc(pack.date)}</title><style>${css}</style></head>
  <body><div class="wrap">
    <div class="head"><h1>Business Development · Daily Report</h1>
      <span class="muted">${esc(pack.date)} · generated ${esc(pack.generatedAt)}${
    prev ? ' · Δ vs ' + esc(prev.date) : ''
  }</span></div>

    <input type="radio" name="tab" id="t-biz" checked>
    <input type="radio" name="tab" id="t-tech">
    <div class="tabnav">
      <label for="t-biz">📊 Business</label>
      <label for="t-tech">🔧 Technical details</label>
    </div>

    <section class="panel" id="p-biz">
      <div class="banner">
        <h3>AI investigation</h3>
        <p>${esc(insights.summary)}</p>
        <div class="stats">
          <span class="stat">🟢 running <b>${running}</b></span>
          <span class="stat">⚪ idle <b>${idle}</b></span>
          <span class="stat">🔴 critical <b>${crit}</b></span>
          <span class="stat">🟠 warn <b>${warn}</b></span>
        </div>
        ${bannerFindings.length ? bannerFindings.map(findingRow).join('') : ''}
      </div>
      ${changesSection(pack, prev)}
      <div class="grid">${bizCards}</div>
      ${ongoingSection(pack, prev)}
    </section>

    <section class="panel" id="p-tech">
      <div class="grid">${techProjects}</div>
      <div style="height:14px"></div>
      <div class="grid">${costSection(pack, prev)}${perfSection(pack)}</div>
      <div style="height:14px"></div>
      ${overprovisionSection(pack)}
    </section>
  </div></body></html>`;
}
