/**
 * Столкновения с пропсами — общие для сервера и клиента.
 */

import { PLAYER_RADIUS } from './constants.ts';
import type { PortalDef, PropDef } from './types.ts';

export interface CircleObstacle {
  x: number;
  z: number;
  r: number;
}

/**
 * Превращаем пропс в круг-обход на XZ.
 */
export function propCircle(prop: PropDef): CircleObstacle {
  const rx = Math.abs(prop.sx);
  const rz = Math.abs(prop.sz);
  const base = Math.max(rx, rz);

  let mult = 1.4;
  if (prop.type === 'pillar' || prop.type === 'cylinder') {
    mult = 1.6;
  } else if (prop.type === 'box') {
    mult = 1.5;
  } else if (prop.type === 'cone') {
    mult = 1.5;
  } else if (prop.type === 'sphere') {
    mult = 1.4;
  }

  const r = base * mult + PLAYER_RADIUS * 0.1;
  return { x: prop.x, z: prop.z, r };
}

export function zoneObstacles(props: PropDef[], portals?: PortalDef[]): CircleObstacle[] {
  if (!portals || portals.length === 0) {
    return props.map(propCircle);
  }
  const result: CircleObstacle[] = [];
  for (const prop of props) {
    // Пропсы очень близко к порталам не блокируем — иначе игрок не может войти
    let nearPortal = false;
    for (const portal of portals) {
      if (Math.hypot(prop.x - portal.x, prop.z - portal.z) < portal.radius + 2.5) {
        nearPortal = true;
        break;
      }
    }
    if (nearPortal) continue;
    result.push(propCircle(prop));
  }
  return result;
}

/**
 * Сдвигаем позицию так, чтобы круг радиуса playerR не пересекался с
 * препятствиями. Push-out по радиусу.
 */
export function resolveCollisions(
  x: number,
  z: number,
  prevX: number,
  prevZ: number,
  obstacles: CircleObstacle[],
  playerR: number = PLAYER_RADIUS,
): { x: number; z: number } {
  const minDist = playerR + 1e-6;
  let px = x;
  let pz = z;

  for (const obs of obstacles) {
    const dx = px - obs.x;
    const dz = pz - obs.z;
    const dist = Math.hypot(dx, dz);
    const limit = obs.r + minDist;
    if (dist < limit - 1e-6) {
      if (dist < 1e-6) {
        const pdx = px - prevX;
        const pdz = pz - prevZ;
        const pd = Math.hypot(pdx, pdz);
        if (pd > 1e-6) {
          px = obs.x + (pdx / pd) * limit;
          pz = obs.z + (pdz / pd) * limit;
        } else {
          px = obs.x + limit;
          pz = obs.z;
        }
        continue;
      }
      const push = limit - dist;
      px = px + (dx / dist) * push;
      pz = pz + (dz / dist) * push;
    }
  }

  return { x: px, z: pz };
}
