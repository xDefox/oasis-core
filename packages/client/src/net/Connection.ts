/**
 * Транспорт: подключение к сектору, приём сообщений, отправка ввода.
 *
 * Тонкий слой над @colyseus/sdk. Всё, что касается формата сообщений,
 * живёт в @oasis/protocol — здесь только доставка.
 */

import { Client, type Room } from '@colyseus/sdk';

import {
  BIN_CHANNEL,
  C2S,
  PROTOCOL_VERSION,
  encodeInput,
  type ChatBroadcastMsg,
  type ErrorMsg,
  type HelloMsg,
  type InputMsg,
  type RosterMsg,
  type TeleportMsg,
  type WelcomeMsg,
  type ZoneMsg,
} from '@oasis/protocol';

export interface ConnectionHandlers {
  onWelcome(message: WelcomeMsg): void;
  onRoster(message: RosterMsg): void;
  onChat(message: ChatBroadcastMsg): void;
  onZone(message: ZoneMsg): void;
  onTeleport(message: TeleportMsg): void;
  onBalance(message: { balance: number; reason: string }): void;
  onBinary(payload: Uint8Array): void;
  onError(message: ErrorMsg): void;
  onStatus(status: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void;
}

export class Connection {
  private room: Room | null = null;

  get connected(): boolean {
    return this.room !== null;
  }

  async connect(serverUrl: string, hello: HelloMsg, handlers: ConnectionHandlers): Promise<void> {
    handlers.onStatus('connecting', serverUrl);

    const client = new Client(serverUrl);
    const room = await client.joinOrCreate('sector', hello);
    this.room = room;

    room.onMessage('welcome', (message: WelcomeMsg) => handlers.onWelcome(message));
    room.onMessage('roster', (message: RosterMsg) => handlers.onRoster(message));
    room.onMessage('chat', (message: ChatBroadcastMsg) => handlers.onChat(message));
    room.onMessage('zone', (message: ZoneMsg) => handlers.onZone(message));
    room.onMessage('teleport', (message: TeleportMsg) => handlers.onTeleport(message));
    room.onMessage('balance', (message: { balance: number; reason: string }) =>
      handlers.onBalance(message),
    );
    room.onMessage('error', (message: ErrorMsg) => handlers.onError(message));
    room.onMessage(BIN_CHANNEL, (payload: Uint8Array) => handlers.onBinary(payload));

    room.onError((code, message) => handlers.onStatus('error', `${code}: ${message}`));
    room.onLeave(() => handlers.onStatus('closed'));

    // Явный handshake: сервер присылает мир только в ответ на hello.
    // Это гарантирует, что обработчики выше уже зарегистрированы.
    room.send(C2S.Hello, { protocolVersion: PROTOCOL_VERSION });

    handlers.onStatus('open');
  }

  /** Ввод идёт бинарным: 30 Гц × N игроков — заметная доля трафика. */
  sendInput(input: InputMsg): void {
    this.room?.sendBytes(BIN_CHANNEL, encodeInput(input));
  }

  sendChat(text: string): void {
    this.room?.send(C2S.Chat, { text });
  }

  requestZone(zoneId: string): void {
    this.room?.send(C2S.ZoneRequest, { zoneId });
  }

  ping(t: number): void {
    this.room?.send(C2S.Ping, { t });
  }

  leave(): void {
    void this.room?.leave();
    this.room = null;
  }
}
