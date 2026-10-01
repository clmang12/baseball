// Creates the renderer and post-processing chain. WebGL2 ships first; the
// WebGPU path (Phase 6) is requested with ?gpu=webgpu and currently falls back
// to WebGL2 with a console note, so the rest of the code never branches on it.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function createRenderer(canvas, { backend = 'webgl', bloom = true, pixelRatio = Math.min(window.devicePixelRatio || 1, 2) } = {}) {
  if (backend === 'webgpu') {
    console.info('[renderer] WebGPU path not implemented yet (Phase 6); using WebGL2.');
  }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(pixelRatio);
  renderer.info.autoReset = false; // bloom renders several passes; count the whole frame

  let composer = null, bloomPass = null, renderPass = null;
  const state = {
    renderer,
    backend: 'webgl',
    pixelRatio,
    bloomEnabled: bloom,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    setSize(w, h) {
      renderer.setSize(w, h, false);
      if (composer) {
        composer.setPixelRatio(state.pixelRatio);
        composer.setSize(w, h);
      }
    },
    setPixelRatio(pr) {
      state.pixelRatio = pr;
      renderer.setPixelRatio(pr);
      if (composer) composer.setPixelRatio(pr);
    },
    setBloom(on) {
      state.bloomEnabled = on;
    },
    render(scene, camera) {
      renderer.info.reset();
      if (state.bloomEnabled) {
        if (!composer) {
          composer = new EffectComposer(renderer);
          renderPass = new RenderPass(scene, camera);
          const size = renderer.getSize(new THREE.Vector2());
          bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.45, 1.6);
          composer.addPass(renderPass);
          composer.addPass(bloomPass);
          composer.addPass(new OutputPass());
          composer.setPixelRatio(state.pixelRatio);
          composer.setSize(size.x, size.y);
        }
        renderPass.scene = scene;
        renderPass.camera = camera;
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    },
    get bloomPass() { return bloomPass; },
    dispose() {
      composer?.dispose();
      renderer.dispose();
    },
  };
  return state;
}
