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

export function computeBalance(input: BalanceInput): BalanceResult {
  const { queue, sent, deleted, storedTerminal, oldestAgeSec } = input;
  const sentMinusDeleted = sent - deleted;
  const deletedMinusStored = deleted - storedTerminal;
  const flags: string[] = [];

  if (sent > 0 && sentMinusDeleted / sent > GAP_RATIO) {
    flags.push('possible-silent-loss: messages sent >> deleted');
  }
  if (deleted > 0 && deletedMinusStored / deleted > GAP_RATIO) {
    flags.push('completion-mismatch: deleted >> stored terminal events (catch-all-fallback?)');
  }
  if (oldestAgeSec !== null && oldestAgeSec > STUCK_AGE_SEC) {
    flags.push(`stuck-batch: oldest message ~${Math.round(oldestAgeSec / 86400)}d (near retention)`);
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
