import { DurableObject } from "cloudflare:workers";
import { hashStringToUint32 } from "./lib/hashing";
import { minuteEpochFromMs, nowMs, msFromMinuteEpoch } from "./lib/time";
import type { Env } from "./lib/types";

interface PublicAgentRecord {
  agentId: string;
  name: string;
  software: string | null;
  discoverable: boolean;
  createdAtMs: number;
}

interface PublicStatsSnapshot {
  total_agents: number;
  accepted_oys_total: number;
  accepted_oys_last_1m: number;
  accepted_oys_last_5m: number;
  accepted_oys_last_60m: number;
  per_minute_last_60m: Array<[number, number]>;
}

export class MetaShardDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.ensureStateKey("total_agents");
      this.ensureStateKey("accepted_oys_total");
      await this.scheduleNextAlarm();
    });
  }

  async upsertPublicAgent(record: PublicAgentRecord): Promise<void> {
    const existing = this.first<{ agent_id: string }>(
      "SELECT agent_id FROM public_agents WHERE agent_id = ? LIMIT 1",
      record.agentId,
    );

    if (!existing) {
      this.incrementState("total_agents", 1);
      this.bumpMinuteBucket("registrations", minuteEpochFromMs(record.createdAtMs), 1);
    }

    this.sql.exec(
      `
        INSERT INTO public_agents (agent_id, name, software, discoverable, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          name = excluded.name,
          software = excluded.software,
          discoverable = excluded.discoverable
      `,
      record.agentId,
      record.name,
      record.software,
      record.discoverable ? 1 : 0,
      record.createdAtMs,
    );

    const slot = hashStringToUint32(record.agentId) % 256;
    if (record.discoverable) {
      this.sql.exec(
        `
          INSERT INTO discovery_sample (slot, agent_id, name, software)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(slot) DO UPDATE SET
            agent_id = excluded.agent_id,
            name = excluded.name,
            software = excluded.software
        `,
        slot,
        record.agentId,
        record.name,
        record.software,
      );
    } else {
      this.sql.exec(
        "DELETE FROM discovery_sample WHERE slot = ? AND agent_id = ?",
        slot,
        record.agentId,
      );
    }

    await this.scheduleNextAlarm();
  }

  async sampleAgents(
    limit: number,
    excludeAgentIds: string[],
  ): Promise<Array<{ agent_id: string; name: string; software: string | null }>> {
    const excluded = new Set(excludeAgentIds);
    const sampleRows = this.all<{ agent_id: string; name: string; software: string | null }>(
      "SELECT agent_id, name, software FROM discovery_sample ORDER BY slot ASC",
    );

    const selected: Array<{ agent_id: string; name: string; software: string | null }> = [];
    for (const row of sampleRows) {
      if (excluded.has(row.agent_id)) {
        continue;
      }
      selected.push(row);
      excluded.add(row.agent_id);
      if (selected.length >= limit) {
        return selected;
      }
    }

    const publicRows = this.all<{
      agent_id: string;
      name: string;
      software: string | null;
      discoverable: number;
    }>(
      `
        SELECT agent_id, name, software, discoverable
        FROM public_agents
        WHERE discoverable = 1
        ORDER BY created_at_ms DESC
        LIMIT 200
      `,
    );

    for (const row of publicRows) {
      if (excluded.has(row.agent_id)) {
        continue;
      }
      selected.push({
        agent_id: row.agent_id,
        name: row.name,
        software: row.software,
      });
      excluded.add(row.agent_id);
      if (selected.length >= limit) {
        break;
      }
    }

    return selected;
  }

  async incrementAcceptedOys(minuteEpoch: number, delta: number): Promise<void> {
    this.bumpMinuteBucket("accepted_oys", minuteEpoch, delta);
    this.incrementState("accepted_oys_total", delta);
    await this.scheduleNextAlarm();
  }

  async getPublicStats(nowMinuteEpoch: number): Promise<PublicStatsSnapshot> {
    const rows = this.all<{ minute_epoch: number; accepted_oys: number }>(
      `
        SELECT minute_epoch, accepted_oys
        FROM minute_buckets
        WHERE minute_epoch BETWEEN ? AND ?
        ORDER BY minute_epoch ASC
      `,
      nowMinuteEpoch - 59,
      nowMinuteEpoch,
    );

    const minuteMap = new Map<number, number>();
    for (const row of rows) {
      minuteMap.set(row.minute_epoch, row.accepted_oys);
    }

    const perMinuteLast60m: Array<[number, number]> = [];
    for (let minute = nowMinuteEpoch - 59; minute <= nowMinuteEpoch; minute += 1) {
      perMinuteLast60m.push([msFromMinuteEpoch(minute), minuteMap.get(minute) ?? 0]);
    }

    return {
      total_agents: this.getState("total_agents"),
      accepted_oys_total: this.getState("accepted_oys_total"),
      accepted_oys_last_1m: minuteMap.get(nowMinuteEpoch) ?? 0,
      accepted_oys_last_5m: sumAccepted(minuteMap, nowMinuteEpoch - 4, nowMinuteEpoch),
      accepted_oys_last_60m: sumAccepted(minuteMap, nowMinuteEpoch - 59, nowMinuteEpoch),
      per_minute_last_60m: perMinuteLast60m,
    };
  }

  async alarm(): Promise<void> {
    const oldestMinute = minuteEpochFromMs(nowMs()) - (24 * 60);
    this.sql.exec("DELETE FROM minute_buckets WHERE minute_epoch < ?", oldestMinute);
    await this.scheduleNextAlarm();
  }

  private initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS public_agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        software TEXT,
        discoverable INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discovery_sample (
        slot INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        software TEXT
      );

      CREATE TABLE IF NOT EXISTS minute_buckets (
        minute_epoch INTEGER PRIMARY KEY,
        registrations INTEGER NOT NULL DEFAULT 0,
        accepted_oys INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  private ensureStateKey(key: string): void {
    this.sql.exec(
      "INSERT INTO state (key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING",
      key,
    );
  }

  private incrementState(key: string, delta: number): void {
    this.ensureStateKey(key);
    this.sql.exec("UPDATE state SET value = value + ? WHERE key = ?", delta, key);
  }

  private getState(key: string): number {
    return this.first<{ value: number }>(
      "SELECT value FROM state WHERE key = ? LIMIT 1",
      key,
    )?.value ?? 0;
  }

  private bumpMinuteBucket(
    column: "registrations" | "accepted_oys",
    minuteEpoch: number,
    delta: number,
  ): void {
    this.sql.exec(
      `
        INSERT INTO minute_buckets (minute_epoch, registrations, accepted_oys)
        VALUES (?, 0, 0)
        ON CONFLICT(minute_epoch) DO NOTHING
      `,
      minuteEpoch,
    );
    this.sql.exec(
      `UPDATE minute_buckets SET ${column} = ${column} + ? WHERE minute_epoch = ?`,
      delta,
      minuteEpoch,
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

function sumAccepted(
  minuteMap: Map<number, number>,
  startMinute: number,
  endMinute: number,
): number {
  let total = 0;
  for (let minute = startMinute; minute <= endMinute; minute += 1) {
    total += minuteMap.get(minute) ?? 0;
  }
  return total;
}
