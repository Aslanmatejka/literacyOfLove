/**
 * Literacy of Love — village animals (Ankole cattle, goats, dogs, chickens).
 *
 * Each animal is built from smooth, rounded shapes (a lofted body, tapered
 * limbs, curved horns) and rigged with real joints: legs swing at the hip and
 * bend at the knee in the right gait for the species, heads lower to graze or
 * peck, and tails swish or wag.
 *
 * Performance: every body part of every animal of a kind is one GPU-instanced
 * draw call (legs included: one instance per leg), and the joints are just a
 * few matrix multiplies per animal per frame.
 */
import * as THREE from './vendor/three-r170/three.module.min.js';
import { mergeGeometries } from './vendor/three-r170/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

/** Detail level while a species is being built (1 = full, ~0.5 for distant herds). */
let LOD = 1;
const seg = (n, min = 3) => Math.max(min, Math.round(n * LOD));

/* ------------------------------------------------------------------ */
/* Geometry builders (all return geometry with position/normal/color) */
/* ------------------------------------------------------------------ */

/** A colour: a number ≤ 4 is a grey multiplier (sRGB), otherwise a hex colour. */
function toColor(v) {
  if (v instanceof THREE.Color) return v;
  if (typeof v === 'number' && v <= 4) return new THREE.Color().setRGB(v, v, v, THREE.SRGBColorSpace);
  return new THREE.Color(v);
}

