import { distinctStoresBetween } from '../lib/dynamo';
import { ProjectConfig } from '../projects';

/**
 * Store-level coverage for a run window. This is the metric that reveals silent
 * loss directly: the run's own counter reports completedEvent *event count*
 * (inflated by retries/re-injections), while `processedDistinct` is the true
 * number of distinct stores touched. `neverProcessed` = universe − distinct is
 * the count of stores that were enqueued but never got a terminal event.
 *
 * `measurable` is false when the completedEvent doesn't carry a per-store id
 * (the GSI1PK is the UNKNOWN_STORE sentinel, e.g. Facebook Ads) — then the
 * distinct/never-processed numbers can't be trusted and the report says so
 * rather than printing a misleading figure.
 */
export interface Coverage {
  /** total stores enqueued for the run (Run Started.totalStores), null if unknown */
  universe: number | null;
  /** distinct stores with a completedEvent (true stores touched) */
  processedDistinct: number;
  /** raw completedEvent count (inflated by retries) */
  processedEvents: number;
  /** processedEvents / processedDistinct (>1 means reprocessing / wasted work) */
  reprocessRatio: number | null;
  /** universe − processedDistinct, clamped at 0; null if universe unknown or not measurable */
  neverProcessed: number | null;
  /** whether the completedEvent carries usable per-store ids */
  measurable: boolean;
}

export async function computeCoverage(
  project: ProjectConfig,
  fromMs: number,
  toMs: number,
  universe: number | null
): Promise<Coverage> {
  const { distinct, total, unknown } = await distinctStoresBetween(
    project.app,
    project.completedEvent.eventType,
    fromMs,
    toMs
  );
  // not measurable when there are events but (nearly) none carry a real store id
  const measurable = total === 0 || unknown / total < 0.5;
  return {
    universe,
    processedDistinct: distinct,
    processedEvents: total,
    reprocessRatio: distinct > 0 ? total / distinct : null,
    neverProcessed: !measurable || universe === null ? null : Math.max(0, universe - distinct),
    measurable,
  };
}
