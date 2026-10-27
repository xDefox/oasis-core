/**
 * Локальный игрок: предсказание движения + сверка с сервером.
 *
 * Клиент интегрирует движение теми же числами и тем же фиксированным шагом,
 * что и сервер (общая `stepVelocity` + `stepVertical` + `resolvePlayerMove`),
 * поэтому в обычной игре расхождение равно сетевой задержке, а не ошибке
 * физики или коллизий.
 */

import {
  GROUND_Y,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  clampToBounds,
  resolvePlayerMove,
  stepVelocity,
  stepVertical,
  supportHeightAt,
  type EntityState,
  type ZoneBounds,
  type ZoneColliders,
} from '@oasis/protocol';

/** Больше этого — считаем «срывом» (реконнект, баг) и прыгаем. */
const SNAP_DISTANCE = 6.0;
/**
 * Меньше этого — нормальный сетевой лаг, трогать не нужно.
 * 8 м/с на 100 мс RTT дают 0.8 м, поэтому допуск не меньше метра.
 */
const SOFT_TOLERANCE = 1.0;
/** Доля «излишка» сверх допуска, которую гасим за один серверный апдейт. */
const CORRECTION_PER_UPDATE = 0.4;
/** Сколько тиков держим буфер прыжка, если нажали чуть раньше приземления. */
const JUMP_BUFFER_TICKS = 4;

export type { ZoneBounds };

export class LocalPlayer {
  /** Позиция на последнем завершённом тике (совпадает с серверной моделью). */
  x = 0;
  y = GROUND_Y;
  z = 0;
  yaw = 0;

  vx = 0;
  vy = 0;
  vz = 0;

  private accumulator = 0;
  private dirX = 0;
  private dirZ = 0;
  private sprint = false;
  private crouch = false;
  /** Буфер прыжка: тики, пока ждём землю. */
  private jumpBuffer = 0;
  private bounds: ZoneBounds | null = null;
  private colliders: ZoneColliders | null = null;

  /** Последний отправленный seq — для отладки и будущей дедупликации. */
  seq = 0;

  /**
   * Сколько тиков предсказания уже проинтегрировано.
   */
  simTicks = 0;

  private readonly tickDtMs: number;

  constructor(tickDtMs: number, startX: number, startZ: number) {
    this.tickDtMs = tickDtMs;
    this.x = startX;
    this.z = startZ;
    this.y = GROUND_Y;
  }

  get renderX(): number {
    return this.renderPose().x;
  }

  get renderY(): number {
    const t = this.accumulator / 1000;
    return Math.max(GROUND_Y, this.y + this.vy * t);
  }

  get renderZ(): number {
    return this.renderPose().z;
  }

  get grounded(): boolean {
    return this.y <= GROUND_Y + 1e-4 && this.vy <= 1e-4;
  }

  get airborne(): boolean {
    return !this.grounded;
  }

  /** Границы текущей зоны (null — не ограничивать). Коллайдеры пропов сбрасываем. */
  setBounds(bounds: ZoneBounds | null): void {
    this.bounds = bounds;
    this.colliders = null;
    this.clampInPlace();
  }

  /** Коллайдеры пропов зоны (F1-1). Подставляют bounds из сетки. */
  setColliders(colliders: ZoneColliders | null): void {
    this.colliders = colliders;
    if (colliders) this.bounds = colliders.bounds;
    this.clampInPlace();
  }

  /** Мгновенный перенос (портал): без него предсказание «идёт» через пустоту. */
  teleportTo(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.y = GROUND_Y;
    this.vy = 0;
    this.accumulator = 0;
    this.jumpBuffer = 0;
    this.clampInPlace();
  }

  /**
   * Направление + флаги. `jump` — одно нажатие Space: кладём в буфер,
   * чтобы прыжок сработал даже если нажали за кадр до приземления.
   */
  setDirection(
    dirX: number,
    dirZ: number,
    sprint: boolean,
    crouch = false,
    jump = false,
  ): void {
    this.dirX = dirX;
    this.dirZ = dirZ;
    this.sprint = sprint && !crouch;
    this.crouch = crouch;
    if (jump) this.jumpBuffer = JUMP_BUFFER_TICKS;
  }

  get crouching(): boolean {
    return this.crouch;
  }

