/**
 * Автопроверка мира под коллизии (F1-16 «мир под коллизии» + F1-20).
 *
 * Мир собирается из seed, но генератор знал только про эстетику: минимум
 * между пропами, подход к порталу, чистоту кольца спавна он не проверял —
 * пропы расставлялись раньше, чем движок научился шагать вверх (F1-19).
 * Результат — 58 пар «щелей-капсул» и четыре портала, забитых пропами.
 *
 * Отсюда же правило работы: правила живут здесь, а не в голове. Генератор
 * обязан им подчиняться (`repairGaps`), а CI гоняет `checkWorld` по
 * закоммиченному world.json — правка руками не пройдёт мимо.
 *
 * Три правила:
 *   1. Зазор. Между пропами, которые блокируют тело, должно быть либо
 *      ≥1 м — проходишь, — либо практически 0: слиплись, щели нет.
 *      Промежуточное — ловушка. Капсула игрока 0.8 м в зазор 0.5–0.7 м
 *      не влезает, а выглядит он как проход: плечи уже, а дверь — нет.
 *   2. Портал. Диск портала и точка прибытия свободны: игрок должен зайти
 *      в портал и выйти из него, не обходя колонну, стоящую в центре.
 *   3. Спавн. Кольцо, из которого сервер выбирает точку появления, чисто.
 *
 * Запуск: node --import tsx scripts/world-check.ts
 */

import { blocksBody, PLAYER_RADIUS, propCollider } from '@oasis/protocol';
import type { PropCollider, PropDef, WorldDef, ZoneDef } from '@oasis/protocol';

import { SPAWN_RING_MAX } from './spawnPoint.ts';

/** Зазор, при котором пропы считаются слипшимися: щели нет. */
export const CONTACT_EPS = 0.05;
/** Зазор, при котором проход считается настоящим. */
export const GAP_MIN = 1;
/** Свободное место вокруг точки прибытия из портала. */
export const ARRIVAL_CLEAR = 1;

export type WorldRule = 'gap' | 'portal' | 'arrival' | 'spawn';

export interface WorldIssue {
  rule: WorldRule;
  /** Зона, портал или сектор — чтобы искать было сразу понятно где. */
  where: string;
  message: string;
}

/** Круг, в который пропам заходить нельзя. */
export interface Clearing {
  id: string;
  rule: WorldRule;
  x: number;
  z: number;
  /** Уже включает отступ игрока: в радиус не должен заходить габарит пропа. */
  radius: number;
  why: string;
}

// ───────────────────────────────────────────────────── геометрия габаритов ───

type Footprint =
  | { kind: 'circle'; x: number; z: number; radius: number }
  | { kind: 'obb'; x: number; z: number; hx: number; hz: number; cos: number; sin: number };

function footprint(collider: PropCollider): Footprint {
  if (collider.shape.kind === 'circle') {
    return { kind: 'circle', x: collider.x, z: collider.z, radius: collider.shape.radius };
  }
  return {
    kind: 'obb',
    x: collider.x,
    z: collider.z,
    hx: collider.shape.hx,
    hz: collider.shape.hz,
    cos: collider.shape.cos,
    sin: collider.shape.sin,
  };
}

/** Расстояние от точки до габарита, 0 — точка внутри. */
function distanceTo(x: number, z: number, shape: Footprint): number {
  if (shape.kind === 'circle') return Math.max(0, Math.hypot(x - shape.x, z - shape.z) - shape.radius);
  const worldX = x - shape.x;
  const worldZ = z - shape.z;
  const localX = shape.cos * worldX + shape.sin * worldZ;
  const localZ = -shape.sin * worldX + shape.cos * worldZ;
  return Math.hypot(Math.max(Math.abs(localX) - shape.hx, 0), Math.max(Math.abs(localZ) - shape.hz, 0));
}

function corners(shape: Extract<Footprint, { kind: 'obb' }>): Array<[number, number]> {
  const { hx, hz, cos, sin } = shape;
  const local: Array<[number, number]> = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  return local.map(([localX, localZ]) => [
    shape.x + cos * localX - sin * localZ,
    shape.z + sin * localX + cos * localZ,
  ]);
}

