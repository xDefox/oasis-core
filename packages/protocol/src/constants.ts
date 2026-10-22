/**
 * Константы протокола OASIS v0.
 *
 * ВАЖНО: эти числа — часть контракта. Клиент и сервер обязаны использовать
 * одни и те же значения (клиент предсказывает движение, сервер — авторитет).
 * Любое изменение здесь ломает предсказание → требует bump PROTOCOL_VERSION.
 */

export const PROTOCOL_VERSION = '0.1.0';

/** Частота серверной симуляции, Гц. */
export const TICK_RATE = 20;
/** Частота рассылки снапшотов/дельт, Гц. */
export const SNAPSHOT_RATE = 10;
/** Частота отправки input клиентом, Гц. */
export const INPUT_RATE = 30;

/** Радиус области интереса, м. По умолчанию AOI_RADIUS + запас. */
export const AOI_RADIUS = 24;
export const AOI_SNAPSHOT_RADIUS = 32;

/** Квантование позиции: 1/64 м (≈1.6 см). */
export const POSITION_QUANT = 64;

/** Скорости, м/с. 5 м/с ≈ 18 км/ч — это бег, а не прогулка. */
export const PLAYER_SPEED = 5.0;
export const PLAYER_SPRINT_SPEED = 8.0;
export const PLAYER_RADIUS = 0.4;
/** Разгон, м/с²: 0 → 5 м/с за 0.18 с. */
export const PLAYER_ACCEL = 28.0;
/** Торможение, м/с²: останавливаемся быстрее, чем разгоняемся. */
export const PLAYER_DECEL = 42.0;

/** Ограничения чата. */
export const MAX_CHAT_LENGTH = 240;
export const CHAT_MESSAGES_PER_SECOND = 5;
export const CHAT_COOLDOWN_MS = 400;

/** Лимиты сектора. */
export const MAX_PLAYERS_PER_SECTOR = 64;
export const MAX_ZONE_PROPS = 2000;

/** Экономика (см. docs/05-economy-and-antifraud.md). */
export const GENESIS_GRANT = 100;
export const GENESIS_ACCOUNT_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Доля гранта для «свежих» аккаунтов (защита от мультиаккаунтов). */
export const GENESIS_FRESH_ACCOUNT_FACTOR = 0.2;
export const FAUCET_DAILY_CAP = 50;

/** Идентификаторы бинарных сообщений (первый байт пакета). */
export const BIN = {
  Snapshot: 1,
  Delta: 2,
  Input: 3,
} as const;

export type BinMessageType = (typeof BIN)[keyof typeof BIN];

/** Имена каналов сообщений (control plane, JSON). */
export const C2S = {
  Hello: 'hello',
  Input: 'input',
  Chat: 'chat',
  ZoneRequest: 'zone_request',
  Ping: 'ping',
} as const;

export const S2C = {
  Welcome: 'welcome',
  Roster: 'roster',
  Chat: 'chat',
  Zone: 'zone',
  Teleport: 'teleport',
  Balance: 'balance',
  Pong: 'pong',
  Error: 'error',
} as const;

/** Единый бинарный канал: клиент и сервер гоняют только его. */
export const BIN_CHANNEL = 'bin';

/** Флаги состояния сущности (битовая маска). */
export const ENTITY_FLAG = {
  Moving: 1 << 0,
  Sprinting: 1 << 1,
  Speaking: 1 << 2,
} as const;
