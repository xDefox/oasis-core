/**
 * Точка входа сервера.
 *
 * Поднимает:
 *  - HTTP (health, отдача мира, базовая статистика);
 *  - WebSocket-сервер Colyseus с единственной комнатой «sector».
 *
 * Запуск без внешних зависимостей: STORAGE=memory по умолчанию.
 * Postgres включается переменной окружения (см. .env.example).
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from 'cors';
import express from 'express';

import { config, logError, logInfo, REPO_ROOT } from './config.ts';
import { SectorRoom, sectorRooms } from './rooms/SectorRoom.ts';
import { createStore } from './store/index.ts';
import { loadWorld } from './world/loadWorld.ts';

async function main(): Promise<void> {
  const world = await loadWorld(config.worldPath);
  const store = await createStore();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.json({ ok: true, ts: Date.now(), world: world.id, version: world.version });
  });

  app.get('/world.json', (_request, response) => {
    response.json(world);
  });

  app.get('/stats', async (_request, response) => {
    let roomMetrics: unknown = null;
    try {
      const rooms = (gameServer as any).rooms;
      if (rooms && typeof rooms.values === 'function') {
        for (const r of rooms.values()) {
          if (typeof (r as any).getMetrics === 'function') {
            roomMetrics = (r as any).getMetrics();
            break;
          }
        }
      }
    } catch {
      // ignore
    }
    response.json({
      world: { id: world.id, version: world.version, zones: world.zones.length },
      storage: store.kind,
      supply: await store.ledger.totalSupply(world.id),
      room: roomMetrics,
    });
  });

  // Собранный клиент отдаёт тот же сервер, что и игру.
  //
  // Зачем деплою один туннель вместо двух: страница и WebSocket живут на одном
  // домене, поэтому бесплатные туннели (pinggy) спрашивают разрешение на вход
  // один раз, а не по адресу для каждой из двух ссылок. Dev-режим на это не
  // реагирует: там клиент поднимает vite на 5173, а dist может не быть вовсе.
  const clientDist = path.join(REPO_ROOT, 'packages', 'client', 'dist');
  const clientIndex = path.join(clientDist, 'index.html');
  const staticFiles = express.static(clientDist);
  app.use((request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    if (!existsSync(clientIndex)) return next();
    staticFiles(request, response, (error) => {
      if (error) return next(error);
      // Файла в dist нет — отдаём index.html: у клиента нет своих маршрутов,
      // но прямая ссылка или обновление страницы не должны ловить 404.
      void response.sendFile(clientIndex, (sendError) => {
        if (sendError) next(sendError);
      });
    });
  });

  const httpServer = http.createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    // Свои SIGINT/SIGTERM ниже: иначе Colyseus и мы гасим сервер
    // одновременно и второй получает already_shutting_down.
    gracefullyShutdown: false,
  });

  gameServer.define('sector', SectorRoom, {
    world,
    ledger: store.ledger,
    maxPlayers: config.maxPlayersPerSector,
  });

  // Тестовый хук: увести игрока в другую зону тем же путём, что портал.
  //
  // Зачем вообще HTTP, а не пеший маршрут в зонде: зонд проверяет поведение
  // при выходе из зоны, а не планировку мира. Пеший путь был завязан на пропы
  // конкретного world.json — и после F1-16 (мир под коллизии) чек падал бы
  // на живом коде. Роут появляется только под OASIS_TEST_HOOKS=1: без флага
  // маршрута нет вовсе, публичный сервер снаружи недоступен.
  //
  // Регистрируем здесь, а не рядом с /health: хуку нужна готовая комната.
  if (config.testHooks) {
    app.post('/debug/move', (request, response) => {
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (!name) {
        response.status(400).json({ ok: false, error: 'нужно имя игрока' });
        return;
      }

      const sector = sectorRooms()[0];
      if (!sector) {
        response.status(409).json({ ok: false, error: 'комната ещё не поднята' });
        return;
      }

      const moved = sector.moveToOtherZone(name);
      if (!moved) {
        response.status(404).json({ ok: false, error: `игрок ${name} не найден` });
        return;
      }

      logInfo('тестовый перенос игрока', { name, ...moved });
      response.json({ ok: true, ...moved });
    });
  }

  await gameServer.listen(config.port, config.host);

  // Аккуратное завершение: закрыть комнаты, потом пул Postgres.
  // Без этого `docker stop`/systemd убивает процесс с открытыми сокетами,
  // а коллекции остаются висеть в базе.
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logInfo(`останавливаюсь по ${signal}`);
    try {
      await gameServer.gracefullyShutdown(false);
      await store.ledger.close();
    } catch (error) {
      logError('ошибка при остановке', { error: String(error) });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logInfo(`сервер поднят`, {
    url: `http://${config.host}:${config.port}`,
    world: `${world.id}@${world.version}`,
    zones: world.zones.length,
    storage: store.kind,
  });
}

main().catch((error: unknown) => {
  logError('сервер не смог стартовать', { error: String(error) });
  process.exit(1);
});
