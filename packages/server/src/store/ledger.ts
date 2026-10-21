/**
 * Ledger — единственный источник истины по деньгам.
 *
 * Принцип: журнал только пополняется (append-only). Баланс = сумма проводок.
 * Ничего не «обновляется на месте» — так историю можно проверить и откатить.
 */

import { randomUUID } from 'node:crypto';

import type { LedgerEntry, LedgerKind } from '@oasis/protocol';

export interface Ledger {
  append(entry: Omit<LedgerEntry, 'id' | 'ts'>): Promise<LedgerEntry>;
  balanceOf(accountId: string): Promise<number>;
  totalSupply(worldId: string): Promise<number>;
  /**
   * Была ли уже проводка такого kind для аккаунта.
   *
   * Мир здесь намеренно не участвует: баланс и, например, genesis-грант —
   * глобальные для аккаунта. Иначе каждый новый мир печатал бы новый грант.
   */
  hasEntry(accountId: string, kind: LedgerKind): Promise<boolean>;
  close(): Promise<void>;
}

export type AppendInput = Omit<LedgerEntry, 'id' | 'ts'>;

/** Реализация в памяти — режим разработки (STORAGE=memory). */
export class MemoryLedger implements Ledger {
  private readonly entries: LedgerEntry[] = [];
  private readonly balances = new Map<string, number>();

  async append(entry: AppendInput): Promise<LedgerEntry> {
    const full: LedgerEntry = { ...entry, id: randomUUID(), ts: Date.now() };
    this.entries.push(full);
    this.balances.set(
      full.accountId,
      (this.balances.get(full.accountId) ?? 0) + full.amount,
    );
    return full;
  }

  async balanceOf(accountId: string): Promise<number> {
    return this.balances.get(accountId) ?? 0;
  }

  async totalSupply(worldId: string): Promise<number> {
    let sum = 0;
    for (const entry of this.entries) {
      if (entry.worldId === worldId) sum += entry.amount;
    }
    return sum;
  }

  async hasEntry(accountId: string, kind: LedgerKind): Promise<boolean> {
    return this.entries.some(
      (entry) => entry.accountId === accountId && entry.kind === kind,
    );
  }

  async close(): Promise<void> {
    this.entries.length = 0;
    this.balances.clear();
  }
}
