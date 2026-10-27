/**
 * Auth-lite (F0-6/F0-7): подписанная cookie вместо доверия клиенту.
 *
 * Три уровня, и все три нужны:
 *  1. подпись — round-trip и попытки подделать (саму подпись, тело, длину id);
 *  2. HTTP — кука выдаётся HttpOnly и не перевыпускается на каждый запрос;
 *  3. комната — два продовых сценария: cookie приходит в AuthContext (третий
 *     аргумент onAuth — colyseus держит там HTTP-заголовки, а в `options`
 *     HttpOnly-куки нет по определению), и D-009: accountCreatedAt берётся
 *     из подписи, а не из hello.
 *
 * Здесь же зафиксирован баг, на котором всё это проверялось: сравнение
 * подписи шло через `Buffer.from(str)` без кодировки (UTF-8, 43 байта)
 * против 32 декодированных — длины не сходились НИКОГДА и каждая сессия
 * отклонялась. Тест round-trip обязан был его поймать.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { AuthContext, Client as ColyseusClient } from '@colyseus/core';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client } from '@colyseus/sdk';

import {
  GENESIS_FRESH_ACCOUNT_FACTOR,
  GENESIS_GRANT,
  PROTOCOL_VERSION,
} from '@oasis/protocol';

import {
  SESSION_COOKIE_NAME,
  issueSession,
  readSessionFromCookieHeader,
} from '../src/auth/session.ts';
import { config } from '../src/config.ts';
import { handleSession } from '../src/http/session.ts';
import { SectorRoom } from '../src/rooms/SectorRoom.ts';
import { MemoryLedger } from '../src/store/ledger.ts';
import { loadWorld } from '../src/world/loadWorld.ts';

/** Значение куки без атрибутов: `oasis.sid=подпись`. */
function cookieValue(cookie: string): string {
  return cookie.split(';')[0]!;
}

/** Подпись из готовой куки: вторая часть после точки. */
function splitSigned(cookie: string): [string, string] {
  const raw = cookieValue(cookie).slice(SESSION_COOKIE_NAME.length + 1);
  const [body, sig] = raw.split('.');
  assert.ok(body && sig, 'подписанная кука должна быть вида body.sig');
  return [body, sig];
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class FakeResponse {
  status = 0;
  headers: Record<string, unknown> = {};
  body = '';

  writeHead(status: number, headers: Record<string, unknown> = {}): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  end(body = ''): this {
    this.body = String(body);
    return this;
  }
}

/** Один запрос к GET /auth/session без настоящего сервера. */
function callSessionRoute(cookie?: string): FakeResponse {
  const req = {
    method: 'GET',
    url: '/auth/session',
    headers: cookie ? { cookie } : {},
  } as unknown as IncomingMessage;
  const res = new FakeResponse();
  const handled = handleSession(req, res as unknown as ServerResponse);
  assert.equal(handled, true, 'GET /auth/session должен быть обработан роутом');
  return res;
}

/** Заголовки HTTP-запроса колиcеуса — именно так cookie доходит до onAuth. */
function authContext(cookie?: string): AuthContext {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return { headers, ip: undefined } as unknown as AuthContext;
}

async function waitFor(
  probe: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timeout: ${label}`);
}

describe('auth-lite: подписанная сессия', () => {
  it('auth: round-trip — подписанная cookie читается обратно', () => {
    const { cookie, payload } = issueSession();
    const read = readSessionFromCookieHeader(cookieValue(cookie));
    assert.ok(read, 'валидная подписанная cookie должна читаться');
    assert.equal(read.accountId, payload.accountId);
    assert.equal(read.issuedAt, payload.issuedAt);
  });

  it('auth: подделка подписи отклоняется', () => {
    const { cookie } = issueSession();
    const [body, sig] = splitSigned(cookie);
    // Та же длина, другой байт: ловится только честной сверкой подписи.
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    assert.equal(readSessionFromCookieHeader(`${SESSION_COOKIE_NAME}=${body}.${flipped}`), null);
  });

  it('auth: подделка тела отклоняется', () => {
    const { cookie } = issueSession();
    const [body, sig] = splitSigned(cookie);
    const parsed = JSON.parse(base64urlDecode(body).toString('utf8')) as { accountId: string };
    parsed.accountId = 'acct_hijacked_by_attacker';
    const forged = base64url(Buffer.from(JSON.stringify(parsed)));
    assert.equal(readSessionFromCookieHeader(`${SESSION_COOKIE_NAME}=${forged}.${sig}`), null);
  });

  it('auth: короткий accountId отклоняется', () => {
    // issueSession подпишет и короткий id — защита должна быть на чтении.
    const { cookie } = issueSession('short');
    assert.equal(readSessionFromCookieHeader(cookieValue(cookie)), null);
  });

  it('auth: мусорный cookie отклоняется', () => {
    assert.equal(readSessionFromCookieHeader(`${SESSION_COOKIE_NAME}=abc`), null);
    assert.equal(readSessionFromCookieHeader(`${SESSION_COOKIE_NAME}=a.b.c`), null);
    assert.equal(readSessionFromCookieHeader(undefined), null);
    assert.equal(readSessionFromCookieHeader('other=value'), null);
  });
});

describe('auth-lite: HTTP-ручка /auth/session', () => {
  it('auth: кука выдаётся HttpOnly и повторно не перевыпускается', () => {
    const first = callSessionRoute();
    assert.equal(first.status, 200);
    const setCookie = String(first.headers['Set-Cookie']);
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE_NAME}=`), 'кука должна выдаваться');
    assert.match(setCookie, /HttpOnly/, 'кука обязана быть HttpOnly');
    assert.match(setCookie, /SameSite=Lax/);
    const issued = JSON.parse(first.body) as { accountId: string };

    // Повторный запрос с валидной кукой возвращает ту же сессию.
    const second = callSessionRoute(cookieValue(setCookie));
    assert.equal(second.status, 200);
    assert.equal(second.headers['Set-Cookie'], undefined, 'валидная сессия не перевыпускается');
    const again = JSON.parse(second.body) as { accountId: string };
    assert.equal(again.accountId, issued.accountId, 'accountId не должен меняться');
  });
});

