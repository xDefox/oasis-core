/**
 * Страховка от регрессии «симуляция зависит от fps».
 *
 * Плейтест 22.10 и CI показали: при потолке кадра 100 мс предсказание на
 * 3–15 fps шло медленнее реального времени, и сверка тянула игрока вперёд.
 * Эти тесты падают, если потолок снова урежут.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_FRAME_MS, frameDeltaMs } from '../src/net/frameDelta.ts';

test('кадр 300 мс не обрезается до 100: иначе предсказание отстаёт от сервера', () => {
  assert.equal(frameDeltaMs(1300, 1000), 300);
});

test('потолок кадра покрывает headless-браузер на 3 fps', () => {
  // 3 fps = кадр 333 мс. Меньший потолок означает потерю времени симуляции.
  assert.ok(
    MAX_FRAME_MS >= 334,
    `потолок ${MAX_FRAME_MS} мс меньше кадра на 3 fps (334 мс)`,
  );
});

test('долгая пауза (вкладка в фоне) не даёт прыжка через полкарты', () => {
  assert.equal(frameDeltaMs(60_000, 1000), MAX_FRAME_MS);
});

test('потолок кадра ниже ограничителя догоняющих тиков (16 × 50 мс)', () => {
  const TICK_MS = 50;
  const GUARD_TICKS = 16;
  assert.ok(
    MAX_FRAME_MS < TICK_MS * GUARD_TICKS,
    `потолок ${MAX_FRAME_MS} мс не оставляет запаса для догоняющего шага`,
  );
});

test('битые часы не дают отрицательный шаг', () => {
  assert.equal(frameDeltaMs(1000, 1500), 0);
  assert.equal(frameDeltaMs(Number.NaN, 1000), 0);
});
