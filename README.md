# Pitcher vs. Batter — StatCast Duel

A browser-based 3D baseball duel between a pitcher and a batter (Three.js, WebGL2 with an optional WebGPU path). It uses Magnus/seam-shifted-wake aerodynamics, an impulse-based bat–ball collision model, and MLB-anchored player ratings.

**Status:** Phases 0–1 done: core helpers, `PlayerStats.js` roster, and the headless `PhysicsEngine.js` (pitch flight, swing, collision, batted ball, outcomes), with tests. The full blueprint (project layout, physics equations and matrices, module-by-module build steps) is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The HUD design reference is [`reference/statcast_boilerplate.html`](reference/statcast_boilerplate.html).

Planned launch, once implemented:

```bash
python3 -m http.server 8080   # then open http://localhost:8080
npm test                      # node --test over tests/**/*.test.js
```
