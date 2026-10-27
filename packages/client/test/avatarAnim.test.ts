/**
 * F1-4: процедурная анимация меняет позу рига при движении.
 *
 * Мутация: noop в animateAvatar — ноги не качнутся, тест упадёт.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { animateAvatar, createAvatar } from '../src/render/avatars.ts';

describe('F1-4: анимация аватара', () => {
  it('в движении качает ноги', () => {
    const avatar = createAvatar(0x4fa3ff);
    const parts = avatar.userData.avatar as {
      rig: { position: { y: number }; rotation: { x: number } };
      legL: { rotation: { x: number } };
      legR: { rotation: { x: number } };
    };

    // Фаза шага у каждого аватара своя (`Math.random()` в createAvatar),
    // а ноги — это ±sin(фазы): в последнем кадре синус может попасть в ноль,
    // и тест падал в ~3% прогонов (CI, 27.10: упал на docs-only PR).
    // Поэтому меряем максимум за цикл, а не значение в одном кадре:
    // за 20 кадров фаза проходит 2.2 рад — гарантированно мимо нуля.
    let maxSwing = 0;
    for (let i = 0; i < 20; i += 1) {
      animateAvatar(avatar, 5, 16);
      maxSwing = Math.max(
        maxSwing,
        Math.abs(parts.legL.rotation.x),
        Math.abs(parts.legR.rotation.x),
      );
    }

    assert.ok(maxSwing > 0.05, 'ноги должны качаться при ходьбе');
    // Без bob/lean рига: иначе с камеры 3-го лица трясётся весь мир.
    assert.equal(parts.rig.position.y, 0);
    assert.equal(parts.rig.rotation.x, 0);
  });

  it('в покое возвращает наклон ближе к нулю', () => {
    const avatar = createAvatar(0xff7a59);
    const parts = avatar.userData.avatar as {
      rig: { rotation: { x: number; z: number } };
      legL: { rotation: { x: number } };
      legR: { rotation: { x: number } };
    };

    for (let i = 0; i < 30; i += 1) animateAvatar(avatar, 6, 16);
    for (let i = 0; i < 40; i += 1) animateAvatar(avatar, 0, 16);

    assert.ok(Math.abs(parts.legL.rotation.x) < 0.05);
    assert.ok(Math.abs(parts.legR.rotation.x) < 0.05);
    assert.ok(Math.abs(parts.rig.rotation.x) < 0.02);
  });

  it('в приседе опускает корпус и прячет ноги', () => {
    const avatar = createAvatar(0x6fcf7f);
    const parts = avatar.userData.avatar as {
      hips: { position: { y: number } };
      legL: { visible: boolean };
      legR: { visible: boolean };
      rest: { hipsY: number };
    };

    for (let i = 0; i < 40; i += 1) {
      animateAvatar(avatar, 0, 16, { crouch: true });
    }

    assert.ok(parts.hips.position.y < parts.rest.hipsY - 0.25, 'таз должен опуститься');
    assert.equal(parts.legL.visible, false, 'ноги спрятаны');
    assert.equal(parts.legR.visible, false, 'ноги спрятаны');
  });
});
