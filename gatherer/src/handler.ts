import { PROJECTS, ProjectConfig } from './projects';
import { detectRun } from './modules/detector';
import { computeProgress } from './modules/progress';
import { ensureBaseline } from './modules/baseline';
import { getQueueMetrics } from './modules/queue';
import { getProxyHealth } from './modules/proxyhealth';
import { computeBalance } from './modules/balance';
import { getCost } from './modules/cost';
import { getPerf } from './modules/perf';
import { getOverprovision } from './modules/overprovision';
import { countEventsBetween } from './lib/dynamo';
import { Pack, ProjectPack, writePack } from './modules/packer';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Gather one project's slice. Isolated so one project failing doesn't kill the report. */
async function gatherProject(project: ProjectConfig, nowMs: number): Promise<ProjectPack> {
  const [run, baseline, queues, proxy, completed24h] = await Promise.all([
    detectRun(project),
    ensureBaseline(project).catch((e) => {
      console.error(`baseline failed for ${project.app}:`, e);
      return null;
    }),
    getQueueMetrics(project.queues, nowMs),
    getProxyHealth(project, nowMs),
    countEventsBetween(project.app, project.completedEvent.eventType, nowMs - DAY_MS, nowMs),
  ]);

  const progress =
    run.active && run.runStartMs
      ? await computeProgress(project, run.runStartMs, nowMs)
      : undefined;

  // balance per queue; the main (first) queue is compared against stored terminals.
  const balance = queues.map((q, i) =>
    computeBalance({
      queue: q.queue,
      sent: q.sent,
      deleted: q.deleted,
      oldestAgeSec: q.oldestAgeSec,
      storedTerminal: i === 0 ? completed24h : q.deleted, // only main queue maps to terminals
    })
  );

  return {
    name: project.name,
    app: project.app,
    active: run.active,
    runId: run.runId,
    runStartMs: run.runStartMs,
    dayNumber: run.runStartMs ? Math.floor((nowMs - run.runStartMs) / DAY_MS) + 1 : undefined,
    progress,
    baseline,
    queues,
    balance,
    proxy,
  };
}

export const handler = async (): Promise<{ status: string; date: string; bucket?: string }> => {
  const nowMs = Date.now();
  const date = new Date(nowMs).toISOString().slice(0, 10);
  console.log(`bd-daily-report gatherer starting for ${date}`);

  // per-project, fault-isolated
  const projects: ProjectPack[] = [];
  for (const p of PROJECTS) {
    try {
      projects.push(await gatherProject(p, nowMs));
    } catch (err) {
      console.error(`project ${p.app} failed:`, err);
      projects.push({
        name: p.name,
        app: p.app,
        active: false,
        baseline: null,
        queues: [],
        balance: [],
        proxy: { app: p.app, totalProxyEvents: 0, byType: [] },
      });
    }
  }

  // account-wide modules, fault-isolated
  const [cost, perf] = await Promise.all([
    getCost(nowMs).catch((e) => {
      console.error('cost failed:', e);
      return { currency: 'USD', byService: [], lambdaByUsageType: [], latestDayEstimated: true };
    }),
    getPerf(nowMs).catch((e) => {
      console.error('perf failed:', e);
      return [];
    }),
  ]);
  const overprovision = await getOverprovision(perf.map((f) => f.name), nowMs).catch((e) => {
    console.error('overprovision failed:', e);
    return [];
  });

  const pack: Pack = {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    date,
    projects,
    cost,
    perf,
    overprovision,
  };

  await writePack(pack);
  console.log(`pack written: packs/${date}.json`);
  return { status: 'ok', date, bucket: process.env.BD_REPORT_BUCKET };
};
