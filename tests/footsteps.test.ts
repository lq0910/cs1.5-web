/** 功能：回归脚步声起步延迟、停止残留、空中发声和加载后补播问题。时间：2026-10-21；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FootstepCadence } from '../src/game/footsteps.ts';
import { AudioSystem } from '../src/engine/audio.ts';

// 功能：起步首个有效模拟帧立即有声，并保持 300ms 跑步步频。时间：2026-10-21；作者：lq。
test('footsteps start immediately and reset after stopping or jumping', () => {
  const cadence = new FootstepCadence();
  assert.equal(cadence.update(0, true, 250, true, false), true);
  assert.equal(cadence.update(0.29, true, 250, true, false), false);
  assert.equal(cadence.update(0.30, true, 250, true, false), true);
  assert.equal(cadence.update(0.31, true, 0, true, false), false);
  assert.equal(cadence.update(0.32, true, 250, true, false), true);
  assert.equal(cadence.update(0.33, false, 250, true, false), false);
  assert.equal(cadence.update(0.34, true, 250, true, false), true);
  assert.equal(cadence.update(0.35, true, 135, true, false), false);
  assert.equal(cadence.update(0.36, true, 250, true, true), false);
  assert.equal(cadence.update(0.37, true, 250, false, false), false);
  assert.equal(cadence.update(10, true, 250, true, false), true);
  assert.equal(cadence.update(10, true, 250, true, false), false);
});

// 功能：Web Audio 解码完成时不补播已经过期的脚步，缓存后的下一脚立即播放。时间：2026-10-21；作者：lq。
test('late footsteps are discarded and cached footsteps start synchronously', async () => {
  let starts = 0;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldFetch = globalThis.fetch;
  // 功能：用最小音频设备替身观察实际 source.start 调用，无需浏览器声卡。时间：2026-10-21；作者：lq。
  class FakeContext {
    state = 'running';
    destination = {};
    constructor(options: AudioContextOptions) { assert.equal(options.latencyHint, 'interactive'); }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createBufferSource() { return { buffer: null, playbackRate: { value: 1 }, connect() {}, start() { starts++; } }; }
    async decodeAudioData() { return {}; }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeContext } });
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2]));
  try {
    const audio = new AudioSystem();
    await audio.unlock();
    audio.play('sound/player/pl_dirt1.wav', { dropIfNotReady: true });
    await audio.preload(['sound/player/pl_dirt1.wav']);
    assert.equal(starts, 0);
    audio.play('sound/player/pl_dirt1.wav', { dropIfNotReady: true });
    assert.equal(starts, 1);
    audio.play('sound/weapons/reload.wav');
    await audio.preload(['sound/weapons/reload.wav']);
    assert.equal(starts, 2, 'ordinary effects retain their initial-load playback');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
