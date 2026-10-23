#!/usr/bin/env node
/**
 * F0-10: нагрузочный тест с ботами.
 */

import { Client } from '@colyseus/sdk';
import { encodeInput, PROTOCOL_VERSION } from '@oasis/protocol';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { url: 'ws://localhost:2567', count: 20, duration: 60 };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--url') out.url = args[i + 1];
    if (args[i] === '--count') out.count = Number(args[i + 1]);
    if (args[i] === '--duration') out.duration = Number(args[i + 1]);
  }
  return out;
}

async function main() {
  const { url, count, duration } = parseArgs();
  console.log(`[load-bots] подключаю ${count} ботов к ${url}, ${duration} с`);
  
  const client = new Client(url);
  const rooms = [];
  const stats = { joined: 0, failed: 0, inputs: 0 };
  
  for (let i = 0; i < count; i += 1) {
    try {
      const room = await client.joinOrCreate('sector', {
        protocolVersion: PROTOCOL_VERSION,
        accountId: `bot_${i}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
        accountCreatedAt: Date.now() - 1000 * 86400 * 30,
        name: `bot-${i}`,
      });
      const rec = [];
      room.onMessage('welcome', () => rec.push('welcome'));
      room.onMessage('error', (e) => { console.error('bot err', e); });
      // Отправляем hello как в тестах
      room.send('hello', { protocolVersion: PROTOCOL_VERSION });
      rooms.push(room);
      stats.joined += 1;
      
      let seq = 0;
      const angle = (Math.PI * 2 * i) / count;
      const ix = setInterval(() => {
        if (!room.connection?.isOpen) return;
        seq += 1;
        try {
          room.sendBytes('bin', encodeInput({
            seq,
            dirX: Math.cos(angle + Date.now() / 5000),
            dirZ: Math.sin(angle + Date.now() / 5000),
            yaw: angle,
            sprint: i % 3 === 0,
          }));
          stats.inputs += 1;
        } catch {}
      }, 33);
      room.onLeave(() => { clearInterval(ix); });
    } catch (e) {
      stats.failed += 1;
    }
  }
  
  console.log(`[load-bots] подключено: ${stats.joined}, ошибок: ${stats.failed}`);
  
  const metrics = setInterval(async () => {
    try {
      const httpUrl = url.replace(/^ws/, 'http').replace(/:\d+$/, ':2567') + '/stats';
      const res = await fetch(httpUrl);
      const data = await res.json();
      if (data.room) {
        console.log(`[stats] players=${data.room.players} entities=${data.room.entities} tick_p50=${data.room.tickMs?.p50?.toFixed(2)}ms tick_p95=${data.room.tickMs?.p95?.toFixed(2)}ms bytes/s=${data.room.bytesOutBps}`);
      } else {
        console.log(`[stats] room=null`);
      }
    } catch (e) {
      // ignore
    }
  }, 5000);
  
  await new Promise(r => setTimeout(r, duration * 1000));
  
  clearInterval(metrics);
  console.log('[load-bots] итого: inputs отправлено', stats.inputs);
  
  for (const room of rooms) {
    try { await room.leave(); } catch {}
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
