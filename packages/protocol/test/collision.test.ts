/**
 * Коллизии с пропами — общая модель сервера и клиента.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLAYER_RADIUS,
  PLAYER_SPRINT_SPEED,
  TICK_RATE,
  buildZoneColliders,
  clampToBounds,
  propCollider,
  propOverlapsPlayerHeight,
  resolvePlayerMove,
  type PropDef,
  type ZoneDef,
} from '@oasis/protocol';

const DT = 1 / TICK_RATE;

function prop(partial: Partial<PropDef> & Pick<PropDef, 'type' | 'x' | 'z' | 'sx' | 'sy' | 'sz'>): PropDef {
  return {
    id: partial.id ?? 'p',
    type: partial.type,
    x: partial.x,
    y: partial.y ?? partial.sy,
    z: partial.z,
    sx: partial.sx,
    sy: partial.sy,
    sz: partial.sz,
    rot: partial.rot ?? 0,
    color: partial.color ?? 0xffffff,
  };
}

function zoneWith(props: PropDef[]): ZoneDef {
  return {
    id: 'test',
    sectorId: 's',
    name: 'test',
    kind: 'test',
    bounds: { x: 0, z: 0, w: 40, d: 40 },
    groundColor: 0x888888,
    props,
  };
}

describe('коллизии с пропами', () => {
  it('маленький box блокирует проход', () => {
    const brick = prop({ type: 'box', x: 2, z: 0, sx: 0.4, sy: 0.4, sz: 0.4 });
    const colliders = buildZoneColliders(zoneWith([brick]));

    const hit = resolvePlayerMove(0.8, 0, 1.2, 0, colliders);
    assert.equal(hit.blockedX, true);
    assert.ok(hit.x < 2 - 0.4 - PLAYER_RADIUS + 0.05, `остановились у ${hit.x}`);
  });

  it('скользит вдоль стены по другой оси', () => {
    const wall = prop({ type: 'box', x: 2, z: 0, sx: 0.5, sy: 1, sz: 3 });
    const colliders = buildZoneColliders(zoneWith([wall]));

    // Идём в стену и вдоль неё: X блокируется, Z проходит.
    const slide = resolvePlayerMove(0.9, -1, 1.5, 1.2, colliders);
    assert.equal(slide.blockedX, true);
    assert.equal(slide.blockedZ, false);
    assert.ok(slide.z > -1);
  });

  it('спринт за один тик не прошивает тонкий столб', () => {
    const pillar = prop({ type: 'pillar', x: 1.0, z: 0, sx: 0.45, sy: 2, sz: 0.45 });
    const colliders = buildZoneColliders(zoneWith([pillar]));

    const step = PLAYER_SPRINT_SPEED * DT; // 0.4 м
    // Старт прямо перед столбом; шаг спринта больше зазора — без коллизии пролетели бы.
    const startX = 1.0 - 0.45 - PLAYER_RADIUS - 0.05;
    const moved = resolvePlayerMove(startX, 0, step + 0.2, 0, colliders);
    assert.equal(moved.blockedX, true);
    assert.ok(moved.x < 1.0 - 0.45, 'не оказались за столбом');
  });

  it('конус над головой не блокирует', () => {
    const crown = prop({
      type: 'cone',
      x: 0,
      y: 3.5,
      z: 0,
      sx: 1.5,
      sy: 1.2,
      sz: 1.5,
    });
    assert.equal(propOverlapsPlayerHeight(crown), false);
    assert.equal(propCollider(crown), null);

    const colliders = buildZoneColliders(zoneWith([crown]));
    const through = resolvePlayerMove(-2, 0, 4, 0, colliders);
    assert.equal(through.blockedX, false);
    assert.ok(Math.abs(through.x - 2) < 1e-6);
  });

  it('ствол дерева (cylinder) блокирует, низкая скамья тоже', () => {
    const trunk = prop({ type: 'cylinder', x: 0, z: 0, sx: 0.22, sy: 1, sz: 0.22, y: 1 });
    const bench = prop({ type: 'box', x: 3, z: 0, sx: 1.1, sy: 0.25, sz: 0.45, y: 0.25 });
    assert.ok(propCollider(trunk));
    assert.ok(propCollider(bench));

    const colliders = buildZoneColliders(zoneWith([trunk, bench]));
    const intoTrunk = resolvePlayerMove(-1, 0, 1.2, 0, colliders);
    assert.equal(intoTrunk.blockedX, true);

    const intoBench = resolvePlayerMove(1.2, 0, 1.5, 0, colliders);
    assert.equal(intoBench.blockedX, true);
  });

  it('clampToBounds учитывает радиус', () => {
    const bounds = { x: 0, z: 0, w: 10, d: 10 };
    const edge = clampToBounds(4.9, 0, bounds, PLAYER_RADIUS);
    assert.ok(edge.x <= 5 - PLAYER_RADIUS + 1e-9);
    assert.equal(edge.blockedX, true);
  });

  it('resolve без коллайдеров только двигает точку', () => {
    const free = resolvePlayerMove(1, 2, 0.5, -0.25, null);
    assert.equal(free.x, 1.5);
    assert.equal(free.z, 1.75);
    assert.equal(free.blockedX, false);
    assert.equal(free.blockedZ, false);
  });

  it('выталкивает из центра пропа при старте внутри', () => {
    const box = prop({ type: 'box', x: 0, z: 0, sx: 1, sy: 1, sz: 1 });
    const colliders = buildZoneColliders(zoneWith([box]));
    const out = resolvePlayerMove(0, 0, 0, 0, colliders);
    const dist = Math.hypot(out.x, out.z);
    assert.ok(dist >= 1 + PLAYER_RADIUS - 0.05, `вытолкнули на ${dist}`);
  });
});
