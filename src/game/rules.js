// Baseball rules for the pitcher–batter duel: count, outs, bases and runs.
// Pure functions over plain state objects (no DOM, no rendering) so they are
// unit-testable and replayable. GameLoop is the only caller.

/** Default "Showdown" scenario from the HUD mock-up: top of the 9th, 1 out, home up 4–3. */
export const SHOWDOWN = Object.freeze({ inning: 9, half: 'top', outs: 1, battingRuns: 3, fieldingRuns: 4, bases: [false, false, false] });

export function newGame(scenario = SHOWDOWN) {
  return {
    inning: scenario.inning,
    half: scenario.half,
    outs: scenario.outs,
    balls: 0,
    strikes: 0,
    bases: [...scenario.bases],          // [first, second, third] occupied?
    score: { batting: scenario.battingRuns, fielding: scenario.fieldingRuns },
    pitchCount: 0,
    paCount: 0,
    stats: { K: 0, BB: 0, H: 0, HR: 0, R: 0, outsRecorded: 0 },
    over: false,
    log: [],
  };
}

const HIT_BASES = { '1B': 1, '2B': 2, '3B': 3, HR: 4 };

/**
 * Applies one pitch. `event.type` is one of:
 *   'ball' | 'called_strike' | 'swinging_strike' | 'foul' | 'foul_tip' | 'in_play'
 * For 'in_play', `event.outcome` is a PhysicsEngine.classifyOutcome() result and
 * `event.batted` the simulateBattedBall() result (for sac flies / double plays).
 *
 * Returns { state, paEnded, result, runs, text } — a new state object; the input is not mutated.
 * `result` is the plate-appearance result when paEnded ('K', 'BB', '1B', 'OUT_FLY', ...).
 */
export function applyPitch(prev, event) {
  const s = structuredClone(prev);
  s.pitchCount++;
  let paEnded = false, result = null, runs = 0, text = '';

  switch (event.type) {
    case 'ball':
      s.balls++;
      text = 'Ball';
      if (s.balls >= 4) {
        runs = walk(s);
        paEnded = true;
        result = 'BB';
        s.stats.BB++;
        text = 'Ball four';
      }
      break;
    case 'called_strike':
    case 'swinging_strike':
    case 'foul_tip':
      s.strikes++;
      text = event.type === 'called_strike' ? 'Called strike' : event.type === 'foul_tip' ? 'Foul tip' : 'Swinging strike';
      if (s.strikes >= 3) {
        s.outs++;
        s.stats.K++;
        s.stats.outsRecorded++;
        paEnded = true;
        result = 'K';
        text = event.type === 'called_strike' ? 'Strike three, called' : 'Strike three, swinging';
      }
      break;
    case 'foul':
      if (s.strikes < 2) s.strikes++;
      text = 'Foul ball';
      break;
    case 'in_play': {
      const r = event.outcome?.result;
      paEnded = true;
      result = r;
      if (r in HIT_BASES) {
        runs = advanceOnHit(s, HIT_BASES[r]);
        s.stats.H++;
        if (r === 'HR') s.stats.HR++;
        text = { '1B': 'Single', '2B': 'Double', '3B': 'Triple', HR: 'Home run' }[r];
      } else if (r === 'OUT_GROUND') {
        ({ runs, text } = groundOut(s, event));
      } else if (r === 'OUT_FLY' || r === 'OUT_LINE') {
        ({ runs, text } = airOut(s, event));
      } else if (r === 'FOUL') {
        // Defensive: classifyOutcome FOUL is routed as a foul ball by GameLoop.
        paEnded = false;
        result = null;
        if (s.strikes < 2) s.strikes++;
        text = 'Foul ball';
      }
      break;
    }
    default:
      throw new Error(`Unknown pitch event "${event.type}"`);
  }

  s.score.batting += runs;
  s.stats.R += runs;
  if (paEnded) {
    s.balls = 0;
    s.strikes = 0;
    s.paCount++;
  }
  if (s.outs >= 3) s.over = true;
  s.log.push({ pitch: s.pitchCount, type: event.type, result, runs, text });
  return { state: s, paEnded, result, runs, text };
}

/** Forced advancement on a walk; returns runs scored. */
function walk(s) {
  const [b1, b2, b3] = s.bases;
  const runs = b1 && b2 && b3 ? 1 : 0;
  s.bases = [true, b1 || b2, (b1 && b2) || b3];
  return runs;
}

/** Runners move up `n` bases (a runner on second scores on a single); the batter takes base n. */
function advanceOnHit(s, n) {
  let runs = 0;
  const next = [false, false, false];
  for (let b = 2; b >= 0; b--) {
    if (!s.bases[b]) continue;
    const advance = n === 1 && b === 1 ? 2 : n; // runner from second scores on a single
    const to = b + advance;
    if (to >= 3) runs++; else next[to] = true;
  }
  if (n >= 4) runs++; else next[n - 1] = true;
  s.bases = next;
  return runs;
}

function groundOut(s, event) {
  const ev = event.batted?.evMph ?? 80;
  const [b1, b2, b3] = s.bases;
  // Double play: runner on first, fewer than two outs, ball hit firmly.
  if (b1 && s.outs < 2 && ev >= 85) {
    s.outs += 2;
    s.stats.outsRecorded += 2;
    const live = s.outs < 3;
    const runs = live && b3 ? 1 : 0;
    s.bases = [false, false, live && b2];
    return { runs, text: 'Grounds into a double play' };
  }
  s.outs++;
  s.stats.outsRecorded++;
  if (s.outs >= 3) return { runs: 0, text: 'Groundout' };
  if (b1) {
    // Fielder's choice: lead runner forced at second, batter safe at first;
    // forced runners move up.
    const runs = b2 && b3 ? 1 : 0;
    s.bases = [true, false, b2 || b3];
    return { runs, text: "Fielder's choice" };
  }
  // No force at first: runners advance a base on the groundout.
  const runs = b3 ? 1 : 0;
  s.bases = [false, false, b2];
  return { runs, text: 'Groundout' };
}

function airOut(s, event) {
  s.outs++;
  s.stats.outsRecorded++;
  let runs = 0;
  const deep = (event.batted?.projectedDistFt ?? 0) >= 250;
  if (event.outcome.result === 'OUT_FLY' && deep && s.bases[2] && s.outs < 3) {
    runs = 1;
    s.bases = [s.bases[0], s.bases[1], false];
    return { runs, text: 'Sacrifice fly' };
  }
  return { runs, text: event.outcome.result === 'OUT_FLY' ? 'Flyout' : 'Lineout' };
}

/** Maps a pitch with no ball in play to a rules event type. */
export function nonContactEvent({ swung, contactKind, isStrike }) {
  if (swung) {
    if (contactKind === 'foulTip') return 'foul_tip';
    return 'swinging_strike';
  }
  return isStrike ? 'called_strike' : 'ball';
}

/** Short count string, e.g. "2-1". */
export const countString = (s) => `${s.balls}-${s.strikes}`;

/** Final verdict for the pitching side once the half-inning ends. */
export function verdict(s) {
  const lead = s.score.fielding - s.score.batting;
  if (lead > 0) return { title: 'Ballgame!', detail: `Save converted, ${s.score.fielding}–${s.score.batting}.`, win: true };
  if (lead === 0) return { title: 'Tied up', detail: 'Headed to the bottom of the 9th all square.', win: false };
  return { title: 'Blown save', detail: `The lead slipped away, ${s.score.batting}–${s.score.fielding}.`, win: false };
}