function paint(geo, colorOrFn) {
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const fixed = typeof colorOrFn === 'function' ? null : toColor(colorOrFn);
  for (let i = 0; i < pos.count; i += 1) {
    const c = fixed || colorOrFn(pos.getX(i), pos.getY(i), pos.getZ(i));
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Same attribute set everywhere, non-indexed, so any parts can be merged. */
function finalize(geo) {
  ['uv', 'uv1', 'uv2'].forEach((n) => { if (geo.attributes[n]) geo.deleteAttribute(n); });
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo.index ? geo.toNonIndexed() : geo;
}

const mix = (a, b, t) => toColor(a).clone().lerp(toColor(b), THREE.MathUtils.clamp(t, 0, 1));

/**
 * A smooth body built from cross-sections along z (like a boat hull).
 * section: { z, y, w (half width), ht (height above y), hb (depth below y), c }
 */
function loft(sections, radialFull = 12) {
  const radial = seg(radialFull, 5);
  const pos = [];
  const col = [];
  const idx = [];
  sections.forEach((s) => {
    const c = toColor(s.c ?? 1);
    // Height blends smoothly from the belly (hb) to the back (ht): no crease along the sides
    const mid = (s.ht + s.hb) / 2;
    const half = (s.ht - s.hb) / 2;
    for (let j = 0; j < radial; j += 1) {
      const th = (j / radial) * TAU;
      const sn = Math.sin(th);
      pos.push(s.w * Math.cos(th), (s.y ?? 0) + sn * mid + sn * sn * half, s.z);
      col.push(c.r, c.g, c.b);
    }
  });
  const ns = sections.length;
  for (let i = 0; i < ns - 1; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * radial + j;
      const b = (i + 1) * radial + j;
      const c = i * radial + ((j + 1) % radial);
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, c, d, b);
    }
  }
  const capAt = (s, ring, front) => {
    const centre = pos.length / 3;
    const c = toColor(s.c ?? 1);
    pos.push(0, s.y ?? 0, s.z);
    col.push(c.r, c.g, c.b);
    for (let j = 0; j < radial; j += 1) {
      const p = ring * radial + j;
      const q = ring * radial + ((j + 1) % radial);
      if (front) idx.push(centre, p, q);
      else idx.push(centre, q, p);
    }
  };
  capAt(sections[0], 0, false);
  capAt(sections[ns - 1], ns - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tapered limb from point a (radius rA) to point b (radius rB), colour graded along it. */
function limb(a, b, rA, rB, cA = 1, cB = cA, radial = 8) {
  const A = new THREE.Vector3(...a);
  const B = new THREE.Vector3(...b);
  const dir = B.clone().sub(A);
  const h = dir.length();
  const g = new THREE.CylinderGeometry(rB, rA, h, seg(radial, 4), LOD < 1 ? 1 : 2, false);
  g.translate(0, h / 2, 0);
  paint(g, (x, y) => mix(cA, cB, y / h));
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate(A.x, A.y, A.z);
  return g;
}

function ellipsoid(c, r, color = 1, segs = [10, 7], rot = null) {
  const g = new THREE.SphereGeometry(1, seg(segs[0], 4), seg(segs[1], 3));
  g.scale(r[0], r[1], r[2]);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
  g.translate(c[0], c[1], c[2]);
  return paint(g, color);
}

function cone(c, radius, height, color, rot = [0, 0, 0], radial = 6) {
  const g = new THREE.ConeGeometry(radius, height, seg(radial, 4));
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
  g.translate(c[0], c[1], c[2]);
  return paint(g, color);
}

/** Curved, tapering tube through `points` (horns, curled tails). */
function taperTube(points, r0, r1, c0 = 1, c1 = c0, segsFull = 12, radialFull = 6) {
  const segs = seg(segsFull, 4);
  const radial = seg(radialFull, 4);
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const frames = curve.computeFrenetFrames(segs, false);
  const pos = [];
  const col = [];
  const idx = [];
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    const P = curve.getPointAt(t);
    const r = THREE.MathUtils.lerp(r0, r1, t);
    const N = frames.normals[i];
    const B = frames.binormals[i];
    const c = mix(c0, c1, t);
    for (let j = 0; j < radial; j += 1) {
      const th = (j / radial) * TAU;
      pos.push(
        P.x + r * (Math.cos(th) * N.x + Math.sin(th) * B.x),
        P.y + r * (Math.cos(th) * N.y + Math.sin(th) * B.y),
        P.z + r * (Math.cos(th) * N.z + Math.sin(th) * B.z),
      );
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < segs; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * radial + j;
      const b = (i + 1) * radial + j;
      const c = i * radial + ((j + 1) % radial);
      const d = (i + 1) * radial + ((j + 1) % radial);
      idx.push(a, c, b, c, d, b);
    }
  }
  const tip = pos.length / 3; // close the thin end
  const P = curve.getPointAt(1);
  const cEnd = toColor(c1);
  pos.push(P.x, P.y, P.z);
  col.push(cEnd.r, cEnd.g, cEnd.b);
  for (let j = 0; j < radial; j += 1) idx.push(tip, segs * radial + j, segs * radial + ((j + 1) % radial));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A muscular upper leg hanging from the hip (origin) down to the knee at -len:
 * deep front-to-back at the top where it blends into the body, tapering down.
 * scale: overall thickness; depth: extra front-to-back size at the top.
 */
function thigh(len, scale, depth = 1.25, c = 1, cKnee = 0.95) {
  const s = scale;
  const g = loft([
    // (the muscle bulks out behind the leg — buttock / elbow — not in front of the chest)
    { z: -0.28 * len, w: 0.4 * s, ht: 0.35 * s, hb: 0.4 * s, c },
    { z: -0.1 * len, w: 0.9 * s, ht: 0.7 * s, hb: 1.1 * s * depth, c },
    { z: 0.12 * len, w: 0.95 * s, ht: 0.72 * s, hb: 1.05 * s * depth, c },
    { z: 0.45 * len, w: 0.72 * s, ht: 0.68 * s, hb: 0.75 * s, c },
    { z: 0.8 * len, w: 0.55 * s, ht: 0.5 * s, hb: 0.52 * s, c: cKnee },
    { z: 1.0 * len, w: 0.5 * s, ht: 0.47 * s, hb: 0.47 * s, c: cKnee },
    { z: 1.08 * len, w: 0.32 * s, ht: 0.3 * s, hb: 0.3 * s, c: cKnee },
  ], 10);
  g.rotateX(Math.PI / 2); // build axis (+z) points down the leg; "top" (+y) faces forward
  return g;
}

/** Move geometry built in a head's own frame (z = snout direction) onto the body. */
function inFrame(geos, origin, tiltX) {
  const m = new THREE.Matrix4().makeRotationX(tiltX).setPosition(origin[0], origin[1], origin[2]);
  return geos.map((g) => g.applyMatrix4(m));
}

const coatMat = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
const plainMat = (roughness = 0.7) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 });

/**
 * part.attach: 'body' | 'head' | 'tail' | 'upper' (thigh) | 'lower' (shin + hoof)
 * part.tinted: multiply by the animal's coat colour
 */
function part(name, attach, geos, tinted = true, material = null) {
  return {
    name,
    attach,
    tinted,
    geometry: mergeGeometries(geos.map(finalize)),
    material: material || (tinted ? coatMat() : plainMat()),
  };
}

/* ------------------------------------------------------------------ */
/* Species (all face +z, hooves on y = 0)                              */
/* ------------------------------------------------------------------ */

