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
  PROTOCOL_VERSION,
  S2C,
  SNAPSHOT_RATE,
  TICK_RATE,
  decodeInput,
  encodeDelta,
  encodeSnapshot,
  isProtocolCompatible,
  speedOf,
  stepVelocity,
  type EntityState,
  type HelloMsg,
  type PlayerInfo,
  type WelcomeMsg,
  type WorldDef,
} from '@oasis/protocol';
import {
  chatSchema,
  helloHandshakeSchema,
  helloSchema,
  inputSchema,
  pingSchema,
  renameSchema,
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
  /** Кешируем welcome, чтобы при переименовании сразу переслать свежий. */
  welcome?: WelcomeMsg;
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
  /** До какого момента порталы игнорируются (после телепорта). */
  teleportUntil: number;
  /** Скорость в м/с: разгон и торможение живут на сервере, клиент их повторяет. */
  vx: number;
  vz: number;
  /** Когда пришёл последний ввод — по нему считаем TTL. */
  lastInputAt: number;
  lastZoneRequestAt: number;
  lastChatErrorAt: number;
}

export interface SectorRoomOptions {
  world: WorldDef;
  ledger: Ledger;
  maxPlayers?: number;
}

/** Сколько ждём `hello` после подключения. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Пауза после телепорта: без неё игрок пинг-понгом летает между зонами. */
const PORTAL_COOLDOWN_MS = 1_200;
/** Ввод считается протухшим: клиент, переставший слать пакеты, должен замереть. */
const INPUT_TTL_MS = 1_000;
/** Не чаще одного запроса зоны в 250 мс (зона весит десятки килобайт JSON). */
const ZONE_REQUEST_COOLDOWN_MS = 250;
/** Радиус кольца спавна: игроки не появляются друг в друге. */
const SPAWN_RADIUS = 1.2;

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
  /**
   * Выдача genesis в процессе. Две вкладки одного аккаунта одновременно —
   * обычное дело, и без этой карты обе успевают увидеть «проводки нет».
   */
  private readonly genesisInFlight = new Map<string, Promise<number>>();
  private readonly entities = new Map<number, EntityState>();
  private nextEntityId = 1;
  private tick = 0;

  override onCreate(options: SectorRoomOptions): void {
    this.world = options.world;
    this.ledger = options.ledger;
    this.maxPlayers = options.maxPlayers ?? 64;
    // Matchmaking должен отказывать сам, а не пускать и потом выкидывать.
    this.maxClients = this.maxPlayers;

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
        session.lastInputAt = Date.now();
      } catch (error) {
        logWarn('бинарный ввод не распознан', {
          bytes: bytes.byteLength,
          error: String(error),
        });
      }
    });

    this.onMessage(C2S.Input, inputSchema, (client, message) => {
      // JSON-ввод — запасной путь (например, для отладки и тестов без бинаря).
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      session.input = message;
      session.yaw = message.yaw;
      session.lastInputAt = Date.now();
    });

    this.onMessage(C2S.Chat, chatSchema, (client, message) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      if (!this.allowChat(session)) {
        // Раньше сообщение молча терялось. Теперь клиент знает, почему.
        const now = Date.now();
        if (now - session.lastChatErrorAt > 1_000) {
          session.lastChatErrorAt = now;
          client.send(S2C.Error, {
            code: 'CHAT_TOO_FAST',
            message: 'Слишком часто. Подождите немного.',
          });
        }
        return;
      }

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
      const session = this.sessions.get(client.sessionId);
      if (session) {
        const now = Date.now();
        if (now - session.lastZoneRequestAt < ZONE_REQUEST_COOLDOWN_MS) return;
        session.lastZoneRequestAt = now;
      }
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

    this.onMessage(C2S.Rename, renameSchema, (client, message) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      const base = sanitizeName(message.name);
      const next = this.uniqueName(base, session);
      // Уникализация учитывает и своё текущее имя. Если игрок выбрал то же
      // самое — ничего не меняем.
      if (next === session.name) return;
      session.name = next;
      if (session.welcome) session.welcome.name = next;
      // Правило сервера: ник — не то, что игрок попросил, а то, что выдано.
      // Клиент показывает именно `name` из ответа.
      client.send(S2C.Renamed, { name: next });
      this.broadcastRoster();
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
      // Без catch любая ошибка ledger (например, обрыв Postgres) станет
      // unhandled rejection и уронит процесс, а не одного игрока.
      void this.activateSession(client, hello).catch((error: unknown) => {
        logWarn('не удалось активировать сессию', { error: String(error) });
        client.send(S2C.Error, {
          code: 'INTERNAL',
          message: 'Не удалось войти в мир. Попробуйте ещё раз.',
        });
        client.leave(1011, 'internal error');
      });
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

    // Имя должно быть уникальным внутри сектора: игрок опознаёт других
    // только по нему. Две вкладки одного браузера делят localStorage и
    // присылают одинаковый ник — сервер разводит их суффиксом. Суффикс
    // считается до спавна: точка спавна зависит от итогового имени.
    const name = this.uniqueName(sanitizeName(hello.name));

    // Детерминированный спавн: одинаковое имя — одинаковая точка. Иначе
    // тесты и зонды зависят от порядка подключения, а игроки в центре
    // площади толпятся там, где и так тесно.
    const spawn = spawnPoint(
      sector.spawn ?? { x: 0, y: 0, z: 0 },
      hashSeed(`${this.world.id}:${name}`),
    );
    const entityId = this.nextEntityId++;
    const color = PLAYER_COLORS[entityId % PLAYER_COLORS.length]!;
    const sessionId = client.sessionId;

    const session: Session = {
      client,
      sessionId,
      entityId,
      name,
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
      vx: 0,
      vz: 0,
      teleportUntil: 0,
      lastInputAt: 0,
      lastZoneRequestAt: 0,
      lastChatErrorAt: 0,
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

    const welcome: WelcomeMsg = {
      protocolVersion: PROTOCOL_VERSION,
      playerId: entityId,
      name,
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
    };
    session.welcome = welcome;
    client.send(S2C.Welcome, welcome);
    client.send(S2C.Balance, { balance: session.balance, reason: 'genesis' });

    this.broadcastRoster();
    this.sendSnapshot(session);

    logInfo(`игрок ${name} вошёл в сектор ${sector.id}`, {
      players: this.sessions.size,
    });
  }

  override async onLeave(client: Client): Promise<void> {
    this.pending.delete(client.sessionId);
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    this.sessions.delete(client.sessionId);
    this.entities.delete(session.entityId);
    this.genesisInFlight.delete(session.accountId);
    this.broadcastRoster();
    logInfo(`игрок ${session.name} вышел`, { players: this.sessions.size });
  }

  override onDispose(): void {
    logInfo('сектор закрыт', { players: this.sessions.size });
  }

  // ────────────────────────────────────────────────────── симуляция ────────

  private simulate(dt: number): void {
    this.tick += 1;

    const now = Date.now();
    for (const session of this.sessions.values()) {
      let input = session.input;

      // Клиент замолчал (обрыв, вкладка в фоне) — не тащим его вперёд
      // последним нажатием до бесконечности.
      if (input && now - session.lastInputAt > INPUT_TTL_MS) {
        input = null;
        session.input = null;
      }

      const dirX = input?.dirX ?? 0;
      const dirZ = input?.dirZ ?? 0;
      const sprint = input?.sprint ?? false;

      const velocity = stepVelocity(session.vx, session.vz, dirX, dirZ, sprint, dt);
      session.vx = velocity.vx;
      session.vz = velocity.vz;

      session.x += session.vx * dt;
      session.z += session.vz * dt;
      if (input) session.yaw = input.yaw;

      // Зона и порталы проверяются всегда, даже без ввода: игрок может
      // стоять внутри портала, а после телепорта его позицию нужно
      // разослать, не дожидаясь следующего нажатия.
      const beforeX = session.x;
      const beforeZ = session.z;
      this.clampToZone(session);
      // Упёрлись в границу — гасим скорость в эту сторону, иначе игрок
      // продолжает «давить» в стену и после отпускания клавиши.
      if (session.x !== beforeX) session.vx = 0;
      if (session.z !== beforeZ) session.vz = 0;

      this.checkPortal(session);

      const speed = speedOf(session.vx, session.vz);
      session.moving = speed > 0.2;
      session.sprinting = session.moving && sprint;

      const entity = this.entities.get(session.entityId);
      if (entity) {
        entity.x = session.x;
        entity.y = session.y;
        entity.z = session.z;
        entity.yaw = session.yaw;
        entity.flags =
          (session.moving ? ENTITY_FLAG.Moving : 0) |
          (session.sprinting ? ENTITY_FLAG.Sprinting : 0);
      }
    }
  }

  /**
   * Делает имя уникальным внутри сектора: `гость` → `гость (2)`.
   *
   * Сравнение без учёта регистра — иначе `Гость` и `гость` стоят рядом и
   * путаница та же. Суффикс уходит в обычный текст, так что длина имени
   * может слегка превысить лимит 24 знака: это дешевле, чем обрезать
   * суффикс и снова получить дубль.
   *
   * `exclude` — сессия, чьё имя не считать занятым. Без него игрок,
   * попросивший своё же имя, получил бы `имя (2)`.
   */
  private uniqueName(base: string, exclude?: Session): string {
    const taken = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session === exclude) continue;
      taken.add(session.name.toLowerCase());
    }
    if (!taken.has(base.toLowerCase())) return base;

    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${base} (${suffix})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${base} ${Date.now().toString(36)}`;
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
    const now = Date.now();
    if (now < session.teleportUntil) return;

    const fromZone = session.zoneId;
    if (!fromZone) return;

    const portal = this.world.portals.find(
      (candidate) =>
        candidate.fromZone === fromZone &&
        Math.hypot(session.x - candidate.x, session.z - candidate.z) < candidate.radius,
    );
    if (!portal) return;

    const target = this.world.portals.find(
      (candidate) =>
        candidate.fromZone === portal.toZone && candidate.toZone === portal.fromZone,
    );

    let x = target?.x ?? portal.x;
    let z = target?.z ?? portal.z;

    // Прибывать в центр обратного портала нельзя: на следующем тике игрок
    // снова окажется внутри радиуса и улетит назад. Ставим его на шаг
    // в сторону центра целевой зоны — то есть «за порогом» портала.
    const destination = findZone(this.world, portal.toZone);
    if (destination) {
      const dx = destination.bounds.x - x;
      const dz = destination.bounds.z - z;
      const length = Math.hypot(dx, dz);
      const step = (target?.radius ?? portal.radius) + 1.5;
      if (length > 0.001) {
        x += (dx / length) * step;
        z += (dz / length) * step;
      }
    }

    session.x = x;
    session.z = z;
    session.zoneId = portal.toZone;
    session.teleportUntil = now + PORTAL_COOLDOWN_MS;

    session.client.send(S2C.Teleport, {
      zoneId: portal.toZone,
      position: { x: session.x, y: session.y, z: session.z },
    });
  }

  // ────────────────────────────────────────────────── рассылка состояния ───

  /**
   * Кто попадает в «поле зрения» игрока.
   *
   * Простой радиус тут недостаточно: две соседние зоны могут стоять ближе
   * AOI_RADIUS, и тогда игроки видят друг друга сквозь границу зоны — то
   * есть сквозь стену. Поэтому зона — жёсткое условие, радиус — только
   * второе. Видимость внутри одной зоны сквозь препятствие (колонну,
   * дерево) этим не решается: там нужен occlusion-рейкаст на каждый тик,
   * это отдельная задача F1.
   */
  private visibleEntities(session: Session): EntityState[] {
    const result: EntityState[] = [];
    for (const other of this.sessions.values()) {
      if (other.entityId === session.entityId) continue;
      if (other.zoneId !== session.zoneId) continue;

      const dx = other.x - session.x;
      const dz = other.z - session.z;
      if (dx * dx + dz * dz > AOI_RADIUS * AOI_RADIUS) continue;

      const entity = this.entities.get(other.entityId);
      if (entity) result.push(entity);
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

  private grantGenesis(accountId: string, accountCreatedAt: number): Promise<number> {
    const inFlight = this.genesisInFlight.get(accountId);
    if (inFlight) return inFlight;

    const task = this.doGrantGenesis(accountId, accountCreatedAt).finally(() => {
      this.genesisInFlight.delete(accountId);
    });
    this.genesisInFlight.set(accountId, task);
    return task;
  }

  private async doGrantGenesis(accountId: string, accountCreatedAt: number): Promise<number> {
    // Валюта глобальная (см. docs/10), поэтому и грант — один на аккаунт,
    // а не на мир. Иначе каждый новый мир печатал бы ещё 100 ¤.
    const already = await this.ledger.hasEntry(accountId, 'genesis');
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

/** Имя — текст, который увидят другие. Убираем управляющие символы и мусор. */
function sanitizeName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'безымянный';
}

/** FNV-1a: быстрый детерминированный сид из строки. */
function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Точка спавна со сдвигом по «золотому углу». Без него все появляются
 * в одной точке и стоят друг в друге. Сид берётся из имени, поэтому
 * один и тот же игрок всегда появляется в одном месте.
 */
function spawnPoint(base: { x: number; y: number; z: number }, seed: number): {
  x: number;
  y: number;
  z: number;
} {
  if (seed === 0) return base;
  const angle = seed * 2.399963;
  const radius = SPAWN_RADIUS * Math.sqrt(1 + (seed % 8));
  return {
    x: base.x + Math.cos(angle) * radius,
    y: base.y,
    z: base.z + Math.sin(angle) * radius,
  };
}
