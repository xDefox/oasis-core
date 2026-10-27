/**
 * F1-3: как чужие аватары выглядят после сетевой интерполяции.
 *
 * Проблемы без этого слоя:
 *  - телепорт: lerp между старой и новой зоной тащит тело сквозь мир;
 *  - вход в AOI: аватар вспыхивает на месте из ниоткуда.
 *
 * Здесь: разрыв буфера делает StateStore, а этот класс сглаживает уже
 * готовый target — экспоненциальное следование, короткий бленд после
 * скачка и fade-in при первом появлении.
 */

/** Порог скачка XZ, м: дальше — считаем телепортом / входом в AOI. */
export const REMOTE_SNAP_M = 6;

/** Постоянная времени обычного следования, мс. */
const FOLLOW_TAU_MS = 55;

/** Длительность визуального бленда после телепорта, мс. */
const TELEPORT_BLEND_MS = 180;

/** Fade-in при первом появлении в AOI, мс. */
const AOI_FADE_MS = 280;

export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** 0..1 — прозрачность аватара. */
  opacity: number;
}

interface Track {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Последний целевой target (для детекта скачка). */
  targetX: number;
  targetZ: number;
  /** Когда впервые увидели сущность. */
  appearedAt: number;
  /** До какого момента идёт бленд после телепорта (0 = нет). */
  blendUntil: number;
  blendFromX: number;
  blendFromY: number;
  blendFromZ: number;
  blendFromYaw: number;
}

export class RemotePresentation {
  private readonly tracks = new Map<number, Track>();

  /** Сбросить всё (переподключение / смена сектора). */
  clear(): void {
    this.tracks.clear();
  }

  /** Убрать трек, если игрок вышел из снимка. */
  forget(id: number): void {
    this.tracks.delete(id);
  }

  /**
   * Обновить отображаемую позу под сетевой target.
   * `null` — сущности нет в AOI: трек удаляется, возвращаем null.
   */
  present(
    id: number,
    target: { x: number; y: number; z: number; yaw: number } | null,
    now: number,
    dtMs: number,
  ): RemotePose | null {
    if (!target) {
      this.tracks.delete(id);
      return null;
    }

    let track = this.tracks.get(id);
    if (!track) {
      track = {
        x: target.x,
        y: target.y,
        z: target.z,
        yaw: target.yaw,
        targetX: target.x,
        targetZ: target.z,
        appearedAt: now,
        blendUntil: 0,
        blendFromX: target.x,
        blendFromY: target.y,
        blendFromZ: target.z,
        blendFromYaw: target.yaw,
      };
      this.tracks.set(id, track);
      return {
        x: track.x,
        y: track.y,
        z: track.z,
        yaw: track.yaw,
        opacity: fadeOpacity(now - track.appearedAt),
      };
    }

    const jump = Math.hypot(target.x - track.targetX, target.z - track.targetZ);
    track.targetX = target.x;
    track.targetZ = target.z;

    if (jump >= REMOTE_SNAP_M) {
      // Телепорт / резкий вход: не тащим тело по прямой, а блендим коротко.
      track.blendFromX = track.x;
      track.blendFromY = track.y;
      track.blendFromZ = track.z;
      track.blendFromYaw = track.yaw;
      track.blendUntil = now + TELEPORT_BLEND_MS;
    }

    if (track.blendUntil > now) {
      const span = TELEPORT_BLEND_MS;
      const alpha = 1 - Math.max(0, (track.blendUntil - now) / span);
      const eased = easeOutCubic(alpha);
      track.x = track.blendFromX + (target.x - track.blendFromX) * eased;
      track.y = track.blendFromY + (target.y - track.blendFromY) * eased;
      track.z = track.blendFromZ + (target.z - track.blendFromZ) * eased;
      track.yaw = lerpAngle(track.blendFromYaw, target.yaw, eased);
    } else {
      track.blendUntil = 0;
      const k = 1 - Math.exp(-dtMs / FOLLOW_TAU_MS);
      track.x += (target.x - track.x) * k;
      track.y += (target.y - track.y) * k;
      track.z += (target.z - track.z) * k;
      track.yaw = lerpAngle(track.yaw, target.yaw, k);
    }

    return {
      x: track.x,
      y: track.y,
      z: track.z,
      yaw: track.yaw,
      opacity: fadeOpacity(now - track.appearedAt),
    };
  }
}

function fadeOpacity(ageMs: number): number {
  if (ageMs >= AOI_FADE_MS) return 1;
  if (ageMs <= 0) return 0;
  return easeOutCubic(ageMs / AOI_FADE_MS);
}

function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}

function lerpAngle(a: number, b: number, alpha: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * alpha;
}