/** Пересекаются ли два прямоугольника (SAT: 4 оси — истина, а не оценка). */
function intersects(a: Extract<Footprint, { kind: 'obb' }>, b: Extract<Footprint, { kind: 'obb' }>): boolean {
  const axes: Array<[number, number]> = [
    [a.cos, a.sin],
    [-a.sin, a.cos],
    [b.cos, b.sin],
    [-b.sin, b.cos],
  ];
  return axes.every(([axisX, axisZ]) => {
    const project = (shape: Extract<Footprint, { kind: 'obb' }>): number[] =>
      corners(shape).map(([x, z]) => x * axisX + z * axisZ);
    const rangeA = project(a);
    const rangeB = project(b);
    return Math.max(...rangeA) >= Math.min(...rangeB) && Math.max(...rangeB) >= Math.min(...rangeA);
  });
}

/**
 * Зазор между двумя габаритами: >0 — между ними щель, ≤0 — слиплись.
 *
 * Прямоугольники меряются точно: сначала SAT (пересекаются — щели нет),
 * потом минимальное расстояние от вершины одного до тела другого. Для
 * не пересекающихся выпуклых фигур минимум всегда достигается в вершине —
 * сэмплирование тут не нужно и не должно ошибаться.
 */
export function gapOf(a: Footprint, b: Footprint): number {
  if (a.kind === 'circle' && b.kind === 'circle') {
    return Math.hypot(a.x - b.x, a.z - b.z) - a.radius - b.radius;
  }
  if (a.kind === 'circle') return distanceTo(a.x, a.z, b) - a.radius;
  if (b.kind === 'circle') return distanceTo(b.x, b.z, a) - b.radius;
  if (intersects(a, b)) return 0;
  let best = Infinity;
  for (const [x, z] of corners(a)) best = Math.min(best, distanceTo(x, z, b));
  for (const [x, z] of corners(b)) best = Math.min(best, distanceTo(x, z, a));
  return best;
}

/** Зазор между габаритами двух пропов. */
export function footprintGap(a: PropCollider, b: PropCollider): number {
  return gapOf(footprint(a), footprint(b));
}

/** Достаёт ли проп в запретный круг. */
export function clearingHit(clearing: Clearing, collider: PropCollider): boolean {
  const circle: Footprint = { kind: 'circle', x: clearing.x, z: clearing.z, radius: clearing.radius };
  return gapOf(circle, footprint(collider)) <= 0;
}

/**
 * Проп мешает игроку, стоящему на земле: пересекает тело (0…1.7 м) и выше,
 * чем берётся шагом вверх (0.4 м). Низкий бордюр и крона над головой в это
 * не попадают — вокруг них правила зазора не нужны.
 */
function blocksPlayer(prop: PropDef): boolean {
  return blocksBody(propCollider(prop));
}

// ──────────────────────────────────────────────────────── запретные круги ───

/**
 * Круги, в которые нельзя ставить пропы: диск портала, точка прибытия и
 * кольцо спавна. Одна и та же функция у генератора и у проверки — иначе
 * генератор считает одно, а проверка другое, и CI врёт.
 */
