// Facade over the render modules (docs/ARCHITECTURE.md §6.1). It owns the
// scene, lights, cameras and ball, and plays back trajectories solved by
// PhysicsEngine — it never integrates anything itself.

import * as THREE from 'three';
import { createRenderer } from './render/RendererFactory.js';
import { buildField } from './render/FieldBuilder.js';
import { buildStadium, drawVideoBoard } from './render/StadiumBuilder.js';
import { Ball } from './render/BallFactory.js';
import { CameraRig } from './render/Cameras.js';
import { PLATE, SIM } from './core/constants.js';
import { PITCH_TYPES } from './PlayerStats.js';

const SPIN_CAP = SIM.visualSpinCapRevPerSec * Math.PI * 2;

export class StadiumRenderer {
  /**
   * @param {HTMLElement} container  element the canvas fills
   * @param {{backend?: 'webgl'|'webgpu', quality?: number, bloom?: boolean}} [opts]
   */
  constructor(container, { backend = 'webgl', quality = 1, bloom = true } = {}) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    container.appendChild(this.canvas);
    this.gfx = createRenderer(this.canvas, { backend, bloom });
    this.renderer = this.gfx.renderer;
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a1324, 0.0016);
    this.rig = new CameraRig(1);
    this.camera = this.rig.camera;
    this.playback = null;
    this.timeScale = 1;
    this.trailEnabled = true;
    this.lastSimTime = null;
    this.frameEma = 16.7;
    this.slowFor = 0;
    this.minPixelRatio = 1;
    this._v = new THREE.Vector3();
    this._sample = new Float64Array(9);
    this._ro = new ResizeObserver(() => this.resize());
  }

  /** Builds everything. Separate from the constructor so callers can show a loading state. */
  init() {
    const aniso = Math.min(8, this.gfx.maxAnisotropy);
    const field = buildField({ anisotropy: aniso });
    this.scene.add(field.group);
    this.field = field;

    const stadium = buildStadium({ boundary: field.boundary, quality: this.quality });
    this.scene.add(stadium.group);
    this.stadium = stadium;

    this._buildLights(stadium);
    this._buildEnvironment();

    this.ball = new Ball({ anisotropy: aniso });
    this.ball.addTo(this.scene);

    this.updateVideoBoard({ title: 'STATCAST', subtitle: 'LIVE TRACKING SYSTEM', metrics: [] });
    this._ro.observe(this.container);
    this.resize();
    return this;
  }

  _buildLights(stadium) {
    // Key light: the combined first-base-side banks. Its shadow frustum is fitted
    // tightly to the plate–mound corridor so the ball and players cast crisp shadows.
    const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
    key.position.set(38, 62, 12);
    key.target.position.set(0, 0, -9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -13; sc.right = 13; sc.top = 13; sc.bottom = -13; sc.near = 20; sc.far = 140;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    this.scene.add(key, key.target);
    this.keyLight = key;

    const fill = new THREE.HemisphereLight(0x9fb6ff, 0x2b3a1f, 0.35);
    this.scene.add(fill);

    // Tower spots: no shadows, physically decaying; intensity in candela-like units.
    for (const spot of stadium.lights) spot.intensity = 9000;
  }

  _buildEnvironment() {
    // Image-based lighting from a tiny procedural "stadium": dark bowl with a ring of bright banks.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x05070d);
    const bankMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    bankMat.color.multiplyScalar(6);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(6, 2.5), bankMat);
      panel.position.set(Math.cos(a) * 20, 9, Math.sin(a) * 20);
      panel.lookAt(0, 0, 0);
      env.add(panel);
    }
    const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 32), new THREE.MeshBasicMaterial({ color: 0x1f3a1d }));
    ground.rotation.x = -Math.PI / 2;
    env.add(ground);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();
  }

  // ---------------------------------------------------------------------------
  // Views and playback
  // ---------------------------------------------------------------------------

  /** 'batting' | 'pitching' | 'broadcast' | 'replaySide' | 'highHome' | 'centerfield' | 'chase' */
  setView(mode, { hb = 1, duration = 0.6 } = {}) {
    this.rig.set(mode, { hb }, duration);
  }

  get view() {
    return this.rig.mode;
  }

  /**
   * Plays a pitch from PhysicsEngine.throwPitch(). `clockOffset` is the sim
   * time at release; trajectory time t maps to sim time clockOffset + t.
   */
  playPitch(pitch, clockOffset) {
    this.playback = { kind: 'pitch', traj: pitch.traj, offset: clockOffset, holdUntil: null };
    this.ball.resetTrail(PITCH_TYPES[pitch.code]?.color ?? '#ffffff');
    this.ball.orientForPitch(pitch.code, pitch.release.w, (pitch.release.v[0] * 97) % (Math.PI * 2));
    this.lastSimTime = null;
  }

  /** Continues playback with a batted-ball trajectory (same pitch clock). */
  playBattedBall(batted, clockOffset) {
    this.playback = { kind: 'batted', traj: batted.traj, offset: clockOffset, holdUntil: null };
    this.ball.resetTrail('#ffffff');
  }

  clearPlayback() {
    this.playback = null;
    this.ball.setVisible(false);
  }

  setTimeScale(ts) {
    this.timeScale = ts;
  }

  shake(ev = 100) {
    this.rig.shake(0.012 * Math.min(1.4, ev / 100), 0.12);
  }

  // ---------------------------------------------------------------------------
  // Frame update
  // ---------------------------------------------------------------------------

  /**
   * @param {number} tSim    current simulation time (s)
   * @param {number} dtReal  wall-clock frame time (s)
   */
  update(tSim, dtReal) {
    this._updateBall(tSim);
    this.rig.update(dtReal);
    this.ball.updateTrail(this.camera, this.trailEnabled);
    this.gfx.render(this.scene, this.camera);
    this._adaptQuality(dtReal);
  }

  _updateBall(tSim) {
    const pb = this.playback;
    if (!pb) return;
    const tr = pb.traj;
    const t = tSim - pb.offset;
    if (t < tr.start) {
      this.ball.setVisible(false);
      this.lastSimTime = tSim;
      return;
    }
    const X = tr.sampleAt(Math.min(t, tr.end), this._sample);
    this.ball.setVisible(true);
    this.ball.setPosition(X[0], X[1], X[2]);
    if (this.lastSimTime !== null && t <= tr.end) {
      const dt = tSim - this.lastSimTime;
      // Live play caps the visual spin rate to avoid wagon-wheel aliasing; slow motion shows the true rate.
      const cap = this.timeScale <= 0.2 ? Infinity : SPIN_CAP;
      if (dt > 0) this.ball.spin([X[6], X[7], X[8]], dt, cap);
    }
    this.lastSimTime = tSim;
    if (t <= tr.end) this.ball.pushTrail(this._v.set(X[0], X[1], X[2]));
    if (pb.kind === 'batted' && this.rig.mode === 'chase') {
      this.rig.setFollow(this._v.set(X[0], X[1], X[2]), new THREE.Vector3(X[3], X[4], X[5]));
    }
  }

  _adaptQuality(dtReal) {
    if (!(dtReal > 0) || dtReal > 0.25) return;
    this.frameEma += (dtReal * 1000 - this.frameEma) * 0.05;
    if (this.frameEma > 18) this.slowFor += dtReal; else this.slowFor = 0;
    if (this.slowFor > 2 && this.gfx.pixelRatio > this.minPixelRatio) {
      const pr = Math.max(this.minPixelRatio, this.gfx.pixelRatio - 0.25);
      this.gfx.setPixelRatio(pr);
      if (pr <= 1) this.gfx.setBloom(false);
      this.slowFor = 0;
      this.resize();
    }
  }

  // ---------------------------------------------------------------------------
  // Screen-space helpers for the HUD
  // ---------------------------------------------------------------------------

  /** Screen rectangle (CSS px, relative to the container) of the strike zone at the front of the plate. */
  projectZone(zone) {
    const rect = this.container.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const x of [-PLATE.halfWidth, PLATE.halfWidth]) {
      for (const y of [zone.botM, zone.topM]) {
        const v = this._v.set(x, y, PLATE.frontZ).project(this.camera);
        const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }

  /** World point (x, y) on the plane z = `planeZ` under a screen position (client px). */
  screenToPlane(clientX, clientY, planeZ = PLATE.frontZ) {
    const rect = this.container.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const { origin, direction } = ray.ray;
    if (Math.abs(direction.z) < 1e-9) return null;
    const s = (planeZ - origin.z) / direction.z;
    if (s <= 0) return null;
    return { x: origin.x + direction.x * s, y: origin.y + direction.y * s };
  }

  /** Projects a world point to container CSS px. */
  worldToScreen(x, y, z) {
    const rect = this.container.getBoundingClientRect();
    const v = this._v.set(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height, visible: v.z < 1 };
  }

  updateVideoBoard(content) {
    drawVideoBoard(this.stadium.videoBoard, content);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.gfx.setSize(w, h);
    this.rig.setAspect(w / h);
  }

  stats() {
    const info = this.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      pixelRatio: this.gfx.pixelRatio,
      frameMs: this.frameEma,
      fans: this.stadium?.counts.fans ?? 0,
    };
  }

  dispose() {
    this._ro.disconnect();
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
        m.dispose();
      }
    });
    this.gfx.dispose();
    this.canvas.remove();
  }
}