/** Ankole long-horned cattle, the breed of western Uganda. */
function cattleSpecies() {
  const muzzle = 0.32;
  const head = inFrame([
    loft([
      { z: -0.03, w: 0.05, ht: 0.05, hb: 0.05 },
      { z: 0.03, w: 0.12, ht: 0.11, hb: 0.12 },
      { z: 0.16, w: 0.125, ht: 0.1, hb: 0.12 },
      { z: 0.3, w: 0.095, ht: 0.08, hb: 0.1, c: 0.9 },
      { z: 0.42, w: 0.085, ht: 0.07, hb: 0.085, c: muzzle },
      { z: 0.5, w: 0.09, ht: 0.065, hb: 0.07, c: muzzle },
      { z: 0.535, w: 0.045, ht: 0.03, hb: 0.03, c: muzzle },
    ], 12),
    ellipsoid([0.15, 0.05, 0.05], [0.1, 0.028, 0.05], 0.85, [8, 5], [0, 0, -0.25]), // ears
    ellipsoid([-0.15, 0.05, 0.05], [0.1, 0.028, 0.05], 0.85, [8, 5], [0, 0, 0.25]),
    ellipsoid([0.105, 0.035, 0.15], [0.022, 0.022, 0.022], 0.08, [6, 4]), // eyes
    ellipsoid([-0.105, 0.035, 0.15], [0.022, 0.022, 0.022], 0.08, [6, 4]),
  ], [0, 1.22, 0.96], 0.55);
  // The huge lyre-shaped horns
  const hornPts = [[0.07, 1.27, 0.97], [0.22, 1.36, 0.95], [0.4, 1.56, 0.92], [0.5, 1.84, 0.9], [0.46, 2.08, 0.93], [0.36, 2.22, 0.98]];
  const horn = (s) => taperTube(hornPts.map(([x, y, z]) => [x * s, y, z]), 0.068, 0.012, 0xe9dec4, 0x7a6a52, 14, 6);
  return {
    name: 'cattle',
    parts: [
      part('cattle-body', 'body', [
        loft([
          { z: -0.86, y: 1.0, w: 0.04, ht: 0.04, hb: 0.04 },
          { z: -0.8, y: 1.01, w: 0.17, ht: 0.15, hb: 0.17 },
          { z: -0.66, y: 1.03, w: 0.24, ht: 0.19, hb: 0.26 },
          { z: -0.42, y: 1.0, w: 0.27, ht: 0.19, hb: 0.32 },
          { z: -0.1, y: 0.97, w: 0.3, ht: 0.21, hb: 0.36 },
          { z: 0.22, y: 0.98, w: 0.29, ht: 0.22, hb: 0.35 },
          { z: 0.46, y: 1.0, w: 0.25, ht: 0.25, hb: 0.33 },
          { z: 0.64, y: 1.02, w: 0.19, ht: 0.22, hb: 0.28 },
          { z: 0.76, y: 1.04, w: 0.12, ht: 0.15, hb: 0.17 },
          { z: 0.8, y: 1.04, w: 0.04, ht: 0.04, hb: 0.05 },
        ], 16),
        ellipsoid([0, 1.24, 0.5], [0.1, 0.08, 0.16], 1, [8, 5]), // hump
        ellipsoid([0, 0.86, 0.68], [0.035, 0.12, 0.085], 1, [8, 6]), // dewlap
      ]),
      part('cattle-head', 'head', [limb([0, 1.04, 0.52], [0, 1.16, 0.98], 0.2, 0.125, 1, 1, 10), ...head]),
      part('cattle-horns', 'head', [horn(1), horn(-1)], false, plainMat(0.55)),
      part('cattle-tail', 'tail', [
        limb([0, 1.14, -0.84], [0, 0.6, -0.9], 0.032, 0.018, 1, 0.8, 6),
        ellipsoid([0, 0.5, -0.9], [0.045, 0.11, 0.045], 0.22, [6, 5]),
      ]),
      part('cattle-thigh', 'upper', [thigh(0.43, 0.13)]),
      part('cattle-shin', 'lower', [
        limb([0, 0, 0], [0, -0.34, 0], 0.056, 0.045, 0.92, 0.82, 8),
        ellipsoid([0, -0.34, 0.005], [0.05, 0.05, 0.055], 0.82, [7, 5]),
        limb([0, -0.35, 0.01], [0, -0.43, 0.02], 0.048, 0.062, 0.12, 0.1, 8), // hoof
      ]),
    ],
    neck: new THREE.Vector3(0, 1.06, 0.56),
    tailRoot: new THREE.Vector3(0, 1.14, -0.84),
    upperLen: 0.43,
    legs: [ // lateral-sequence walk: LH, LF, RH, RF a quarter cycle apart
      { hip: new THREE.Vector3(0.16, 0.86, 0.5), phase: 0.25, front: true },
      { hip: new THREE.Vector3(-0.16, 0.86, 0.5), phase: 0.75, front: true },
      { hip: new THREE.Vector3(0.16, 0.86, -0.56), phase: 0, front: false },
      { hip: new THREE.Vector3(-0.16, 0.86, -0.56), phase: 0.5, front: false },
    ],
    palette: [0x8b3a1e, 0x5a2b18, 0x1e1a18, 0xe8e0d0, 0xa8673a, 0x9c4424, 0x6e5a48],
    stride: 1.25, hipAmp: 0.3, kneeAmp: 0.75, bob: 0.025, roll: 0.03, walkNod: 0.06,
    speed: 0.5, turn: 1.4, idle: [6, 18], roam: 7,
    graze: 1.15, grazeChance: 0.75, walkHead: 0.12,
    tail: (a, t) => [0.08, 0, 0.22 * Math.sin(t * 1.1 + a.tone * 20) + 0.25 * Math.pow(Math.max(0, Math.sin(t * 0.37 + a.tone * 7)), 12)],
  };
}

