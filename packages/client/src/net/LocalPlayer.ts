/**
 * Локальный игрок: предсказание движения + сверка с сервером.
 *
 * Клиент интегрирует движение теми же числами и тем же фиксированным шагом,
 * что и сервер (общая `stepVelocity` из протокола), поэтому в обычной игре
 * расхождение равно сетевой задержке, а не ошибке физики.
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

import { stepVelocity } from '@oasis/protocol';
import type { EntityState } from '@oasis/protocol';

/** Больше этого — считаем «срывом» (реконнект, баг) и прыгаем. */
const SNAP_DISTANCE = 6.0;
/**
 * Меньше этого — нормальный сетевой лаг, трогать не нужно.
 * 8 м/с на 100 мс RTT дают 0.8 м, поэтому допуск не меньше метра.
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
  /** Позиция на последнем завершённом тике (совпадает с серверной моделью). */
  x = 0;
  z = 0;
  yaw = 0;

  vx = 0;
  vz = 0;

  private accumulator = 0;
  private dirX = 0;
  private dirZ = 0;
  private sprint = false;
  private bounds: ZoneBounds | null = null;
  /** Максимальное отставание картинки от авторитета, метры. */
  private aheadAbs = 0;

  /** Последний отправленный seq — для отладки и будущей дедупликации. */
  seq = 0;

  /**
   * Граница догона: снимок на RTT отстаёт, поэтому предсказание всегда
   * чуть впереди сервера. Экстраполяцию за эту границу не пускаем —
   * иначе мгновенный разворот рисует бросок на всю длину лага.
   */
  private aheadX = 0;
  private aheadZ = 0;

  private readonly tickDtMs: number;

  constructor(tickDtMs: number, startX: number, startZ: number) {
    this.tickDtMs = tickDtMs;
    this.x = startX;
    this.z = startZ;
  }

  /**
   * Позиция для рендера: тик идёт раз в 50 мс, и без экстраполяции аватар
   * прыгал бы на 0.25–0.4 м 20 раз в секунду. Досчитываем дробный шаг
   * вперёд по текущей скорости — картинка становится непрерывной.
   */
  get renderX(): number {
    return this.clampX(this.x + this.aheadX);
  }

  get renderZ(): number {
    return this.clampZ(this.z + this.aheadZ);
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
    this.aheadX = 0;
    this.aheadZ = 0;
    this.aheadAbs = 0;
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
    let guard = 0;
    while (this.accumulator >= this.tickDtMs && guard < 16) {
      this.accumulator -= this.tickDtMs;
      guard += 1;
      this.simulateTick(dt);
    }

    if (guard >= 16) {
      // Цикл не успел за реальным временем (вкладка в фоне, лаг).
      // Догоняем одним шагом, но фиксированным dt — иначе движение
      // ускорится ровно во столько раз, сколько времени потеряли.
      this.accumulator = 0;
      this.simulateTick(dt);
    }
  }

  /** Один тик: модель движения + границы. Общая с сервером формула. */
  private simulateTick(dt: number): void {
    const velocity = stepVelocity(this.vx, this.vz, this.dirX, this.dirZ, this.sprint, dt);
    this.vx = velocity.vx;
    this.vz = velocity.vz;

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Догоняем ровно на один кадр, но не больше накопленного отставания
    // от авторитета: развернулся — картинка не летит назад через полкарты.
    const stepX = this.vx * dt;
    const stepZ = this.vz * dt;
    this.aheadX = Math.max(-this.aheadAbs, Math.min(this.aheadAbs, this.aheadX + stepX));
    this.aheadZ = Math.max(-this.aheadAbs, Math.min(this.aheadAbs, this.aheadZ + stepZ));

    this.clamp();
  }

  /** То же ограничение, что и на сервере: игрок не выходит за прямоугольник зоны. */
  private clamp(): void {
    const nextX = this.clampX(this.x);
    const nextZ = this.clampZ(this.z);
    if (nextX !== this.x) this.vx = 0;
    if (nextZ !== this.z) this.vz = 0;
    this.x = nextX;
    this.z = nextZ;
  }

  private clampX(value: number): number {
    const bounds = this.bounds;
    if (!bounds) return value;
    const half = bounds.w / 2;
    return Math.min(Math.max(value, bounds.x - half), bounds.x + half);
  }

  private clampZ(value: number): number {
    const bounds = this.bounds;
    if (!bounds) return value;
    const half = bounds.d / 2;
    return Math.min(Math.max(value, bounds.z - half), bounds.z + half);
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

    // Сколько мы сейчас впереди сервера. Это и есть бюджет догона:
    // больше снимка мы не знаем, значит и рисовать дальше не имеем права.
    this.aheadAbs = Math.min(distance, 2);

    if (distance > SNAP_DISTANCE) {
      this.x = authoritative.x;
      this.z = authoritative.z;
      this.vx = 0;
      this.vz = 0;
      this.aheadX = 0;
      this.aheadZ = 0;
      this.aheadAbs = 0;
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
