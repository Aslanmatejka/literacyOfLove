/**
 * Literacy of Love — the countryside around the 3D village.
 *
 * Red murram main roads to the horizon, feeder roads, footpath shortcuts,
 * family homesteads, farms and banana groves, eucalyptus and forests,
 * papyrus swamps, and animals going about their day (cattle, goats, dogs,
 * chickens).
 *
 * Performance: everything repeated is GPU-instanced (one draw call per part,
 * however many copies), and each kind of road, path, field or swamp is one
 * merged mesh. The layout is seeded, so it is the same on every visit.
 */
import * as THREE from './vendor/three-r170/three.module.min.js';
import { mergeGeometries } from './vendor/three-r170/addons/utils/BufferGeometryUtils.js';
import { AnimalGroup, SPECIES } from './sim-animals.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const V = (x, z) => new THREE.Vector3(x, 0, z);
const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

const HUT_WALL_TINTS = [[1, 1, 1], [1.08, 1.02, 0.95], [0.9, 0.86, 0.8], [1.05, 0.95, 0.86], [0.96, 0.92, 0.9]];
const HUT_THATCH_TINTS = [[1, 1, 1], [0.92, 0.9, 0.84], [1.08, 1.05, 0.94], [0.85, 0.82, 0.74]];
const LEAF_TINTS = [[1, 1, 1], [0.88, 1, 0.9], [1.1, 1.06, 0.92], [0.95, 0.95, 0.85]];
const HOUSE_WALLS = [0xc49a6c, 0xd9cdb6, 0xb8774f, 0xe2d8c4, 0xa9805c, 0xcfae84];
const HOUSE_ROOFS = [0xa4abaf, 0x8f9599, 0xa26a43, 0x7d8a94, 0xb3b7b4];
const LEAF_COLORS = [0x4f7f35, 0x5d8a3a, 0x6b8f3f, 0x45702f, 0x587d34];
const FOREST_COLORS = [0x3f6b2c, 0x4a7a33, 0x355e27, 0x56843a, 0x2f5a25];
const EUCALYPTUS_COLORS = [0x7c9468, 0x6d8a5c, 0x87a074, 0x748f63];
const pickOf = (list, t) => list[Math.floor((t % 1) * list.length)];

/** Distance from (x, z) to segment a–b in the ground plane. */
function segDist(x, z, a, b) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 1e-6 ? THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
  return Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
}

/** Roads and paths as polylines, with bounding boxes for quick nearest-point queries. */
class LineIndex {
  constructor() { this.lines = []; }

