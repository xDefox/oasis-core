/**
 * Тесты модели движения.
 *
 * Она общая для сервера и клиента: если эти числа разъедутся, предсказание
 * начнёт «дрожать» без видимой причины, а сервер — прощать читы по скорости.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLAYER_ACCEL,
  PLAYER_SPEED,
  PLAYER_SPRINT_SPEED,
  TICK_RATE,
  speedOf,
  stepVelocity,
} from '@oasis/protocol';

const DT = 1 / TICK_RATE;

/** Прогон с постоянным вводом: возвращает скорость после n тиков. */
function run(dirX: number, dirZ: number, sprint: boolean, ticks: number) {
  let vx = 0;
  let vz = 0;
  for (let i = 0; i < ticks; i += 1) {
    const next = stepVelocity(vx, vz, dirX, dirZ, sprint, DT);
    vx = next.vx;
    vz = next.vz;
  }
  return { vx, vz };
}

describe('движение: разгон, торможение, ограничения', () => {
  it('разгоняется до целевой скорости и не превышает её', () => {
    const after1s = run(1, 0, false, TICK_RATE);
    assert.ok(
      Math.abs(speedOf(after1s.vx, after1s.vz) - PLAYER_SPEED) < 0.05,
      `скорость ${speedOf(after1s.vx, after1s.vz)} вместо ${PLAYER_SPEED}`,
    );

    // Даже после минуты бега скорость остаётся целевой.
    const after60s = run(1, 0, false, TICK_RATE * 60);
    assert.ok(speedOf(after60s.vx, after60s.vz) <= PLAYER_SPEED + 1e-6);
  });

  it('спринт быстрее шага, но не бесконечно', () => {
    const walk = run(1, 0, false, TICK_RATE * 3);
    const sprint = run(1, 0, true, TICK_RATE * 3);
    assert.ok(speedOf(sprint.vx, sprint.vz) > speedOf(walk.vx, walk.vz));
    assert.ok(speedOf(sprint.vx, sprint.vz) <= PLAYER_SPRINT_SPEED + 1e-6);
  });

  it('диагональ не быстрее прямой', () => {
    const straight = run(1, 0, false, TICK_RATE);
    const diagonal = run(0.7071, 0.7071, false, TICK_RATE);
    assert.ok(
      Math.abs(speedOf(diagonal.vx, diagonal.vz) - speedOf(straight.vx, straight.vz)) < 0.05,
    );
  });

  it('ввод длиннее единицы нормализуется, а не даёт форсаж', () => {
    const hacked = run(50, 0, false, TICK_RATE * 2);
    assert.ok(
      speedOf(hacked.vx, hacked.vz) <= PLAYER_SPEED + 1e-6,
      `чит прошёл: ${speedOf(hacked.vx, hacked.vz)} м/с`,
    );
  });

  it('разгон не мгновенный: скорость растёт постепенно', () => {
    // Раньше ни один тест этого не проверял: если скорость прыгает с 0 на 5
    // одним шагом, все остальные проверки (целевая скорость, торможение)
    // остаются довольны. А по ощущениям это «скольжение по льду» — баг,
    // который мы чинили 22.10.
    const after1tick = run(1, 0, false, 1);
    const afterHalf = run(1, 0, false, TICK_RATE / 2);

    assert.ok(
      speedOf(after1tick.vx, after1tick.vz) < PLAYER_SPEED,
      'за один тик скорость уже на цели — разгона нет',
    );
    assert.ok(
      speedOf(after1tick.vx, after1tick.vz) > 0.5,
      'скорость не растёт совсем: разгон сломан иначе',
    );

    // Скорость растёт, а не стоит на месте.
    assert.ok(
      speedOf(afterHalf.vx, afterHalf.vz) > speedOf(after1tick.vx, after1tick.vz),
      'скорость не растёт со временем',
    );

    // И достигает цели за разумное время, а не через минуту.
    const after1s = run(1, 0, false, TICK_RATE);
    assert.ok(
      Math.abs(speedOf(after1s.vx, after1s.vz) - PLAYER_SPEED) < 0.05,
      `за секунду скорость ${speedOf(after1s.vx, after1s.vz)} вместо ${PLAYER_SPEED}`,
    );
  });

  it('останавливается за конечное время и тормозит быстрее разгона', () => {
    const moving = run(1, 0, false, TICK_RATE);
    let vx = moving.vx;
    let vz = moving.vz;

    let stopTicks = 0;
    while (speedOf(vx, vz) > 0.001 && stopTicks < TICK_RATE * 5) {
      const next = stepVelocity(vx, vz, 0, 0, false, DT);
      vx = next.vx;
      vz = next.vz;
      stopTicks += 1;
    }

    // 5 м/с при торможении 42 м/с² — примерно 0.12 с, то есть 3 тика.
    assert.ok(stopTicks <= 5, `останавливался ${stopTicks} тиков`);
    assert.ok(stopTicks * DT * PLAYER_ACCEL < PLAYER_SPEED, 'тормозит медленнее, чем разгоняется');
  });

  it('мёртвая зона: дрожание ввода не двигает персонажа', () => {
    const idle = run(0.004, 0.004, false, 10);
    assert.equal(idle.vx, 0);
    assert.equal(idle.vz, 0);
  });
});
