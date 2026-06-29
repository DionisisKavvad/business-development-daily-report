import { Pack, ProjectPack, Insights, YieldRatio } from './types';

/** Deterministic, self-contained HTML report (inline CSS). AI text goes in the
 *  insights section; everything else is rendered straight from the pack. */

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

function baselineYield(p: ProjectPack, key: string): number | null {
  const y = p.baseline?.yields.find((b) => b.key === key);
  return y ? y.perStore : null;
}

function findingsHtml(ins: Insights): string {
  if (!ins.findings?.length) return '<p class="muted">No findings.</p>';
  return ins.findings
    .map(
      (f) => `
      <div class="finding ${esc(f.severity)}">
        <span class="sev">${esc(f.severity.toUpperCase())}</span>
        <strong>${esc(f.title)}</strong>
        <div class="detail">${esc(f.detail)}</div>
      </div>`
    )
    .join('');
}

function projectCard(p: ProjectPack): string {
  const status = p.active
    ? `<span class="badge active">ACTIVE · day ${p.dayNumber ?? '?'}</span>`
    : `<span class="badge idle">IDLE</span>`;

  const yieldsRows = (p.progress?.yields || [])
    .map((y: YieldRatio) => {
      const base = baselineYield(p, y.key);
      return `<tr>
        <td>${esc(y.label)}</td>
        <td class="r">${num(y.total)}</td>
        <td class="r">${y.perStore === null ? '—' : y.perStore.toFixed(2)}</td>
        <td class="r">${base === null ? '—' : base.toFixed(2)}</td>
        <td class="r">${deltaPct(y.perStore, base)}</td>
      </tr>`;
    })
    .join('');

  const errors = (p.progress?.errors || []).filter((e) => e.count > 0);
  const errorsHtml = errors.length
    ? errors.map((e) => `${esc(e.label)}: <b>${num(e.count)}</b>`).join(' · ')
    : '<span class="muted">none</span>';

  const flags = p.balance.flatMap((b) => b.flags);
  const flagsHtml = flags.length
    ? `<div class="flags">${flags.map((f) => `<div class="flag">⚠ ${esc(f)}</div>`).join('')}</div>`
    : '';

  const queueRows = p.queues
    .map(
      (q) => `<tr>
      <td>${esc(q.queue)}</td>
      <td class="r">${num(q.sent)}</td>
      <td class="r">${num(q.deleted)}</td>
      <td class="r">${num(q.visibleMax)}</td>
      <td class="r">${q.oldestAgeSec === null ? '—' : (q.oldestAgeSec / 86400).toFixed(1) + 'd'}</td>
    </tr>`
    )
    .join('');

  const progressBlock = p.active
    ? `
      <div class="kv"><span>Stores completed (run)</span><b>${num(p.progress?.storesCompleted)}</b></div>
      <div class="kv"><span>Errors / store</span><b>${p.progress?.errorRate === null ? '—' : p.progress?.errorRate?.toFixed(3)}</b></div>
      <table class="t">
        <thead><tr><th>Yield</th><th class="r">Total</th><th class="r">/store</th><th class="r">baseline /store</th><th class="r">Δ</th></tr></thead>
        <tbody>${yieldsRows || '<tr><td colspan="5" class="muted">no yield metrics</td></tr>'}</tbody>
      </table>`
    : `<p class="muted">No active run. Last completed run baseline: ${
        p.baseline ? num(p.baseline.storesCompleted) + ' stores' : 'none'
      }.</p>`;

  return `
  <div class="card">
    <div class="card-h"><h3>${esc(p.name)}</h3>${status}</div>
    ${progressBlock}
    <div class="kv"><span>Errors</span><span>${errorsHtml}</span></div>
    <div class="kv"><span>Proxy events (24h)</span><b>${num(p.proxy.totalProxyEvents)}</b></div>
    ${flagsHtml}
    <details><summary>Queue metrics (24h)</summary>
      <table class="t">
        <thead><tr><th>Queue</th><th class="r">Sent</th><th class="r">Deleted</th><th class="r">Visible</th><th class="r">Oldest</th></tr></thead>
        <tbody>${queueRows || '<tr><td colspan="5" class="muted">none</td></tr>'}</tbody>
      </table>
    </details>
  </div>`;
}

function costSection(pack: Pack): string {
  const byDayService: Record<string, number> = {};
  for (const c of pack.cost.byService) byDayService[c.group] = (byDayService[c.group] || 0) + c.amount;
  const top = Object.entries(byDayService)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const rows = top
    .map(([svc, amt]) => `<tr><td>${esc(svc)}</td><td class="r">${amt.toFixed(2)} ${esc(pack.cost.currency)}</td></tr>`)
    .join('');
  return `
  <div class="card">
    <div class="card-h"><h3>Cost (last 7d, by service)</h3><span class="muted">latest day estimated</span></div>
    <table class="t"><thead><tr><th>Service</th><th class="r">Total</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="2" class="muted">no cost > 0 in window</td></tr>'}</tbody></table>
  </div>`;
}

