import { putJson } from '../lib/s3';
import { ProgressSummary } from './progress';
import { Coverage } from './coverage';
import { BaselineSummary } from './baseline';
import { QueueMetrics } from './queue';
import { BalanceResult } from './balance';
import { ProxyHealth } from './proxyhealth';
import { CostSummary } from './cost';
import { FnPerf } from './perf';
import { OverprovisionRow } from './overprovision';

/**
 * The pack is the ONLY thing the Claude cloud routine reads. It is projected by
 * construction: every module produces aggregates / counts / ratios / timestamps
 * — never raw scraped content, post/ad text, PII, URLs, or tokens. So the
 * data-minimization allow-list is satisfied upstream; nothing here re-introduces
 * raw fields.
 */
export interface ProjectPack {
  name: string;
  app: string;
  active: boolean;
  runId?: string;
  runStartMs?: number;
  dayNumber?: number;
  progress?: ProgressSummary;
  /** store-level coverage of the current (active) run */
  coverage?: Coverage;
  baseline: BaselineSummary | null;
  queues: QueueMetrics[];
  balance: BalanceResult[];
  proxy: ProxyHealth;
}

export interface Pack {
  schemaVersion: 1;
  generatedAt: string;
  date: string; // YYYY-MM-DD (UTC)
  projects: ProjectPack[];
  cost: CostSummary;
  perf: FnPerf[];
  overprovision: OverprovisionRow[];
}

/** Write the pack to packs/YYYY-MM-DD.json and packs/latest.json. */
export async function writePack(pack: Pack): Promise<void> {
  await Promise.all([
    putJson(`packs/${pack.date}.json`, pack),
    putJson('packs/latest.json', pack),
  ]);
}
