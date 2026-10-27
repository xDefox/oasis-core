/**
 * Генератор мира.
 *
 * Мир — данные. Этот скрипт берёт собранное `buildWorld()` (seed + описание
 * зон + правила коллизий) и кладёт результат в world.json, который
 * коммитится в git и является единственным источником правды о мире.
 *
 * Сборка живёт в src/world/buildWorld.ts, а не здесь: иначе автопроверка
 * мира не смогла бы поймать регрессию генератора до коммита.
 *
 * Запуск:  npm run generate:world -w @oasis/server
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorld } from '../src/world/buildWorld.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

async function main(): Promise<void> {
  const world = buildWorld();
  const target = resolve(REPO_ROOT, 'content/default/world.json');
  await mkdir(resolve(REPO_ROOT, 'content/default'), { recursive: true });
  await writeFile(target, `${JSON.stringify(world, null, 2)}\n`, 'utf8');

  const propCount = world.zones.reduce((sum, zone) => sum + zone.props.length, 0);
  console.log(
    `[oasis] мир записан: ${target} (секторов: ${world.sectors.length}, зон: ${world.zones.length}, объектов: ${propCount})`,
  );
}

main().catch((error: unknown) => {
  console.error('[oasis] генератор мира упал', error);
  process.exit(1);
});
