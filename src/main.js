// Phase 2 bootstrap: builds the ballpark and plays back pitches solved by the
// physics engine, with a small overlay. GameLoop, TelemetryUI and input take
// over in Phase 3; this file then becomes pure wiring.
//
// URL options: ?view=pitching|batting|broadcast|replaySide  ?pitcher=skenes
//              ?quality=0.5  ?bloom=0  ?auto=0  ?seed=123  ?debug=1  ?gpu=webgpu

import { StadiumRenderer } from './StadiumRenderer.js';
import * as PS from './PlayerStats.js';
import * as PE from './PhysicsEngine.js';
import { Rng } from './core/rng.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);

const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const loading = document.getElementById('loading');

const renderer = new StadiumRenderer(stage, {
  backend: params.get('gpu') ?? 'webgl',
  quality: num('quality', 1),
  bloom: params.get('bloom') !== '0',
});

const VIEWS = ['pitching', 'batting', 'broadcast', 'replaySide'];
const state = {
  tSim: 0,
  timeScale: 1,
  paused: false,
  auto: params.get('auto') !== '0',
  viewIndex: Math.max(0, VIEWS.indexOf(params.get('view') ?? 'pitching')),
  hb: 1,
  pitcherIndex: Math.max(0, PS.listPitchers().findIndex((p) => p.id === params.get('pitcher'))),
  forcedCode: null,
  current: null,      // { pitch, releaseAt }
  nextAt: 0.8,
  replay: null,       // { savedView, until }
  rng: new Rng(params.get('seed') ?? Date.now()),
};

function buildOverlay() {
  hud.innerHTML = `
    <div class="panel demo-card" id="demoCard">
      <div class="label">Pitching</div>
      <div class="who" id="dWho">—</div>
      <div class="pitch"><span class="chip" id="dChip"></span><span id="dPitch">—</span></div>
      <div class="demo-grid">
        <div><div class="label">Velocity</div><span class="v" id="dMph" style="color:var(--c-pitch)">—</span><span class="u">MPH</span></div>
        <div><div class="label">Spin</div><span class="v" id="dRpm" style="color:var(--c-spin)">—</span><span class="u">RPM</span></div>
        <div><div class="label">Ind. Vert. Break</div><span class="v" id="dIvb">—</span><span class="u">IN</span></div>
        <div><div class="label">Horiz. Break</div><span class="v" id="dHb">—</span><span class="u">IN ARM</span></div>
        <div><div class="label">Plate</div><span class="v" id="dPlate">—</span><span class="u">MPH</span></div>
        <div><div class="label">Result</div><span class="v" id="dCall" style="font-size:16px">—</span></div>
      </div>
    </div>
    <div class="panel demo-help">
      <kbd>V</kbd> view &nbsp; <kbd>Space</kbd> throw / pause auto &nbsp; <kbd>1</kbd>–<kbd>5</kbd> pitch &nbsp;
      <kbd>P</kbd> pitcher &nbsp; <kbd>R</kbd> slow-mo replay &nbsp; <kbd>T</kbd> trail &nbsp; <kbd>B</kbd> bloom &nbsp; <kbd>D</kbd> stats
    </div>
    <div class="panel demo-view" id="dView"></div>
    <div class="panel demo-stats" id="dStats" hidden></div>`;
  if (params.get('debug') === '1') document.getElementById('dStats').hidden = false;
}

function pitcher() {
  return PS.listPitchers()[state.pitcherIndex % PS.listPitchers().length];
}

/** Throws a pitch now: usage-weighted type, a target inside or just off the zone. */
function throwNow({ code = null, target = null, meter = undefined } = {}) {
  const p = pitcher();
  const rng = state.rng;
  const pitchCode = code ?? state.forcedCode ?? p.arsenal[rng.weightedIndex(p.arsenal.map((a) => a.usage))].code;
  const zone = { botM: 0.5, topM: 1.06 };
  const aim = target ?? { x: rng.uniform(-0.28, 0.28), y: rng.uniform(zone.botM - 0.1, zone.topM + 0.08) };
  const m = meter === undefined ? { tau: rng.gaussian(0, 0.2), reticleIn: rng.uniform(1, 3) } : meter;
  const pitch = PE.throwPitch({ pitcher: p, pitchCode, target: aim, meter: m, rng });
  state.current = { pitch, releaseAt: state.tSim + 0.05, zone };
  renderer.playPitch(pitch, state.current.releaseAt);
  showPitch(pitch, p, zone);
  state.nextAt = state.current.releaseAt + pitch.traj.end + 1.6;
  return pitch;
}

