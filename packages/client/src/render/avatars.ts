/**
 * Аватары игроков.
 *
 * Капсула + подпись с ником. Никаких скелетов и анимаций на первом этапе:
 * важно, чтобы два человека видели друг друга и понимали, кто где.
 */

import {
  CanvasTexture,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Sprite,
  SpriteMaterial,
  CapsuleGeometry,
  SphereGeometry,
} from 'three/webgpu';

const AVATAR_HEIGHT = 1.7;

export function createAvatar(color: number): Group {
  const group = new Group();
  group.name = 'avatar';

  const body = new Mesh(
    new CapsuleGeometry(0.35, 0.9, 6, 14),
    new MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.1 }),
  );
  body.position.y = AVATAR_HEIGHT / 2;
  group.add(body);

  const head = new Mesh(
    new SphereGeometry(0.24, 16, 12),
    new MeshLambertMaterial({ color: 0xf0d9c0 }),
  );
  head.position.y = AVATAR_HEIGHT + 0.12;
  group.add(head);

  // Направление «вперёд» — чтобы было видно, куда смотрит игрок.
  const nose = new Mesh(
    new SphereGeometry(0.07, 8, 6),
    new MeshLambertMaterial({ color: 0x30363f }),
  );
  nose.position.set(0, AVATAR_HEIGHT + 0.14, -0.24);
  group.add(nose);

  return group;
}

/** Подпись с ником: спрайт с текстом, нарисованным на canvas. */
export function createNameTag(name: string, color: number): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({ map: nameTexture(name, color), transparent: true, depthTest: false }),
  );
  sprite.scale.set(1.8, 0.45, 1);
  sprite.position.y = AVATAR_HEIGHT + 0.75;
  sprite.renderOrder = 10;
  sprite.userData.name = name;
  sprite.userData.color = color;
  return sprite;
}

/**
 * Обновляет подпись, только если имя/цвет реально изменились.
 * Ростер приходит на каждое подключение и отключение — перерисовывать
 * canvas каждый раз бессмысленно.
 */
/** Прозрачность аватара (F1-3: fade-in при входе в AOI). */
export function setAvatarOpacity(group: Group, opacity: number): void {
  const clamped = Math.min(1, Math.max(0, opacity));
  group.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      const mat = material as MeshStandardMaterial & MeshLambertMaterial & SpriteMaterial;
      mat.transparent = clamped < 0.999;
      mat.opacity = clamped;
      mat.depthWrite = clamped >= 0.999;
      mat.needsUpdate = true;
    }
  });
}

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
  context.font = 'bold 54px Inter, Segoe UI, system-ui, sans-serif';
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
