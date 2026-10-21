/**
 * Сектор (он же «комната» Colyseus) — один шард мира.
 *
 * Обязанности:
 *  - принимать игроков, выдавать им сущность и стартовый снимок;
 *  - интегрировать движение по фиксированному шагу (сервер — источник истины);
 *  - рассылать каждому игроку только то, что попадает в его область интереса;
 *  - принимать и валидировать ввод, чат, запросы зон;
 *  - выдавать genesis-грант через ledger.
 *
 * Чего здесь НЕТ намеренно: PvP, физики, инвентаря, ИИ-агентов.
 * Протокол и сектор разделены: всё, что не касается симуляции, живёт в ядре.
 */

import type { Client } from '@colyseus/core';
import { Room } from '@colyseus/core';

import {
  AOI_RADIUS,
  BIN_CHANNEL,
  C2S,
  CHAT_COOLDOWN_MS,
  CHAT_MESSAGES_PER_SECOND,
  ENTITY_FLAG,
  EntityKind,
  GENESIS_ACCOUNT_MIN_AGE_MS,
  GENESIS_FRESH_ACCOUNT_FACTOR,
  GENESIS_GRANT,
  PLAYER_SPRINT_SPEED,
  PLAYER_SPEED,
  PROTOCOL_VERSION,
  S2C,
  SNAPSHOT_RATE,
  TICK_RATE,
  decodeInput,
  encodeDelta,
  encodeSnapshot,
  isProtocolCompatible,
  type EntityState,
  type HelloMsg,
  type PlayerInfo,
  type WorldDef,
} from '@oasis/protocol';
import {
  chatSchema,
  helloHandshakeSchema,
  helloSchema,
  inputSchema,
  pingSchema,
  zoneRequestSchema,
} from '@oasis/protocol/validation';

import { logInfo, logWarn } from '../config.ts';
import type { Ledger } from '../store/ledger.ts';
import { findZone, zoneAt } from '../world/loadWorld.ts';

interface SessionInput {
  seq: number;
  dirX: number;
  dirZ: number;
  yaw: number;
  sprint: boolean;
}

interface Session {
  client: Client;
  sessionId: string;
  entityId: number;
  name: string;
  accountId: string;
  color: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  moving: boolean;
  sprinting: boolean;
  input: SessionInput | null;
  /** Что клиент уже получил — по этому состоянию считаем диффы. */
  sent: Map<number, EntityState>;
  chatTimestamps: number[];
  balance: number;
  zoneId: string | null;
}

export interface SectorRoomOptions {
  world: WorldDef;
  ledger: Ledger;
  maxPlayers?: number;
}

