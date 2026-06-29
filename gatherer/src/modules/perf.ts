import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';

/**
 * Lambda compute signals. There is no CPU% metric (CPU scales with memory), so
 * we track Duration (avg + p99), Invocations, Errors, Throttles,
 * ConcurrentExecutions, and estimate GB-seconds = avgDuration x invocations x
 * memory. Heavy functions are discovered by memory threshold (no name guessing).
 */
const HEAVY_MEMORY_MB = 512;
const MAX_FUNCTIONS = 80; // keep GetMetricData under the 500-query cap (6 queries/fn)
const DAY_MS = 24 * 60 * 60 * 1000;

/** Only the 3 BD scraper projects' Lambdas (by service-name substring); excludes
 *  unrelated account workloads (eca/cosmote/akked/etc.). */
const SCRAPER_NAME_PARTS = [
  'facebook-ads',
  'scrape-ads',
  'detect-pages',
  'detect-store-page',
  'facebook-posts',
  'scrape-posts',
  'scrape-eshop',
  'process-eshops',
  'detect-store-logo',
  'detect-logos',
  'scrape-greek',
];

function isScraperFn(name: string): boolean {
  const n = name.toLowerCase();
  return SCRAPER_NAME_PARTS.some((p) => n.includes(p));
}

const lambda = new LambdaClient({ region: process.env.AWS_REGION });
const cw = new CloudWatchClient({ region: process.env.AWS_REGION });

export interface FnPerf {
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
}

async function discoverHeavyFunctions(): Promise<{ name: string; memoryMB: number }[]> {
  const found: { name: string; memoryMB: number }[] = [];
  let marker: string | undefined;
  do {
    const res = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    for (const fn of res.Functions || []) {
      if ((fn.MemorySize || 0) >= HEAVY_MEMORY_MB && fn.FunctionName && isScraperFn(fn.FunctionName)) {
        found.push({ name: fn.FunctionName, memoryMB: fn.MemorySize as number });
      }
    }
    marker = res.NextMarker;
  } while (marker);
  found.sort((a, b) => b.memoryMB - a.memoryMB);
  return found.slice(0, MAX_FUNCTIONS);
}

const STATS: { suffix: string; metric: string; stat: string }[] = [
  { suffix: 'inv', metric: 'Invocations', stat: 'Sum' },
  { suffix: 'err', metric: 'Errors', stat: 'Sum' },
  { suffix: 'thr', metric: 'Throttles', stat: 'Sum' },
  { suffix: 'davg', metric: 'Duration', stat: 'Average' },
  { suffix: 'dp99', metric: 'Duration', stat: 'p99' },
  { suffix: 'conc', metric: 'ConcurrentExecutions', stat: 'Maximum' },
];

export async function getPerf(nowMs: number): Promise<FnPerf[]> {
  const funcs = await discoverHeavyFunctions();
  if (funcs.length === 0) return [];

  const queries: MetricDataQuery[] = [];
  funcs.forEach((fn, i) => {
    for (const s of STATS) {
      queries.push({
        Id: `m${i}_${s.suffix}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/Lambda',
            MetricName: s.metric,
            Dimensions: [{ Name: 'FunctionName', Value: fn.name }],
          },
          Period: DAY_MS / 1000,
          Stat: s.stat,
        },
        ReturnData: true,
      });
    }
  });

  // GetMetricData accepts up to 500 queries per call; our cap keeps us under it.
  const values: Record<string, number> = {};
  let nextToken: string | undefined;
  do {
    const res = await cw.send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: new Date(nowMs - DAY_MS),
        EndTime: new Date(nowMs),
        NextToken: nextToken,
      })
    );
    for (const r of res.MetricDataResults || []) {
      // one daily datapoint expected; take the latest value if multiple
      if (r.Id && r.Values && r.Values.length > 0) values[r.Id] = r.Values[0];
    }
    nextToken = res.NextToken;
  } while (nextToken);

  const rows = funcs.map((fn, i) => {
    const v = (suffix: string): number | null => {
      const x = values[`m${i}_${suffix}`];
      return x === undefined ? null : x;
    };
    const invocations = v('inv') || 0;
    const errors = v('err') || 0;
    const durationAvgMs = v('davg');
    const gbSecondsEst =
      durationAvgMs !== null
        ? (durationAvgMs / 1000) * invocations * (fn.memoryMB / 1024)
        : null;
    return {
      name: fn.name,
      memoryMB: fn.memoryMB,
      invocations,
      errors,
      throttles: v('thr') || 0,
      errorRate: invocations > 0 ? errors / invocations : null,
      durationAvgMs,
      durationP99Ms: v('dp99'),
      concurrentMax: v('conc'),
      gbSecondsEst,
    };
  });

  // keep only functions that actually ran in the window (drops idle/cross-project
  // noise); most cost/perf-relevant first.
  return rows
    .filter((r) => r.invocations > 0)
    .sort((a, b) => (b.gbSecondsEst || 0) - (a.gbSecondsEst || 0));
}
