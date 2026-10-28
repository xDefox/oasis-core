/**
 * Узлы добычи (F1-21): зелёные слизни в мире.
 *
 * Узел — обычный проп с id, начинающимся на `:res`. Выше шага вверх он не
 * растёт (`PLAYER_STEP_UP`), поэтому тело не блокирует: ни `checkWorld`, ни
 * `repairGaps` его не видят, а игрок добежит до любого из них. Так добыча
 * добавляется в мир как данные, а не как новое правило коллизий.
 */

import { GATHER_RADIUS, RESOURCE_PROP_PREFIX } from '@oasis/protocol';
import type { PropDef, ZoneDef } from '@oasis/protocol';

/**
 * Ближайший узел добычи в радиусе от точки (по XZ).
 *
 * Ровно одна проверка делает проп узлом — префикс id. Никаких «похожих на
 * слизня по цвету»: генератор и сервер должны договориться одним числом.
 */
export function findResourceNear(
  zone: Pick<ZoneDef, 'props'>,
  x: number,
  z: number,
  radius: number = GATHER_RADIUS,
): PropDef | null {
  let best: PropDef | null = null;
  let bestDistance = radius;
  for (const prop of zone.props) {
    if (!prop.id.includes(RESOURCE_PROP_PREFIX)) continue;
    const distance = Math.hypot(prop.x - x, prop.z - z);
    if (distance <= bestDistance) {
      best = prop;
      bestDistance = distance;
    }
  }
  return best;
}
