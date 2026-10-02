// Game state machine and clock (docs/ARCHITECTURE.md §7.1).
//
// GameLoop owns all game state. It never touches the DOM: the renderer and
// HUD are optional collaborators, so a whole half-inning can run headless in
// Node tests. Each pitch is resolved completely when the pitcher releases it
// (physics is deterministic); the loop then *presents* it over time.
//
// Phase 3 implements pitching mode (user pitches to a CPU batter). Batting
// mode slots into the same phases in Phase 4.

import * as PS from './PlayerStats.js';
import * as PE from './PhysicsEngine.js';
import * as Rules from './game/rules.js';
import { resolvePitchVsCpu, DIFFICULTY } from './AIController.js';
import { EventBus } from './core/EventBus.js';
import { Rng } from './core/rng.js';

export const TIMING = Object.freeze({
  windup: 0.85,          // s from release command to ball release
  meterDuration: 1.1,    // s for the needle to sweep 0 → 1
  resultHold: 3.4,       // s the result stays up before the next pitch
  catchHold: 0.35,       // s after the ball reaches the glove
  maxBattedPlay: 7,      // s cap on batted-ball presentation
  aimSmoothing: 18,      // 1/s exponential smoothing of the aim point
});

/** Pitch meter: green centre, overdrive (effort) zone, and needle → τ mapping. */
export const METER = Object.freeze({ center: 0.7, scale: 0.35, effortStart: 0.9, effortEnd: 0.995 });

export function meterToTau(x) {
  if (x >= METER.effortStart && x < METER.effortEnd) return { tau: (x - 0.95) / 0.25, effort: true };
  if (x >= METER.effortEnd) return { tau: 1, effort: false };
  return { tau: Math.max(-1, Math.min(1, (x - METER.center) / METER.scale)), effort: false };
}

const AIM_LIMIT = { x: 0.6, yLo: 0.05, yHi: 1.7 };

