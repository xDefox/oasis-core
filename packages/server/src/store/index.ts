/**
 * Фабрика хранилища.
 *
 * Режим разработки (STORAGE=memory) не требует ни Postgres, ни Redis:
 * `npm run dev` поднимает мир с нуля за пару секунд. Это осознанное решение —
 * онбординг второго разработчика не должен требовать docker.
 */

import { config, logInfo, logWarn } from '../config.ts';
import type { Ledger } from './ledger.ts';
import { MemoryLedger } from './ledger.ts';
import { PostgresLedger } from './postgres.ts';

export interface Store {
  ledger: Ledger;
  kind: 'memory' | 'postgres';
}

export async function createStore(): Promise<Store> {
  if (config.storage === 'postgres') {
    if (!config.databaseUrl) {
      logWarn('STORAGE=postgres, но DATABASE_URL пуст — откатываюсь на память');
      return { ledger: new MemoryLedger(), kind: 'memory' };
    }
    const ledger = new PostgresLedger(config.databaseUrl);
    await ledger.migrate();
    logInfo('ledger: postgres');
    return { ledger, kind: 'postgres' };
  }

  logInfo('ledger: memory (режим разработки)');
  return { ledger: new MemoryLedger(), kind: 'memory' };
}

export type { Ledger };
