import { latestEvent } from '../lib/dynamo';
import { ProjectConfig } from '../projects';

export interface RunState {
  active: boolean;
  /** run id from the Run Started event properties, if present */
  runId?: string;
  /** ms timestamp of the active run's start */
  runStartMs?: number;
  /** ms timestamp of the last completed run's start (for baseline pairing) */
  lastCompletedRunStartMs?: number;
  /** total stores enqueued for this run (from Run Started properties), if present */
  universe?: number;
}

/**
 * Detect whether a project has an active run: latest Run Started is newer than
 * latest Run Completed (or there is no completion). Open-run-marker detection.
 */
export async function detectRun(project: ProjectConfig): Promise<RunState> {
  const [started, completed] = await Promise.all([
    latestEvent(project.app, project.runStarted),
    latestEvent(project.app, project.runCompleted),
  ]);

  if (!started) {
    return { active: false };
  }

  const startedMs: number = started.timestamp;
  const completedMs: number | undefined = completed?.timestamp;
  const active = completedMs === undefined || startedMs > completedMs;
  const universe =
    typeof started.properties?.totalStores === 'number' ? started.properties.totalStores : undefined;

  return {
    active,
    runId: started.properties?.runId,
    runStartMs: active ? startedMs : undefined,
    // when the current run is active, the previous completion marks the baseline run;
    // when idle, the latest started run is itself the last completed one.
    lastCompletedRunStartMs: active ? undefined : startedMs,
    universe,
  };
}
