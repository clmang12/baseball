// Bootstrap: builds the ballpark, then wires GameLoop ↔ TelemetryUI ↔
// InputController through the event bus. While the menu is open an attract
// mode throws pitches behind it.
//
// URL options: ?quality=0.5  ?bloom=0  ?debug=1  ?seed=123  ?gpu=webgpu

import { StadiumRenderer } from './StadiumRenderer.js';
import { GameLoop } from './GameLoop.js';
import { TelemetryUI } from './TelemetryUI.js';
import { InputController } from './InputController.js';
import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';
import { PLATE } from './core/constants.js';
import * as PS from './PlayerStats.js';
import * as PE from './PhysicsEngine.js';

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const loading = document.getElementById('loading');

const bus = new EventBus();
const renderer = new StadiumRenderer(stage, {
  backend: params.get('gpu') ?? 'webgl',
  quality: params.has('quality') ? Number(params.get('quality')) : 1,
  bloom: params.get('bloom') !== '0',
});
const loop = new GameLoop({ renderer, bus });

const ui = new TelemetryUI(hud, {
  bus,
  projector: renderer,
  onIntent: (intent) => loop.handle(intent),
  onStart: (cfg) => {
    attract.active = false;
    renderer.clearPlayback();
    loop.start({ ...cfg, seed: params.get('seed') ?? Date.now() });
  },
  onQuit: () => toMenu(),
});

const input = new InputController({
  surface: stage,
  toPlate: (x, y) => renderer.screenToPlane(x, y, PLATE.frontZ),
  onIntent: (intent) => loop.handle(intent),
});

// Video board mirrors every result.
bus.on('result', ({ payload }) => {
  const c = payload.contact, b = payload.batted;
  renderer.updateVideoBoard({
    title: payload.call,
    subtitle: `${payload.players.pitcher.name.toUpperCase()} vs ${payload.players.batter.name.toUpperCase()}`,
    metrics: [
      { label: 'PITCH SPEED', value: payload.pitch.releaseMph.toFixed(1), unit: 'MPH' },
      { label: 'SPIN RATE', value: Math.round(payload.pitch.rpm).toLocaleString('en-US'), unit: 'RPM' },
      { label: 'EXIT VELO', value: c ? c.evMph.toFixed(1) : '—', unit: 'MPH' },
      { label: 'LAUNCH ANGLE', value: c ? c.laDeg.toFixed(0) : '—', unit: 'DEG' },
      { label: 'DISTANCE', value: b ? String(Math.round(b.projDistFt)) : '—', unit: 'FT' },
    ],
  });
});

// ---------------------------------------------------------------------------
// Attract mode behind the menu: broadcast camera, random pitches.
// ---------------------------------------------------------------------------
const attract = { active: true, t: 0, next: 0.6, rng: new Rng('attract') };

function attractTick(dt) {
  attract.t += dt;
  if (attract.t < attract.next) return;
  const pitchers = PS.listPitchers();
  const p = pitchers[attract.rng.int(pitchers.length)];
  const code = p.arsenal[attract.rng.weightedIndex(p.arsenal.map((a) => a.usage))].code;
  const pitch = PE.throwPitch({ pitcher: p, pitchCode: code, target: { x: attract.rng.uniform(-0.25, 0.25), y: attract.rng.uniform(0.5, 1.0) } });
  renderer.playPitch(pitch, attract.t + 0.05);
  attract.next = attract.t + pitch.traj.end + 2.2;
}

function toMenu() {
  loop.phase = 'menu';
  loop.paused = false;
  loop.timeScale = 1;
  renderer.setTimeScale(1);
  renderer.clearPlayback();
  renderer.attachSwing(null, 0);
  renderer.batter.group.visible = false;
  renderer.setView('broadcast', { duration: 0.8 });
  ui.showMenu(true);
  attract.active = true;
  attract.next = attract.t + 0.8;
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
const stats = document.createElement('div');
stats.className = 'panel debug-stats mono';
stats.hidden = params.get('debug') !== '1';
document.body.appendChild(stats);

let last = performance.now();
let statsTimer = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  loop.tick(dt, now);
  let tSim;
  if (attract.active) {
    attractTick(dt);
    tSim = attract.t;
  } else {
    tSim = loop.t;
  }
  renderer.update(tSim, loop.paused ? 0 : dt);
  ui.frame(loop.snapshot());

  statsTimer += dt;
  if (!stats.hidden && statsTimer > 0.5) {
    statsTimer = 0;
    const s = renderer.stats();
    stats.textContent = `${(1000 / s.frameMs).toFixed(0)} fps · ${s.frameMs.toFixed(1)} ms · ${s.calls} calls · ${(s.triangles / 1000).toFixed(0)}k tris · DPR ${s.pixelRatio}`;
  }
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && loop.phase !== 'menu' && loop.phase !== 'gameover' && !loop.paused) loop.handle({ type: 'pause' });
});

function boot() {
  renderer.init();
  // Calibrate every pitch up front (~0.2 s) so the first throw never hitches.
  for (const p of PS.listPitchers()) for (const pitch of p.arsenal) PE.calibratePitch(p, pitch);
  renderer.setView('broadcast', { duration: 0 });
  loading.classList.add('done');
  requestAnimationFrame((t) => { last = t; frame(t); });
}

// Hooks for automated checks.
window.__game = { renderer, loop, ui, input, bus, PS, PE, toMenu };

boot();