function goatSpecies() {
  const head = inFrame([
    loft([
      { z: -0.015, w: 0.03, ht: 0.03, hb: 0.03 },
      { z: 0.03, w: 0.055, ht: 0.055, hb: 0.06 },
      { z: 0.12, w: 0.05, ht: 0.045, hb: 0.055 },
      { z: 0.2, w: 0.034, ht: 0.033, hb: 0.04, c: 0.6 },
      { z: 0.235, w: 0.018, ht: 0.018, hb: 0.02, c: 0.5 },
    ], 10),
    ellipsoid([0.075, -0.01, 0.05], [0.075, 0.018, 0.032], 0.9, [8, 5], [0, 0, -0.55]), // drooping ears
    ellipsoid([-0.075, -0.01, 0.05], [0.075, 0.018, 0.032], 0.9, [8, 5], [0, 0, 0.55]),
    ellipsoid([0.045, 0.022, 0.075], [0.012, 0.012, 0.012], 0.08, [6, 4]),
    ellipsoid([-0.045, 0.022, 0.075], [0.012, 0.012, 0.012], 0.08, [6, 4]),
    ellipsoid([0, -0.07, 0.14], [0.016, 0.05, 0.02], 0.55, [6, 5]), // beard
  ], [0, 0.86, 0.43], 0.75);
  const hornPts = [[0.028, 0.9, 0.44], [0.05, 0.985, 0.405], [0.068, 1.02, 0.335], [0.078, 1.0, 0.275]];
  const horn = (s) => taperTube(hornPts.map(([x, y, z]) => [x * s, y, z]), 0.022, 0.005, 0x6a5e50, 0x3a3430, 8, 5);
  return {
    name: 'goat',
    parts: [
      part('goat-body', 'body', [loft([
        { z: -0.42, y: 0.63, w: 0.03, ht: 0.03, hb: 0.03 },
        { z: -0.37, y: 0.63, w: 0.1, ht: 0.08, hb: 0.1 },
        { z: -0.25, y: 0.62, w: 0.13, ht: 0.1, hb: 0.15 },
        { z: 0, y: 0.6, w: 0.15, ht: 0.11, hb: 0.18 },
        { z: 0.2, y: 0.61, w: 0.14, ht: 0.11, hb: 0.17 },
        { z: 0.32, y: 0.64, w: 0.1, ht: 0.1, hb: 0.13 },
        { z: 0.38, y: 0.65, w: 0.03, ht: 0.03, hb: 0.03 },
      ], 12)]),
      part('goat-head', 'head', [limb([0, 0.62, 0.28], [0, 0.82, 0.44], 0.072, 0.045, 1, 1, 8), ...head]),
      part('goat-horns', 'head', [horn(1), horn(-1)], false),
      part('goat-tail', 'tail', [limb([0, 0.69, -0.38], [0, 0.78, -0.45], 0.026, 0.01, 1, 0.85, 6)]),
      part('goat-thigh', 'upper', [thigh(0.23, 0.06)]),
      part('goat-shin', 'lower', [
        limb([0, 0, 0], [0, -0.2, 0], 0.026, 0.022, 0.92, 0.85, 7),
        limb([0, -0.2, 0], [0, -0.23, 0.01], 0.024, 0.03, 0.15, 0.12, 7),
      ]),
    ],
    neck: new THREE.Vector3(0, 0.63, 0.28),
    tailRoot: new THREE.Vector3(0, 0.69, -0.38),
    upperLen: 0.23,
    legs: [
      { hip: new THREE.Vector3(0.08, 0.46, 0.25), phase: 0.25, front: true },
      { hip: new THREE.Vector3(-0.08, 0.46, 0.25), phase: 0.75, front: true },
      { hip: new THREE.Vector3(0.08, 0.46, -0.27), phase: 0, front: false },
      { hip: new THREE.Vector3(-0.08, 0.46, -0.27), phase: 0.5, front: false },
    ],
    palette: [0xece6da, 0x2a2624, 0x7a4a2a, 0xb08a5a, 0x8a8278, 0x5e3a22],
    stride: 0.75, hipAmp: 0.38, kneeAmp: 0.85, bob: 0.018, roll: 0.03, walkNod: 0.07,
    speed: 0.6, turn: 2.4, idle: [3, 10], roam: 3.5,
    graze: 1.35, grazeChance: 0.7, walkHead: 0.05,
    tail: (a, t) => [0, 0, 0.35 * Math.sin(t * 9 + a.tone * 30) * Math.pow(Math.max(0, Math.sin(t * 0.6 + a.tone * 11)), 6)],
  };
}

