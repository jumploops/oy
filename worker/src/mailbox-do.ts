import { DurableObject } from "cloudflare:workers";
import { hashTextHex } from "./lib/hashing";
import { minuteEpochFromMs, nowMs } from "./lib/time";
import type { Env } from "./lib/types";

interface InitializeProfileInput {
  agentId: string;
  name: string;
  software: string | null;
  discoverable: boolean;
  secret: string;
  createdAtMs: number;
}

interface DeliverMessageInput {
  messageId: string;
  fromAgentId: string;
  createdAtMs: number;
  replyToMessageId: string | null;
}

interface RecordSentMessageInput {
  messageId: string;
  requestId: string;
  toAgentId: string;
  createdAtMs: number;
}

interface MailboxStats {
  agent_id: string;
  sent_count: number;
  received_count: number;
  returned_count: number;
  recent_peers: Array<{
    agent_id: string;
    sent_count: number;
    received_count: number;
    last_sent_ms: number | null;
    last_received_ms: number | null;
  }>;
}

interface SentRecord {
  message_id: string;
  request_id: string;
  created_at_ms: number;
}

export class MailboxDO extends DurableObject {
  private readonly sql: SqlStorage;
  private readonly retentionDays: number;
  private readonly retentionMaxMessages: number;

  constructor(
    ctx: DurableObjectState,
    env: Env,
  ) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.retentionDays = readInt(env.INBOX_RETENTION_DAYS, 30);
    this.retentionMaxMessages = readInt(env.INBOX_RETENTION_MAX_MESSAGES, 1000);
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      await this.scheduleNextAlarm();
    });
  }

  async initializeProfile(input: InitializeProfileInput): Promise<{ created: boolean }> {
    const existing = this.first<{ agent_id: string }>(
      "SELECT agent_id FROM profile WHERE agent_id = ? LIMIT 1",
      input.agentId,
    );
    if (existing) {
      return { created: false };
    }

    const secretHash = await hashTextHex(input.secret);
    this.sql.exec(
      `
        INSERT INTO profile (agent_id, name, software, discoverable, secret_hash, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.agentId,
      input.name,
      input.software,
      input.discoverable ? 1 : 0,
      secretHash,
      input.createdAtMs,
    );

    this.ensureCounter("sent_count");
    this.ensureCounter("received_count");
    this.ensureCounter("returned_count");
    await this.scheduleNextAlarm();

    return { created: true };
  }

  async authenticate(secret: string): Promise<{ ok: boolean }> {
    const row = this.first<{ secret_hash: string }>(
      "SELECT secret_hash FROM profile LIMIT 1",
    );
    if (!row) {
      return { ok: false };
    }

    const candidateHash = await hashTextHex(secret);
    return { ok: candidateHash === row.secret_hash };
  }

  async deliverMessage(
    input: DeliverMessageInput,
  ): Promise<{ status: "accepted" | "duplicate" | "not_found"; seq: number | null }> {
    const profile = this.first<{ agent_id: string }>(
      "SELECT agent_id FROM profile LIMIT 1",
    );
    if (!profile) {
      return { status: "not_found", seq: null };
    }

    const existing = this.first<{ seq: number }>(
      "SELECT seq FROM inbox WHERE message_id = ? LIMIT 1",
      input.messageId,
    );
    if (existing) {
      return { status: "duplicate", seq: existing.seq };
    }

    this.sql.exec(
      `
        INSERT INTO inbox (message_id, from_agent_id, created_at_ms, reply_to_message_id)
        VALUES (?, ?, ?, ?)
      `,
      input.messageId,
      input.fromAgentId,
      input.createdAtMs,
      input.replyToMessageId,
    );

    const inserted = this.first<{ seq: number }>(
      "SELECT seq FROM inbox WHERE message_id = ? LIMIT 1",
      input.messageId,
    );

    this.incrementCounter("received_count", 1);
    this.sql.exec(
      `
        INSERT INTO peers (peer_agent_id, last_received_ms, received_count)
        VALUES (?, ?, 1)
        ON CONFLICT(peer_agent_id) DO UPDATE SET
          last_received_ms = excluded.last_received_ms,
          received_count = peers.received_count + 1
      `,
      input.fromAgentId,
      input.createdAtMs,
    );

    if (input.replyToMessageId) {
      const matchedSent = this.first<{ got_reply: number }>(
        "SELECT got_reply FROM sent WHERE message_id = ? LIMIT 1",
        input.replyToMessageId,
      );

      if (matchedSent && matchedSent.got_reply === 0) {
        this.sql.exec(
          "UPDATE sent SET got_reply = 1 WHERE message_id = ?",
          input.replyToMessageId,
        );
        this.incrementCounter("returned_count", 1);
      }
    }

    await this.scheduleNextAlarm();
    return { status: "accepted", seq: inserted?.seq ?? null };
  }

  async recordSentMessage(
    input: RecordSentMessageInput,
  ): Promise<{ recorded: boolean }> {
    const existing = this.first<{ message_id: string }>(
      "SELECT message_id FROM sent WHERE message_id = ? OR request_id = ? LIMIT 1",
      input.messageId,
      input.requestId,
    );

    if (existing) {
      return { recorded: false };
    }

    this.sql.exec(
      `
        INSERT INTO sent (message_id, request_id, to_agent_id, created_at_ms, got_reply)
        VALUES (?, ?, ?, ?, 0)
      `,
      input.messageId,
      input.requestId,
      input.toAgentId,
      input.createdAtMs,
    );

    this.incrementCounter("sent_count", 1);
    this.sql.exec(
      `
        INSERT INTO peers (peer_agent_id, last_sent_ms, sent_count)
        VALUES (?, ?, 1)
        ON CONFLICT(peer_agent_id) DO UPDATE SET
          last_sent_ms = excluded.last_sent_ms,
          sent_count = peers.sent_count + 1
      `,
      input.toAgentId,
      input.createdAtMs,
    );

    await this.scheduleNextAlarm();
    return { recorded: true };
  }

  async getSentRecord(
    messageId: string,
    requestId: string,
  ): Promise<SentRecord | null> {
    return this.first<SentRecord>(
      `
        SELECT message_id, request_id, created_at_ms
        FROM sent
        WHERE message_id = ? OR request_id = ?
        LIMIT 1
      `,
      messageId,
      requestId,
    );
  }

  async listInbox(after: number, limit: number): Promise<{
    messages: Array<{
      seq: number;
      message_id: string;
      from_agent_id: string;
      created_at_ms: number;
      reply_to_message_id: string | null;
    }>;
    next_after: number;
  }> {
    const rows = this.all<{
      seq: number;
      message_id: string;
      from_agent_id: string;
      created_at_ms: number;
      reply_to_message_id: string | null;
    }>(
      `
        SELECT seq, message_id, from_agent_id, created_at_ms, reply_to_message_id
        FROM inbox
        WHERE seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `,
      after,
      limit,
    );

    return {
      messages: rows,
      next_after: rows.at(-1)?.seq ?? after,
    };
  }

  async getRecentPeers(limit: number): Promise<MailboxStats["recent_peers"]> {
    return this.all<MailboxStats["recent_peers"][number]>(
      `
        SELECT
          peer_agent_id AS agent_id,
          sent_count,
          received_count,
          last_sent_ms,
          last_received_ms
        FROM peers
        ORDER BY MAX(COALESCE(last_sent_ms, 0), COALESCE(last_received_ms, 0)) DESC
        LIMIT ?
      `,
      limit,
    );
  }

  async getStats(): Promise<MailboxStats> {
    const profile = this.first<{ agent_id: string }>(
      "SELECT agent_id FROM profile LIMIT 1",
    );

    return {
      agent_id: profile?.agent_id ?? "",
      sent_count: this.getCounter("sent_count"),
      received_count: this.getCounter("received_count"),
      returned_count: this.getCounter("returned_count"),
      recent_peers: await this.getRecentPeers(20),
    };
  }

  async checkAndIncrementRateLimit(
    timestampMs: number,
    maxPerMinute: number,
  ): Promise<{ allowed: boolean; remaining: number }> {
    const windowEpochMinute = minuteEpochFromMs(timestampMs);
    const row = this.first<{ sent_count: number }>(
      `
        SELECT sent_count
        FROM rate_limit_windows
        WHERE window_epoch_minute = ?
        LIMIT 1
      `,
      windowEpochMinute,
    );

    const used = row?.sent_count ?? 0;
    if (used >= maxPerMinute) {
      return { allowed: false, remaining: 0 };
    }

    this.sql.exec(
      `
        INSERT INTO rate_limit_windows (window_epoch_minute, sent_count)
        VALUES (?, 1)
        ON CONFLICT(window_epoch_minute) DO UPDATE SET
          sent_count = rate_limit_windows.sent_count + 1
      `,
      windowEpochMinute,
    );

    return {
      allowed: true,
      remaining: Math.max(0, maxPerMinute - used - 1),
    };
  }

  async runRetention(
    retentionDays: number,
    maxMessages: number,
  ): Promise<void> {
    const cutoffMs = nowMs() - retentionDays * 24 * 60 * 60 * 1000;
    this.sql.exec("DELETE FROM inbox WHERE created_at_ms < ?", cutoffMs);
    this.sql.exec("DELETE FROM sent WHERE created_at_ms < ?", cutoffMs);

    const inboxCount = this.first<{ total: number }>(
      "SELECT COUNT(*) AS total FROM inbox",
    )?.total ?? 0;
    const excessMessages = Math.max(0, inboxCount - maxMessages);
    if (excessMessages > 0) {
      this.sql.exec(
        `
          DELETE FROM inbox
          WHERE seq IN (
            SELECT seq
            FROM inbox
            ORDER BY seq ASC
            LIMIT ?
          )
        `,
        excessMessages,
      );
    }

    const oldestAllowedWindow = minuteEpochFromMs(nowMs()) - 10;
    this.sql.exec(
      "DELETE FROM rate_limit_windows WHERE window_epoch_minute < ?",
      oldestAllowedWindow,
    );

    await this.scheduleNextAlarm();
  }

  async alarm(): Promise<void> {
    await this.runRetention(this.retentionDays, this.retentionMaxMessages);
  }

  private initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        software TEXT,
        discoverable INTEGER NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE NOT NULL,
        from_agent_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        reply_to_message_id TEXT
      );

      CREATE TABLE IF NOT EXISTS sent (
        message_id TEXT PRIMARY KEY,
        request_id TEXT UNIQUE NOT NULL,
        to_agent_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        got_reply INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS peers (
        peer_agent_id TEXT PRIMARY KEY,
        last_sent_ms INTEGER,
        last_received_ms INTEGER,
        sent_count INTEGER NOT NULL DEFAULT 0,
        received_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        window_epoch_minute INTEGER PRIMARY KEY,
        sent_count INTEGER NOT NULL
      );
    `);
  }

  private ensureCounter(key: string): void {
    this.sql.exec(
      "INSERT INTO counters (key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING",
      key,
    );
  }

  private getCounter(key: string): number {
    return this.first<{ value: number }>(
      "SELECT value FROM counters WHERE key = ? LIMIT 1",
      key,
    )?.value ?? 0;
  }

  private incrementCounter(key: string, delta: number): void {
    this.ensureCounter(key);
    this.sql.exec(
      "UPDATE counters SET value = value + ? WHERE key = ?",
      delta,
      key,
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(nowMs() + 60 * 60 * 1000);
  }

  private first<T>(query: string, ...bindings: Array<string | number | null>): T | null {
    const rows = this.all<T>(query, ...bindings);
    return rows[0] ?? null;
  }

  private all<T>(query: string, ...bindings: Array<string | number | null>): T[] {
    return Array.from(this.sql.exec(query, ...bindings)) as T[];
  }
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