export class GameLoop {
  /**
   * @param {object} [o]
   * @param {import('./StadiumRenderer.js').StadiumRenderer|null} [o.renderer]
   * @param {EventBus} [o.bus]
   * @param {object} [o.env]  PhysicsEngine environment
   */
  constructor({ renderer = null, bus = new EventBus(), env = PE.STANDARD_ENV } = {}) {
    this.renderer = renderer;
    this.bus = bus;
    this.env = env;
    this.t = 0;                 // simulation clock (s)
    this.timeScale = 1;
    this.lastRealMs = null;
    this.phase = 'menu';
    this.phaseStart = 0;
    this.config = null;
    this.game = null;
    this.paused = false;
    this.view = 'pitching';
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /**
   * @param {{mode?:'pitch', pitcherId:string, batterId:string, difficulty?:string, seed?:number|string, scenario?:object}} config
   */
  start(config) {
    const pitcher = PS.getPitcher(config.pitcherId);
    const first = PS.getBatter(config.batterId);
    const lineup = [first, ...PS.listBatters().filter((b) => b.id !== first.id)];
    this.config = { mode: 'pitch', difficulty: 'pro', ...config };
    this.rng = new Rng(config.seed ?? Date.now());
    this.pitcher = pitcher;
    this.lineup = lineup;
    this.batterIndex = 0;
    this.difficulty = DIFFICULTY[this.config.difficulty] ?? DIFFICULTY.pro;
    this.game = Rules.newGame(config.scenario ?? Rules.SHOWDOWN);
    this.pitchCode = pitcher.arsenal[0].code;
    this.aim = { x: 0, y: 0.8 };
    this.aimGoal = { x: 0, y: 0.8 };
    this.prevPitch = null;
    this.paHistory = [];
    this.play = null;
    this.lastPayload = null;
    this.paused = false;
    this.timeScale = 1;
    this.view = 'pitching';
    this._applyBatter();
    this.bus.emit('game:start', { config: this.config, pitcher, batter: this.batter });
    this._enter('aim');
  }

  get batter() {
    return this.lineup[this.batterIndex % this.lineup.length];
  }

  get zone() {
    return PS.strikeZone(this.batter);
  }

  get ratings() {
    return PS.ratingsVs(this.batter, this.pitcher);
  }

  _applyBatter() {
    this.renderer?.setBatter?.(this.batter, this.ratings.hb);
    this.renderer?.setView(this.view, { hb: this.ratings.hb, duration: 0.6 });
    this.bus.emit('batter:up', { batter: this.batter, ratings: this.ratings });
  }

  // ---------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------

  /** Sim time corresponding to a DOM event timestamp (ms, performance.now() base). */
  simTimeAt(timeStampMs) {
    if (this.lastRealMs === null || timeStampMs === undefined) return this.t;
    const dt = ((timeStampMs - this.lastRealMs) / 1000) * this.timeScale;
    return this.t + Math.max(-0.1, Math.min(0.1, dt));
  }

  /** Advances the game by dtReal seconds of wall time. `nowMs` anchors input timestamps. */
  tick(dtReal, nowMs) {
    if (nowMs !== undefined) this.lastRealMs = nowMs;
    if (this.paused || this.phase === 'menu') return;
    this.t += dtReal * this.timeScale;
    const k = 1 - Math.exp(-TIMING.aimSmoothing * dtReal);
    this.aim.x += (this.aimGoal.x - this.aim.x) * k;
    this.aim.y += (this.aimGoal.y - this.aim.y) * k;
    this._update();
  }

  _enter(phase, data = {}) {
    this.phase = phase;
    this.phaseStart = this.t;
    Object.assign(this, data);
    this.bus.emit('phase', { phase, t: this.t });
  }

  _since() {
    return this.t - this.phaseStart;
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  /**
   * Intents from InputController (or tests):
   *   { type:'aim', x, y }            world point on the front plate plane
   *   { type:'press'|'release', ts }  primary button / tap / Space
   *   { type:'select', code|index }   pitch type
   *   { type:'pause' } { type:'replay' } { type:'view' } { type:'continue' }
   */
  handle(intent) {
    if (intent.type === 'pause') {
      if (this.phase !== 'menu' && this.phase !== 'gameover') this.paused = !this.paused;
      this.bus.emit('pause', { paused: this.paused });
      return;
    }
    if (this.paused) return;
    const t = this.simTimeAt(intent.ts);
    switch (this.phase) {
      case 'aim':
        if (intent.type === 'aim') this._setAim(intent);
        else if (intent.type === 'nudge') this._setAim({ x: this.aimGoal.x + intent.dx * 0.04, y: this.aimGoal.y + intent.dy * 0.04 });
        else if (intent.type === 'select') this._selectPitch(intent);
        else if (intent.type === 'press' && intent.pointerType !== 'touch') this._lockAim(t);
        else if (intent.type === 'release' && intent.pointerType === 'touch') this._lockAim(t);
        else if (intent.type === 'view') this._cycleView();
        break;
      case 'meter':
        if (intent.type === 'press') this._lockMeter(t);
        break;
      case 'result':
        if (intent.type === 'replay') this._startReplay();
        else if (intent.type === 'press' || intent.type === 'continue') this._finishResult();
        else if (intent.type === 'view') this._cycleView();
        break;
      default:
        break;
    }
  }

  _setAim({ x, y }) {
    this.aimGoal = {
      x: Math.max(-AIM_LIMIT.x, Math.min(AIM_LIMIT.x, x)),
      y: Math.max(AIM_LIMIT.yLo, Math.min(AIM_LIMIT.yHi, y)),
    };
  }

  _selectPitch({ code, index }) {
    const pitch = code ? this.pitcher.arsenal.find((p) => p.code === code) : this.pitcher.arsenal[index];
    if (!pitch || pitch.code === this.pitchCode) return;
    this.pitchCode = pitch.code;
    this.phaseStart = this.t; // the reticle re-settles for a new grip
    this.bus.emit('pitch:selected', { code: pitch.code });
  }

  _cycleView() {
    this.view = this.view === 'pitching' ? 'broadcast' : 'pitching';
    this.renderer?.setView(this.view, { hb: this.ratings.hb });
  }

  /** Current aim reticle radius (inches): shrinks while the pitcher settles on a spot. */
  reticleIn(t = this.t) {
    if (this.phase !== 'aim') return this.lockedReticleIn ?? 0;
    return PS.reticleModel(this.pitcher.ratings.control).radiusAt(t - this.phaseStart);
  }

  meterValue(t = this.t) {
    return this.phase === 'meter' ? Math.min(1, Math.max(0, (t - this.phaseStart) / TIMING.meterDuration)) : this.lockedMeter ?? 0;
  }

  _lockAim(t) {
    this.lockedReticleIn = PS.reticleModel(this.pitcher.ratings.control).radiusAt(t - this.phaseStart);
    this.lockedAim = { ...this.aimGoal };
    this.lockedMeter = null;
    this._enter('meter');
    this.phaseStart = t;
  }

  _lockMeter(t) {
    const x = Math.min(1, Math.max(0, (t - this.phaseStart) / TIMING.meterDuration));
    this.lockedMeter = x;
    const { tau, effort } = meterToTau(x);
    this._throw({ tau, effort, x });
  }

  // ---------------------------------------------------------------------------
  // Pitch resolution and presentation
  // ---------------------------------------------------------------------------

  _throw({ tau, effort, x }) {
    const pitch = PE.throwPitch({
      pitcher: this.pitcher, pitchCode: this.pitchCode, target: this.lockedAim,
      meter: { tau, reticleIn: this.lockedReticleIn, effort }, rng: this.rng, env: this.env,
    });
    const play = resolvePitchVsCpu({
      pitch, batter: this.batter, pitcher: this.pitcher,
      count: { balls: this.game.balls, strikes: this.game.strikes },
      prevPitch: this.prevPitch, rng: this.rng, difficulty: this.difficulty, env: this.env,
    });
    play.meter = { x, tau, effort, grade: meterGrade(tau, PS.meterGreenHalfWidth(this.pitcher.ratings.control), effort) };
    play.isStrike = PE.isStrike(pitch.crossing, this.zone);
    play.releaseAt = this.t + TIMING.windup;

    // When does the presentation of this pitch end, and when does the ball disappear?
    if (play.batted) {
      const o = play.outcome;
      const caught = o.result === 'OUT_FLY' || o.result === 'OUT_LINE';
      const end = caught ? o.t
        : play.batted.isHR ? play.batted.wall.t + 1.6
          : Math.min(play.batted.traj.end, (o.t ?? play.batted.landing.t) + 0.8);
      play.endAt = play.releaseAt + Math.min(end, play.collision.t + TIMING.maxBattedPlay);
      play.hideBallAt = caught ? play.releaseAt + o.t : null;
    } else {
      play.endAt = play.releaseAt + pitch.traj.end + TIMING.catchHold;
    }
    this.play = play;
    this.prevPitch = pitch;
    this.renderer?.playPitch(pitch, play.releaseAt);
    this.renderer?.attachSwing?.(play.swing, play.releaseAt);
    this.bus.emit('pitch:thrown', { play });
    this._enter('windup');
  }

  _update() {
    const play = this.play;
    switch (this.phase) {
      case 'meter':
        if (this._since() >= TIMING.meterDuration) this._lockMeter(this.phaseStart + TIMING.meterDuration);
        break;
      case 'windup':
        if (this.t >= play.releaseAt) {
          this.bus.emit('pitch:released', { play });
          this._enter('flight');
        }
        break;
      case 'flight': {
        if (play.collision && this.t >= play.releaseAt + play.collision.t) {
          this.renderer?.playBattedBall(play.batted, play.releaseAt);
          this.renderer?.shake(play.collision.evMph);
          this.renderer?.setView('track', { duration: 0.7 });
          this.bus.emit('contact', { play });
          this._enter('batted');
        } else if (!play.collision && this.t >= play.endAt) {
          this._resolve();
        }
        break;
      }
      case 'batted':
        if (play.hideBallAt !== null && this.t >= play.hideBallAt) {
          this.renderer?.clearPlayback();
          play.hideBallAt = null;
          this.bus.emit('catch', { play });
        }
        if (this.t >= play.endAt) this._resolve();
        break;
      case 'result':
        if (this._since() >= TIMING.resultHold) this._finishResult();
        break;
      case 'replay':
        if (this.t >= this.replayUntil) this._endReplay();
        break;
      default:
        break;
    }
  }

  /** Applies the rules for the presented pitch and publishes the telemetry payload. */
  _resolve() {
    const play = this.play;
    let event;
    if (play.outcome) {
      event = play.outcome.result === 'FOUL' ? { type: 'foul' } : { type: 'in_play', outcome: play.outcome, batted: play.batted };
    } else {
      event = { type: Rules.nonContactEvent({ swung: Boolean(play.swing), contactKind: play.contact?.kind, isStrike: play.isStrike }) };
    }
    const before = this.game;
    const res = Rules.applyPitch(before, event);
    this.game = res.state;
    play.event = event;
    play.rules = res;

    this.paHistory.push({ x: play.pitch.crossing?.x ?? 0, y: play.pitch.crossing?.y ?? 0, code: play.pitch.code, event: event.type, n: this.paHistory.length + 1 });
    const payload = PE.statcastMetrics(play.pitch, play.swing, play.collision, play.batted, play.outcome);
    payload.players = { pitcher: this.pitcher, batter: this.batter };
    payload.count = { balls: before.balls, strikes: before.strikes };
    payload.call = callText(event, res);
    payload.result = res.result;
    payload.text = res.text;
    payload.meter = play.meter;
    payload.runs = res.runs;
    payload.isStrike = play.isStrike;
    this.lastPayload = payload;

    this.renderer?.setView(this.view, { hb: this.ratings.hb, duration: 0.7 });
    this.bus.emit('result', { payload, play, game: this.game });
    this._enter('result');
  }

  _finishResult() {
    if (this.phase !== 'result') return;
    const res = this.play.rules;
    if (this.game.over) {
      this.renderer?.clearPlayback();
      this.bus.emit('game:over', { game: this.game, verdict: Rules.verdict(this.game) });
      this._enter('gameover');
      return;
    }
    if (res.paEnded) {
      this.batterIndex++;
      this.paHistory = [];
      this.prevPitch = null;
      this._applyBatter();
    }
    this.renderer?.clearPlayback();
    this.renderer?.attachSwing?.(null, 0);
    this.lockedReticleIn = null;
    this._enter('aim');
  }

  _startReplay() {
    const play = this.play;
    if (!play) return;
    const start = this.t + 0.3;
    this.replayOffset = start;
    this.renderer?.playPitch(play.pitch, start);
    this.renderer?.attachSwing?.(play.swing, start);
    const contactT = play.collision ? play.collision.t : null;
    this.replayUntil = start + (contactT !== null ? contactT + 0.25 : play.pitch.traj.end + 0.05);
    this.replayContact = contactT;
    this.timeScale = 0.125;
    this.renderer?.setTimeScale(0.125);
    this.renderer?.setView('replaySide', { hb: this.ratings.hb, duration: 0.4 });
    this._enter('replay');
  }

  _endReplay() {
    this.timeScale = 1;
    this.renderer?.setTimeScale(1);
    this.renderer?.setView(this.view, { hb: this.ratings.hb, duration: 0.5 });
    this.renderer?.clearPlayback();
    this._enter('result');
  }

  // ---------------------------------------------------------------------------
  // HUD snapshot (read every frame by TelemetryUI)
  // ---------------------------------------------------------------------------

  snapshot() {
    if (!this.game) return { phase: this.phase, paused: this.paused, t: this.t, game: null };
    return {
      phase: this.phase,
      paused: this.paused,
      t: this.t,
      game: this.game,
      pitcher: this.pitcher,
      batter: this.batter,
      ratings: this.game ? this.ratings : null,
      zone: this.game ? this.zone : null,
      pitchCode: this.pitchCode,
      aim: this.phase === 'aim' ? this.aim : this.lockedAim ?? this.aim,
      reticleIn: this.reticleIn(),
      meter: {
        value: this.meterValue(),
        active: this.phase === 'meter',
        greenCenter: METER.center,
        greenHalf: this.pitcher ? PS.meterGreenHalfWidth(this.pitcher.ratings.control) * METER.scale : 0,
        effort: [METER.effortStart, METER.effortEnd],
      },
      paHistory: this.paHistory,
      payload: this.lastPayload,
      view: this.view,
      difficulty: this.difficulty,
      timeToNext: this.phase === 'result' ? Math.max(0, TIMING.resultHold - this._since()) : null,
    };
  }
}

function meterGrade(tau, greenHalf, effort) {
  const a = Math.abs(tau);
  if (effort) return a <= greenHalf ? 'MAX EFFORT' : 'OVERTHROWN';
  if (a <= greenHalf) return 'PERFECT';
  if (a <= greenHalf * 2.5) return tau < 0 ? 'EARLY' : 'LATE';
  return tau < 0 ? 'WAY EARLY' : 'WAY LATE';
}

function callText(event, res) {
  if (res.result === 'K') return event.type === 'called_strike' ? 'STRIKE THREE' : 'STRIKEOUT';
  if (res.result === 'BB') return 'BALL FOUR';
  switch (event.type) {
    case 'ball': return 'BALL';
    case 'called_strike': return 'STRIKE';
    case 'swinging_strike': return 'SWINGING STRIKE';
    case 'foul_tip': return 'FOUL TIP';
    case 'foul': return 'FOUL';
    default: break;
  }
  return {
    '1B': 'SINGLE', '2B': 'DOUBLE', '3B': 'TRIPLE', HR: 'HOME RUN',
    OUT_FLY: 'FLY OUT', OUT_LINE: 'LINE OUT', OUT_GROUND: 'GROUND OUT',
  }[res.result] ?? res.text.toUpperCase();
}

export const _internal = { meterGrade, callText };
