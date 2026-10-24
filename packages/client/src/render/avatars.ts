/**
 * Аватары (F1-4) — дух Big Walk:
 * один овальный торс, компактная голова, глаз целиком снаружи,
 * руки крепятся к плечам корпуса.
 *
 * Бег — широкий быстрый мах; присед — корпус ниже, ножки согнуты.
 */

import {
  CanvasTexture,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Material,
} from 'three/webgpu';

export const AVATAR_HEIGHT = 1.7;

/** Насколько опускаем корпус в полном приседе, м. */
const CROUCH_DROP = 0.55;

interface AvatarRest {
  hipsY: number;
  torsoY: number;
  headY: number;
  eyeY: number;
  pupilY: number;
  armY: number;
  /** |x| плеча — в приседе чуть разводим, чтобы капсулы не лезли в торс. */
  armX: number;
  legY: number;
  tagY: number;
}

interface AvatarParts {
  rig: Group;
  torso: Mesh;
  hips: Mesh;
  head: Mesh;
  eyeWhite: Mesh;
  pupil: Mesh;
  legL: Group;
  legR: Group;
  armL: Group;
  armR: Group;
  phase: number;
  /** 0..1 сглаженный присед. */
  crouchT: number;
  rest: AvatarRest;
}

export interface AvatarMotion {
  sprint?: boolean;
  crouch?: boolean;
  airborne?: boolean;
}

function toy(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0,
  });
}

/** Pivot в суставе, меш вниз от него. */
function limb(length: number, radius: number, material: MeshStandardMaterial): Group {
  const pivot = new Group();
  const mesh = new Mesh(
    new CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 4, 10),
    material,
  );
  mesh.position.y = -length / 2;
  pivot.add(mesh);
  return pivot;
}

export function createAvatar(color: number): Group {
  const group = new Group();
  group.name = 'avatar';

  const rig = new Group();
  rig.name = 'rig';
  group.add(rig);

  const primary = toy(color);
  const dark = toy(0x1c1c22);
  const white = new MeshLambertMaterial({ color: 0xffffff });
  const pupilMat = new MeshLambertMaterial({ color: 0x101014 });

  const hipsR = 0.18;
  const hipsScaleX = 1.05;
  const hipsY = 0.82;
  const hips = new Mesh(new SphereGeometry(hipsR, 16, 12), dark);
  hips.name = 'hips';
  hips.position.y = hipsY;
  hips.scale.set(hipsScaleX, 0.85, 0.9);
  rig.add(hips);

  const legLen = 0.68;
  const legRads = 0.05;
  const legX = 0.09;
  const legL = limb(legLen, legRads, dark);
  legL.name = 'legL';
  legL.position.set(-legX, hipsY, 0.02);
  const legR = limb(legLen, legRads, dark);
  legR.name = 'legR';
  legR.position.set(legX, hipsY, 0.02);
  rig.add(legL, legR);

  const torsoBaseR = 0.26;
  const torsoScaleX = 0.88;
  const torsoY = 1.18;
  const torso = new Mesh(new SphereGeometry(torsoBaseR, 20, 16), primary);
  torso.name = 'torso';
  torso.position.y = torsoY;
  torso.scale.set(torsoScaleX, 1.4, 0.8);
  rig.add(torso);

  const headR = 0.3;
  const headY = 1.7;
  const head = new Mesh(new SphereGeometry(headR, 18, 14), primary);
  head.name = 'head';
  head.position.y = headY;
  rig.add(head);

  const eyeR = 0.145;
  const eyeZ = headR + eyeR * 0.2;
  const eyeY = 1.72;
  const eyeWhite = new Mesh(new SphereGeometry(eyeR, 16, 12), white);
  eyeWhite.name = 'eyeWhite';
  eyeWhite.position.set(0, eyeY, eyeZ);
  eyeWhite.scale.set(1.12, 1.05, 0.65);
  rig.add(eyeWhite);

  const pupil = new Mesh(new SphereGeometry(0.072, 12, 10), pupilMat);
  pupil.name = 'pupil';
  pupil.position.set(0, eyeY, eyeZ + eyeR * 0.55);
  rig.add(pupil);

  const armLen = 0.5;
  const armRads = 0.045;
  const shoulderY = 1.4;
  const shoulderX = torsoBaseR * torsoScaleX + armRads * 0.2;
  const armL = limb(armLen, armRads, dark);
  armL.name = 'armL';
  armL.position.set(-shoulderX, shoulderY, 0);

  const armR = limb(armLen, armRads, dark);
  armR.name = 'armR';
  armR.position.set(shoulderX, shoulderY, 0);

  rig.add(armL, armR);

  group.userData.avatar = {
    rig,
    torso,
    hips,
    head,
    eyeWhite,
    pupil,
    legL,
    legR,
    armL,
    armR,
    phase: Math.random() * Math.PI * 2,
    crouchT: 0,
    rest: {
      hipsY,
      torsoY,
      headY,
      eyeY,
      pupilY: eyeY,
      armY: shoulderY,
      armX: shoulderX,
      legY: hipsY,
      tagY: AVATAR_HEIGHT + 0.5,
    },
  } satisfies AvatarParts;

  return group;
}

