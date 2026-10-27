/**
 * Коллизии игрока с пропами зоны (F1-1, F1-19).
 *
 * Движение в OASIS v0 — горизонтальное (XZ). Один чистый резолвер обязаны
 * вызывать и сервер, и клиентское предсказание: иначе упор в столб на
 * сервере даёт резиновый бан на клиенте.
 *
 * Модель: круг радиуса PLAYER_RADIUS против OBB/круга пропа в XZ, плюс
 * высота: у каждого коллайдера есть низ и верх. Вертикальный отбор живёт в
 * момент решения, а не при сборке зоны (F1-19), поэтому одни и те же пропы
 * разные для стоящего на земле, прыгающего и вошедшего на ступеньку:
 *
 *   - `blocksBody` — во что нельзя войти: проп выше, чем можно подняться
 *     шагом, и ниже макушки тела. Крона над головой сюда не попадает;
 *   - `supportsBody` — на чём можно стоять: верх пропа не выше шага вверх;
 *   - `supportHeightAt` — высота опоры под ногами. Её отдаёт в
 *     `stepVertical` вызывающий, чтобы подтянуть тело на ступеньку.
 */

import {
  GROUND_Y,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_STEP_UP,
} from './constants.ts';
import type { PropDef, ZoneBounds, ZoneDef } from './types.ts';

/** Размер ячейки сетки, м. */
const CELL_SIZE = 2;

/** Сколько раз выталкиваем, если старт внутри пропа. */
const SEPARATE_ITERS = 4;

export type ColliderShape =
  | { kind: 'obb'; hx: number; hz: number; cos: number; sin: number }
  | { kind: 'circle'; radius: number };

export interface PropCollider {
  x: number;
  z: number;
  shape: ColliderShape;
  /** Ось-выровненный bbox для сетки (с запасом). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Низ и верх пропа по оси Y, м (F1-19). */
  y0: number;
  y1: number;
}

export interface ZoneColliders {
  zoneId: string;
  bounds: ZoneBounds;
  items: PropCollider[];
  /** cellKey → индексы в items. */
  grid: Map<string, number[]>;
  cellSize: number;
  originX: number;
  originZ: number;
}

export interface MoveResult {
  x: number;
  z: number;
  /** Ось X упёрлась в препятствие или край зоны. */
  blockedX: boolean;
  /** Ось Z упёрлась в препятствие или край зоны. */
  blockedZ: boolean;
}

/**
 * Препятствие: проп пересекает тело и выше, чем можно подняться шагом.
 *
 * Низкий бордюр с земли блокирует, в прыжке — проходится; крона над головой
 * не блокирует, пока игрок ниже её низа, и блокирует, если забрался выше.
 */
export function blocksBody(
  collider: PropCollider,
  feetY = GROUND_Y,
  height = PLAYER_HEIGHT,
  stepUp = PLAYER_STEP_UP,
): boolean {
  return collider.y1 > feetY + stepUp && collider.y0 < feetY + height;
}

/**
 * Опора: верх пропа не выше шага вверх — на него можно встать и по нему
 * ходить. Выше — тело не подтягивается, нужен прыжок.
 */
export function supportsBody(
  collider: PropCollider,
  feetY = GROUND_Y,
  stepUp = PLAYER_STEP_UP,
): boolean {
  return collider.y1 <= feetY + stepUp;
}

/**
 * Горизонтальный коллайдер пропа — всегда, без отбраковки по высоте.
 * Отбраковка перенесена в `blocksBody`: если выбросить проп на этапе
 * сборки зоны, он неизвестен игроку с любой высотой ног — и крона в 3 м
 * перестаёт быть препятствием даже для того, кто стоит на ней.
 * Габариты совпадают с визуалом в client/render/world.ts (sx/sz — полуразмеры).
 */
