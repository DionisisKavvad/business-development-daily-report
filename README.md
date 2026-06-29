# bd-daily-report

Daily cross-project scrape **progress + cost + Lambda perf** report with AI investigation.
Uploads an HTML report to S3 and posts a presigned link to Slack.

Covers: `scrape-facebook-ads`, `scrape-facebook-posts`, `scrape-the-greek-ecommerce-v2`.

Design: `docs/superpowers/specs/2026-06-29-bd-daily-report-design.md`.

## Architecture (hybrid, security-first)

```
EventBridge cron 06:00 UTC
   └─ gatherer Lambda (IAM role, in-AWS)  ── reads DynamoDB / Cost Explorer / CloudWatch / SQS metrics
        └─ writes projected pack.json → s3://<bucket>/packs/
Claude cloud routine 06:30 UTC (Anthropic infra)
   └─ reads ONLY the pack (tiny S3 key) → investigates → render HTML → S3 → presign → Slack
```

The broad/unscopable reads (Cost Explorer, CloudWatch) stay inside AWS on the Lambda role.
The cloud routine holds only an S3-scoped key + Slack token. See spec "Security posture".

## Layout

- `gatherer/` — serverless Lambda that builds the pack (deployed to AWS).
- `routine/` — node scripts run by the Claude cloud routine (`fetch-pack`, `publish`, `render`).
- `config/config.{prod,dev}.yml` — profile + SSM param names + bucket.

## Local development

Run the full gatherer against prod data without touching AWS infra (writes to `./.local-report/`):

```bash
npm install
npm run gather:local            # writes .local-report/packs/<date>.json + baselines/
```

Dry-run the report HTML from a local pack + an insights file:

```bash
npm run --workspace routine publish -- \
  gatherer/.local-report/packs/latest.json path/to/insights.json --dry-run --out /tmp/report.html
```

## Deploy (manual AWS steps — run with the `equalityAdmin` profile)

Get the account id once: `aws sts get-caller-identity --profile equalityAdmin --query Account --output text`

1. **Create the report bucket** (private, SSE, block public access), eu-west-1:
   ```bash
   ACCT=$(aws sts get-caller-identity --profile equalityAdmin --query Account --output text)
   BUCKET=bd-daily-reports-$ACCT
   aws s3api create-bucket --bucket $BUCKET --region eu-west-1 \
     --create-bucket-configuration LocationConstraint=eu-west-1 --profile equalityAdmin
   aws s3api put-public-access-block --bucket $BUCKET --profile equalityAdmin \
     --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
   aws s3api put-bucket-encryption --bucket $BUCKET --profile equalityAdmin \
     --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   ```
   (The gatherer derives the bucket name as `bd-daily-reports-<accountId>` — see `config.prod.yml`.)

2. **Slack** — no new param. Reuse the existing daily-progress channel and bot token:
   ```bash
   aws ssm get-parameter --profile equalityAdmin --name /prod/facebook-ads/slack-report-channel --query Parameter.Value --output text   # channel id
   aws ssm get-parameter --profile equalityAdmin --name /prod/facebook-ads/slack-bot-token --with-decryption --query Parameter.Value --output text   # bot token
   ```
   These two values go into the routine secrets in step 5. The bot is already in that channel.

3. **Deploy the gatherer** (creates the Lambda, daily cron, and its least-privilege role):
   ```bash
   cd gatherer && npx serverless deploy --stage prod
   # smoke test:
   npx serverless invoke --stage prod --function gatherer
   aws s3 ls s3://bd-daily-reports-$ACCT/packs/ --profile equalityAdmin
   ```

4. **Cloud-side IAM user** (`bd-daily-report-cloud`) — long-lived key, S3-only on this bucket:
   ```bash
   aws iam create-user --user-name bd-daily-report-cloud --profile equalityAdmin
   aws iam put-user-policy --user-name bd-daily-report-cloud --policy-name s3-report-only \
     --profile equalityAdmin --policy-document '{
       "Version":"2012-10-17",
       "Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],
         "Resource":"arn:aws:s3:::bd-daily-reports-'"$ACCT"'/*"}]}'
   aws iam create-access-key --user-name bd-daily-report-cloud --profile equalityAdmin
   ```
   Save the access key — it goes into the routine secrets (step 5).

5. **Create the cloud routine** via `/schedule` (daily ~06:30 UTC). Prompt = `routine/ROUTINE_PROMPT.md`.
   Routine env secrets:
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (from step 4)
   - `AWS_REGION=eu-west-1`
   - `BD_REPORT_BUCKET=bd-daily-reports-<accountId>`
   - `SLACK_BOT_TOKEN`, `SLACK_REPORT_CHANNEL` (the two values read in step 2 — the existing
     daily-progress channel + bot token)

6. **Guardrails** (recommended): AWS Budgets + Cost Anomaly alert; CloudTrail; rotate the
   cloud access key every 30–90d (`aws iam create-access-key` → update routine → delete old).

## Notes / out of scope

- Per-project cost needs `app=` tags on the 3 scraper repos' serverless.yml (Phase 2 follow-up).
- No-DLQ / SQS-delete-before-processing are detected (queue balance) but fixed in the scraper repos.
- The report is an early-warning detector, not a fix.
