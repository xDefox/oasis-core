#!/usr/bin/env node
/**
 * Один процесс — два dev-сервера.
 *
 * Запускает сервер (tsx watch) и клиент (vite) параллельно, подписывает
 * строки префиксами, аккуратно убивает второго при падении первого.
 * Не тянет concurrently/npm-run-all: 40 строк на node:child_process дешевле.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const jobs = [
  { name: 'server', color: '\x1b[36m', args: ['run', 'dev:server'] },
  { name: 'client', color: '\x1b[35m', args: ['run', 'dev:client'] },
];

const RESET = '\x1b[0m';
const children = [];
let shuttingDown = false;

function prefixLine(name, color, chunk) {
  const text = chunk.toString();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    process.stdout.write(`${color}[${name}]${RESET} ${line}\n`);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300).unref();
}

for (const job of jobs) {
  const child = spawn(npm, job.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
    // Windows: .cmd/.bat require a shell; Node 20+ rejects spawn without it (EINVAL).
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.stdout.on('data', (chunk) => prefixLine(job.name, job.color, chunk));
  child.stderr.on('data', (chunk) => prefixLine(job.name, job.color, chunk));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `${job.color}[${job.name}]${RESET} завершился (code=${code ?? 'null'}, signal=${signal ?? '—'})\n`,
    );
    shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
