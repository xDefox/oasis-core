/**
 * Узлы добычи (F1-21): зелёные слизни в мире.
 *
 * Узел — обычный проп с id, начинающимся на `:res`. Выше шага вверх он не
 * растёт (`PLAYER_STEP_UP`), поэтому тело не блокирует: ни `checkWorld`, ни
 * `repairGaps` его не видят, а игрок добежит до любого из них. Так добыча
 * добавляется в мир как данные, а не как новое правило коллизий.
 */

import {
  GATHER_DAILY_CAP,
  GATHER_NODE_COOLDOWN_MS,
  GATHER_RADIUS,
  RESOURCE_PROP_PREFIX,
} from '@oasis/protocol';
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

/** Успешный сбор: номер под лимитом — чтобы показать прогресс в сутках. */
export type GatherPermit =
  | { ok: true; usedToday: number }
  | { ok: false; reason: 'cooldown'; retryMs: number }
  | { ok: false; reason: 'cap' };

/** Сутки капа — по UTC, как и все timestamps в ledger. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Кулдауны узлов и суточный кап по аккаунтам.
 *
 * `consume` атомарно и то, и другое: раз проверка прошла — узел занят и
 * счётчик увеличен. Если начисление упадёт (ledger недоступен), сбор всё
 * равно сгорит: иначе зациклится «фарм → ошибка → фарм».
 */
export class GatherTracker {
  private readonly readyAt = new Map<string, number>();
  private readonly byAccount = new Map<string, { day: string; count: number }>();

  consume(nodeId: string, accountId: string, now: number): GatherPermit {
    const readyAt = this.readyAt.get(nodeId) ?? 0;
    if (now < readyAt) return { ok: false, reason: 'cooldown', retryMs: readyAt - now };

    const day = dayKey(now);
    const state = this.byAccount.get(accountId);
    const usedToday = state && state.day === day ? state.count : 0;
    if (usedToday >= GATHER_DAILY_CAP) return { ok: false, reason: 'cap' };

    this.readyAt.set(nodeId, now + GATHER_NODE_COOLDOWN_MS);
    this.byAccount.set(accountId, { day, count: usedToday + 1 });
    return { ok: true, usedToday: usedToday + 1 };
  }
}
