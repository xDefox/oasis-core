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
  type PongMsg,
  type RenamedMsg,
  type RosterMsg,
  type TeleportMsg,
  type WelcomeMsg,
  type ZoneMsg,
} from '@oasis/protocol';

/**
 * Паузы между попытками восстановить связь. Три попытки — примерно 6 секунд:
 * за это время либо сеть вернулась, либо проблема не в ней.
 */
const RECONNECT_DELAYS_MS = [500, 1500, 4000];

export interface ConnectionHandlers {
  onWelcome(message: WelcomeMsg): void;
  onRoster(message: RosterMsg): void;
  onChat(message: ChatBroadcastMsg): void;
  onZone(message: ZoneMsg): void;
  onTeleport(message: TeleportMsg): void;
  onBalance(message: { balance: number; reason: string }): void;
  onBinary(payload: Uint8Array): void;
  onPong(message: PongMsg): void;
  onError(message: ErrorMsg): void;
  onRenamed(message: RenamedMsg): void;
  onStatus(status: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void;
}

export class Connection {
  private room: Room | null = null;
  private closed = false;

  private url = '';
  private hello: HelloMsg | null = null;
  private handlers: ConnectionHandlers | null = null;
  /** Токен места: сервер вернёт нас туда же после обрыва. */
  private resumeToken: string | null = null;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  /** Явный выход: переподключаться не надо. */
  private intentional = false;
  /** Растёт на каждый вход — чтобы поздний ответ старой попытки не победил. */
  private generation = 0;

  get connected(): boolean {
    return this.room !== null && !this.closed;
  }

  async connect(serverUrl: string, hello: HelloMsg, handlers: ConnectionHandlers): Promise<void> {
    this.url = serverUrl;
    this.hello = hello;
    this.handlers = handlers;
    this.resumeToken = hello.resume ?? null;
    this.intentional = false;
    this.attempt = 0;
    await this.open(this.resumeToken);
  }

  /** Один вход в комнату. Переиспользуется и первой попыткой, и повторами. */
  private async open(resume: string | null): Promise<void> {
    const handlers = this.handlers;
    const hello = this.hello;
    if (!handlers || !hello) throw new Error('connect() не вызывался');

    const generation = ++this.generation;
    handlers.onStatus('connecting', this.url);

    const client = new Client(this.url);
    const room = await client.joinOrCreate('sector', { ...hello, ...(resume ? { resume } : {}) });
    // Пока мы подключались, начали новую попытку или вышли совсем.
    if (generation !== this.generation) {
      void room.leave();
      return;
    }
    this.room = room;
    this.closed = false;
    // Переподключением управляем сами: у нас свой handshake (hello → welcome),
    // и тихий ре-аттач SDK оставил бы клиент без мира.
    room.reconnection.enabled = false;

    room.onMessage('welcome', (message: WelcomeMsg) => {
      // Связь есть — счётчик попыток обнуляем.
      this.attempt = 0;
      this.resumeToken = message.resumeToken;
      handlers.onWelcome(message);
    });
    room.onMessage('roster', (message: RosterMsg) => handlers.onRoster(message));
    room.onMessage('chat', (message: ChatBroadcastMsg) => handlers.onChat(message));
    room.onMessage('zone', (message: ZoneMsg) => handlers.onZone(message));
    room.onMessage('teleport', (message: TeleportMsg) => handlers.onTeleport(message));
    room.onMessage('balance', (message: { balance: number; reason: string }) =>
      handlers.onBalance(message),
    );
    room.onMessage('pong', (message: PongMsg) => handlers.onPong(message));
    room.onMessage('error', (message: ErrorMsg) => handlers.onError(message));
    room.onMessage('renamed', (message: RenamedMsg) => handlers.onRenamed(message));
    room.onMessage(BIN_CHANNEL, (payload: Uint8Array) => handlers.onBinary(payload));

    room.onError((code, message) => {
      handlers.onStatus('error', `${code}: ${message}`);
    });
    room.onLeave((code) => {
      this.markClosed();
      // 4003 — место забрало новое соединение (тот же игрок в другой вкладке/после F5).
      // Переподключаться не надо: токен уже заменён, старое соединение больше ни к чему.
      if (this.intentional || code === 4003) {
        handlers.onStatus('closed');
        return;
      }
      this.scheduleReconnect();
    });

    // Явный handshake: сервер присылает мир только в ответ на hello.
    // Это гарантирует, что обработчики выше уже зарегистрированы.
    room.send(C2S.Hello, { protocolVersion: PROTOCOL_VERSION });

    handlers.onStatus('open');
  }

  /**
   * Повторные попытки входа после обрыва.
   *
   * Паузы растут: 0.5 с, 1.5 с, 4 с. Первая попытка почти всегда успевает
   * раньше, чем сервер вообще заметит, что мы пропали, — поэтому ждать
   * дольше незачем, а настойчиво долбить сервер при реальной аварии тоже
   * не нужно.
   */
  private scheduleReconnect(): void {
    const handlers = this.handlers;
    if (!handlers || this.intentional) return;

    const delay = RECONNECT_DELAYS_MS[this.attempt];
    if (delay === undefined) {
      handlers.onStatus('error', 'связь не восстановилась — перезагрузите страницу');
      return;
    }
    this.attempt += 1;
    handlers.onStatus(
      'connecting',
      `восстановление связи, попытка ${this.attempt} из ${RECONNECT_DELAYS_MS.length}`,
    );

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.open(this.resumeToken).catch((error: unknown) => {
        this.markClosed();
        handlers.onStatus('error', `не удалось восстановить связь: ${String(error)}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private markClosed(): void {
    this.closed = true;
    this.room = null;
  }

  /** Ввод идёт бинарным: 30 Гц × N игроков — заметная доля трафика. */
  sendInput(input: InputMsg): void {
    if (!this.connected) return;
    this.room?.sendBytes(BIN_CHANNEL, encodeInput(input));
  }

  sendChat(text: string): void {
    if (!this.connected) return;
    this.room?.send(C2S.Chat, { text });
  }

  rename(name: string): void {
    if (!this.connected) return;
    this.room?.send(C2S.Rename, { name });
  }

  requestZone(zoneId: string): void {
    if (!this.connected) return;
    this.room?.send(C2S.ZoneRequest, { zoneId });
  }

  ping(t: number): void {
    if (!this.connected) return;
    this.room?.send(C2S.Ping, { t });
  }

  leave(): void {
    this.intentional = true;
    this.generation += 1;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const room = this.room;
    this.markClosed();
    if (room) void room.leave();
  }
}
