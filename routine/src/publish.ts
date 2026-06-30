/**
 * Render the HTML report from a pack + AI insights, upload to S3, presign, and
 * post the link to Slack.
 *
 * Usage:
 *   tsx src/publish.ts <pack.json> <insights.json>            # real publish
 *   tsx src/publish.ts <pack.json> <insights.json> --dry-run  # write HTML locally only
 *   (optional) --out <path>   override local html path for --dry-run
 */
import * as fs from 'fs';
import { renderHtml } from './render';
import { Pack, Insights } from './types';
import { putHtml, presign, getText } from './lib/s3';
import { postReportLink } from './lib/slack';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** YYYY-MM-DD of the day before `date`. */
function prevDate(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Yesterday's pack from S3 for vs-yesterday deltas (null if missing/unreadable). */
async function loadPrevPack(date: string): Promise<Pack | null> {
  try {
    return JSON.parse(await getText(`packs/${prevDate(date)}.json`)) as Pack;
  } catch {
    return null;
  }
}

async function main() {
  const packPath = process.argv[2];
  const insightsPath = process.argv[3];
  if (!packPath || !insightsPath) {
    throw new Error('usage: publish.ts <pack.json> <insights.json> [--dry-run] [--out <path>]');
  }
  const dryRun = process.argv.includes('--dry-run');

  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8')) as Pack;
  const insights = JSON.parse(fs.readFileSync(insightsPath, 'utf8')) as Insights;

  if (dryRun) {
    // allow a local prev pack via --prev for offline delta testing
    const prevPath = arg('--prev');
    const prev = prevPath ? (JSON.parse(fs.readFileSync(prevPath, 'utf8')) as Pack) : null;
    const html = renderHtml(pack, insights, prev);
    const out = arg('--out') || `./report-${pack.date}.html`;
    fs.writeFileSync(out, html);
    console.log(`[dry-run] wrote ${out} (${html.length} bytes)`);
    return;
  }

  const prev = await loadPrevPack(pack.date);
  const html = renderHtml(pack, insights, prev);

  const key = `html/${pack.date}.html`;
  await putHtml(key, html);
  const url = await presign(key, 7);

  const criticalCount = insights.findings.filter((f) => f.severity === 'critical').length;
  const oneLiner =
    insights.findings.length > 0
      ? `${insights.findings.length} finding(s), ${criticalCount} critical`
      : 'all nominal';

  if (process.argv.includes('--no-slack')) {
    console.log(`published ${key} (Slack skipped). Presigned URL:\n${url}`);
    return;
  }

  await postReportLink({ date: pack.date, url, oneLiner, criticalCount });
  console.log(`published ${key} and posted to Slack`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