  get sprinting(): boolean {
    return this.sprint;
  }

  /** Есть ли ещё импульс прыжка в буфере (для отправки на сервер). */
  get jumpPending(): boolean {
    return this.jumpBuffer > 0;
  }

  /** Интегрирует движение фиксированным шагом, как сервер. */
  advance(deltaMs: number): void {
    this.accumulator += deltaMs;
    const dt = this.tickDtMs / 1000;
    let guard = 0;
    while (this.accumulator >= this.tickDtMs && guard < 16) {
      this.accumulator -= this.tickDtMs;
      guard += 1;
      this.simulateTick(dt);
    }

    if (guard >= 16) {
      this.accumulator = 0;
      this.simulateTick(dt);
    }
  }

  private simulateTick(dt: number): void {
    this.simTicks += 1;
    const velocity = stepVelocity(
      this.vx,
      this.vz,
      this.dirX,
      this.dirZ,
      this.sprint,
      dt,
      this.crouch,
    );
    this.vx = velocity.vx;
    this.vz = velocity.vz;

    this.applyMotion(this.vx * dt, this.vz * dt);

    const wantJump = this.jumpBuffer > 0;
    // Высота опоры под ногами (F1-19): то же число, что считает сервер,
    // иначе на ступеньках предсказание начнёт отставать и дёргаться.
    const groundY = this.colliders
      ? supportHeightAt(this.x, this.z, this.colliders, this.y)
      : GROUND_Y;
    const vertical = stepVertical(this.y, this.vy, wantJump, this.crouch, dt, groundY);
    this.y = vertical.y;
    this.vy = vertical.vy;
    if (vertical.jumped || this.jumpBuffer > 0) {
      this.jumpBuffer = vertical.jumped ? 0 : Math.max(0, this.jumpBuffer - 1);
    }
  }

  private renderPose(): { x: number; z: number } {
    const t = this.accumulator / 1000;
    return this.resolveDelta(this.x, this.z, this.vx * t, this.vz * t);
  }

  private applyMotion(dx: number, dz: number): void {
    const resolved = this.resolveDelta(this.x, this.z, dx, dz);
    if (resolved.blockedX) this.vx = 0;
    if (resolved.blockedZ) this.vz = 0;
    this.x = resolved.x;
    this.z = resolved.z;
  }

  private resolveDelta(
    x: number,
    z: number,
    dx: number,
    dz: number,
  ): { x: number; z: number; blockedX: boolean; blockedZ: boolean } {
    if (this.colliders) {
      return resolvePlayerMove(x, z, dx, dz, this.colliders, {
        feetY: this.y,
        height: this.crouch ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT,
      });
    }
    const nextX = x + dx;
    const nextZ = z + dz;
    if (!this.bounds) {
      return { x: nextX, z: nextZ, blockedX: false, blockedZ: false };
    }
    return clampToBounds(nextX, nextZ, this.bounds, PLAYER_RADIUS);
  }

  private clampInPlace(): void {
    const resolved = this.resolveDelta(this.x, this.z, 0, 0);
    if (resolved.blockedX) this.vx = 0;
    if (resolved.blockedZ) this.vz = 0;
    this.x = resolved.x;
    this.z = resolved.z;
  }

  reconcile(authoritative: EntityState): void {
    const dx = authoritative.x - this.x;
    const dz = authoritative.z - this.z;
    const dy = authoritative.y - this.y;
    const distance = Math.hypot(dx, dz, dy);

    if (distance > SNAP_DISTANCE) {
      this.x = authoritative.x;
      this.y = authoritative.y;
      this.z = authoritative.z;
      this.vx = 0;
      this.vy = 0;
      this.vz = 0;
      this.accumulator = 0;
      this.jumpBuffer = 0;
      this.clampInPlace();
      return;
    }

    if (distance <= SOFT_TOLERANCE) {
      // Высоту подтягиваем мягче — иначе прыжок «прилипает» к старому снимку.
      if (Math.abs(dy) > 0.35) this.y += dy * 0.25;
      return;
    }

    const excess = distance - SOFT_TOLERANCE;
    const pull = (excess / distance) * CORRECTION_PER_UPDATE;
    this.x += dx * pull;
    this.y += dy * pull;
    this.z += dz * pull;
    this.clampInPlace();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
