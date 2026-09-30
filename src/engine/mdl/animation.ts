/**
 * 功能：读取 GoldSrc Studio 模型的原版动作帧并计算各骨骼世界变换。
 * 时间：2026-09-29；作者：lq。
 */
import * as THREE from 'three';
import type { Mdl, MdlSequence } from './parser.ts';

export interface BonePose {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
}

/** 功能：解码 Studio 动作值的游程块，获得指定帧的有符号通道值。时间：2026-09-29；作者：lq。 */
function readChannel(bytes: Uint8Array, offset: number, frame: number): number {
  let cursor = offset;
  let remaining = frame;
  for (let block = 0; block < 1000 && cursor + 2 <= bytes.length; block++) {
    const valid = bytes[cursor]!;
    const total = bytes[cursor + 1]!;
    if (total === 0 || valid === 0 || valid > total || cursor + 2 + valid * 2 > bytes.length) return 0;
    if (remaining < total) {
      const sample = Math.min(remaining, valid - 1);
      return new DataView(bytes.buffer, bytes.byteOffset + cursor + 2 + sample * 2, 2).getInt16(0, true);
    }
    remaining -= total;
    cursor += 2 + valid * 2;
  }
  return 0;
}

/** 功能：按原版动作序列采样姿态，供人物持枪和第一人称枪械使用。时间：2026-09-29；作者：lq。 */
export function samplePose(mdl: Mdl, sequence: MdlSequence | null, frame = 0, pitch = 0): BonePose[] {
  const bytes = mdl.bytes;
  const sampledFrame = sequence ? Math.max(0, Math.min(sequence.numFrames - 1, Math.floor(frame))) : 0;
  // 功能：9 档瞄准动作按 -90° 至 +90° 插值；中间第 5 档才是水平视角。时间：2026-09-29；作者：lq。
  const blend = sequence && sequence.numBlends === 9 && sequence.blendEnd !== sequence.blendStart
    ? Math.max(0, Math.min(sequence.numBlends - 1, (pitch - sequence.blendStart) / (sequence.blendEnd - sequence.blendStart) * (sequence.numBlends - 1)))
    : 0;
  const lowerBlend = Math.floor(blend);
  const upperBlend = Math.ceil(blend);
  const fraction = blend - lowerBlend;
  const poses: BonePose[] = [];
  for (const [index, bone] of mdl.bones.entries()) {
    const translation = [...bone.value];
    const angles = [...bone.rotation];
    if (sequence && sequence.seqGroup === 0) {
      const animAt = sequence.animIndex + (lowerBlend * mdl.bones.length + index) * 12;
      const upperAnimAt = sequence.animIndex + (upperBlend * mdl.bones.length + index) * 12;
      if (animAt >= 0 && animAt + 12 <= bytes.length) {
        const table = new DataView(bytes.buffer, bytes.byteOffset + animAt, 12);
        const upperTable = fraction > 0 && upperAnimAt + 12 <= bytes.length
          ? new DataView(bytes.buffer, bytes.byteOffset + upperAnimAt, 12) : null;
        for (let channel = 0; channel < 6; channel++) {
          const relative = table.getUint16(channel * 2, true);
          const upperRelative = upperTable?.getUint16(channel * 2, true) ?? 0;
          if (!relative && !upperRelative) continue;
          const lowerValue = relative ? readChannel(bytes, animAt + relative, sampledFrame) : 0;
          const upperValue = upperRelative ? readChannel(bytes, upperAnimAt + upperRelative, sampledFrame) : 0;
          const value = (lowerValue + (upperValue - lowerValue) * fraction) * bone.scale[channel]!;
          if (channel < 3) translation[channel] = bone.value[channel]! + value;
          else angles[channel - 3] = bone.rotation[channel - 3]! + value;
        }
      }
    }
    const localPosition = new THREE.Vector3(translation[0], translation[1], translation[2]);
    const localRotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(angles[0], angles[1], angles[2], 'ZYX'),
    );
    const parent = bone.parent >= 0 && bone.parent < index ? poses[bone.parent] : null;
    if (!parent) {
      poses.push({ position: localPosition, rotation: localRotation });
      continue;
    }
    poses.push({
      position: localPosition.applyQuaternion(parent.rotation).add(parent.position),
      rotation: parent.rotation.clone().multiply(localRotation),
    });
  }
  return poses;
}
