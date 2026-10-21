import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BIN,
  ENTITY_FLAG,
  EntityKind,
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeSnapshot,
  type EntityState,
} from '../src/index.ts';

const entity = (overrides: Partial<EntityState> = {}): EntityState => ({
  id: 7,
  kind: EntityKind.Player,
  x: 12.5,
  y: 0,
  z: -3.25,
  yaw: Math.PI / 2,
  flags: ENTITY_FLAG.Moving | ENTITY_FLAG.Sprinting,
  color: 0x33aaff,
  ...overrides,
});

describe('бинарный кодек', () => {
  it('ск round-trip\'ит снапшот', () => {
    const entities = [entity(), entity({ id: 8, x: -100.5, z: 77.125, yaw: 0 })];

    const decoded = decodeSnapshot(encodeSnapshot(1234, entities));

    assert.equal(decoded.tick, 1234);
    assert.equal(decoded.entities.length, 2);
    for (let i = 0; i < entities.length; i += 1) {
      const source = entities[i]!;
      const target = decoded.entities[i]!;
      assert.equal(target.id, source.id);
      assert.equal(target.kind, source.kind);
      assert.equal(target.flags, source.flags);
      assert.equal(target.color, source.color);
      // Квантование 1/64 м — погрешность не больше 0.8 см.
      assert.ok(Math.abs(target.x - source.x) < 0.008, `x: ${target.x} vs ${source.x}`);
      assert.ok(Math.abs(target.y - source.y) < 0.008);
      assert.ok(Math.abs(target.z - source.z) < 0.008);
      assert.ok(Math.abs(target.yaw - source.yaw) < 0.001);
    }
  });

  it('ск round-trip\'ит дельту вместе с удалёнными id', () => {
    const changed = [entity({ id: 9, x: 1.125 })];

    const decoded = decodeDelta(encodeDelta(42, changed, [3, 4, 5]));

    assert.equal(decoded.tick, 42);
    assert.equal(decoded.changed.length, 1);
    assert.equal(decoded.changed[0]!.id, 9);
    assert.deepEqual(decoded.removed, [3, 4, 5]);
  });

  it('различает типы пакетов', () => {
    assert.equal(encodeSnapshot(1, [])[0], BIN.Snapshot);
    assert.equal(encodeDelta(1, [], [])[0], BIN.Delta);
    assert.throws(() => decodeSnapshot(encodeDelta(1, [], [])), /ожидался тип/);
    assert.throws(() => decodeDelta(encodeSnapshot(1, [])), /ожидался тип/);
  });

  it('держит точность позиции в пределах кванта', () => {
    const source = entity({ x: 100.0078125, z: -0.0078125 });

    const decoded = decodeSnapshot(encodeSnapshot(1, [source]));

    assert.ok(Math.abs(decoded.entities[0]!.x - source.x) <= 1 / 64);
    assert.ok(Math.abs(decoded.entities[0]!.z - source.z) <= 1 / 64);
  });

  it('нормализует курс в диапазон 0..2π', () => {
    const decoded = decodeSnapshot(encodeSnapshot(1, [entity({ yaw: -Math.PI / 2 })]));
    const yaw = decoded.entities[0]!.yaw;

    assert.ok(yaw >= 0 && yaw < Math.PI * 2 + 0.001, `yaw=${yaw}`);
    // −π/2 и 3π/2 — один и тот же угол.
    assert.ok(Math.abs(Math.sin(yaw) - -1) < 0.01);
  });

  it('упаковывает сущность компактно', () => {
    // 19 байт на сущность — бюджет трафика держится за счёт этого, а не за счёт JSON.
    assert.equal(encodeSnapshot(1, [entity()]).byteLength, 1 + 4 + 2 + 19);
  });
});
