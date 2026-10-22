/**
 * Модель данных OASIS v0.
 *
 * Два слоя:
 *  - доменный (WorldDef, ZoneDef, EntityState) — описывает, что есть в мире;
 *  - транспортный (payload'ы сообщений) — что реально летит по проводу.
 *
 * Мир — данные. Клиент строит сцену из дескрипторов зон, сервер — источник истины.
 */

import type { SectorFlags } from './domain.ts';

// ────────────────────────────────────────────────────────────── домен ──────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SectorDef {
  id: string;
  name: string;
  flags: SectorFlags;
  spawn?: Vec3;
}

export interface ZoneBounds {
  /** Центр по X. */
  x: number;
  /** Центр по Z. */
  z: number;
  /** Размер по X. */
  w: number;
  /** Размер по Z. */
  d: number;
}

export type PropType = 'box' | 'cylinder' | 'sphere' | 'cone' | 'pillar';

export interface PropDef {
  id: string;
  type: PropType;
  x: number;
  y: number;
  z: number;
  /** Габариты (полуразмеры для box, радиус/высота для остальных). */
  sx: number;
  sy: number;
  sz: number;
  /** Поворот вокруг Y, радианы. */
  rot: number;
  /** Цвет 0xRRGGBB. */
  color: number;
}

/** Дескриптор зоны — то, что клиент превращает в геометрию. */
export interface ZoneDef {
  id: string;
  sectorId: string;
  name: string;
  kind: 'plaza' | 'grove' | 'arena' | 'hub' | 'test';
  bounds: ZoneBounds;
  groundColor: number;
  props: PropDef[];
}

export interface PortalDef {
  id: string;
  fromZone: string;
  toZone: string;
  x: number;
  z: number;
  radius: number;
}

/** Полное описание мира = world.json. Версионируется, хранится в git/S3. */
export interface WorldDef {
  id: string;
  version: number;
  seed: number;
  generator: string;
  sectors: SectorDef[];
  zones: ZoneDef[];
  portals: PortalDef[];
}

/** Краткое описание зоны — без геометрии. Летит сразу при входе. */
export type ZoneSummary = Omit<ZoneDef, 'props'>;

/** Заголовок мира — то, что клиенту нужно до получения зон. */
export interface WorldHeader {
  id: string;
  version: number;
  seed: number;
  generator: string;
  sectors: SectorDef[];
  zones: ZoneSummary[];
  portals: PortalDef[];
}

// ────────────────────────────────────────────────────────── сущности ──────

export const EntityKind = {
  Prop: 0,
  Player: 1,
} as const;

export type EntityKindValue = (typeof EntityKind)[keyof typeof EntityKind];

/** Состояние одной сущности в бинарном виде (трансформ + статика). */
export interface EntityState {
  id: number;
  kind: EntityKindValue;
  x: number;
  y: number;
  z: number;
  /** Курс, радианы. */
  yaw: number;
  /** Битовая маска ENTITY_FLAG. */
  flags: number;
  /** Цвет 0xRRGGBB. */
  color: number;
}

/** Игрок в реестре сектора (JSON-плоскость: имена, цвет, ник). */
export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
}

// ───────────────────────────────────────────────────── сообщения (C→S) ────

export interface HelloMsg {
  protocolVersion: string;
  /** Клиентский стабильный id аккаунта (localStorage). TODO: заменить на auth. */
  accountId: string;
  /** Момент создания аккаунта (ms). В v0 клиент доверяется — см. D-009. */
  accountCreatedAt: number;
  /** Ник игрока. */
  name: string;
}

export interface InputMsg {
  /** Монотонный номер инпута — для дедупликации и отладки. */
  seq: number;
  /** Направление движения в мировых координатах, нормализовано. */
  dirX: number;
  dirZ: number;
  /** Курс камеры, радианы. */
  yaw: number;
  sprint: boolean;
}

export interface ChatMsg {
  text: string;
}

export interface ZoneRequestMsg {
  zoneId: string;
}

export interface PingMsg {
  /** Клиентское время отправки, ms. */
  t: number;
}

export interface RenameMsg {
  name: string;
}

// ───────────────────────────────────────────────────── сообщения (S→C) ────

export interface WelcomeMsg {
  protocolVersion: string;
  /** Идентификатор сущности игрока в этом секторе. */
  playerId: number;
  /** Имя, которое игрок получил в секторе. Может отличаться от запрошенного:
   *  сервер добавляет суффикс при совпадении (`гость` → `гость (2)`). */
  name: string;
  /** Идентификатор сессии Colyseus (для reconnect). */
  sessionId: string;
  world: WorldHeader;
  sectorId: string;
  tickRate: number;
  snapshotRate: number;
  aoiRadius: number;
  spawn: Vec3;
  balance: number;
}

export interface RosterMsg {
  players: PlayerInfo[];
}

export interface ChatBroadcastMsg {
  from: number;
  name: string;
  text: string;
  /** Время сервера, ms. */
  ts: number;
}

export interface ZoneMsg {
  zone: ZoneDef;
}

export interface TeleportMsg {
  zoneId: string;
  position: Vec3;
}

export interface BalanceMsg {
  balance: number;
  /** Человекочитаемая причина изменения — для тостов в UI. */
  reason: string;
}

export interface PongMsg {
  t: number;
  serverTime: number;
}

/** Ответ на успешное переименование. Имя может отличаться от запрошенного. */
export interface RenamedMsg {
  name: string;
}

export interface ErrorMsg {
  code: string;
  message: string;
}

// ───────────────────────────────────────────────────────────── ledger ───────

export type LedgerKind =
  | 'genesis'
  | 'faucet'
  | 'sink'
  | 'source'
  | 'transfer'
  | 'fee'
  | 'adjustment';

/**
 * Одна проводка в append-only журнале экономики.
 * Баланс счёта = сумма проводок. Ничего не обновляется «на месте» —
 * иначе невозможно ни проверить историю, ни откатить ошибку.
 */
export interface LedgerEntry {
  id: string;
  /** Unix ms. */
  ts: number;
  worldId: string;
  accountId: string;
  kind: LedgerKind;
  /** Знаковая величина: + начисление, − списание. */
  amount: number;
  reason: string;
  counterpartyId?: string | null;
  meta?: Record<string, unknown>;
}
