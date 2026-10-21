/**
 * Ввод: клавиатура + мышь.
 *
 * Направление движения считается сразу в мировых координатах —
 * так серверу не нужно знать про угол камеры, а клиент и сервер
 * одинаково считают вектор «куда идём».
 */

export interface MoveDirection {
  x: number;
  z: number;
}

export class Input {
  readonly keys = new Set<string>();

  /** Курс камеры, радианы. 0 — взгляд вдоль −Z. */
  yaw = 0;
  /** Наклон камеры, радианы (вверх — положительный). */
  pitch = -0.12;

  private readonly canvas: HTMLCanvasElement;
  private pointerLocked = false;
  private readonly onLockChange: (locked: boolean) => void;

  constructor(canvas: HTMLCanvasElement, onLockChange: (locked: boolean) => void) {
    this.canvas = canvas;
    this.onLockChange = onLockChange;

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('click', () => {
      if (!this.pointerLocked) void canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      this.onLockChange(this.pointerLocked);
    });

    document.addEventListener('mousemove', (event) => {
      if (!this.pointerLocked) return;
      this.yaw -= event.movementX * 0.0022;
      this.pitch -= event.movementY * 0.0022;
      const limit = Math.PI / 2 - 0.05;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Не перехватываем ввод, когда пользователь печатает в чате.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    this.keys.add(event.code);
    if (event.code === 'Tab') {
      event.preventDefault();
      if (this.pointerLocked) document.exitPointerLock();
    }
  }

  get locked(): boolean {
    return this.pointerLocked;
  }

  get sprinting(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Направление движения в мировых координатах, нормализованное. */
  moveDirection(): MoveDirection {
    let forward = 0;
    let strafe = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;

    if (forward === 0 && strafe === 0) return { x: 0, z: 0 };

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    // Вперёд по −Z, вправо по +X (при yaw = 0).
    const forwardX = -sin;
    const forwardZ = -cos;
    const rightX = cos;
    const rightZ = -sin;

    let x = forwardX * forward + rightX * strafe;
    let z = forwardZ * forward + rightZ * strafe;
    const length = Math.hypot(x, z);
    if (length > 0) {
      x /= length;
      z /= length;
    }
    return { x, z };
  }
}