function perfSection(pack: Pack): string {
  const rows = pack.perf
    .slice(0, 15)
    .map(
      (f) => `<tr>
      <td>${esc(f.name)}</td>
      <td class="r">${num(f.memoryMB)}</td>
      <td class="r">${num(f.invocations)}</td>
      <td class="r">${f.errorRate === null ? '—' : (f.errorRate * 100).toFixed(0) + '%'}</td>
      <td class="r">${num(f.throttles)}</td>
      <td class="r">${f.durationP99Ms === null ? '—' : (f.durationP99Ms / 1000).toFixed(1) + 's'}</td>
      <td class="r">${num(f.gbSecondsEst, 1)}</td>
    </tr>`
    )
    .join('');
  return `
  <div class="card">
    <div class="card-h"><h3>Lambda perf (24h, heavy fns)</h3></div>
    <table class="t">
      <thead><tr><th>Function</th><th class="r">Mem</th><th class="r">Inv</th><th class="r">Err%</th><th class="r">Thr</th><th class="r">p99</th><th class="r">GB-s</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">no active heavy functions</td></tr>'}</tbody>
    </table>
  </div>`;
}

function overprovisionSection(pack: Pack): string {
  const rows = pack.overprovision
    .filter((r) => r.utilization !== null)
    .sort((a, b) => (a.utilization || 0) - (b.utilization || 0))
    .slice(0, 12)
    .map((r) => {
      const u = (r.utilization || 0) * 100;
      const cls = u > 80 ? 'down' : u < 35 ? 'up' : 'flat';
      return `<tr>
        <td>${esc(r.logGroup.split('/').pop())}</td>
        <td class="r">${num(r.provisionedMB)}</td>
        <td class="r">${num(r.maxUsedMB)}</td>
        <td class="r"><span class="delta ${cls}">${u.toFixed(0)}%</span></td>
      </tr>`;
    })
    .join('');
  return `
  <div class="card">
    <div class="card-h"><h3>Memory utilization</h3><span class="muted">&gt;80% bump · &lt;35% over-provisioned</span></div>
    <table class="t"><thead><tr><th>Function</th><th class="r">Provisioned MB</th><th class="r">Max used MB</th><th class="r">Util</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">no REPORT data in window</td></tr>'}</tbody></table>
  </div>`;
}

export function renderHtml(pack: Pack, insights: Insights): string {
  const css = `
  :root{--bg:#0f1419;--card:#1a212b;--line:#2a3340;--txt:#e6edf3;--mut:#8b97a7;--up:#f0883e;--down:#f85149;--ok:#3fb950}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:20px;margin:0}h3{font-size:15px;margin:0}.muted{color:var(--mut);font-size:12px}
  .wrap{max-width:980px;margin:0 auto}.head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .card-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .badge{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600}
  .badge.active{background:rgba(63,185,80,.15);color:var(--ok)}.badge.idle{background:#2a3340;color:var(--mut)}
  .kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dotted var(--line)}
  table.t{width:100%;border-collapse:collapse;margin:8px 0;font-size:12.5px}
  table.t th{text-align:left;color:var(--mut);font-weight:600;border-bottom:1px solid var(--line);padding:4px}
  table.t td{padding:4px;border-bottom:1px solid var(--line)}.r{text-align:right}
  .delta{font-weight:700}.delta.up{color:var(--up)}.delta.down{color:var(--down)}.delta.flat{color:var(--mut)}
  .flags{margin:8px 0}.flag{background:rgba(248,81,73,.12);color:var(--down);padding:5px 8px;border-radius:6px;margin:4px 0;font-size:12.5px}
  .insights{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);border-radius:10px;padding:16px;margin-bottom:16px}
  .finding{padding:8px 0;border-bottom:1px solid var(--line)}.finding .sev{font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:8px}
  .finding.critical .sev{background:rgba(248,81,73,.2);color:var(--down)}.finding.warn .sev{background:rgba(240,136,62,.2);color:var(--up)}.finding.info .sev{background:#2a3340;color:var(--mut)}
  .finding .detail{color:var(--mut);font-size:12.5px;margin-top:2px}
  details summary{cursor:pointer;color:var(--mut);font-size:12px;margin-top:8px}`;

  const projects = pack.projects.map(projectCard).join('');

  return `<!DOCTYPE html><html lang="el"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BD Daily Report · ${esc(pack.date)}</title><style>${css}</style></head>
  <body><div class="wrap">
    <div class="head"><h1>Business Development · Daily Report</h1>
      <span class="muted">${esc(pack.date)} · generated ${esc(pack.generatedAt)}</span></div>
    <div class="insights">
      <h3>AI investigation</h3>
      <p>${esc(insights.summary)}</p>
      ${findingsHtml(insights)}
    </div>
    <div class="grid">${projects}</div>
    <div style="height:14px"></div>
    <div class="grid">${costSection(pack)}${perfSection(pack)}</div>
    <div style="height:14px"></div>
    ${overprovisionSection(pack)}
  </div></body></html>`;
}
