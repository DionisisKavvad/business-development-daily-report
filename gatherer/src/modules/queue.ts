import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from '@aws-sdk/client-cloudwatch';

/**
 * SQS health via CloudWatch (namespace AWS/SQS, dimension QueueName) — no SQS
 * permission needed. `sent` vs `deleted` vs stored terminal events reveals
 * silent loss; `oldestAgeSec` near retention reveals stuck batches.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const cw = new CloudWatchClient({ region: process.env.AWS_REGION });

export interface QueueMetrics {
  queue: string;
  sent: number;
  deleted: number;
  visibleMax: number | null;
  oldestAgeSec: number | null;
}

const STATS: { suffix: string; metric: string; stat: string }[] = [
  { suffix: 'sent', metric: 'NumberOfMessagesSent', stat: 'Sum' },
  { suffix: 'del', metric: 'NumberOfMessagesDeleted', stat: 'Sum' },
  { suffix: 'vis', metric: 'ApproximateNumberOfMessagesVisible', stat: 'Maximum' },
  { suffix: 'age', metric: 'ApproximateAgeOfOldestMessage', stat: 'Maximum' },
];

export async function getQueueMetrics(queueNames: string[], nowMs: number): Promise<QueueMetrics[]> {
  if (queueNames.length === 0) return [];

  const queries: MetricDataQuery[] = [];
  queueNames.forEach((q, i) => {
    for (const s of STATS) {
      queries.push({
        Id: `q${i}_${s.suffix}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/SQS',
            MetricName: s.metric,
            Dimensions: [{ Name: 'QueueName', Value: q }],
          },
          Period: DAY_MS / 1000,
          Stat: s.stat,
        },
        ReturnData: true,
      });
    }
  });

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
      if (r.Id && r.Values && r.Values.length > 0) values[r.Id] = r.Values[0];
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return queueNames.map((q, i) => {
    const v = (suffix: string): number | null => {
      const x = values[`q${i}_${suffix}`];
      return x === undefined ? null : x;
    };
    return {
      queue: q,
      sent: v('sent') || 0,
      deleted: v('del') || 0,
      visibleMax: v('vis'),
      oldestAgeSec: v('age'),
    };
  });
}
