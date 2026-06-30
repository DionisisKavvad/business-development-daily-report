import { Pack, ProjectPack, Coverage } from './types';

/**
 * Deterministic signals derived from a pack. These — not the AI prose — are the
 * source of truth for "what is wrong", so the daily report can diff today vs
 * yesterday and show only what CHANGED (new / worsened / resolved), collapsing
 * unchanged persistent issues into a one-line "known/ongoing" list instead of
 * re-raising the same CRITICAL every single day.
 */
export type Severity = 'critical' | 'warn' | 'info';
export type Status = 'new' | 'worsened' | 'improved' | 'ongoing' | 'resolved';

export interface Signal {
  /** stable identity across days (so the same issue matches day-to-day) */
  key: string;
  /** project name, or "Account" */
  scope: string;
  severity: Severity;
  title: string;
  /** comparable magnitude for worsened/improved (null = presence-only) */
  value: number | null;
  /** true when a higher value is worse (never-processed); false for cliffDays */
  worseUp: boolean;
}

export interface DiffedSignal extends Signal {
  status: Status;
  prevValue: number | null;
}

function coverageOf(p: ProjectPack): Coverage | undefined {
  return p.active ? p.coverage : p.baseline?.coverage ?? undefined;
}

/** Derive the deterministic signal set from a pack. */
export function deriveSignals(pack: Pack): Signal[] {
  const out: Signal[] = [];

  for (const p of pack.projects) {
    const cov = coverageOf(p);
    if (cov && cov.measurable && cov.neverProcessed && cov.neverProcessed > 0) {
      out.push({
        key: `${p.app}:never-processed`,
        scope: p.name,
        severity: cov.neverProcessed >= 500 ? 'critical' : 'warn',
        title: `${cov.neverProcessed.toLocaleString('en-US')} stores never processed${
          cov.universe ? ' / ' + cov.universe.toLocaleString('en-US') : ''
        }`,
        value: cov.neverProcessed,
        worseUp: true,
      });
    }
    if (cov && cov.reprocessRatio && cov.reprocessRatio >= 1.5) {
      out.push({
        key: `${p.app}:reprocess`,
        scope: p.name,
        severity: 'info',
        title: `reprocessing ${cov.reprocessRatio.toFixed(2)}× (wasted work / retries)`,
        value: Math.round(cov.reprocessRatio * 100),
        worseUp: true,
      });
    }

    for (const q of p.queues) {
      const id = `${p.app}:${q.queue}`;
      const visible = q.visibleMax || 0;
      if (visible > 0 && q.deleted === 0) {
        out.push({
          key: `${id}:consumer-stall`,
          scope: p.name,
          severity: 'critical',
          title: `consumer stalled: ${visible.toLocaleString('en-US')} visible, 0 deleted (24h)`,
          value: visible,
          worseUp: true,
        });
      }
      if (q.cliffDays !== null && q.cliffDays !== undefined && q.cliffDays <= 3 && visible > 0) {
        out.push({
          key: `${id}:retention-cliff`,
          scope: p.name,
          severity: 'critical',
          title: `retention cliff: messages expire in ~${q.cliffDays.toFixed(1)}d`,
          value: q.cliffDays,
          worseUp: false,
        });
      }
      if (q.dlq === false && visible > 0) {
        out.push({
          key: `${id}:no-dlq`,
          scope: p.name,
          severity: 'warn',
          title: `no DLQ: failed messages recycle until expiry`,
          value: null,
          worseUp: true,
        });
      }
      const gap = q.sent - q.deleted;
      if (q.sent > 0 && gap / q.sent > 0.1) {
        out.push({
          key: `${id}:silent-loss`,
          scope: p.name,
          severity: 'warn',
          title: `sent ≫ deleted: ${gap.toLocaleString('en-US')} unacked (silent-loss risk)`,
          value: gap,
          worseUp: true,
        });
      }
    }

    // yield divergence vs baseline (data-quality / limit-bug signature)
    for (const y of p.progress?.yields || []) {
      const base = p.baseline?.yields.find((b) => b.key === y.key)?.perStore ?? null;
      if (y.perStore !== null && base !== null && base !== 0) {
        const d = Math.abs((y.perStore - base) / base);
        if (d > 0.25) {
          out.push({
            key: `${p.app}:yield:${y.key}`,
            scope: p.name,
            severity: 'warn',
            title: `${y.label} /store ${y.perStore.toFixed(2)} vs baseline ${base.toFixed(2)}`,
            value: Math.round(y.perStore * 1000),
            worseUp: false,
          });
        }
      }
    }
  }

  // account-level
  const op = pack.overprovision.filter((r) => r.utilization !== null && (r.utilization as number) < 0.35);
  if (op.length >= 3) {
    out.push({
      key: `account:overprovision`,
      scope: 'Account',
      severity: 'info',
      title: `${op.length} Lambdas over-provisioned (<35% memory)`,
      value: op.length,
      worseUp: true,
    });
  }
  for (const f of pack.perf) {
    if (f.invocations > 0 && f.errorRate !== null && f.errorRate >= 0.5) {
      out.push({
        key: `account:errrate:${f.name}`,
        scope: 'Account',
        severity: 'warn',
        title: `${f.name}: ${(f.errorRate * 100).toFixed(0)}% error rate (${f.invocations} inv)`,
        value: Math.round(f.errorRate * 100),
        worseUp: true,
      });
    }
  }

  return out;
}

const EPS = 1e-9;

/**
 * Diff today's signals against yesterday's. Returns today's signals annotated
 * with status, plus RESOLVED entries for signals present yesterday but gone today.
 */
export function diffSignals(today: Pack, prev: Pack | null): DiffedSignal[] {
  const cur = deriveSignals(today);
  const old = prev ? deriveSignals(prev) : [];
  const oldByKey = new Map(old.map((s) => [s.key, s]));
  const curKeys = new Set(cur.map((s) => s.key));

  const diffed: DiffedSignal[] = cur.map((s) => {
    const o = oldByKey.get(s.key);
    if (!o) return { ...s, status: 'new', prevValue: null };
    if (s.value === null || o.value === null || Math.abs(s.value - o.value) < EPS) {
      return { ...s, status: 'ongoing', prevValue: o.value };
    }
    const wentUp = s.value > o.value;
    const worse = s.worseUp ? wentUp : !wentUp;
    return { ...s, status: worse ? 'worsened' : 'improved', prevValue: o.value };
  });

  // resolved: in yesterday, not today
  for (const o of old) {
    if (!curKeys.has(o.key)) diffed.push({ ...o, status: 'resolved', prevValue: o.value });
  }

  return diffed;
}
