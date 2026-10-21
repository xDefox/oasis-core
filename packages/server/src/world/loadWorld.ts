/**
 * Загрузка и валидация мира.
 *
 * Мир — данные. Сервер читает world.json, валидирует по схеме
 * (@oasis/protocol) и отдаёт клиенту дескрипторы зон по запросу.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { WorldDef, ZoneDef } from '@oasis/protocol';
import { worldSchema } from '@oasis/protocol/validation';

import { logError } from '../config.ts';

export async function loadWorld(path: string): Promise<WorldDef> {
  const absolute = resolve(process.cwd(), path);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (error) {
    logError(`не удалось прочитать мир ${absolute}`, { error: String(error) });
    throw new Error(`world file not found: ${absolute}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    logError(`мир ${absolute} — некорректный JSON`, { error: String(error) });
    throw new Error(`invalid world JSON: ${absolute}`);
  }

  const result = worldSchema.safeParse(parsedJson);
  if (!result.success) {
    logError(`мир ${absolute} не прошёл валидацию`, { issues: result.error.issues });
    throw new Error(`world validation failed: ${absolute}`);
  }

  const world = result.data as WorldDef;

  // Ссылочная целостность: секторы и порталы должны существовать.
  const sectorIds = new Set(world.sectors.map((sector) => sector.id));
  const zoneIds = new Set(world.zones.map((zone) => zone.id));
  for (const zone of world.zones) {
    if (!sectorIds.has(zone.sectorId)) {
      throw new Error(`зона ${zone.id} ссылается на несуществующий сектор ${zone.sectorId}`);
    }
  }
  for (const portal of world.portals) {
    if (!zoneIds.has(portal.fromZone) || !zoneIds.has(portal.toZone)) {
      throw new Error(`портал ${portal.id} ссылается на несуществующую зону`);
    }
  }

  return world;
}

export function findZone(world: WorldDef, zoneId: string): ZoneDef | undefined {
  return world.zones.find((zone) => zone.id === zoneId);
}

/** Зона, в которой находится точка (или ближайшая по центру). */
export function zoneAt(world: WorldDef, x: number, z: number): ZoneDef | undefined {
  let nearest: ZoneDef | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const zone of world.zones) {
    const { x: zx, z: zz, w, d } = zone.bounds;
    const inside = x >= zx - w / 2 && x <= zx + w / 2 && z >= zz - d / 2 && z <= zz + d / 2;
    if (inside) return zone;
    const dx = Math.max(Math.abs(x - zx) - w / 2, 0);
    const dz = Math.max(Math.abs(z - zz) - d / 2, 0);
    const distance = Math.hypot(dx, dz);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = zone;
    }
  }
  return nearest;
}
