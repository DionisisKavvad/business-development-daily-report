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
import { putHtml, presign } from './lib/s3';
import { postReportLink } from './lib/slack';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
  const html = renderHtml(pack, insights);

  if (dryRun) {
    const out = arg('--out') || `./report-${pack.date}.html`;
    fs.writeFileSync(out, html);
    console.log(`[dry-run] wrote ${out} (${html.length} bytes)`);
    return;
  }

  const key = `html/${pack.date}.html`;
  await putHtml(key, html);
  const url = await presign(key, 7);

  const criticalCount = insights.findings.filter((f) => f.severity === 'critical').length;
  const oneLiner =
    insights.findings.length > 0
      ? `${insights.findings.length} finding(s), ${criticalCount} critical`
      : 'all nominal';

  await postReportLink({ date: pack.date, url, oneLiner, criticalCount });
  console.log(`published ${key} and posted to Slack`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
