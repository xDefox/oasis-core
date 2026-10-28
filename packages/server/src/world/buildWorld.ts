/**
 * Сборка мира из блюпринтов: seed + описание зон → WorldDef.
 *
 * Вынесено из скрипта генерации, чтобы мир можно было проверить прямо в
 * тестах: `checkWorld(buildWorld())` ловит регрессию генератора до того,
 * как кто-то перегенерирует world.json и закоммитит сломанный файл.
 *
 * Запуск на запись: npm run generate:world -w @oasis/server
 */

import type { WorldDef, ZoneDef } from '@oasis/protocol';

import { generateZoneProps } from './procedural.ts';
import { zoneClearings } from './worldCheck.ts';

/** Сид мира: один и тот же сид даёт один и тот же мир. */
export const SEED = 20261021;

/** Спавн сектора вынесен из центра: в центре стоит монумент (см. c5b8ffe). */
const SECTOR_SPAWN = { x: -5, y: 0, z: 10 };

interface ZoneBlueprint {
  id: string;
  sectorId: string;
  name: string;
  kind: ZoneDef['kind'];
  cx: number;
  cz: number;
  w: number;
  d: number;
  count: number;
  /** Узлов добычи: у леса больше, у площади — учебный рядом со спавном. */
  resources: number;
  clearRadius: number;
  groundColor: number;
}

const ZONE_BLUEPRINTS: ZoneBlueprint[] = [
  {
    id: 'z_plaza',
    sectorId: 's_plaza',
    name: 'Плаза',
    kind: 'plaza',
    cx: 0,
    cz: 0,
    w: 64,
    d: 64,
    count: 90,
    resources: 3,
    clearRadius: 7,
    groundColor: 0x6f7a8c,
  },
  {
    id: 'z_grove',
    sectorId: 's_plaza',
    name: 'Роща',
    kind: 'grove',
    cx: 120,
    cz: 0,
    w: 72,
    d: 72,
    count: 110,
    resources: 6,
    clearRadius: 6,
    groundColor: 0x3f6b46,
  },
  {
    id: 'z_arena',
    sectorId: 's_plaza',
    name: 'Арена',
    kind: 'arena',
    cx: -120,
    cz: 0,
    w: 56,
    d: 56,
    count: 70,
    resources: 0,
    clearRadius: 8,
    groundColor: 0x5c4a52,
  },
];

export function buildWorld(): WorldDef {
  // Каркас мира собирается первым: запретные круги считаются от порталов
  // и секторов, а в зонах их ещё нет.
  const shell: WorldDef = {
    id: 'default',
    version: 1,
    seed: SEED,
    generator: 'oasis-v1',
    sectors: [
      {
        id: 's_plaza',
        name: 'Сектор Плаза',
        flags: { pvp: false, magic: false, tech: true, teleport: true, comms: true },
        // Спавн вынесен из центра: в центре стоит монумент (см. c5b8ffe).
        // Генератор обязан воспроизводить закоммиченный world.json байт в байт,
        // иначе правка руками — это долги, которые спишет следующая регенерация.
        spawn: SECTOR_SPAWN,
      },
    ],
    zones: [],
    portals: [
      { id: 'p_grove', fromZone: 'z_plaza', toZone: 'z_grove', x: 26, z: 0, radius: 3 },
      { id: 'p_arena', fromZone: 'z_plaza', toZone: 'z_arena', x: -26, z: 0, radius: 3 },
      { id: 'p_back_grove', fromZone: 'z_grove', toZone: 'z_plaza', x: 92, z: 0, radius: 3 },
      { id: 'p_back_arena', fromZone: 'z_arena', toZone: 'z_plaza', x: -92, z: 0, radius: 3 },
    ],
  };

  const zones: ZoneDef[] = ZONE_BLUEPRINTS.map((blueprint) => {
    const zone: ZoneDef = {
      id: blueprint.id,
      sectorId: blueprint.sectorId,
      name: blueprint.name,
      kind: blueprint.kind,
      bounds: { x: blueprint.cx, z: blueprint.cz, w: blueprint.w, d: blueprint.d },
      groundColor: blueprint.groundColor,
      props: [],
    };
    const props = generateZoneProps({
      zoneId: blueprint.id,
      seed: SEED,
      cx: blueprint.cx,
      cz: blueprint.cz,
      w: blueprint.w,
      d: blueprint.d,
      count: blueprint.count,
      resources: blueprint.resources,
      spawn: SECTOR_SPAWN,
      clearRadius: blueprint.clearRadius,
      clearings: zoneClearings(shell, zone),
      kind: blueprint.kind,
    });
    return { ...zone, props };
  });

  return { ...shell, zones };
}
