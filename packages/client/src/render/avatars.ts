/**
 * Аватары игроков (F1-4).
 *
 * Простые примитивы — без ассетов. Форма: мягкий «колобок» с ушками и
 * короткими ножками. Анимация — процедурный шаг и лёгкий наклон в бег.
 */

import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Material,
} from 'three/webgpu';

/** Высота точки «макушки» — для камеры и тега. */
export const AVATAR_HEIGHT = 1.55;

interface AvatarParts {
  rig: Group;
  body: Mesh;
  head: Mesh;
  legL: Mesh;
  legR: Mesh;
  phase: number;
}

function skinTone(color: number): number {
  // Чуть светлее основного цвета — «животик».
  const r = Math.min(255, ((color >> 16) & 0xff) + 28);
  const g = Math.min(255, ((color >> 8) & 0xff) + 22);
  const b = Math.min(255, (color & 0xff) + 18);
  return (r << 16) | (g << 8) | b;
}

export function createAvatar(color: number): Group {
  const group = new Group();
  group.name = 'avatar';

  const rig = new Group();
  rig.name = 'rig';
  group.add(rig);

  const cloth = new MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.05,
  });
  const belly = new MeshStandardMaterial({
    color: skinTone(color),
    roughness: 0.8,
    metalness: 0,
  });
  const face = new MeshLambertMaterial({ color: 0xffe0c8 });
  const ink = new MeshLambertMaterial({ color: 0x2a2430 });
  const blush = new MeshLambertMaterial({ color: 0xff9aa8, transparent: true, opacity: 0.55 });
  const accent = new MeshLambertMaterial({ color: 0xfff4a3 });

  // Туловище — мягкий шарик, чуть вытянут.
  const body = new Mesh(new SphereGeometry(0.42, 20, 16), cloth);
  body.name = 'body';
  body.scale.set(1, 1.15, 0.95);
  body.position.y = 0.55;
  rig.add(body);

  // Животик посветлее — «милота» без текстур.
  const tummy = new Mesh(new SphereGeometry(0.28, 16, 12), belly);
  tummy.position.set(0, 0.42, 0.22);
  tummy.scale.set(1, 0.9, 0.7);
  rig.add(tummy);

  const head = new Mesh(new SphereGeometry(0.36, 20, 16), face);
  head.name = 'head';
  head.position.y = 1.12;
  rig.add(head);

  // Ушки-капельки.
  for (const side of [-1, 1]) {
    const ear = new Mesh(new SphereGeometry(0.14, 12, 10), face);
    ear.position.set(side * 0.28, 1.38, 0);
    ear.scale.set(0.75, 1.15, 0.65);
    ear.rotation.z = side * -0.35;
    rig.add(ear);
  }

  // Глазки.
  for (const side of [-1, 1]) {
    const eye = new Mesh(new SphereGeometry(0.07, 10, 8), ink);
    eye.position.set(side * 0.12, 1.16, 0.3);
    rig.add(eye);
    const shine = new Mesh(new SphereGeometry(0.025, 8, 6), accent);
    shine.position.set(side * 0.12 + 0.015, 1.18, 0.355);
    rig.add(shine);
  }

  // Румянец.
  for (const side of [-1, 1]) {
    const cheek = new Mesh(new SphereGeometry(0.06, 8, 6), blush);
    cheek.position.set(side * 0.22, 1.05, 0.28);
    cheek.scale.set(1.2, 0.7, 0.5);
    rig.add(cheek);
  }

  // Антенна-«маячок» — лёгкий намёк на OASIS.
  const stem = new Mesh(new CylinderGeometry(0.025, 0.03, 0.22, 8), cloth);
  stem.position.y = 1.52;
  rig.add(stem);
  const bulb = new Mesh(new SphereGeometry(0.07, 12, 10), accent);
  bulb.position.y = 1.66;
  rig.add(bulb);

  // Короткие ножки.
  const legGeo = new CylinderGeometry(0.09, 0.11, 0.28, 10);
  const legL = new Mesh(legGeo, cloth);
  legL.name = 'legL';
  legL.position.set(-0.14, 0.14, 0);
  const legR = new Mesh(legGeo, cloth);
  legR.name = 'legR';
  legR.position.set(0.14, 0.14, 0);
  rig.add(legL, legR);

  const parts: AvatarParts = { rig, body, head, legL, legR, phase: 0 };
  group.userData.avatar = parts;

  return group;
}

