/**
 * Конфигурация сервера. Всё через env, ничего не зашито.
 */

import 'dotenv/config';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень монорепо. Пути не зависят от того, из какой папки запущен сервер. */
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type StorageKind = 'memory' | 'postgres';

export const config = {
  port: num('PORT', 2567),
  host: str('HOST', '0.0.0.0'),

  /** Путь к world.json (по умолчанию — мир из репозитория). */
  worldPath: str('WORLD_PATH', resolve(REPO_ROOT, 'content/default/world.json')),
  /** Идентификатор мира (совпадает с world.id). */
  worldId: str('WORLD_ID', 'default'),

  /** Где живёт ledger: memory — для локальной разработки, postgres — для боя. */
  storage: str('STORAGE', 'memory') as StorageKind,
  databaseUrl: str('DATABASE_URL', ''),
  redisUrl: str('REDIS_URL', ''),

  /** Максимум игроков в одном секторе (комнате). */
  maxPlayersPerSector: num('MAX_PLAYERS_PER_SECTOR', 64),

  logLevel: str('LOG_LEVEL', 'info'),
} as const;

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  console.log(`[oasis] ${message}`, meta ?? '');
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  console.warn(`[oasis][warn] ${message}`, meta ?? '');
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  console.error(`[oasis][error] ${message}`, meta ?? '');
}
