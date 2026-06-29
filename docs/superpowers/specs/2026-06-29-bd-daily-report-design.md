# bd-daily-report — Design Spec

**Date:** 2026-06-29
**Status:** Approved for planning
**Owner:** Dionisis

## Goal

Ένα daily routine που για κάθε business-development scraper project που τρέχει σε
production και κάνει scrape εκείνη την περίοδο, παράγει ένα **progress + cost + perf
update** σαν HTML, το ανεβάζει σε S3, και στέλνει το link στο Slack. Το AI πρέπει να
**βλέπει τα νούμερα και να κάνει διερεύνηση** όταν κάτι πάει στραβά (συσχετίσεις,
εξήγηση anomalies, priorities) — όχι απλώς να τυπώνει νούμερα.

## Projects σε scope

Και τα 3 γράφουν στο ίδιο shared DynamoDB table (SSM `/prod/core/unifiedEvents-table`
→ `prod_equality_unified_logs`), tenant `gbinnovations`, region `eu-west-1`, AWS profile
`equalityAdmin` / alias "equality".

| Project | App name | Run markers |
|---|---|---|
| scrape-facebook-ads | scrape-ads | `Facebook Ads Run Started` / `Facebook Ads Run Completed` |
| scrape-facebook-posts | scrape-posts | `Facebook Posts Run Started` / (no Completed event → SFN status) |
| scrape-the-greek-ecommerce-v2 | scrape-eshops | `Scrape Eshops Run Started` / `Scrape Eshops Run Completed` |

## Architecture: C (Hybrid), Investigation Επίπεδο 2

Σαφές σύνορο ασφαλείας: **οι broad AWS reads δεν φεύγουν ποτέ από το AWS.**

```
EventBridge cron (06:00 UTC)
        │
        ▼
[A] Gatherer Lambda (IAM role, in-account, μηδέν long-lived keys)
        │  queries: DynamoDB GSI6 + Cost Explorer + CloudWatch + Logs Insights + Lambda config
        ▼
   pack.json  →  s3://bd-reports/packs/YYYY-MM-DD.json  (private, SSE)
        │
        ▼  (Claude routine, ~06:30 UTC, διαβάζει ΜΟΝΟ αυτό)
[B] Claude cloud routine (Anthropic infra)
        │  investigate → narrative → render HTML → upload → presign → Slack
        ▼
   s3://bd-reports/html/YYYY-MM-DD.html  →  presigned 7d  →  Slack report-channel
```