export function propCollider(prop: PropDef): PropCollider {
  const y0 = prop.y - prop.sy;
  const y1 = prop.y + prop.sy;

  if (prop.type === 'box' || prop.type === 'pillar') {
    const cos = Math.cos(prop.rot);
    const sin = Math.sin(prop.rot);
    const hx = Math.max(prop.sx, 0.01);
    const hz = Math.max(prop.sz, 0.01);
    // AABB повёрнутого прямоугольника.
    const extX = Math.abs(cos) * hx + Math.abs(sin) * hz;
    const extZ = Math.abs(sin) * hx + Math.abs(cos) * hz;
    return {
      x: prop.x,
      z: prop.z,
      shape: { kind: 'obb', hx, hz, cos, sin },
      minX: prop.x - extX,
      maxX: prop.x + extX,
      minZ: prop.z - extZ,
      maxZ: prop.z + extZ,
      y0,
      y1,
    };
  }

  const radius = Math.max(prop.sx, 0.01);
  return {
    x: prop.x,
    z: prop.z,
    shape: { kind: 'circle', radius },
    minX: prop.x - radius,
    maxX: prop.x + radius,
    minZ: prop.z - radius,
    maxZ: prop.z + radius,
    y0,
    y1,
  };
}

/** Собирает коллайдеры зоны и раскладывает их по сетке. */
export function buildZoneColliders(zone: ZoneDef): ZoneColliders {
  const items: PropCollider[] = [];
  for (const prop of zone.props) {
    items.push(propCollider(prop));
  }

  const halfW = zone.bounds.w / 2;
  const halfD = zone.bounds.d / 2;
  const originX = zone.bounds.x - halfW;
  const originZ = zone.bounds.z - halfD;
  const grid = new Map<string, number[]>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const minCx = Math.floor((item.minX - originX) / CELL_SIZE);
    const maxCx = Math.floor((item.maxX - originX) / CELL_SIZE);
    const minCz = Math.floor((item.minZ - originZ) / CELL_SIZE);
    const maxCz = Math.floor((item.maxZ - originZ) / CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cz = minCz; cz <= maxCz; cz += 1) {
        const key = `${cx},${cz}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(i);
        else grid.set(key, [i]);
      }
    }
  }

  return {
    zoneId: zone.id,
    bounds: zone.bounds,
    items,
    grid,
    cellSize: CELL_SIZE,
    originX,
    originZ,
  };
}

/** Точка внутри прямоугольника зоны с учётом радиуса игрока. */
export function clampToBounds(
  x: number,
  z: number,
  bounds: ZoneBounds,
  radius = PLAYER_RADIUS,
): { x: number; z: number; blockedX: boolean; blockedZ: boolean } {
  const halfW = bounds.w / 2 - radius;
  const halfD = bounds.d / 2 - radius;
  const minX = bounds.x - halfW;
  const maxX = bounds.x + halfW;
  const minZ = bounds.z - halfD;
  const maxZ = bounds.z + halfD;
  const nextX = Math.min(Math.max(x, minX), maxX);
  const nextZ = Math.min(Math.max(z, minZ), maxZ);
  return {
    x: nextX,
    z: nextZ,
    blockedX: nextX !== x,
    blockedZ: nextZ !== z,
  };
}

/**
 * Как тело стоит в этот момент: радиус, высота ног и макушки.
 * Раньше позиционно передавался только радиус (F1-1); с высотой (F1-19)
 * набор вырос, и объект читается прямо на месте вызова.
 */
export interface MoveContext {
  /** Радиус круга игрока, м. */
  radius?: number;
  /** Высота ног над опорой: от неё зависит, во что упираемся. */
  feetY?: number;
  /** Высота тела: полная или в приседе. */
  height?: number;
  /** На сколько можно подняться одним шагом, м. */
  stepUp?: number;
}

/**
 * Сдвиг позиции с разрешением коллизий.
 * Раздельный sweep по X и Z — можно скользить вдоль стены.
 *
 * Препятствиями считаются только те пропы, что пересекают тело с учётом
 * `context.feetY`: низкий бордюр блокирует с земли, в прыжке проходится,
 * крона над головой не блокирует вовсе.
 */
export function resolvePlayerMove(
  x: number,
  z: number,
  dx: number,
  dz: number,
  colliders: ZoneColliders | null | undefined,
  context: MoveContext = {},
): MoveResult {
  const body: Required<MoveContext> = {
    radius: context.radius ?? PLAYER_RADIUS,
    feetY: context.feetY ?? GROUND_Y,
    height: context.height ?? PLAYER_HEIGHT,
    stepUp: context.stepUp ?? PLAYER_STEP_UP,
  };
  const radius = body.radius;
  let px = x;
  let pz = z;
  let blockedX = false;
  let blockedZ = false;

  // Сначала выталкиваем, если уже внутри (спавн / телепорт / коррекция).
  const separated = separateFromProps(px, pz, colliders, body);
  px = separated.x;
  pz = separated.z;

  if (dx !== 0) {
    const nextX = px + dx;
    if (collidesAt(nextX, pz, colliders, body)) {
      blockedX = true;
    } else {
      px = nextX;
    }
  }

  if (dz !== 0) {
    const nextZ = pz + dz;
    if (collidesAt(px, nextZ, colliders, body)) {
      blockedZ = true;
    } else {
      pz = nextZ;
    }
  }

  if (colliders) {
    const clamped = clampToBounds(px, pz, colliders.bounds, radius);
    if (clamped.blockedX) blockedX = true;
    if (clamped.blockedZ) blockedZ = true;
    px = clamped.x;
    pz = clamped.z;
  }

  return { x: px, z: pz, blockedX, blockedZ };
}

/**
 * Высота опоры под ногами в точке (x, z) — F1-19.
 *
 * Максимум верхов пропов, на которые можно встать не выше шага вверх; если
 * вокруг ничего — пол зоны. Точка проверяется по центру ноги, а не по
 * радиусу: на бордюр можно забраться ровно в его границе, а «висеть» над
 * краем в воздухе — нельзя.
 *
 * Контракт для `stepVertical`: результат никогда не выше `feetY + stepUp`,
 * иначе тело телепортировало бы вверх.
 */
export function supportHeightAt(
  x: number,
  z: number,
  colliders: ZoneColliders | null | undefined,
  feetY = GROUND_Y,
  stepUp = PLAYER_STEP_UP,
): number {
  if (!colliders) return GROUND_Y;

  let best = GROUND_Y;
  for (const collider of queryNearby(x, z, colliders, PLAYER_RADIUS)) {
    if (!supportsBody(collider, feetY, stepUp)) continue;
    if (collider.y1 <= best) continue;
    if (!containsPoint(x, z, collider)) continue;
    best = collider.y1;
  }
  return best;
}

/** Центр ноги внутри горизонтального габарита пропа. */
function containsPoint(x: number, z: number, collider: PropCollider): boolean {
  if (collider.shape.kind === 'circle') {
    return Math.hypot(x - collider.x, z - collider.z) <= collider.shape.radius;
  }

  const { hx, hz, cos, sin } = collider.shape;
  const wx = x - collider.x;
  const wz = z - collider.z;
  const lx = cos * wx + sin * wz;
  const lz = -sin * wx + cos * wz;
  return Math.abs(lx) <= hx && Math.abs(lz) <= hz;
}

function separateFromProps(
  x: number,
  z: number,
  colliders: ZoneColliders | null | undefined,
  body: Required<MoveContext>,
): { x: number; z: number } {
  if (!colliders || colliders.items.length === 0) return { x, z };

  let px = x;
  let pz = z;
  for (let iter = 0; iter < SEPARATE_ITERS; iter += 1) {
    let moved = false;
    for (const collider of queryNearby(px, pz, colliders, body.radius)) {
      // Проп, в который тело уже не упирается (стоим сверху, крона над
      // головой), не выталкивает — иначе игрока выкидывало бы с собственной
      // ступеньки.
      if (!blocksBody(collider, body.feetY, body.height, body.stepUp)) continue;
      const push = penetration(px, pz, collider, body.radius);
      if (!push) continue;
      px += push.x;
      pz += push.z;
      moved = true;
    }
    if (!moved) break;
  }
  return { x: px, z: pz };
}

function collidesAt(
  x: number,
  z: number,
  colliders: ZoneColliders | null | undefined,
  body: Required<MoveContext>,
): boolean {
  if (!colliders) return false;
  for (const collider of queryNearby(x, z, colliders, body.radius)) {
    if (!blocksBody(collider, body.feetY, body.height, body.stepUp)) continue;
    if (overlaps(x, z, collider, body.radius)) return true;
  }
  return false;
}

function* queryNearby(
  x: number,
  z: number,
  colliders: ZoneColliders,
  radius: number,
): Generator<PropCollider> {
  const pad = radius + 0.01;
  const minCx = Math.floor((x - pad - colliders.originX) / colliders.cellSize);
  const maxCx = Math.floor((x + pad - colliders.originX) / colliders.cellSize);
  const minCz = Math.floor((z - pad - colliders.originZ) / colliders.cellSize);
  const maxCz = Math.floor((z + pad - colliders.originZ) / colliders.cellSize);
  const seen = new Set<number>();

  for (let cx = minCx; cx <= maxCx; cx += 1) {
    for (let cz = minCz; cz <= maxCz; cz += 1) {
      const bucket = colliders.grid.get(`${cx},${cz}`);
      if (!bucket) continue;
      for (const index of bucket) {
        if (seen.has(index)) continue;
        seen.add(index);
        const item = colliders.items[index];
        if (item) yield item;
      }
    }
  }
}

function overlaps(x: number, z: number, collider: PropCollider, radius: number): boolean {
  return penetration(x, z, collider, radius) !== null;
}

/**
 * Вектор выталкивания круга из коллайдера, или null если нет пересечения.
 * Длина = глубина проникновения (+epsilon).
 */
function penetration(
  x: number,
  z: number,
  collider: PropCollider,
  radius: number,
): { x: number; z: number } | null {
  if (collider.shape.kind === 'circle') {
    const dx = x - collider.x;
    const dz = z - collider.z;
    const dist = Math.hypot(dx, dz);
    const minDist = radius + collider.shape.radius;
    if (dist >= minDist) return null;
    if (dist < 1e-8) {
      // Центр в центре — толкаем по X.
      return { x: minDist, z: 0 };
    }
    const push = (minDist - dist) / dist;
    return { x: dx * push, z: dz * push };
  }

  // OBB: в локальные координаты пропа.
  const { hx, hz, cos, sin } = collider.shape;
  const wx = x - collider.x;
  const wz = z - collider.z;
  const lx = cos * wx + sin * wz;
  const lz = -sin * wx + cos * wz;

  const closestX = Math.min(Math.max(lx, -hx), hx);
  const closestZ = Math.min(Math.max(lz, -hz), hz);
  const ox = lx - closestX;
  const oz = lz - closestZ;
  const distSq = ox * ox + oz * oz;

  if (distSq >= radius * radius) return null;

  // Центр внутри OBB: выталкиваем по ближайшей грани.
  if (distSq < 1e-12) {
    const toRight = hx - lx;
    const toLeft = hx + lx;
    const toTop = hz - lz;
    const toBottom = hz + lz;
    const minPen = Math.min(toRight, toLeft, toTop, toBottom);
    let localPushX = 0;
    let localPushZ = 0;
    if (minPen === toRight) localPushX = toRight + radius;
    else if (minPen === toLeft) localPushX = -(toLeft + radius);
    else if (minPen === toTop) localPushZ = toTop + radius;
    else localPushZ = -(toBottom + radius);
    return {
      x: cos * localPushX - sin * localPushZ,
      z: sin * localPushX + cos * localPushZ,
    };
  }

  const dist = Math.sqrt(distSq);
  const push = (radius - dist) / dist;
  const localPushX = ox * push;
  const localPushZ = oz * push;
  return {
    x: cos * localPushX - sin * localPushZ,
    z: sin * localPushX + cos * localPushZ,
  };
}
