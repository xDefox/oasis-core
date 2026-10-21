/**
 * Построение сцены зоны из дескриптора.
 *
 * Клиент не знает ничего о мире, кроме данных: дескриптор зоны приходит
 * по сети, из него собирается геометрия. Никаких «зашитых» моделей.
 *
 * Пропсы — примитивы с плоским цветом. Это осознанно: первый мир должен
 * запускаться без единого арт-ассета. Красота — вопрос контента, а не кода.
 */

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';

import type { PortalDef, PropDef, ZoneDef } from '@oasis/protocol';

interface GeometryCache {
  box: BufferGeometry;
  cylinder: BufferGeometry;
  sphere: BufferGeometry;
  cone: BufferGeometry;
}

/** Кэш геометрий: пропсы одного типа делят одну геометрию. */
let geometryCache: GeometryCache | null = null;

function geometries(): GeometryCache {
  if (geometryCache) return geometryCache;
  geometryCache = {
    box: new BoxGeometry(1, 1, 1),
    cylinder: new CylinderGeometry(0.5, 0.5, 1, 12),
    sphere: new SphereGeometry(0.5, 14, 10),
    cone: new ConeGeometry(0.5, 1, 12),
  };
  return geometryCache;
}

function propGeometry(prop: PropDef): BufferGeometry {
  const cache = geometries();
  switch (prop.type) {
    case 'box':
    case 'pillar':
      return cache.box;
    case 'cylinder':
      return cache.cylinder;
    case 'sphere':
      return cache.sphere;
    case 'cone':
      return cache.cone;
    default:
      return cache.box;
  }
}

/** Габариты пропса: sx/sy/sz — полуразмеры, поэтому масштабируем базовую геометрию. */
function propScale(prop: PropDef): [number, number, number] {
  switch (prop.type) {
    case 'box':
    case 'pillar':
      return [prop.sx * 2, prop.sy * 2, prop.sz * 2];
    case 'cylinder':
      return [prop.sx * 2, prop.sy * 2, prop.sx * 2];
    case 'sphere':
      return [prop.sx * 2, prop.sy * 2, prop.sx * 2];
    case 'cone':
      return [prop.sx * 2, prop.sy * 2, prop.sx * 2];
    default:
      return [prop.sx * 2, prop.sy * 2, prop.sz * 2];
  }
}

export function buildZone(zone: ZoneDef): Group {
  const group = new Group();
  group.name = `zone:${zone.id}`;

  const groundMaterial = new MeshLambertMaterial({ color: zone.groundColor });
  const ground = new Mesh(new BoxGeometry(zone.bounds.w, 0.4, zone.bounds.d), groundMaterial);
  ground.position.set(zone.bounds.x, -0.2, zone.bounds.z);
  ground.receiveShadow = false;
  group.add(ground);

  const materials = new Map<number, Material>();
  for (const prop of zone.props) {
    let material = materials.get(prop.color);
    if (!material) {
      material = new MeshStandardMaterial({
        color: prop.color,
        roughness: 0.9,
        metalness: 0.05,
        flatShading: true,
      });
      materials.set(prop.color, material);
    }

    const mesh = new Mesh(propGeometry(prop), material);
    const [sx, sy, sz] = propScale(prop);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(prop.x, prop.y, prop.z);
    mesh.rotation.y = prop.rot;
    group.add(mesh);
  }

  return group;
}

/** Портал: светящееся кольцо на земле — видно издалека, работает без текстур. */
export function buildPortal(portal: PortalDef): Group {
  const group = new Group();
  group.name = `portal:${portal.id}`;

  const ring = new Mesh(
    new RingGeometry(portal.radius * 0.6, portal.radius, 32),
    new MeshLambertMaterial({ color: 0x4fa3ff, side: 2 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(portal.x, 0.05, portal.z);
  group.add(ring);

  const column = new Mesh(
    new CylinderGeometry(portal.radius * 0.5, portal.radius * 0.5, 6, 16, 1, true),
    new MeshLambertMaterial({ color: 0x4fa3ff, transparent: true, opacity: 0.25, side: 2 }),
  );
  column.position.set(portal.x, 3, portal.z);
  group.add(column);

  return group;
}

/** Удаляет геометрию и материалы группы (при выгрузке зоны). */
export function disposeGroup(group: Group): void {
  group.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose();
    } else {
      material?.dispose?.();
    }
  });
  group.removeFromParent();
}