export function animateAvatar(
  group: Group,
  speed: number,
  dtMs: number,
  motion: AvatarMotion = {},
): void {
  const parts = group.userData.avatar as AvatarParts | undefined;
  if (!parts) return;

  const airborne = Boolean(motion.airborne);
  const wantCrouch = Boolean(motion.crouch) && !airborne;
  const sprint = Boolean(motion.sprint) && !wantCrouch && !airborne;
  const crouchK = 1 - Math.exp(-dtMs / 70);
  parts.crouchT += ((wantCrouch ? 1 : 0) - parts.crouchT) * crouchK;
  const c = parts.crouchT;
  const drop = CROUCH_DROP * c;

  const moving = speed > 0.12 && !airborne;
  const pace = moving ? Math.min(speed / (sprint ? 7 : 5), sprint ? 1.45 : 1.15) : 0;
  const phaseRate = sprint ? 6.4 + pace * 3.2 : 4.2 + pace * 2.4;
  // В приседе шаг короче и чаще «семенит».
  if (!airborne) {
    parts.phase += (dtMs / 1000) * (c > 0.5 ? 3.2 + pace * 1.6 : phaseRate);
  }

  const swing = moving ? Math.sin(parts.phase) : 0;

  parts.rig.position.y = 0;
  // Лёгкий наклон вперёд в корточках — не «сидит на пятках».
  parts.rig.rotation.x = c > 0.001 ? c * -0.08 : 0;
  parts.rig.rotation.z = 0;

  const { rest } = parts;
  parts.hips.position.y = rest.hipsY - drop;
  parts.torso.position.y = rest.torsoY - drop;
  parts.head.position.y = rest.headY - drop;
  parts.eyeWhite.position.y = rest.eyeY - drop;
  parts.pupil.position.y = rest.pupilY - drop;
  // Плечи чуть наружу в приседе — капсулы рук не режут торс.
  const armOut = rest.armX + c * 0.1;
  parts.armL.position.set(-armOut, rest.armY - drop, 0.02 * c);
  parts.armR.position.set(armOut, rest.armY - drop, 0.02 * c);
  // В приседе сидит на попе — ноги прячем, иначе торчат «корточками».
  const showLegs = c < 0.55;
  parts.legL.visible = showLegs;
  parts.legR.visible = showLegs;
  parts.legL.position.set(-0.09, rest.legY, 0.02);
  parts.legR.position.set(0.09, rest.legY, 0.02);

  parts.torso.scale.set(0.88, 1.4, 0.8);
  parts.hips.scale.set(1.05 + c * 0.12, 0.85 + c * 0.1, 0.9 + c * 0.08);
  parts.head.scale.set(1, 1, 1);
  parts.head.rotation.x = c * 0.08;

  // Ноги только стоя / в прыжке / на шаге (пока ещё видны).
  const jumpBend = airborne ? -0.5 : 0;
  const legAmp = moving && showLegs ? (sprint ? 0.75 : 0.55) * pace : 0;
  parts.legL.rotation.x = jumpBend + swing * legAmp;
  parts.legR.rotation.x = jumpBend * 0.85 - swing * legAmp;
  parts.legL.rotation.z = airborne ? 0.12 : 0;
  parts.legR.rotation.z = airborne ? -0.12 : 0;

  // Руки свободно вдоль боков, чуть вперёд — не в торс.
  const armAmp = moving ? (c > 0.4 ? 0.12 : sprint ? 0.65 : 0.4) * pace : 0;
  parts.armL.rotation.x = -swing * armAmp + c * -0.2 - (airborne ? 0.35 : 0);
  parts.armR.rotation.x = swing * armAmp + c * -0.2 - (airborne ? 0.35 : 0);
  parts.armL.rotation.z = -c * 0.28 - (airborne ? 0.35 : 0);
  parts.armR.rotation.z = c * 0.28 + (airborne ? 0.35 : 0);

  parts.pupil.position.x = moving ? swing * (sprint ? 0.035 : 0.02) : parts.pupil.position.x * 0.85;

  const tag = group.getObjectByName('tag') as Sprite | undefined;
  if (tag) tag.position.y = rest.tagY - drop;
}

export function createNameTag(name: string, color: number): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({ map: nameTexture(name, color), transparent: true, depthTest: false }),
  );
  sprite.name = 'tag';
  sprite.scale.set(1.8, 0.45, 1);
  sprite.position.y = AVATAR_HEIGHT + 0.5;
  sprite.renderOrder = 10;
  sprite.userData.name = name;
  sprite.userData.color = color;
  return sprite;
}

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
      mat.transparent = opacity < 0.999;
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
  context.font = 'bold 54px "Segoe UI", system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const hex = `#${color.toString(16).padStart(6, '0')}`;
  context.lineWidth = 8;
  context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  context.strokeText(name, canvas.width / 2, canvas.height / 2);
  context.fillStyle = hex;
  context.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}
