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

import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cors from 'cors';
import express from 'express';

import { config, logError, logInfo } from './config.ts';
import { SectorRoom } from './rooms/SectorRoom.ts';
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
    response.json({
      world: { id: world.id, version: world.version, zones: world.zones.length },
      storage: store.kind,
      supply: await store.ledger.totalSupply(world.id),
    });
  });

  const httpServer = http.createServer(app);
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
  });

  gameServer.define('sector', SectorRoom, {
    world,
    ledger: store.ledger,
    maxPlayers: config.maxPlayersPerSector,
  });

  await gameServer.listen(config.port, config.host);

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
