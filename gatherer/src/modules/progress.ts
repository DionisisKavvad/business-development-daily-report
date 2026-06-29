import { countEventsBetween, eventTimestampsBetween } from '../lib/dynamo';
import { ProjectConfig } from '../projects';

const DAY_MS = 24 * 60 * 60 * 1000;
const BREAKDOWN_DAYS = 14; // daily granularity window for WoW within a run

export interface YieldRatio {
  key: string;
  label: string;
  total: number;
  /** per completed store (numerator / storesCompleted), null if no stores yet */
  perStore: number | null;
}

export interface DayPoint {
  /** YYYY-MM-DD (UTC) */
  date: string;
  storesCompleted: number;
  primaryYield: number;
  errors: number;
}

export interface ProgressSummary {
  app: string;
  name: string;
  runStartMs: number;
  storesCompleted: number;
  yields: YieldRatio[];
  errors: { key: string; label: string; count: number }[];
  errorRate: number | null; // total errors / storesCompleted
  dailyBreakdown: DayPoint[];
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function bucketByDay(timestamps: number[], fromMs: number, toMs: number): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (let d = fromMs; d <= toMs; d += DAY_MS) buckets[dayKey(d)] = 0;
  for (const ts of timestamps) {
    const k = dayKey(ts);
    if (k in buckets) buckets[k] += 1;
  }
  return buckets;
}

/**
 * Compute current-run-to-date progress for an active project: totals, per-store
 * yield ratios, error counts/rate, and a daily breakdown for the last
 * BREAKDOWN_DAYS (for week-over-week detection inside the run).
 */
export async function computeProgress(
  project: ProjectConfig,
  runStartMs: number,
  nowMs: number
): Promise<ProgressSummary> {
  const storesCompleted = await countEventsBetween(project.app, project.completedEvent.eventType, runStartMs, nowMs);

  const yields: YieldRatio[] = await Promise.all(
    project.yieldEvents.map(async (y) => {
      const total = await countEventsBetween(project.app, y.eventType, runStartMs, nowMs);
      return {
        key: y.key,
        label: y.label,
        total,
        perStore: storesCompleted > 0 ? total / storesCompleted : null,
      };
    })
  );

  const errors = await Promise.all(
    project.errorEvents.map(async (e) => ({
      key: e.key,
      label: e.label,
      count: await countEventsBetween(project.app, e.eventType, runStartMs, nowMs),
    }))
  );
  const totalErrors = errors.reduce((s, e) => s + e.count, 0);

  // daily breakdown over the trailing BREAKDOWN_DAYS (bounded by run start)
  const breakdownFrom = Math.max(runStartMs, nowMs - BREAKDOWN_DAYS * DAY_MS);
  const primaryYieldEvent = project.yieldEvents[0]?.eventType;
  const [completedTs, yieldTs, ...errorTsArrays] = await Promise.all([
    eventTimestampsBetween(project.app, project.completedEvent.eventType, breakdownFrom, nowMs),
    primaryYieldEvent
      ? eventTimestampsBetween(project.app, primaryYieldEvent, breakdownFrom, nowMs)
      : Promise.resolve<number[]>([]),
    ...project.errorEvents.map((e) => eventTimestampsBetween(project.app, e.eventType, breakdownFrom, nowMs)),
  ]);
  const completedBuckets = bucketByDay(completedTs, breakdownFrom, nowMs);
  const yieldBuckets = bucketByDay(yieldTs, breakdownFrom, nowMs);
  const errorTs = ([] as number[]).concat(...errorTsArrays);
  const errorBuckets = bucketByDay(errorTs, breakdownFrom, nowMs);
  const dailyBreakdown: DayPoint[] = Object.keys(completedBuckets)
    .sort()
    .map((date) => ({
      date,
      storesCompleted: completedBuckets[date],
      primaryYield: yieldBuckets[date] || 0,
      errors: errorBuckets[date] || 0,
    }));

  return {
    app: project.app,
    name: project.name,
    runStartMs,
    storesCompleted,
    yields,
    errors,
    errorRate: storesCompleted > 0 ? totalErrors / storesCompleted : null,
    dailyBreakdown,
  };
}
