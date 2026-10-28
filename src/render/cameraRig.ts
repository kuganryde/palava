import * as THREE from 'three';
import { clamp } from '../core/math';

/**
 * Isometric orthographic camera with damped pan, zoom and 90-degree rotation steps.
 * Yaw 0 looks along -Z; the default (PI/4) gives the classic isometric diamond view.
 */
export class CameraRig {
  readonly camera: THREE.OrthographicCamera;
  readonly target = new THREE.Vector3();
  private goalTarget = new THREE.Vector3();
  yaw = Math.PI / 4;
  private goalYaw = Math.PI / 4;
  zoom = 1;
  private goalZoom = 1;
  /** Pitch eases from the classic ~35.5 degrees to a lower inspection angle as the player zooms right in. */
  private pitch = 0.62;
  /** Ground height lookup; the camera target rides the terrain so hills never slide under or over the focus point. */
  ground: ((x: number, z: number) => number) | null = null;
  private groundY = 2.5;
  private readonly distance = 140;
  private readonly viewHeight = 46; // world units visible vertically at zoom 1
  private aspect: number;
  smoothing = true;

  constructor(aspect: number, private readonly mapSize: number, private readonly minZoom = 0.55, private readonly maxZoom = 5) {
    this.aspect = aspect;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
    this.applyFrustum();
    this.apply();
  }

  setTarget(x: number, z: number, instant = true): void {
    this.goalTarget.set(clamp(x, 0, this.mapSize - 1), 0, clamp(z, 0, this.mapSize - 1));
    if (instant) {
      this.target.copy(this.goalTarget);
      if (this.ground) this.groundY = Math.max(0, this.ground(this.target.x, this.target.z)); // jump cuts must not glide in height
      this.apply();
    }
  }

  /** Pan in screen-relative terms: +right moves right, +forward moves up the screen. */
  pan(right: number, forward: number): void {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.setTarget(
      this.goalTarget.x + right * c - forward * s,
      this.goalTarget.z - right * s - forward * c,
      false,
    );
  }

  setZoom(z: number, instant = true): void {
    this.goalZoom = clamp(z, this.minZoom, this.maxZoom);
    if (instant) { this.zoom = this.goalZoom; this.apply(); }
  }

  /** Snap the heading (used by the intro cinematic and when it hands the camera back). */
  setYaw(yaw: number): void { this.yaw = yaw; this.goalYaw = yaw; this.apply(); }

  rotateStep(dir: 1 | -1): void { this.goalYaw += dir * (Math.PI / 2); }

  zoomBy(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.goalZoom = clamp(this.goalZoom * factor, this.minZoom, this.maxZoom);
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
    this.applyFrustum();
  }

  get zoomLevel(): number { return this.goalZoom; }

  /** World-space ray through normalised device coordinates (-1..1). */
  rayFromNdc(nx: number, ny: number): THREE.Ray {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return rc.ray;
  }

  /** Where the four screen corners land on the ground plane (for the minimap view quad). */
  groundCorners(): { x: number; z: number }[] {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.groundY);
    const pt = new THREE.Vector3();
    const out: { x: number; z: number }[] = [];
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      if (this.rayFromNdc(nx, ny).intersectPlane(plane, pt)) out.push({ x: pt.x, z: pt.z });
    }
    return out;
  }

  update(dt: number): void {
    const k = this.smoothing ? 1 - Math.exp(-10 * dt) : 1;
    this.target.lerp(this.goalTarget, k);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.zoom += (this.goalZoom - this.zoom) * k;
    // Terrain-aware framing: damp the height separately (slower) so crossing a ridge glides instead of jolting.
    if (this.ground) {
      const gy = Math.max(0, this.ground(this.target.x, this.target.z));
      this.groundY += (gy - this.groundY) * (this.smoothing ? 1 - Math.exp(-4 * dt) : 1);
    }
    this.apply();
  }

  private applyFrustum(): void {
    const h = this.viewHeight / 2, w = h * this.aspect;
    Object.assign(this.camera, { left: -w, right: w, top: h, bottom: -h });
    this.camera.updateProjectionMatrix();
  }

  private apply(): void {
    this.target.y = this.groundY;
    // Close inspection view: from zoom 2.4 to 4.5 the pitch drops 0.62 -> 0.42 rad so facades and figures read side-on.
    const t = clamp((this.zoom - 2.4) / 2.1, 0, 1);
    this.pitch = 0.62 - 0.2 * t * t * (3 - 2 * t);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.distance,
      this.target.y + sp * this.distance,
      this.target.z + Math.cos(this.yaw) * cp * this.distance,
    );
    this.camera.zoom = this.zoom;
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }
}
