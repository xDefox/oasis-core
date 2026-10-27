/**
 * Точка входа клиента OASIS Core.
 *
 * Схема кадра:
 *   1. читаем ввод → считаем направление движения;
 *   2. предсказываем движение локального игрока (фиксированный шаг = серверный);
 *   3. шлём ввод на сервер (30 Гц, бинарно);
 *   4. применяем серверные дельты (сверка предсказания);
 *   5. рисуем мир на (now − задержка интерполяции).
 *
 * Сервер — источник истины. Клиент никогда не решает, где игрок находится;
 * он только старается угадать, чтобы не было задержки в отклике.
 */

import { Group, Raycaster, Vector3 } from 'three/webgpu';

import {
  BIN,
  ENTITY_FLAG,
  INPUT_RATE,
  PROTOCOL_VERSION,
  buildZoneColliders,
  decodeDelta,
  decodeSnapshot,
  type ChatBroadcastMsg,
  type PortalDef,
  type RenamedMsg,
  type RosterMsg,
  type TeleportMsg,
  type WelcomeMsg,
  type ZoneMsg,
  type ZoneSummary,
} from '@oasis/protocol';

import { Input } from './input/Input.ts';
import { Connection } from './net/Connection.ts';
import { frameDeltaMs } from './net/frameDelta.ts';
import { LocalPlayer } from './net/LocalPlayer.ts';
import { RemotePresentation } from './net/RemotePresentation.ts';
import { INTERP_DELAY_MS, StateStore } from './net/StateStore.ts';
import { animateAvatar, createAvatar, createNameTag, setAvatarOpacity, setNameTag } from './render/avatars.ts';
import { createRenderer } from './render/Renderer.ts';
import { buildPortal, buildZone, disposeGroup } from './render/world.ts';
import { Hud } from './ui/Hud.ts';
import { runOnboarding } from './ui/Onboarding.ts';

