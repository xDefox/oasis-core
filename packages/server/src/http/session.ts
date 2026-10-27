/**
 * HTTP-роут для выдачи/возврата подписанной сессии.
 *
 * Клиент может дернуть GET /auth/session до подключения по вебсокету,
 * чтобы получить HttpOnly-cookie с accountId.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { issueSession, readSessionFromCookieHeader, type SessionPayload } from '../auth/session.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function getCookieHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  if (Array.isArray(raw)) return raw.join('; ');
  return raw;
}

export function handleSession(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'POST') return false;
  const url = req.url ?? '';
  if (url.split('?')[0] !== '/auth/session') return false;

  const existing = readSessionFromCookieHeader(getCookieHeader(req));
  if (existing) {
    // Сессия есть и валидна — просто возвращаем её, не перевыпускаем.
    sendJson(res, 200, { accountId: existing.accountId, issuedAt: existing.issuedAt });
    return true;
  }

  const { cookie, payload } = issueSession();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': cookie,
  });
  res.end(JSON.stringify({ accountId: payload.accountId, issuedAt: payload.issuedAt }));
  return true;
}
