// The example page's "phone video": a first-person camera walking a loop
// through the room at eye height, with a little handheld sway. It is a
// stand-in until a real capture goes up, and is labelled as one.
import * as THREE from 'three';
import { createScene } from './scene.js';
import { THEMES, LAYOUTS, buildItem, tickMaterials } from './room.js';

const LOOP_SECONDS = 26;
const EYE = 1.45;

export function createWalkthrough(canvas, ui = {}) {
  const S = createScene(canvas, THEMES.original, {}, { closed: true });
  for (const it of LAYOUTS.original) {
    const g = buildItem(it.type, S.mats);
    g.position.set(it.x, 0, it.z);
    g.rotation.y = THREE.MathUtils.degToRad(it.rot || 0);
    S.scene.add(g);
  }
  // a loop across the free floor, keeping clear of the furniture
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(1.55, EYE, 1.45), new THREE.Vector3(0.6, EYE, 1.5),
    new THREE.Vector3(-0.9, EYE, 1.35), new THREE.Vector3(-1.2, EYE, 0.4),
    new THREE.Vector3(-0.2, EYE, 0.15), new THREE.Vector3(0.9, EYE, -0.35),
    new THREE.Vector3(1.55, EYE, 0.5),
  ], true, 'centripetal', 0.6);
  // where the camera looks, a beat ahead of where it is, drifting toward the room
  const centre = new THREE.Vector3(-0.4, 1.1, -0.5);
  const pos = new THREE.Vector3(), ahead = new THREE.Vector3(), look = new THREE.Vector3();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();

  function update(dt, now) {
    const t = reduced ? 0.12 : (((now - t0) / 1000) % LOOP_SECONDS) / LOOP_SECONDS;
    path.getPointAt(t, pos);
    path.getPointAt((t + 0.06) % 1, ahead);
    const sway = reduced ? 0 : 1;
    pos.y = EYE + Math.sin(now / 420) * 0.012 * sway;
    look.copy(ahead).lerp(centre, 0.55);
    look.y = 1.05 + Math.sin(now / 1900) * 0.08 * sway;
    look.x += Math.sin(now / 2300) * 0.12 * sway;
    S.camera.position.copy(pos);
    S.camera.lookAt(look);
    S.camera.rotation.z += Math.sin(now / 1700) * 0.006 * sway;
    S.camera.fov = 62;
    S.camera.updateProjectionMatrix();
    tickMaterials(S.mats);
    S.renderer.render(S.scene, S.camera);
    if (ui.clock) {
      const s = Math.floor(t * LOOP_SECONDS);
      ui.clock.textContent = `00:${String(s).padStart(2, '0')}`;
    }
    if (ui.bar) ui.bar.style.transform = `scaleX(${t})`;
  }
  return { update };
}
