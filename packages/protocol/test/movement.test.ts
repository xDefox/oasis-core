/**
 * Тесты модели движения.
 *
 * Она общая для сервера и клиента: если эти числа разъедутся, предсказание
 * начнёт «дрожать» без видимой причины, а сервер — прощать читы по скорости.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GROUND_Y,
  PLAYER_ACCEL,
  PLAYER_CROUCH_SPEED,
  PLAYER_GRAVITY,
  PLAYER_JUMP_SPEED,
  PLAYER_SPEED,
  PLAYER_SPRINT_SPEED,
  TICK_RATE,
  speedOf,
  stepVelocity,
  stepVertical,
} from '@oasis/protocol';

const DT = 1 / TICK_RATE;

/** Прогон с постоянным вводом: возвращает скорость после n тиков. */
function run(dirX: number, dirZ: number, sprint: boolean, ticks: number, crouch = false) {
  let vx = 0;
  let vz = 0;
  for (let i = 0; i < ticks; i += 1) {
    const next = stepVelocity(vx, vz, dirX, dirZ, sprint, DT, crouch);
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

  it('присед медленнее шага; спринт в приседе не помогает', () => {
    const walk = run(1, 0, false, TICK_RATE * 3);
    const crouch = run(1, 0, false, TICK_RATE * 3, true);
    const crouchSprint = run(1, 0, true, TICK_RATE * 3, true);
    assert.ok(speedOf(crouch.vx, crouch.vz) < speedOf(walk.vx, walk.vz));
    assert.ok(Math.abs(speedOf(crouch.vx, crouch.vz) - PLAYER_CROUCH_SPEED) < 0.05);
    assert.ok(
      Math.abs(speedOf(crouchSprint.vx, crouchSprint.vz) - PLAYER_CROUCH_SPEED) < 0.05,
      'присед отменяет спринт',
    );
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

  it('прыжок поднимает и возвращает на землю; в приседе нельзя', () => {
    const start = stepVertical(GROUND_Y, 0, true, false, DT);
    assert.equal(start.jumped, true);
    // В том же тике уже вычитается g·dt — скорость чуть ниже импульса.
    assert.ok(start.vy > PLAYER_JUMP_SPEED - PLAYER_GRAVITY * DT - 1e-6);
    assert.equal(start.grounded, false);
    assert.ok(start.y > GROUND_Y);

    let y = start.y;
    let vy = start.vy;
    let maxY = y;
    let grounded = false;
    for (let i = 0; i < TICK_RATE * 3; i += 1) {
      const next = stepVertical(y, vy, false, false, DT);
      y = next.y;
      vy = next.vy;
      grounded = next.grounded;
      if (y > maxY) maxY = y;
    }
    assert.ok(maxY > 0.8, `высота прыжка ${maxY}`);
    assert.ok(grounded);
    assert.equal(y, GROUND_Y);

    const crouched = stepVertical(GROUND_Y, 0, true, true, DT);
    assert.equal(crouched.jumped, false);
    assert.equal(crouched.y, GROUND_Y);
  });
});

/**
 * F1-19: опора перестала быть плоскостью y=0. Механика живёт в общей
 * `stepVertical`, поэтому здесь же проверяется, что сервер и клиент
 * поднимутся на ступеньку одним и тем же числом.
 */
describe('F1-19: опора и шаг вверх', () => {
  it('приземляется на опору выше пола, а не сквозь неё', () => {
    const ledge = 0.5;
    let y = 1.4;
    let vy = -1;
    let grounded = false;
    for (let i = 0; i < TICK_RATE; i += 1) {
      const next = stepVertical(y, vy, false, false, DT, ledge);
      y = next.y;
      vy = next.vy;
      grounded = next.grounded;
    }
    assert.equal(y, ledge, 'остановился ровно на верху пропа');
    assert.equal(grounded, true);
    assert.equal(vy, 0);
  });

  it('шаг вверх подтягивает тело к опоре без прыжка', () => {
    const next = stepVertical(0, 0, false, false, DT, 0.3);
    assert.equal(next.y, 0.3, 'бордюр 0.3 м взят ногой');
    assert.equal(next.grounded, true);
    assert.equal(next.jumped, false, 'это не прыжок и не падение');
  });

  it('прыжок стартует с высоты опоры, а не с пола', () => {
    const start = stepVertical(0.5, 0, true, false, DT, 0.5);
    assert.equal(start.jumped, true);
    assert.ok(start.y > 0.5, `тело ушло вверх: ${start.y}`);
    assert.equal(start.grounded, false);
  });

  it('опора выше шага вверх телепортом вверх не берётся', () => {
    // Вне контракта supportHeightAt (в игре такого не бывает): даже так
    // тело не должно въехать на столб одним касанием — иначе «застревание»
    // превратилось бы в бесплатный лифт.
    const next = stepVertical(0, 0, false, false, DT, 1.2);
    assert.ok(next.y <= 0, `подъём без прыжка запрещён, получили ${next.y}`);
    assert.equal(next.grounded, false, 'на недосягаемую опору не «встал»');
  });
});
