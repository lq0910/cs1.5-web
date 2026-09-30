/**
 * Three.js world renderer.
 *
 * The simulation runs in GoldSrc's Z-up space; boxGeometry.ts is the only place
 * that converts to Three.js' Y-up space. Wall geometry is emitted with
 * world-space planar UVs, exactly how the GoldSrc map compiler projects
 * textures, so adjacent boxes tile seamlessly.
 */

import * as THREE from 'three';
import type { Vec3 } from '../math.ts';
import type { BoxDef } from '../collision/brush.ts';
import { getMaterial } from './textures.ts';
import { createSkyTexture } from './textures.ts';
import { makeGeometryArrays, toThree, verticalFovForHorizontal, writeBoxGeometry } from './boxGeometry.ts';

export { toThree, verticalFovForHorizontal };

export interface RendererInfo {
  webglVersion: number;
  drawCalls: number;
  triangles: number;
  materials: number;
}

export class WorldRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly webgl: THREE.WebGLRenderer;
  private readonly worldGroup: THREE.Group;
  private lastStats: RenderStats = { drawCalls: 0, triangles: 0 };
  private viewScene: THREE.Scene | null = null;
  private viewCamera: THREE.PerspectiveCamera | null = null;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private disposed = false;

  /** Horizontal FOV in degrees; the AWP scope narrows this. */
  fovHorizontal: number;

  constructor(container: HTMLElement, fovHorizontal = 90) {
    this.fovHorizontal = fovHorizontal;
    this.webgl = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.webgl.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = createSkyTexture();

    this.camera = new THREE.PerspectiveCamera(fovHorizontal, 1, 4, 16384);
    this.camera.rotation.order = 'YXZ';

    this.hemisphere = new THREE.HemisphereLight(0xdfeaf5, 0x6b6252, 1.15);
    this.scene.add(this.hemisphere);

    this.sun = new THREE.DirectionalLight(0xfff2d8, 1.05);
    const sunDirection = new THREE.Vector3(0.45, 0.82, -0.35).normalize();
    this.sun.position.copy(sunDirection.multiplyScalar(2048));
    this.scene.add(this.sun);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.scene.fog = new THREE.Fog(0xa8bccd, 1800, 9000);
  }

  /** Builds and adds the render geometry for a list of boxes, merged per material. */
  addBoxes(boxes: BoxDef[]): void {
    const byMaterial = new Map<string, BoxDef[]>();
    for (const b of boxes) {
      const name = b.material ?? 'concrete';
      const list = byMaterial.get(name);
      if (list) list.push(b);
      else byMaterial.set(name, [b]);
    }

    for (const [name, list] of byMaterial) {
      const { material, tileUnits } = getMaterial(name);
      const arrays = makeGeometryArrays();
      writeBoxGeometry(list, tileUnits, arrays);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(arrays.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(arrays.uvs, 2));
      geometry.setIndex(arrays.indices);
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.worldGroup.add(mesh);
    }
  }

  /** Adds a prebuilt object (used by the BSP loader for world geometry). */
  addObject(object: THREE.Object3D): void {
    this.worldGroup.add(object);
  }

  /** Removes everything currently in the world (for map switching). */
  clearWorld(): void {
    for (const child of [...this.worldGroup.children]) {
      this.worldGroup.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
  }

  /** Swaps the background: a real skybox when available, else a gradient. */
  setSky(texture: THREE.CubeTexture | null, top = 0x4d7fb3, horizon = 0xd7e6f2): void {
    if (texture) {
      this.scene.background = texture;
      return;
    }
    this.scene.background = createSkyTexture(top, horizon);
  }

  setWorldLighting(intensity = 1.05): void {
    this.sun.intensity = intensity;
    this.hemisphere.intensity = intensity;
  }

  setFog(color: number, near: number, far: number): void {
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(color);
    fog.near = near;
    fog.far = far;
  }

  /**
   * Positions the camera from the simulation state.
   * `pitch`/`yaw` are GoldSrc view angles in degrees (pitch positive = down).
   */
  setView(origin: Vec3, pitch: number, yaw: number): void {
    const [x, y, z] = toThree(origin.x, origin.y, origin.z);
    this.camera.position.set(x, y, z);
    this.camera.rotation.set((-pitch * Math.PI) / 180, (yaw * Math.PI) / 180 - Math.PI / 2, 0);
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.webgl.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = verticalFovForHorizontal(this.fovHorizontal, aspect);
    this.camera.updateProjectionMatrix();
    if (this.viewCamera) {
      this.viewCamera.aspect = aspect;
      this.viewCamera.updateProjectionMatrix();
    }
  }

  /**
   * Counters for the HUD.
   *
   * three.js resets `info` at the start of every render() call, and the view
   * model is a second pass — reading info here without the snapshot below would
   * report only the weapon (6 calls / 72 triangles) and hide a missing world.
   */
  info(): RendererInfo {
    return {
      webglVersion: this.webgl.capabilities.isWebGL2 ? 2 : 1,
      drawCalls: this.lastStats.drawCalls,
      triangles: this.lastStats.triangles,
      materials: byMaterialCount(this.worldGroup),
    };
  }

  /**
   * Sets the first-person overlay scene. It is drawn in a second pass with a
   * cleared depth buffer, which is how the original engine keeps the weapon from
   * poking through walls.
   */
  setViewScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.viewScene = scene;
    this.viewCamera = camera;
  }

  render(): void {
    if (this.disposed) return;
    this.lastStats = renderTwoPass(
      this.webgl,
      this.scene,
      this.camera,
      this.viewScene,
      this.viewCamera,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.clearWorld();
    this.webgl.dispose();
    this.webgl.domElement.remove();
  }
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
}

/** The subset of three.js's renderer this function drives (kept structural so
 * the two-pass logic can be unit tested without a WebGL context). */
export interface TwoPassTarget {
  autoClear: boolean;
  clearDepth(): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  info: { render: { calls: number; triangles: number } };
}

/**
 * Draws the world and then the first-person weapon as an overlay.
 *
 * The overlay pass must run with autoClear **off**: three.js clears the colour
 * buffer at the start of every render() call, so leaving it on wipes the world
 * and leaves a black frame containing nothing but the gun. Only the depth buffer
 * is cleared, which is what keeps the weapon out of the walls.
 */
export function renderTwoPass(
  target: TwoPassTarget,
  scene: THREE.Scene,
  camera: THREE.Camera,
  viewScene: THREE.Scene | null,
  viewCamera: THREE.Camera | null,
): RenderStats {
  target.autoClear = true;
  target.render(scene, camera);
  let drawCalls = target.info.render.calls;
  let triangles = target.info.render.triangles;

  if (viewScene && viewCamera) {
    target.autoClear = false;
    target.clearDepth();
    target.render(viewScene, viewCamera);
    target.autoClear = true;
    drawCalls += target.info.render.calls;
    triangles += target.info.render.triangles;
  }

  return { drawCalls, triangles };
}

function byMaterialCount(group: THREE.Group): number {
  let count = 0;
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) count++;
  });
  return count;
}