  add(pts) {
    const L = { pts, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    pts.forEach((p) => {
      L.minX = Math.min(L.minX, p.x); L.maxX = Math.max(L.maxX, p.x);
      L.minZ = Math.min(L.minZ, p.z); L.maxZ = Math.max(L.maxZ, p.z);
    });
    this.lines.push(L);
    return L;
  }

  /** Closest point on any line within maxD, or null. */
  nearest(x, z, maxD = Infinity, set = this.lines) {
    let best = maxD;
    let hit = null;
    for (const L of set) {
      if (Math.hypot(Math.max(L.minX - x, 0, x - L.maxX), Math.max(L.minZ - z, 0, z - L.maxZ)) >= best) continue;
      const p = L.pts;
      for (let i = 0; i < p.length - 1; i += 1) {
        const a = p[i];
        const b = p[i + 1];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        const t = len2 > 1e-6 ? THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
        const px = a.x + abx * t;
        const pz = a.z + abz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) { best = d; hit = { d, x: px, z: pz }; }
      }
    }
    return hit;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry building blocks                                            */
/* ------------------------------------------------------------------ */

/** Non-indexed copy with a flat vertex colour (no uv), so different shapes merge cleanly. */
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Plain (no colour/uv) non-indexed copy, for parts tinted per instance. */
function plain(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

/** A two-triangle leaf blade (diamond) lying along +z, slightly cupped. */
function leafBlade(width, length, lift) {
  const g = new THREE.BufferGeometry();
  const B = [0, 0, 0];
  const L = [-width / 2, lift, length * 0.47];
  const R = [width / 2, lift, length * 0.47];
  const T = [0, 0, length];
  g.setAttribute('position', new THREE.Float32BufferAttribute([...B, ...T, ...R, ...B, ...L, ...T], 3));
  g.computeVertexNormals();
  return g;
}

/** Flat strip along a polyline (roads, paths): v runs across it, u along it in tiles. */
function ribbon(points, half, y, tileLen) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  let dist = 0;
  points.forEach((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const inDir = p.clone().sub(prev).setY(0);
    const outDir = next.clone().sub(p).setY(0);
    if (inDir.lengthSq() < 1e-8) inDir.copy(outDir);
    if (outDir.lengthSq() < 1e-8) outDir.copy(inDir);
    inDir.normalize();
    outDir.normalize();
    const tangent = inDir.clone().add(outDir);
    if (tangent.lengthSq() < 1e-8) tangent.copy(outDir);
    tangent.normalize();
    const px = -tangent.z;
    const pz = tangent.x;
    const miter = THREE.MathUtils.clamp(1 / Math.max(0.4, Math.abs(px * -inDir.z + pz * inDir.x)), 1, 1.8);
    const span = half * miter;
    positions.push(p.x + px * span, y, p.z + pz * span, p.x - px * span, y, p.z - pz * span);
    normals.push(0, 1, 0, 0, 1, 0);
    if (i > 0) dist += p.distanceTo(prev);
    uvs.push(dist / tileLen, 0, dist / tileLen, 1);
  });
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/** Irregular flat blob (swamp ground, pools). uv tiles in metres/6; uv1 is radial for a soft edge. */
function blob(cx, cz, r, y, rand, wobble = 0.22, n = 40) {
  const p1 = rand() * TAU;
  const p2 = rand() * TAU;
  const pos = [cx, y, cz];
  const uv = [cx / 6, cz / 6];
  const uv1 = [0.5, 0.5];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * TAU;
    const k = 1 + wobble * (0.6 * Math.sin(a * 2 + p1) + 0.4 * Math.sin(a * 5 + p2));
    const x = cx + Math.cos(a) * r * k;
    const z = cz + Math.sin(a) * r * k;
    pos.push(x, y, z);
    uv.push(x / 6, z / 6);
    uv1.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  const index = [];
  for (let i = 0; i < n; i += 1) index.push(0, 1 + ((i + 1) % n), 1 + i);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array((n + 1) * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(uv1, 2));
  g.setIndex(index);
  return g;
}

/* ------------------------------------------------------------------ */
/* Textures and materials                                              */
/* ------------------------------------------------------------------ */

function canvasTexture(width, height, draw, { repeat = true, srgb = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function speckle(g, w, h, rgb, density = 0.07) {
  for (let i = 0; i < w * h * density; i += 1) {
    const dark = Math.random() < 0.5;
    const k = dark ? 0.7 : 1;
    g.fillStyle = `rgba(${rgb[0] * k}, ${rgb[1] * k}, ${rgb[2] * k}, ${dark ? 0.35 : 0.3})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2.5, 1 + Math.random() * 1.5);
  }
}

/** Earth texture for roads; `bands` adds strips across v (tyre ruts, crown, verges). */
function earthTexture(width, height, base, rgb, bands = []) {
  const tex = canvasTexture(width, height, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, rgb);
    bands.forEach(([from, to, fill]) => { g.fillStyle = fill; g.fillRect(0, from * h, w, (to - from) * h); });
  });
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Soft alpha across a strip's width (solid between `inner` and 1-inner). */
function edgeAlpha(inner) {
  const tex = canvasTexture(4, 64, (g) => {
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#000');
    grad.addColorStop(inner, '#fff');
    grad.addColorStop(1 - inner, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 64);
  }, { srgb: false });
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Radial soft edge (solid to `inner`, fading to the rim). */
function radialAlpha(inner = 0.6) {
  return canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(inner, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }, { repeat: false, srgb: false });
}

/** Rectangle with softened edges, for fields. */
function rectAlpha() {
  return canvasTexture(64, 64, (g) => {
    const img = g.createImageData(64, 64);
    const edge = (t) => THREE.MathUtils.smoothstep(t, 0, 0.1) * THREE.MathUtils.smoothstep(1 - t, 0, 0.1);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const v = Math.round(255 * edge((x + 0.5) / 64) * edge((y + 0.5) / 64));
        const i = (y * 64 + x) * 4;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { repeat: false, srgb: false });
}

/* ------------------------------------------------------------------ */
/* Models (each part: { name, geometry, material })                    */
/* ------------------------------------------------------------------ */

const tintedMat = (opts = {}) => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: true, ...opts });
const vertexMat = (opts = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true, ...opts });

/** Rectangular mud-brick house with an iron-sheet gable roof. */
function houseModel() {
  // Walls reach right up under the eaves (no see-through gap below the roof)
  const walls = new THREE.BoxGeometry(4.2, 2.4, 3.2).toNonIndexed();
  walls.translate(0, 1.2, 0);
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([
    2.1, 2.4, 1.6, 2.1, 2.4, -1.6, 2.1, 3.22, 0,
    -2.1, 2.4, -1.6, -2.1, 2.4, 1.6, -2.1, 3.22, 0,
  ], 3));
  gable.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  gable.computeVertexNormals();
  // Eaves overhang the long walls; only a short lip past the gable ends
  const A = [-2.2, 2.22, 1.95]; const B = [2.2, 2.22, 1.95]; const C = [2.2, 3.28, 0]; const D = [-2.2, 3.28, 0];
  const E = [2.2, 2.22, -1.95]; const F = [-2.2, 2.22, -1.95]; const G = [-2.2, 3.28, 0]; const H = [2.2, 3.28, 0];
  const roof = new THREE.BufferGeometry();
  roof.setAttribute('position', new THREE.Float32BufferAttribute([...A, ...B, ...C, ...A, ...C, ...D, ...E, ...F, ...G, ...E, ...G, ...H], 3));
  roof.computeVertexNormals();
  return [
    { name: 'house-wall', geometry: mergeGeometries([walls, gable]), material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }) },
    { name: 'house-roof', geometry: roof, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide }) },
    { name: 'house-trim', geometry: mergeGeometries([box(0.8, 1.65, 0.08, 0.7, 0.825, 1.62), box(0.75, 0.62, 0.08, -1.05, 1.4, 1.62)]), material: new THREE.MeshStandardMaterial({ color: 0x3b2a1d, roughness: 0.9 }) },
  ];
}

/** Light flat-topped (acacia-like) tree. */
function roundTreeModel() {
  const trunk = new THREE.CylinderGeometry(0.12, 0.2, 1.8, 6);
  trunk.translate(0, 0.9, 0);
  const canopy = new THREE.IcosahedronGeometry(1.5, 0);
  canopy.scale(1.4, 0.62, 1.4);
  canopy.translate(0, 2.3, 0);
  return [
    { name: 'tree-trunk', geometry: trunk, material: tintedMat({ color: 0x6b4a2e, roughness: 1 }) },
    { name: 'tree-canopy', geometry: canopy, material: tintedMat({ roughness: 0.95 }) },
  ];
}

/** Tall, slender eucalyptus. */
function eucalyptusModel() {
  const trunk = new THREE.CylinderGeometry(0.13, 0.26, 8.6, 6);
  trunk.translate(0, 4.3, 0);
  const upper = new THREE.IcosahedronGeometry(1.35, 0);
  upper.scale(0.95, 2.1, 0.95);
  upper.translate(0, 8.7, 0);
  const lower = new THREE.IcosahedronGeometry(1.15, 0);
  lower.scale(0.9, 1.6, 0.9);
  lower.translate(0.2, 6.5, -0.1);
  return [
    { name: 'eucalyptus-trunk', geometry: trunk, material: tintedMat({ color: 0xbcae96, roughness: 0.8 }) },
    { name: 'eucalyptus-canopy', geometry: mergeGeometries([upper, lower]), material: tintedMat({ roughness: 0.95 }) },
  ];
}

/** Banana (matoke) plant: pseudostem and a crown of broad leaves. */
function bananaModel() {
  const stem = new THREE.CylinderGeometry(0.1, 0.15, 1.7, 6);
  stem.translate(0, 0.85, 0);
  const parts = [colored(stem, 0x6f7f3c)];
  for (let i = 0; i < 6; i += 1) {
    const leaf = leafBlade(0.62, 1.7, 0.26);
    leaf.applyMatrix4(new THREE.Matrix4().makeRotationX(i % 2 ? -0.15 : -0.5));
    leaf.applyMatrix4(new THREE.Matrix4().makeRotationY((i / 6) * TAU + (i % 2) * 0.4));
    leaf.translate(0, 1.62, 0);
    parts.push(colored(leaf, i === 5 ? 0x8a8a3c : 0x4f8f36));
  }
  return [{ name: 'banana', geometry: mergeGeometries(parts), material: vertexMat({ side: THREE.DoubleSide }) }];
}

/** Maize plant: two crossed leaf blades (cheap, reads well in rows). */
function maizeModel() {
  const blade = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0.1, 0, 0.3, 0.95, 0, 0, 1.95, 0,
      0, 0.1, 0, 0, 1.95, 0, -0.3, 0.95, 0,
    ], 3));
    g.computeVertexNormals();
    return g;
  };
  const a = blade();
  const b = blade();
  b.rotateY(Math.PI / 2);
  return [{ name: 'maize', geometry: mergeGeometries([plain(a), plain(b)]), material: tintedMat({ color: 0xffffff, side: THREE.DoubleSide, roughness: 1 }) }];
}

/** Papyrus clump: a few tall stems topped with umbrella-like heads. */
function papyrusModel() {
  const parts = [];
  for (let i = 0; i < 5; i += 1) {
    const h = 2.0 + i * 0.22;
    const lean = new THREE.Euler((i % 2 ? 1 : -1) * 0.14, 0, (i < 2 ? 1 : -1) * 0.12);
    const stem = new THREE.CylinderGeometry(0.018, 0.03, h, 3);
    stem.translate(0, h / 2, 0);
    const head = new THREE.ConeGeometry(0.46, 0.34, 5);
    head.rotateX(Math.PI);
    head.translate(0, h + 0.05, 0);
    const m = new THREE.Matrix4().makeRotationFromEuler(lean)
      .premultiply(new THREE.Matrix4().makeTranslation(Math.cos(i * 1.7) * 0.18, 0, Math.sin(i * 1.7) * 0.18));
    stem.applyMatrix4(m);
    head.applyMatrix4(m);
    parts.push(colored(stem, 0x5f7f30), colored(head, 0x8fb04a));
  }
  return [{ name: 'papyrus', geometry: mergeGeometries(parts), material: vertexMat({ side: THREE.DoubleSide }) }];
}

/* ------------------------------------------------------------------ */
/* Instancing                                                          */
/* ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);

/** One InstancedMesh per part: many copies, one draw call each. */
function instanced(scene, parts, items, { cast = false, receive = false, order = 0 } = {}, tintFor = null) {
  if (!parts || !items.length) return [];
  return parts.map((part) => {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, items.length);
    const tint = tintFor ? tintFor(part) : null;
    items.forEach((it, i) => {
      _m.compose(_p.set(it.x, it.y ?? -0.02, it.z), _q.setFromAxisAngle(UP, it.yaw || 0),
        it.sx ? _s.set(it.sx, it.sy, it.sz) : _s.setScalar(it.scale ?? 1));
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, tint ? tint(it) : _white);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.renderOrder = order;
    mesh.computeBoundingSphere();
    mesh.name = `TOWN_${String(part.name).trim()}`;
    scene.add(mesh);
    return mesh;
  });
}

/* ------------------------------------------------------------------ */
/* The countryside                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build everything around the village.
 * @param {object} o
 * @param {THREE.Scene} o.scene
 * @param {THREE.Vector3} o.center   village centre
 * @param {THREE.Vector3[][]} o.roadRoutes  the kids' village paths
 * @param {{name:string, anchor:THREE.Vector3}[]} o.places
 * @param {object} o.props  captured Blender hut/tree + obstacles + stream box
 * @param {boolean} o.lite  lighter density for phones / low-power devices
 * @returns {{ update(dt:number):void, stats:object }}
 */
export function buildCountryside({ scene, center, roadRoutes, places, props, lite = false }) {
  const rand = seededRandom(20261115);
  const density = lite ? 0.55 : 1;
  const count = (n) => Math.max(1, Math.round(n * density));
  const cx = center.x;
  const cz = center.z;
  const index = new LineIndex();
  (roadRoutes || []).forEach((route) => index.add(route)); // the kids' village paths

  const spline = (ctrl, step) => {
    const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
    return curve.getSpacedPoints(Math.max(2, Math.ceil(curve.getLength() / step)));
  };
  // A natural, slightly wandering line between two points (ends stay put)
  const meander = (a, b, ampScale = 1) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(2, Math.ceil(len / 2.5));
    const nx = -(b.z - a.z) / (len || 1);
    const nz = (b.x - a.x) / (len || 1);
    const amp = Math.min(3, len * 0.07) * ampScale;
    const f1 = 1 + rand() * 2;
    const f2 = 3 + rand() * 3;
    const p1 = rand() * TAU;
    const p2 = rand() * TAU;
    const pts = [];
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      const off = amp * Math.sin(Math.PI * t) * (0.65 * Math.sin(t * Math.PI * f1 + p1) + 0.35 * Math.sin(t * Math.PI * f2 + p2));
      pts.push(V(a.x + (b.x - a.x) * t + nx * off, a.z + (b.z - a.z) * t + nz * off));
    }
    return pts;
  };
  const ring = (rMin, rMax) => {
    const a = rand() * TAU;
    const r = Math.sqrt(rMin * rMin + rand() * (rMax * rMax - rMin * rMin)); // even spread by area
    return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, r };
  };
  const distC = (x, z) => Math.hypot(x - cx, z - cz);

  /* ---------- Roads ---------- */
  const murram = []; // { pts, half }
  const mainSet = [
    // East–west, passing just south of the shops: the village sits on it like a small trading centre
    [V(-540, 70), V(-300, 52), V(-150, 34), V(-60, 30), V(0, 28.5), V(45, 25), V(82, 18), V(150, -2), V(300, -30), V(540, -55)],
    // North–south, meeting it at a junction east of the farm
    [V(118, -540), V(104, -300), V(92, -140), V(84, -40), V(82, 18), V(74, 110), V(58, 260), V(40, 540)],
  ].map((ctrl) => {
    const pts = spline(ctrl, 3);
    murram.push({ pts, half: 2.9 });
    return index.add(pts);
  });
  // Access roads from the main road to the shops and the village farm
  [['Shops', 3.5], ['Farm', 6.5]].forEach(([name, inset]) => {
    const place = places.find((p) => p.name === name);
    const hit = place && index.nearest(place.anchor.x, place.anchor.z, 120, mainSet);
    if (!hit) return;
    const dir = V(hit.x - place.anchor.x, hit.z - place.anchor.z).normalize();
    const pts = meander(V(place.anchor.x + dir.x * inset, place.anchor.z + dir.z * inset), V(hit.x, hit.z), 0.5);
    murram.push({ pts, half: 1.6 });
    index.add(pts);
  });
  // Feeder roads branching off into the countryside
  const feeders = [];
  for (let made = 0, tries = 0; made < 7 && tries < 300; tries += 1) {
    const road = mainSet[Math.floor(rand() * mainSet.length)].pts;
    const i = 2 + Math.floor(rand() * (road.length - 4));
    const a = road[i];
    const r = distC(a.x, a.z);
    if (r < 80 || r > 380) continue;
    const t = road[i + 1].clone().sub(road[i - 1]).normalize();
    const side = rand() < 0.5 ? -1 : 1;
    const dir = V(-t.z * side, t.x * side).applyAxisAngle(UP, (rand() - 0.5) * 0.9);
    const perp = V(-dir.z, dir.x);
    const len = 120 + rand() * 150;
    const ctrl = [
      a.clone(),
      a.clone().addScaledVector(dir, len * 0.35).addScaledVector(perp, (rand() - 0.5) * 30),
      a.clone().addScaledVector(dir, len * 0.7).addScaledVector(perp, (rand() - 0.5) * 40),
      a.clone().addScaledVector(dir, len).addScaledVector(perp, (rand() - 0.5) * 50),
    ];
    if (ctrl.some((p) => distC(p.x, p.z) < 60)) continue;
    if (index.nearest(ctrl[3].x, ctrl[3].z, 45, mainSet)) continue; // would run back into a main road
    if (feeders.some((f) => f.some((p) => ctrl.slice(1).some((q) => p.distanceTo(q) < 45)))) continue;
    const pts = spline(ctrl, 3);
    feeders.push(ctrl);
    murram.push({ pts, half: 1.8 });
    index.add(pts);
    made += 1;
  }

  /* ---------- Land use: what must stay clear of what ---------- */
  const keepOut = places.map((p) => ({ x: p.anchor.x, z: p.anchor.z, r: 14 })).concat(props.obstacles || []);
  const reserved = []; // { x, z, r, kind } swamps, forests, pastures, fields, compounds
  const w = props.water;
  const nearStream = (x, z, m) => w && x > w.min.x - m && x < w.max.x + m && z > w.min.z - m && z < w.max.z + m;
  const isClear = (x, z, { road = 0, room = 0, kinds = null } = {}) => {
    if (nearStream(x, z, 6 + room)) return false;
    if (keepOut.some((k) => Math.hypot(x - k.x, z - k.z) < k.r + room)) return false;
    if (reserved.some((c) => (!kinds || kinds.includes(c.kind)) && Math.hypot(x - c.x, z - c.z) < c.r + room)) return false;
    return road <= 0 || !index.nearest(x, z, road + room);
  };

  /* ---------- Papyrus swamps ---------- */
  const swamps = [];
  const swampAt = (rMin, rMax) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const { x, z } = ring(rMin, rMax);
      const r = 20 + rand() * 18;
      if (!isClear(x, z, { road: 6, room: r })) continue;
      swamps.push({ x, z, r });
      reserved.push({ x, z, r: r + 4, kind: 'swamp' });
      return;
    }
  };
  swampAt(70, 120);
  swampAt(150, 300);
  if (!lite) swampAt(150, 300);

  /* ---------- Forests ---------- */
  const forests = [];
  for (let made = 0, tries = 0; made < count(5) && tries < 400; tries += 1) {
    const { x, z } = ring(115, 330);
    const r = 26 + rand() * 32;
    if (!isClear(x, z, { room: r * 0.9 })) continue;
    forests.push({ x, z, r });
    reserved.push({ x, z, r, kind: 'forest' });
    made += 1;
  }

  /* ---------- Pastures (cattle herds) ---------- */
  const pastures = [];
  const pastureAt = (rMin, rMax) => {
    for (let tries = 0; tries < 200; tries += 1) {
      const { x, z } = ring(rMin, rMax);
      const r = 12 + rand() * 9;
      if (!isClear(x, z, { road: 0, room: r })) continue;
      if (index.nearest(x, z, r * 0.6)) continue;
      pastures.push({ x, z, r });
      reserved.push({ x, z, r, kind: 'pasture' });
      return;
    }
  };
  pastureAt(34, 58); // one herd grazing right beside the village
  for (let i = 1; i < count(6); i += 1) pastureAt(60, 190);

  /* ---------- Homesteads ---------- */
  const compounds = [];
  const tryCompound = (x, z, spacing) => {
    const r = distC(x, z);
    if (r < 16 || r > 340) return false;
    if (!isClear(x, z, { road: 9, room: 0 })) return false;
    if (reserved.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + 7)) return false;
    if (compounds.some((c) => Math.hypot(c.x - x, c.z - z) < spacing)) return false;
    compounds.push({ x, z, r, near: r < 80 });
    return true;
  };
  // Homes line the roads, the way rural settlements grow...
  murram.forEach(({ pts, half }) => {
    let walked = 0;
    let next = 8 + rand() * 20;
    for (let i = 1; i < pts.length - 1; i += 1) {
      walked += pts[i].distanceTo(pts[i - 1]);
      if (walked < next) continue;
      next = walked + (20 + rand() * 22) / density;
      if (rand() < 0.25) continue;
      const t = pts[i + 1].clone().sub(pts[i - 1]).normalize();
      const side = rand() < 0.5 ? -1 : 1;
      const off = half + 8 + rand() * 6;
      tryCompound(pts[i].x - t.z * side * off, pts[i].z + t.x * side * off, 17);
    }
  });
  // ...with more scattered across the fields
  const scatter = (n, rMin, rMax, spacing) => {
    for (let made = 0, tries = 0; made < n && tries < n * 150; tries += 1) {
      const { x, z } = ring(rMin, rMax);
      if (tryCompound(x, z, spacing)) made += 1;
    }
  };
  scatter(count(8), 16, 80, 16);
  scatter(count(30), 90, 300, 24);

  const sets = {
    hutNear: [], hutFar: [], houseNear: [], houseFar: [], yards: [],
    treeNear: [], treeFar: [], forest: [], eucNear: [], eucFar: [],
    bananaNear: [], bananaFar: [], maize: [], papyrus: [],
  };
  const buildings = []; // circles animals walk around
  compounds.forEach((c) => {
    const n = 1 + Math.floor(rand() * 3);
    c.yardR = 3.8 + n * 0.8;
    sets.yards.push({ x: c.x, y: 0, z: c.z, yaw: rand() * TAU, scale: c.yardR });
    reserved.push({ x: c.x, z: c.z, r: c.yardR + 2, kind: 'compound' });
    const start = rand() * TAU;
    for (let i = 0; i < n; i += 1) {
      const ang = start + (i / n) * TAU + (rand() - 0.5) * 0.5;
      const house = rand() < 0.3;
      const dist = n === 1 ? 0 : (house ? 4.4 : 3.5);
      const x = c.x + Math.cos(ang) * dist;
      const z = c.z + Math.sin(ang) * dist;
      // Doors open onto the shared yard
      const face = n === 1 ? rand() * TAU : Math.atan2(c.x - x, c.z - z);
      const scale = 0.85 + rand() * 0.3;
      sets[(house ? 'house' : 'hut') + (c.near ? 'Near' : 'Far')].push({
        x, z, yaw: face - (house ? 0 : props.hut.doorAngle), scale, tone: rand(),
      });
      buildings.push({ x, z, r: (house ? 2.9 : 2.1) * scale });
    }
  });

  /* ---------- Farms ---------- */
  const fields = []; // { x, z, w, d, yaw, kind }
  compounds.forEach((c) => {
    const plots = rand() < 0.78 ? 1 + (rand() < 0.4 ? 1 : 0) : 0;
    for (let k = 0; k < plots; k += 1) {
      const fw = 12 + rand() * 14;
      const fd = 10 + rand() * 10;
      const rad = 0.5 * Math.hypot(fw, fd);
      for (let tries = 0; tries < 8; tries += 1) {
        const ang = rand() * TAU;
        const dist = c.yardR + rad * 0.75 + 2;
        const x = c.x + Math.cos(ang) * dist;
        const z = c.z + Math.sin(ang) * dist;
        if (!isClear(x, z, { road: 2, room: rad * 0.7 })) continue;
        if (compounds.some((o) => Math.hypot(o.x - x, o.z - z) < o.yardR + rad * 0.7)) continue;
        const roll = rand();
        const kind = roll < 0.38 ? 'maize' : roll < 0.62 ? 'beans' : roll < 0.78 ? 'cassava' : roll < 0.9 ? 'tilled' : 'banana';
        fields.push({ x, z, w: fw, d: fd, yaw: ang + (rand() - 0.5) * 0.6, kind, near: distC(x, z) < 90, tone: rand() });
        reserved.push({ x, z, r: rad * 0.75, kind: 'field' });
        break;
      }
    }
  });
  // Rows of crops on the near maize fields; matoke plantations
  fields.forEach((f) => {
    const cos = Math.cos(f.yaw);
    const sin = Math.sin(f.yaw);
    const toWorld = (lx, lz) => ({ x: f.x + lx * cos + lz * sin, z: f.z - lx * sin + lz * cos });
    if (f.kind === 'maize' && f.near) {
      const step = lite ? 1.6 : 1.1;
      // Rows sit on the green stripes of the field texture (one per metre, at .5)
      for (let lx = Math.ceil(-f.w / 2 + 0.3) + 0.5; lx < f.w / 2 - 0.3; lx += 1.0) {
        for (let lz = -f.d / 2 + 0.6; lz < f.d / 2 - 0.4; lz += step) {
          const p = toWorld(lx + (rand() - 0.5) * 0.15, lz + (rand() - 0.5) * 0.3);
          sets.maize.push({ x: p.x, z: p.z, yaw: rand() * TAU, scale: 0.8 + rand() * 0.4, tone: f.tone });
        }
      }
    } else if (f.kind === 'banana') {
      for (let lx = -f.w / 2 + 1.5; lx < f.w / 2 - 1; lx += 3.2) {
        for (let lz = -f.d / 2 + 1.5; lz < f.d / 2 - 1; lz += 3.2) {
          const p = toWorld(lx + (rand() - 0.5) * 0.8, lz + (rand() - 0.5) * 0.8);
          sets[f.near ? 'bananaNear' : 'bananaFar'].push({ x: p.x, z: p.z, yaw: rand() * TAU, scale: 0.8 + rand() * 0.45, tone: rand() });
        }
      }
    }
  });
  // A few banana plants beside most homes; eucalyptus woodlots behind some
  compounds.forEach((c) => {
    if (rand() < 0.75) {
      const n = 2 + Math.floor(rand() * 5);
      const base = rand() * TAU;
      for (let i = 0; i < n; i += 1) {
        const ang = base + (rand() - 0.5) * 1.1;
        const d = c.yardR + 1.2 + rand() * 2.5;
        const x = c.x + Math.cos(ang) * d;
        const z = c.z + Math.sin(ang) * d;
        if (!isClear(x, z, { road: 2, kinds: ['field', 'swamp', 'forest'] })) continue;
        sets[c.near ? 'bananaNear' : 'bananaFar'].push({ x, z, yaw: rand() * TAU, scale: 0.75 + rand() * 0.45, tone: rand() });
      }
    }
    if (rand() < 0.2) {
      const ang = rand() * TAU;
      const ox = c.x + Math.cos(ang) * (c.yardR + 9);
      const oz = c.z + Math.sin(ang) * (c.yardR + 9);
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 4; j += 1) {
          const lx = (i - 1) * 3;
          const lz = (j - 1.5) * 3;
          const x = ox + lx * Math.cos(ang) - lz * Math.sin(ang);
          const z = oz + lx * Math.sin(ang) + lz * Math.cos(ang);
          if (!isClear(x, z, { road: 3, kinds: ['field', 'compound', 'swamp'] })) continue;
          sets[distC(x, z) < 90 ? 'eucNear' : 'eucFar'].push({ x, z, yaw: rand() * TAU, scale: 0.8 + rand() * 0.4, tone: rand() });
        }
      }
    }
  });

  /* ---------- Shortcuts: worn footpaths across the grass ---------- */
  const footpaths = [];
  const crossesHome = (a, b, ...skip) => compounds.some((c) => !skip.includes(c) && segDist(c.x, c.z, a, b) < c.yardR + 1)
    || places.some((p) => segDist(p.anchor.x, p.anchor.z, a, b) < 9)
    || fields.some((f) => segDist(f.x, f.z, a, b) < Math.min(f.w, f.d) * 0.45)
    || swamps.some((s) => segDist(s.x, s.z, a, b) < s.r * 0.8);
  const addPath = (pts) => { footpaths.push(pts); index.add(pts); };
  // Each home to the nearest road or path (nearest first, so later homes can join earlier paths)
  compounds.slice().sort((a, b) => a.r - b.r).forEach((c) => {
    const hit = index.nearest(c.x, c.z, 150);
    if (!hit || hit.d < c.yardR + 1) return;
    const dir = V(hit.x - c.x, hit.z - c.z).normalize();
    const start = V(c.x + dir.x * c.yardR * 0.85, c.z + dir.z * c.yardR * 0.85);
    const end = V(hit.x, hit.z);
    if (crossesHome(start, end, c)) return;
    addPath(meander(start, end));
  });
  // Neighbours visiting neighbours
  compounds.forEach((c) => {
    if (rand() < 0.45) return;
    let best = null;
    compounds.forEach((o) => {
      if (o === c) return;
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      if (d < 65 && (!best || d < best.d)) best = { o, d };
    });
    if (!best || best.o.pair === c) return;
    c.pair = best.o;
    const dir = V(best.o.x - c.x, best.o.z - c.z).normalize();
    const start = V(c.x + dir.x * c.yardR * 0.85, c.z + dir.z * c.yardR * 0.85);
    const end = V(best.o.x - dir.x * best.o.yardR * 0.85, best.o.z - dir.z * best.o.yardR * 0.85);
    if (crossesHome(start, end, c, best.o)) return;
    addPath(meander(start, end));
  });
  // Short cuts across the village where the kids have no direct path
  [['School', 'Farm'], ['School', 'Wood'], ['Wood', 'Well']].forEach(([from, to]) => {
    const a = places.find((p) => p.name === from);
    const b = places.find((p) => p.name === to);
    if (!a || !b) return;
    const A = V(a.anchor.x, a.anchor.z);
    const B = V(b.anchor.x, b.anchor.z);
    const dir = B.clone().sub(A).normalize();
    addPath(meander(A.clone().addScaledVector(dir, 5), B.clone().addScaledVector(dir, -6), 1.6));
  });

  /* ---------- Trees: forests, compound shade, lone and tall trees ---------- */
  forests.forEach((f) => {
    const n = Math.round((f.r * f.r * Math.PI) / 15 * density);
    const placed = [];
    for (let made = 0, tries = 0; made < n && tries < n * 6; tries += 1) {
      const a = rand() * TAU;
      const r = f.r * Math.sqrt(rand());
      const x = f.x + Math.cos(a) * r;
      const z = f.z + Math.sin(a) * r;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 3.1)) continue;
      if (index.nearest(x, z, 4)) continue;
      placed.push({ x, z });
      // thinner at the edge, taller in the middle
      const core = 1 - r / f.r;
      if (rand() < 0.22) sets.eucFar.push({ x, z, yaw: rand() * TAU, scale: 0.8 + rand() * 0.5, tone: rand() });
      else sets.forest.push({ x, z, yaw: rand() * TAU, scale: 1 + core * 0.6 + rand() * 0.5, tone: rand() });
      made += 1;
    }
  });
  compounds.forEach((c) => {
    const trees = rand() < 0.8 ? 1 + Math.floor(rand() * 2) : 0;
    for (let i = 0; i < trees; i += 1) {
      const ang = rand() * TAU;
      const d = c.yardR + 1.5 + rand() * 3;
      const x = c.x + Math.cos(ang) * d;
      const z = c.z + Math.sin(ang) * d;
      if (!isClear(x, z, { road: 3, kinds: ['field', 'swamp'] })) continue;
      sets[c.near ? 'treeNear' : 'treeFar'].push({ x, z, yaw: rand() * TAU, scale: 0.8 + rand() * 0.5, tone: rand() });
    }
  });
  for (let made = 0, tries = 0; made < count(170) && tries < 5000; tries += 1) {
    const { x, z, r } = ring(22, 330);
    const near = r < 75;
    if (!isClear(x, z, { road: near ? 4 : 3, kinds: ['field', 'compound', 'swamp', 'forest', 'pasture'] })) continue;
    sets[near ? 'treeNear' : 'treeFar'].push({ x, z, yaw: rand() * TAU, scale: 0.75 + rand() * 0.6, tone: rand() });
    made += 1;
  }
  // Tall landmarks near the village: big shade trees and lone eucalyptus
  for (let made = 0, tries = 0; made < count(14) && tries < 2000; tries += 1) {
    const { x, z } = ring(24, 95);
    if (!isClear(x, z, { road: 5, room: 2, kinds: ['field', 'compound', 'swamp', 'pasture'] })) continue;
    if (rand() < 0.5) sets.treeNear.push({ x, z, yaw: rand() * TAU, scale: 1.7 + rand() * 0.7, tone: rand() });
    else sets.eucNear.push({ x, z, yaw: rand() * TAU, scale: 0.9 + rand() * 0.35, tone: rand() });
    made += 1;
  }
  // Eucalyptus windbreaks along stretches of the feeder roads
  murram.slice(2).forEach(({ pts, half }) => {
    if (rand() < 0.4) return;
    const start = Math.floor(rand() * pts.length * 0.5);
    const len = Math.min(pts.length - 1, start + 15 + Math.floor(rand() * 20));
    const side = rand() < 0.5 ? -1 : 1;
    for (let i = start + 1; i < len; i += 2) {
      const t = pts[i + 1] ? pts[i + 1].clone().sub(pts[i - 1]).normalize() : V(1, 0);
      const x = pts[i].x - t.z * side * (half + 3.5);
      const z = pts[i].z + t.x * side * (half + 3.5);
      if (!isClear(x, z, { kinds: ['compound', 'field', 'swamp'] })) continue;
      sets[distC(x, z) < 90 ? 'eucNear' : 'eucFar'].push({ x, z, yaw: rand() * TAU, scale: 0.85 + rand() * 0.3, tone: rand() });
    }
  });

  /* ---------- Swamp plants ---------- */
  const pools = [];
  swamps.forEach((s) => {
    const nPools = 3 + Math.floor(rand() * 4);
    for (let i = 0; i < nPools; i += 1) {
      const a = rand() * TAU;
      const r = s.r * 0.55 * Math.sqrt(rand());
      pools.push({ x: s.x + Math.cos(a) * r, z: s.z + Math.sin(a) * r, r: 3 + rand() * 5, swamp: s });
    }
    const n = Math.round(Math.min(260, s.r * s.r * 0.3) * density);
    for (let made = 0, tries = 0; made < n && tries < n * 5; tries += 1) {
      const a = rand() * TAU;
      const r = s.r * 0.95 * Math.sqrt(rand());
      const x = s.x + Math.cos(a) * r;
      const z = s.z + Math.sin(a) * r;
      if (pools.some((p) => p.swamp === s && Math.hypot(p.x - x, p.z - z) < p.r * 0.85)) continue;
      sets.papyrus.push({ x, z, yaw: rand() * TAU, scale: 0.7 + rand() * 0.6, tone: rand() });
      made += 1;
    }
  });

  /* ---------- Meshes: ground features (each kind is one merged mesh) ---------- */
  // Ground draw order: swamp, pools, fields & yards, footpaths, murram, then the kids' paths
  const addFlat = (geos, material, name, order) => {
    if (!geos.length) return;
    const mesh = new THREE.Mesh(mergeGeometries(geos), material);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.renderOrder = order;
    scene.add(mesh);
  };
  addFlat(murram.map(({ pts, half }) => ribbon(pts, half, 0.03, 5)), new THREE.MeshStandardMaterial({
    // Red laterite ("murram"): dusty verges, two tyre tracks, a lighter crown
    map: earthTexture(256, 128, '#b0673d', [214, 150, 104], [
      [0, 0.1, 'rgba(214, 170, 120, 0.22)'], [0.9, 1, 'rgba(214, 170, 120, 0.22)'],
      [0.24, 0.35, 'rgba(110, 52, 28, 0.2)'], [0.65, 0.76, 'rgba(110, 52, 28, 0.2)'],
      [0.43, 0.57, 'rgba(232, 168, 118, 0.1)'],
    ]),
    alphaMap: edgeAlpha(0.14),
    transparent: true,
    depthWrite: false,
    roughness: 0.95,
  }), 'ROAD_Murram', -2);
  addFlat(footpaths.map((pts) => ribbon(pts, 0.55, 0.045, 3)), new THREE.MeshStandardMaterial({
    map: earthTexture(128, 64, '#a68c66', [196, 172, 132]),
    alphaMap: edgeAlpha(0.36),
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    roughness: 1,
  }), 'ROAD_Footpaths', -3);

  // Fields: crops in rows, or freshly dug soil
  const fieldGeo = (f) => {
    const cos = Math.cos(f.yaw);
    const sin = Math.sin(f.yaw);
    const hw = f.w / 2;
    const hd = f.d / 2;
    const corner = (lx, lz) => [f.x + lx * cos + lz * sin, 0.006, f.z - lx * sin + lz * cos];
    const A = corner(-hw, -hd); const B = corner(hw, -hd); const C = corner(hw, hd); const D = corner(-hw, hd);
    const uvA = [-hw, -hd / 4]; const uvB = [hw, -hd / 4]; const uvC = [hw, hd / 4]; const uvD = [-hw, hd / 4];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...A, ...C, ...B, ...A, ...D, ...C], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([...uvA, ...uvC, ...uvB, ...uvA, ...uvD, ...uvC], 2));
    g.setAttribute('uv1', new THREE.Float32BufferAttribute([0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1], 2));
    const tint = new THREE.Color(f.kind === 'maize' ? 0xf0f0b0 : f.kind === 'beans' ? 0xd8f0c8 : f.kind === 'cassava' ? 0xc8e0b8 : 0xffffff)
      .multiplyScalar(0.92 + f.tone * 0.12);
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(6).fill(0).flatMap(() => [tint.r, tint.g, tint.b]), 3));
    return g;
  };
  const fieldAlpha = rectAlpha();
  fieldAlpha.channel = 1;
  const rowTexture = canvasTexture(32, 128, (g, w, h) => {
    g.fillStyle = '#7a5638';
    g.fillRect(0, 0, w, h);
    speckle(g, w, h, [150, 110, 76], 0.12);
    for (let i = 0; i < 70; i += 1) {
      g.fillStyle = ['#6f9a3a', '#86ad48', '#5c8a33', '#7aa040'][i % 4];
      g.beginPath();
      g.arc(w * (0.35 + Math.random() * 0.3), Math.random() * h, 3 + Math.random() * 4, 0, TAU);
      g.fill();
    }
  });
  const soilTexture = canvasTexture(32, 64, (g, w, h) => {
    g.fillStyle = '#86603f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(90, 60, 36, 0.55)';
    g.fillRect(w * 0.38, 0, w * 0.24, h);
    g.fillStyle = 'rgba(176, 134, 92, 0.3)';
    g.fillRect(0, 0, w * 0.18, h);
    speckle(g, w, h, [170, 128, 88], 0.12);
  });
  const fieldMat = (map) => {
    const alpha = fieldAlpha;
    return new THREE.MeshStandardMaterial({ map, alphaMap: alpha, vertexColors: true, transparent: true, depthWrite: false, roughness: 1 });
  };
  addFlat(fields.filter((f) => ['maize', 'beans', 'cassava'].includes(f.kind)).map(fieldGeo), fieldMat(rowTexture), 'FARM_Crops', -4);
  addFlat(fields.filter((f) => ['tilled', 'banana'].includes(f.kind)).map(fieldGeo), fieldMat(soilTexture), 'FARM_Soil', -4);

  // Swamps: marshy ground with dark open water
  const radial = radialAlpha(0.55);
  radial.channel = 1;
  addFlat(swamps.map((s) => blob(s.x, s.z, s.r, 0.004, rand, 0.25)), new THREE.MeshStandardMaterial({
    map: canvasTexture(64, 64, (g, w, h) => {
      g.fillStyle = '#56663a';
      g.fillRect(0, 0, w, h);
      speckle(g, w, h, [120, 140, 80], 0.2);
    }),
    alphaMap: radial,
    transparent: true,
    depthWrite: false,
    roughness: 0.85,
  }), 'SWAMP_Ground', -6);
  const poolAlpha = radialAlpha(0.7);
  poolAlpha.channel = 1;
  addFlat(pools.map((p) => blob(p.x, p.z, p.r, 0.012, rand, 0.3, 24)), new THREE.MeshStandardMaterial({
    color: 0x3e6262,
    alphaMap: poolAlpha,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    roughness: 0.12,
    metalness: 0.1,
  }), 'SWAMP_Water', -5);

  /* ---------- Meshes: buildings, plants, trees (instanced) ---------- */
  const color = new THREE.Color();
  const multiply = (list, salt = 1) => (it) => color.setRGB(...pickOf(list, it.tone * salt));
  const paint = (list, salt = 1) => (it) => color.setHex(pickOf(list, it.tone * salt));
  const hutTint = (part) => {
    if (/thatch|roof/i.test(part.name)) return multiply(HUT_THATCH_TINTS, 7);
    if (/mud|wall/i.test(part.name)) return multiply(HUT_WALL_TINTS);
    return null;
  };
  const houseTint = (part) => (part.name === 'house-wall' ? paint(HOUSE_WALLS) : part.name === 'house-roof' ? paint(HOUSE_ROOFS, 7) : null);
  const canopyTint = (palette) => (part) => (/canopy/.test(part.name) ? paint(palette) : null);
  const greenTint = () => (it) => color.setRGB(0.9 + (it.tone % 0.2), 1, 0.85 + ((it.tone * 3) % 0.15));
  const near = { cast: true, receive: true };
  const far = { cast: false, receive: false }; // beyond the shadow area anyway
  const house = houseModel();
  const roundTree = roundTreeModel();
  const eucalyptus = eucalyptusModel();
  const banana = bananaModel();

  instanced(scene, props.hut.parts, sets.hutNear, near, hutTint);
  instanced(scene, props.hut.parts, sets.hutFar, far, hutTint);
  instanced(scene, house, sets.houseNear, near, houseTint);
  instanced(scene, house, sets.houseFar, far, houseTint);
  if (props.tree) {
    instanced(scene, props.tree.parts, sets.treeNear, near, (part) => (/leaf/i.test(part.name) ? multiply(LEAF_TINTS) : null));
  } else {
    sets.treeFar.push(...sets.treeNear);
  }
  instanced(scene, roundTree, sets.treeFar.concat(sets.forest.map((t) => ({ ...t, forest: true }))), far,
    (part) => (part.name === 'tree-canopy' ? (it) => color.setHex(pickOf(it.forest ? FOREST_COLORS : LEAF_COLORS, it.tone)) : null));
  instanced(scene, eucalyptus, sets.eucNear, near, canopyTint(EUCALYPTUS_COLORS));
  instanced(scene, eucalyptus, sets.eucFar, far, canopyTint(EUCALYPTUS_COLORS));
  instanced(scene, banana, sets.bananaNear, near, greenTint);
  instanced(scene, banana, sets.bananaFar, far, greenTint);
  instanced(scene, maizeModel(), sets.maize, { cast: false, receive: true }, () => (it) => color.setHex(0x9ab348).multiplyScalar(0.9 + it.tone * 0.2));
  instanced(scene, papyrusModel(), sets.papyrus, far, greenTint);
  instanced(scene, [{ name: 'yard', geometry: (() => { const g = new THREE.CircleGeometry(1, 28); g.rotateX(-Math.PI / 2); return g; })(), material: new THREE.MeshStandardMaterial({
    color: 0xa58b6c,
    roughness: 1,
    alphaMap: radialAlpha(0.45),
    transparent: true,
    depthWrite: false,
  }) }], sets.yards, { receive: true, order: -4 });

  /* ---------- Animals ---------- */
  const herds = [];
  const cattle = [];
  pastures.forEach((p, i) => {
    const n = i === 0 ? 7 : 4 + Math.floor(rand() * 7);
    for (let k = 0; k < n; k += 1) {
      const a = rand() * TAU;
      const r = p.r * 0.8 * Math.sqrt(rand());
      cattle.push({ x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, home: p, scale: 0.9 + rand() * 0.2, pace: 0.8 + rand() * 0.4, tone: rand() });
    }
  });
  const goats = [];
  const dogs = [];
  const chickens = [];
  // A starting spot inside `home` that isn't inside a building
  const freeSpot = (home) => {
    for (let t = 0; t < 16; t += 1) {
      const a = rand() * TAU;
      const r = home.r * Math.sqrt(rand());
      const x = home.x + Math.cos(a) * r;
      const z = home.z + Math.sin(a) * r;
      if (!buildings.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + 0.4)) return { x, z };
    }
    return { x: home.x + home.r, z: home.z };
  };
  compounds.filter((c) => c.r < 115).forEach((c) => {
    const yard = { x: c.x, z: c.z, r: c.yardR + 1 };
    const nChickens = rand() < 0.85 ? Math.round((2 + Math.floor(rand() * 5)) * density) : 0;
    for (let k = 0; k < nChickens; k += 1) {
      chickens.push({ ...freeSpot(yard), home: yard, scale: 0.9 + rand() * 0.25, pace: 0.8 + rand() * 0.5, tone: rand() });
    }
    if (rand() < 0.5) {
      const home = { x: c.x, z: c.z, r: c.yardR + 7 };
      dogs.push({ ...freeSpot(home), home, scale: 0.9 + rand() * 0.25, pace: 0.8 + rand() * 0.4, tone: rand() });
    }
    if (rand() < 0.5) {
      // A few goats grazing just outside the compound
      for (let tries = 0; tries < 6; tries += 1) {
        const ang = rand() * TAU;
        const gx = c.x + Math.cos(ang) * (c.yardR + 7);
        const gz = c.z + Math.sin(ang) * (c.yardR + 7);
        if (!isClear(gx, gz, { road: 3, kinds: ['field', 'swamp', 'forest', 'pasture'] })) continue;
        const home = { x: gx, z: gz, r: 5 };
        const n = 2 + Math.floor(rand() * 4);
        for (let k = 0; k < n; k += 1) {
          goats.push({ ...freeSpot(home), home, scale: 0.9 + rand() * 0.25, pace: 0.8 + rand() * 0.4, tone: rand() });
        }
        break;
      }
    }
  });
  // Animals near the village get full detail and cast shadows (they're inside
  // the sun's shadow area); distant herds, never seen up close, use about half
  // the polygons and no shadows.
  const addAnimals = (makeSpecies, list, blockers) => {
    if (!list.length) return;
    const nearList = list.filter((a) => distC(a.home.x, a.home.z) < 50);
    const farList = list.filter((a) => distC(a.home.x, a.home.z) >= 50);
    [[nearList, true, 1], [farList, false, 0.5]].forEach(([group, castShadow, detail]) => {
      if (!group.length) return;
      const herd = new AnimalGroup(scene, makeSpecies(detail), group, rand, { castShadow });
      if (blockers) herd.setBlockers(blockers);
      herds.push(herd);
    });
  };
  addAnimals(SPECIES.cattle, cattle, null);
  addAnimals(SPECIES.goat, goats, buildings);
  addAnimals(SPECIES.dog, dogs, buildings);
  addAnimals(SPECIES.chicken, chickens, buildings);

  const stats = {
    homesteads: compounds.length,
    huts: sets.hutNear.length + sets.hutFar.length,
    houses: sets.houseNear.length + sets.houseFar.length,
    roads: murram.length,
    footpaths: footpaths.length,
    fields: fields.length,
    bananas: sets.bananaNear.length + sets.bananaFar.length,
    maize: sets.maize.length,
    trees: sets.treeNear.length + sets.treeFar.length + sets.forest.length,
    eucalyptus: sets.eucNear.length + sets.eucFar.length,
    forests: forests.length,
    swamps: swamps.length,
    papyrus: sets.papyrus.length,
    cattle: cattle.length,
    goats: goats.length,
    dogs: dogs.length,
    chickens: chickens.length,
  };
  return {
    stats,
    herds,
    /** Animate the animals (dt in seconds; 0 while paused). */
    update(dt) { herds.forEach((h) => h.update(dt)); },
  };
}
