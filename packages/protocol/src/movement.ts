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

import { PLAYER_ACCEL, PLAYER_DECEL, PLAYER_SPEED, PLAYER_SPRINT_SPEED } from './constants.ts';

export interface Velocity {
  vx: number;
  vz: number;
}

/** Меньше этого вектор считается нулевым: дрожание стика — не движение. */
const DEAD_ZONE = 0.01;

/**
 * @param dt — шаг симуляции в секундах (1 / TICK_RATE).
 * @returns новая скорость. Функция чистая: вход не мутируется.
 */
export function stepVelocity(
  vx: number,
  vz: number,
  dirX: number,
  dirZ: number,
  sprint: boolean,
  dt: number,
): Velocity {
  const length = Math.hypot(dirX, dirZ);
  const moving = length > DEAD_ZONE;

  let targetVx = 0;
  let targetVz = 0;
  if (moving) {
    const speed = sprint ? PLAYER_SPRINT_SPEED : PLAYER_SPEED;
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
