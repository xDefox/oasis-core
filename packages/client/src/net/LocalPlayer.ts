/**
 * Локальный игрок: предсказание движения + сверка с сервером.
 *
 * Клиент интегрирует движение теми же числами и тем же фиксированным шагом,
 * что и сервер (PLAYER_SPEED, TICK_RATE), поэтому в обычной игре расхождение
 * равно сетевой задержке, а не ошибке физики.
 *
 * Важно: предсказание — это то, что видит игрок. Мы НЕ тянем картинку к
 * последнему серверному снимку: снимок описывает прошлое, и подтягивание к
 * нему добавляет ровно ту задержку, от которой предсказание избавляет.
 *
 * Поэтому:
 *  - расхождение меньше допуска игнорируется целиком (это просто лаг);
 *  - заметное (упёрлись в стену, телепорт, рассинхрон) — гасится по частям
 *    на каждом серверном апдейте, а не размазывается по кадрам;
 *  - большое (телепорт, реконнект) — мгновенный сдвиг.
 *
 * Раньше здесь ошибка накапливалась каждый кадр (`error += err`) и гасилась
 * умножением. На 60 fps это давало равновесие в несколько метров, и камера
 * уезжала вперёд от собственного аватара. Не повторяем.
 */

import {
  PLAYER_SPRINT_SPEED,
  PLAYER_SPEED,
  type EntityState,
} from '@oasis/protocol';

/** Больше этого — считаем «срывом» (реконнект, баг) и прыгаем. */
const SNAP_DISTANCE = 6.0;
/**
 * Меньше этого — нормальный сетевой лаг, трогать не нужно.
 * 9 м/с на 100 мс RTT дают 0.9 м, поэтому допуск не меньше метра.
 */
const SOFT_TOLERANCE = 1.0;
/** Доля «излишка» сверх допуска, которую гасим за один серверный апдейт. */
const CORRECTION_PER_UPDATE = 0.4;

/** Границы зоны: клиент повторяет серверный clampToZone, иначе — откаты. */
export interface ZoneBounds {
  x: number;
  z: number;
  w: number;
  d: number;
}

export class LocalPlayer {
  /** Предсказанная позиция. Именно она идёт в рендер. */
  x = 0;
  z = 0;
  yaw = 0;

  private accumulator = 0;
  private dirX = 0;
  private dirZ = 0;
  private sprint = false;
  private bounds: ZoneBounds | null = null;

  /** Последний отправленный seq — для отладки и будущей дедупликации. */
  seq = 0;

  private readonly tickDtMs: number;

  constructor(tickDtMs: number, startX: number, startZ: number) {
    this.tickDtMs = tickDtMs;
    this.x = startX;
    this.z = startZ;
  }

  /** Границы текущей зоны (null — не ограничивать). */
  setBounds(bounds: ZoneBounds | null): void {
    this.bounds = bounds;
    // Новая зона может не содержать текущую точку — сразу приводим себя в неё,
    // иначе первый же кадр покажет игрока за стеной.
    this.clamp();
  }

  /** Мгновенный перенос (портал): без него предсказание «идёт» через пустоту. */
  teleportTo(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.accumulator = 0;
    this.clamp();
  }

  /** Направление движения в мировых координатах (уже повёрнутое на yaw). */
  setDirection(dirX: number, dirZ: number, sprint: boolean): void {
    this.dirX = dirX;
    this.dirZ = dirZ;
    this.sprint = sprint;
  }

  /** Интегрирует движение фиксированным шагом, как сервер. */
  advance(deltaMs: number): void {
    this.accumulator += deltaMs;
    const dt = this.tickDtMs / 1000;
    const speed = this.sprint ? PLAYER_SPRINT_SPEED : PLAYER_SPEED;
    let guard = 0;
    while (this.accumulator >= this.tickDtMs && guard < 16) {
      this.accumulator -= this.tickDtMs;
      guard += 1;
      this.x += this.dirX * speed * dt;
      this.z += this.dirZ * speed * dt;
      this.clamp();
    }
    if (guard >= 16) this.accumulator = 0;
  }

  /** То же ограничение, что и на сервере: игрок не выходит за прямоугольник зоны. */
  private clamp(): void {
    const bounds = this.bounds;
    if (!bounds) return;
    const halfW = bounds.w / 2;
    const halfD = bounds.d / 2;
    this.x = Math.min(Math.max(this.x, bounds.x - halfW), bounds.x + halfW);
    this.z = Math.min(Math.max(this.z, bounds.z - halfD), bounds.z + halfD);
  }

  /**
   * Сверка с авторитетным состоянием. Вызывать на каждый новый серверный
   * снимок/дельту, а не каждый кадр — иначе один и тот же старый ответ
   * применяется десятки раз.
   */
  reconcile(authoritative: EntityState): void {
    const dx = authoritative.x - this.x;
    const dz = authoritative.z - this.z;
    const distance = Math.hypot(dx, dz);

    if (distance > SNAP_DISTANCE) {
      this.x = authoritative.x;
      this.z = authoritative.z;
      this.clamp();
      return;
    }

    if (distance <= SOFT_TOLERANCE) return;

    const excess = distance - SOFT_TOLERANCE;
    const pull = (excess / distance) * CORRECTION_PER_UPDATE;
    this.x += dx * pull;
    this.z += dz * pull;
    this.clamp();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
