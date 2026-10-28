/**
 * Команды чата (F1-21): временный интерфейс действий.
 *
 * Кнопки — это клиент, а клиент в карте владения (docs/11) у B. Чтобы
 * добыча существовала уже сейчас, действие запускается командой: `/gather`.
 * Когда появятся кнопки, они вызовут те же хендлеры — логика от этого не
 * изменится, изменится только то, кто её запускает.
 *
 * Команда — текст, начинающийся с `/`. Всё остальное остаётся репликой в чат.
 */

export interface ParsedCommand {
  /** Имя в нижнем регистре: `/GATHER` — та же команда, что `/gather`. */
  name: string;
  /** Аргументы, разделённые пробелами. */
  args: string[];
}

/** `/gather` → `{ name: 'gather', args: [] }`; обычный текст и `/` — не команда. */
export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0];
  if (!name) return null;
  return { name: name.toLowerCase(), args: parts.slice(1) };
}
