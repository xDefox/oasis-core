/**
 * Ledger на PostgreSQL. Боевая реализация: журнал в таблице ledger_entries.
 *
 * Баланс считается суммой проводок. Индекс по (account_id) держит запросы
 * баланса быстрыми; при росте — материализуем баланс в отдельную таблицу
 * (см. docs/05-economy-and-antifraud.md, раздел «ledger как append-only»).
 */

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import type { LedgerEntry, LedgerKind } from '@oasis/protocol';

import { logError, logInfo } from '../config.ts';
import type { AppendInput, Ledger } from './ledger.ts';

export class PostgresLedger implements Ledger {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async append(entry: AppendInput): Promise<LedgerEntry> {
    const full: LedgerEntry = { ...entry, id: randomUUID(), ts: Date.now() };
    await this.pool.query(
      `insert into ledger_entries
         (id, ts, world_id, account_id, kind, amount, reason, counterparty_id, meta)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        full.id,
        full.ts,
        full.worldId,
        full.accountId,
        full.kind,
        full.amount,
        full.reason,
        full.counterpartyId ?? null,
        JSON.stringify(full.meta ?? {}),
      ],
    );
    return full;
  }

  async balanceOf(accountId: string): Promise<number> {
    const result = await this.pool.query<{ balance: string }>(
      `select coalesce(sum(amount), 0) as balance from ledger_entries where account_id = $1`,
      [accountId],
    );
    return Number(result.rows[0]?.balance ?? 0);
  }

  async totalSupply(worldId: string): Promise<number> {
    const result = await this.pool.query<{ supply: string }>(
      `select coalesce(sum(amount), 0) as supply from ledger_entries where world_id = $1`,
      [worldId],
    );
    return Number(result.rows[0]?.supply ?? 0);
  }

  async hasEntry(worldId: string, accountId: string, kind: LedgerKind): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from ledger_entries
        where world_id = $1 and account_id = $2 and kind = $3
        limit 1`,
      [worldId, accountId, kind],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    logInfo('применяю миграции ledger');
    try {
      await this.pool.query(`
        create table if not exists ledger_entries (
          id              uuid primary key,
          ts              bigint not null,
          world_id        text not null,
          account_id      text not null,
          kind            text not null,
          amount          numeric(18,4) not null,
          reason          text not null,
          counterparty_id text null,
          meta            jsonb not null default '{}'::jsonb
        );
        create index if not exists ledger_entries_account_idx on ledger_entries (account_id);
        create index if not exists ledger_entries_world_idx on ledger_entries (world_id);
        create index if not exists ledger_entries_genesis_idx
          on ledger_entries (world_id, account_id, kind);
      `);
    } catch (error) {
      logError('миграция ledger провалилась', { error: String(error) });
      throw error;
    }
  }
}
