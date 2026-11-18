/** 功能：将真实帧时间转换成有限的固定模拟步，丢弃卡顿积压以防恢复后持续快进；时间：2026-11-18；作者：lq。 */
import { TICK_INTERVAL } from './constants.ts';

export function fixedFrameSteps(accumulator: number, elapsed: number): { steps: number; remainder: number } {
  const total = accumulator + Math.max(0, Math.min(elapsed, 0.25));
  const available = Math.floor((total + 1e-10) / TICK_INTERVAL);
  return { steps: Math.min(available, 8), remainder: Math.max(0, total - available * TICK_INTERVAL) };
}