describe('auth-lite: onAuth читает HTTP-контекст колиcеуса', () => {
  it('auth: onAuth читает cookie из AuthContext', async () => {
    const { cookie, payload } = issueSession();
    const auth = await SectorRoom.prototype.onAuth(
      {} as unknown as ColyseusClient,
      {},
      authContext(cookieValue(cookie)),
    );
    assert.deepEqual(auth, { accountId: payload.accountId, issuedAt: payload.issuedAt });
  });

  it('auth: production без cookie отказывает', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // Клиент прислал accountId в options — в проде верить ему нельзя.
      const auth = await SectorRoom.prototype.onAuth(
        {} as unknown as ColyseusClient,
        { accountId: 'acct_client_supplied_1', accountCreatedAt: 1 },
        authContext(),
      );
      assert.equal(auth, false, 'в production без подписанной cookie — отказ');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe('auth-lite: D-009 на живой комнате', () => {
  // 2620 занят vertical.test.ts — файлы гоняются параллельно.
  const PORT = 2621;
  let gameServer: Server;

  before(async () => {
    const world = await loadWorld(config.worldPath);
    const ledger = new MemoryLedger();
    const httpServer = http.createServer();
    gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
    gameServer.define('sector_auth', SectorRoom, { world, ledger, maxPlayers: 4 });
    await gameServer.listen(PORT);
  });

  after(async () => {
    await gameServer.gracefullyShutdown(false);
  });

  /**
   * Подключиться, отправить hello и дождаться баланса genesis —
   * по нему и видно, чей `accountCreatedAt` взял сервер.
   */
  async function genesisBalance(
    client: Client,
    hello: { accountId: string; accountCreatedAt: number; name: string; cookie?: string },
  ): Promise<number | undefined> {
    const room = await client.joinOrCreate('sector_auth', {
      protocolVersion: PROTOCOL_VERSION,
      ...hello,
    });
    // Как в vertical.test.ts: встроенный реконнект ломает сценарий обрыва.
    room.reconnection.enabled = false;

    let balance: number | undefined;
    room.onMessage('balance', (message: { balance: number }) => {
      balance = message.balance;
    });
    room.send('hello', { protocolVersion: PROTOCOL_VERSION });
    await waitFor(() => balance !== undefined, 15_000, 'баланс genesis');
    room.leave();
    return balance;
  }

  it(
    'auth: D-009 — accountCreatedAt берётся из подписи, а не из hello',
    { timeout: 20_000 },
    async () => {
      const { cookie, payload } = issueSession();
      const balance = await genesisBalance(new Client(`ws://127.0.0.1:${PORT}`), {
        accountId: payload.accountId,
        // Клиент врёт: «аккаунту 40 дней» — тогда genesis дал бы 100 ¤.
        accountCreatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
        name: 'd009-probe',
        cookie,
      });
      // Подпись свежая (issuedAt = сейчас) → аккаунт «новый» → 20 ¤.
      // Поверят hello — будет 100 ¤, и D-009 останется открытым.
      assert.equal(balance, Math.round(GENESIS_GRANT * GENESIS_FRESH_ACCOUNT_FACTOR));
    },
  );

  it(
    'auth: cookie доходит через HTTP-заголовки (как в браузере)',
    { timeout: 20_000 },
    async () => {
      const { cookie, payload } = issueSession();
      // Ровно продовый путь: HttpOnly-кука уходит с HTTP-запросом
      // матчмейкина и апгрейдом вебсокета, а в options её нет вовсе —
      // для JS она закрыта. Colyseus отдаёт заголовки через AuthContext.
      const client = new Client(`ws://127.0.0.1:${PORT}`, {
        headers: { cookie: cookieValue(cookie) },
      });
      const balance = await genesisBalance(client, {
        accountId: payload.accountId,
        accountCreatedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
        name: 'd009-header',
      });
      assert.equal(balance, Math.round(GENESIS_GRANT * GENESIS_FRESH_ACCOUNT_FACTOR));
    },
  );
});
