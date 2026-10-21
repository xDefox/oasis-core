/**
 * Детерминированная процедурная генерация.
 *
 * Мир = данные. Генератор — инструмент, результат — закоммиченный world.json.
 * Один и тот же seed всегда даёт один и тот же мир: это позволяет
 * пересоздавать зоны, генерировать их на разных машинах и проверять,
 * что все видят одно и то же.
 */

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
  const props: GeneratedProp[] = [];
  const halfW = options.w / 2;
  const halfD = options.d / 2;

  const push = (prop: GeneratedProp): void => {
    const dx = prop.x - options.cx;
    const dz = prop.z - options.cz;
    if (Math.hypot(dx, dz) < options.clearRadius) return;
    props.push(prop);
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
    // Монумент в центре (не должен попадать в clearRadius — выносим наружу руками).
    props.push({
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
      push({
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
      });
      props.push({
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
      });
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
        y: type === 'sphere' ? size : size,
        z,
        sx: size,
        sy: size,
        sz: size,
        rot: random() * Math.PI,
        color: palette[Math.floor(random() * palette.length)]!,
      });
    }
  }

  return props;
}
