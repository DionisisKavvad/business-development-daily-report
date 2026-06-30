import { latestEvent, latestEventBefore } from '../lib/dynamo';
import { getJson, putJson } from '../lib/s3';
import { computeProgress } from './progress';
import { computeCoverage, Coverage } from './coverage';
import { ProjectConfig } from '../projects';

/**
 * Frozen normalized summary of the previous COMPLETED run. Computed once at the
 * run boundary (or on cold start) and stored in S3; read as-is each day so the
 * gatherer does not recompute history daily. Comparison against the live run is
 * normalized (per-store yield, error rate), never absolute, because this is a
 * finished run vs a mid-flight one.
 */
export interface BaselineSummary {
  app: string;
  runStartMs: number;
  runEndMs: number;
  storesCompleted: number;
  yields: { key: string; label: string; total: number; perStore: number | null }[];
  errors: { key: string; label: string; count: number }[];
  errorRate: number | null;
  /** frozen store-level coverage of this completed run */
  coverage: Coverage;
  frozenAt: number;
}

function baselineKey(app: string): string {
  return `baselines/${app}/last-completed-run.json`;
}

/** Find the most recent completed run's [startMs, endMs] for a project, or null. */
export async function getLastCompletedRun(
  project: ProjectConfig
): Promise<{ startMs: number; endMs: number; runId?: string; universe: number | null } | null> {
  const completed = await latestEvent(project.app, project.runCompleted);
  if (!completed) return null;
  const endMs: number = completed.timestamp;
  const start = await latestEventBefore(project.app, project.runStarted, endMs);
  if (!start) return null;
  const universe =
    typeof start.properties?.totalStores === 'number' ? start.properties.totalStores : null;
  return { startMs: start.timestamp, endMs, runId: completed.properties?.runId, universe };
}

async function computeBaseline(
  project: ProjectConfig,
  startMs: number,
  endMs: number,
  universe: number | null
): Promise<BaselineSummary> {
  const [p, coverage] = await Promise.all([
    computeProgress(project, startMs, endMs),
    computeCoverage(project, startMs, endMs, universe),
  ]);
  return {
    app: project.app,
    runStartMs: startMs,
    runEndMs: endMs,
    storesCompleted: p.storesCompleted,
    yields: p.yields,
    errors: p.errors,
    errorRate: p.errorRate,
    coverage,
    frozenAt: Date.now(),
  };
}

/**
 * Ensure the frozen baseline reflects the latest completed run.
 * - cold start (no baseline): compute and store.
 * - new completion (baseline.runStartMs !== last completed run start): recompute once.
 * - otherwise: return the stored baseline unchanged (no recompute).
 * Returns the baseline, or null if the project has no completed run yet.
 */
export async function ensureBaseline(project: ProjectConfig): Promise<BaselineSummary | null> {
  const last = await getLastCompletedRun(project);
  if (!last) return null;

  const existing = await getJson<BaselineSummary>(baselineKey(project.app));
  if (existing && existing.runStartMs === last.startMs && existing.coverage) {
    return existing;
  }

  const fresh = await computeBaseline(project, last.startMs, last.endMs, last.universe);
  await putJson(baselineKey(project.app), fresh);
  return fresh;
}
