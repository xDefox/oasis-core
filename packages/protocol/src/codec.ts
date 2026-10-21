/**
 * Бинарный кодек состояния сущностей.
 *
 * Формат пакета (little-endian):
 *
 *   u8   тип пакета (BIN.Snapshot | BIN.Delta)
 *   u32  tick
 *   u16  количество сущностей
 *   entity[]:
 *     u32  id
 *     u8   kind (0 = prop, 1 = player)
 *     u16  flags (битовая маска ENTITY_FLAG)
 *     i16  x  (в 1/64 м)
 *     i16  y
 *     i16  z
 *     u16  yaw (0..65535 → 0..2π)
 *     u32  color (0xRRGGBB)
 *
 * Для Delta дополнительно в конце:
 *   u16  количество удалённых id
 *   u32  removedId[]
 *
 * Имена игроков НЕ передаются в бинарном канале: они идут отдельным
 * JSON-сообщением `roster` (ростер меняется редко, а трафик — постоянно).
 */

import { BIN, POSITION_QUANT } from './constants.ts';
import { EntityKind, type EntityState } from './types.ts';

const HEADER_BYTES = 1 + 4 + 2;
const ENTITY_BYTES = 4 + 1 + 2 + 2 + 2 + 2 + 2 + 4;

const TAU = Math.PI * 2;

function clampI16(value: number): number {
  const rounded = Math.round(value);
  if (rounded < -32768) return -32768;
  if (rounded > 32767) return 32767;
  return rounded;
}

function quantize(value: number): number {
  return clampI16(value * POSITION_QUANT);
}

function dequantize(value: number): number {
  return value / POSITION_QUANT;
}

function quantizeYaw(yaw: number): number {
  const normalized = ((yaw % TAU) + TAU) % TAU;
  return Math.round((normalized / TAU) * 65535) & 0xffff;
}

function dequantizeYaw(raw: number): number {
  return (raw / 65535) * TAU;
}

class ByteWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  offset = 0;

  constructor(initial = 256) {
    this.buffer = new ArrayBuffer(initial);
    this.view = new DataView(this.buffer);
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < this.offset + extra) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buffer));
    this.buffer = next;
    this.view = new DataView(next);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value & 0xff);
    this.offset += 1;
  }

  u16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, value & 0xffff, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  i16(value: number): void {
    this.ensure(2);
    this.view.setInt16(this.offset, clampI16(value), true);
    this.offset += 2;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.offset);
  }
}

class ByteReader {
  private view: DataView;
  offset = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i16(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  get remaining(): number {
    return this.data.byteLength - this.offset;
  }
}

function writeEntity(writer: ByteWriter, entity: EntityState): void {
  writer.u32(entity.id);
  writer.u8(entity.kind);
  writer.u16(entity.flags);
  writer.i16(quantize(entity.x));
  writer.i16(quantize(entity.y));
  writer.i16(quantize(entity.z));
  writer.u16(quantizeYaw(entity.yaw));
  writer.u32(entity.color >>> 0);
}

function readEntity(reader: ByteReader): EntityState {
  const id = reader.u32();
  const kind = reader.u8() as EntityState['kind'];
  const flags = reader.u16();
  const x = dequantize(reader.i16());
  const y = dequantize(reader.i16());
  const z = dequantize(reader.i16());
  const yaw = dequantizeYaw(reader.u16());
  const color = reader.u32();
  return { id, kind, flags, x, y, z, yaw, color };
}

/** Полный снимок видимой области. */
export function encodeSnapshot(tick: number, entities: EntityState[]): Uint8Array {
  const writer = new ByteWriter(HEADER_BYTES + entities.length * ENTITY_BYTES);
  writer.u8(BIN.Snapshot);
  writer.u32(tick);
  writer.u16(entities.length);
  for (const entity of entities) writeEntity(writer, entity);
  return writer.bytes();
}

export function decodeSnapshot(data: Uint8Array): { tick: number; entities: EntityState[] } {
  const reader = new ByteReader(data);
  const type = reader.u8();
  if (type !== BIN.Snapshot) {
    throw new Error(`decodeSnapshot: ожидался тип ${BIN.Snapshot}, получен ${type}`);
  }
  const tick = reader.u32();
  const count = reader.u16();
  const entities: EntityState[] = [];
  for (let i = 0; i < count; i += 1) entities.push(readEntity(reader));
  return { tick, entities };
}

/** Изменения с последнего снимка + список исчезнувших сущностей. */
export function encodeDelta(
  tick: number,
  changed: EntityState[],
  removed: number[],
): Uint8Array {
  const writer = new ByteWriter(
    HEADER_BYTES + changed.length * ENTITY_BYTES + 2 + removed.length * 4,
  );
  writer.u8(BIN.Delta);
  writer.u32(tick);
  writer.u16(changed.length);
  for (const entity of changed) writeEntity(writer, entity);
  writer.u16(removed.length);
  for (const id of removed) writer.u32(id);
  return writer.bytes();
}

export function decodeDelta(
  data: Uint8Array,
): { tick: number; changed: EntityState[]; removed: number[] } {
  const reader = new ByteReader(data);
  const type = reader.u8();
  if (type !== BIN.Delta) {
    throw new Error(`decodeDelta: ожидался тип ${BIN.Delta}, получен ${type}`);
  }
  const tick = reader.u32();
  const count = reader.u16();
  const changed: EntityState[] = [];
  for (let i = 0; i < count; i += 1) changed.push(readEntity(reader));
  const removedCount = reader.u16();
  const removed: number[] = [];
  for (let i = 0; i < removedCount; i += 1) removed.push(reader.u32());
  return { tick, changed, removed };
}

/** Упакованный размер одного состояния — для метрик и расчёта бюджета трафика. */
export const ENTITY_PACKED_BYTES = ENTITY_BYTES;
export const SNAPSHOT_HEADER_BYTES = HEADER_BYTES;

// ──────────────────────────────────────────────────── input (клиент→сервер) ─

/**
 * Пакет ввода. Клиент шлёт его бинарным — на 30 Гц это заметная доля трафика.
 *
 *   u8   BIN.Input
 *   u32  seq
 *   i16  dirX * 1000   (направление в мировых координатах, ±1.0)
 *   i16  dirZ * 1000
 *   u16  yaw (0..65535 → 0..2π)
 *   u8   flags (bit0 = sprint)
 */
export function encodeInput(input: {
  seq: number;
  dirX: number;
  dirZ: number;
  yaw: number;
  sprint: boolean;
}): Uint8Array {
  const writer = new ByteWriter(1 + 4 + 2 + 2 + 2 + 1);
  writer.u8(BIN.Input);
  writer.u32(input.seq);
  writer.i16(Math.round(input.dirX * 1000));
  writer.i16(Math.round(input.dirZ * 1000));
  writer.u16(quantizeYaw(input.yaw));
  writer.u8(input.sprint ? 1 : 0);
  return writer.bytes();
}

export function decodeInput(data: Uint8Array): {
  seq: number;
  dirX: number;
  dirZ: number;
  yaw: number;
  sprint: boolean;
} {
  const reader = new ByteReader(data);
  const type = reader.u8();
  if (type !== BIN.Input) {
    throw new Error(`decodeInput: ожидался тип ${BIN.Input}, получен ${type}`);
  }
  const seq = reader.u32();
  const dirX = reader.i16() / 1000;
  const dirZ = reader.i16() / 1000;
  const yaw = dequantizeYaw(reader.u16());
  const sprint = reader.u8() === 1;
  return { seq, dirX, dirZ, yaw, sprint };
}
