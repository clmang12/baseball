// Broadcast-style HUD and StatCast overlay (docs/ARCHITECTURE.md §6.2),
// ported from reference/statcast_boilerplate.html. The DOM skeleton is built
// once; per-frame state comes from GameLoop.snapshot() and discrete updates
// arrive on the event bus. Dynamic text is always set via textContent.

import * as PS from './PlayerStats.js';
import { PLATE } from './core/constants.js';
import { IN, FT } from './core/units.js';
import { DIFFICULTY } from './AIController.js';

const fmt = {
  mph: (v) => (Number.isFinite(v) ? v.toFixed(1) : '—'),
  rpm: (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—'),
  deg: (v) => (Number.isFinite(v) ? v.toFixed(1) : '—'),
  ft: (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—'),
  pct: (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v}%` : '—'),
};
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 >= 11 && n % 100 <= 13) || n % 10 > 3 ? 0 : n % 10]}`;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const SKELETON = `
<div class="hud-top">
  <div class="panel scoreboard" id="scoreboard">
    <div class="sb-teams">
      <span class="badge" id="sbBatTeam">—</span><span class="sb-runs" id="sbBatRuns">0</span>
      <span class="sb-div">|</span>
      <span class="badge" id="sbFieldTeam">—</span><span class="sb-runs" id="sbFieldRuns">0</span>
    </div>
    <div class="vsep"></div>
    <div class="sb-inning"><span class="label">Inning</span><span class="statcast-font accent-amber" id="sbInning">▲ 9th</span></div>
    <div class="sb-outs" aria-label="outs"><span class="dot" id="out1"></span><span class="dot" id="out2"></span><span class="sb-outs-label" id="sbOuts">0 OUT</span></div>
    <svg class="sb-bases" viewBox="0 0 40 30" aria-label="bases">
      <rect id="base2" x="15" y="2" width="10" height="10" transform="rotate(45 20 7)"/>
      <rect id="base3" x="4" y="13" width="10" height="10" transform="rotate(45 9 18)"/>
      <rect id="base1" x="26" y="13" width="10" height="10" transform="rotate(45 31 18)"/>
    </svg>
    <div class="sb-count statcast-font"><span>B <b class="accent-emerald" id="sbBalls">0</b></span><span>S <b class="accent-rose" id="sbStrikes">0</b></span></div>
  </div>
  <div class="panel matchup" id="matchup">
    <div class="mu-side mu-right">
      <div class="label">Pitching</div>
      <div class="mu-name statcast-font" id="muPitcher">—</div>
      <div class="mu-sub accent-cyan" id="muPitcherSub">—</div>
    </div>
    <div class="mu-vs statcast-font">VS</div>
    <div class="mu-side">
      <div class="label">Batting</div>
      <div class="mu-name statcast-font" id="muBatter">—</div>
      <div class="mu-sub accent-amber" id="muBatterSub">—</div>
    </div>
  </div>
</div>

<div class="panel arsenal" id="arsenal" data-ui>
  <div class="label accent-cyan arsenal-title">Pitch Arsenal</div>
  <div class="arsenal-list" id="arsenalList"></div>
</div>

<div class="zone-layer" id="zoneLayer">
  <div class="zone-box" id="zoneBox"><div class="zone-grid"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
  <div class="pitch-dots" id="pitchDots"></div>
  <div class="aim-reticle" id="aimReticle"><span></span></div>
</div>

<div class="center-stack">
  <div class="call-banner statcast-font" id="callBanner"></div>
</div>

<div class="hud-bottom">
  <div class="prompt" id="prompt"></div>
  <div class="meter" id="meter" aria-hidden="true">
    <div class="meter-track">
      <div class="meter-green" id="meterGreen"></div>
      <div class="meter-effort" id="meterEffort"></div>
      <div class="meter-needle" id="meterNeedle"></div>
    </div>
    <div class="meter-grade statcast-font" id="meterGrade"></div>
  </div>
  <div class="panel statcast" id="statcast">
    <div class="sc-head">
      <div class="sc-title"><span class="sc-chip statcast-font">STATCAST</span><span class="statcast-font" id="scHeadline">Pitch Tracking</span></div>
      <div class="sc-live">LIVE TRACKING SYSTEM // ACTIVE</div>
    </div>
    <div class="sc-body">
      <div class="sc-grid">
        <div class="metric"><span class="label">Pitch Speed</span><div><span class="mv mono accent-cyan" id="mSpeed">—</span><span class="mu">MPH</span></div></div>
        <div class="metric"><span class="label">Spin Rate</span><div><span class="mv mono accent-purple" id="mSpin">—</span><span class="mu">RPM</span></div></div>
        <div class="metric"><span class="label">Exit Velocity</span><div><span class="mv mono accent-amber" id="mEV">—</span><span class="mu">MPH</span></div></div>
        <div class="metric"><span class="label">Launch Angle</span><div><span class="mv mono accent-emerald" id="mLA">—</span><span class="mu">DEG°</span></div></div>
        <div class="metric"><span class="label">Est. Distance</span><div><span class="mv mono accent-rose" id="mDist">—</span><span class="mu">FT</span></div></div>
      </div>
      <svg class="spray" id="spray" viewBox="-60 -62 120 70" aria-label="spray chart">
        <path class="spray-field" d="M0 0 L-42.4 -42.4 A60 60 0 0 1 42.4 -42.4 Z"/>
        <path class="spray-infield" d="M0 0 L-12 -12 L0 -24 L12 -12 Z"/>
        <path class="spray-arc" id="sprayArc" d=""/>
        <circle class="spray-dot" id="sprayDot" r="2.6" cx="0" cy="0"/>
      </svg>
    </div>
    <div class="sc-secondary mono" id="scSecondary"></div>
    <div class="sc-desc">
      <p id="scDesc">—</p>
      <span class="pill" id="scPill">—</span>
    </div>
  </div>
</div>

<div class="help" id="help"></div>
<div class="sr-only" aria-live="polite" id="live"></div>

<div class="overlay" id="menu" data-ui>
  <div class="panel menu-card">
    <div class="menu-head">
      <div class="sc-chip statcast-font">STATCAST</div>
      <h1 class="statcast-font">Pitcher vs Batter</h1>
      <p class="muted">Top of the 9th, one out, protecting a one-run lead. Pick your arm and face the lineup.</p>
    </div>
    <div class="menu-section">
      <div class="label">Mode</div>
      <div class="seg">
        <button class="seg-btn active" data-mode="pitch" type="button">Pitch</button>
        <button class="seg-btn" data-mode="bat" type="button" disabled title="Batting mode arrives in Phase 4">Bat <small>soon</small></button>
      </div>
    </div>
    <div class="menu-section">
      <div class="label">Your pitcher</div>
      <div class="cards" id="pitcherCards"></div>
    </div>
    <div class="menu-section">
      <div class="label">Lead-off batter <span class="muted">(the lineup rotates)</span></div>
      <div class="cards" id="batterCards"></div>
    </div>
    <div class="menu-section">
      <div class="label">CPU difficulty</div>
      <div class="seg" id="diffSeg"></div>
    </div>
    <button class="primary-btn statcast-font" id="startBtn" type="button">Play ball</button>
  </div>
</div>

<div class="overlay" id="pauseOverlay" data-ui hidden>
  <div class="panel menu-card small">
    <h2 class="statcast-font">Paused</h2>
    <div class="btn-row">
      <button class="primary-btn statcast-font" id="resumeBtn" type="button">Resume</button>
      <button class="ghost-btn" id="quitBtn" type="button">Quit to menu</button>
    </div>
  </div>
</div>

<div class="overlay" id="overOverlay" data-ui hidden>
  <div class="panel menu-card small">
    <div class="sc-chip statcast-font">FINAL</div>
    <h2 class="statcast-font" id="overTitle">Ballgame</h2>
    <p class="muted" id="overDetail"></p>
    <div class="over-stats mono" id="overStats"></div>
    <div class="btn-row">
      <button class="primary-btn statcast-font" id="againBtn" type="button">Run it back</button>
      <button class="ghost-btn" id="menuBtn" type="button">Main menu</button>
    </div>
  </div>
</div>`;

export class TelemetryUI {
  /**
   * @param {HTMLElement} root
   * @param {{ bus:import('./core/EventBus.js').EventBus, projector:object, onIntent:(i:object)=>void, onStart:(cfg:object)=>void, onQuit:()=>void }} o
   */
  constructor(root, { bus, projector, onIntent, onStart, onQuit }) {
    this.root = root;
    this.bus = bus;
    this.projector = projector;
    this.onIntent = onIntent;
    this.onStart = onStart;
    this.onQuit = onQuit;
    root.innerHTML = SKELETON;
    this.$ = (id) => root.querySelector(`#${id}`);
    this.selection = { pitcherId: PS.listPitchers()[0].id, batterId: PS.listBatters()[0].id, difficulty: 'pro' };
    this._lastScore = '';
    this._lastArsenalKey = '';
    this._dotsKey = '';
    this._buildMenu();
    this._bindButtons();
    this._subscribe();
    this.showMenu(true);
  }

  // ---------------------------------------------------------------------------
  // Menu and overlays
  // ---------------------------------------------------------------------------

  _card(container, player, selected, kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pcard${selected ? ' active' : ''}`;
    btn.dataset.id = player.id;
    const team = PS.TEAMS[player.team];
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = player.team;
    badge.style.background = team?.primary ?? '#334155';
    badge.style.borderColor = team?.accent ?? '#64748b';
    const name = document.createElement('span');
    name.className = 'pcard-name';
    name.textContent = player.name;
    const sub = document.createElement('span');
    sub.className = 'pcard-sub';
    if (kind === 'pitcher') {
      const r = player.ratings;
      sub.textContent = `${player.throws}HP · VEL ${r.velocity} · CTL ${r.control} · BRK ${r.break}`;
    } else {
      const r = player.ratings;
      sub.textContent = `${player.bats === 'S' ? 'Switch' : `${player.bats}HB`} · PWR ${r.power.vsR} · CON ${r.contact.vsR} · VIS ${r.vision}`;
    }
    const ovr = document.createElement('span');
    ovr.className = 'pcard-ovr mono';
    ovr.textContent = PS.overall(player);
    btn.append(badge, name, ovr, sub);
    container.appendChild(btn);
    return btn;
  }

  _buildMenu() {
    const pc = this.$('pitcherCards'), bc = this.$('batterCards'), ds = this.$('diffSeg');
    const render = () => {
      pc.replaceChildren(); bc.replaceChildren(); ds.replaceChildren();
      for (const p of PS.listPitchers()) this._card(pc, p, p.id === this.selection.pitcherId, 'pitcher').onclick = () => { this.selection.pitcherId = p.id; render(); };
      for (const b of PS.listBatters()) this._card(bc, b, b.id === this.selection.batterId, 'batter').onclick = () => { this.selection.batterId = b.id; render(); };
      for (const [key, d] of Object.entries(DIFFICULTY)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `seg-btn${key === this.selection.difficulty ? ' active' : ''}`;
        btn.textContent = d.label;
        btn.onclick = () => { this.selection.difficulty = key; render(); };
        ds.appendChild(btn);
      }
    };
    render();
  }

  _bindButtons() {
    this.$('startBtn').onclick = () => this.onStart({ ...this.selection });
    this.$('resumeBtn').onclick = () => this.onIntent({ type: 'pause' });
    this.$('quitBtn').onclick = () => this.onQuit();
    this.$('againBtn').onclick = () => this.onStart({ ...this.selection });
    this.$('menuBtn').onclick = () => this.onQuit();
  }

  showMenu(show) {
    this.$('menu').hidden = !show;
    this.root.classList.toggle('menu-open', show);
    if (show) {
      this.$('overOverlay').hidden = true;
      this.$('pauseOverlay').hidden = true;
      this.$('statcast').classList.remove('show');
    }
  }

  // ---------------------------------------------------------------------------
  // Bus events
  // ---------------------------------------------------------------------------

  _subscribe() {
    const b = this.bus;
    b.on('phase', ({ phase }) => {
      if (phase === 'aim') {
        this.$('statcast').classList.remove('show');
        this.root.classList.remove('result-open');
      }
    });
    b.on('game:start', ({ pitcher }) => {
      this.showMenu(false);
      this.$('overOverlay').hidden = true;
      this.$('statcast').classList.remove('show');
      this._setPitcher(pitcher);
      this._lastArsenalKey = '';
    });
    b.on('batter:up', ({ batter, ratings }) => this._setBatter(batter, ratings));
    b.on('pause', ({ paused }) => { this.$('pauseOverlay').hidden = !paused; });
    b.on('pitch:thrown', ({ play }) => { this._lastGrade = play.meter?.grade ?? ''; });
    b.on('pitch:released', () => {
      this.$('statcast').classList.remove('show');
      this.root.classList.remove('result-open');
      this.root.classList.add('in-flight');
    });
    b.on('result', ({ payload }) => {
      this.root.classList.remove('in-flight');
      this.showStatcast(payload);
      this.flashCall(payload.call, payload.result);
    });
    b.on('game:over', ({ game, verdict }) => this._showGameOver(game, verdict));
  }

  _setPitcher(p) {
    this.$('muPitcher').textContent = p.name;
    this.$('muPitcherSub').textContent = `${PS.overall(p)} OVR · ${p.throws}HP · ${p.team}`;
  }

  _setBatter(b, r) {
    this.$('muBatter').textContent = b.name;
    this.$('muBatterSub').textContent = `${PS.overall(b)} OVR · ${r.side}HB · CON ${r.contact} PWR ${r.power} ${r.split === 'vsL' ? 'vs LHP' : 'vs RHP'}`;
  }

  _showGameOver(game, verdict) {
    this.$('overTitle').textContent = verdict.title;
    this.$('overDetail').textContent = verdict.detail;
    const s = game.stats;
    this.$('overStats').textContent = `PITCHES ${game.pitchCount}   K ${s.K}   BB ${s.BB}   H ${s.H}   HR ${s.HR}   R ${s.R}`;
    this.$('overOverlay').hidden = false;
    this.$('statcast').classList.remove('show');
  }

  // ---------------------------------------------------------------------------
  // StatCast panel and call banner
  // ---------------------------------------------------------------------------

  showStatcast(p) {
    const el = this.$('statcast');
    const contact = p.contact, batted = p.batted;
    this.$('scHeadline').textContent = contact ? 'Launch Metrics Analysis' : 'Pitch Tracking';
    this._countUp('mSpeed', p.pitch.releaseMph, fmt.mph);
    this._countUp('mSpin', p.pitch.rpm, fmt.rpm);
    this._countUp('mEV', contact?.evMph, fmt.mph);
    this._countUp('mLA', contact?.laDeg, fmt.deg);
    this._countUp('mDist', batted?.projDistFt, fmt.ft);

    const bits = [
      `${p.pitch.name}`,
      `PLATE ${fmt.mph(p.pitch.plateMph)} MPH`,
      `IVB ${fmt.deg(p.pitch.ivbIn)}"`,
      `HB ${fmt.deg(p.pitch.hbArmIn)}"`,
      `EXT ${fmt.deg(p.pitch.extensionFt)} FT`,
    ];
    if (p.meter) bits.push(`METER ${p.meter.grade}`);
    if (p.swing?.timing) bits.push(`SWING ${p.swing.timing}${p.swing.dtMs ? ` ${Math.abs(Math.round(p.swing.dtMs))} MS` : ''}`);
    if (contact) {
      bits.push(`SPRAY ${Math.round(contact.sprayDeg)}°`, `xBA ${contact.xBA.toFixed(3).replace(/^0/, '')}`);
      if (batted) bits.push(`HANG ${batted.hangS.toFixed(1)} S`);
      if (contact.barrel) bits.push('BARREL');
    }
    this.$('scSecondary').textContent = bits.join('   ·   ');
    this.$('scDesc').textContent = describe(p);
    const pill = this.$('scPill');
    const { label, tone } = pillFor(p);
    pill.textContent = label;
    pill.className = `pill tone-${tone}`;
    this._drawSpray(batted);
    el.classList.add('show');
    this.root.classList.add('result-open');
    this.$('live').textContent = describe(p);
  }

  _countUp(id, value, format) {
    const el = this.$(id);
    if (!Number.isFinite(value)) { el.textContent = '—'; return; }
    if (reducedMotion()) { el.textContent = format(value); return; }
    const start = performance.now(), dur = 600;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - (1 - k) ** 3;
      el.textContent = format(value * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  _drawSpray(batted) {
    const dot = this.$('sprayDot'), arc = this.$('sprayArc');
    if (!batted) {
      dot.setAttribute('visibility', 'hidden');
      arc.setAttribute('d', '');
      return;
    }
    // 60 svg units = 420 ft.
    const k = 60 / 420;
    const x = (batted.landing.x / FT) * k, y = (batted.landing.z / FT) * k;
    dot.setAttribute('cx', x.toFixed(1));
    dot.setAttribute('cy', y.toFixed(1));
    dot.setAttribute('visibility', 'visible');
    dot.setAttribute('class', `spray-dot${batted.isHR ? ' hr' : ''}`);
    const lift = Math.min(18, (batted.apexFt / 120) * 18);
    arc.setAttribute('d', `M0 0 Q${(x / 2).toFixed(1)} ${(y / 2 - lift).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`);
  }

  flashCall(text, result) {
    const el = this.$('callBanner');
    el.textContent = text ?? '';
    el.className = `call-banner statcast-font tone-${pillFor({ result, call: text }).tone}`;
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------

  frame(s) {
    if (!s.game) return;
    this._scoreboard(s);
    this._arsenal(s);
    this._zone(s);
    this._meter(s);
    this._prompt(s);
  }

  _scoreboard(s) {
    const g = s.game;
    const key = JSON.stringify([g.score, g.outs, g.balls, g.strikes, g.bases, g.inning, s.batter.team, s.pitcher.team]);
    if (key === this._lastScore) return;
    this._lastScore = key;
    const bt = PS.TEAMS[s.batter.team], ft = PS.TEAMS[s.pitcher.team];
    const setBadge = (id, abbr, team) => {
      const el = this.$(id);
      el.textContent = abbr;
      el.style.background = team?.primary ?? '#334155';
      el.style.borderColor = team?.accent ?? '#64748b';
    };
    setBadge('sbBatTeam', s.batter.team, bt);
    setBadge('sbFieldTeam', s.pitcher.team, ft);
    this.$('sbBatRuns').textContent = g.score.batting;
    this.$('sbFieldRuns').textContent = g.score.fielding;
    this.$('sbInning').textContent = `${g.half === 'top' ? '▲' : '▼'} ${ordinal(g.inning)}`;
    this.$('out1').classList.toggle('on', g.outs >= 1);
    this.$('out2').classList.toggle('on', g.outs >= 2);
    this.$('sbOuts').textContent = `${Math.min(g.outs, 3)} OUT${g.outs === 1 ? '' : 'S'}`;
    this.$('sbBalls').textContent = g.balls;
    this.$('sbStrikes').textContent = g.strikes;
    g.bases.forEach((on, i) => this.$(`base${i + 1}`).classList.toggle('on', on));
  }

  _arsenal(s) {
    const key = `${s.pitcher.id}:${s.pitchCode}`;
    if (key === this._lastArsenalKey) return;
    this._lastArsenalKey = key;
    const list = this.$('arsenalList');
    list.replaceChildren();
    for (const row of PS.arsenalForUI(s.pitcher)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pitch-btn${row.code === s.pitchCode ? ' active' : ''}`;
      btn.style.setProperty('--pitch-color', row.color);
      const hk = document.createElement('kbd'); hk.textContent = row.hotkey;
      const name = document.createElement('span'); name.className = 'pb-name'; name.textContent = row.name;
      const mph = document.createElement('span'); mph.className = 'pb-mph mono'; mph.textContent = `${row.mph.toFixed(0)} MPH`;
      const meta = document.createElement('span'); meta.className = 'pb-meta';
      meta.textContent = `${row.rpm.toLocaleString('en-US')} RPM · BRK ${fmt.pct(row.breakPct)}`;
      const usage = document.createElement('span'); usage.className = 'pb-usage'; usage.style.width = `${row.usage}%`;
      btn.append(hk, name, mph, meta, usage);
      btn.onclick = () => this.onIntent({ type: 'select', code: row.code });
      list.appendChild(btn);
    }
  }

  _zone(s) {
    const box = this.$('zoneBox');
    const r = this.projector.projectZone(s.zone);
    box.style.transform = `translate(${r.left.toFixed(1)}px, ${r.top.toFixed(1)}px)`;
    box.style.width = `${r.width.toFixed(1)}px`;
    box.style.height = `${r.height.toFixed(1)}px`;
    const showZone = ['aim', 'meter', 'windup', 'result'].includes(s.phase);
    this.$('zoneLayer').classList.toggle('visible', showZone);

    // Aim reticle (cyan) with its control-driven radius.
    const ret = this.$('aimReticle');
    const aiming = ['aim', 'meter', 'windup'].includes(s.phase);
    ret.classList.toggle('visible', aiming);
    ret.classList.toggle('locked', s.phase !== 'aim');
    if (aiming) {
      const c = this.projector.worldToScreen(s.aim.x, s.aim.y, PLATE.frontZ);
      const e = this.projector.worldToScreen(s.aim.x + s.reticleIn * IN, s.aim.y, PLATE.frontZ);
      const rad = Math.max(6, Math.hypot(e.x - c.x, e.y - c.y));
      ret.style.transform = `translate(${(c.x - rad).toFixed(1)}px, ${(c.y - rad).toFixed(1)}px)`;
      ret.style.width = ret.style.height = `${(2 * rad).toFixed(1)}px`;
    }

    // Pitch-location dots for this plate appearance.
    const dotsKey = `${s.paHistory.length}:${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}`;
    if (dotsKey !== this._dotsKey) {
      this._dotsKey = dotsKey;
      const wrap = this.$('pitchDots');
      wrap.replaceChildren();
      for (const d of s.paHistory) {
        const p = this.projector.worldToScreen(d.x, d.y, PLATE.frontZ);
        const dot = document.createElement('span');
        dot.className = `pdot ${d.event}`;
        dot.style.transform = `translate(${(p.x - 9).toFixed(1)}px, ${(p.y - 9).toFixed(1)}px)`;
        dot.style.background = PS.PITCH_TYPES[d.code]?.color ?? '#fff';
        dot.textContent = d.n;
        wrap.appendChild(dot);
      }
    }
  }

  _meter(s) {
    const m = s.meter;
    const el = this.$('meter');
    const show = s.phase === 'meter' || s.phase === 'windup';
    el.classList.toggle('visible', show);
    if (!show) return;
    this.$('meterNeedle').style.left = `${(m.value * 100).toFixed(2)}%`;
    const g = this.$('meterGreen');
    g.style.left = `${((m.greenCenter - m.greenHalf) * 100).toFixed(2)}%`;
    g.style.width = `${(2 * m.greenHalf * 100).toFixed(2)}%`;
    const e = this.$('meterEffort');
    e.style.left = `${(m.effort[0] * 100).toFixed(2)}%`;
    e.style.width = `${((m.effort[1] - m.effort[0]) * 100).toFixed(2)}%`;
    const grade = s.phase === 'windup' ? this._lastGrade ?? '' : '';
    const gEl = this.$('meterGrade');
    if (gEl.textContent !== grade) {
      gEl.textContent = grade;
      gEl.dataset.grade = grade.split(' ')[0];
    }
  }

  _prompt(s) {
    const touch = matchMedia?.('(pointer: coarse)').matches;
    const text = {
      aim: touch ? 'Drag to aim · tap a pitch · lift to set the spot' : 'Move to aim · 1–5 pick a pitch · click to set the spot',
      meter: 'Stop the needle in the green · far right = max effort',
      windup: '',
      flight: '',
      batted: '',
      result: touch ? 'Tap to continue' : 'Click to continue · R slow-mo replay',
      replay: 'Replay · 1/8 speed',
    }[s.phase] ?? '';
    const el = this.$('prompt');
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('visible', Boolean(text));
    this.$('help').textContent = touch ? '' : 'V camera · P pause · arrows nudge aim';
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function pillFor(p) {
  const r = p.result;
  if (r === 'HR') return { label: 'HOME RUN', tone: 'emerald' };
  if (r === '1B' || r === '2B' || r === '3B') return { label: { '1B': 'SINGLE', '2B': 'DOUBLE', '3B': 'TRIPLE' }[r], tone: 'cyan' };
  if (r === 'K') return { label: 'STRIKEOUT', tone: 'amber' };
  if (r === 'BB') return { label: 'WALK', tone: 'slate' };
  if (r && r.startsWith('OUT')) return { label: 'OUT', tone: 'rose' };
  const call = p.call ?? '';
  if (call.includes('BALL')) return { label: 'BALL', tone: 'slate' };
  if (call.includes('FOUL')) return { label: 'FOUL', tone: 'slate' };
  return { label: 'STRIKE', tone: 'amber' };
}

/** One-line play description in broadcast voice. */
export function describe(p) {
  const pitcher = p.players.pitcher.name, batter = p.players.batter.name;
  const pitch = `${fmt.mph(p.pitch.releaseMph)} mph ${p.pitch.name.toLowerCase()}`;
  const c = p.contact, b = p.batted;
  if (c) {
    const sweet = c.sweetSpotPct >= 90 ? 'squares up' : c.sweetSpotPct >= 60 ? 'barrels' : 'gets a piece of';
    const tail = b ? `, projected ${fmt.ft(b.projDistFt)} ft` : '';
    const what = {
      HR: 'Gone!', '1B': 'Base hit.', '2B': 'Into the gap for a double.', '3B': 'Triple!',
      OUT_FLY: 'Caught on the fly.', OUT_LINE: 'Lined out.', OUT_GROUND: p.text ?? 'Grounded out.',
    }[p.result] ?? (p.call === 'FOUL' ? 'Foul ball.' : p.text ?? '');
    return `${batter} ${sweet} a ${pitch}: ${fmt.mph(c.evMph)} mph off the bat at ${fmt.deg(c.laDeg)}°${tail}. ${what}`;
  }
  const loc = p.isStrike ? 'in the zone' : 'off the plate';
  switch (p.call) {
    case 'STRIKE': return `${pitcher} drops a ${pitch} ${loc}. Called strike.`;
    case 'STRIKE THREE': return `${pitcher} freezes ${batter} with a ${pitch}. Strike three, called.`;
    case 'STRIKEOUT': return `${batter} chases a ${pitch} and misses. Strikeout.`;
    case 'SWINGING STRIKE': return `${batter} swings through a ${pitch}.`;
    case 'FOUL TIP': return `${batter} just tips a ${pitch}.`;
    case 'BALL FOUR': return `${pitch[0].toUpperCase()}${pitch.slice(1)} ${loc}. Ball four, ${batter} takes his base.`;
    default: return `${pitcher}'s ${pitch} misses ${loc}. Ball.`;
  }
}
