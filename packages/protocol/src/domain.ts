/**
 * Доменные перечисления и простые структуры.
 *
 * Отдельный файл, потому что эти типы используются и клиентом, и сервером,
 * и валидаторами (zod-схемы строятся из тех же констант).
 */

import { PROTOCOL_VERSION } from './constants.ts';

/** Правила сектора — прямо из канона OASIS (27 секторов с разными флагами). */
export interface SectorFlags {
  /** PvP разрешён в секторе. */
  pvp: boolean;
  /** Магическая система включена. */
  magic: boolean;
  /** Технологии включены. */
  tech: boolean;
  /** Телепортация разрешена. */
  teleport: boolean;
  /** Коммуникация (чат/голос) разрешена. */
  comms: boolean;
}

export const DEFAULT_SECTOR_FLAGS: SectorFlags = {
  pvp: false,
  magic: false,
  tech: true,
  teleport: true,
  comms: true,
};

/** Единица измерения мира: 1.0 = 1 метр. */
export const WORLD_UNIT_METERS = 1.0;

/** Границы мира по умолчанию (если не заданы зоной). */
export const DEFAULT_WORLD_BOUNDS = {
  minX: -200,
  maxX: 200,
  minZ: -200,
  maxZ: 200,
} as const;

/**
 * Совместимость версий протокола.
 *
 * Строгое равенство: расхождение версий означает разный layout бинарных
 * пакетов, а значит — мусор вместо данных. Лучше отказать в подключении,
 * чем показать игроку чужую комнату.
 */
export function isProtocolCompatible(clientVersion: string): boolean {
  return clientVersion === PROTOCOL_VERSION;
}
