/**
 * Точка, из которой игрок появляется в секторе.
 *
 * Сид берётся из имени, поэтому один и тот же игрок всегда выходит в одном
 * месте, а разные игроки — по кольцу (иначе все стоят друг в друге).
 *
 * Вынесено из SectorRoom: кольцо нужно ещё и автопроверке мира
 * (`worldCheck`) — в него нельзя ставить пропы, иначе кто-то родится
 * внутри дерева.
 */

/** Радиус кольца спавна: игроки не появляются друг в друге. */
export const SPAWN_RADIUS = 1.2;

/**
 * Худший радиус кольца: `seed % 8` доходит до 7 → `sqrt(1 + 7)`.
 * Проверять мир нужно по худшему случаю — имена произвольные.
 */
export const SPAWN_RING_MAX = SPAWN_RADIUS * Math.sqrt(8);

/** Точка спавна со сдвигом по «золотому углу». */
export function spawnPoint(base: { x: number; y: number; z: number }, seed: number): {
  x: number;
  y: number;
  z: number;
} {
  if (seed === 0) return base;
  const angle = seed * 2.399963;
  const radius = SPAWN_RADIUS * Math.sqrt(1 + (seed % 8));
  return {
    x: base.x + Math.cos(angle) * radius,
    y: base.y,
    z: base.z + Math.sin(angle) * radius,
  };
}
