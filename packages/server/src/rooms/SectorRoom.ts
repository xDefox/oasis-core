/**
 * Сектор (он же «комната» Colyseus) — один шард мира.
 *
 * Обязанности:
 *  - принимать игроков, выдавать им сущность и стартовый снимок;
 *  - интегрировать движение по фиксированному шагу (сервер — источник истины);
 *  - рассылать каждому игроку только то, что попадает в его область интереса;
 *  - принимать и валидировать ввод, чат, запросы зон, команды `/gather`;
 *  - выдавать genesis-грант и начислять добычу через ledger.
 *
 * Чего здесь НЕТ намеренно: PvP, физики, инвентаря, ИИ-агентов.
 * Протокол и сектор разделены: всё, что не касается симуляции, живёт в ядре.
 */

import { randomUUID } from 'node:crypto';

import type { AuthContext, Client } from '@colyseus/core';
import { Room } from '@colyseus/core';

import { readSessionFromCookieHeader } from '../auth/session.ts';

import {
  AOI_RADIUS,
  BIN_CHANNEL,
  C2S,
  CHAT_COOLDOWN_MS,
  CHAT_MESSAGES_PER_SECOND,
  ENTITY_FLAG,
  EntityKind,
  GATHER_DAILY_CAP,
  GATHER_RADIUS,
  GATHER_REWARD,
  GENESIS_ACCOUNT_MIN_AGE_MS,
  GENESIS_FRESH_ACCOUNT_FACTOR,
  GENESIS_GRANT,
  GROUND_Y,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  S2C,
  SNAPSHOT_RATE,
  TICK_RATE,
  buildZoneColliders,
  clampToBounds,
  decodeInput,
  encodeDelta,
  encodeSnapshot,
  isProtocolCompatible,
  resolvePlayerMove,
  speedOf,
  stepVelocity,
  stepVertical,
  supportHeightAt,
  type EntityState,
  type HelloMsg,
  type PlayerInfo,
  type WelcomeMsg,
  type WorldDef,
  type ZoneColliders,
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

import { parseCommand, type ParsedCommand } from '../chat/commands.ts';

import { logInfo, logWarn } from '../config.ts';
import type { Ledger } from '../store/ledger.ts';
import { findZone, zoneAt } from '../world/loadWorld.ts';
import { findResourceNear, GatherTracker } from '../world/resources.ts';
import { spawnPoint } from '../world/spawnPoint.ts';

interface SessionInput {
  seq: number;
  dirX: number;
  dirZ: number;
  yaw: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
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
  crouching: boolean;
  airborne: boolean;
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
  vy: number;
  vz: number;
  /** Когда пришёл последний ввод — по нему считаем TTL. */
  lastInputAt: number;
  lastZoneRequestAt: number;
  lastChatErrorAt: number;
  /** Токен, по которому игрок возвращается на это место. */
  resumeToken: string;
  /** Когда пропала связь; null — игрок на связи. */
  disconnectedAt: number | null;
}

export interface SectorRoomOptions {
  world: WorldDef;
  ledger: Ledger;
  maxPlayers?: number;
  /** Сколько держать место после обрыва. В тестах уменьшают, чтобы не ждать. */
  resumeGraceMs?: number;
}

/** Сколько ждём `hello` после подключения. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Пауза после телепорта: без неё игрок пинг-понгом летает между зонами. */
const PORTAL_COOLDOWN_MS = 1_200;
/** Ввод считается протухшим: клиент, переставший слать пакеты, должен замереть. */
const INPUT_TTL_MS = 1_000;
/** Не чаще одного запроса зоны в 250 мс (зона весит десятки килобайт JSON). */
const ZONE_REQUEST_COOLDOWN_MS = 250;
/**
 * Сколько живёт комната без единого игрока.
 *
 * `autoDispose` выключен: иначе последний ушедший игрок уносит с собой и своё
 * зарезервированное место — то есть ровно тот случай, который нужно
 * пережить (единственный игрок перезагружает страницу). Пустая комната
 * закрывается сама через этот таймаут.
 */
const ROOM_IDLE_MS = 10_000;
/**
 * Сколько место держится за игроком после обрыва связи.
 *
 * 30 с — это «перезагрузил страницу», «уснул ноутбук», «прыгнул Wi-Fi».
 * Дольше держать нельзя: ник и место заняты, а человек может и не вернуться.
 */
const DEFAULT_RESUME_GRACE_MS = 30_000;

const PLAYER_COLORS = [
  0x4fa3ff, 0xff7a59, 0x6fcf7f, 0xffd166, 0xc792ea, 0x59d4d4, 0xff8fa3, 0x9ad36f,
];

/**
 * Живые экземпляры сектора на этом процессе.
 *
 * Colyseus отдаёт снаружи только кеш matchmaker'а (`IRoomCache` — id, счётчики,
 * метаданные), а тестовому хуку нужен сам объект комнаты: позиции игроков
 * живут в нём. Комната пополняет реестр сама — onCreate добавляет,
 * onDispose убирает.
 */
const liveRooms = new Set<SectorRoom>();

/** Живые секторы (обычно один) — для HTTP-хука `POST /debug/move`. */
export const sectorRooms = (): SectorRoom[] => [...liveRooms];

export class SectorRoom extends Room {
  private world!: WorldDef;
  private ledger!: Ledger;
  private maxPlayers = 64;

  private readonly sessions = new Map<string, Session>();
  /**
   * Места, которые держим за игроком после обрыва: токен → сессия.
   * Пока место здесь, ник занят, тело стоит в мире, ввод не читается.
   */
  private readonly resumeTokens = new Map<string, Session>();
  private resumeGraceMs = DEFAULT_RESUME_GRACE_MS;
  /** Подключились, но ещё не прислали hello — сущности пока нет. */
  private readonly pending = new Map<string, HelloMsg>();
  /**
   * Выдача genesis в процессе. Две вкладки одного аккаунта одновременно —
   * обычное дело, и без этой карты обе успевают увидеть «проводки нет».
   */
  private readonly genesisInFlight = new Map<string, Promise<number>>();
  /** Кулдауны слизней и суточный кап добычи — по F1-21. */
  private readonly gather = new GatherTracker();
  private readonly entities = new Map<number, EntityState>();
  /** Коллайдеры пропов по зонам — собираются один раз при создании комнаты. */
  private readonly zoneColliders = new Map<string, ZoneColliders>();
  private nextEntityId = 1;
  private tick = 0;
  /** С какого момента в комнате нет ни одного игрока. */
  private idleSince: number | null = null;

  // ── метрики для F0-10/F0-11 ──────────────────────────────────────────
  private tickDurations: number[] = [];
  private bytesOutTotal = 0;
  private bytesOutWindow: number[] = [];
  private lastByteWindowAt = Date.now();
  private readonly maxTickDurations = 2000;

  /**
   * Auth-lite: берём accountId из подписанной cookie, игнорируем то, что
   * прислано в теле hello. F0-6 закрывает D-009.
   *
   * Где живёт cookie в проде: браузер шлёт её с HTTP-запросом матчмейкина
   * и апгрейда вебсокета, но для JS она закрыта (HttpOnly), поэтому в
   * `options` её нет по определению. Colyseus отдаёт эти заголовки третьим
   * аргументом — `AuthContext.headers`. Без чтения оттуда подписанная кука
   * в проде не читается вовсе и защита существовала бы только на бумаге.
   *
   * В тестах и локальной разработке без cookie разрешаем проход (fallback),
   * чтобы не ломать существующие тесты и прямые подключения SDK.
   */
  override async onAuth(_client: Client, options: any, context?: AuthContext): Promise<any> {
    const cookieHeader =
      options?.cookie ??
      options?.headers?.cookie ??
      options?.headers?.Cookie ??
      (options as any)?.['httpHeaders']?.cookie ??
      (options as any)?.rawHeaders?.cookie ??
      cookieFromContext(context);
    const session = readSessionFromCookieHeader(cookieHeader);
    if (session) return { accountId: session.accountId, issuedAt: session.issuedAt };
    // В prod без валидной cookie — отказ: accountId от клиента не верим (D-009).
    if (process.env.NODE_ENV === 'production') return false;
    // Fallback для dev/tests: используем accountId из options, если передан
    const accountId = options?.accountId;
    const issuedAt = options?.accountCreatedAt ?? options?.issuedAt;
    if (typeof accountId === 'string' && accountId.length >= 8) {
      return { accountId, issuedAt: typeof issuedAt === 'number' ? issuedAt : Date.now() };
    }
    return { accountId: `acct_dev_${Date.now().toString(36)}`, issuedAt: Date.now() };
  }

  override onCreate(options: SectorRoomOptions): void {
    liveRooms.add(this);
    this.world = options.world;
    this.ledger = options.ledger;
    this.maxPlayers = options.maxPlayers ?? 64;
    this.resumeGraceMs = options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS;
    // Matchmaking должен отказывать сам, а не пускать и потом выкидывать.
    this.maxClients = this.maxPlayers;
    // Пустая комната не должна исчезать мгновенно: в ней может остаться
    // место, зарезервированное за игроком, который вот-вот вернётся.
    this.autoDispose = false;
    this.idleSince = null;

    this.zoneColliders.clear();
    for (const zone of this.world.zones) {
      this.zoneColliders.set(zone.id, buildZoneColliders(zone));
    }

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
      session.input = {
        seq: message.seq,
        dirX: message.dirX,
        dirZ: message.dirZ,
        yaw: message.yaw,
        sprint: message.sprint,
        crouch: message.crouch ?? false,
        jump: message.jump ?? false,
      };
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

      // Команда — это действие, а не реплика: в общий чат она не попадает.
      const command = parseCommand(text);
      if (command) {
        this.runCommand(client, session, command);
        return;
      }

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
    let hello: any;
    if (parsed.success) {
      hello = parsed.data;
    } else {
      // Fallback для ботов/тестов
      const o: any = options || {};
      if (o.protocolVersion && o.accountId && o.name) {
        hello = {
          protocolVersion: String(o.protocolVersion),
          accountId: String(o.accountId),
          accountCreatedAt: Number(o.accountCreatedAt) || Date.now(),
          name: String(o.name),
        };
      } else {
        client.send(S2C.Error, {
          code: 'BAD_HELLO',
          message: 'Некорректные параметры подключения',
        });
        client.leave(4001, 'отказано в подключении');
        return;
      }
    }
    if (!isProtocolCompatible(hello.protocolVersion)) {
      client.send(S2C.Error, {
        code: 'PROTOCOL_MISMATCH',
        message: `Ожидался протокол ${PROTOCOL_VERSION}, пришёл ${hello.protocolVersion}`,
      });
      client.leave(4001, 'отказано в подключении');
      return;
    }

    // Возвращающийся игрок занимает своё же место: место уже посчитано в
    // sessions, и отказ «сектор заполнен» был бы издевательством.
    const returning = hello.resume !== undefined && this.resumeTokens.has(hello.resume);
    if (!returning && this.sessions.size + this.pending.size >= this.maxPlayers) {
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
    // Возврат на прежнее место — до всего остального: спавн, цвет и ник
    // восстанавливаются из сессии, а не выдаются заново.
    if (this.resume(client, hello)) return;

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
    // F0-6/F0-7: accountId и accountCreatedAt берём из серверной сессии,
    // игнорируем client-supplied. D-009 закрыт.
    const auth = (client.auth ?? {}) as { accountId?: string; issuedAt?: number };
    const hasServerAuth = typeof auth.accountId === 'string';
    const accountId: string = (hasServerAuth ? auth.accountId : hello.accountId) ?? `acct_fallback_${client.sessionId}`;
    const accountCreatedAt: number =
      hasServerAuth && typeof auth.issuedAt === 'number' ? auth.issuedAt : hello.accountCreatedAt;

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
      accountId,
      color,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      moving: false,
      sprinting: false,
      crouching: false,
      airborne: false,
      input: null,
      sent: new Map(),
      chatTimestamps: [],
      balance: 0,
      zoneId: null,
      vx: 0,
      vy: 0,
      vz: 0,
      teleportUntil: 0,
      lastInputAt: 0,
      lastZoneRequestAt: 0,
      lastChatErrorAt: 0,
      resumeToken: randomUUID(),
      disconnectedAt: null,
    };
    this.sessions.set(sessionId, session);
    // Токен живёт в реестре всё время, пока место существует: иначе по нему
    // нельзя было бы забрать место у ещё не признанного мёртвым сокета
    // (сон/пробуждение, гонка при перезагрузке страницы).
    this.resumeTokens.set(session.resumeToken, session);

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
    // F0-6/F0-7: accountCreatedAt берём из подписанной сессии.
    session.balance = await this.grantGenesis(accountId, accountCreatedAt);

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
      resumeToken: session.resumeToken,
      resumed: false,
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

  /**
   * Связь пропала без согласия клиента: обрыв, спящий ноутбук, краш вкладки.
   *
   * Место не отдаём сразу. Игрок вернётся (по токену или тем же аккаунтом)
   * и окажется там, где пропал. Всё это время тело стоит на месте: для
   * остальных он «замер», а не исчез, и ник остаётся занятым.
   */
  override onDrop(client: Client): void {
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    this.freeze(session);
    logInfo(
      `связь с ${session.name} потеряна, место держим ${Math.round(this.resumeGraceMs / 1000)} с`,
      { players: this.sessions.size },
    );
  }

  override onLeave(client: Client): void {
    this.pending.delete(client.sessionId);
    const session = this.sessions.get(client.sessionId);
    if (!session) return;
    // После onDrop Colyseus вызывает и onLeave — но место уже в резерве,
    // отдавать его рано.
    if (session.disconnectedAt !== null) return;
    // Место могло быть забрано новым соединением по токену (F5, сон).
    // Старый сокет закрывается — не удалять сессию, которая теперь у нового клиента.
    if (session.client !== client) return;
    this.dropSession(session);
  }

  /** Замораживает сессию и кладёт её место в резерв. */
  private freeze(session: Session): void {
    if (session.disconnectedAt !== null) return;
    session.disconnectedAt = Date.now();
    session.input = null;
    session.vx = 0;
    session.vz = 0;
    session.moving = false;
    session.sprinting = false;
    // Иначе аватар «бежит» стоя: флаги движения — часть снимка.
    const entity = this.entities.get(session.entityId);
    if (entity) entity.flags = 0;
  }

  /** Отдаёт место окончательно: сущность, ник и токен. */
  private dropSession(session: Session): void {
    this.sessions.delete(session.sessionId);
    this.entities.delete(session.entityId);
    this.resumeTokens.delete(session.resumeToken);
    this.genesisInFlight.delete(session.accountId);
    this.broadcastRoster();
    logInfo(`игрок ${session.name} вышел`, { players: this.sessions.size });
  }

  /**
   * Возврат на прежнее место. Возвращает true, если игрок вернулся.
   *
   * Два пути:
   *  1. токен из прошлого `welcome` — точный адрес места. Он работает даже
   *     если сервер ещё не заметил, что старый сокет мёртв: место забирается
   *     у старого соединения (сон/пробуждение ноутбука, гонка при F5).
   *  2. тот же аккаунт и тот же ник — человек закрыл вкладку и открыл
   *     заново, токен потерялся вместе с sessionStorage. Работает только
   *     для простаивающего места. Пока авторизации нет (D-009), accountId —
   *     единственное, что у нас есть; поэтому чужой человек с тем же
   *     accountId тоже займёт место. Это цена v0.
   *
   * Захват места не превращается в перетягивание: токен при возврате
   * ротируется, поэтому у выбитого соединения остаётся просроченный токен,
   * и его следующая попытка получит новое место, а не отберёт это обратно.
   */
  private resume(client: Client, hello: HelloMsg): boolean {
    const session = this.findResumable(hello);
    if (!session) return false;
    const previous = session.welcome;
    if (!previous) return false;

    if (session.disconnectedAt === null) {
      // Место занято живым соединением. Токен однозначно указывает на него,
      // а аккаунт совпал — это мы же. Старый сокет закрываем.
      logInfo(`место ${session.name} забирает новое соединение`, {
        players: this.sessions.size,
      });
      try {
        session.client.leave(4003, 'место занято новым соединением');
      } catch {
        // Сокет уже мёртв — ровно то, что нам нужно.
      }
    }

    this.resumeTokens.delete(session.resumeToken);
    // Старый ключ — прежний сокет; новый клиент приходит со своим sessionId.
    this.sessions.delete(session.sessionId);

    session.client = client;
    session.sessionId = client.sessionId;
    session.disconnectedAt = null;
    session.input = null;
    session.vx = 0;
    session.vz = 0;
    // У нового клиента нет истории снимков: диффы ему не с чем сравнивать.
    session.sent.clear();
    session.resumeToken = randomUUID();
    this.resumeTokens.set(session.resumeToken, session);
    this.sessions.set(session.sessionId, session);

    const welcome: WelcomeMsg = {
      ...previous,
      sessionId: session.sessionId,
      // Клиент ставит предсказание ровно туда, где игрок пропал.
      spawn: { x: session.x, y: session.y, z: session.z },
      balance: session.balance,
      resumeToken: session.resumeToken,
      resumed: true,
    };
    session.welcome = welcome;

    client.send(S2C.Welcome, welcome);
    this.broadcastRoster();
    this.sendSnapshot(session);
    logInfo(`игрок ${session.name} вернулся на место`, { players: this.sessions.size });
    return true;
  }

  /**
   * Ищет место: сначала по токену (живое или простаивающее), потом по
   * аккаунту и нику — но по второму пути только простаивающее.
   */
  private findResumable(hello: HelloMsg): Session | undefined {
    if (hello.resume) {
      const byToken = this.resumeTokens.get(hello.resume);
      if (byToken) {
        if (byToken.accountId !== hello.accountId) {
          logWarn('токен возобновления от другого аккаунта', {
            token: hello.resume.slice(0, 8),
          });
          return undefined;
        }
        return byToken;
      }
    }

    const requested = sanitizeName(hello.name).toLowerCase();
    for (const session of this.sessions.values()) {
      if (session.disconnectedAt === null) continue;
      if (session.accountId !== hello.accountId) continue;
      if (session.name.toLowerCase() !== requested) continue;
      return session;
    }
    return undefined;
  }

  override onDispose(): void {
    liveRooms.delete(this);
    logInfo('сектор закрыт', { players: this.sessions.size });
  }

  // ────────────────────────────────────────────────────── симуляция ────────

  private simulate(dt: number): void {
    const t0 = performance.now();
    this.tick += 1;

    const now = Date.now();
    const expired: Session[] = [];
    for (const session of this.sessions.values()) {
      // Игрок отвалился: тело стоит, ввод не читаем, порталы не проверяем.
      if (session.disconnectedAt !== null) {
        if (now - session.disconnectedAt > this.resumeGraceMs) expired.push(session);
        continue;
      }

      let input = session.input;

      // Клиент замолчал (обрыв, вкладка в фоне) — не тащим его вперёд
      // последним нажатием до бесконечности.
      if (input && now - session.lastInputAt > INPUT_TTL_MS) {
        input = null;
        session.input = null;
      }

      const dirX = input?.dirX ?? 0;
      const dirZ = input?.dirZ ?? 0;
      const crouch = input?.crouch ?? false;
      const sprint = !crouch && (input?.sprint ?? false);
      const wantJump = input?.jump ?? false;

      const velocity = stepVelocity(session.vx, session.vz, dirX, dirZ, sprint, dt, crouch);
      session.vx = velocity.vx;
      session.vz = velocity.vz;

      const prevX = session.x;
      const prevZ = session.z;
      session.x += session.vx * dt;
      session.z += session.vz * dt;
      if (input) session.yaw = input.yaw;

      // Коллизии с пропами + край зоны (с радиусом). Та же формула, что
      // на клиенте в LocalPlayer — иначе предсказание резинит.
      this.resolveMotion(session, session.x - prevX, session.z - prevZ, crouch);

      // Высота опоры под ногами (F1-19): над пропом опора — его верх,
      // около пропа — пол зоны. Ровно этот вызов есть и в LocalPlayer:
      // разойдётся хотя бы на ступеньку — предсказание зажует резину.
      const colliders = this.collidersFor(session);
      const groundY = colliders
        ? supportHeightAt(session.x, session.z, colliders, session.y)
        : GROUND_Y;

      const vertical = stepVertical(session.y, session.vy, wantJump, crouch, dt, groundY);
      session.y = vertical.y;
      session.vy = vertical.vy;
      session.airborne = !vertical.grounded;

      // Порталы проверяются всегда, даже без ввода: игрок может стоять
      // внутри портала, а после телепорта позицию нужно разослать.
      this.checkPortal(session);

      const speed = speedOf(session.vx, session.vz);
      session.moving = speed > 0.2;
      session.crouching = crouch && vertical.grounded;
      session.sprinting = session.moving && sprint && vertical.grounded;

      const entity = this.entities.get(session.entityId);
      if (entity) {
        entity.x = session.x;
        entity.y = session.y;
        entity.z = session.z;
        entity.yaw = session.yaw;
        entity.flags =
          (session.moving ? ENTITY_FLAG.Moving : 0) |
          (session.sprinting ? ENTITY_FLAG.Sprinting : 0) |
          (session.crouching ? ENTITY_FLAG.Crouching : 0) |
          (session.airborne ? ENTITY_FLAG.Airborne : 0);
      }
    }
    for (const session of expired) {
      logInfo(`место ${session.name} освобождено: игрок не вернулся`, {});
      this.dropSession(session);
    }

    this.disposeIfIdle(now);

    const dtMs = performance.now() - t0;
    this.tickDurations.push(dtMs);
    if (this.tickDurations.length > this.maxTickDurations) this.tickDurations.shift();
  }

  /** Пустая комната закрывается сама — иначе `autoDispose = false` течёт. */
  private disposeIfIdle(now: number): void {
    if (this.sessions.size > 0 || this.pending.size > 0 || this.clients.length > 0) {
      this.idleSince = null;
      return;
    }
    this.idleSince ??= now;
    if (now - this.idleSince < ROOM_IDLE_MS) return;
    logInfo('сектор пуст, закрываю', {});
    void this.disconnect();
  }

  /** Метрики для F0-10/F0-11. */
  getMetrics() {
    const durations = [...this.tickDurations];
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
    const p99 = durations[Math.floor(durations.length * 0.99)] ?? 0;
    const avg = durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : 0;

    // bytes out за последнюю секунду
    const now = Date.now();
    if (now - this.lastByteWindowAt >= 1000) {
      this.bytesOutWindow.push(this.bytesOutTotal);
      if (this.bytesOutWindow.length > 60) this.bytesOutWindow.shift();
      this.lastByteWindowAt = now;
    }

    return {
      tick: this.tick,
      tickRate: TICK_RATE,
      players: this.sessions.size,
      entities: this.entities.size,
      tickMs: { p50, p95, p99, avg, count: durations.length },
      bytesOutTotal: this.bytesOutTotal,
      bytesOutBps: this.bytesOutWindow.length >= 2 ? (this.bytesOutTotal - this.bytesOutWindow[0]!) : 0,
    };
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

  /**
   * Разрешает шаг против пропов текущей зоны и прижимает к bounds.
   * Обновляет zoneId по фактической точке (как старый clampToZone).
   *
   * `crouch` нужен для высоты тела: в приседе можно пройти под низким
   * проёмом (F1-19).
   */
  private resolveMotion(
    session: Session,
    dx: number,
    dz: number,
    crouch: boolean,
  ): void {
    const zone = zoneAt(this.world, session.x, session.z) ?? (session.zoneId
      ? findZone(this.world, session.zoneId)
      : undefined);
    const startX = session.x - dx;
    const startZ = session.z - dz;

    if (zone) {
      const colliders = this.zoneColliders.get(zone.id);
      if (colliders) {
        const resolved = resolvePlayerMove(startX, startZ, dx, dz, colliders, {
          feetY: session.y,
          height: crouch ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT,
        });
        session.x = resolved.x;
        session.z = resolved.z;
        if (resolved.blockedX) session.vx = 0;
        if (resolved.blockedZ) session.vz = 0;
      } else {
        const clamped = clampToBounds(startX + dx, startZ + dz, zone.bounds, PLAYER_RADIUS);
        session.x = clamped.x;
        session.z = clamped.z;
        if (clamped.blockedX) session.vx = 0;
        if (clamped.blockedZ) session.vz = 0;
      }
    }

    const at = zoneAt(this.world, session.x, session.z);
    if (at) session.zoneId = at.id;
  }

  /**
   * Коллизеры зоны, в которой игрок стоит сейчас (F1-19).
   * Выбор зоны тот же, что в resolveMotion: по фактической точке, иначе
   * последняя известная — иначе горизонталь и опора считались бы по разным
   * зонам ровно на границе.
   */
  private collidersFor(session: Session): ZoneColliders | null {
    const zone = zoneAt(this.world, session.x, session.z) ?? (session.zoneId
      ? findZone(this.world, session.zoneId)
      : undefined);
    return zone ? (this.zoneColliders.get(zone.id) ?? null) : null;
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

    session.teleportUntil = now + PORTAL_COOLDOWN_MS;
    this.applyTeleport(session, x, z, portal.toZone);
  }

  /**
   * Переносит игрока в другую зону. Тот же путь, что у портала, но без
   * привязки к геометрии: целевую зону выбирает сервер, точку — центр её
   * bounds. Это тестовый хук (см. `OASIS_TEST_HOOKS` в config).
   *
   * Возвращает, откуда и куда ушёл, или null, если игрока/зены нет.
   */
  moveToOtherZone(name: string): { from: string; to: string; x: number; z: number } | null {
    const session = [...this.sessions.values()].find((candidate) => candidate.name === name);
    const fromZone = session?.zoneId;
    if (!session || !fromZone) return null;

    const destination = this.world.zones.find((zone) => zone.id !== fromZone);
    if (!destination) return null;

    const x = destination.bounds.x + destination.bounds.w / 2;
    const z = destination.bounds.z + destination.bounds.d / 2;

    this.applyTeleport(session, x, z, destination.id);
    // Скорость обнуляем: иначе игрок продолжает «уезжать» из новой точки
    // с той, что была до переноса.
    session.vx = 0;
    session.vz = 0;

    return { from: fromZone, to: destination.id, x, z };
  }

  /** Единая точка переноса: позиция, зона и уведомление клиента. */
  private applyTeleport(session: Session, x: number, z: number, zoneId: string): void {
    session.x = x;
    session.y = 0;
    session.z = z;
    session.vy = 0;
    session.airborne = false;
    session.zoneId = zoneId;

    session.client.send(S2C.Teleport, {
      zoneId,
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
      // Мёртвому сокету не шлём: клиент вернётся и получит полный снимок.
      if (session.disconnectedAt !== null) continue;
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

      const delta = encodeDelta(this.tick, changed, removed);
      session.client.sendBytes(BIN_CHANNEL, delta);
      this.bytesOutTotal += delta.byteLength;
    }
  }

  private sendSnapshot(session: Session): void {
    const visible = this.visibleEntities(session);
    session.sent.clear();
    for (const entity of visible) session.sent.set(entity.id, { ...entity });
    const snap = encodeSnapshot(this.tick, visible);
    session.client.sendBytes(BIN_CHANNEL, snap);
    this.bytesOutTotal += snap.byteLength;
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

  // ────────────────────────────────── команды чата (F1-21: добыча) ────────

  private runCommand(client: Client, session: Session, command: ParsedCommand): void {
    switch (command.name) {
      case 'gather':
        void this.commandGather(client, session);
        break;
      default:
        this.replyTo(client, `Неизвестная команда: /${command.name}. Пока есть /gather.`);
    }
  }

  /** Ответ отправителю: результат команды — не реплика в общий чат. */
  private replyTo(client: Client, text: string): void {
    client.send(S2C.Chat, { from: 0, name: 'система', text, ts: Date.now() });
  }

  private async commandGather(client: Client, session: Session): Promise<void> {
    const zone = session.zoneId ? findZone(this.world, session.zoneId) : null;
    if (!zone) {
      this.replyTo(client, 'Сначала окажись в зоне.');
      return;
    }

    const node = findResourceNear(zone, session.x, session.z, GATHER_RADIUS);
    if (!node) {
      this.replyTo(client, `Рядом нет слизня: подойди ближе чем на ${GATHER_RADIUS} м.`);
      return;
    }

    const permit = this.gather.consume(node.id, session.accountId, Date.now());
    if (!permit.ok) {
      this.replyTo(
        client,
        permit.reason === 'cooldown'
          ? `Слизнь переваривается ещё ${Math.ceil(permit.retryMs / 1000)} с.`
          : `Суточная норма ${GATHER_DAILY_CAP} сборов исчерпана.`,
      );
      return;
    }

    // Начисление через ledger: баланс — сумма проводок, историю можно проверить.
    await this.ledger.append({
      worldId: this.world.id,
      accountId: session.accountId,
      kind: 'source',
      amount: GATHER_REWARD,
      reason: 'gather',
      meta: { node: node.id },
    });
    session.balance = await this.ledger.balanceOf(session.accountId);
    client.send(S2C.Balance, { balance: session.balance, reason: 'gather' });
    this.replyTo(
      client,
      `+${GATHER_REWARD} ¤ за сбор (${permit.usedToday}/${GATHER_DAILY_CAP} сегодня).`,
    );
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

/**
 * Cookie из контекста colyseus. `AuthContext.headers` — это HTTP-заголовки
 * запроса матчмейкина/апгрейда: именно туда браузер кладёт HttpOnly-cookie,
 * недоступную JS, а значит и `options` от клиента.
 */
function cookieFromContext(context?: AuthContext): string | undefined {
  const headers = context?.headers;
  if (!headers || typeof headers.get !== 'function') return undefined;
  return headers.get('cookie') ?? undefined;
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


