import { countEventsBetween } from '../lib/dynamo';
import { ProjectConfig } from '../projects';

/**
 * Proxy-starvation signal. Counts no-proxy / proxy-ban events in the last 24h.
 * The strong signal ("active run + invocations up + yield ~0 + Duration ~max =
 * proxies down, likely because machines are off") is correlated by the AI layer
 * from the assembled pack; here we provide the raw counts it needs.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProxyHealth {
  app: string;
  totalProxyEvents: number;
  byType: { eventType: string; count: number }[];
}

export async function getProxyHealth(project: ProjectConfig, nowMs: number): Promise<ProxyHealth> {
  const from = nowMs - DAY_MS;
  const byType = await Promise.all(
    project.proxyEvents.map(async (eventType) => ({
      eventType,
      count: await countEventsBetween(project.app, eventType, from, nowMs),
    }))
  );
  return {
    app: project.app,
    totalProxyEvents: byType.reduce((s, e) => s + e.count, 0),
    byType,
  };
}
