/**
 * Подписанная сессия игрока (auth-lite).
 *
 * Цель — перестать доверять `accountId`, присланному клиентом. Сервер
 * сам генерирует и подписывает его HMAC-SHA256, хранит в HttpOnly-cookie.
 *
 * Минимально и без внешних зависимостей (только node:crypto).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  accountId: string;
  /** Момент выпуска, ms. */
  issuedAt: number;
}

const COOKIE_NAME = 'oasis.sid';

function getSecret(): string {
  const secret = process.env.OASIS_AUTH_SECRET;
  if (secret && secret.length >= 16) return secret;
  // В dev без секретного ключа — детерминированный ключ, чтобы сессии
  // переживали рестарт в рамках одной сессии разработки. В проде ОБЯЗАТЕЛЬНО
  // выставить OASIS_AUTH_SECRET.
  return 'oasis-dev-insecure-secret-change-me';
}

function base64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(value: string): string {
  const mac = createHmac('sha256', getSecret()).update(value).digest();
  return base64url(mac);
}

function signPayload(payload: SessionPayload): string {
  const body = base64url(JSON.stringify(payload));
  const sig = sign(body);
  return `${body}.${sig}`;
}

/** Проверка с тайминг-безопасным сравнением. */
function verifySigned(signed: string): SessionPayload | null {
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  // Обе стороны — base64url одной и той же подписи, поэтому декодируем
  // одинаково. Buffer.from(str) без кодировки дал бы UTF-8 байты строки
  // (43 шт.) против 32 декодированных: lengths не сошлись бы никогда и
  // каждая сессия отваливалась бы.
  const expected = base64urlDecode(sign(body));
  const got = base64urlDecode(sig);
  if (expected.length !== got.length) return null;
  try {
    if (!timingSafeEqual(expected, got)) return null;
  } catch {
    return null;
  }

  try {
    const json = base64urlDecode(body).toString('utf8');
    const parsed = JSON.parse(json) as Partial<SessionPayload>;
    if (typeof parsed.accountId !== 'string' || parsed.accountId.length < 8) return null;
    if (typeof parsed.issuedAt !== 'number') return null;
    return { accountId: parsed.accountId, issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}

/** Новый анонимный accountId. */
export function newAccountId(): string {
  return `acct_${randomBytes(16).toString('hex')}`;
}

/** Выпустить подписанную сессию. */
export function issueSession(accountId = newAccountId()): { cookie: string; payload: SessionPayload } {
  const payload: SessionPayload = { accountId, issuedAt: Date.now() };
  const signed = signPayload(payload);
  const maxAge = 365 * 24 * 60 * 60; // 1 год
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  return { cookie, payload };
}

/** Прочесть сессию из заголовка Cookie. */
export function readSessionFromCookieHeader(header: string | undefined): SessionPayload | null {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== COOKIE_NAME) continue;
    const value = rest.join('=');
    if (!value) return null;
    return verifySigned(value);
  }
  return null;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
