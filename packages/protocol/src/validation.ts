/**
 * Валидация входных данных (control plane) и world.json.
 *
 * Клиент недоверенный, поэтому проверяем ВСЁ, что приходит по JSON-каналу.
 * Бинарный канал разбирается вручную в codec.ts (там фиксированный layout).
 */

import { z } from 'zod';

export const helloSchema = z.object({
  protocolVersion: z.string().min(1).max(32),
  accountId: z.string().min(8).max(64),
  accountCreatedAt: z.number().int().nonnegative(),
  // trim здесь, потому что имя уходит в ростер и в подпись над головой.
  name: z.string().trim().min(1).max(24),
});

/**
 * Ввод намеренно мягкий: сервер всё равно нормализует вектор и ограничивает
 * скорость. Строгие границы здесь означали бы «клиент с багом отключён»,
 * а нам нужен предсказуемый мир, а не наказание за кривой float.
 */
export const inputSchema = z.object({
  seq: z.number().int().nonnegative(),
  dirX: z.number().finite(),
  dirZ: z.number().finite(),
  yaw: z.number().finite(),
  sprint: z.boolean(),
});

export const helloHandshakeSchema = z.object({
  protocolVersion: z.string().min(1).max(32),
});

/**
 * Лимит схемы выше игрового: сообщение длиннее 240 символов обрезается
 * на сервере, а не превращается в дисконнект (Colyseus рвёт соединение
 * при провале валидатора).
 */
export const chatSchema = z.object({
  text: z.string().min(1).max(4096),
});

export const zoneRequestSchema = z.object({
  zoneId: z.string().min(1).max(64),
});

export const pingSchema = z.object({
  t: z.number().finite(),
});

export const renameSchema = z.object({
  name: z.string().trim().min(1).max(24),
});

// ───────────────────────────────────────────────── валидация world.json ────

const flagsSchema = z.object({
  pvp: z.boolean(),
  magic: z.boolean(),
  tech: z.boolean(),
  teleport: z.boolean(),
  comms: z.boolean(),
});

const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const sectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  flags: flagsSchema,
  spawn: vec3Schema.optional(),
});

const boundsSchema = z.object({
  x: z.number(),
  z: z.number(),
  w: z.number().positive(),
  d: z.number().positive(),
});

const propSchema = z.object({
  id: z.string(),
  type: z.enum(['box', 'cylinder', 'sphere', 'cone', 'pillar']),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  sx: z.number().nonnegative(),
  sy: z.number().nonnegative(),
  sz: z.number().nonnegative(),
  rot: z.number(),
  color: z.number().int().min(0).max(0xffffff),
});

const zoneSchema = z.object({
  id: z.string().min(1),
  sectorId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['plaza', 'grove', 'arena', 'hub', 'test']),
  bounds: boundsSchema,
  groundColor: z.number().int().min(0).max(0xffffff),
  props: z.array(propSchema),
});

const portalSchema = z.object({
  id: z.string().min(1),
  fromZone: z.string().min(1),
  toZone: z.string().min(1),
  x: z.number(),
  z: z.number(),
  radius: z.number().positive(),
});

export const worldSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  seed: z.number().int(),
  generator: z.string().min(1),
  sectors: z.array(sectorSchema).min(1),
  // Мир без зон — это мир, в котором негде стоять.
  zones: z.array(zoneSchema).min(1),
  portals: z.array(portalSchema),
});

export type ParsedWorld = z.infer<typeof worldSchema>;
