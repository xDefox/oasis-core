/**
 * Хранилище состояния мира на клиенте.
 *
 * Три слоя:
 *  1. серверные снимки/дельты → буфер сэмплов (для интерполяции);
 *  2. ростер (имена, цвета) — отдельная плоскость, меняется редко;
 *  3. локальный игрок — предсказание + сверка с сервером (LocalPlayer).
 *
 * Интерполяция: рисуем не «последнее известное», а состояние на
 * (now − INTERP_DELAY). Задержка скрывает сетевой джиттер ценой
 * небольшого отставания — это стандартный размен в любом шутере.
 */

import {
  EntityKind,
  type EntityState,
  type PlayerInfo,
} from '@oasis/protocol';

export const INTERP_DELAY_MS = 110;
const MAX_SAMPLES = 10;

interface Sample {
  /** Локальное время получения (performance.now). */
  t: number;
  state: EntityState;
}

export class StateStore {
  private readonly samples = new Map<number, Sample[]>();
  readonly roster = new Map<number, PlayerInfo>();

  localPlayerId = 0;
  lastTick = 0;
  lastServerTime = 0;

  /** Полный снимок: всё, что было видно, приходит заново. */
  applySnapshot(entities: EntityState[], tick: number, now: number): void {
    const seen = new Set<number>();
    for (const entity of entities) {
      seen.add(entity.id);
      this.pushSample(entity, now);
    }
    for (const id of [...this.samples.keys()]) {
      if (!seen.has(id)) this.samples.delete(id);
    }
    this.lastTick = tick;
  }

  /** Дельта: изменившиеся сущности + исчезнувшие. */
  applyDelta(changed: EntityState[], removed: number[], tick: number, now: number): void {
    for (const entity of changed) this.pushSample(entity, now);
    for (const id of removed) this.samples.delete(id);
    this.lastTick = tick;
  }

  setRoster(players: PlayerInfo[]): void {
    this.roster.clear();
    for (const player of players) this.roster.set(player.id, player);
  }

  private pushSample(entity: EntityState, now: number): void {
    let buffer = this.samples.get(entity.id);
    if (!buffer) {
      buffer = [];
      this.samples.set(entity.id, buffer);
    }
    const last = buffer[buffer.length - 1];
    // Дубликаты (один и тот же тик) перезаписываем.
    if (last && last.t === now) {
      buffer[buffer.length - 1] = { t: now, state: entity };
      return;
    }
    buffer.push({ t: now, state: entity });
    if (buffer.length > MAX_SAMPLES) buffer.shift();
  }

  /**
   * Состояние мира на момент renderTime (интерполированное).
   * Возвращает карту id → состояние для отрисовки.
   */
  sampleAt(renderTime: number): Map<number, EntityState> {
    const result = new Map<number, EntityState>();
    for (const [id, buffer] of this.samples) {
      const state = this.interpolate(buffer, renderTime);
      if (state) result.set(id, state);
    }
    return result;
  }

  /** Последнее известное состояние (без интерполяции) — для сверки предсказания. */
  latest(entityId: number): EntityState | undefined {
    const buffer = this.samples.get(entityId);
    return buffer?.[buffer.length - 1]?.state;
  }

  private interpolate(buffer: Sample[], renderTime: number): EntityState | undefined {
    if (buffer.length === 0) return undefined;
    const first = buffer[0]!;
    if (buffer.length === 1) return first.state;
    if (renderTime <= first.t) return first.state;

    const last = buffer[buffer.length - 1]!;
    if (renderTime >= last.t) return last.state;

    for (let i = buffer.length - 1; i > 0; i -= 1) {
      const a = buffer[i - 1]!;
      const b = buffer[i]!;
      if (renderTime >= a.t && renderTime <= b.t) {
        const span = b.t - a.t;
        const alpha = span > 0 ? (renderTime - a.t) / span : 1;
        return lerpState(a.state, b.state, alpha);
      }
    }
    return last.state;
  }

  get playerCount(): number {
    let count = 0;
    for (const info of this.roster.values()) {
      if (info.id !== this.localPlayerId) count += 1;
    }
    return count;
  }

  get players(): EntityState[] {
    const result: EntityState[] = [];
    for (const buffer of this.samples.values()) {
      const state = buffer[buffer.length - 1]?.state;
      if (state && state.kind === EntityKind.Player) result.push(state);
    }
    return result;
  }
}

function lerpState(a: EntityState, b: EntityState, alpha: number): EntityState {
  return {
    id: b.id,
    kind: b.kind,
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    z: a.z + (b.z - a.z) * alpha,
    yaw: lerpAngle(a.yaw, b.yaw, alpha),
    flags: b.flags,
    color: b.color,
  };
}

/** Кратчайшая дуга по углу (yaw может перейти через ±π). */
function lerpAngle(a: number, b: number, alpha: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * alpha;
}
