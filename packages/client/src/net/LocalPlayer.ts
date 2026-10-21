/**
 * Локальный игрок: предсказание движения + сверка с сервером.
 *
 * Клиент интегрирует движение теми же числами и тем же фиксированным
 * шагом, что и сервер (PLAYER_SPEED, TICK_RATE) — поэтому предсказание
 * почти не расходится с авторитетом.
 *
 * Когда приходит авторитетное состояние, считаем ошибку:
 *  - маленькая ошибка → гасим её плавно (не дёргаем камеру);
 *  - большая ошибка (телепорт, лаг, рассинхрон) → жёсткий сдвиг.
 */

import {
  PLAYER_SPRINT_SPEED,
  PLAYER_SPEED,
  type EntityState,
} from '@oasis/protocol';

/** Порог, после которого ошибка считается «срывом» и корректируется мгновенно. */
const SNAP_DISTANCE = 1.5;
/** Доля ошибки, гасимая за один серверный апдейт. */
const ERROR_DECAY = 0.15;

/** Границы зоны: клиент повторяет серверный clampToZone, иначе — откаты. */
export interface ZoneBounds {
  x: number;
  z: number;
  w: number;
  d: number;
}

export class LocalPlayer {
  /** Предсказанная позиция (без накопленной ошибки). */
  x = 0;
  z = 0;
  yaw = 0;

  /** Накопленная ошибка: рисуем (x − errorX), чтобы не дёргаться. */
  errorX = 0;
  errorZ = 0;

  private accumulator = 0;
  private dirX = 0;
  private dirZ = 0;
  private sprint = false;
  private bounds: ZoneBounds | null = null;

  /** Последний отправленный seq — для дедупликации на сервере. */
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

  /** Сверка с авторитетным состоянием сервера. */
  reconcile(authoritative: EntityState): void {
    const errorX = authoritative.x - this.x;
    const errorZ = authoritative.z - this.z;
    const distance = Math.hypot(errorX, errorZ);

    if (distance > SNAP_DISTANCE) {
      this.x = authoritative.x;
      this.z = authoritative.z;
      this.clamp();
      this.errorX = 0;
      this.errorZ = 0;
      return;
    }

    this.errorX += errorX;
    this.errorZ += errorZ;
    // Плавное гашение: ошибка уменьшается на каждый апдейт.
    this.errorX *= 1 - ERROR_DECAY;
    this.errorZ *= 1 - ERROR_DECAY;
  }

  /** Позиция для отрисовки (с плавно гасимой ошибкой). */
  get renderX(): number {
    return this.x - this.errorX;
  }

  get renderZ(): number {
    return this.z - this.errorZ;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
