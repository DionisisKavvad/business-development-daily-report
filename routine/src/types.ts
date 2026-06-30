/**
 * Minimal pack shape consumed by the routine (mirrors gatherer packer output).
 * Kept loose/permissive so rendering tolerates absent fields.
 */
export interface YieldRatio {
  key: string;
  label: string;
  total: number;
  perStore: number | null;
}

export interface Coverage {
  universe: number | null;
  processedDistinct: number;
  processedEvents: number;
  reprocessRatio: number | null;
  neverProcessed: number | null;
  measurable: boolean;
}

export interface ProjectPack {
  name: string;
  app: string;
  active: boolean;
  runId?: string;
  runStartMs?: number;
  dayNumber?: number;
  progress?: {
    storesCompleted: number;
    yields: YieldRatio[];
    errors: { key: string; label: string; count: number }[];
    errorRate: number | null;
    dailyBreakdown: { date: string; storesCompleted: number; primaryYield: number; errors: number }[];
  };
  coverage?: Coverage;
  baseline: {
    runStartMs: number;
    runEndMs: number;
    storesCompleted: number;
    yields: YieldRatio[];
    errorRate: number | null;
    coverage?: Coverage;
  } | null;
  queues: {
    queue: string;
    sent: number;
    deleted: number;
    visibleMax: number | null;
    oldestAgeSec: number | null;
    retentionSec?: number | null;
    cliffDays?: number | null;
    dlq?: boolean | null;
  }[];
  balance: {
    queue: string;
    sent: number;
    deleted: number;
    storedTerminal: number;
    sentMinusDeleted: number;
    deletedMinusStored: number;
    oldestAgeSec: number | null;
    flags: string[];
  }[];
  proxy: { app: string; totalProxyEvents: number; byType: { eventType: string; count: number }[] };
}

export interface Pack {
  schemaVersion: number;
  generatedAt: string;
  date: string;
  projects: ProjectPack[];
  cost: {
    currency: string;
    byService: { date: string; group: string; amount: number }[];
    lambdaByUsageType: { date: string; group: string; amount: number }[];
    latestDayEstimated: boolean;
  };
  perf: {
    name: string;
    memoryMB: number;
    invocations: number;
    errors: number;
    throttles: number;
    errorRate: number | null;
    durationAvgMs: number | null;
    durationP99Ms: number | null;
    concurrentMax: number | null;
    gbSecondsEst: number | null;
  }[];
  overprovision: {
    logGroup: string;
    provisionedMB: number | null;
    maxUsedMB: number | null;
    avgUsedMB: number | null;
    utilization: number | null;
  }[];
}

/** AI investigation output, produced by the cloud routine and fed to render. */
export interface Insights {
  /** one-paragraph plain-language summary (Greek) */
  summary: string;
  findings: {
    severity: 'info' | 'warn' | 'critical';
    title: string;
    detail: string;
    /** optional project name to attribute the finding to a card (else shown in the banner) */
    project?: string;
  }[];
}
