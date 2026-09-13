// The hero: the room appears the way the pipeline builds it. Points scattered
// like a raw capture settle onto the floor and walls first, then the
// furniture, and the solid room fades in over them.
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { createScene, easeOut, clamp } from './scene.js';
import { THEMES, LAYOUTS, buildItem, tickMaterials, setTheme } from './room.js';

const PHASES = [
  [0.0, 'Reading frames'],
  [0.5, 'Solving the camera path'],
  [1.3, 'Measuring depth in metres'],
  [2.2, 'Finding walls, floor and furniture'],
  [3.15, 'Ready to edit'],
];
const FADE_START = 3.0, FADE_DUR = 0.9, END = 4.2;

export function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.7, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function meshArea(mesh) {
  const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia); b.fromBufferAttribute(pos, ib); c.fromBufferAttribute(pos, ic);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area;
}

// Points spread over the surfaces of every mesh, in proportion to area, each
// remembering which mesh it came from. World space; meshes must be placed.
export function samplePoints(meshes, total) {
  const areas = meshes.map(meshArea);
  const sum = areas.reduce((s, v) => s + v, 0);
  const target = new Float32Array(total * 3), color = new Float32Array(total * 3);
  const owner = new Uint16Array(total);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  let k = 0;
  meshes.forEach((mesh, mi) => {
    const count = mi === meshes.length - 1 ? total - k : Math.round(total * areas[mi] / sum);
    if (count <= 0) return;
    const sampler = new MeshSurfaceSampler(mesh).build();
    const col = mesh.material.color;
    for (let i = 0; i < count && k < total; i++, k++) {
      sampler.sample(p, n);
      p.applyMatrix4(mesh.matrixWorld);
      target.set([p.x, p.y, p.z], k * 3);
      const jitter = 0.66 + Math.random() * 0.16; // darker than the surface, like a raw scan
      color.set([col.r * jitter, col.g * jitter, col.b * jitter], k * 3);
      owner[k] = mi;
    }
  });
  return { target, color, owner, count: k };
}

export function pointsMaterial() {
  return new THREE.PointsMaterial({
    size: 0.042, map: dotTexture(), alphaTest: 0.4, transparent: true, depthWrite: false,
    vertexColors: true, sizeAttenuation: true, opacity: 0,
  });
}

