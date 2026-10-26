/**
 * Коллизии с пропами — общая модель сервера и клиента.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPRINT_SPEED,
  PLAYER_STEP_UP,
  TICK_RATE,
  blocksBody,
  buildZoneColliders,
  clampToBounds,
  propCollider,
  resolvePlayerMove,
  supportHeightAt,
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

  it('скользит вдоль круглого пропа, а не застревает в нём', () => {
    // Жалоба «в круглых застреваешь»: ствол — не плоская стена. Мимо него
    // должны проходить касательной, а не упереться и стоять колом.
    const trunk = prop({ type: 'cylinder', x: 3, z: 0, sx: 0.5, sy: 1, sz: 0.5, y: 1 });
    const colliders = buildZoneColliders(zoneWith([trunk]));

    // Старт чуть сбоку от ствола: вглубь X не проходит, по Z проходит.
    const slide = resolvePlayerMove(2, -0.5, 1.0, 0.6, colliders);
    assert.equal(slide.blockedX, true, 'вглубь ствола не проходит');
    assert.equal(slide.blockedZ, false, 'по касательной проходит');
    assert.ok(slide.z > -0.5, `сместился по Z: ${slide.z}`);
    assert.ok(
      slide.x < 3 - 0.5 - PLAYER_RADIUS + 0.05,
      `остановился перед стволом, а не внутри: ${slide.x}`,
    );
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
    // Коллайдер собран: проп обязан быть известен движку, даже если с земли
    // он и не мешает (иначе на нём не сможешь стоять).
    const collider = propCollider(crown);
    assert.equal(blocksBody(collider, 0), false, 'низ 2.3 выше макушки 1.7 — проходим');
    assert.equal(
      blocksBody(collider, 2.4),
      true,
      'забравшийся на крону упирается в неё же',
    );
    const colliders = buildZoneColliders(zoneWith([crown]));
    assert.equal(
      supportHeightAt(crown.x, crown.z, colliders, 0),
      0,
      'с земли на крону не встать: её верх далеко выше шага вверх',
    );
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

/**
 * F1-19: высота тела в момент решения, а не при сборке зоны.
 * Жалоба, из которой выросла задача: маленькие объекты перепрыгнуть не
 * получалось (крона считалась стеной), а в высоких и круглых застревали.
 */
describe('F1-19: высотная фильтрация пропов', () => {
  it('низкий проп блокирует с земли, но проходится в прыжке', () => {
    // Лавка в плазе: верх 0.5 м — выше шага вверх, поэтому с земли не пройти.
    const lava = prop({ type: 'box', x: 2, z: 0, sx: 0.5, sy: 0.25, sz: 0.5, y: 0.25 });
    assert.ok(propCollider(lava).y1 > PLAYER_STEP_UP, 'шагом не берётся — нужен прыжок');

    const colliders = buildZoneColliders(zoneWith([lava]));
    const walk = resolvePlayerMove(0.8, 0, 1.5, 0, colliders, { feetY: 0 });
    assert.equal(walk.blockedX, true, 'с земли в лавку не входят');
    assert.ok(Math.abs(walk.x - 0.8) < 1e-9, `остался перед ней: ${walk.x}`);

    const jump = resolvePlayerMove(0.8, 0, 1.5, 0, colliders, { feetY: 1.0 });
    assert.equal(jump.blockedX, false, 'в прыжке низкий проп не мешает');
    assert.ok(Math.abs(jump.x - 2.3) < 1e-6, `прошёл дальше: ${jump.x}`);
  });

  it('высокий столб не перепрыгнуть', () => {
    const pillar = prop({ type: 'pillar', x: 1, z: 0, sx: 0.5, sy: 1.5, sz: 0.5, y: 1.5 });
    assert.ok(propCollider(pillar).y1 > 2.0, '3 м — выше апекса прыжка (≈1.1 м)');
    const colliders = buildZoneColliders(zoneWith([pillar]));
    const jump = resolvePlayerMove(-0.5, 0, 2, 0, colliders, { feetY: 1.0 });
    assert.equal(jump.blockedX, true, 'даже в прыжке упираются');
  });

  it('бордюр 0.3 м проходится ногой, и на него встают', () => {
    const curb = prop({ type: 'box', x: 2, z: 0, sx: 1, sy: 0.15, sz: 0.5, y: 0.15 });
    assert.ok(propCollider(curb).y1 <= PLAYER_STEP_UP, 'в пределах шага вверх');

    const colliders = buildZoneColliders(zoneWith([curb]));
    const step = resolvePlayerMove(0, 0, 2.5, 0, colliders, { feetY: 0 });
    assert.equal(step.blockedX, false, 'бордюр не блокирует');
    assert.equal(supportHeightAt(step.x, step.z, colliders, 0), 0.3, 'опора — его верх');
  });

  it('опора меряется по центру ноги, а не по краю габарита', () => {
    const curb = prop({ type: 'box', x: 2, z: 0, sx: 1, sy: 0.15, sz: 0.5, y: 0.15 });
    const colliders = buildZoneColliders(zoneWith([curb]));

    assert.equal(supportHeightAt(2.9, 0, colliders, 0), 0.3, 'центр ноги ещё на бордюре');
    assert.equal(supportHeightAt(3.2, 0, colliders, 0), 0, 'центр уже за краем — вниз');
    assert.equal(supportHeightAt(0, 0, colliders, 0), 0, 'в стороне — пол зоны');
  });

  it('высокий столб вокруг не даёт полки', () => {
    const wall = prop({ type: 'box', x: -4, z: 0, sx: 1, sy: 1.5, sz: 1, y: 1.5 });
    const colliders = buildZoneColliders(zoneWith([wall]));

    assert.equal(supportHeightAt(-4, 0, colliders, 0), 0, 'с земли полки нет');
    assert.equal(supportHeightAt(-4, 0, colliders, 1.0), 0, 'и в прыжке под ним нет полки');
  });

  it('в приседе проход ниже — низкое перекрытие проходится', () => {
    // Перемычка [1.2, 2.0]: стоя (макушка 1.7) упираемся, в приседе
    // (1.05) проходим под ней.
    const beam = prop({ type: 'box', x: 0, z: 0, sx: 1, sy: 0.4, sz: 1, y: 1.6 });
    const collider = propCollider(beam);
    assert.equal(blocksBody(collider, 0, PLAYER_HEIGHT), true, 'стоя упираемся');
    assert.equal(blocksBody(collider, 0, PLAYER_CROUCH_HEIGHT), false, 'в приседе проходим');

    const colliders = buildZoneColliders(zoneWith([beam]));
    // Идём ровно до центра перемычки: дальше — уже мимо, и блок не случится.
    const standing = resolvePlayerMove(-2, 0, 2, 0, colliders, { feetY: 0, height: PLAYER_HEIGHT });
    const crouched = resolvePlayerMove(-2, 0, 2, 0, colliders, {
      feetY: 0,
      height: PLAYER_CROUCH_HEIGHT,
    });
    assert.equal(standing.blockedX, true);
    assert.equal(crouched.blockedX, false);
  });
});