function showPitch(pitch, p, zone) {
  const m = pitch.metrics;
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('dWho', `${p.name} · ${p.throws}HP`);
  set('dPitch', pitch.name);
  document.getElementById('dChip').style.background = PS.PITCH_TYPES[pitch.code].color;
  set('dMph', m.releaseMph.toFixed(1));
  set('dRpm', Math.round(m.rpm).toLocaleString());
  set('dIvb', m.ivbIn.toFixed(1));
  set('dHb', m.hbArmIn.toFixed(1));
  set('dPlate', m.plateMph.toFixed(1));
  const call = PE.isStrike(pitch.crossing, zone) ? 'STRIKE' : 'BALL';
  set('dCall', call);
  renderer.updateVideoBoard({
    title: pitch.name.toUpperCase(),
    subtitle: `${p.name.toUpperCase()} · ${call}`,
    metrics: [
      { label: 'VELOCITY', value: m.releaseMph.toFixed(1), unit: 'MPH' },
      { label: 'SPIN', value: Math.round(m.rpm).toLocaleString(), unit: 'RPM' },
      { label: 'IND. VERT. BREAK', value: m.ivbIn.toFixed(1), unit: 'IN' },
      { label: 'HORIZ. BREAK', value: m.hbArmIn.toFixed(1), unit: 'IN' },
    ],
  });
}

function setView(i) {
  state.viewIndex = (i + VIEWS.length) % VIEWS.length;
  const view = VIEWS[state.viewIndex];
  renderer.setView(view, { hb: state.hb });
  document.getElementById('dView').textContent = view === 'batting' ? `batting (${state.hb > 0 ? 'RHB' : 'LHB'})` : view;
}

/** Slow-motion replay of the last pitch from the side camera at 1/8 speed (true spin rate). */
function replay() {
  if (!state.current) return;
  const savedView = VIEWS[state.viewIndex];
  const start = state.tSim;
  state.current.releaseAt = start + 0.05;
  renderer.playPitch(state.current.pitch, state.current.releaseAt);
  state.timeScale = 0.125;
  renderer.setTimeScale(0.125);
  renderer.setView('replaySide', { hb: state.hb, duration: 0.4 });
  state.replay = { savedView, until: state.current.releaseAt + state.current.pitch.traj.end + 0.1 };
  state.nextAt = Infinity;
}

function onKey(e) {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'v') {
    if (VIEWS[state.viewIndex] === 'batting' && state.hb === 1) { state.hb = -1; setView(state.viewIndex); }
    else { state.hb = 1; setView(state.viewIndex + 1); }
  } else if (k === ' ') {
    e.preventDefault();
    state.auto = false;
    throwNow();
  } else if (k === 'p') {
    state.pitcherIndex = (state.pitcherIndex + 1) % PS.listPitchers().length;
    state.forcedCode = null;
  } else if (k >= '1' && k <= '5') {
    const a = pitcher().arsenal[Number(k) - 1];
    if (a) state.forcedCode = a.code;
  } else if (k === 'r') replay();
  else if (k === 't') renderer.trailEnabled = !renderer.trailEnabled;
  else if (k === 'b') renderer.gfx.setBloom(!renderer.gfx.bloomEnabled);
  else if (k === 'd') document.getElementById('dStats').hidden ^= true;
  else if (k === 'a') state.auto = !state.auto;
}

let last = performance.now();
let statsTimer = 0;
function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state.paused) state.tSim += dtReal * state.timeScale;

  if (state.replay && state.tSim >= state.replay.until) {
    state.timeScale = 1;
    renderer.setTimeScale(1);
    renderer.setView(state.replay.savedView, { hb: state.hb, duration: 0.5 });
    state.replay = null;
    state.nextAt = state.tSim + 1.2;
  }
  if (state.auto && !state.replay && state.tSim >= state.nextAt) throwNow();

  renderer.update(state.tSim, dtReal);

  statsTimer += dtReal;
  if (statsTimer > 0.5) {
    statsTimer = 0;
    const s = renderer.stats();
    const el = document.getElementById('dStats');
    if (!el.hidden) {
      el.textContent = `${(1000 / s.frameMs).toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms\ncalls ${s.calls}  tris ${(s.triangles / 1000).toFixed(0)}k\nDPR ${s.pixelRatio}  fans ${s.fans}`;
    }
  }
  requestAnimationFrame(frame);
}

function boot() {
  buildOverlay();
  renderer.init();
  // Calibrate every pitch up front (~0.2 s) so the first throw doesn't hitch.
  for (const p of PS.listPitchers()) for (const pitch of p.arsenal) PE.calibratePitch(p, pitch);
  setView(state.viewIndex);
  window.addEventListener('keydown', onKey);
  loading.classList.add('done');
  requestAnimationFrame((t) => { last = t; frame(t); });
}

// Hooks for automated checks (screenshots, perf probes).
window.__game = { renderer, state, throwNow, setView, replay, PS, PE };

boot();