export function zoneClearings(world: WorldDef, zone: ZoneDef): Clearing[] {
  const clearings: Clearing[] = [];
  for (const portal of world.portals) {
    if (portal.fromZone !== zone.id) continue;

    clearings.push({
      id: portal.id,
      rule: 'portal',
      x: portal.x,
      z: portal.z,
      radius: portal.radius + PLAYER_RADIUS,
      why: `портал ${portal.id}`,
    });

    // Игрок прибывает не в центр, а за порог: центр обратного портала плюс
    // шаг (radius + 1.5) вглубь своей зоны — иначе на следующем тике он
    // снова внутри радиуса и улетает назад (см. SectorRoom.checkPortal).
    const reverseExists = world.portals.some(
      (candidate) => candidate.fromZone === portal.toZone && candidate.toZone === portal.fromZone,
    );
    const length = Math.hypot(zone.bounds.x - portal.x, zone.bounds.z - portal.z);
    if (!reverseExists || length <= 0.001) continue;
    const step = portal.radius + 1.5;
    clearings.push({
      id: portal.id,
      rule: 'arrival',
      x: portal.x + ((zone.bounds.x - portal.x) / length) * step,
      z: portal.z + ((zone.bounds.z - portal.z) / length) * step,
      radius: ARRIVAL_CLEAR,
      why: `точка прибытия через ${portal.id}`,
    });
  }

  for (const sector of world.sectors) {
    // Сервер при отсутствующем spawn родится в (0,0,0) — кольцо считаем
    // от той же точки, что и SectorRoom.
    const spawn = sector.spawn ?? { x: 0, y: 0, z: 0 };
    clearings.push({
      id: sector.id,
      rule: 'spawn',
      x: spawn.x,
      z: spawn.z,
      radius: SPAWN_RING_MAX + PLAYER_RADIUS,
      why: `кольцо спавна ${sector.id}`,
    });
  }

  return clearings;
}

// ─────────────────────────────────────────────────────────────── проверка ───

function shortId(id: string): string {
  const separator = id.indexOf(':');
  return separator === -1 ? id : id.slice(separator + 1);
}

function head(list: string[], limit = 5): string {
  const shown = list.slice(0, limit).join(', ');
  return list.length > limit ? `${shown} … ещё ${list.length - limit}` : shown;
}

/**
 * Правила мира глазами игрока. Пустой список — мир можно показывать.
 *
 * Нарушения группируются по правилу и объекту (зона/портал/сектор), а не по
 * каждой паре: в отчёте должно быть понятно, что чинить, а не 58 строк
 * одинаковой беды.
 */
export function checkWorld(world: WorldDef): WorldIssue[] {
  const issues: WorldIssue[] = [];

  for (const zone of world.zones) {
    const blockers = zone.props.filter(blocksPlayer);

    // 1. зазоры между блокирующими пропами
    const traps: string[] = [];
    for (let i = 0; i < blockers.length; i += 1) {
      for (let j = i + 1; j < blockers.length; j += 1) {
        const a = blockers[i]!;
        const b = blockers[j]!;
        const colliderA = propCollider(a);
        const colliderB = propCollider(b);
        // Отсев по bbox с запасом в GAP_MIN: дальше щель уже не бывает.
        if (colliderA.maxX < colliderB.minX - GAP_MIN || colliderB.maxX < colliderA.minX - GAP_MIN) continue;
        if (colliderA.maxZ < colliderB.minZ - GAP_MIN || colliderB.maxZ < colliderA.minZ - GAP_MIN) continue;
        const gap = footprintGap(colliderA, colliderB);
        if (gap > CONTACT_EPS && gap < GAP_MIN) traps.push(`${shortId(a.id)}↔${shortId(b.id)} ${gap.toFixed(2)} м`);
      }
    }
    if (traps.length > 0) {
      issues.push({
        rule: 'gap',
        where: zone.id,
        message:
          `${zone.id}: ${traps.length} щелей шире ${CONTACT_EPS} м и уже ${GAP_MIN} м — ` +
          `влезаешь и застреваешь: ${head(traps)}`,
      });
    }

    // 2–3. запретные круги: диск портала, точка прибытия, кольцо спавна
    for (const clearing of zoneClearings(world, zone)) {
      const inside = blockers.filter((prop) => clearingHit(clearing, propCollider(prop)));
      if (inside.length === 0) continue;
      issues.push({
        rule: clearing.rule,
        where: clearing.id,
        message: `${clearing.why} (зона ${zone.id}): перекрыто пропами ${head(inside.map((prop) => shortId(prop.id)), 6)}`,
      });
    }
  }

  return issues;
}

/** Сколько пропов стоит в каждой зоне — для отчёта скрипта. */
export function zoneStats(world: WorldDef): Array<Pick<ZoneDef, 'id'> & { props: number; blockers: number }> {
  return world.zones.map((zone) => ({
    id: zone.id,
    props: zone.props.length,
    blockers: zone.props.filter(blocksPlayer).length,
  }));
}
