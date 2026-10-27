/**
 * Раздвигает ловушки мира до проходимого зазора (F1-16).
 *
 * Генератор ставит пропы вслепую: два куста в 0.6 м друг от друга — это
 * «выглядит как проход», но капсула в 0.8 м в него не входит, и игрок
 * упирается в пустоту. Этот проход правит расстановку уже после того, как
 * вся зона собрана: пары с щелью от 0.05 до 1 м раздвигаются до метра,
 * не выходя за границы зоны и не заходя в запретные круги (портал, точка
 * прибытия, кольцо спавна).
 *
 * Двигаются объекты целиком: ствол и крона — одно дерево, разъезжать им
 * нельзя, иначе крона висит в стороне от ствола.
 *
 * Правила — те же, что у `checkWorld`: константы импортируются оттуда,
 * чтобы генератор и проверка не могли разойтись.
 */

import { blocksBody, propCollider } from '@oasis/protocol';
import type { PropCollider, PropDef, ZoneDef } from '@oasis/protocol';

import type { Clearing } from './worldCheck.ts';
import { CONTACT_EPS, GAP_MIN, clearingHit, footprintGap } from './worldCheck.ts';

/** Сколько проходов по всем парам. На практике хватает десятка. */
const MAX_PASSES = 40;
/** Целевой зазор с запасом: не остаться на границе после соседних движений. */
const TARGET_GAP = GAP_MIN + 0.02;

interface Unit {
  props: PropDef[];
  x: number;
  z: number;
}

export interface RepairTarget {
  bounds: ZoneDef['bounds'];
  clearings: Clearing[];
}

interface Trap {
  a: Unit;
  b: Unit;
  gap: number;
}

function centerOf(props: PropDef[]): { x: number; z: number } {
  return {
    x: props.reduce((sum, prop) => sum + prop.x, 0) / props.length,
    z: props.reduce((sum, prop) => sum + prop.z, 0) / props.length,
  };
}

/** Пары объектов, между которыми щель выглядит как проход, но проходом не является. */
function findTraps(units: Unit[]): Trap[] {
  const traps: Trap[] = [];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i]!;
      const b = units[j]!;
      // Считаем не минимум по всем парам, а минимум среди открытых щелей.
      // Иначе слипшиеся кроны (зазор отрицательный) перетягивают на себя
      // минимум, и пара «ствол↔ствол 0.94 м» выглядит починенной — хотя
      // в неё игрок и упирается. Слипшиеся пары чекеру не мешают, ими
      // заниматься не нужно.
      let openGap = Infinity;
      for (const propA of a.props) {
        const colliderA = propCollider(propA);
        if (!blocksBody(colliderA)) continue;
        for (const propB of b.props) {
          const colliderB = propCollider(propB);
          if (!blocksBody(colliderB)) continue;
          const gap = footprintGap(colliderA, colliderB);
          if (gap > CONTACT_EPS) openGap = Math.min(openGap, gap);
        }
      }
      if (openGap < GAP_MIN) traps.push({ a, b, gap: openGap });
    }
  }
  return traps.sort((left, right) => right.gap - left.gap);
}

/** Можно ли сдвинуть объект: не выйти за границы зоны и не зайти в запретный круг. */
function canMove(unit: Unit, dx: number, dz: number, target: RepairTarget): boolean {
  const { bounds } = target;
  const minX = bounds.x - bounds.w / 2;
  const maxX = bounds.x + bounds.w / 2;
  const minZ = bounds.z - bounds.d / 2;
  const maxZ = bounds.z + bounds.d / 2;

  for (const prop of unit.props) {
    const collider = propCollider(prop);
    if (collider.minX + dx < minX || collider.maxX + dx > maxX) return false;
    if (collider.minZ + dz < minZ || collider.maxZ + dz > maxZ) return false;
    if (!blocksBody(collider)) continue;
    const moved: PropCollider = { ...collider, x: collider.x + dx, z: collider.z + dz };
    for (const clearing of target.clearings) {
      if (clearingHit(clearing, moved)) return false;
    }
  }
  return true;
}

function move(unit: Unit, dx: number, dz: number): void {
  for (const prop of unit.props) {
    prop.x += dx;
    prop.z += dz;
  }
  unit.x += dx;
  unit.z += dz;
}

/**
 * Раздвигает ловушки на месте. Ничего не добавляет и не удаляет — только
 * сдвигает координаты, поэтому порядок и состав пропов не меняются.
 *
 * Если пара не двигается ни в одну сторону (упёрлась в границу или в
 * запретный круг), она остаётся — о ней честно скажет `checkWorld`.
 */
export function repairGaps(units: PropDef[][], target: RepairTarget): void {
  const state: Unit[] = units.map((props) => ({ props, ...centerOf(props) }));

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const traps = findTraps(state);
    if (traps.length === 0) return;

    let progress = 0;
    for (const trap of traps) {
      const need = TARGET_GAP - trap.gap;
      let dirX = trap.b.x - trap.a.x;
      let dirZ = trap.b.z - trap.a.z;
      const length = Math.hypot(dirX, dirZ) || 1;
      dirX /= length;
      dirZ /= length;

      const half = need / 2;
      const aOk = canMove(trap.a, -dirX * half, -dirZ * half, target);
      const bOk = canMove(trap.b, dirX * half, dirZ * half, target);
      if (aOk && bOk) {
        move(trap.a, -dirX * half, -dirZ * half);
        move(trap.b, dirX * half, dirZ * half);
        progress += 1;
      } else if (bOk) {
        move(trap.b, dirX * need, dirZ * need);
        progress += 1;
      } else if (aOk) {
        move(trap.a, -dirX * need, -dirZ * need);
        progress += 1;
      }
    }

    if (progress === 0) return;
  }
}