/**
 * F1-4: процедурный шаг / наклон.
 * `speed` — м/с по горизонтали (0 = стойка).
 */
export function animateAvatar(group: Group, speed: number, dtMs: number): void {
  const parts = group.userData.avatar as AvatarParts | undefined;
  if (!parts) return;

  const moving = speed > 0.15;
  const pace = moving ? Math.min(speed, 8) : 0;
  parts.phase += (dtMs / 1000) * (4.2 + pace * 1.6);

  const swing = moving ? Math.sin(parts.phase) : 0;
  const bob = moving ? Math.abs(Math.sin(parts.phase * 2)) * 0.035 * Math.min(pace / 5, 1.2) : 0;
  const lean = moving ? Math.min(pace / 8, 1) * 0.18 : 0;

  parts.rig.position.y = bob;
  parts.rig.rotation.x = lean;
  // Лёгкое покачивание корпуса в сторону шага.
  parts.rig.rotation.z = moving ? swing * 0.06 : parts.rig.rotation.z * 0.85;

  const legAmp = moving ? 0.55 : 0;
  parts.legL.rotation.x = swing * legAmp;
  parts.legR.rotation.x = -swing * legAmp;

  // Голова чуть кивает в противофазе — живее.
  parts.head.rotation.x = moving ? -lean * 0.35 + swing * 0.04 : 0;
}

/** Подпись с ником: спрайт с текстом, нарисованным на canvas. */
export function createNameTag(name: string, color: number): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({ map: nameTexture(name, color), transparent: true, depthTest: false }),
  );
  sprite.scale.set(1.8, 0.45, 1);
  sprite.position.y = AVATAR_HEIGHT + 0.55;
  sprite.renderOrder = 10;
  sprite.userData.name = name;
  sprite.userData.color = color;
  return sprite;
}

/** Прозрачность аватара (F1-3: fade-in при входе в AOI). */
export function setAvatarOpacity(group: Group, opacity: number): void {
  const clamped = Math.min(1, Math.max(0, opacity));
  group.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const mat = material as Material & {
        transparent?: boolean;
        opacity?: number;
        depthWrite?: boolean;
        needsUpdate?: boolean;
      };
      mat.transparent = clamped < 0.999;
      mat.opacity = clamped;
      mat.depthWrite = clamped >= 0.999;
      mat.needsUpdate = true;
    }
  });
}

/**
 * Обновляет подпись, только если имя/цвет реально изменились.
 * Ростер приходит на каждое подключение и отключение — перерисовывать
 * canvas каждый раз бессмысленно.
 */
export function setNameTag(group: Group, name: string, color: number): void {
  const tag = group.getObjectByName('tag') as Sprite | undefined;
  if (!tag) return;
  if (tag.userData.name === name && tag.userData.color === color) return;

  const material = tag.material as SpriteMaterial;
  material.map?.dispose();
  material.map = nameTexture(name, color);
  material.needsUpdate = true;
  tag.userData.name = name;
  tag.userData.color = color;
}

function nameTexture(name: string, color: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) return new CanvasTexture(canvas);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 54px "Segoe UI", system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const hex = `#${color.toString(16).padStart(6, '0')}`;
  context.lineWidth = 8;
  context.strokeStyle = 'rgba(0,0,0,0.75)';
  context.strokeText(name, canvas.width / 2, canvas.height / 2);
  context.fillStyle = hex;
  context.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}
