/**
 * Интеграционный тест вертикального среза.
 *
 * Проверяет главное обещание протокола: «два человека видят друг друга,
 * двигаются и общаются» — на настоящем сервере и настоящем клиенте.
 * Без моков: поднимаем Colyseus в процессе, подключаемся через @colyseus/sdk
 * и проверяем байтовый поток.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';

import {
  AOI_RADIUS,
  BIN_CHANNEL,
  PROTOCOL_VERSION,
  decodeDelta,
  decodeSnapshot,
  encodeInput,
  type ChatBroadcastMsg,
  type EntityState,
  type RosterMsg,
  type TeleportMsg,
  type WelcomeMsg,
} from '@oasis/protocol';

import { config } from '../src/config.ts';
import { SectorRoom } from '../src/rooms/SectorRoom.ts';
import { MemoryLedger } from '../src/store/ledger.ts';
import { loadWorld } from '../src/world/loadWorld.ts';

const PORT = 2620;

interface Recorder {
  welcome?: WelcomeMsg;
  roster?: RosterMsg;
  chats: ChatBroadcastMsg[];
  teleports: TeleportMsg[];
  balance?: number;
  renamed: string[];
  snapshots: { tick: number; entities: EntityState[] }[];
  deltas: { tick: number; changed: EntityState[]; removed: number[] }[];
}

function recorder(room: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMessage(type: string, callback: (message: any) => void): unknown;
}): Recorder {
  const record: Recorder = { chats: [], teleports: [], renamed: [], snapshots: [], deltas: [] };
  room.onMessage('welcome', (message: WelcomeMsg) => {
    record.welcome = message;
  });
  room.onMessage('roster', (message: RosterMsg) => {
    record.roster = message;
  });
  room.onMessage('renamed', (message: { name: string }) => {
    record.renamed.push(message.name);
  });
  room.onMessage('chat', (message: ChatBroadcastMsg) => {
    record.chats.push(message);
  });
  room.onMessage('balance', (message: { balance: number }) => {
    record.balance = message.balance;
  });
  room.onMessage('teleport', (message: TeleportMsg) => {
    record.teleports.push(message);
  });
  room.onMessage(BIN_CHANNEL, (payload: Uint8Array) => {
    if (payload[0] === 1) {
      record.snapshots.push(decodeSnapshot(payload));
    } else if (payload[0] === 2) {
      record.deltas.push(decodeDelta(payload));
    }
  });
  return record;
}

/** Подключение + запись сообщений + hello (после регистрации обработчиков). */
async function joinWorld(
  client: Client,
  hello: { accountId: string; accountCreatedAt: number; name: string },
  roomName = 'sector',
): Promise<{ room: Awaited<ReturnType<Client['joinOrCreate']>>; record: Recorder }> {
  const room = await client.joinOrCreate(roomName, {
    protocolVersion: PROTOCOL_VERSION,
    ...hello,
  });
  const record = recorder(room);
  room.send('hello', { protocolVersion: PROTOCOL_VERSION });
  return { room, record };
}

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 8000,
  label = 'условие',
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timeout: ${label}`);
}

describe('вертикальный срез: два игрока видят друг друга, двигаются, общаются', () => {
  let gameServer: Server;
  let world: Awaited<ReturnType<typeof loadWorld>>;
  /** Мир для теста порталов: спавн стоит прямо в портале, зоны — те же. */
  let portalWorld: Awaited<ReturnType<typeof loadWorld>>;
  /** Мир для теста видимости: спавн вне портала, но зоны граничат близко. */
  let aoiWorld: Awaited<ReturnType<typeof loadWorld>>;

  before(async () => {
    world = await loadWorld(config.worldPath);

    portalWorld = structuredClone(world);
    portalWorld.sectors[0]!.spawn = { x: 0, y: 0, z: 0 };
    portalWorld.portals = [
      { id: 'p_test_in', fromZone: 'z_plaza', toZone: 'z_grove', x: 2, z: 0, radius: 3 },
      { id: 'p_test_out', fromZone: 'z_grove', toZone: 'z_plaza', x: 92, z: 0, radius: 3 },
    ];

    // Две зоны, стоящие впритык: игроки из разных зон попадают в один
    // AOI_RADIUS. Именно так ловится «видно сквозь границу зоны».
    // Левая x∈[-10,10], правая x∈[10,30] — на x=9 и x=11 они в 2 м
    // друг от друга, но в разных зонах.
    aoiWorld = structuredClone(world);
    aoiWorld.zones = [
      {
        ...aoiWorld.zones[0]!,
        id: 'z_left',
        name: 'left',
        bounds: { x: 0, z: 0, w: 20, d: 20 },
      },
      {
        ...aoiWorld.zones[0]!,
        id: 'z_right',
        name: 'right',
        bounds: { x: 15, z: 0, w: 10, d: 20 },
      },
    ];
    aoiWorld.portals = [
      { id: 'p_aoi', fromZone: 'z_left', toZone: 'z_right', x: 9, z: 0, radius: 1.5 },
      { id: 'p_aoi_back', fromZone: 'z_right', toZone: 'z_left', x: 11, z: 0, radius: 1.5 },
    ];
    // Левая зона x∈[-10,10], правая x∈[10,20]. Игрок из правой не может
    // уехать дальше x=20, то есть дальше AOI_RADIUS от спавна альфы:
    // «ушёл далеко» исключено, и тест проверяет ровно правило зоны.
    aoiWorld.sectors[0]!.spawn = { x: 0, y: 0, z: 0 };

    const ledger = new MemoryLedger();
    const httpServer = http.createServer();
    gameServer = new Server({
      transport: new WebSocketTransport({ server: httpServer }),
    });
    gameServer.define('sector', SectorRoom, { world, ledger, maxPlayers: 16 });
    gameServer.define('sector_portal', SectorRoom, {
      world: portalWorld,
      ledger,
      maxPlayers: 16,
    });
    gameServer.define('sector_aoi', SectorRoom, { world: aoiWorld, ledger, maxPlayers: 16 });
    await gameServer.listen(PORT);
  });

  after(async () => {
    await gameServer.gracefullyShutdown(false);
  });

  it('выдаёт welcome, ростер и стартовый снимок', async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const { room, record } = await joinWorld(client, {
      accountId: 'acct_test_alpha_0001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'alpha',
    });

    const welcome = await waitFor(() => record.welcome, 8000, 'welcome');
    assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
    assert.ok(welcome.playerId > 0);
    assert.equal(welcome.world.id, world.id);
    assert.ok(welcome.world.zones.length > 0, 'в welcome должны быть описания зон');

    // Стартовый снимок приходит сразу и содержит хотя бы нас самих.
    const snapshot = await waitFor(() => record.snapshots[0], 8000, 'снимок');
    const own = snapshot.entities.find((entity) => entity.id === welcome.playerId);
    assert.ok(own, 'снимок должен содержать собственную сущность');
    assert.equal(own!.kind, 1);

    // Ростер приходит и перечисляет игроков.
    const roster = await waitFor(() => record.roster, 8000, 'ростер');
    assert.equal(roster.players.length, 1);
    assert.equal(roster.players[0]!.name, 'alpha');

    await room.leave();
  });

  it('разводит игроков с одинаковым ником суффиксом', async () => {
    // Сценарий из жизни: две вкладки одного браузера делят localStorage и
    // присылают один и тот же guest-ник. Игрок опознаёт других только по
    // имени, поэтому дубль — баг, а не косметика.
    const first = new Client(`ws://localhost:${PORT}`);
    const second = new Client(`ws://localhost:${PORT}`);
    const third = new Client(`ws://localhost:${PORT}`);

    const { room: firstRoom, record: firstRecord } = await joinWorld(first, {
      accountId: 'acct_dup_000000000001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'guest-1234',
    });
    await waitFor(() => firstRecord.welcome, 8000, 'welcome первого');

    const { room: secondRoom, record: secondRecord } = await joinWorld(second, {
      accountId: 'acct_dup_000000000002',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'guest-1234',
    });
    await waitFor(() => secondRecord.welcome, 8000, 'welcome второго');

    const { room: thirdRoom, record: thirdRecord } = await joinWorld(third, {
      accountId: 'acct_dup_000000000003',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'guest-1234',
    });
    await waitFor(() => thirdRecord.welcome, 8000, 'welcome третьего');

    const names = [
      firstRecord.welcome!.name,
      secondRecord.welcome!.name,
      thirdRecord.welcome!.name,
    ];
    assert.deepEqual(
      names,
      ['guest-1234', 'guest-1234 (2)', 'guest-1234 (3)'],
      'имена должны быть уникальны, начиная со второго — с суффиксом',
    );

    // Ростер тоже без дублей — именно его видят игроки.
    const roster = await waitFor(
      () => {
        const current = firstRecord.roster;
        return current && current.players.length === 3 ? current : undefined;
      },
      8000,
      'ростер из трёх',
    );
    const rosterNames = roster.players.map((player) => player.name).sort();
    assert.deepEqual(rosterNames, ['guest-1234', 'guest-1234 (2)', 'guest-1234 (3)']);

    await firstRoom.leave();
    await secondRoom.leave();
    await thirdRoom.leave();
  });

  it('переименовывает игрока и разводит совпадение суффиксом', async () => {
    // Смена ника — команда `/name` на клиенте, но решает сервер: он же
    // авторитет по реестру сектора. Тест проверяет обе ветки — успешную
    // смену и конфликт с уже занятым именем.
    const alpha = new Client(`ws://localhost:${PORT}`);
    const beta = new Client(`ws://localhost:${PORT}`);

    const { room: alphaRoom, record: alphaRecord } = await joinWorld(alpha, {
      accountId: 'acct_rename_alpha_001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'rename-alpha',
    });
    const { room: betaRoom, record: betaRecord } = await joinWorld(beta, {
      accountId: 'acct_rename_beta_0002',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'rename-beta',
    });
    await waitFor(() => alphaRecord.welcome, 8000, 'welcome alpha');
    await waitFor(() => betaRecord.welcome, 8000, 'welcome beta');

    // Успешная смена.
    alphaRoom.send('rename', { name: 'новый-ник' });
    const renamed = await waitFor(() => alphaRecord.renamed[0], 8000, 'renamed alpha');
    assert.equal(renamed, 'новый-ник');

    // Ростер у второго игрока обновился.
    const rosterAfterRename = await waitFor(
      () => {
        const current = betaRecord.roster;
        return current?.players.some((player) => player.name === 'новый-ник')
          ? current
          : undefined;
      },
      8000,
      'ростер с новым ником',
    );
    assert.ok(
      rosterAfterRename.players.some((player) => player.name === 'новый-ник'),
      'в ростере нет нового ника',
    );
    assert.ok(
      !rosterAfterRename.players.some((player) => player.name === 'rename-alpha'),
      'старый ник остался в ростере',
    );

    // Конфликт: бета пытается взять имя, которое уже занято.
    betaRoom.send('rename', { name: 'новый-ник' });
    const conflicted = await waitFor(() => betaRecord.renamed[0], 8000, 'renamed beta');
    assert.equal(conflicted, 'новый-ник (2)');

    // Просьба оставить своё же имя не должна превращаться в «имя (2)».
    alphaRecord.renamed.length = 0;
    alphaRoom.send('rename', { name: 'новый-ник' });
    // Сервер ничего не меняет и не шлёт ответ — ждём, что ответа нет.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(alphaRecord.renamed.length, 0, 'сервер переименовал в то же имя с суффиксом');

    await alphaRoom.leave();
    await betaRoom.leave();
  });

  it('показывает второго игрока и двигает его по дельтам', async () => {
    const alpha = new Client(`ws://localhost:${PORT}`);
    const beta = new Client(`ws://localhost:${PORT}`);

    const { room: alphaRoom, record: alphaRecord } = await joinWorld(alpha, {
      accountId: 'acct_test_alpha_0001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'alpha',
    });
    const { room: betaRoom, record: betaRecord } = await joinWorld(beta, {
      accountId: 'acct_test_beta_00002',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'beta',
    });

    const alphaWelcome = await waitFor(() => alphaRecord.welcome, 8000, 'welcome alpha');
    const betaWelcome = await waitFor(() => betaRecord.welcome, 8000, 'welcome beta');

    // Ростер у обоих содержит двоих.
    const roster = await waitFor(
      () => {
        const current = alphaRecord.roster;
        return current && current.players.length === 2 ? current : undefined;
      },
      8000,
      'ростер из двух игроков',
    );
    assert.deepEqual(
      roster.players.map((player) => player.name).sort(),
      ['alpha', 'beta'],
    );

    // Бета двигается: альфа должна увидеть это в дельтах.
    betaRoom.sendBytes(
      BIN_CHANNEL,
      encodeInput({ seq: 1, dirX: 1, dirZ: 0, yaw: 0, sprint: true }),
    );

    const moved = await waitFor(
      () => {
        for (const delta of alphaRecord.deltas) {
          const betaState = delta.changed.find((entity) => entity.id === betaWelcome.playerId);
          if (betaState && betaState.x > 1) return betaState;
        }
        return undefined;
      },
      8000,
      'движение беты в дельтах альфы',
    );
    assert.ok(moved.x > 1, `бета должна сместиться по X, получено x=${moved.x}`);

    // Собственная сущность альфы в снимке тоже есть.
    const alphaSnapshot = await waitFor(() => alphaRecord.snapshots[0], 8000, 'снимок альфы');
    assert.ok(
      alphaSnapshot.entities.some((entity) => entity.id === alphaWelcome.playerId),
      'снимок альфы должен содержать её саму',
    );

    await alphaRoom.leave();
    await betaRoom.leave();
  });

  it('доставляет чат всем участникам', async () => {
    const alpha = new Client(`ws://localhost:${PORT}`);
    const beta = new Client(`ws://localhost:${PORT}`);

    const { room: alphaRoom, record: alphaRecord } = await joinWorld(alpha, {
      accountId: 'acct_test_alpha_0001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'alpha',
    });
    const { room: betaRoom, record: betaRecord } = await joinWorld(beta, {
      accountId: 'acct_test_beta_00002',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'beta',
    });
    await waitFor(() => alphaRecord.welcome, 8000, 'welcome alpha');
    await waitFor(() => betaRecord.welcome, 8000, 'welcome beta');

    alphaRoom.send('chat', { text: 'привет, оазис' });

    const delivered = await waitFor(
      () => betaRecord.chats.find((message) => message.text === 'привет, оазис'),
      8000,
      'чат у беты',
    );
    assert.equal(delivered.name, 'alpha');
    assert.ok(delivered.from > 0);

    // Отправитель тоже получает эхо.
    const echo = await waitFor(
      () => alphaRecord.chats.find((message) => message.text === 'привет, оазис'),
      8000,
      'эхо у альфы',
    );
    assert.equal(echo.name, 'alpha');

    await alphaRoom.leave();
    await betaRoom.leave();
  });

  it('телепортирует через портал и не отправляет обратно (регрессия пинг-понга)', async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.joinOrCreate('sector_portal', {
      protocolVersion: PROTOCOL_VERSION,
      accountId: 'acct_test_portal_04',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'portal',
    });
    const record = recorder(room);
    room.send('hello', { protocolVersion: PROTOCOL_VERSION });

    const teleport = await waitFor(() => record.teleports[0], 8000, 'телепорт');
    assert.equal(teleport.zoneId, 'z_grove');

    // Прибытие должно быть ЗА порталом возврата, иначе следующий тик
    // отправит игрока обратно и так до бесконечности.
    const arrival = teleport.position;
    const backPortal = portalWorld.portals.find((portal) => portal.id === 'p_test_out')!;
    const distanceToBack = Math.hypot(arrival.x - backPortal.x, arrival.z - backPortal.z);
    assert.ok(
      distanceToBack > backPortal.radius,
      `прибытие внутри обратного портала: ${distanceToBack.toFixed(2)} м`,
    );

    // Стоим на месте дольше кулдауна — второго телепорта быть не должно.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(record.teleports.length, 1, 'игрока унесло обратно');

    await room.leave();
  });

  it('не показывает игрока из другой зоны, даже если он рядом', async () => {
    // Регрессия: AOI считался только по расстоянию, поэтому игроки из
    // соседних зон видели друг друга сквозь границу зоны — то есть сквозь
    // стену. Зона должна быть жёстким условием.
    const alpha = new Client(`ws://localhost:${PORT}`);
    const beta = new Client(`ws://localhost:${PORT}`);

    const { room: alphaRoom, record: alphaRecord } = await joinWorld(
      alpha,
      {
        accountId: 'acct_aoi_000000000001',
        accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
        name: 'aoi-alpha',
      },
      'sector_aoi',
    );
    // Ростер у обоих — двое: игрок из другой зоны остаётся в реестре
    // (он в мире), но его состояние больше не шлётся.
    const { room: betaRoom, record: betaRecord } = await joinWorld(
      beta,
      {
        accountId: 'acct_aoi_000000000002',
        accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
        name: 'aoi-beta',
      },
      'sector_aoi',
    );

    await waitFor(() => alphaRecord.welcome, 8000, 'welcome alpha');

    // Бета идёт вправо до портала и уходит в z_right. Ввод надо слать
    // постоянно: у сервера есть TTL ввода, и «одно нажатие на 8 секунд»
    // он справедливо трактует как «клиент отвалился».
    let pump = true;
    const pumping = (async () => {
      let seq = 0;
      while (pump) {
        seq += 1;
        betaRoom.sendBytes(
          BIN_CHANNEL,
          encodeInput({ seq, dirX: 1, dirZ: 0, yaw: 0, sprint: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    const teleport = await waitFor(() => betaRecord.teleports[0], 8000, 'телепорт беты');
    pump = false;
    await pumping;
    assert.equal(teleport.zoneId, 'z_right');

    // Ключевое: бета остаётся В РАДИУСЕ видимости альфы. Если бы AOI считался
    // только по расстоянию, бета была бы видна. Значит `removed` ниже
    // доказывает именно правило зоны, а не «ушёл далеко».
    const alphaSpawn = (await waitFor(() => alphaRecord.welcome, 8000, 'welcome α')).spawn;
    const betaPlayerId = (await waitFor(() => betaRecord.welcome, 8000, 'welcome β')).playerId;
    const distance = Math.hypot(
      teleport.position.x - alphaSpawn.x,
      teleport.position.z - alphaSpawn.z,
    );
    assert.ok(
      distance < AOI_RADIUS,
      `бета должна быть в радиусе AOI, а не в ${distance.toFixed(1)} м`,
    );

    // После ухода беты в другую зону альфа должна получить removed.
    const removed = await waitFor(
      () => alphaRecord.deltas.find((delta) => delta.removed.length > 0),
      8000,
      'removed после ухода беты в другую зону',
    );
    assert.deepEqual(
      removed.removed,
      [betaPlayerId],
      'из поля зрения должна пропасть именно бета',
    );

    await alphaRoom.leave();
    await betaRoom.leave();
  });

  it('игрок без ввода останавливается: ввод клиента протухает', async () => {
    // Если клиент замолчал (обрыв, вкладка в фоне, потеря сети), сервер
    // не должен тащить его вперёд последним нажатием до бесконечности.
    // Раньше это правило было в коде, но ни один тест его не проверял.
    const client = new Client(`ws://localhost:${PORT}`);
    const { room, record } = await joinWorld(client, {
      accountId: 'acct_ttl_000000000001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'ttl',
    });
    await waitFor(() => record.welcome, 8000, 'welcome');

    // Один-единственный ввод — дальше клиент молчит.
    room.sendBytes(BIN_CHANNEL, encodeInput({ seq: 1, dirX: 1, dirZ: 0, yaw: 0, sprint: true }));

    // Ждём заметно дольше TTL ввода (1 с).
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const own = record.deltas
      .flatMap((delta) => delta.changed)
      .filter((entity) => entity.id === record.welcome?.playerId)
      .at(-1);
    assert.ok(own, 'сервер не прислал состояние игрока');

    // Без TTL игрок доехал бы до стены z_plaza (x = 32). С TTL он должен
    // замереть там, где остановился.
    assert.ok(
      own.x < 12,
      `игрок с мёртвым вводом продолжает ехать: x=${own.x} (ждали остановки)`,
    );

    await room.leave();
  });

  it('кулдаун портала не даёт улететь обратно, если держать клавишу', async () => {
    // Игрок приходит в z_grove и продолжает жать в сторону обратного
    // портала. Без кулдауна его мгновенно уносит назад, потом вперёд —
    // бесконечный пинг-понг.
    const client = new Client(`ws://localhost:${PORT}`);
    const room = await client.joinOrCreate('sector_portal', {
      protocolVersion: PROTOCOL_VERSION,
      accountId: 'acct_cooldown_000001',
      accountCreatedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
      name: 'cooldown',
    });
    const record = recorder(room);
    room.send('hello', { protocolVersion: PROTOCOL_VERSION });

    // Идём в портал своим ходом: спавн разбрасывает игрока по хэшу имени,
    // и полагаться на то, что он случайно оказался внутри, нельзя.
    let seq = 0;
    let pumping = true;
    const pumpingTask = (async () => {
      while (pumping) {
        seq += 1;
        room.sendBytes(
          BIN_CHANNEL,
          encodeInput({ seq, dirX: 1, dirZ: 0, yaw: 0, sprint: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    const first = await waitFor(() => record.teleports[0], 8000, 'первый телепорт');
    assert.equal(first.zoneId, 'z_grove');

    // Теперь жмём в сторону обратного портала (в z_grove он на x = 92,
    // игрок прибывает за ним, дальше по +X). Направление меняем на -X.
    pumping = false;
    await pumpingTask;

    let pumpingBack = true;
    const pumpingBackTask = (async () => {
      while (pumpingBack) {
        seq += 1;
        room.sendBytes(
          BIN_CHANNEL,
          encodeInput({ seq, dirX: -1, dirZ: 0, yaw: 0, sprint: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();

    // Ждём меньше кулдауна (1.2 с) — второй телепорт быть не должно.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    pumpingBack = false;
    await pumpingBackTask;

    assert.equal(
      record.teleports.length,
      1,
      `игрока унесло обратно, пока держал клавишу: телепортов ${record.teleports.length}`,
    );

    await room.leave();
  });

  it('отказывает клиенту с чужой версией протокола', async () => {
    const client = new Client(`ws://localhost:${PORT}`);
    const badHello = {
      protocolVersion: '0.0.1',
      accountId: 'acct_test_gamma_0003',
      accountCreatedAt: Date.now(),
      name: 'gamma',
    };

    // Сервер либо отклоняет подключение, либо сразу отключает клиента —
    // оба варианта означают «не пустили».
    let rejected = false;
    let room;
    try {
      room = await client.joinOrCreate('sector', badHello);
    } catch {
      rejected = true;
    }

    if (!rejected) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('сервер не отключил клиента')), 3000);
        room!.onLeave(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    assert.ok(true);
  });
});
