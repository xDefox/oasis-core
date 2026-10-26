/**
 * Детерминированная процедурная генерация.
 *
 * Мир = данные. Генератор — инструмент, результат — закоммиченный world.json.
 * Один и тот же seed всегда даёт один и тот же мир: это позволяет
 * пересоздавать зоны, генерировать их на разных машинах и проверять,
 * что все видят одно и то же.
 */

import { blocksBody, propCollider } from '@oasis/protocol';

import { repairGaps } from './repairGaps.ts';
import type { Clearing } from './worldCheck.ts';
import { clearingHit } from './worldCheck.ts';

/** Быстрый 32-битный PRNG (mulberry32). Период 2^32, достаточно для мира. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Стабильный хэш строки → seed. */
export function hashString(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export interface GeneratedProp {
  id: string;
  type: 'box' | 'cylinder' | 'sphere' | 'cone' | 'pillar';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rot: number;
  color: number;
}

export interface GenZoneOptions {
  zoneId: string;
  seed: number;
  /** Границы зоны: центр x/z и размер w/d. */
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Количество объектов. */
  count: number;
  /** Радиус центральной площадки, где объекты не ставятся (точка спавна). */
  clearRadius: number;
  /**
   * Запретные круги: диск портала, точка прибытия, кольцо спавна.
   * Их считает `zoneClearings` — та же функция, что у автопроверки мира.
   */
  clearings: Clearing[];
  kind: 'plaza' | 'grove' | 'arena' | 'hub' | 'test';
}

const PALETTE: Record<string, number[]> = {
  plaza: [0x8a93a6, 0x6f7a8c, 0xa9b2c2, 0x55607a],
  grove: [0x3f7a46, 0x2f5c36, 0x6b9c4a, 0x8a6b3f],
  arena: [0x7a4b4b, 0x5c3a3a, 0x9c6b5c, 0x3f3a44],
  hub: [0x5c7a9c, 0x44607a, 0x7a9cc4, 0x9c8a7a],
  test: [0x888888, 0x999999, 0x777777, 0xaaaaaa],
};

/**
 * Генерация содержимого зоны. Схема простая, но осмысленная:
 *  - plaza/hub: колонны по периметру + центральный монумент;
 *  - grove: «деревья» (ствол + крона);
 *  - arena/test: разбросанные блоки и сферы.
 */
export function generateZoneProps(options: GenZoneOptions): GeneratedProp[] {
  const random = mulberry32((options.seed ^ hashString(options.zoneId)) >>> 0);
  const palette = PALETTE[options.kind] ?? PALETTE.test!;
  /**
   * Объекты зоны. Один элемент — то, что игрок обходит как одно целое:
   * дерево (ствол + крона) или одиночный проп. Ставятся и двигаются они
   * целиком, иначе крона уезжает от ствола.
   */
  const units: GeneratedProp[][] = [];
  const halfW = options.w / 2;
  const halfD = options.d / 2;

  /** Проп заходит в запретный круг — диск портала, точку прибытия, кольцо спавна. */
  const inClearing = (prop: GeneratedProp): boolean => {
    const collider = propCollider(prop);
    if (!blocksBody(collider)) return false;
    return options.clearings.some((clearing) => clearingHit(clearing, collider));
  };

  /** Проп стоит на свободном месте: вне центральной площадки и вне запретных кругов. */
  const fits = (prop: GeneratedProp): boolean => {
    const dx = prop.x - options.cx;
    const dz = prop.z - options.cz;
    return Math.hypot(dx, dz) >= options.clearRadius && !inClearing(prop);
  };

  const push = (...props: GeneratedProp[]): void => {
    if (props.length > 0 && props.every(fits)) units.push(props);
  };

  // Монумент стоит в центре площадки — ему clearRadius не помеха, а в
  // запретные круги он всё равно не попадает.
  const pushMonument = (prop: GeneratedProp): void => {
    if (!inClearing(prop)) units.push([prop]);
  };

  if (options.kind === 'plaza' || options.kind === 'hub') {
    // Колонны по периметру.
    const columns = Math.max(6, Math.round(options.count / 6));
    for (let i = 0; i < columns; i += 1) {
      const angle = (i / columns) * Math.PI * 2 + random() * 0.05;
      const radiusX = halfW * 0.82;
      const radiusZ = halfD * 0.82;
      const height = 2.5 + random() * 3.5;
      push({
        id: `${options.zoneId}:col${i}`,
        type: 'pillar',
        x: options.cx + Math.cos(angle) * radiusX,
        y: height / 2,
        z: options.cz + Math.sin(angle) * radiusZ,
        sx: 0.45,
        sy: height / 2,
        sz: 0.45,
        rot: angle,
        color: palette[Math.floor(random() * palette.length)]!,
      });
    }
    // Монумент в центре (для него clearRadius не действует).
    pushMonument({
      id: `${options.zoneId}:monument`,
      type: 'box',
      x: options.cx,
      y: 1.4,
      z: options.cz,
      sx: 1.6,
      sy: 1.4,
      sz: 1.6,
      rot: 0,
      color: palette[0]!,
    });
    // Скамьи по кругу.
    for (let i = 0; i < Math.round(options.count / 3); i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = options.clearRadius + 2 + random() * (halfW * 0.6);
      push({
        id: `${options.zoneId}:bench${i}`,
        type: 'box',
        x: options.cx + Math.cos(angle) * radius,
        y: 0.25,
        z: options.cz + Math.sin(angle) * radius,
        sx: 1.1,
        sy: 0.25,
        sz: 0.45,
        rot: angle,
        color: palette[3]!,
      });
    }
  } else if (options.kind === 'grove') {
    for (let i = 0; i < options.count; i += 1) {
      const x = options.cx + (random() * 2 - 1) * halfW * 0.92;
      const z = options.cz + (random() * 2 - 1) * halfD * 0.92;
      const trunkHeight = 1.4 + random() * 1.4;
      // Ствол и крона — одно дерево: встают и уходят вместе. Раньше крона
      // шла мимо `push` и в центре зоны оставалась висячая крона (crown49).
      push(
        {
          id: `${options.zoneId}:trunk${i}`,
          type: 'cylinder',
          x,
          y: trunkHeight / 2,
          z,
          sx: 0.22,
          sy: trunkHeight / 2,
          sz: 0.22,
          rot: 0,
          color: 0x6b4a2f,
        },
        {
          id: `${options.zoneId}:crown${i}`,
          type: 'cone',
          x,
          y: trunkHeight + 0.9,
          z,
          sx: 1.1 + random() * 0.5,
          sy: 1.3,
          sz: 1.1 + random() * 0.5,
          rot: random() * Math.PI,
          color: palette[Math.floor(random() * palette.length)]!,
        },
      );
    }
  } else {
    for (let i = 0; i < options.count; i += 1) {
      const x = options.cx + (random() * 2 - 1) * halfW * 0.9;
      const z = options.cz + (random() * 2 - 1) * halfD * 0.9;
      const size = 0.4 + random() * 1.2;
      const type = random() < 0.3 ? 'sphere' : 'box';
      push({
        id: `${options.zoneId}:prop${i}`,
        type,
        x,
        // Коробка лежит наполовину в грунте (y0 = -size/2), сфера стоит на
        // земле (y0 = 0): так мир выглядит в клиенте и так он закоммичен.
        y: type === 'sphere' ? size : size / 2,
        z,
        sx: size,
        sy: size,
        sz: size,
        rot: random() * Math.PI,
        color: palette[Math.floor(random() * palette.length)]!,
      });
    }
  }

  // Правила коллизий: щели, в которые игрок влезает и застревает, раздвигаем
  // до проходимого зазора. Границы зоны и запретные круги не трогаем.
  repairGaps(units, {
    bounds: { x: options.cx, z: options.cz, w: options.w, d: options.d },
    clearings: options.clearings,
  });

  return units.flat();
}
