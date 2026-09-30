/**
 * Sound playback.
 *
 * All samples come from the user's own Counter-Strike installation (extracted
 * into public/cstrike/sound/), so the gun sounds are the real ones. Decoding
 * happens once per file through Web Audio; playback applies distance attenuation
 * and a little pitch randomisation, the way GoldSrc does.
 *
 * The AudioContext can only start after a user gesture, hence `unlock()`.
 */

import type { Vec3 } from './math.ts';

export interface PlayOptions {
  volume?: number;
  rate?: number;
  /** Distance in world units after which the sound is inaudible. */
  maxDistance?: number;
}

const DEFAULT_MAX_DISTANCE = 2400;

export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();

  /** Overall volume, 0..1. */
  volume = 0.65;
  /** Listener position (GoldSrc units) for distance attenuation. */
  listener: Vec3 = { x: 0, y: 0, z: 0 };

  get ready(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /** Must be called from a user gesture (click / pointer lock). */
  async unlock(): Promise<void> {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** Loads (and caches) a sound. Missing files are remembered and skipped. */
  load(name: string): Promise<void> {
    if (this.buffers.has(name) || this.failed.has(name)) return Promise.resolve();
    const existing = this.loading.get(name);
    if (existing) return existing;

    const task = (async () => {
      try {
        const response = await fetch(`cstrike/${name}`, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (!this.context) {
          // No AudioContext yet (no user gesture). Keep the bytes out of the way;
          // preload() is retried after unlock().
          throw new Error('audio context not ready');
        }
        const buffer = await this.context.decodeAudioData(bytes);
        this.buffers.set(name, buffer);
      } catch {
        this.failed.add(name);
      } finally {
        this.loading.delete(name);
      }
    })();

    this.loading.set(name, task);
    return task;
  }

  /** Preloads a list of sounds, tolerating failures. */
  async preload(names: string[]): Promise<void> {
    await Promise.all([...new Set(names)].map((name) => this.load(name)));
  }

  /** Clears the failure cache so sounds can be retried after unlocking audio. */
  retryFailed(): void {
    this.failed.clear();
  }

  play(name: string, options: PlayOptions = {}): void {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.context || !this.master) {
      // 功能：未预载完成的首次音效在解码后立即播放，避免第一次换弹静音。时间：2026-09-29；作者：lq。
      if (this.context && this.master) void this.load(name).then(() => {
        if (this.buffers.has(name)) this.play(name, options);
      });
      return;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;

    const gain = this.context.createGain();
    gain.gain.value = options.volume ?? 1;

    source.connect(gain);
    gain.connect(this.master);
    source.start();
  }

  /** Plays a sound in the world, attenuated by distance from the listener. */
  playAt(name: string, position: Vec3, options: PlayOptions = {}): void {
    const dx = position.x - this.listener.x;
    const dy = position.y - this.listener.y;
    const dz = position.z - this.listener.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
    if (distance >= maxDistance) return;

    // Squared falloff, clamped so nearby sounds are not deafening.
    const t = 1 - distance / maxDistance;
    const attenuation = Math.min(1, t * t * 1.6);

    this.play(name, { ...options, volume: (options.volume ?? 1) * attenuation });
  }

  /** Picks a random entry from a list of sound names (CS randomises gunshots). */
  playRandom(names: string[], options: PlayOptions = {}): void {
    if (names.length === 0) return;
    const name = names[Math.floor(Math.random() * names.length)]!;
    this.play(name, {
      ...options,
      // Slight pitch variation keeps repeated shots from sounding robotic.
      rate: (options.rate ?? 1) * (0.97 + Math.random() * 0.06),
    });
  }
}
