import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageCommandInput,
} from '@aws-sdk/client-cost-explorer';

/**
 * Cost Explorer. The CE API is global and only reachable via us-east-1,
 * regardless of where the data lives. Each request bills $0.01, so we make few,
 * well-grouped calls. Data lags ~24h; the latest day is Estimated.
 */
const ce = new CostExplorerClient({ region: 'us-east-1' });

export interface CostCell {
  date: string;
  group: string;
  amount: number;
}

export interface CostSummary {
  currency: string;
  byService: CostCell[]; // last 7 days, grouped by SERVICE
  lambdaByUsageType: CostCell[]; // last 7 days, Lambda only, grouped by USAGE_TYPE
  latestDayEstimated: boolean;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseGroups(
  res: Awaited<ReturnType<typeof ce.send>> extends infer _ ? any : any
): { cells: CostCell[]; currency: string } {
  const cells: CostCell[] = [];
  let currency = 'USD';
  for (const day of res.ResultsByTime || []) {
    const date = day.TimePeriod?.Start as string;
    for (const g of day.Groups || []) {
      const metric = g.Metrics?.UnblendedCost;
      if (metric?.Unit) currency = metric.Unit;
      cells.push({
        date,
        group: (g.Keys && g.Keys[0]) || 'unknown',
        amount: Number(metric?.Amount || '0'),
      });
    }
  }
  return { cells, currency };
}

export async function getCost(nowMs: number): Promise<CostSummary> {
  const now = new Date(nowMs);
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 1); // End is exclusive; +1 to include today
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 7);
  const TimePeriod = { Start: ymd(start), End: ymd(end) };

  const byServiceInput: GetCostAndUsageCommandInput = {
    TimePeriod,
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
  };
  const lambdaInput: GetCostAndUsageCommandInput = {
    TimePeriod,
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
    Filter: { Dimensions: { Key: 'SERVICE', Values: ['AWS Lambda'] } },
  };

  const [svcRes, lambdaRes] = await Promise.all([
    ce.send(new GetCostAndUsageCommand(byServiceInput)),
    ce.send(new GetCostAndUsageCommand(lambdaInput)),
  ]);

  const svc = parseGroups(svcRes);
  const lambda = parseGroups(lambdaRes);

  return {
    currency: svc.currency,
    byService: svc.cells,
    lambdaByUsageType: lambda.cells,
    latestDayEstimated: true,
  };
}