/** Lean, short-coated village dog. */
function dogSpecies() {
  const head = inFrame([
    loft([
      { z: -0.02, w: 0.03, ht: 0.03, hb: 0.03 },
      { z: 0.03, w: 0.06, ht: 0.055, hb: 0.05 },
      { z: 0.08, w: 0.062, ht: 0.055, hb: 0.05 },
      { z: 0.13, w: 0.04, ht: 0.034, hb: 0.035 },
      { z: 0.2, w: 0.025, ht: 0.024, hb: 0.024, c: 0.55 },
      { z: 0.222, w: 0.016, ht: 0.015, hb: 0.015, c: 0.08 }, // nose
    ], 10),
    cone([0.035, 0.075, 0.03], 0.028, 0.085, 0.9, [0, 0, -0.25], 5), // upright ears
    cone([-0.035, 0.075, 0.03], 0.028, 0.085, 0.9, [0, 0, 0.25], 5),
    ellipsoid([0.04, 0.025, 0.09], [0.011, 0.011, 0.011], 0.06, [6, 4]),
    ellipsoid([-0.04, 0.025, 0.09], [0.011, 0.011, 0.011], 0.06, [6, 4]),
  ], [0, 0.66, 0.31], 0.25);
  return {
    name: 'dog',
    parts: [
      part('dog-body', 'body', [loft([
        { z: -0.31, y: 0.45, w: 0.03, ht: 0.03, hb: 0.03 },
        { z: -0.27, y: 0.46, w: 0.07, ht: 0.06, hb: 0.06 },
        { z: -0.15, y: 0.46, w: 0.085, ht: 0.07, hb: 0.07 },
        { z: 0, y: 0.46, w: 0.09, ht: 0.075, hb: 0.09 },
        { z: 0.14, y: 0.46, w: 0.1, ht: 0.08, hb: 0.13 },
        { z: 0.24, y: 0.48, w: 0.085, ht: 0.075, hb: 0.11 },
        { z: 0.3, y: 0.5, w: 0.03, ht: 0.03, hb: 0.03 },
      ], 12)]),
      part('dog-head', 'head', [limb([0, 0.48, 0.22], [0, 0.65, 0.33], 0.058, 0.042, 1, 1, 8), ...head]),
      part('dog-tail', 'tail', [taperTube([[0, 0.5, -0.29], [0, 0.6, -0.36], [0, 0.67, -0.32], [0.015, 0.66, -0.25]], 0.026, 0.012, 1, 0.9, 8, 6)]),
      part('dog-thigh', 'upper', [thigh(0.2, 0.052, 1.15)]),
      part('dog-shin', 'lower', [
        limb([0, 0, 0], [0, -0.18, 0], 0.023, 0.02, 0.92, 0.88, 7),
        ellipsoid([0, -0.19, 0.015], [0.025, 0.016, 0.036], 0.82, [7, 4]), // paw
      ]),
    ],
    neck: new THREE.Vector3(0, 0.48, 0.22),
    tailRoot: new THREE.Vector3(0, 0.5, -0.29),
    upperLen: 0.2,
    legs: [ // trot: diagonal pairs together
      { hip: new THREE.Vector3(0.06, 0.4, 0.2), phase: 0, front: true },
      { hip: new THREE.Vector3(-0.06, 0.4, 0.2), phase: 0.5, front: true },
      { hip: new THREE.Vector3(0.06, 0.4, -0.22), phase: 0.5, front: false },
      { hip: new THREE.Vector3(-0.06, 0.4, -0.22), phase: 0, front: false },
    ],
    palette: [0xc0904e, 0x7a4e2c, 0x2a2522, 0xe0d2b8, 0xb06a32, 0x9a7a58],
    stride: 0.85, hipAmp: 0.5, kneeAmp: 0.95, bob: 0.02, roll: 0.02, walkNod: 0.05,
    speed: 1.25, turn: 3.5, idle: [3, 11], roam: 9,
    graze: 0.6, grazeChance: 0.45, walkHead: -0.05,
    tail: (a, t) => [0, 0, 0.4 * Math.sin(t * (a.walking ? 9 : 6) + a.tone * 30)],
  };
}