// The hero's cloud: every point also gets a scattered start and a delay, so
// the floor and walls settle first and the furniture after.
function buildCloud(meshes, total) {
  const { target, color, owner, count } = samplePoints(meshes, total);
  const start = new Float32Array(total * 3), delay = new Float32Array(total);
  const rng = () => Math.random();
  for (let k = 0; k < count; k++) {
    const j = k * 3;
    const part = meshes[owner[k]].userData.part;
    const base = part === 'floor' ? 0.5 : part === 'wall' ? 0.6 : 1.4;
    const r = 0.5 + rng() * 2.2;
    const th = rng() * Math.PI * 2, ph = Math.acos(2 * rng() - 1);
    start[j] = target[j] + r * Math.sin(ph) * Math.cos(th);
    start[j + 1] = target[j + 1] + 0.8 + r * Math.cos(ph);
    start[j + 2] = target[j + 2] + r * Math.sin(ph) * Math.sin(th);
    delay[k] = base + (target[j + 1] / 2.7) * 0.25 + rng() * 0.3;
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(start.slice(), 3);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
  const points = new THREE.Points(geo, pointsMaterial());
  points.frustumCulled = false;
  return { points, start, target, delay, pos: posAttr, count };
}

export function createHero(canvas, ui = {}, opts = {}) {
  const S = createScene(canvas, THEMES.original);
  for (const it of LAYOUTS.original) {
    const g = buildItem(it.type, S.mats);
    g.position.set(it.x, 0, it.z);
    g.rotation.y = THREE.MathUtils.degToRad(it.rot || 0);
    S.scene.add(g);
  }
  S.scene.updateMatrixWorld(true);
  const meshes = [];
  S.scene.traverse((o) => { if (o.isMesh && o.userData.part && o.userData.part !== 'contact') meshes.push(o); });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cloud = buildCloud(meshes, innerWidth < 700 ? 10000 : 26000);
  S.scene.add(cloud.points);
  const contact = S.room.group.children.find((o) => o.userData.part === 'contact');

  let t0 = null, phase = -1, done = false, doneAt = 0, restyled = false;
  const status = ui.status || null, pill = status ? status.parentElement : null;
  const say = (text) => { if (status) status.textContent = text; };

  function setOpacity(o) {
    for (const m of Object.values(S.mats)) {
      m.transparent = o < 1;
      m.opacity = o;
      m.needsUpdate = false;
    }
    if (contact) contact.material.opacity = o;
  }
  function setShadows(on) { for (const m of meshes) m.castShadow = on && m.userData.castsShadow !== false; }
  for (const m of meshes) m.userData.castsShadow = m.castShadow;

  function finish() {
    done = true;
    doneAt = performance.now();
    setOpacity(1);
    setShadows(true);
    cloud.points.visible = false;
    say(PHASES[PHASES.length - 1][1]);
    pill?.classList.add('is-done');
  }

  function start() {
    if (reduced) { finish(); return; }
    t0 = performance.now();
    phase = -1;
    done = false;
    cloud.points.visible = true;
    cloud.points.material.opacity = 0;
    cloud.pos.array.set(cloud.start);
    cloud.pos.needsUpdate = true;
    setOpacity(0);
    setShadows(false);
    pill?.classList.remove('is-done');
    if (restyled) { setTheme(S.mats, THEMES.original); restyled = false; }
  }

  function animateCloud(t) {
    const arr = cloud.pos.array, { start, target, delay, count } = cloud;
    for (let i = 0; i < count; i++) {
      const e = easeOut((t - delay[i]) / 1.2);
      const j = i * 3;
      arr[j] = start[j] + (target[j] - start[j]) * e;
      arr[j + 1] = start[j + 1] + (target[j + 1] - start[j + 1] * 1) * e + (1 - e) * Math.sin(t * 1.3 + i) * 0.015;
      arr[j + 2] = start[j + 2] + (target[j + 2] - start[j + 2]) * e;
    }
    cloud.pos.needsUpdate = true;
    const appear = clamp(t / 0.5, 0, 1);
    const vanish = t > FADE_START + 0.2 ? 1 - clamp((t - FADE_START - 0.2) / (FADE_DUR - 0.2), 0, 1) : 1;
    cloud.points.material.opacity = 0.95 * appear * vanish;
  }

  function update(dt, now) {
    if (t0 !== null && !done) {
      const t = (now - t0) / 1000;
      animateCloud(t);
      let p = 0;
      for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i][0]) p = i;
      if (p !== phase) { phase = p; say(PHASES[p][1]); }
      if (t >= FADE_START) {
        setOpacity(clamp((t - FADE_START) / FADE_DUR, 0, 1));
        if (t >= FADE_START + 0.35) setShadows(true);
      }
      if (t >= END) finish();
    } else if (done && opts.loop) {
      const held = now - doneAt;
      if (opts.restyle && !restyled && held > 2600) {
        restyled = true;
        setTheme(S.mats, opts.restyle);
        say(`Restyled: ${opts.restyle.name}`);
        pill?.classList.remove('is-done');
      }
      if (held > opts.loop) start();
    }
    // a slow look around while idle, plus a little parallax from the pointer
    S.orbit.azBase = 0.62 + Math.sin(now / 9000) * 0.05;
    tickMaterials(S.mats);
    S.render();
  }

  // look around by dragging, lean with the pointer otherwise
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      S.orbitBy(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    } else if (e.pointerType === 'mouse') {
      const r = canvas.getBoundingClientRect();
      S.orbit.pAz = ((e.clientX - r.left) / r.width - 0.5) * 0.12;
      S.orbit.pEl = -((e.clientY - r.top) / r.height - 0.5) * 0.08;
    }
  });
  const release = () => { drag = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { S.orbit.pAz = 0; S.orbit.pEl = 0; });

  ui.replay?.addEventListener('click', start);
  start();
  return { update, start };
}
