// The example: a phone walking through the room on one side, and on the
// other the room appearing as it is scanned. Scan points show up where the
// phone has looked, the floor and walls solidify first, and each piece of
// furniture pops in once the camera has seen it. Both panels read the same
// clock, so they stay in step.
import * as THREE from 'three';
import { createScene, easeOut, clamp } from './scene.js';
import { THEMES, LAYOUTS, ITEMS, ROOM, buildItem, tickMaterials } from './room.js';
import { samplePoints, pointsMaterial } from './hero.js';
import { WALK_SECONDS, walkCamera, cameraPose } from './walkthrough.js';

const HOLD = 6;                       // seconds the finished room stays before the loop restarts
const CYCLE = WALK_SECONDS + HOLD;
const SHELL_AT = 0.26;                // share of the walk after which the floor and walls solidify
const LAG = 0.9;                      // seconds between a piece's points appearing and the piece itself
const SHELL_ROLES = ['wall', 'skirting', 'floor', 'frame', 'glass'];

export function createScanExample(ui = {}) {
  const t0 = performance.now();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const say = (text) => { if (ui.status) ui.status.textContent = text; };
  const pill = ui.status ? ui.status.parentElement : null;

  function phase(now) {
    const sec = ((now - t0) / 1000) % CYCLE;
    return { t: reduced ? 1 : clamp(sec / WALK_SECONDS, 0, 1), hold: sec >= WALK_SECONDS, sec };
  }

  // The camera's path, sampled once, to work out when each thing gets seen.
  const STEPS = 120;
  const poses = [];
  const tmp = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
  for (let i = 0; i < STEPS; i++) {
    cameraPose(i / STEPS, 0, 0, tmp);
    poses.push({ pos: tmp.pos.clone(), fwd: tmp.look.clone().sub(tmp.pos).normalize() });
  }
  const v = new THREE.Vector3();
  // First moment the point is inside the phone's view and near enough; if it
  // never is, the moment the phone passes closest (peripheral vision).
  function seenAt(p, cone = 0.78, reach = 4.5) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < STEPS; i++) {
      v.copy(p).sub(poses[i].pos);
      const d = v.length();
      if (d < reach && v.divideScalar(d).dot(poses[i].fwd) > cone) return i / STEPS;
      if (d < bestD) { bestD = d; best = i / STEPS; }
    }
    return Math.min(0.96, best + 0.05);
  }

  function walk(canvas) {
    const S = createScene(canvas, THEMES.original, {}, { closed: true });
    for (const it of LAYOUTS.original) {
      const g = buildItem(it.type, S.mats);
      g.position.set(it.x, 0, it.z);
      g.rotation.y = THREE.MathUtils.degToRad(it.rot || 0);
      S.scene.add(g);
    }
    return {
      update(dt, now) {
        const { t, hold } = phase(now);
        walkCamera(S.camera, hold ? 1 : t, now, reduced || hold);
        tickMaterials(S.mats);
        S.renderer.render(S.scene, S.camera);
        if (ui.clock) {
          const s = Math.floor(t * WALK_SECONDS);
          ui.clock.textContent = hold ? `00:${WALK_SECONDS} · saved` : `00:${String(s).padStart(2, '0')}`;
        }
        if (ui.bar) ui.bar.style.transform = `scaleX(${t})`;
        if (ui.rec) ui.rec.classList.toggle('is-saved', hold);
      },
    };
  }

  function result(canvas) {
    const S = createScene(canvas, THEMES.original);
    const items = LAYOUTS.original.map((it) => {
      const g = buildItem(it.type, S.mats);
      g.position.set(it.x, 0, it.z);
      g.rotation.y = THREE.MathUtils.degToRad(it.rot || 0);
      S.scene.add(g);
      const spec = ITEMS[it.type];
      const seen = seenAt(new THREE.Vector3(it.x, spec.h / 2, it.z));
      return { group: g, seen, reveal: seen + LAG / WALK_SECONDS, label: spec.label };
    });
    S.scene.updateMatrixWorld(true);
    const meshes = [];
    S.scene.traverse((o) => { if (o.isMesh && o.userData.part && o.userData.part !== 'contact') meshes.push(o); });
    const contact = S.room.group.children.find((o) => o.userData.part === 'contact');

    // the scan: every point knows when the phone first saw it
    const total = innerWidth < 700 ? 8000 : 16000;
    const cloud = samplePoints(meshes, total);
    const seen = new Float32Array(cloud.count);
    const p = new THREE.Vector3();
    const itemOfMesh = meshes.map((m) => items.find((it) => { let o = m; while (o) { if (o === it.group) return true; o = o.parent; } return false; }));
    for (let k = 0; k < cloud.count; k++) {
      const it = itemOfMesh[cloud.owner[k]];
      if (it) seen[k] = it.seen + Math.random() * 0.02;             // a piece's points arrive together
      else seen[k] = seenAt(p.fromArray(cloud.target, k * 3), 0.7, 5.5) + Math.random() * 0.015;
    }
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(cloud.count * 3).fill(-100), 3);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', new THREE.BufferAttribute(cloud.color.slice(0, cloud.count * 3), 3));
    const points = new THREE.Points(geo, pointsMaterial());
    points.frustumCulled = false;
    S.scene.add(points);

    const shell = SHELL_ROLES.map((r) => S.mats[r]);
    for (const m of meshes) m.userData.castsShadow = m.castShadow;

    function setShell(o) {
      for (const m of shell) { m.transparent = o < 1; m.opacity = o; }
      if (contact) contact.material.opacity = o;
      const cast = o > 0.5;
      for (const m of meshes) if (m.userData.part !== 'furniture') m.castShadow = cast && m.userData.castsShadow;
    }

    let lastFound = -1, wasHold = null;
    return {
      update(dt, now) {
        const { t, hold, sec } = phase(now);
        // points appear where the phone has looked, dropping the last few centimetres into place
        const arr = posAttr.array;
        for (let k = 0; k < cloud.count; k++) {
          const j = k * 3;
          if (t < seen[k]) { arr[j] = 0; arr[j + 1] = -100; arr[j + 2] = 0; continue; }
          const e = easeOut((t - seen[k]) * WALK_SECONDS / 0.7);
          arr[j] = cloud.target[j];
          arr[j + 1] = cloud.target[j + 1] + (1 - e) * 0.3;
          arr[j + 2] = cloud.target[j + 2];
        }
        posAttr.needsUpdate = true;
        points.material.opacity = hold ? 0.9 * (1 - clamp((sec - WALK_SECONDS) / 1.2, 0, 1)) : 0.9;
        points.visible = points.material.opacity > 0.01;
        // the floor and walls solidify once enough of them has been seen
        setShell(clamp((t - SHELL_AT) * WALK_SECONDS / 1.6, 0, 1));
        // each piece pops in a beat after its points
        let found = 0;
        for (const it of items) {
          const e = easeOut((t - it.reveal) * WALK_SECONDS / 0.55);
          const s = e > 0 ? Math.max(0.001, e) : 0.001;
          it.group.scale.setScalar(s);
          it.group.visible = e > 0;
          if (t >= it.seen) found++;
        }
        if (hold !== wasHold || found !== lastFound) {
          wasHold = hold; lastFound = found;
          if (hold) say(`Rebuilt · ${items.length} pieces · ${ROOM.w} × ${ROOM.d} m`);
          else if (t < SHELL_AT) say('Scanning · finding the floor and walls');
          else say(`Scanning · ${found} of ${items.length} pieces found`);
          pill?.classList.toggle('is-done', hold);
        }
        S.orbit.azBase = 0.62 + Math.sin(now / 9000) * 0.05;
        tickMaterials(S.mats);
        S.render();
      },
    };
  }

  return { walk, result };
}
