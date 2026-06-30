/**
 * Conservation / balance checks (pure). Combines queue metrics with stored
 * terminal-event counts to surface silent data loss and the catch-all-fallback
 * mismatch, plus stuck-batch warnings.
 */
const STUCK_AGE_SEC = 10 * 24 * 60 * 60; // ~10d; SQS default retention is 14d

export interface BalanceInput {
  queue: string;
  sent: number;
  deleted: number;
  oldestAgeSec: number | null;
  /** terminal events stored in the same 24h window (e.g. process completed) */
  storedTerminal: number;
  /** max visible messages in the window (for consumer-stall detection) */
  visibleMax?: number | null;
  /** days until the oldest message expires (retention − oldestAge) */
  cliffDays?: number | null;
  /** whether the queue has a dead-letter redrive policy */
  dlq?: boolean | null;
}

export interface BalanceResult {
  queue: string;
  sent: number;
  deleted: number;
  storedTerminal: number;
  /** sent - deleted: messages received but not acked (possible silent loss) */
  sentMinusDeleted: number;
  /** deleted - storedTerminal: acked without a terminal event (catch-all-fallback) */
  deletedMinusStored: number;
  oldestAgeSec: number | null;
  flags: string[];
}

/** Relative gap above which a divergence is worth flagging (10%). */
const GAP_RATIO = 0.1;
/** flag the retention cliff when the oldest message is this close to expiry */
const CLIFF_WARN_DAYS = 3;

export function computeBalance(input: BalanceInput): BalanceResult {
  const { queue, sent, deleted, storedTerminal, oldestAgeSec, visibleMax, cliffDays, dlq } = input;
  const sentMinusDeleted = sent - deleted;
  const deletedMinusStored = deleted - storedTerminal;
  const flags: string[] = [];

  // consumer stall: messages waiting but nothing drained in the window — the
  // earliest signal of a dead consumer (fires before the retention cliff).
  if (visibleMax !== null && visibleMax !== undefined && visibleMax > 0 && deleted === 0) {
    flags.push(`consumer-stall: ${visibleMax} messages visible but 0 deleted in 24h`);
  }
  if (sent > 0 && sentMinusDeleted / sent > GAP_RATIO) {
    flags.push('possible-silent-loss: messages sent >> deleted');
  }
  if (deleted > 0 && deletedMinusStored / deleted > GAP_RATIO) {
    flags.push('completion-mismatch: deleted >> stored terminal events (catch-all-fallback?)');
  }
  if (cliffDays !== null && cliffDays !== undefined && cliffDays <= CLIFF_WARN_DAYS) {
    flags.push(`retention-cliff: oldest message expires in ~${cliffDays.toFixed(1)}d`);
  } else if (oldestAgeSec !== null && oldestAgeSec > STUCK_AGE_SEC) {
    flags.push(`stuck-batch: oldest message ~${Math.round(oldestAgeSec / 86400)}d (near retention)`);
  }
  if (dlq === false && visibleMax !== null && visibleMax !== undefined && visibleMax > 0) {
    flags.push('no-DLQ: failed messages recycle until expiry (silent-loss risk)');
  }

  return {
    queue,
    sent,
    deleted,
    storedTerminal,
    sentMinusDeleted,
    deletedMinusStored,
    oldestAgeSec,
    flags,
  };
}
