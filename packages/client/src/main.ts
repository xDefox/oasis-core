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

import { Group, Vector3 } from 'three/webgpu';

import {
  BIN,
  INPUT_RATE,
  PROTOCOL_VERSION,
  decodeDelta,
  decodeSnapshot,
  type ChatBroadcastMsg,
  type PortalDef,
  type RosterMsg,
  type TeleportMsg,
  type WelcomeMsg,
  type ZoneMsg,
  type ZoneSummary,
} from '@oasis/protocol';

import { Input } from './input/Input.ts';
import { Connection } from './net/Connection.ts';
import { LocalPlayer } from './net/LocalPlayer.ts';
import { INTERP_DELAY_MS, StateStore } from './net/StateStore.ts';
import { createAvatar, createNameTag, setNameTag } from './render/avatars.ts';
import { createRenderer } from './render/Renderer.ts';
import { buildPortal, buildZone, disposeGroup } from './render/world.ts';
import { Hud } from './ui/Hud.ts';

/** На HTTPS-странице ws:// блокируется браузером как mixed content. */
const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:2567`;

const ACCOUNT_KEY = 'oasis.account';
const NAME_KEY = 'oasis.name';

interface Account {
  id: string;
  createdAt: number;
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
    id: `acct_${crypto.randomUUID().replace(/-/g, '')}`,
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

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const { renderer, scene, camera, backend } = await createRenderer(canvas);

  const state = new StateStore();
  const connection = new Connection();

  let localPlayer: LocalPlayer | null = null;
  let zoneSummaries: ZoneSummary[] = [];
  let worldPortals: PortalDef[] = [];
  let balance = 0;
  let lastReconciledTick = -1;

  const zoneGroups = new Map<string, Group>();
  const avatarGroups = new Map<number, Group>();
  const sceneRoot = new Group();
  scene.add(sceneRoot);

  const hud = new Hud({
    onChat: (text) => connection.sendChat(text),
    onChatFocusChange: (focused) => {
      // Пока печатаешь — мышь не должна крутить камеру.
      if (focused) document.exitPointerLock?.();
    },
  });

  const input = new Input(canvas, (locked) => {
    hud.setCrosshair(locked);
  });

  // ── зоны ────────────────────────────────────────────────────────────────

  function requestZone(zoneId: string): void {
    if (!zoneId || zoneGroups.has(zoneId)) return;
    connection.requestZone(zoneId);
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
    }
  }

  // ── обработчики сети ───────────────────────────────────────────────────

  const handlers = {
    onWelcome(message: WelcomeMsg): void {
      hud.addChatLine(null, `добро пожаловать, ${message.world.id}@${message.world.version}`);
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

    onZone(message: ZoneMsg): void {
      const zone = message.zone;
      if (zoneGroups.has(zone.id)) return;
      const group = buildZone(zone);
      sceneRoot.add(group);
      zoneGroups.set(zone.id, group);

      for (const portal of worldPortals) {
        if (portal.fromZone !== zone.id) continue;
        sceneRoot.add(buildPortal(portal));
      }

      // Если игрок уже в этой зоне — обновляем границы предсказания.
      if (localPlayer) {
        const at = zoneAt(localPlayer.x, localPlayer.z);
        if (at?.id === zone.id) localPlayer.setBounds(zone.bounds);
      }
    },

    onTeleport(message: TeleportMsg): void {
      // Сначала границы новой зоны, потом мгновенный перенос: иначе clamp
      // старой зоны «дёрнет» предсказание до того, как мы узнаем, куда едем.
      const zone = zoneSummaries.find((candidate) => candidate.id === message.zoneId);
      if (localPlayer) {
        localPlayer.setBounds(zone?.bounds ?? null);
        localPlayer.teleportTo(message.position.x, message.position.z);
      }
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
      if (status === 'closed') hud.addChatLine(null, 'соединение закрыто');
      if (status === 'error') hud.addChatLine(null, `ошибка: ${detail ?? '?'}`);
    },
  };

  // ── подключение ────────────────────────────────────────────────────────

  const account = loadAccount();
  try {
    await connection.connect(
      SERVER_URL,
      {
        protocolVersion: PROTOCOL_VERSION,
        accountId: account.id,
        accountCreatedAt: account.createdAt,
        name: loadName(),
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

  const cameraTarget = new Vector3();
  const cameraPosition = new Vector3();
  const lookDirection = new Vector3();

  function frame(): void {
    requestAnimationFrame(frame);

    const now = performance.now();
    const deltaMs = Math.min(now - lastFrame, 100);
    lastFrame = now;

    // 1. ввод
    const direction = input.moveDirection();
    localPlayer?.setDirection(direction.x, direction.z, input.sprinting);

    // 2. предсказание
    localPlayer?.advance(deltaMs);

    // 3. отправка ввода
    if (localPlayer && connection.connected) {
      inputAccumulator += deltaMs;
      const interval = 1000 / INPUT_RATE;
      if (inputAccumulator >= interval) {
        inputAccumulator = 0;
        connection.sendInput({
          seq: localPlayer.nextSeq(),
          dirX: direction.x,
          dirZ: direction.z,
          yaw: input.yaw,
          sprint: input.sprinting,
        });
      }
    }

    // 4. интерполяция и отрисовка
    const renderTime = now - INTERP_DELAY_MS;
    const snapshot = state.sampleAt(renderTime);

    for (const [id, group] of avatarGroups) {
      if (id === state.localPlayerId) continue;
      const entity = snapshot.get(id);
      if (!entity) continue;
      group.position.set(entity.x, entity.y, entity.z);
      group.rotation.y = entity.yaw;
    }

    // Свой аватар — по предсказанию, а не по интерполированному снимку:
    // снимок отстаёт на INTERP_DELAY_MS, и камера уезжала бы от тела.
    if (localPlayer) {
      const own = avatarGroups.get(state.localPlayerId);
      if (own) {
        own.position.set(localPlayer.x, 0, localPlayer.z);
        own.rotation.y = input.yaw;
      }
    }

    // Камера: вид от третьего лица. Сглаживание — по времени, а не по кадрам,
    // иначе на 144 Гц камера «прилипает» быстрее, чем на 60.
    if (localPlayer) {
      const pitch = input.pitch;
      const yaw = input.yaw;
      lookDirection.set(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      );
      cameraTarget.set(localPlayer.x, 1.4, localPlayer.z);
      cameraPosition.copy(cameraTarget).addScaledVector(lookDirection, -4.2);
      const smoothing = 1 - Math.exp(-deltaMs / 60);
      camera.position.lerp(cameraPosition, smoothing);
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

  window.addEventListener('beforeunload', () => {
    connection.leave();
  });

  frame();
}

void main();
