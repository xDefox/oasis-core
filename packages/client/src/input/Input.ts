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

  /** Одноразовый запрос прыжка (Space, без автоповтора). */
  private jumpQueued = false;
  /** Желаемая дистанция камеры (колёсико), м. */
  private _cameraDistance = 4.2;

  private readonly canvas: HTMLCanvasElement;
  private pointerLocked = false;
  private readonly onLockChange: (locked: boolean) => void;
  private readonly cameraDistanceMin: number;
  private readonly cameraDistanceMax: number;

  constructor(
    canvas: HTMLCanvasElement,
    onLockChange: (locked: boolean) => void,
    cameraDistance = { default: 4.2, min: 1.6, max: 7.5 },
  ) {
    this.canvas = canvas;
    this.onLockChange = onLockChange;
    this._cameraDistance = cameraDistance.default;
    this.cameraDistanceMin = cameraDistance.min;
    this.cameraDistanceMax = cameraDistance.max;

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.jumpQueued = false;
    });

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
      // Чуть уже вверх: иначе камера уходит под пол за спиной.
      const limitUp = Math.PI / 2 - 0.18;
      const limitDown = Math.PI / 2 - 0.05;
      this.pitch = Math.max(-limitDown, Math.min(limitUp, this.pitch));
    });

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.pointerLocked) return;
        event.preventDefault();
        // deltaY > 0 — отдаляем.
        this._cameraDistance = Math.min(
          this.cameraDistanceMax,
          Math.max(this.cameraDistanceMin, this._cameraDistance + event.deltaY * 0.004),
        );
      },
      { passive: false },
    );
  }

  get cameraDistance(): number {
    return this._cameraDistance;
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
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) this.jumpQueued = true;
    }
  }

  /** Забирает одно нажатие Space (для предсказания и отправки на сервер). */
  consumeJump(): boolean {
    const pressed = this.jumpQueued;
    this.jumpQueued = false;
    return pressed;
  }

  /** Вернуть управление: вызывается по клику, когда чат закрыт. */
  requestControl(): void {
    if (!this.pointerLocked) void this.canvas.requestPointerLock();
  }

  get locked(): boolean {
    return this.pointerLocked;
  }

  get sprinting(): boolean {
    // Присед важнее бега: Shift+Ctrl = присед.
    if (this.crouching) return false;
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Ctrl — приседание. */
  get crouching(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight');
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
