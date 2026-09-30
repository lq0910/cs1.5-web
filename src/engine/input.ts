/**
 * Keyboard/mouse input and pointer lock.
 *
 * Produces a GoldSrc-style UserCmd (forwardmove/sidemove/buttons in the same
 * units the original client uses: +/-400 for movement, IN_* bit flags), so the
 * movement code sees exactly the kind of command a real CS 1.5 client sends.
 */

import {
  CL_FORWARD_SPEED,
  CL_SIDE_SPEED,
  IN_ATTACK,
  IN_ATTACK2,
  IN_BACK,
  IN_DUCK,
  IN_FORWARD,
  IN_JUMP,
  IN_MOVELEFT,
  IN_MOVERIGHT,
  IN_RELOAD,
  IN_USE,
  IN_WALK,
} from '../game/constants.ts';
import type { UserCmd } from '../game/movement.ts';

/** CS 1.5 m_yaw: degrees of view rotation per mouse count. */
const M_YAW = 0.022;
const M_PITCH = 0.022;

export class Input {
  /** Mouse sensitivity, matching CS' `sensitivity` cvar semantics. */
  sensitivity = 3.2;
  inverted = false;

  private readonly keys = new Set<string>();
  private readonly pressedHandlers = new Map<string, () => void>();
  private mouseDX = 0;
  private mouseDY = 0;
  private mouseButtons = 0;
  private attached = false;

  readonly element: HTMLElement;
  onLockChange: ((locked: boolean) => void) | null = null;
  /** 功能：鼠标滚轮切换武器方向回调。时间：2026-09-29；作者：lq。 */
  onWheel: ((direction: number) => void) | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('mousemove', this.handleMouseMove);
    this.element.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    this.element.addEventListener('contextmenu', this.preventContextMenu);
    this.element.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    document.removeEventListener('mousemove', this.handleMouseMove);
    this.element.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    this.element.removeEventListener('contextmenu', this.preventContextMenu);
    this.element.removeEventListener('wheel', this.handleWheel);
  }

  private preventContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    // 功能：Tab 无论首次按下还是长按重复事件都不参与浏览器焦点导航，战绩表只留在游戏内。时间：2026-09-30；作者：lq。
    if (event.code === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.repeat) {
      return;
    }
    this.keys.add(event.code);
    const handler = this.pressedHandlers.get(event.code);
    if (handler) handler();
    // 功能：阻止 Tab 离开游戏画布，使按住 Tab 的战绩表行为与 CS 1.5 一致。时间：2026-09-30；作者：lq。
    if (event.code === 'Space' || event.code === 'Tab' || event.code.startsWith('Arrow')) {
      event.preventDefault();
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    // 功能：阻止 Tab 松开时浏览器恢复焦点选择，确保按住显示、松开隐藏战绩表。时间：2026-09-30；作者：lq。
    if (event.code === 'Tab') event.preventDefault();
    this.keys.delete(event.code);
  };

  private handleBlur = (): void => {
    this.keys.clear();
    this.mouseButtons = 0;
  };

  private handleLockChange = (): void => {
    const locked = document.pointerLockElement === this.element;
    if (!locked) {
      this.keys.clear();
      this.mouseButtons = 0;
    }
    this.onLockChange?.(locked);
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.element) return;
    this.mouseDX += event.movementX;
    this.mouseDY += event.movementY;
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.element) return;
    this.mouseButtons |= 1 << event.button;
    event.preventDefault();
  };

  private handleMouseUp = (event: MouseEvent): void => {
    this.mouseButtons &= ~(1 << event.button);
  };

  /** 功能：锁定鼠标时把滚轮转为上/下一件武器，并阻止页面滚动。时间：2026-09-29；作者：lq。 */
  private handleWheel = (event: WheelEvent): void => {
    if (!this.locked) return;
    event.preventDefault();
    this.onWheel?.(Math.sign(event.deltaY));
  };

  requestPointerLock(): void {
    void this.element.requestPointerLock();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  /** Registers a one-shot handler for a key press (used for R/F/etc.). */
  onPress(code: string, handler: () => void): void {
    this.pressedHandlers.set(code, handler);
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Consumes the accumulated mouse delta, converted to view-angle degrees. */
  consumeLookDelta(): { yaw: number; pitch: number } {
    const scale = M_YAW * this.sensitivity;
    // GoldSrc: viewangles.yaw -= dx * M_YAW. Yaw grows anticlockwise (turning
    // left), so moving the mouse right must *decrease* it. Getting this sign
    // wrong is the classic inverted-look bug.
    const yaw = -this.mouseDX * scale;
    const pitch = this.mouseDY * M_PITCH * this.sensitivity * (this.inverted ? -1 : 1);
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { yaw, pitch };
  }

  /** Builds a UserCmd for the current tick. */
  sampleCommand(cmd: UserCmd): void {
    let forward = 0;
    let side = 0;
    let buttons = 0;

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
      forward += CL_FORWARD_SPEED;
      buttons |= IN_FORWARD;
    }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
      forward -= CL_FORWARD_SPEED;
      buttons |= IN_BACK;
    }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
      side += CL_SIDE_SPEED;
      buttons |= IN_MOVERIGHT;
    }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
      side -= CL_SIDE_SPEED;
      buttons |= IN_MOVELEFT;
    }
    if (this.keys.has('Space')) buttons |= IN_JUMP;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC')) {
      buttons |= IN_DUCK;
    }
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) buttons |= IN_WALK;
    if (this.mouseButtons & 1) buttons |= IN_ATTACK;
    // Browser button 2 is the right mouse button -> bit 2.
    if (this.mouseButtons & 4) buttons |= IN_ATTACK2;
    if (this.keys.has('KeyR')) buttons |= IN_RELOAD;
    // 功能：E 键持续产生原版 IN_USE，供 C4 拆除和拾枪共用。时间：2026-09-30；作者：lq。
    if (this.keys.has('KeyE')) buttons |= IN_USE;

    cmd.forwardmove = forward;
    cmd.sidemove = side;
    cmd.buttons = buttons;
  }
}
