import * as THREE from "three";
import type { DirectorBody, DirectorPropKind } from "./directorCatalog";
import type { DirectorPose } from "./directorPose";

function shape(parent: THREE.Object3D, material: THREE.MeshStandardMaterial, geometry: THREE.BufferGeometry,
  x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function makeDirectorRig(root: THREE.Group, kind: DirectorBody, material: THREE.MeshStandardMaterial) {
  const width = kind === "female" ? 0.35 : 0.43;
  const stature = kind === "child" ? 0.7 : kind === "chibi" ? 0.55 : 1;
  const lift = new THREE.Group();
  lift.scale.setScalar(stature);
  root.add(lift);
  function pivot(parent: THREE.Object3D, x: number, y: number, z = 0) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);
    return group;
  }
  const hips = pivot(lift, 0, 0.92);
  const torso = pivot(hips, 0, 0.06);
  const head = pivot(torso, 0, 0.51);
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, x: number, y: number, z = 0) =>
    shape(parent, material, geometry, x, y, z);
  add(hips, new THREE.SphereGeometry(0.17, 14, 10), 0, 0.02);
  add(torso, new THREE.CylinderGeometry(width / 2, 0.14, 0.45, 14), 0, 0.24);
  add(head, new THREE.CylinderGeometry(0.067, 0.073, 0.13, 12), 0, 0.02);
  add(head, new THREE.CapsuleGeometry(kind === "chibi" ? 0.18 : 0.115, 0.08), 0, 0.15);
  add(head, new THREE.SphereGeometry(0.036, 10, 8), 0, 0.135, kind === "chibi" ? 0.175 : 0.108);
  const sides = ([1, -1] as const).map(side => {
    const arm = pivot(torso, side * (width / 2 + 0.035), 0.42);
    const elbow = pivot(arm, 0, -0.275);
    const leg = pivot(hips, side * 0.103, -0.022);
    const knee = pivot(leg, 0, -0.415);
    add(arm, new THREE.CapsuleGeometry(0.064, 0.19), 0, -0.135);
    add(elbow, new THREE.CapsuleGeometry(0.053, 0.18), 0, -0.115);
    add(elbow, new THREE.SphereGeometry(0.056, 12, 8), 0, -0.248);
    add(leg, new THREE.CapsuleGeometry(0.087, 0.27), 0, -0.195);
    add(knee, new THREE.CapsuleGeometry(0.064, 0.28), 0, -0.198);
    const foot = add(knee, new THREE.BoxGeometry(0.122, 0.107, 0.21), 0, -0.43, 0.055);
    return { side, arm, elbow, leg, knee, foot };
  });
  const corner = new THREE.Vector3();
  const relative = new THREE.Matrix4();
  const inverse = new THREE.Matrix4();
  const deg = THREE.MathUtils.degToRad;
  return (pose: DirectorPose | undefined) => {
    hips.rotation.set(deg(pose?.body?.bend ?? 0), deg(pose?.body?.turn ?? 0), deg(pose?.body?.tilt ?? 0), "YXZ");
    torso.rotation.set(deg(pose?.torso?.bend ?? 0), deg(pose?.torso?.turn ?? 0), deg(pose?.torso?.tilt ?? 0), "YXZ");
    head.rotation.set(deg(pose?.head?.nod ?? 0), deg(pose?.head?.turn ?? 0), deg(pose?.head?.tilt ?? 0), "YXZ");
    sides.forEach(({ side, arm, elbow, leg, knee }, index) => {
      const shoulder = index === 0 ? pose?.l_arm : pose?.r_arm;
      const hip = index === 0 ? pose?.l_leg : pose?.r_leg;
      arm.rotation.set(deg(-(shoulder?.raise ?? 0)), deg(side * (shoulder?.turn ?? 0)), deg(side * (shoulder?.straddle ?? 0)), "ZXY");
      leg.rotation.set(deg(-(hip?.raise ?? 0)), deg(side * (hip?.turn ?? 0)), deg(side * (hip?.straddle ?? 0)), "ZXY");
      elbow.rotation.x = deg(-(index === 0 ? pose?.l_elbow?.bend ?? 0 : pose?.r_elbow?.bend ?? 0));
      knee.rotation.x = deg(index === 0 ? pose?.l_knee?.bend ?? 0 : pose?.r_knee?.bend ?? 0);
    });
    lift.position.y = 0;
    root.updateWorldMatrix(true, true);
    inverse.copy(root.matrixWorld).invert();
    let floor = Infinity;
    for (const { foot } of sides) {
      relative.multiplyMatrices(inverse, foot.matrixWorld);
      for (const x of [-0.061, 0.061]) for (const y of [-0.0535, 0.0535]) for (const z of [-0.105, 0.105]) {
        floor = Math.min(floor, corner.set(x, y, z).applyMatrix4(relative).y);
      }
    }
    lift.position.y = -floor;
  };
}

