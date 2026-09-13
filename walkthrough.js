// The example page's "phone video": a first-person camera walking a loop
// through the room at eye height, with a little handheld sway. It is a
// stand-in until a real capture goes up, and is labelled as one.
import * as THREE from 'three';

export const WALK_SECONDS = 26;
export const EYE = 1.45;

// a loop across the free floor, keeping clear of the furniture
const path = new THREE.CatmullRomCurve3([
  new THREE.Vector3(1.55, EYE, 1.45), new THREE.Vector3(0.6, EYE, 1.5),
  new THREE.Vector3(-0.9, EYE, 1.35), new THREE.Vector3(-1.2, EYE, 0.4),
  new THREE.Vector3(-0.2, EYE, 0.15), new THREE.Vector3(0.9, EYE, -0.35),
  new THREE.Vector3(1.55, EYE, 0.5),
], true, 'centripetal', 0.6);
// the camera looks a beat ahead of where it is, drifting toward the room
const centre = new THREE.Vector3(-0.4, 1.1, -0.5);
const ahead = new THREE.Vector3();

// Where the phone is and what it looks at, t in [0, 1] along the loop.
export function cameraPose(t, now, sway, out) {
  path.getPointAt(t % 1, out.pos);
  path.getPointAt((t + 0.06) % 1, ahead);
  out.pos.y = EYE + Math.sin(now / 420) * 0.012 * sway;
  out.look.copy(ahead).lerp(centre, 0.55);
  out.look.y = 1.05 + Math.sin(now / 1900) * 0.08 * sway;
  out.look.x += Math.sin(now / 2300) * 0.12 * sway;
}

const pose = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
export function walkCamera(camera, t, now, reduced) {
  const sway = reduced ? 0 : 1;
  cameraPose(t, now, sway, pose);
  camera.position.copy(pose.pos);
  camera.lookAt(pose.look);
  camera.rotation.z += Math.sin(now / 1700) * 0.006 * sway;
  camera.fov = 62;
  camera.updateProjectionMatrix();
}
