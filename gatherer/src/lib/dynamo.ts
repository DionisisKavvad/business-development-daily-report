import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, QueryCommandInput } from '@aws-sdk/lib-dynamodb';

/**
 * GSI6 query helpers for the shared unifiedEvents table.
 * Ported from scrape-facebook-ads detect-pages-service/src/services/reportQueryService.ts.
 *
 * GSI6PK = `EVENT#<eventType>`
 * GSI6SK = `TENANT#<tenant>#APP#<app>#TIMESTAMP#<ms>`
 */

const TABLE = process.env.UNIFIED_EVENTS_TABLE as string;
const TENANT = process.env.TENANT_ID || 'gbinnovations';
const GSI6 = 'GSI6';
const MAX_TS = '9999999999999';

const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function skPrefix(app: string): string {
  return `TENANT#${TENANT}#APP#${app}#`;
}

/** Count events of a type for an app within [fromMs, toMs] (inclusive). Paginates. */
export async function countEventsBetween(
  app: string,
  eventType: string,
  fromMs: number,
  toMs: number = Number(MAX_TS)
): Promise<number> {
  let count = 0;
  let lastKey: Record<string, any> | undefined;
  do {
    const params: QueryCommandInput = {
      TableName: TABLE,
      IndexName: GSI6,
      KeyConditionExpression: 'GSI6PK = :pk AND GSI6SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `EVENT#${eventType}`,
        ':start': `${skPrefix(app)}TIMESTAMP#${fromMs}`,
        ':end': `${skPrefix(app)}TIMESTAMP#${toMs}`,
      },
      Select: 'COUNT',
      ExclusiveStartKey: lastKey,
    };
    const res = await docClient.send(new QueryCommand(params));
    count += res.Count || 0;
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

/** Most recent event of a type for an app (or null). */
export async function latestEvent(
  app: string,
  eventType: string
): Promise<Record<string, any> | null> {
  const params: QueryCommandInput = {
    TableName: TABLE,
    IndexName: GSI6,
    KeyConditionExpression: 'GSI6PK = :pk AND begins_with(GSI6SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `EVENT#${eventType}`,
      ':prefix': skPrefix(app),
    },
    ScanIndexForward: false,
    Limit: 1,
  };
  const res = await docClient.send(new QueryCommand(params));
  return res.Items && res.Items.length > 0 ? res.Items[0] : null;
}

/** Most recent event of a type for an app at or before `beforeMs` (or null). */
export async function latestEventBefore(
  app: string,
  eventType: string,
  beforeMs: number
): Promise<Record<string, any> | null> {
  const params: QueryCommandInput = {
    TableName: TABLE,
    IndexName: GSI6,
    KeyConditionExpression: 'GSI6PK = :pk AND GSI6SK BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': `EVENT#${eventType}`,
      ':start': `${skPrefix(app)}TIMESTAMP#0`,
      ':end': `${skPrefix(app)}TIMESTAMP#${beforeMs}`,
    },
    ScanIndexForward: false,
    Limit: 1,
  };
  const res = await docClient.send(new QueryCommand(params));
  return res.Items && res.Items.length > 0 ? res.Items[0] : null;
}

/**
 * Fetch items (not COUNT) of a type for an app within a window, projecting only
 * `timestamp`. Used for bucketing by day. Paginates. Returns timestamps (ms).
 */
export async function eventTimestampsBetween(
  app: string,
  eventType: string,
  fromMs: number,
  toMs: number = Number(MAX_TS)
): Promise<number[]> {
  const out: number[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const params: QueryCommandInput = {
      TableName: TABLE,
      IndexName: GSI6,
      KeyConditionExpression: 'GSI6PK = :pk AND GSI6SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':pk': `EVENT#${eventType}`,
        ':start': `${skPrefix(app)}TIMESTAMP#${fromMs}`,
        ':end': `${skPrefix(app)}TIMESTAMP#${toMs}`,
      },
      ProjectionExpression: '#ts',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExclusiveStartKey: lastKey,
    };
    const res = await docClient.send(new QueryCommand(params));
    for (const it of res.Items || []) {
      if (typeof it.timestamp === 'number') out.push(it.timestamp);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}
