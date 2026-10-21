/**
 * Валидация входных данных (control plane) и world.json.
 *
 * Клиент недоверенный, поэтому проверяем ВСЁ, что приходит по JSON-каналу.
 * Бинарный канал разбирается вручную в codec.ts (там фиксированный layout).
 */

import { z } from 'zod';
import { MAX_CHAT_LENGTH } from './constants.ts';

export const helloSchema = z.object({
  protocolVersion: z.string().min(1).max(32),
  accountId: z.string().min(8).max(64),
  accountCreatedAt: z.number().int().nonnegative(),
  name: z.string().min(1).max(24),
});

export const inputSchema = z.object({
  seq: z.number().int().nonnegative(),
  dirX: z.number().finite().min(-1).max(1),
  dirZ: z.number().finite().min(-1).max(1),
  yaw: z.number().finite(),
  sprint: z.boolean(),
});

export const helloHandshakeSchema = z.object({
  protocolVersion: z.string().min(1).max(32),
});

export const chatSchema = z.object({
  text: z.string().min(1).max(MAX_CHAT_LENGTH),
});

export const zoneRequestSchema = z.object({
  zoneId: z.string().min(1).max(64),
});

export const pingSchema = z.object({
  t: z.number().finite(),
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
  zones: z.array(zoneSchema),
  portals: z.array(portalSchema),
});

export type ParsedWorld = z.infer<typeof worldSchema>;
