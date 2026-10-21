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
  type EntityState,
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
import { createAvatar, createNameTag } from './render/avatars.ts';
import { createRenderer } from './render/Renderer.ts';
import { buildPortal, buildZone, disposeGroup } from './render/world.ts';
import { Hud } from './ui/Hud.ts';

const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `ws://${window.location.hostname}:2567`;

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

  const zoneGroups = new Map<string, Group>();
  const avatarGroups = new Map<number, Group>();
  const sceneRoot = new Group();
  scene.add(sceneRoot);

  const hud = new Hud({
    onChat: (text) => connection.sendChat(text),
    onChatFocusChange: () => {
      /* курсор живёт сам */
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
        const own = state.latest(state.localPlayerId);
        if (own) {
          const at = zoneAt(own.x, own.z);
          if (at?.id === zone.id) localPlayer.setBounds(zone.bounds);
        }
      }
    },

    onTeleport(message: TeleportMsg): void {
      const zone = zoneSummaries.find((candidate) => candidate.id === message.zoneId);
      if (zone && localPlayer) localPlayer.setBounds(zone.bounds);
      requestZone(message.zoneId);
      hud.addChatLine(null, `переход в зону ${message.zoneId}`);
    },

    onBalance(message: { balance: number; reason: string }): void {
      balance = message.balance;
    },

    onBinary(payload: Uint8Array): void {
      const now = performance.now();
      if (payload.byteLength === 0) return;
      const type = payload[0];
      if (type === BIN.Snapshot) {
        const decoded = decodeSnapshot(payload);
        state.applySnapshot(decoded.entities, decoded.tick, now);
      } else if (type === BIN.Delta) {
        const decoded = decodeDelta(payload);
        state.applyDelta(decoded.changed, decoded.removed, decoded.tick, now);
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
      hud.focusChat();
    }
  });

  // ── аватары ────────────────────────────────────────────────────────────

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
      }
    }
    for (const [id, group] of avatarGroups) {
      if (state.roster.has(id)) continue;
      disposeGroup(group);
      avatarGroups.delete(id);
    }
  }

  const rosterObserver = setInterval(syncAvatars, 400);

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

    // 4. сверка с сервером
    const ownAuthoritative = state.latest(state.localPlayerId);
    if (ownAuthoritative && localPlayer) localPlayer.reconcile(ownAuthoritative);

    // 5. интерполяция и отрисовка
    const renderTime = now - INTERP_DELAY_MS;
    const snapshot = state.sampleAt(renderTime);

    for (const [id, group] of avatarGroups) {
      const entity = snapshot.get(id);
      if (!entity) continue;
      group.position.set(entity.x, entity.y, entity.z);
      group.rotation.y = entity.yaw;
    }

    updateLocalAvatar(snapshot.get(state.localPlayerId));

    // Камера: вид от третьего лица.
    if (localPlayer) {
      const pitch = input.pitch;
      const yaw = input.yaw;
      lookDirection.set(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch),
      );
      cameraTarget.set(localPlayer.renderX, 1.4, localPlayer.renderZ);
      cameraPosition.copy(cameraTarget).addScaledVector(lookDirection, -4.2);
      camera.position.lerp(cameraPosition, 0.25);
      camera.lookAt(cameraTarget);
    }

    renderer.render(scene, camera);

    // 6. статистика и пинг
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

  function updateLocalAvatar(entity: EntityState | undefined): void {
    const group = avatarGroups.get(state.localPlayerId);
    if (!group) return;
    if (entity) {
      group.position.set(entity.x, entity.y, entity.z);
      group.rotation.y = entity.yaw;
    } else if (localPlayer) {
      group.position.set(localPlayer.renderX, 0, localPlayer.renderZ);
      group.rotation.y = input.yaw;
    }
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(rosterObserver);
    connection.leave();
  });

  frame();
}

void main();
