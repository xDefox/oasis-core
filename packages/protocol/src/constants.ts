/**
 * Константы протокола OASIS v0.
 *
 * ВАЖНО: эти числа — часть контракта. Клиент и сервер обязаны использовать
 * одни и те же значения (клиент предсказывает движение, сервер — авторитет).
 * Любое изменение здесь ломает предсказание → требует bump PROTOCOL_VERSION.
 */

export const PROTOCOL_VERSION = '0.5.0';

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
export const PLAYER_SPRINT_SPEED = 9.5;
/** Присед: медленный шаг вприсядку. */
export const PLAYER_CROUCH_SPEED = 2.2;
export const PLAYER_RADIUS = 0.4;
/** Высота тела для отбора горизонтальных коллайдеров, м. */
export const PLAYER_HEIGHT = 1.7;
/** Высота тела в приседе (для коллизий с низкими проёмами позже). */
export const PLAYER_CROUCH_HEIGHT = 1.05;
/**
 * На сколько можно подняться одним шагом, не прыгая, м (F1-19).
 * Бордюр и ступенька проходятся ногой; всё, что выше, — прыжком.
 * 0.4 меньше высоты прыжка (≈1.1 м), поэтому лавки в 0.5 м берутся прыжком.
 */
export const PLAYER_STEP_UP = 0.4;
/** Разгон, м/с²: 0 → 5 м/с за 0.18 с. */
export const PLAYER_ACCEL = 28.0;
/** Торможение, м/с²: останавливаемся быстрее, чем разгоняемся. */
export const PLAYER_DECEL = 42.0;

/** Прыжок: пол y=0, без платформ. Высота ≈ v²/(2g) ≈ 1.1 м. */
export const PLAYER_GRAVITY = 24.0;
export const PLAYER_JUMP_SPEED = 7.2;
export const GROUND_Y = 0;

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

/**
 * Добыча (F1-21). Кран «добыча» — один из пяти из docs/05: кап в сутки на
 * игрока, никакого бесконечного фарма. Цифры согласованы в плейтесте 28.10.
 */
/**
 * Узел добычи опознаётся по префиксу `:res` в id — например `z_grove:res0`.
 * Двоеточие обязательно: id пропа устроен как `зона:тип+номер`, и без
 * разделителя «res» ловилось бы и «restroom», и любое совпадение в середине.
 */
export const RESOURCE_PROP_PREFIX = ':res';
/** Радиус, в котором /gather находит узел, м. */
export const GATHER_RADIUS = 3;
/** Сколько ¤ за один сбор. */
export const GATHER_REWARD = 3;
/** Кулдаун узла: слизнь «восстанавливается» после сбора. */
export const GATHER_NODE_COOLDOWN_MS = 20_000;
/** Суточный кап сборов на аккаунт: 20 × 3 ¤ = 60 ¤ в сутки. */
export const GATHER_DAILY_CAP = 20;

/**
 * Переводы между игроками (F1-22). Сток из docs/05 «Налог на переводы».
 * До лимита комиссии нет — мелкие переводы бесплатны, чтобы игроки вообще
 * пользовались механикой; свыше — 5 % сгорают, сумма приходит целиком.
 */
export const PAY_FEE_FREE_LIMIT = 1_000;
export const PAY_FEE_RATE = 0.05;
/** Кулдаун перевода: защита от спама и от двойного нажатия. */
export const PAY_COOLDOWN_MS = 3_000;

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
  Rename: 'rename',
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
  Renamed: 'renamed',
} as const;

/** Единый бинарный канал: клиент и сервер гоняют только его. */
export const BIN_CHANNEL = 'bin';

/** Флаги состояния сущности (битовая маска). */
export const ENTITY_FLAG = {
  Moving: 1 << 0,
  Sprinting: 1 << 1,
  Speaking: 1 << 2,
  Crouching: 1 << 3,
  /** В воздухе (прыжок / падение). */
  Airborne: 1 << 4,
} as const;
