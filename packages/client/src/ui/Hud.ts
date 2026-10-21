/**
 * HUD: статус, статистика, чат.
 *
 * Чистый DOM — так текст остаётся текстом (доступность, копирование,
 * никаких шейдерных трюков ради трёх строчек).
 */

export interface HudCallbacks {
  onChat(text: string): void;
  onChatFocusChange(focused: boolean): void;
}

export class Hud {
  private readonly statusText = document.getElementById('status-text') as HTMLElement;
  private readonly statusDot = document.getElementById('status-dot') as HTMLElement;
  private readonly stats = document.getElementById('stats') as HTMLElement;
  private readonly statFps = document.getElementById('stat-fps') as HTMLElement;
  private readonly statPing = document.getElementById('stat-ping') as HTMLElement;
  private readonly statPlayers = document.getElementById('stat-players') as HTMLElement;
  private readonly statBackend = document.getElementById('stat-backend') as HTMLElement;
  private readonly statBalance = document.getElementById('stat-balance') as HTMLElement;
  private readonly chatLog = document.getElementById('chat-log') as HTMLElement;
  private readonly chatForm = document.getElementById('chat-form') as HTMLFormElement;
  private readonly chatInput = document.getElementById('chat-input') as HTMLInputElement;
  private readonly crosshair = document.getElementById('crosshair') as HTMLElement;
  private readonly hint = document.getElementById('hint') as HTMLElement;

  private chatFocused = false;

  private readonly callbacks: HudCallbacks;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.chatInput.value.trim();
      this.chatInput.value = '';
      if (text) this.callbacks.onChat(text);
      this.setChatFocused(false);
    });

    this.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.chatInput.value = '';
        this.setChatFocused(false);
      }
      event.stopPropagation();
    });

    this.chatInput.addEventListener('blur', () => this.setChatFocused(false));
  }

  setStatus(kind: 'connecting' | 'open' | 'closed' | 'error', detail?: string): void {
    this.statusDot.className = `dot ${
      kind === 'open' ? 'dot-ok' : kind === 'error' || kind === 'closed' ? 'dot-err' : 'dot-warn'
    }`;
    const labels = {
      connecting: 'подключение…',
      open: 'в сети',
      closed: 'соединение закрыто',
      error: 'ошибка',
    };
    this.statusText.textContent = detail ? `${labels[kind]} (${detail})` : labels[kind];
  }

  setStats(fps: number, ping: number, players: number, backend: string, balance: number): void {
    this.stats.hidden = false;
    this.statFps.textContent = `${fps} fps`;
    this.statPing.textContent = `${ping} ms`;
    this.statPlayers.textContent = `${players} игроков`;
    this.statBackend.textContent = backend;
    this.statBalance.textContent = `${balance} ¤`;
  }

  setCrosshair(visible: boolean): void {
    this.crosshair.hidden = !visible;
  }

  /** Открывает поле ввода чата (Enter). */
  focusChat(): void {
    this.setChatFocused(true);
  }

  get isChatFocused(): boolean {
    return this.chatFocused;
  }

  private setChatFocused(focused: boolean): void {
    if (this.chatFocused === focused) return;
    this.chatFocused = focused;
    this.chatForm.hidden = !focused;
    this.hint.style.opacity = focused ? '0.25' : '1';
    if (focused) {
      this.chatInput.focus();
    } else {
      this.chatInput.blur();
    }
    this.callbacks.onChatFocusChange(focused);
  }

  addChatLine(who: string | null, text: string): void {
    const line = document.createElement('div');
    line.className = who ? 'chat-line' : 'chat-line system';
    if (who) {
      const name = document.createElement('span');
      name.className = 'who';
      name.textContent = `${who}:`;
      line.appendChild(name);
    }
    line.appendChild(document.createTextNode(text));
    this.chatLog.appendChild(line);

    while (this.chatLog.childElementCount > 60) {
      this.chatLog.removeChild(this.chatLog.firstChild!);
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }
}
