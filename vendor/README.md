# Vendored dependencies

`three/` is [three.js](https://threejs.org) **r170** (`three@0.170.0` from npm), MIT-licensed (see `three/LICENSE`).
Only the minified core build and the post-processing addons the renderer imports are included,
so the game runs from any static server with no CDN or network access.

To refresh: `npm pack three@0.170.0`, then copy `build/three.module.min.js` and the files under
`examples/jsm/` listed here (plus their relative imports).
