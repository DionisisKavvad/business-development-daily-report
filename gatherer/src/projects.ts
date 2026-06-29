/**
 * Per-project registry. All project-specific knowledge lives here.
 *
 * Event-type strings and app names are verified against the source repos
 * (scrape-facebook-ads, scrape-facebook-posts, scrape-the-greek-ecommerce-v2).
 * They are matched on GSI6: GSI6PK = `EVENT#<eventType>`,
 * GSI6SK = `TENANT#<tenant>#APP#<app>#TIMESTAMP#<ms>`.
 */

export interface LabeledEvent {
  /** exact eventType string as written to unifiedEvents */
  eventType: string;
  /** short key used in the pack JSON */
  key: string;
  /** human label for the report */
  label: string;
}

export interface ProjectConfig {
  /** display name */
  name: string;
  /** GSI6 app segment */
  app: string;
  /** run lifecycle markers */
  runStarted: string;
  runCompleted: string;
  /**
   * Per-store terminal event. Its count == stores processed, and is the
   * denominator for per-store yield. (one terminal event ~= one store done)
   */
  completedEvent: LabeledEvent;
  /** numerator events for per-store yield (e.g. ads/posts/products saved) */
  yieldEvents: LabeledEvent[];
  /** error / ban events to track */
  errorEvents: LabeledEvent[];
  /** proxy-starvation signal event types (no-proxy / proxy ban) */
  proxyEvents: string[];
  /** main scraping SQS queue names (prod-...) for queue metrics */
  queues: string[];
  /** state machine names (prod-...) for RUNNING fallback + perf */
  stateMachines: string[];
}

export const PROJECTS: ProjectConfig[] = [
  {
    name: 'Facebook Ads',
    app: 'facebook-ads',
    runStarted: 'Facebook Ads Run Started',
    runCompleted: 'Facebook Ads Run Completed',
    completedEvent: { eventType: 'Facebook Ad Process Completed', key: 'storesCompleted', label: 'Stores completed' },
    yieldEvents: [
      { eventType: 'Facebook Ad Saved', key: 'adsSaved', label: 'Ads saved' },
    ],
    errorEvents: [
      { eventType: 'Facebook Ad Ban Detected', key: 'bans', label: 'Ad bans' },
      { eventType: 'GraphQL Usage Limit Detected', key: 'rateLimits', label: 'Rate limits' },
      { eventType: 'Processing Error', key: 'processingErrors', label: 'Processing errors' },
    ],
    proxyEvents: ['Proxy Banned'],
    queues: ['prod-stores-in-facebook-ads', 'prod-facebook-ads-post-processing'],
    stateMachines: ['prod-scrape-facebook-ads', 'prod-post-process-facebook-ads'],
  },
  {
    name: 'Facebook Posts',
    app: 'scrape-posts',
    runStarted: 'Facebook Posts Run Started',
    runCompleted: 'Facebook Posts Run Completed',
    completedEvent: { eventType: 'Facebook Posts Process Completed', key: 'storesCompleted', label: 'Stores completed' },
    yieldEvents: [
      { eventType: 'Facebook Post Saved', key: 'postsSaved', label: 'Posts saved' },
      { eventType: 'Posts Found', key: 'postsFound', label: 'Stores with posts' },
      { eventType: 'Posts Not Found', key: 'postsNotFound', label: 'Stores without posts' },
    ],
    errorEvents: [
      { eventType: 'Scraping Posts Facebook Ban Login Detected', key: 'softBans', label: 'Soft bans' },
      { eventType: 'Scraping Posts Facebook Possible Hard Ban Detected', key: 'hardBans', label: 'Hard bans' },
    ],
    proxyEvents: ['Active Proxies Not Found', 'Proxy Connection Failed', 'Proxy Banned'],
    queues: ['prod-stores-in-facebook-posts'],
    stateMachines: ['prod-scrape-facebook-posts'],
  },
  {
    name: 'Greek Ecommerce',
    app: 'scrape-eshops',
    runStarted: 'Scrape Eshops Run Started',
    runCompleted: 'Scrape Eshops Run Completed',
    completedEvent: { eventType: 'Store Scrape At Marketplace Completed', key: 'storesCompleted', label: 'Stores completed' },
    yieldEvents: [
      // products are emitted under a different app (scrape-eshop-products); tracked
      // via a dedicated extra-app count in progress.ts, not here.
    ],
    errorEvents: [
      { eventType: 'Store Ban Error', key: 'storeBans', label: 'Store bans' },
      { eventType: 'Proxy Banned', key: 'proxyBans', label: 'Proxy bans' },
      { eventType: 'Connection Error', key: 'connectionErrors', label: 'Connection errors' },
    ],
    proxyEvents: ['Proxy Banned'],
    queues: ['ecommerce-prod-stores-in-bulk-sqs', 'ecommerce-prod-stores-in-shuffle-sqs'],
    stateMachines: ['prod-scrape-greek-stores', 'prod-scrape-greek-marketplaces'],
  },
];