function chickenSpecies() {
  const red = 0xc22a22;
  const drop = -0.055; // sits low on short legs
  const lowered = (p) => { p.geometry.translate(0, drop, 0); return p; };
  return {
    name: 'chicken',
    parts: [
      part('chicken-body', 'body', [
        loft([
          { z: -0.13, y: 0.33, w: 0.03, ht: 0.03, hb: 0.03 },
          { z: -0.1, y: 0.32, w: 0.07, ht: 0.07, hb: 0.08 },
          { z: -0.02, y: 0.3, w: 0.1, ht: 0.09, hb: 0.11 },
          { z: 0.06, y: 0.31, w: 0.095, ht: 0.09, hb: 0.1 },
          { z: 0.12, y: 0.34, w: 0.06, ht: 0.06, hb: 0.07 },
          { z: 0.15, y: 0.36, w: 0.02, ht: 0.02, hb: 0.02 },
        ], 12),
        ellipsoid([0, 0.43, -0.13], [0.024, 0.085, 0.05], 0.85, [7, 5], [-0.45, 0, 0]), // tail feathers
        ellipsoid([0.035, 0.41, -0.12], [0.02, 0.07, 0.045], 0.8, [7, 5], [-0.4, 0, 0.3]),
        ellipsoid([-0.035, 0.41, -0.12], [0.02, 0.07, 0.045], 0.8, [7, 5], [-0.4, 0, -0.3]),
        ellipsoid([0.095, 0.32, -0.01], [0.025, 0.065, 0.1], 0.88, [7, 5], [0.15, 0, 0]), // wings
        ellipsoid([-0.095, 0.32, -0.01], [0.025, 0.065, 0.1], 0.88, [7, 5], [0.15, 0, 0]),
        ellipsoid([0.045, 0.24, 0], [0.035, 0.05, 0.045], 0.9, [6, 4]), // drumsticks
        ellipsoid([-0.045, 0.24, 0], [0.035, 0.05, 0.045], 0.9, [6, 4]),
      ]),
      part('chicken-head', 'head', [
        limb([0, 0.34, 0.09], [0, 0.46, 0.13], 0.045, 0.032, 1, 1, 8),
        ellipsoid([0, 0.48, 0.14], [0.042, 0.042, 0.045], 1, [8, 6]),
      ]),
      part('chicken-face', 'head', [
        cone([0, 0.473, 0.19], 0.014, 0.045, 0xe0a020, [Math.PI / 2, 0, 0], 5), // beak
        ellipsoid([0, 0.53, 0.12], [0.009, 0.017, 0.017], red, [6, 4]), // comb
        ellipsoid([0, 0.535, 0.14], [0.009, 0.019, 0.017], red, [6, 4]),
        ellipsoid([0, 0.525, 0.16], [0.009, 0.015, 0.015], red, [6, 4]),
        ellipsoid([0, 0.44, 0.17], [0.01, 0.022, 0.012], red, [6, 4]), // wattle
        ellipsoid([0.035, 0.49, 0.16], [0.008, 0.008, 0.008], 0x111111, [5, 3]),
        ellipsoid([-0.035, 0.49, 0.16], [0.008, 0.008, 0.008], 0x111111, [5, 3]),
      ], false),
      part('chicken-leg', 'upper', [
        limb([0, 0.02, 0], [0, -0.15, 0], 0.012, 0.011, 0xd8b040, 0xd8b040, 5),
        limb([0, -0.15, 0], [0, -0.16, 0.06], 0.006, 0.005, 0xd8b040, 0xd8b040, 4), // toes
        limb([0, -0.15, 0], [0.03, -0.16, 0.045], 0.006, 0.005, 0xd8b040, 0xd8b040, 4),
        limb([0, -0.15, 0], [-0.03, -0.16, 0.045], 0.006, 0.005, 0xd8b040, 0xd8b040, 4),
        limb([0, -0.15, 0], [0, -0.16, -0.025], 0.006, 0.005, 0xd8b040, 0xd8b040, 4),
      ], false),
    ].map((p) => (p.attach === 'upper' ? p : lowered(p))),
    neck: new THREE.Vector3(0, 0.36 + drop, 0.1),
    tailRoot: null,
    upperLen: 0.15,
    legs: [
      { hip: new THREE.Vector3(0.045, 0.165, 0), phase: 0, front: true },
      { hip: new THREE.Vector3(-0.045, 0.165, 0), phase: 0.5, front: true },
    ],
    palette: [0x8a5030, 0xf0ece4, 0x2a2624, 0xa04020, 0xd0a060, 0x9a948a],
    stride: 0.22, hipAmp: 0.55, kneeAmp: 0, lift: 0.03, bob: 0.012, roll: 0.05, walkNod: 0,
    headBob: 0.025, peck: 0.9,
    speed: 0.4, turn: 6, idle: [1, 4], roam: 2.5,
    graze: 0.15, grazeChance: 0.5, walkHead: 0,
  };
}

