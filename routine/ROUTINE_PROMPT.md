# BD Daily Report — cloud routine prompt

Paste this as the prompt of the scheduled cloud routine (`/schedule`, daily ~06:30 UTC).
It runs in the Claude cloud sandbox, which has these env vars set as routine secrets:
`AWS_REGION=eu-west-1`, `BD_REPORT_BUCKET`, `SLACK_BOT_TOKEN`, `SLACK_REPORT_CHANNEL`,
and AWS creds (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) scoped to `s3:GetObject`+`s3:PutObject`
on this bucket only. The sandbox reads ONLY the pack — no broad AWS access.

---

You are generating the daily Business Development scrape report. Work in `routine/`.

1. Install deps if needed: `npm ci` (in repo root).
2. Fetch the latest data pack:
   `npm run --workspace routine fetch-pack > /tmp/pack.json`
   (If this fails because no pack exists yet, stop and report that the gatherer has not run.)
3. Read `/tmp/pack.json`. It is already aggregated/projected (counts, ratios, timestamps —
   no raw content). Investigate it like an SRE. Specifically look for:
   - **Undercounting / data-quality**: any project where `progress.yields[].perStore` diverges
     sharply (>25%) from `baseline.yields[].perStore`. A yield that dropped and stayed low is the
     months-long-bug signature. A yield of ~1.0 ads/store or exactly N is suspicious (limit bug).
   - **Within-run break**: in `progress.dailyBreakdown`, a sudden drop in `storesCompleted` or
     `primaryYield`, or a spike in `errors` (rate-limit stall, duplicate spike).
   - **Silent loss / queue health**: `balance[].flags` — `possible-silent-loss`,
     `completion-mismatch`, `stuck-batch`. Treat stuck-batch (near 14d retention) as CRITICAL.
   - **Proxies down (machines off)**: a project that is `active` with heavy-fn invocations up in
     `perf` but `storesCompleted`/yield ≈ 0 and Duration near max, and/or high `proxy.totalProxyEvents`.
   - **Cost / perf regressions**: `cost.byService` week-over-week jumps; `perf[]` high error rate,
     throttles > 0, p99 spikes; `overprovision` rows >80% (bump) or <35% (over-provisioned).
4. Write `/tmp/insights.json` with this exact shape:
   ```json
   {
     "summary": "<one short paragraph, GREEK, plain language>",
     "findings": [
       {"severity": "critical|warn|info", "title": "<short>", "detail": "<what + why + what to check, GREEK>"}
     ]
   }
   ```
   - Only include findings that the numbers support. If all nominal, summary says so and findings = [].
   - Correlate signals into one finding where they share a cause (e.g. proxy bans + zero yield +
     high duration → "proxies down").
5. Publish:
   `npm run --workspace routine publish -- /tmp/pack.json /tmp/insights.json`
   This renders the HTML, uploads to S3, presigns (7d), and posts the link to Slack.
6. Confirm the publish step printed `published ... and posted to Slack`. Report the outcome briefly.

Do NOT read or print AWS credentials or `.env` files. Do not attempt any AWS call beyond what the
scripts do (the credentials only allow S3 on the report bucket anyway).
