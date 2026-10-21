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
  BIN_CHANNEL,
  PROTOCOL_VERSION,
  decodeDelta,
  decodeSnapshot,
  encodeInput,
  type ChatBroadcastMsg,
  type EntityState,
  type RosterMsg,
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
  balance?: number;
  snapshots: { tick: number; entities: EntityState[] }[];
  deltas: { tick: number; changed: EntityState[]; removed: number[] }[];
}

function recorder(room: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMessage(type: string, callback: (message: any) => void): unknown;
}): Recorder {
  const record: Recorder = { chats: [], snapshots: [], deltas: [] };
  room.onMessage('welcome', (message: WelcomeMsg) => {
    record.welcome = message;
  });
  room.onMessage('roster', (message: RosterMsg) => {
    record.roster = message;
  });
  room.onMessage('chat', (message: ChatBroadcastMsg) => {
    record.chats.push(message);
  });
  room.onMessage('balance', (message: { balance: number }) => {
    record.balance = message.balance;
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
): Promise<{ room: Awaited<ReturnType<Client['joinOrCreate']>>; record: Recorder }> {
  const room = await client.joinOrCreate('sector', {
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

  before(async () => {
    world = await loadWorld(config.worldPath);
    const ledger = new MemoryLedger();
    const httpServer = http.createServer();
    gameServer = new Server({
      transport: new WebSocketTransport({ server: httpServer }),
    });
    gameServer.define('sector', SectorRoom, { world, ledger, maxPlayers: 16 });
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