/** Сколько ждём `hello` после подключения. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

const PLAYER_COLORS = [
  0x4fa3ff, 0xff7a59, 0x6fcf7f, 0xffd166, 0xc792ea, 0x59d4d4, 0xff8fa3, 0x9ad36f,
];

export class SectorRoom extends Room {
  private world!: WorldDef;
  private ledger!: Ledger;
  private maxPlayers = 64;

  private readonly sessions = new Map<string, Session>();
  /** Подключились, но ещё не прислали hello — сущности пока нет. */
  private readonly pending = new Map<string, HelloMsg>();
  private readonly entities = new Map<number, EntityState>();
  private nextEntityId = 1;
  private tick = 0;

  override onCreate(options: SectorRoomOptions): void {
    this.world = options.world;
    this.ledger = options.ledger;
    this.maxPlayers = options.maxPlayers ?? 64;

    this.setFixedTimestep((context) => this.simulate(context.dt), TICK_RATE);
    this.clock.setInterval(() => this.publish(), Math.round(1000 / SNAPSHOT_RATE));

    this.registerHandlers();
  }

  private registerHandlers(): void {
    // ── ввод идёт бинарным: 30 Гц × N игроков — это заметная доля трафика ──
    this.onMessageBytes(BIN_CHANNEL, (client, bytes) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      try {
        const input = decodeInput(bytes);
        session.input = input;
        session.yaw = input.yaw;
      } catch (error) {
        logWarn('бинарный ввод не распознан', { error: String(error) });
      }
    });

    this.onMessage(C2S.Input, inputSchema, (client, message) => {
      // JSON-ввод — запасной путь (например, для отладки и тестов без бинаря).
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      session.input = message;
      session.yaw = message.yaw;
    });

    this.onMessage(C2S.Chat, chatSchema, (client, message) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      if (!this.allowChat(session)) return;

      const text = message.text.trim().slice(0, 240);
      if (!text) return;
      this.broadcast(S2C.Chat, {
        from: session.entityId,
        name: session.name,
        text,
        ts: Date.now(),
      });
    });

    this.onMessage(C2S.ZoneRequest, zoneRequestSchema, (client, message) => {
      const zone = findZone(this.world, message.zoneId);
      if (!zone) {
        client.send(S2C.Error, {
          code: 'NO_ZONE',
          message: `Зона ${message.zoneId} не найдена`,
        });
        return;
      }
      client.send(S2C.Zone, { zone });
    });

    this.onMessage(C2S.Ping, pingSchema, (client, message) => {
      client.send(S2C.Pong, { t: message.t, serverTime: Date.now() });
    });

    this.onMessage(C2S.Hello, helloHandshakeSchema, (client, message) => {
      const hello = this.pending.get(client.sessionId);
      if (!hello) return;
      if (!isProtocolCompatible(message.protocolVersion)) {
        this.pending.delete(client.sessionId);
        client.send(S2C.Error, {
          code: 'PROTOCOL_MISMATCH',
          message: `Ожидался протокол ${PROTOCOL_VERSION}, пришёл ${message.protocolVersion}`,
        });
        client.leave(4001, 'версия протокола');
        return;
      }
      this.pending.delete(client.sessionId);
      void this.activateSession(client, hello);
    });
  }

  /**
   * Вход в комнату — только проверка. Мир отправляется позже, в ответ на
   * сообщение `hello`: Colyseus подтверждает вход (JOIN_ROOM) уже ПОСЛЕ
   * onJoin, поэтому всё, что отправлено здесь, клиент физически не успевает
   * подписать обработчиками. Явный handshake убирает эту гонку.
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const parsed = helloSchema.safeParse(options);
    if (!parsed.success) {
      client.send(S2C.Error, {
        code: 'BAD_HELLO',
        message: 'Некорректные параметры подключения',
      });
      client.leave(4001, 'отказано в подключении');
      return;
    }

    const hello = parsed.data;
    if (!isProtocolCompatible(hello.protocolVersion)) {
      client.send(S2C.Error, {
        code: 'PROTOCOL_MISMATCH',
        message: `Ожидался протокол ${PROTOCOL_VERSION}, пришёл ${hello.protocolVersion}`,
      });
      client.leave(4001, 'отказано в подключении');
      return;
    }

    if (this.sessions.size + this.pending.size >= this.maxPlayers) {
      client.send(S2C.Error, { code: 'SECTOR_FULL', message: 'Сектор заполнен' });
      client.leave(4001, 'отказано в подключении');
      return;
    }

    this.pending.set(client.sessionId, hello);
    // Клиент, который подключился и молчит, не должен занимать место.
    this.clock.setTimeout(() => {
      if (this.pending.delete(client.sessionId)) {
        client.leave(4002, 'handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);
  }

  /** Создаёт игрока и отправляет ему мир. Вызывается после `hello`. */
  private async activateSession(client: Client, hello: HelloMsg): Promise<void> {
    const sector = this.world.sectors[0];
    if (!sector) {
      client.send(S2C.Error, { code: 'NO_SECTOR', message: 'В мире нет ни одного сектора' });
      client.leave(4001, 'нет сектора');
      return;
    }

    const spawn = sector.spawn ?? { x: 0, y: 0, z: 0 };
    const entityId = this.nextEntityId++;
    const color = PLAYER_COLORS[entityId % PLAYER_COLORS.length]!;
    const sessionId = client.sessionId;

    const session: Session = {
      client,
      sessionId,
      entityId,
      name: hello.name,
      accountId: hello.accountId,
      color,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      moving: false,
      sprinting: false,
      input: null,
      sent: new Map(),
      chatTimestamps: [],
      balance: 0,
      zoneId: null,
    };
    this.sessions.set(sessionId, session);

    this.entities.set(entityId, {
      id: entityId,
      kind: EntityKind.Player,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      flags: 0,
      color,
    });

    // Genesis-грант: одноразовый, с пониженной ставкой для свежих аккаунтов.
    session.balance = await this.grantGenesis(hello.accountId, hello.accountCreatedAt);

    client.send(S2C.Welcome, {
      protocolVersion: PROTOCOL_VERSION,
      playerId: entityId,
      sessionId,
      world: {
        id: this.world.id,
        version: this.world.version,
        seed: this.world.seed,
        generator: this.world.generator,
        sectors: this.world.sectors,
        zones: this.world.zones.map((zone) => ({
          id: zone.id,
          sectorId: zone.sectorId,
          name: zone.name,
          kind: zone.kind,
          bounds: zone.bounds,
          groundColor: zone.groundColor,
        })),
        portals: this.world.portals,
      },
      sectorId: sector.id,
      tickRate: TICK_RATE,
      snapshotRate: SNAPSHOT_RATE,
      aoiRadius: AOI_RADIUS,
      spawn,
      balance: session.balance,
    });
    client.send(S2C.Balance, { balance: session.balance, reason: 'genesis' });

    this.broadcastRoster();
    this.sendSnapshot(session);

    logInfo(`игрок ${hello.name} вошёл в сектор ${sector.id}`, {
      players: this.sessions.size,
    });
  }

  override async onLeave(client: Client): Promise<void> {
    this.pending.delete(client.sessionId);
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    this.sessions.delete(client.sessionId);
    this.entities.delete(session.entityId);
    this.broadcastRoster();
    logInfo(`игрок ${session.name} вышел`, { players: this.sessions.size });
  }

  override onDispose(): void {
    logInfo('сектор закрыт', { players: this.sessions.size });
  }

  // ────────────────────────────────────────────────────── симуляция ────────

  private simulate(dt: number): void {
    this.tick += 1;

    for (const session of this.sessions.values()) {
      const input = session.input;
      if (!input) continue;

      let dirX = input.dirX;
      let dirZ = input.dirZ;
      const length = Math.hypot(dirX, dirZ);
      if (length > 1) {
        dirX /= length;
        dirZ /= length;
      }

      const moving = length > 0.01;
      session.moving = moving;
      session.sprinting = moving && input.sprint;

      if (moving) {
        const speed = input.sprint ? PLAYER_SPRINT_SPEED : PLAYER_SPEED;
        session.x += dirX * speed * dt;
        session.z += dirZ * speed * dt;
      }

      this.clampToZone(session);
      this.checkPortal(session);

      const entity = this.entities.get(session.entityId);
      if (entity) {
        entity.x = session.x;
        entity.y = session.y;
        entity.z = session.z;
        entity.yaw = input.yaw;
        entity.flags =
          (moving ? ENTITY_FLAG.Moving : 0) |
          (session.sprinting ? ENTITY_FLAG.Sprinting : 0);
      }
    }
  }

  /** Игрок не может выйти за пределы зоны сектора. */
  private clampToZone(session: Session): void {
    const zone = zoneAt(this.world, session.x, session.z);
    if (!zone) return;
    const halfW = zone.bounds.w / 2;
    const halfD = zone.bounds.d / 2;
    session.x = Math.min(Math.max(session.x, zone.bounds.x - halfW), zone.bounds.x + halfW);
    session.z = Math.min(Math.max(session.z, zone.bounds.z - halfD), zone.bounds.z + halfD);
    session.zoneId = zone.id;
  }

  /** Портал переносит игрока в соседнюю зону. Решение принимает сервер. */
  private checkPortal(session: Session): void {
    const fromZone = session.zoneId;
    if (!fromZone) return;

    const portal = this.world.portals.find(
      (candidate) =>
        candidate.fromZone === fromZone &&
        Math.hypot(session.x - candidate.x, session.z - candidate.z) < candidate.radius,
    );
    if (!portal) return;

    const destination = this.world.portals.find(
      (candidate) =>
        candidate.fromZone === portal.toZone && candidate.toZone === portal.fromZone,
    );
    const target = destination ?? portal;

    session.x = target.x;
    session.z = target.z;
    session.zoneId = portal.toZone;

    session.client.send(S2C.Teleport, {
      zoneId: portal.toZone,
      position: { x: session.x, y: session.y, z: session.z },
    });
  }

  // ────────────────────────────────────────────────── рассылка состояния ───

  private visibleEntities(session: Session): EntityState[] {
    const result: EntityState[] = [];
    for (const entity of this.entities.values()) {
      if (entity.id === session.entityId) continue;
      const dx = entity.x - session.x;
      const dz = entity.z - session.z;
      if (dx * dx + dz * dz <= AOI_RADIUS * AOI_RADIUS) result.push(entity);
    }
    // Собственная сущность всегда «в кадре».
    const own = this.entities.get(session.entityId);
    if (own) result.push(own);
    return result;
  }

  private publish(): void {
    for (const session of this.sessions.values()) {
      const visible = this.visibleEntities(session);
      const changed: EntityState[] = [];
      const removed: number[] = [];
      const seen = new Set<number>();

      for (const entity of visible) {
        seen.add(entity.id);
        const previous = session.sent.get(entity.id);
        if (!previous || !sameState(previous, entity)) {
          changed.push({ ...entity });
        }
      }
      for (const id of session.sent.keys()) {
        if (!seen.has(id)) removed.push(id);
      }
      if (changed.length === 0 && removed.length === 0) continue;

      for (const id of removed) session.sent.delete(id);
      for (const entity of changed) session.sent.set(entity.id, { ...entity });

      session.client.sendBytes(BIN_CHANNEL, encodeDelta(this.tick, changed, removed));
    }
  }

  private sendSnapshot(session: Session): void {
    const visible = this.visibleEntities(session);
    session.sent.clear();
    for (const entity of visible) session.sent.set(entity.id, { ...entity });
    session.client.sendBytes(BIN_CHANNEL, encodeSnapshot(this.tick, visible));
  }

  private broadcastRoster(): void {
    const players: PlayerInfo[] = [...this.sessions.values()].map((session) => ({
      id: session.entityId,
      name: session.name,
      color: session.color,
    }));
    this.broadcast(S2C.Roster, { players });
  }

  // ────────────────────────────────────────────────────────── экономика ────

  private async grantGenesis(accountId: string, accountCreatedAt: number): Promise<number> {
    const already = await this.ledger.hasEntry(this.world.id, accountId, 'genesis');
    if (already) return this.ledger.balanceOf(accountId);

    const age = Date.now() - accountCreatedAt;
    const isFresh = age < GENESIS_ACCOUNT_MIN_AGE_MS;
    const amount = isFresh
      ? Math.round(GENESIS_GRANT * GENESIS_FRESH_ACCOUNT_FACTOR)
      : GENESIS_GRANT;

    await this.ledger.append({
      worldId: this.world.id,
      accountId,
      kind: 'genesis',
      amount,
      reason: isFresh ? 'genesis:fresh' : 'genesis',
      meta: { accountAgeMs: age },
    });
    return this.ledger.balanceOf(accountId);
  }

  // ───────────────────────────────────────────────────────────── чат ───────

  private allowChat(session: Session): boolean {
    const now = Date.now();
    session.chatTimestamps = session.chatTimestamps.filter(
      (timestamp) => now - timestamp < 1000,
    );
    if (session.chatTimestamps.length >= CHAT_MESSAGES_PER_SECOND) return false;
    const last = session.chatTimestamps[session.chatTimestamps.length - 1];
    if (last !== undefined && now - last < CHAT_COOLDOWN_MS) return false;
    session.chatTimestamps.push(now);
    return true;
  }
}

function sameState(a: EntityState, b: EntityState): boolean {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.z - b.z) < 0.001 &&
    Math.abs(a.yaw - b.yaw) < 0.01 &&
    a.flags === b.flags &&
    a.color === b.color
  );
}