const withDetail = (build) => (lod = 1) => {
  LOD = lod;
  try { return build(); } finally { LOD = 1; }
};
/** Species factories: SPECIES.cattle(1) full detail, SPECIES.cattle(0.5) for distant herds. */
export const SPECIES = {
  cattle: withDetail(cattleSpecies),
  goat: withDetail(goatSpecies),
  dog: withDetail(dogSpecies),
  chicken: withDetail(chickenSpecies),
};

/* ------------------------------------------------------------------ */
/* Behaviour and animation                                             */
/* ------------------------------------------------------------------ */

const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
function segDist(x, z, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 1e-6 ? THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
  return Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
}

const _B = new THREE.Matrix4();
const _L = new THREE.Matrix4();
const _U = new THREE.Matrix4();
const _K = new THREE.Matrix4();
const _W = new THREE.Matrix4();
const _H = new THREE.Matrix4();
const _T = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _e2 = new THREE.Euler(0, 0, 0, 'YXZ');

/** Rotation by `euler` about point `p` (all in the body's own frame). */
function aroundPivot(out, euler, p) {
  out.makeRotationFromEuler(euler);
  _v.copy(p).applyMatrix4(out);
  return out.setPosition(p.x - _v.x, p.y - _v.y, p.z - _v.z);
}

/**
 * All the animals of one species that share a drawing setup.
 * Each wanders a little at a time inside its home circle (pasture, yard),
 * avoiding buildings, then stops to graze, sniff, peck or look around.
 */
export class AnimalGroup {
  constructor(scene, species, animals, rand, { castShadow = false } = {}) {
    this.sp = species;
    this.animals = animals;
    this.rand = rand;
    this.blockers = null;
    const nLegs = species.legs.length;
    const coat = new THREE.Color();
    const white = new THREE.Color(1, 1, 1);

    // One culling sphere around every home this group uses
    const homes = [...new Set(animals.map((a) => a.home))];
    const centre = new THREE.Vector3();
    homes.forEach((h) => centre.add(_v.set(h.x, 0, h.z)));
    centre.divideScalar(homes.length);
    let radius = 0;
    homes.forEach((h) => { radius = Math.max(radius, Math.hypot(h.x - centre.x, h.z - centre.z) + h.r); });
    const sphere = new THREE.Sphere(centre.setY(1), radius + 3);

    this.meshes = species.parts.map((p) => {
      const perAnimal = p.attach === 'upper' || p.attach === 'lower' ? nLegs : 1;
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, animals.length * perAnimal);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      animals.forEach((a, i) => {
        coat.setHex(species.palette[Math.floor(a.tone * species.palette.length) % species.palette.length]);
        for (let k = 0; k < perAnimal; k += 1) mesh.setColorAt(i * perAnimal + k, p.tinted ? coat : white);
      });
      mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      mesh.boundingSphere = sphere.clone(); // animals never leave their homes
      mesh.name = `ANIMAL_${p.name}`;
      scene.add(mesh);
      return { mesh, attach: p.attach, perAnimal };
    });

