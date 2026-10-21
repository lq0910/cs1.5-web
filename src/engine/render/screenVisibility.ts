/** 功能：判断玩家是否靠近且能实际看到大屏，兼容屏幕局部入镜和地图墙体遮挡。时间：2026-10-21；作者：lq。 */
import * as THREE from 'three';
import type { CollisionWorld } from '../collision/types.ts';
import type { ScreenPlacement } from './newsScreen.ts';
import { toThree } from './boxGeometry.ts';

/** 功能：限定大屏附近的观看范围，单位与地图一致。时间：2026-10-21；作者：lq。 */
export const LIVE_SCREEN_DISTANCE = 1000;

/** 功能：先裁剪屏幕四边形到视锥，再对可见部分采样射线，避免只检查中心漏掉边缘入镜。时间：2026-10-21；作者：lq。 */
export function canSeeScreen(placement: ScreenPlacement, camera: THREE.Camera, world: CollisionWorld): boolean {
  camera.updateMatrixWorld();
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const normal = new THREE.Vector3(...toThree(placement.normal.x, placement.normal.y, placement.normal.z)).normalize();
  const center = new THREE.Vector3(...toThree(placement.position.x, placement.position.y, placement.position.z)).addScaledVector(normal, 7.1);
  if (eye.distanceTo(center) > LIVE_SCREEN_DISTANCE || eye.clone().sub(center).dot(normal) <= 0) return false;
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  let polygon = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => center.clone()
    .addScaledVector(right, x! * placement.width / 2).addScaledVector(up, y! * placement.height / 2));
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  for (const plane of frustum.planes) {
    const clipped: THREE.Vector3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
      if (da >= 0) clipped.push(a);
      if ((da >= 0) !== (db >= 0)) clipped.push(a.clone().lerp(b, da / (da - db)));
    }
    polygon = clipped;
    if (polygon.length === 0) return false;
  }
  const middle = polygon.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(polygon.length);
  const samples = [middle, ...polygon.map((point) => point.clone().lerp(middle, 0.01)),
    ...polygon.map((point, i) => point.clone().lerp(polygon[(i + 1) % polygon.length]!, 0.5))];
  const start = { x: eye.x, y: -eye.z, z: eye.y };
  const pointHull = { mins: { x: 0, y: 0, z: 0 }, maxs: { x: 0, y: 0, z: 0 } };
  return samples.some((sample) => {
    const hit = world.traceHull(pointHull, start, { x: sample.x, y: -sample.z, z: sample.y });
    return !hit.startsolid && !hit.allsolid && hit.fraction >= 1;
  });
}
