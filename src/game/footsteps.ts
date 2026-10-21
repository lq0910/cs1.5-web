/** 功能：管理原版风格的落脚节奏，起步即触发，落地/停止后重置，慢走和蹲行静音。时间：2026-10-21；作者：lq。 */
export class FootstepCadence {
  private wasMoving = false;
  private nextAt = 0;

  /** 功能：只对当前模拟时刻发出一次脚步，低帧率时不积压补播旧声音。时间：2026-10-21；作者：lq。 */
  update(now: number, grounded: boolean, speed: number, alive: boolean, crouched: boolean): boolean {
    const moving = grounded && speed > 140 && alive && !crouched;
    const emit = moving && (!this.wasMoving || now >= this.nextAt);
    if (emit) this.nextAt = now + (speed > 210 ? 0.30 : 0.40);
    this.wasMoving = moving;
    return emit;
  }
}