    animals.forEach((a) => {
      a.yaw = rand() * TAU;
      a.walking = false;
      a.timer = rand() * species.idle[1];
      a.t = rand() * 100;
      a.gait = rand() * TAU;
      a.amt = 0;
      a.mode = rand() < species.grazeChance ? 'graze' : 'look';
      a.nod = a.mode === 'graze' ? species.graze : 0;
      a.look = 0;
      a.lookTo = 0;
    });
    this.update(0);
  }

  setBlockers(list) { this.blockers = list; }

  _pickTarget(a) {
    const sp = this.sp;
    for (let tries = 0; tries < 6; tries += 1) {
      const ang = this.rand() * TAU;
      const r = sp.roam * (0.35 + 0.65 * this.rand());
      let tx = a.x + Math.cos(ang) * r;
      let tz = a.z + Math.sin(ang) * r;
      const dx = tx - a.home.x;
      const dz = tz - a.home.z;
      const d = Math.hypot(dx, dz);
      if (d > a.home.r) { // stay home
        tx = a.home.x + (dx / d) * a.home.r * 0.9;
        tz = a.home.z + (dz / d) * a.home.r * 0.9;
      }
      if (this.blockers && this.blockers.some((b) => segDist(b.x, b.z, a, { x: tx, z: tz }) < b.r)) continue;
      a.tx = tx;
      a.tz = tz;
      a.walking = true;
      return;
    }
    a.timer = 1 + this.rand() * 2; // boxed in for now; try again shortly
  }

  update(dt) {
    const sp = this.sp;
    const nLegs = sp.legs.length;
    this.animals.forEach((a, i) => {
      a.t += dt;
      let moved = 0;
      let turned = 0;
      if (dt > 0) {
        if (a.walking) {
          const dx = a.tx - a.x;
          const dz = a.tz - a.z;
          const d = Math.hypot(dx, dz);
          if (d < 0.1) {
            a.walking = false;
            a.timer = sp.idle[0] + this.rand() * (sp.idle[1] - sp.idle[0]);
            a.mode = this.rand() < sp.grazeChance ? 'graze' : 'look';
            a.lookTo = (this.rand() - 0.5) * 1.1;
          } else {
            const want = Math.atan2(dx, dz);
            const turn = angleDiff(want, a.yaw) * Math.min(1, dt * sp.turn);
            a.yaw += turn;
            turned = Math.abs(turn);
            if (Math.abs(angleDiff(want, a.yaw)) < 0.6) {
              moved = Math.min(d, sp.speed * a.pace * a.scale * dt);
              a.x += Math.sin(a.yaw) * moved;
              a.z += Math.cos(a.yaw) * moved;
            }
          }
        } else {
          a.timer -= dt;
          if (a.timer <= 0) this._pickTarget(a);
        }
      }

      // Legs advance with distance walked, so hooves don't slide
      a.gait += (moved / (sp.stride * a.scale)) * TAU + turned * 1.2;
      const want = moved > 1e-5 ? 1 : turned > 1e-4 ? 0.6 : 0;
      a.amt += (want - a.amt) * Math.min(1, dt * 6);

      // Head: graze / sniff / look around while still, carried while walking
      let nodTo = sp.walkHead;
      if (!a.walking) nodTo = a.mode === 'graze' ? sp.graze * (0.88 + 0.12 * Math.sin(a.t * 0.8 + a.tone * 9)) : -0.08;
      a.nod += (nodTo - a.nod) * Math.min(1, dt * 1.6);
      a.look += ((!a.walking && a.mode === 'look' ? a.lookTo : 0) - a.look) * Math.min(1, dt * 1.2);
      let peck = 0;
      if (sp.peck && !a.walking) peck = Math.pow(Math.max(0, Math.sin(a.t * 2.7 + a.tone * 17)), 8) * sp.peck;

      // Body: rises twice per stride, rolls with the gait, tips forward to peck
      const amt = a.amt;
      const bob = sp.bob * amt * (0.5 - 0.5 * Math.cos(2 * a.gait));
      _e.set(peck * 0.4, a.yaw, sp.roll * amt * Math.sin(a.gait));
      _B.compose(_p.set(a.x, -0.02 + bob * a.scale, a.z), _q.setFromEuler(_e), _s.setScalar(a.scale));

      // Head and tail
      _e2.set(a.nod + peck + sp.walkNod * amt * Math.sin(2 * a.gait), a.look, 0);
      aroundPivot(_L, _e2, sp.neck);
      if (sp.headBob) _L.elements[14] += sp.headBob * amt * Math.sin(2 * a.gait); // chicken head-bob
      const headM = _H.multiplyMatrices(_B, _L);
      let tailM = null;
      if (sp.tailRoot && sp.tail) {
        const [rx, ry, rz] = sp.tail(a, a.t);
        _e2.set(rx, ry, rz);
        tailM = _T.multiplyMatrices(_B, aroundPivot(_L, _e2, sp.tailRoot));
      }

      this.meshes.forEach(({ mesh, attach }) => {
        if (attach === 'body') mesh.setMatrixAt(i, _B);
        else if (attach === 'head') mesh.setMatrixAt(i, headM);
        else if (attach === 'tail' && tailM) mesh.setMatrixAt(i, tailM);
      });

      // Legs: swing at the hip, fold at the knee while the foot is in the air
      sp.legs.forEach((leg, l) => {
        const ph = a.gait + leg.phase * TAU;
        const s = Math.sin(ph);
        const c = Math.cos(ph);
        const swing = c > 0 ? c * c : 0; // foot lifted while the leg moves forward
        const hipA = -sp.hipAmp * amt * s;
        const kneeA = sp.kneeAmp * amt * swing * (leg.front ? 1 : -0.6);
        _U.makeRotationX(hipA).setPosition(leg.hip.x, leg.hip.y + (sp.lift || 0) * amt * swing, leg.hip.z);
        _W.multiplyMatrices(_B, _U);
        _K.makeRotationX(kneeA).setPosition(0, -sp.upperLen, 0);
        _K.premultiply(_W); // shin = thigh * knee
        this.meshes.forEach(({ mesh, attach }) => {
          if (attach === 'upper') mesh.setMatrixAt(i * nLegs + l, _W);
          else if (attach === 'lower') mesh.setMatrixAt(i * nLegs + l, _K);
        });
      });
    });
    this.meshes.forEach(({ mesh }) => { mesh.instanceMatrix.needsUpdate = true; });
  }
}