### Γιατί αυτό κι όχι "scripts με κανόνες"
Τα pre-coded rules πιάνουν μόνο ό,τι προβλέφθηκε. Το AI πάνω σε γενναιόδωρο evidence
pack βρίσκει **συσχετίσεις που δεν γράφτηκε κανόνας** (π.χ. "κόστος +32% ταυτόχρονα με
duration p99 ×2 + throttles + bans → proxy bans προκαλούν retries"), σε καθαρά ελληνικά,
με priority. Δουλεύει χωρίς live access, αρκεί το pack να είναι πλούσιο.

### Γιατί Επίπεδο 2 κι όχι 3 (live agentic)
Επ. 3 (το Claude τραβάει μόνο του logs/metrics on-demand) θέλει broad read-only AWS
creds στο plain-text cloud env → ξαναφέρνει το security πρόβλημα. Ξεκινάμε με Επ. 2
(creds = 1 S3 prefix). Αναβάθμιση σε Επ. 3 αργότερα **μόνο** αν το AI συχνά ζητάει
δεδομένα εκτός pack, και τότε scoped (logs/metrics read, **χωρίς** Cost Explorer).

## Component A — Gatherer Lambda

Ένα entrypoint, isolated modules:

1. **detector** — per project: GSI6 query latest `Run Started` vs latest `Run Completed`.
   Active αν Started > Completed (ή no Completed). Posts: fallback σε Step Functions
   `ListExecutions` RUNNING.
2. **progress** — για active projects: count metric events από run-start (total) + 24h
   window. Per-project metric specs (ads: ad process completed, posts: posts found/not
   found + bans, eshops: store scrape completed + availability).
3. **cost** — Cost Explorer (`ce.us-east-1.amazonaws.com`):
   - `GetCostAndUsage` DAILY, Metrics `[UnblendedCost]`, GroupBy SERVICE, last 7 days.
   - 2η κλήση GroupBy USAGE_TYPE, filter Service=`AWS Lambda` (GB-Second vs Request).
   - Per-project cost = **Φάση 2** (θέλει tag `app=` στα 3 serverless.yml).
   - Caveats: ~24h lag (τελευταία μέρα Estimated), $0.01/request → λίγες grouped κλήσεις.
4. **perf** — ένα `GetMetricData` batch για τα heavy lambdas (λίστα παρακάτω):
   Duration (Average + p99), Invocations (Sum), Errors (Sum), Throttles (Sum),
   ConcurrentExecutions (Maximum), period 86400. GB-seconds = Duration × MemorySize
   (από `ListFunctions`/`GetFunctionConfiguration`). Error rate = Errors/Invocations.
5. **overprovisioning** — Logs Insights στο `REPORT` line: `@maxMemoryUsed` vs
   `@memorySize` per heavy function (>80% bump, <30-40% over-provisioned). Daily ή weekly.
6. **queue** — SQS metrics (CloudWatch namespace `AWS/SQS`, dimension QueueName) ανά
   scraping queue: `NumberOfMessagesSent`, `NumberOfMessagesDeleted`,
   `ApproximateNumberOfMessagesVisible`, `ApproximateAgeOfOldestMessage`. (Live depth
   προαιρετικά με `sqs:GetQueueAttributes`.)
7. **proxyhealth** — σήμα proxy starvation: count no-proxy / proxy-ban error events στο
   unifiedEvents, + (προαιρετικά) Logs Insights στο `get-active-proxies` για πλήθος active
   proxies. Το βασικό signal υπολογίζεται στο AI layer (correlation, βλ. παρακάτω).
8. **packer** — μαζεύει τα πάνω σε ένα γενναιόδωρο `pack.json` → S3 PutObject. **First-class
   metrics (εδώ κρύβεται το 80% του value — οι months-long bugs φάνηκαν μόνο εδώ):**
   - **Per-store yield**: ads/store, posts/store, products/store (όχι σκέτα absolute counts).
   - **Week-over-week deltas** για κάθε μέγεθος (count, yield, error rate, cost).
   - **Balance / conservation checks**:
     - `MessagesSent ≈ MessagesDeleted ≈ stored terminal events` (απόκλιση = silent loss).
     - `completed (DynamoDB) ↔ queue drained (SQS)` (mismatch = catch-all-fallback bug).
     - `running_count = running_prev + entered − terminal` (running ↑ ενώ completions flat
       = ban-retry overcounting).
   - **Stuck-batch warning**: `ApproximateAgeOfOldestMessage` κοντά στο retention (14d).
   - Top errors **με τα μηνύματά τους**.

### Detection coverage (από ανάλυση 9 πραγματικών incidents)

Με τα παραπάνω, σήματα που πιάνονται και **πώς** (όλα μέσα στο in-AWS role, μηδέν extra
cloud creds):

| Πρόβλημα | Σήμα | Confidence |
|---|---|---|
| Undercounting (random 1-10, debug=2) | per-store yield + WoW | high |
| Rate-limit stall | calls/h ↓, error rate ↑, cost/ad ↑ | high |
| Duplicate events | per-store yield spike + WoW | high |
| Ban-retry overcounting | conservation: running↑ vs completions flat | high |
| **Silent data loss** | SQS sent↔deleted↔stored balance (+age) | med (>5% loss· <2% trickle θέλει DLQ code fix) |
| **Catch-all-fallback wrong event** | completed↔queue-drained mismatch | med-high |
| **Proxies down (κλειστά μηχανήματα)** | active run + Invocations↑ + yield≈0 + Duration≈max· + no-proxy errors | high |

Honest όρια: το routine είναι **early-warning/detector**, όχι fix. Το no-DLQ και το
SQS-delete-before-processing **διορθώνονται σωστά με code/infra** (βάλε DLQ, μετακίνησε το
delete μετά το processing)· το report απλώς τα κάνει ορατά νωρίς.

**Heavy lambdas προς παρακολούθηση** (από inventory, 150+ συνολικά):
- `facebook` (posts) — 2048MB/900s, puppeteer, ζυγούς μήνες
- `find-facebook-page` (greek) — 1400MB, puppeteer
- `get-skroutz-stores` (900s), `get-bestprice-stores` (600s) (greek)
- `exportDynamodbToS3`/`exportAllEvents` (ads) — 1024MB
- Throttles > 0 = χτυπάς concurrency limit (συχνό σε puppeteer fleet)

**IAM role policy (least-privilege):**
- `dynamodb:Query` σε table ARN **+ index ARN** (`table/prod_equality_unified_logs/index/*`)
- `ssm:GetParameter`/`GetParameters` στο `/prod/*` (+ `kms:Decrypt` αν SecureString)
- `ce:GetCostAndUsage` (Resource `*` — δεν κλειδώνεται)
- `cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` (Resource `*`)
- `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery`, `logs:DescribeLogGroups`
- `lambda:ListFunctions`, `lambda:GetFunctionConfiguration`
- `states:ListExecutions`, `states:DescribeExecution` (scoped σε state machine ARNs)
- `sqs:GetQueueAttributes` (scoped σε scraping queue ARNs· προαιρετικό — τα SQS metrics
  έρχονται ήδη μέσω `cloudwatch:GetMetricData` namespace `AWS/SQS` χωρίς extra perm)
- `s3:PutObject` στο `bd-reports/packs/*`

## Component B — Claude cloud routine

- **Schedule:** daily ~06:30 UTC (μετά τη Lambda). Via `/schedule` skill.
- **Steps:** read latest `pack.json` → investigate (συσχετίσεις/εξήγηση/priority πάνω σε
  yield + WoW + balance/conservation· π.χ. "active αλλά yield≈0 + Duration≈max → proxies
  down", "completed↔queue mismatch", "running↑ vs completions flat") → ελληνικό narrative +
  AI insights section → render self-contained HTML (inline CSS:
  header + σύνοψη, ένα card ανά active project με progress, cost section, perf section,
  **AI insights** section) → S3 PutObject `bd-reports/html/YYYY-MM-DD.html` → presign 7d
  → Slack `chat.postMessage` στο report-channel (ημερομηνία + link + one-liner).
- **Secrets στο cloud env (2, tiny blast radius):**
  - AWS key: `s3:GetObject` + `s3:PutObject` **μόνο** στο `bd-reports/*`
  - Slack bot token (post σε **ένα** channel)
- **Hardening:** `.claude/settings.json` deny rules για credential files· minimal
  network access· το pack είναι pre-digested (μικρή επιφάνεια prompt-injection).

## Security posture (από το research)

- Cloud routine secrets = **plain-text env vars** σε Anthropic-managed VM, readable από
  όποιον κάνει edit το env, χωρίς masking/rotation. Anthropic: long-lived creds **δεν
  συνιστώνται**.
- AWS: long-lived keys discouraged (SEC02-BP02)· OIDC μη εφικτό (δεν ελέγχουμε Anthropic
  infra)· "third-party clients" είναι sanctioned exception.
- **Κρίσιμο:** `ce:GetCostAndUsage` + `cloudwatch:GetMetricData` **δεν** κλειδώνονται σε
  ARN → ένα key που τα έχει = account-wide cost/metrics read. Γι' αυτό μένουν στη Lambda.
- Net: leak του cloud key = read/write report bucket prefix + post σε 1 Slack channel.

### Operational guardrails
- CloudTrail enabled· AWS Budgets + Cost Anomaly alerts (το CE είναι chargeable + leak target).
- Rotate το S3 key σε fixed cadence (30-90d), έλεγχος με access-key-last-used.
- IAM Access Analyzer policy generation από CloudTrail μετά το πρώτο run για tightening.

## Defaults / open items

- **Per-project cost:** Φάση 2 (tagging `app=` στα 3 serverless.yml). Φάση 1 = per-service.
- **Bucket:** νέο dedicated private `bd-daily-reports-<accountId>`.
- **Cron:** Lambda 06:00 UTC, routine 06:30 UTC.
- **Slack:** υπάρχον report-channel (SSM `/prod/facebook-ads/slack-report-channel` +
  `slack-bot-token`) — επιβεβαίωση ότι το bot έχει access στο channel.

## Build order (κάθε βήμα verifiable)

1. Gatherer: detector + progress (+ per-store yield + WoW) → local run με creds Dionisis, verify σωστά active projects + counts vs DynamoDB.
2. Gatherer: cost + perf + overprovisioning → verify νούμερα vs Console.
3. Gatherer: queue (SQS metrics) + proxyhealth + balance/conservation checks → verify σε γνωστό incident pattern (π.χ. stale oldest-message-age).
4. Gatherer: packer + S3 PutObject + EventBridge cron → verify `pack.json` εμφανίζεται καθημερινά.
5. IAM: gatherer role + Claude-side S3 key + bucket → verify least-privilege (deny ό,τι εκτός).
6. Routine: read pack → render HTML (`--dry-run` local) → verify HTML.
7. Routine: S3 upload + presign + Slack → verify link φτάνει στο channel.
8. `/schedule` routine daily → manual trigger → verify end-to-end.

## Non-goals (YAGNI)

- Όχι live agentic AWS access στο Claude (Επ. 3) τώρα.
- Όχι historical dashboard/UI — μόνο daily HTML snapshot.
- Όχι αλλαγές στη scraping logic των 3 projects (μόνο tagging σε Φάση 2).
