/**
 * Download the latest pack from S3 and print it to stdout.
 * The cloud routine pipes this to a file, reads/analyzes it, then runs publish.
 *
 * Usage: tsx src/fetch-pack.ts > pack.json
 */
import { getText } from './lib/s3';

async function main() {
  const json = await getText('packs/latest.json');
  process.stdout.write(json);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
