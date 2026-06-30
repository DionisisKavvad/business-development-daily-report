import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

/**
 * SQS health: throughput via CloudWatch (namespace AWS/SQS), config via SQS
 * GetQueueAttributes. `sent` vs `deleted` reveals silent loss; `oldestAgeSec`
 * vs `retentionSec` gives the retention cliff (days until messages expire);
 * absence of a redrive policy (`dlq=false`) means failed messages recycle until
 * they expire — the structural enabler of silent loss.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const cw = new CloudWatchClient({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });

export interface QueueMetrics {
  queue: string;
  sent: number;
  deleted: number;
  visibleMax: number | null;
  oldestAgeSec: number | null;
  /** message retention period in seconds (config), null if unreadable */
  retentionSec: number | null;
  /** days until the oldest message expires (retention − oldestAge), null if unknown */
  cliffDays: number | null;
  /** whether the queue has a dead-letter redrive policy */
  dlq: boolean | null;
}

/** Read static queue config (retention, redrive policy). Best-effort per queue. */
async function getQueueConfig(
  queue: string
): Promise<{ retentionSec: number | null; dlq: boolean | null }> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queue }));
    if (!QueueUrl) return { retentionSec: null, dlq: null };
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['MessageRetentionPeriod', 'RedrivePolicy'],
      })
    );
    const retention = Attributes?.MessageRetentionPeriod;
    return {
      retentionSec: retention !== undefined ? Number(retention) : null,
      dlq: Attributes ? Boolean(Attributes.RedrivePolicy) : null,
    };
  } catch {
    return { retentionSec: null, dlq: null };
  }
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

  const configs = await Promise.all(queueNames.map((q) => getQueueConfig(q)));

  return queueNames.map((q, i) => {
    const v = (suffix: string): number | null => {
      const x = values[`q${i}_${suffix}`];
      return x === undefined ? null : x;
    };
    const oldestAgeSec = v('age');
    const { retentionSec, dlq } = configs[i];
    const cliffDays =
      oldestAgeSec !== null && retentionSec !== null
        ? (retentionSec - oldestAgeSec) / 86400
        : null;
    return {
      queue: q,
      sent: v('sent') || 0,
      deleted: v('del') || 0,
      visibleMax: v('vis'),
      oldestAgeSec,
      retentionSec,
      cliffDays,
      dlq,
    };
  });
}
