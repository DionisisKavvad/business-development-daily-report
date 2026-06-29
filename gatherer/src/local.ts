/**
 * Local verification entrypoint. Runs the real gatherer handler with S3 routed
 * to a local directory (BD_LOCAL), so the full pack is built end-to-end against
 * prod data without touching any AWS infra (bucket/Lambda are deployed later).
 *
 * Usage: npm run gather:local
 * Output: ./.local-report/packs/<date>.json + baselines/<app>/last-completed-run.json
 */
import { handler } from './handler';

async function main() {
  const res = await handler();
  console.log('\nresult:', JSON.stringify(res));
  console.log(`pack + baselines written under: ${process.env.BD_LOCAL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
