# Pitcher vs. Batter — StatCast Duel

A browser-based 3D baseball duel between a pitcher and a batter (Three.js, WebGL2 with an optional WebGPU path). It uses Magnus/seam-shifted-wake aerodynamics, an impulse-based bat–ball collision model, and MLB-anchored player ratings.

**Status:** Phases 0–3 done. **Pitching mode is playable:** pitch to a CPU lineup of MLB stars in a 3D ballpark with a StatCast HUD. Batting mode is Phase 4. The full blueprint (project layout, physics equations and matrices, module-by-module build steps) is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The HUD design reference is [`reference/statcast_boilerplate.html`](reference/statcast_boilerplate.html).

## Run it

```bash
python3 -m http.server 8080   # then open http://localhost:8080
npm test                      # physics & roster tests (Node 20+)
```

No install or network access is needed: three.js r170 is vendored in `vendor/three/`.

## How to play (Phase 3: pitching mode)

Pick your pitcher, the lead-off batter and a CPU difficulty, then protect a one-run lead in the top of the 9th.

| Input | Action |
|---|---|
| Mouse / drag | Aim. The cyan reticle shrinks as you settle; better Control shrinks it faster and tighter. |
| `1`–`5` or click | Choose a pitch from the real arsenal |
| Click / `Space` / lift finger | Lock the spot, then stop the meter needle in the green. The striped red end is max effort: +1.2 mph, but wilder. |
| `R` (after a pitch) | Slow-motion side replay with true spin |
| `V` | Toggle pitching and broadcast cameras |
| `P` / `Esc` | Pause |
| Arrow keys | Nudge the aim |

After every pitch the StatCast panel shows pitch speed, spin, exit velocity, launch angle, projected distance, movement, timing, xBA and barrel flags.

URL options: `?quality=0.5` (lighter crowd), `?bloom=0`, `?debug=1` (fps / draw calls), `?seed=42`.

Batting mode arrives in Phase 4.
