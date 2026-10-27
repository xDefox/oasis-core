/**
 * Движение: один шаг разгона/торможения.
 *
 * Это единственная функция движения, которую обязаны вызывать и сервер,
 * и клиент. Пока формула живёт в двух местах, они рано или поздно
 * разъезжаются — и предсказание начинает «дрожать» без видимой причины.
 *
 * Модель простая: у скорости есть цель (направление × скорость), и текущая
 * скорость едет к ней с ограничением по ускорению. Никакой инерции «как в
 * космосе»: остановка быстрее разгона, иначе персонаж едет как по льду.
 */

import {
  GROUND_Y,
  PLAYER_ACCEL,
  PLAYER_CROUCH_SPEED,
  PLAYER_DECEL,
  PLAYER_GRAVITY,
  PLAYER_JUMP_SPEED,
  PLAYER_SPEED,
  PLAYER_SPRINT_SPEED,
  PLAYER_STEP_UP,
} from './constants.ts';

export interface Velocity {
  vx: number;
  vz: number;
}

export interface VerticalState {
  y: number;
  vy: number;
  grounded: boolean;
  /** В этом тике стартовал прыжок. */
  jumped: boolean;
}

/** Меньше этого вектор считается нулевым: дрожание стика — не движение. */
const DEAD_ZONE = 0.01;

/**
 * @param dt — шаг симуляции в секундах (1 / TICK_RATE).
 * @param crouch — присед: медленнее шага; спринт при приседе игнорируется.
 * @returns новая скорость. Функция чистая: вход не мутируется.
 */
export function stepVelocity(
  vx: number,
  vz: number,
  dirX: number,
  dirZ: number,
  sprint: boolean,
  dt: number,
  crouch = false,
): Velocity {
  const length = Math.hypot(dirX, dirZ);
  const moving = length > DEAD_ZONE;

  let targetVx = 0;
  let targetVz = 0;
  if (moving) {
    const speed = crouch
      ? PLAYER_CROUCH_SPEED
      : sprint
        ? PLAYER_SPRINT_SPEED
        : PLAYER_SPEED;
    // Нормализуем: по диагонали нельзя бежать быстрее, чем по прямой.
    const scale = (length > 1 ? 1 / length : 1) * speed;
    targetVx = dirX * scale;
    targetVz = dirZ * scale;
  }

  const maxDelta = (moving ? PLAYER_ACCEL : PLAYER_DECEL) * dt;
  const deltaX = targetVx - vx;
  const deltaZ = targetVz - vz;
  const delta = Math.hypot(deltaX, deltaZ);

  if (delta <= maxDelta || delta === 0) {
    return { vx: targetVx, vz: targetVz };
  }

  const factor = maxDelta / delta;
  return { vx: vx + deltaX * factor, vz: vz + deltaZ * factor };
}

/** Скорость (м/с) — для флага «идёт» и для отладки. */
export function speedOf(vx: number, vz: number): number {
  return Math.hypot(vx, vz);
}

/**
 * Вертикаль: прыжок с опоры + гравитация + шаг вверх.
 *
 * Присед блокирует прыжок. `groundY` — высота опоры под ногами из
 * `supportHeightAt` (по умолчанию плоский пол GROUND_Y; платформ пока нет
 * в спавне, но механика уже считает по ним).
 *
 * Шаг вверх (F1-19): если опора чуть выше тела — бордюр, ступенька, низкий
 * проп — тело подтягивается к ней без прыжка, но не выше `stepUp`: иначе
 * игрок «въезжал» бы на столб одним касанием. Контракт `supportHeightAt`
 * гарантирует `groundY <= y + stepUp`, поэтому выше шага тело никогда не
 * телепортируется.
 *
 * @param dt — шаг симуляции в секундах (1 / TICK_RATE).
 */
export function stepVertical(
  y: number,
  vy: number,
  wantJump: boolean,
  crouch: boolean,
  dt: number,
  groundY = GROUND_Y,
  stepUp = PLAYER_STEP_UP,
): VerticalState {
  let nextY = y;
  let nextVy = vy;

  // Шаг вверх: не падение и не прыжок, просто встали на ступеньку.
  if (groundY > nextY && groundY - nextY <= stepUp) {
    nextY = groundY;
    nextVy = 0;
  }

  let grounded = nextY <= groundY + 1e-4 && nextVy <= 1e-4;
  let jumped = false;

  if (grounded && wantJump && !crouch) {
    nextVy = PLAYER_JUMP_SPEED;
    grounded = false;
    jumped = true;
  }

  nextVy -= PLAYER_GRAVITY * dt;
  nextY += nextVy * dt;

  // Приземление на опору. Опора обязана быть в пределах шага вверх от
  // старта тика — иначе это не пол, а препятствие выше головы, и тело
  // телепортом вверх не тащим.
  if (nextY <= groundY && groundY - y <= stepUp) {
    nextY = groundY;
    nextVy = 0;
    grounded = true;
  } else {
    grounded = false;
  }

  return { y: nextY, vy: nextVy, grounded, jumped };
}
