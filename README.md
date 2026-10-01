# Pitcher vs. Batter — StatCast Duel

A browser-based 3D baseball duel between a pitcher and a batter (Three.js, WebGL2 with an optional WebGPU path). It uses Magnus/seam-shifted-wake aerodynamics, an impulse-based bat–ball collision model, and MLB-anchored player ratings.

**Status:** Phases 0–2 done: roster and ratings, the physics engine (pitch flight, swing, collision, batted ball, outcomes), and the 3D ballpark that plays back pitches. The playable game loop and HUD arrive in Phase 3. The full blueprint (project layout, physics equations and matrices, module-by-module build steps) is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The HUD design reference is [`reference/statcast_boilerplate.html`](reference/statcast_boilerplate.html).

## Run it

```bash
python3 -m http.server 8080   # then open http://localhost:8080
npm test                      # physics & roster tests (Node 20+)
```

No install or network access is needed: three.js r170 is vendored in `vendor/three/`.

The current build (Phase 2) auto-throws pitches from the roster and plays them back in 3D:

| Key | Action |
|---|---|
| `V` | Cycle camera: pitching, batting (RHB/LHB), broadcast, replay side |
| `Space` | Throw now (stops auto-throw) |
| `1`–`5` | Choose the pitch type |
| `P` | Next pitcher |
| `R` | Slow-motion side replay at 1/8 speed, with true spin rate |
| `T` / `B` / `D` | Toggle trail, bloom, perf stats |

URL options: `?view=broadcast`, `?pitcher=skubal`, `?quality=0.5` (lighter crowd), `?bloom=0`, `?auto=0`, `?seed=42`, `?debug=1`.