/** На HTTPS-странице ws:// блокируется браузером как mixed content. */
const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:2567`;

/** Камера от третьего лица: дистанция по умолчанию / зум колёсиком. */
const CAMERA_DISTANCE = 4.2;
const CAMERA_DISTANCE_MIN = 1.6;
const CAMERA_DISTANCE_MAX = 7.5;
/** Ближе этого к игроку камеру не прижимаем — иначе видно изнутри капсулы. */
const CAMERA_MIN_DISTANCE = 0.85;
/** Зазор между камерой и поверхностью пропа при антиклипе, м. */
const CAMERA_CLIP_PADDING = 0.28;
/** Минимальная высота камеры над ногами игрока (не уходить под пол). */
const CAMERA_FLOOR_CLEARANCE = 0.35;
/** Высота точки, на которую смотрит камера. */
const CAMERA_TARGET_HEIGHT = 1.55;

const ACCOUNT_KEY = 'oasis.account';
const NAME_KEY = 'oasis.name';
/**
 * Токен места — в sessionStorage, а не в localStorage: он принадлежит
 * ВКЛАДКЕ. Соседняя вкладка того же браузера — отдельный игрок, а не тот же
 * самый; общий ключ заставил бы их отбирать друг у друга одно тело.
 */
const RESUME_KEY = 'oasis.resume';

interface Account {
  id: string;
  createdAt: number;
}

function randomId(): string {
  // crypto.randomUUID() доступен только в secure context (https или localhost).
  // В локальной сети по http://<IP>:5173 он отсутствует в некоторых браузерах.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Стабильный id аккаунта в localStorage: пока нет серверной авторизации. */
function loadAccount(): Account {
  const raw = window.localStorage.getItem(ACCOUNT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Account;
      if (parsed.id && parsed.createdAt) return parsed;
    } catch {
      // повреждённые данные — пересоздаём
    }
  }
  const account: Account = {
    id: `acct_${randomId()}`,
    createdAt: Date.now(),
  };
  window.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  return account;
}

function loadName(): string {
  const stored = window.localStorage.getItem(NAME_KEY);
  if (stored) return stored;
  const name = `guest-${Math.floor(Math.random() * 9000 + 1000)}`;
  window.localStorage.setItem(NAME_KEY, name);
  return name;
}

/**
 * Запоминает ник, который игрок выбрал сам (`/name`).
 *
 * Сохраняется только явный выбор. Суффикс `(2)`, выданный сервером при
 * совпадении двух вкладок, не записывается: это временное разведение, а не
 * новое имя — иначе оно прилипло бы к игроку навсегда.
 */
function saveName(name: string): void {
  window.localStorage.setItem(NAME_KEY, name);
}

/** Токен возобновления текущей вкладки: переживает F5, умирает с вкладкой. */
function loadResumeToken(): string | undefined {
  return window.sessionStorage.getItem(RESUME_KEY) ?? undefined;
}

function saveResumeToken(token: string): void {
  window.sessionStorage.setItem(RESUME_KEY, token);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const { renderer, scene, camera, backend } = await createRenderer(canvas);

  const state = new StateStore();
  const connection = new Connection();
  const remoteView = new RemotePresentation();

  let localPlayer: LocalPlayer | null = null;
  let zoneSummaries: ZoneSummary[] = [];
  let worldPortals: PortalDef[] = [];
  let balance = 0;
  let lastReconciledTick = -1;
  /** Ник, который выдал сервер: может отличаться от запрошенного. */
  let selfName = '';

  const zoneGroups = new Map<string, Group>();
  const avatarGroups = new Map<number, Group>();
  const sceneRoot = new Group();
  scene.add(sceneRoot);

  const hud = new Hud({
    onChat: (text) => {
      // Команды начинаются с `/` и в мир не уходят. Пока это только ник:
      // сервер — авторитет по реестру, поэтому он же решает, свободен ли он.
      if (text.startsWith('/')) {
        handleCommand(text);
        return;
      }
      connection.sendChat(text);
    },
    onChatFocusChange: (focused) => {
      // Пока печатаешь — мышь не должна крутить камеру.
      if (focused) document.exitPointerLock?.();
    },
    onRequestControl: () => input.requestControl(),
  });

  /**
   * Команды чата. Неизвестную команду не отправляем в мир: игрок опечатался,
   * а не пытался сказать что-то всем.
   */
  function handleCommand(text: string): void {
    const [rawCommand, ...rest] = text.slice(1).split(/\s+/);
    const command = rawCommand?.toLowerCase() ?? '';

    if (command === 'name') {
      const requested = rest.join(' ').trim();
      if (!requested) {
        hud.addChatLine(null, 'использование: /name новый-ник');
        return;
      }
      connection.rename(requested);
      return;
    }

    if (command === 'help') {
      hud.addChatLine(null, 'команды: /name <ник>, /help');
      return;
    }

    hud.addChatLine(null, `неизвестная команда «${rawCommand}» — /help`);
  }

  const input = new Input(
    canvas,
    (locked) => {
      hud.setCrosshair(locked);
    },
    { default: CAMERA_DISTANCE, min: CAMERA_DISTANCE_MIN, max: CAMERA_DISTANCE_MAX },
  );

  // ── зоны ────────────────────────────────────────────────────────────────

  function requestZone(zoneId: string): void {
    if (!zoneId || zoneGroups.has(zoneId)) return;
    connection.requestZone(zoneId);
  }

  /**
   * F0-9: зоны не копятся. При уходе оставляем только текущую; ресурсы
   * (включая порталы, вложенные в группу зоны) освобождаются через disposeGroup.
   */
  function unloadZonesExcept(keepId: string | null): void {
    for (const [id, group] of [...zoneGroups]) {
      if (keepId !== null && id === keepId) continue;
      disposeGroup(group);
      zoneGroups.delete(id);
    }
  }

  function zoneAt(x: number, z: number): ZoneSummary | undefined {
    let nearest: ZoneSummary | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const zone of zoneSummaries) {
      const halfW = zone.bounds.w / 2;
      const halfD = zone.bounds.d / 2;
      const inside =
        x >= zone.bounds.x - halfW &&
        x <= zone.bounds.x + halfW &&
        z >= zone.bounds.z - halfD &&
        z <= zone.bounds.z + halfD;
      if (inside) return zone;
      const dx = Math.max(Math.abs(x - zone.bounds.x) - halfW, 0);
      const dz = Math.max(Math.abs(z - zone.bounds.z) - halfD, 0);
      const distance = Math.hypot(dx, dz);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = zone;
      }
    }
    return nearest;
  }

  /**
   * Зона под игроком — по его актуальной позиции.
   *
   * Границы зоны нужны зонду, чтобы проверять не «дошёл ли игрок до
   * конкретной стены», а «всегда ли он внутри своей зоны». Первая
   * проверка ломалась о портал: игрок уходил в соседнюю зону, и тест
   * называл это «вышел за границу».
   */
  function currentZone(): { id: string; bounds: ZoneSummary['bounds'] } | null {
    if (!localPlayer) return null;
    const zone = zoneAt(localPlayer.x, localPlayer.z);
    if (!zone) return null;
    return { id: zone.id, bounds: zone.bounds };
  }

  /** Аватары — событие ростера, а не таймер. Имя тоже обновляем здесь. */
  function syncAvatars(): void {
    for (const player of state.roster.values()) {
      let group = avatarGroups.get(player.id);
      if (!group) {
        group = createAvatar(player.color);
        const tag = createNameTag(player.name, player.color);
        tag.name = 'tag';
        group.add(tag);
        sceneRoot.add(group);
        avatarGroups.set(player.id, group);
      } else {
        setNameTag(group, player.name, player.color);
      }
    }
    for (const [id, group] of avatarGroups) {
      if (state.roster.has(id)) continue;
      disposeGroup(group);
      avatarGroups.delete(id);
      remoteView.forget(id);
    }
  }

  // ── обработчики сети ───────────────────────────────────────────────────

  const handlers = {
    onWelcome(message: WelcomeMsg): void {
      saveResumeToken(message.resumeToken);
      // Возврат после обрыва: старые сэмплы описывают прошлую сессию, и
      // интерполяция потянула бы тело из точки «до» в точку «после».
      if (message.resumed) {
        state.reset();
        lastReconciledTick = -1;
        hud.addChatLine(null, `связь восстановлена: ты снова ${message.name}`);
      } else {
        hud.addChatLine(null, `добро пожаловать, ${message.world.id}@${message.world.version}`);
      }
      // Ник мог измениться: сервер разводит совпадения суффиксом. Молчать
      // об этом нельзя — игрок будет искать, почему его зовут иначе.
      selfName = message.name;
      const requestedName = loadName();
      if (!message.resumed) {
        if (message.name !== requestedName) {
          hud.addChatLine(null, `ник «${requestedName}» уже занят здесь — ты ${message.name}`);
        } else {
          hud.addChatLine(null, `ты в мире как «${message.name}»`);
        }
        hud.addChatLine(
          null,
          'WASD — идти, Shift — бежать, Ctrl — присесть, Space — прыжок, мышь — камера, Enter — чат',
        );
      }
      state.localPlayerId = message.playerId;
      zoneSummaries = message.world.zones;
      worldPortals = message.world.portals ?? [];
      balance = message.balance;
      localPlayer = new LocalPlayer(1000 / message.tickRate, message.spawn.x, message.spawn.z);
      localPlayer.yaw = input.yaw;

      const zone = zoneAt(message.spawn.x, message.spawn.z);
      if (zone) {
        localPlayer.setBounds(zone.bounds);
        requestZone(zone.id);
      }
    },

    onRoster(message: RosterMsg): void {
      state.setRoster(message.players);
      syncAvatars();
    },

    onChat(message: ChatBroadcastMsg): void {
      hud.addChatLine(message.name, message.text);
    },

    onRenamed(message: RenamedMsg): void {
      selfName = message.name;
      saveName(message.name);
      hud.addChatLine(null, `теперь ты «${message.name}»`);
    },

    onZone(message: ZoneMsg): void {
      const zone = message.zone;
      if (!zoneGroups.has(zone.id)) {
        const group = buildZone(zone);
        // Порталы — дети группы зоны: выгрузка зоны уносит их вместе с ней.
        for (const portal of worldPortals) {
          if (portal.fromZone !== zone.id) continue;
          group.add(buildPortal(portal));
        }
        sceneRoot.add(group);
        zoneGroups.set(zone.id, group);
      }

      // Держим в сцене только зону под ногами (или только что пришедшую).
      const keepId = localPlayer
        ? (zoneAt(localPlayer.x, localPlayer.z)?.id ?? zone.id)
        : zone.id;
      unloadZonesExcept(keepId);

      // Коллизии предсказания = те же пропы, что рисуем (F1-1).
      if (localPlayer) {
        const at = zoneAt(localPlayer.x, localPlayer.z);
        if (at?.id === zone.id) {
          localPlayer.setColliders(buildZoneColliders(zone));
        }
      }
    },

    onTeleport(message: TeleportMsg): void {
      // Сначала границы новой зоны (без старых коллайдеров), потом перенос:
      // иначе clamp старой зоны «дёрнет» предсказание. Пропы придут в onZone.
      const zone = zoneSummaries.find((candidate) => candidate.id === message.zoneId);
      if (localPlayer) {
        localPlayer.setBounds(zone?.bounds ?? null);
        localPlayer.teleportTo(message.position.x, message.position.z);
      }
      // Старую геометрию снимаем сразу: иначе после нескольких порталов
      // в памяти висят все посещённые зоны.
      unloadZonesExcept(message.zoneId);
      requestZone(message.zoneId);
      hud.addChatLine(null, `переход в зону ${message.zoneId}`);
    },

    onBalance(message: { balance: number; reason: string }): void {
      balance = message.balance;
    },

    onPong(message: { t: number; serverTime: number }): void {
      const rtt = Date.now() - message.t;
      if (Number.isFinite(rtt) && rtt >= 0) ping = Math.min(rtt, 9_999);
    },

    onBinary(payload: Uint8Array): void {
      const now = performance.now();
      if (payload.byteLength === 0) return;

      let tick = -1;
      try {
        const type = payload[0];
        if (type === BIN.Snapshot) {
          const decoded = decodeSnapshot(payload);
          state.applySnapshot(decoded.entities, decoded.tick, now);
          tick = decoded.tick;
        } else if (type === BIN.Delta) {
          const decoded = decodeDelta(payload);
          state.applyDelta(decoded.changed, decoded.removed, decoded.tick, now);
          tick = decoded.tick;
        }
      } catch (error) {
        // Битая посылка не должна убивать цикл кадров.
        console.warn('не удалось разобрать бинарный пакет', error);
        return;
      }

      // Сверка — ровно один раз на новый авторитетный снимок.
      if (localPlayer && tick >= 0 && tick !== lastReconciledTick) {
        lastReconciledTick = tick;
        const own = state.latest(state.localPlayerId);
        if (own) localPlayer.reconcile(own);
      }
    },

    onError(message: { code: string; message: string }): void {
      hud.addChatLine(null, `ошибка сервера: ${message.message}`);
    },

    onStatus(status: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void {
      hud.setStatus(status, detail);
      if (status === 'open') hud.addChatLine(null, 'соединение установлено');
      // 'closed' приходит только на явный выход: после обрыва клиент
      // переподключается и пишет 'connecting', а не «соединение закрыто».
      if (status === 'closed') {
        hud.addChatLine(null, 'соединение закрыто');
        remoteView.clear();
      }
      if (status === 'error') hud.addChatLine(null, `ошибка: ${detail ?? '?'}`);
    },
  };

  // ── онбординг (F1-8) → подключение ─────────────────────────────────────

  const account = loadAccount();
  const gate = await runOnboarding(loadName());
  if (gate.shown) saveName(gate.name);
  const joinName = gate.name;

  try {
    await connection.connect(
      SERVER_URL,
      {
        protocolVersion: PROTOCOL_VERSION,
        accountId: account.id,
        accountCreatedAt: account.createdAt,
        name: joinName,
        resume: loadResumeToken(),
      },
      handlers,
    );
  } catch (error) {
    hud.setStatus('error', String(error));
    hud.addChatLine(null, `не удалось подключиться: ${String(error)}`);
    return;
  }

  // ── ввод в чат ─────────────────────────────────────────────────────────

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.code === 'Enter') {
      event.preventDefault();
      // Иначе pointer lock продолжает слать mousemove, и камера крутится
      // в такт печати.
      document.exitPointerLock?.();
      hud.focusChat();
    }
  });

  // ── цикл кадра ─────────────────────────────────────────────────────────

  let lastFrame = performance.now();
  let fpsAccumulator = 0;
  let fpsFrames = 0;
  let fps = 0;
  let inputAccumulator = 0;
  let pingTimer = 0;
  let ping = 0;
  let frameCounter = 0;

  const cameraTarget = new Vector3();
  const cameraPosition = new Vector3();
  const lookDirection = new Vector3();
  const rayDirection = new Vector3();
  const rayHit = new Vector3();
  const raycaster = new Raycaster();
  let cameraSmoothedDistance = CAMERA_DISTANCE;
  /** Сглаженная высота камеры при приседе — без рывка вниз. */
  let cameraCrouchDrop = 0;

  /**
   * F1-5: максимальная дистанция камеры до стены/пропа.
   * Пол (`isGround`) пропускаем — под полом держим отдельным clamp по Y.
   */
  function clampCameraDistance(target: Vector3, desired: Vector3): number {
    rayDirection.copy(desired).sub(target);
    const distance = rayDirection.length();
    if (distance < 0.001 || zoneGroups.size === 0) return distance;

    rayDirection.divideScalar(distance);
    raycaster.set(target, rayDirection);
    raycaster.far = distance;

    const hits = raycaster.intersectObjects([...zoneGroups.values()], true);
    for (const hit of hits) {
      let obj: { userData?: { isGround?: boolean }; parent?: unknown } | null = hit.object;
      let ground = false;
      while (obj) {
        if (obj.userData?.isGround) {
          ground = true;
          break;
        }
        obj = obj.parent as typeof obj;
      }
      if (ground) continue;
      return Math.max(CAMERA_MIN_DISTANCE, hit.distance - CAMERA_CLIP_PADDING);
    }
    return distance;
  }

  function frame(): void {
    requestAnimationFrame(frame);
    frameCounter += 1;

    const now = performance.now();
    const deltaMs = frameDeltaMs(now, lastFrame);
    lastFrame = now;

    // 1. ввод
    const direction = input.moveDirection();
    const jump = input.consumeJump();
    localPlayer?.setDirection(
      direction.x,
      direction.z,
      input.sprinting,
      input.crouching,
      jump,
    );
    const netJump = Boolean(localPlayer?.jumpPending);

    // 2. предсказание
    localPlayer?.advance(deltaMs);

    // 3. отправка ввода. 30 Гц, но не реже раза в 500 мс: вкладка в фоне
    // почти не рисует кадры, и без этого сервер по TTL решает, что клиент
    // отвалился, и останавливает игрока.
    if (localPlayer && connection.connected) {
      inputAccumulator = Math.min(inputAccumulator + deltaMs, 400);
      if (inputAccumulator >= 1000 / INPUT_RATE) {
        inputAccumulator = 0;
        connection.sendInput({
          seq: localPlayer.nextSeq(),
          dirX: direction.x,
          dirZ: direction.z,
          yaw: input.yaw,
          sprint: input.sprinting,
          crouch: input.crouching,
          jump: netJump,
        });
      }
    }

    // 5. интерполяция и отрисовка
    const renderTime = now - INTERP_DELAY_MS;
    const snapshot = state.sampleAt(renderTime);

    for (const [id, group] of avatarGroups) {
      if (id === state.localPlayerId) continue;
      const entity = snapshot.get(id);
      const pose = remoteView.present(id, entity ?? null, now, deltaMs);
      if (!pose) {
        // Игрок ушёл из зоны или за радиус видимости: сервер перестал
        // слать его состояние. Тело не должно зависнуть на месте — прячем.
        group.visible = false;
        continue;
      }
      group.visible = pose.opacity > 0.02;
      group.position.set(pose.x, pose.y, pose.z);
      // Модель смотрит в +Z, камера и «вперёд» — в −Z: +π, чтобы видеть спину.
      group.rotation.y = pose.yaw + Math.PI;
      setAvatarOpacity(group, pose.opacity);
      // Скорость чужого — по смещению сглаженной позы между кадрами.
      const prev = (group.userData.prevPos as { x: number; z: number } | undefined) ?? {
        x: pose.x,
        z: pose.z,
      };
      const moved = Math.hypot(pose.x - prev.x, pose.z - prev.z);
      const speed = deltaMs > 0 ? (moved / deltaMs) * 1000 : 0;
      group.userData.prevPos = { x: pose.x, z: pose.z };
      const flags = entity?.flags ?? 0;
      animateAvatar(group, speed, deltaMs, {
        sprint: (flags & ENTITY_FLAG.Sprinting) !== 0,
        crouch: (flags & ENTITY_FLAG.Crouching) !== 0,
        airborne: (flags & ENTITY_FLAG.Airborne) !== 0 || pose.y > 0.05,
      });
    }

    // Свой аватар — по предсказанию, а не по интерполированному снимку:
    // снимок отстаёт на INTERP_DELAY_MS, и камера уезжала бы от тела.
    // renderX/renderZ добавляют дробный шаг внутри тика — иначе тело
    // дёргалось бы 20 раз в секунду при плавной камере.
    if (localPlayer) {
      const own = avatarGroups.get(state.localPlayerId);
      if (own) {
        own.position.set(localPlayer.renderX, localPlayer.renderY, localPlayer.renderZ);
        own.rotation.y = input.yaw + Math.PI;
        animateAvatar(own, Math.hypot(localPlayer.vx, localPlayer.vz), deltaMs, {
          sprint: localPlayer.sprinting,
          crouch: localPlayer.crouching && localPlayer.grounded,
          airborne: localPlayer.airborne,
        });
      }
    }

    // F1-5: цель на игроке, антиклип рейкастом, плавный зум, пол по Y.
    if (localPlayer) {
      const pitch = input.pitch;
      const yaw = input.yaw;
      lookDirection.set(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      );
      cameraCrouchDrop +=
        ((localPlayer.crouching && localPlayer.grounded ? 0.38 : 0) - cameraCrouchDrop) *
        (1 - Math.exp(-deltaMs / 70));
      cameraTarget.set(
        localPlayer.renderX,
        CAMERA_TARGET_HEIGHT - cameraCrouchDrop + localPlayer.renderY,
        localPlayer.renderZ,
      );

      const desiredDistance = input.cameraDistance;
      cameraPosition.copy(cameraTarget).addScaledVector(lookDirection, -desiredDistance);

      const clamped = clampCameraDistance(cameraTarget, cameraPosition);
      if (clamped < cameraSmoothedDistance - 0.02) {
        // В стену — сразу, иначе кадр изнутри пропа.
        cameraSmoothedDistance = clamped;
      } else {
        // От стены / к зуму колёсика — плавно.
        const zoomTarget = Math.min(desiredDistance, clamped);
        cameraSmoothedDistance +=
          (zoomTarget - cameraSmoothedDistance) * (1 - Math.exp(-deltaMs / 140));
        if (clamped < cameraSmoothedDistance) cameraSmoothedDistance = clamped;
      }

      camera.position.copy(cameraTarget).addScaledVector(lookDirection, -cameraSmoothedDistance);
      // Не проваливаться под пол за спиной при взгляде вверх.
      const floorY = localPlayer.renderY + CAMERA_FLOOR_CLEARANCE;
      if (camera.position.y < floorY) camera.position.y = floorY;
      camera.lookAt(cameraTarget);
    }

    renderer.render(scene, camera);

    // 5. статистика и пинг
    fpsAccumulator += deltaMs;
    fpsFrames += 1;
    if (fpsAccumulator >= 500) {
      fps = Math.round((fpsFrames * 1000) / fpsAccumulator);
      fpsAccumulator = 0;
      fpsFrames = 0;
      hud.setStats(fps, ping, state.playerCount + 1, backend, balance);
    }

    pingTimer += deltaMs;
    if (pingTimer >= 2000) {
      pingTimer = 0;
      connection.ping(Date.now());
    }
  }

  // На выгрузке страницы ничего не шлём: явный leave() со стороны клиента —
  // это «ушёл по своему желанию», и сервер отдаёт место сразу (F0-8 не
  // срабатывает). Сокет закрывается сам, сервер видит обрыв в onDrop и
  // держит место 30 с — ровно то, что нужно при F5 и пропавшем Wi-Fi.
  // Явный выход остаётся в Connection.leave() — его зовут оттуда, где
  // выход осознанный.

  // Отладочный доступ для зонда (scripts/probe-client.mjs). Не API:
  // существует только чтобы можно было проверить предсказание снаружи.
  (window as unknown as { __oasisDebug?: () => unknown }).__oasisDebug = () => ({
    x: Number(localPlayer?.x.toFixed(3) ?? 0),
    z: Number(localPlayer?.z.toFixed(3) ?? 0),
    renderX: Number(localPlayer?.renderX.toFixed(3) ?? 0),
    renderZ: Number(localPlayer?.renderZ.toFixed(3) ?? 0),
    vx: Number(localPlayer?.vx.toFixed(3) ?? 0),
    vz: Number(localPlayer?.vz.toFixed(3) ?? 0),
    yaw: Number(input.yaw.toFixed(3)),
    cameraDistance: Number(camera.position.distanceTo(cameraTarget).toFixed(3)),
    zoneGroups: zoneGroups.size,
    /** Id зон, реально лежащих в сцене (после F0-9 — не больше одной). */
    loadedZones: [...zoneGroups.keys()],
    avatars: avatarGroups.size,
    roster: state.roster.size,
    /** Сколько чужих тел реально отрисовано (не спрятано) в данный момент. */
    visibleOthers: [...avatarGroups.entries()].filter(
      ([id, group]) => id !== state.localPlayerId && group.visible,
    ).length,
    /** Сколько чужих тел есть в снимке состояния. */
    trackedOthers: [...avatarGroups.keys()].filter((id) => id !== state.localPlayerId).length,
    rosterPlayers: [...state.roster.values()].map((player) => ({
      id: player.id,
      name: player.name,
    })),
    selfName: selfName,
    lastTick: state.lastTick,
    /** Сколько тиков предсказания проинтегрировано (тик — 50 мс). */
    simTicks: localPlayer?.simTicks ?? 0,
    keys: [...input.keys],
    frames: frameCounter,
    /** Зона, в которой игрок находится сейчас: id и границы. */
    zone: currentZone(),
  });

  (window as unknown as { __oasisWarp?: (x: number, z: number) => void }).__oasisWarp = (
    x,
    z,
  ) => {
    localPlayer?.teleportTo(x, z);
  };

  // Зонду нужно сверять предсказание с сервером, не читая поля класса.
  (window as unknown as { __oasisCompare?: () => unknown }).__oasisCompare = () => {
    const server = state.latest(state.localPlayerId);
    return {
      clientX: localPlayer ? Number(localPlayer.x.toFixed(3)) : null,
      clientZ: localPlayer ? Number(localPlayer.z.toFixed(3)) : null,
      serverX: server ? Number(server.x.toFixed(3)) : null,
      serverZ: server ? Number(server.z.toFixed(3)) : null,
      frames: frameCounter,
    };
  };

  frame();
}

void main();
