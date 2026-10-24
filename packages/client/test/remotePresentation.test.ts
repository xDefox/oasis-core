/**
 * F1-3: сглаживание чужих — телепорт не тащит по прямой, AOI fade-in.
 *
 * Мутация: убрать детект jump >= REMOTE_SNAP_M — бленд не стартует,
 * и после скачка pose совпадёт с мгновенным target без промежуточных.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REMOTE_SNAP_M, RemotePresentation } from '../src/net/RemotePresentation.ts';
import { StateStore } from '../src/net/StateStore.ts';
import { EntityKind } from '@oasis/protocol';

describe('F1-3: remote presentation', () => {
  it('плавно следует за мелкими шагами', () => {
    const view = new RemotePresentation();
    const first = view.present(1, { x: 0, y: 0, z: 0, yaw: 0 }, 1000, 16)!;
    assert.equal(first.x, 0);

    const next = view.present(1, { x: 0.5, y: 0, z: 0, yaw: 0 }, 1016, 16)!;
    assert.ok(next.x > 0 && next.x < 0.5, `ожидали промежуточную x, получили ${next.x}`);
  });

  it('на телепорте не прыгает мгновенно в точку назначения', () => {
    const view = new RemotePresentation();
    view.present(1, { x: 0, y: 0, z: 0, yaw: 0 }, 1000, 16);
    // Дожимаем к нулю.
    for (let t = 1016; t < 1300; t += 16) {
      view.present(1, { x: 0, y: 0, z: 0, yaw: 0 }, t, 16);
    }

    const afterJump = view.present(
      1,
      { x: REMOTE_SNAP_M + 10, y: 0, z: 0, yaw: 0 },
      1316,
      16,
    )!;
    assert.ok(
      afterJump.x < REMOTE_SNAP_M,
      `после телепорта должен быть бленд, а не мгновенный snap: x=${afterJump.x}`,
    );
  });

  it('при входе в AOI opacity растёт от 0 к 1', () => {
    const view = new RemotePresentation();
    const at0 = view.present(7, { x: 1, y: 0, z: 1, yaw: 0 }, 5000, 16)!;
    assert.ok(at0.opacity < 0.2, `сразу после появления opacity слишком высок: ${at0.opacity}`);

    const later = view.present(7, { x: 1, y: 0, z: 1, yaw: 0 }, 5400, 16)!;
    assert.equal(later.opacity, 1);
  });
});

describe('F1-3: StateStore не интерполирует сквозь телепорт', () => {
  it('после скачка > REMOTE_SNAP_M буфер сбрасывается', () => {
    const store = new StateStore();
    store.applyDelta(
      [{ id: 1, kind: EntityKind.Player, x: 0, y: 0, z: 0, yaw: 0, flags: 0, color: 0 }],
      [],
      1,
      1000,
    );
    store.applyDelta(
      [
        {
          id: 1,
          kind: EntityKind.Player,
          x: REMOTE_SNAP_M + 20,
          y: 0,
          z: 0,
          yaw: 0,
          flags: 0,
          color: 0,
        },
      ],
      [],
      2,
      1100,
    );

    // Между 1000 и 1100 интерполяции быть не должно: только новая точка.
    const mid = store.sampleAt(1050).get(1);
    assert.ok(mid, 'сущность должна быть в снимке');
    assert.ok(
      Math.abs(mid.x - (REMOTE_SNAP_M + 20)) < 0.01,
      `ожидали snap к новой позиции, получили x=${mid.x}`,
    );
  });
});
