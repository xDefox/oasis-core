#!/usr/bin/env node
/**
 * Автопроверка мира под коллизии (F1-20).
 *
 * Правила живут в `packages/server/src/world/worldCheck.ts`, здесь только
 * прогон по закоммиченному content/default/world.json и внятный отчёт:
 * сколько ловушек, какие порталы забиты, чисто ли кольцо спавна.
 *
 * Запуск:  node --import tsx scripts/world-check.ts
 * Падает с кодом 1 — в CI это красит джобу.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorldDef } from '../packages/protocol/src/index.ts';
import { checkWorld, zoneStats } from '../packages/server/src/world/worldCheck.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const worldPath = resolve(REPO_ROOT, 'content/default/world.json');

const world = JSON.parse(await readFile(worldPath, 'utf8')) as WorldDef;
const issues = checkWorld(world);

console.log(`мир: ${world.id} (seed ${world.seed})`);
for (const stat of zoneStats(world)) {
  console.log(`  ${stat.id}: объектов ${stat.props}, блокирующих тело ${stat.blockers}`);
}
console.log(`  порталов: ${world.portals.length}, секторов: ${world.sectors.length}`);

if (issues.length > 0) {
  console.error(`\n❌ мир не проходит автопроверку: ${issues.length} нарушений`);
  for (const issue of issues) console.error(`  [${issue.rule}] ${issue.message}`);
  process.exit(1);
}

console.log('\n✅ мир проходит автопроверку: зазоры, порталы и спавн в норме');
