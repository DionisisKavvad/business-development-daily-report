import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

/**
 * Memory over-provisioning is NOT a CloudWatch metric; it only appears in the
 * Lambda REPORT log line. One Logs Insights query across all heavy functions'
 * log groups, grouped by @log, surfaces provisioned vs used memory.
 *   >80% used  -> bump (OOM/slowness risk)
 *   <30-40%    -> over-provisioned (paying for unused GB-seconds)
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 40;

const logs = new CloudWatchLogsClient({ region: process.env.AWS_REGION });

export interface OverprovisionRow {
  logGroup: string;
  provisionedMB: number | null;
  maxUsedMB: number | null;
  avgUsedMB: number | null;
  /** maxUsed / provisioned */
  utilization: number | null;
}

const QUERY = `filter @type = "REPORT"
| stats max(@memorySize)/1048576 as provisionedMB,
        max(@maxMemoryUsed)/1048576 as maxUsedMB,
        avg(@maxMemoryUsed)/1048576 as avgUsedMB by @log`;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param functionNames heavy Lambda function names (log group is /aws/lambda/<name>)
 */
export async function getOverprovision(
  functionNames: string[],
  nowMs: number
): Promise<OverprovisionRow[]> {
  if (functionNames.length === 0) return [];
  const logGroupNames = functionNames.slice(0, 50).map((n) => `/aws/lambda/${n}`);

  let queryId: string | undefined;
  try {
    const started = await logs.send(
      new StartQueryCommand({
        logGroupNames,
        startTime: Math.floor((nowMs - DAY_MS) / 1000),
        endTime: Math.floor(nowMs / 1000),
        queryString: QUERY,
      })
    );
    queryId = started.queryId;
  } catch (err) {
    // missing log groups etc. — non-fatal for the report
    console.error('overprovision StartQuery failed:', err);
    return [];
  }
  if (!queryId) return [];

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const res = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      return (res.results || []).map((row) => {
        const get = (f: string) => row.find((c) => c.field === f)?.value;
        const num = (f: string) => {
          const v = get(f);
          return v === undefined ? null : Number(v);
        };
        const provisionedMB = num('provisionedMB');
        const maxUsedMB = num('maxUsedMB');
        return {
          logGroup: get('@log') || 'unknown',
          provisionedMB,
          maxUsedMB,
          avgUsedMB: num('avgUsedMB'),
          utilization: provisionedMB && maxUsedMB ? maxUsedMB / provisionedMB : null,
        };
      });
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
      console.error('overprovision query status:', res.status);
      return [];
    }
  }
  console.error('overprovision query did not complete in time');
  return [];
}