export function addDirectorProp(root: THREE.Group, kind: DirectorPropKind, material: THREE.MeshStandardMaterial) {
  const add = (geometry: THREE.BufferGeometry, x: number, y: number, z: number, angle = 0) => {
    const mesh = shape(root, material, geometry, x, y, z);
    mesh.rotation.z = angle;
    return mesh;
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => add(new THREE.BoxGeometry(w, h, d), x, y, z);
  const cylinder = (top: number, bottom: number, h: number, x: number, y: number, z: number) =>
    add(new THREE.CylinderGeometry(top, bottom, h, 20), x, y, z);
  const ball = (r: number, x: number, y: number, z: number) => add(new THREE.SphereGeometry(r, 20, 14), x, y, z);
  const legs = (x: number, z: number, h: number) => {
    for (const side of [-x, x]) for (const depth of [-z, z]) box(0.065, h, 0.065, side, h / 2, depth);
  };
  switch (kind) {
    case "cube": box(1, 1, 1, 0, 0.5, 0); break;
    case "sphere": ball(0.5, 0, 0.5, 0); break;
    case "cylinder": cylinder(0.5, 0.5, 1, 0, 0.5, 0); break;
    case "torus": add(new THREE.TorusGeometry(0.36, 0.14, 12, 32), 0, 0.5, 0); break;
    case "cone": cylinder(0, 0.5, 1, 0, 0.5, 0); break;
    case "pyramid": add(new THREE.ConeGeometry(0.65, 1, 4), 0, 0.5, 0); break;
    case "chair":
    case "sofa":
    case "bench": {
      const width = kind === "chair" ? 0.53 : kind === "bench" ? 1.5 : 1.8;
      legs(width / 2 - 0.08, 0.22, 0.4);
      box(width, 0.12, 0.56, 0, 0.45, 0);
      box(width, 0.43, 0.11, 0, 0.69, -0.24);
      if (kind === "sofa") for (const side of [-1, 1]) box(0.14, 0.25, 0.56, side * 0.84, 0.58, 0);
      break;
    }
    case "square_table": box(1.35, 0.09, 0.83, 0, 0.77, 0); legs(0.56, 0.32, 0.75); break;
    case "round_table": cylinder(0.61, 0.61, 0.09, 0, 0.77, 0); cylinder(0.08, 0.27, 0.74, 0, 0.37, 0); break;
    case "wall_2m": case "wall_3m": box(kind === "wall_2m" ? 2 : 3, 2.35, 0.13, 0, 1.175, 0); break;
    case "column": cylinder(0.22, 0.24, 2.5, 0, 1.25, 0); break;
    case "staircase":
      for (let step = 1; step <= 6; step++) box(1.15, step * 0.17, 0.28, 0, step * 0.085, (step - 3.5) * -0.28);
      break;
    case "tree_small": case "tree_large": {
      const size = kind === "tree_large" ? 1.7 : 1;
      cylinder(0.06 * size, 0.12 * size, size * 1.4, 0, size * 0.7, 0);
      ball(0.59 * size, 0, size * 1.63, 0);
      ball(0.37 * size, -0.34 * size, size * 1.47, 0.14);
      ball(0.4 * size, 0.33 * size, size * 1.43, -0.1);
      break;
    }
    case "rock": add(new THREE.DodecahedronGeometry(0.51), 0, 0.32, 0, 0.27).scale.set(1.25, 0.68, 0.86); break;
    case "bush":
      ball(0.32, 0, 0.29, 0); ball(0.26, -0.3, 0.24, 0.07); ball(0.28, 0.27, 0.26, 0.1); break;
    case "car":
      box(1.7, 0.5, 3.65, 0, 0.57, 0); box(1.46, 0.48, 1.76, 0, 0.98, -0.28);
      for (const x of [-0.82, 0.82]) for (const z of [-1.13, 1.13]) {
        cylinder(0.33, 0.33, 0.21, x, 0.33, z).rotation.z = Math.PI / 2;
      }
      break;
    case "bicycle": {
      for (const z of [-0.65, 0.65]) add(new THREE.TorusGeometry(0.32, 0.025, 10, 32), 0, 0.345, z).rotation.y = Math.PI / 2;
      const beam = (y: number, z: number, h: number, tilt: number) => { cylinder(0.024, 0.024, h, 0, y, z).rotation.x = tilt; };
      beam(0.52, -0.3, 0.78, 1.12); beam(0.54, 0.27, 0.7, -1.15); beam(0.69, 0.12, 0.68, 1.57);
      beam(0.55, -0.09, 0.62, -0.35); beam(0.62, 0.52, 0.74, -0.42);
      box(0.19, 0.05, 0.19, 0, 0.86, -0.16); box(0.49, 0.04, 0.04, 0, 0.95, 0.38);
      break;
    }
    case "streetlamp": cylinder(0.042, 0.075, 2.75, 0, 1.375, 0); box(0.24, 0.16, 0.58, 0, 2.72, 0.22); break;
    case "trash_bin": cylinder(0.28, 0.23, 0.63, 0, 0.315, 0); cylinder(0.3, 0.3, 0.067, 0, 0.65, 0); break;
    case "arrow": {
      box(0.14, 0.055, 0.7, 0, 0.035, -0.16);
      add(new THREE.ConeGeometry(0.24, 0.42, 4), 0, 0.055, 0.32).rotation.x = Math.PI / 2;
      break;
    }
    case "area_marker":
      box(1.6, 0.03, 0.065, 0, 0.022, 0.77); box(1.6, 0.03, 0.065, 0, 0.022, -0.77);
      box(0.065, 0.03, 1.6, 0.77, 0.022, 0); box(0.065, 0.03, 1.6, -0.77, 0.022, 0); break;
    case "image_board": {
      const board = add(new THREE.PlaneGeometry(1, 1), 0, 0.65, 0);
      material.side = THREE.DoubleSide;
      board.scale.set(1.6, 1.1, 1);
      return board;
    }
  }
  return null;
}
