/**
 * Literacy of Love — Blender sim viewer
 * Paths scrub with the day timeline; Walk/Idle play in real-time
 * at a rate matched to each kid's travel speed (no foot-slide).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SCENE_URL = 'simulation/web/assets/scene.glb';
const SCHEDULE_URL = 'simulation/web/schedule.json';

const LOCATION_COORDS = {
  Home: new THREE.Vector3(0, 0, 0),
  School: new THREE.Vector3(2, 0, -22),
  Farm: new THREE.Vector3(24, 0, -2),
  Shops: new THREE.Vector3(1, 0, 20),
  Wood: new THREE.Vector3(-20, 0, -16),
  Well: new THREE.Vector3(-14, 0, 12),
};

/** meters per walk cycle — matches Blender schedule stride */
const STRIDE_M = 0.55;
/** Keep kids from occupying the same spot */
const MIN_SEPARATION = 1.35;

const CARRY_WORDS = ['water', 'wood', 'kindling', 'return', 'carry', 'fetch'];
const CHORE_WORDS = ['gather', 'farm', 'help', 'tend', 'errand', 'market', 'chore', 'fetch', 'prepare'];
const SCHOOL_WORDS = ['class', 'school'];

function activityMode(activity, type) {
  const a = (activity || '').toLowerCase();
  if (type === 'travel') {
    return CARRY_WORDS.some((w) => a.includes(w)) ? 'carry' : 'walk';
  }
  if (SCHOOL_WORDS.some((w) => a.includes(w))) return 'sit';
  if (CHORE_WORDS.some((w) => a.includes(w))) return 'pickup';
  return 'idle';
}

function parseClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h + m / 60;
}

function formatClock(hour) {
  const h = Math.floor(hour) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60) % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function cssColor(arr) {
  return `rgb(${Math.round(arr[0] * 255)}, ${Math.round(arr[1] * 255)}, ${Math.round(arr[2] * 255)})`;
}

export class SimViewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.sceneUrl = opts.sceneUrl || SCENE_URL;
    this.scheduleUrl = opts.scheduleUrl || SCHEDULE_URL;
    this.onTick = opts.onTick || (() => {});
    this.onReady = opts.onReady || (() => {});

    this.playing = true;
    this.speed = 1;
    this.dayHour = 6;
    this.followId = null;
    /** When true, user is orbiting freely — don't overwrite camera with follow-cam */
    this.freeLook = false;
    this.schedule = null;
    this.meta = null;
    this.pathMixer = null;
    this.pathActions = [];
    this.clipDuration = 1;
    this.fps = 24;
    this.frameStart = 1;
    this.frameEnd = 1261;
    this.kidRoots = new Map();
    this.kidLoco = new Map(); // id -> { walk, idle, mode, prevPos }
    this.kidDefs = [];
    this.clock = new THREE.Clock();
    this._tmp = new THREE.Vector3();

    this._initRenderer();
    this._initScene();
    this._initLights();
    this._load();
  }

  _initRenderer() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(rect.width, rect.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.camera = new THREE.PerspectiveCamera(40, rect.width / Math.max(rect.height, 1), 0.2, 250);
    this.camera.position.set(-36, 28, 42);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 120;
    this.controls.target.set(0, 1.5, 0);

    window.addEventListener('resize', () => this.resize());
    this._bindDisplayRecovery();
  }

  _bindDisplayRecovery() {
    const parent = this.canvas.parentElement;
    if (parent && typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(parent);
    }

    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this._contextLost = true;
      const gl = this.renderer.getContext();
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      window.setTimeout(() => {
        try { lose && lose.restoreContext(); } catch (err) { /* restore already in progress */ }
      }, 200);
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      this._contextLost = false;
      this.resize();
      this._kickLoop();
    });

    window.addEventListener('pageshow', () => {
      this.clock.getDelta();
      this._contextLost = false;
      this.resize();
      this._kickLoop();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.clock.getDelta();
      const gl = this.renderer.getContext();
      if (gl && gl.isContextLost()) {
        this._contextLost = true;
        const lose = gl.getExtension('WEBGL_lose_context');
        try { lose && lose.restoreContext(); } catch (err) { /* ignore */ }
        return;
      }
      this.resize();
      this._kickLoop();
    });
  }

  _kickLoop() {
    if (this._loopQueued) return;
    this._loopQueued = true;
    this._raf = requestAnimationFrame(this._animate);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xb9d4ea);
    this.scene.fog = new THREE.Fog(0xb9d4ea, 55, 140);
  }

  _initLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff5e6, 0x6a8f55, 0.95));
    this.sun = new THREE.DirectionalLight(0xfff0d4, 1.55);
    this.sun.position.set(28, 42, 16);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 2;
    this.sun.shadow.camera.far = 140;
    this.sun.shadow.camera.left = -55;
    this.sun.shadow.camera.right = 55;
    this.sun.shadow.camera.top = 55;
    this.sun.shadow.camera.bottom = -55;
    this.sun.shadow.bias = -0.00035;
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  }

  _ensureWell() {
    let hasWell = false;
    this.scene.traverse((o) => {
      if (o.name && /^(PH_Well|WELL_)/i.test(o.name)) hasWell = true;
    });
    if (hasWell) return;
    const c = LOCATION_COORDS.Well;
    const g = new THREE.Group();
    g.name = 'Well_Fallback';
    const mud = new THREE.MeshStandardMaterial({ color: 0x73522e, roughness: 0.95 });
    const water = new THREE.MeshStandardMaterial({ color: 0x387aa0, roughness: 0.25 });
    const bank = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.1, 28), mud);
    bank.position.set(0, 0.05, 0);
    g.add(bank);
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 0.06, 28), water);
    pool.position.set(0, 0.08, 0);
    pool.name = 'WELL_Water';
    g.add(pool);
    g.position.copy(c);
    this.scene.add(g);
  }

  _waterMaterial(normalMap) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSun: { value: new THREE.Vector3(0.4, 1, 0.2) },
        uNormal: { value: normalMap },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        uniform float uTime;
        varying vec3 vWorld;
        varying vec2 vLocal;

        void main() {
          vec3 p = position;
          vLocal = vec2(p.x, p.z);
          float flow = p.x - uTime * 1.5;
          p.y += sin(flow * 5.5) * 0.008;
          vec4 world = modelMatrix * vec4(p, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uSun;
        uniform sampler2D uNormal;
        varying vec3 vWorld;
        varying vec2 vLocal;

        void main() {
          float halfL = 6.6;
          float halfW = 1.45;
          vec2 q = abs(vLocal) - vec2(halfL - halfW, 0.0);
          float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - halfW;
          if (sd > 0.0) discard;

          vec2 flowUv = vec2(vLocal.x * 0.55, vLocal.y * 1.6);
          vec3 nA = texture2D(uNormal, flowUv + vec2(-uTime * 0.85, 0.0)).xyz * 2.0 - 1.0;
          vec3 nB = texture2D(uNormal, flowUv * 1.8 + vec2(-uTime * 1.45, 0.03)).xyz * 2.0 - 1.0;
          vec3 n = normalize(vec3((nA.x + nB.x) * 1.4, 0.85, nA.y + nB.y));

          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 sunDir = normalize(uSun);
          float ndotv = max(dot(n, viewDir), 0.0);
          float fres = pow(1.0 - ndotv, 2.2);
          float spec = pow(max(dot(reflect(-sunDir, n), viewDir), 0.0), 48.0);
          float rush = pow(clamp(nA.x * 0.5 + 0.5, 0.0, 1.0), 3.0);

          vec3 water = vec3(0.30, 0.70, 0.78);
          vec3 sky = vec3(0.84, 0.93, 0.97);
          vec3 col = mix(water, water * 1.35, rush * 0.45);
          col = mix(col, sky, fres * 0.65);
          col += spec * vec3(0.95, 0.98, 1.0) * 0.5;
          gl_FragColor = vec4(col, 0.8);
        }
      `,
    });
  }

  _setupWater() {
    this.waterMats = [];
    const sources = [];
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (o.name === 'WELL_Water' || o.name === 'WELL_Bank') {
        sources.push(o);
        o.visible = false;
      }
    });
    const water = sources.find((o) => o.name === 'WELL_Water');
    if (!water) return;
    const box = new THREE.Box3().setFromObject(water);
    const cx = (box.min.x + box.max.x) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;
    const y = box.max.y + 0.06;
    const normals = new THREE.TextureLoader().load('simulation/web/assets/waternormals.jpg');
    normals.wrapS = THREE.RepeatWrapping;
    normals.wrapT = THREE.RepeatWrapping;
    normals.colorSpace = THREE.NoColorSpace;
    const geo = new THREE.PlaneGeometry(14, 3.2, 80, 12);
    geo.rotateX(-Math.PI / 2);
    const mat = this._waterMaterial(normals);
    const surface = new THREE.Mesh(geo, mat);
    surface.name = 'WELL_WaterSurface';
    surface.position.set(cx, y + 0.04, cz);
    surface.renderOrder = 2;
    this.scene.add(surface);
    this.waterMats.push(mat);
  }

  _dirtTexture() {
    if (this._dirtMap) return this._dirtMap;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const g = canvas.getContext('2d');
    g.fillStyle = '#8b6842';
    g.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 2200; i += 1) {
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      const shade = 70 + Math.random() * 90;
      g.fillStyle = `rgba(${shade + 30}, ${Math.floor(shade * 0.72)}, ${Math.floor(shade * 0.42)}, 0.45)`;
      g.fillRect(x, y, 2 + Math.random() * 2, 2);
    }
    g.fillStyle = 'rgba(70, 48, 28, 0.35)';
    g.fillRect(0, 34, 256, 14);
    g.fillRect(0, 80, 256, 14);
    g.fillStyle = 'rgba(196, 164, 116, 0.35)';
    g.fillRect(0, 0, 256, 10);
    g.fillRect(0, 118, 256, 10);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this._dirtMap = tex;
    return tex;
  }

  _filletRoute(points) {
    if (points.length < 3) return points.map((p) => p.clone());
    const out = [points[0].clone()];
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];
      const d0 = curr.clone().sub(prev);
      const d1 = next.clone().sub(curr);
      const len0 = d0.length();
      const len1 = d1.length();
      if (len0 < 0.05 || len1 < 0.05) {
        out.push(curr.clone());
        continue;
      }
      d0.multiplyScalar(1 / len0);
      d1.multiplyScalar(1 / len1);
      const angle = Math.acos(THREE.MathUtils.clamp(d0.dot(d1), -1, 1));
      if (angle < 0.35) {
        out.push(curr.clone());
        continue;
      }
      const cut = Math.min(1.3, len0 * 0.45, len1 * 0.45);
      const a = curr.clone().addScaledVector(d0, -cut);
      const b = curr.clone().addScaledVector(d1, cut);
      for (let s = 0; s <= 5; s += 1) {
        const t = s / 5;
        const u = 1 - t;
        out.push(new THREE.Vector3()
          .addScaledVector(a, u * u)
          .addScaledVector(curr, 2 * u * t)
          .addScaledVector(b, t * t));
      }
    }
    out.push(points[points.length - 1].clone());
    return out;
  }

  _pathCenterline(mesh) {
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.attributes.position;
    if (!pos || pos.count < 9) return [];
    const e = mesh.matrixWorld.elements;
    const world = (i) => {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      return new THREE.Vector3(
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14]
      );
    };
    const rings = [];
    const ring = pos.count % 9 === 0 ? 9 : 1;
    for (let i = 0; i < pos.count; i += ring) {
      const c = new THREE.Vector3();
      const n = Math.min(ring, pos.count - i);
      for (let k = 0; k < n; k += 1) c.add(world(i + k));
      c.multiplyScalar(1 / n);
      const prev = rings[rings.length - 1];
      if (!prev || prev.distanceTo(c) > 0.2) rings.push(c);
    }
    if (rings.length < 2) return [];
    const out = [rings[0].clone()];
    for (let i = 1; i < rings.length; i += 1) {
      const a = rings[i - 1];
      const b = rings[i];
      const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 1.5));
      for (let s = 1; s <= steps; s += 1) out.push(a.clone().lerp(b, s / steps));
    }
    return out;
  }

  _sameRoute(a, b) {
    const step = Math.max(1, Math.floor(a.length / 8));
    let sum = 0;
    let n = 0;
    for (let i = 0; i < a.length; i += step) {
      let best = Infinity;
      for (let j = 0; j < b.length; j += 1) {
        const dx = a[i].x - b[j].x;
        const dz = a[i].z - b[j].z;
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      sum += Math.sqrt(best);
      n += 1;
    }
    return sum / n < 0.75;
  }

  _addDirtRoad(points, index) {
    const route = this._filletRoute(points);
    const half = 1.2;
    const positions = [];
    const uvs = [];
    const indices = [];
    let dist = 0;
    route.forEach((p, i) => {
      const prev = route[Math.max(0, i - 1)];
      const next = route[Math.min(route.length - 1, i + 1)];
      const inDir = p.clone().sub(prev);
      const outDir = next.clone().sub(p);
      if (inDir.lengthSq() < 1e-6) inDir.copy(outDir);
      if (outDir.lengthSq() < 1e-6) outDir.copy(inDir);
      inDir.normalize();
      outDir.normalize();
      const tangent = inDir.clone().add(outDir);
      if (tangent.lengthSq() < 1e-6) tangent.copy(outDir);
      tangent.normalize();
      const px = -tangent.z;
      const pz = tangent.x;
      const inPx = -inDir.z;
      const inPz = inDir.x;
      const denom = px * inPx + pz * inPz;
      const miter = THREE.MathUtils.clamp(1 / Math.max(0.4, Math.abs(denom)), 1, 1.8);
      const y = p.y + 0.035 + index * 0.003;
      const span = half * miter;
      positions.push(p.x + px * span, y, p.z + pz * span);
      positions.push(p.x - px * span, y, p.z - pz * span);
      if (i > 0) dist += p.distanceTo(route[i - 1]);
      const u = dist / 2.4;
      uvs.push(u, 0, u, 1);
    });
    for (let i = 0; i < route.length - 1; i += 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: this._dirtTexture(),
      roughness: 0.96,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `DIRT_Road_${index}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.scene.add(mesh);
  }

  _setupDirtRoads() {
    const meshes = [];
    this.scene.traverse((o) => {
      if (o.isMesh && (/^PATH_/i.test(o.name) || o.name === 'FARM_Path')) meshes.push(o);
    });
    const routes = [];
    meshes.forEach((mesh) => {
      if (mesh.name === 'FARM_Path') {
        mesh.material = new THREE.MeshStandardMaterial({
          map: this._dirtTexture(),
          roughness: 0.96,
          metalness: 0,
        });
        return;
      }
      const pts = this._pathCenterline(mesh);
      mesh.visible = false;
      if (pts.length < 2) return;
      if (routes.some((route) => this._sameRoute(pts, route))) return;
      routes.push(pts);
      this._addDirtRoad(pts, routes.length - 1);
    });
    this.roadRoutes = routes;
  }

  _connectRoadToHut() {
    if (!this.roadRoutes || !this.roadRoutes.length) return;
    let door = null;
    let hut = null;
    this.scene.traverse((o) => {
      if (!door && o.name === 'HUT_Door') door = o;
      if (!hut && o.name === 'HUT_Root') hut = o;
    });
    if (!door) return;
    const doorPos = this._worldPos(door);
    const center = hut ? this._worldPos(hut) : doorPos.clone();
    const forward = doorPos.clone().sub(center);
    forward.y = 0;
    if (forward.lengthSq() < 0.01) forward.set(0, 0, 1);
    forward.normalize();

    let best = null;
    let bestD = Infinity;
    this.roadRoutes.forEach((route) => {
      for (let i = 0; i < route.length - 1; i += 1) {
        const a = route[i];
        const b = route[i + 1];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        let t = 0;
        if (len2 > 1e-6) {
          t = ((doorPos.x - a.x) * abx + (doorPos.z - a.z) * abz) / len2;
          t = Math.max(0, Math.min(1, t));
        }
        const x = a.x + abx * t;
        const z = a.z + abz * t;
        const dx = x - doorPos.x;
        const dz = z - doorPos.z;
        if (dx * forward.x + dz * forward.z < 0.4) continue;
        const d = Math.hypot(dx, dz);
        if (d < bestD) {
          bestD = d;
          best = new THREE.Vector3(x, a.y + (b.y - a.y) * t, z);
        }
      }
    });
    if (!best) return;
    const end = doorPos.clone().addScaledVector(forward, 0.45);
    end.y = best.y;
    this._addDirtRoad([best, end], this.roadRoutes.length);
  }

  _fixMaterials(root) {
    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.visible = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((mat) => {
        if (!mat) return;
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
        mat.side = THREE.DoubleSide;
        if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
        if ('metalness' in mat) mat.metalness = Math.min(mat.metalness ?? 0, 0.2);
        if ('roughness' in mat) mat.roughness = Math.max(mat.roughness ?? 0.65, 0.45);
        if ('transmission' in mat) mat.transmission = 0;
        mat.needsUpdate = true;
      });
    });
  }

  _findKidRoots(root) {
    const map = new Map();
    root.traverse((o) => {
      const m = (o.name || '').match(/^KID_(kid_0[123])$/i);
      if (m) map.set(m[1].toLowerCase(), o);
    });
    return map;
  }

  _activityAt(def, hour) {
    const events = def.events || [];
    let cur = events[0];
    for (const e of events) {
      if (parseClock(e.time) <= hour) cur = e;
      else break;
    }
    return cur || { activity: '—', location: 'Home', type: 'hold' };
  }

  _hourToAnimTime(hour) {
    const start = this.meta.day_start_hour;
    const end = this.meta.day_end_hour;
    const t = THREE.MathUtils.clamp((hour - start) / (end - start), 0, 0.9999);
    return t * this.clipDuration;
  }

  _applyPathTime(hour) {
    if (!this.pathMixer || !this.pathActions.length) return;
    const time = this._hourToAnimTime(hour);
    for (const action of this.pathActions) {
      action.enabled = true;
      action.paused = false;
      action.timeScale = 0;
      action.time = Math.min(time, action.getClip().duration);
    }
    this.pathMixer.update(0);
  }

  _setLocoMode(loco, mode) {
    if (loco.mode === mode) return;
    const prev = loco.actions[loco.mode];
    const next = loco.actions[mode] || loco.actions.idle;
    if (prev && prev !== next) prev.fadeOut(0.22);
    if (next) {
      next.reset().fadeIn(0.22).play();
      // Sit / pickup play through; walk/carry/idle loop
      if (mode === 'sit' || mode === 'pickup') {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        next.setLoop(THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = false;
      }
    }
    loco.mode = mode;
  }

  _setupClips(root, clips) {
    this.pathMixer = new THREE.AnimationMixer(root);
    this.pathActions = [];
    this.kidLoco = new Map();
    this.locoMixer = new THREE.AnimationMixer(root);

    const pathClips = [];
    /** @type {Map<string, Map<string, THREE.AnimationClip>>} */
    const byKid = new Map();

    const ensureKid = (id) => {
      if (!byKid.has(id)) byKid.set(id, new Map());
      return byKid.get(id);
    };

    clips.forEach((clip) => {
      const n = clip.name || '';
      let m = n.match(/^(walk|idle|pickup|sit|carry)[_-]?kid[_-]?0?([123])/i);
      if (m) {
        const kind = m[1].toLowerCase();
        const id = `kid_0${m[2]}`;
        ensureKid(id).set(kind, clip);
        return;
      }
      m = n.match(/path[_-]?kid[_-]?0?([123])/i);
      if (m || /KID_kid_0[123]/i.test(n) || /Animation_KID/i.test(n)) {
        pathClips.push(clip);
        return;
      }
      const rootTracks = clip.tracks.filter((t) => /^KID_kid_0[123]\./i.test(t.name));
      if (rootTracks.length) {
        pathClips.push(new THREE.AnimationClip(`${clip.name}_roots`, clip.duration, rootTracks));
      }
    });

    let maxDur = 0;
    pathClips.forEach((clip) => {
      const action = this.pathMixer.clipAction(clip);
      action.play();
      action.timeScale = 0;
      action.paused = false;
      this.pathActions.push(action);
      maxDur = Math.max(maxDur, clip.duration);
    });
    this.clipDuration = maxDur > 0.1 ? maxDur : (this.frameEnd - this.frameStart) / this.fps;

    for (let i = 1; i <= 3; i++) {
      const id = `kid_0${i}`;
      const map = byKid.get(id) || new Map();
      const actions = {};
      ['walk', 'idle', 'pickup', 'sit', 'carry'].forEach((kind) => {
        const clip = map.get(kind);
        if (!clip) return;
        const action = this.locoMixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        action.setEffectiveWeight(0);
        actions[kind] = action;
      });
      // Fallbacks
      if (!actions.carry && actions.walk) actions.carry = actions.walk;
      if (!actions.sit && actions.idle) actions.sit = actions.idle;
      if (!actions.pickup && actions.idle) actions.pickup = actions.idle;

      if (actions.idle) {
        actions.idle.setEffectiveWeight(1);
      }

      this.kidLoco.set(id, {
        actions,
        mode: 'idle',
        prevPos: new THREE.Vector3(),
        ready: false,
      });
      console.info(`[SimViewer] ${id} actions`, Object.keys(actions));
    }

    console.info('[SimViewer] path clips', pathClips.length, 'dur', this.clipDuration);
  }

  async _load() {
    try {
      const [schedRes, gltf] = await Promise.all([
        fetch(this.scheduleUrl).then((r) => r.json()),
        new GLTFLoader().loadAsync(this.sceneUrl),
      ]);
      this.schedule = schedRes;
      this.meta = schedRes.meta;
      this.fps = this.meta.fps || 24;
      this.dayHour = this.meta.day_start_hour;
      this.kidDefs = schedRes.kids;
      const fph = this.meta.frames_per_hour || 90;
      this.frameStart = 1;
      this.frameEnd = Math.max(2, Math.round((this.meta.day_end_hour - this.meta.day_start_hour) * fph) + 1);

      const root = gltf.scene;
      this._fixMaterials(root);
      this.scene.add(root);
      this._sceneMounted = true;
      this._ensureWell();
      this._setupWater();
      this._setupDirtRoads();

      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      this.controls.target.copy(center).setY(Math.max(1.2, center.y));
      const dist = Math.max(size.x, size.z, size.y) * 0.85;
      this.camera.position.set(center.x - dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.85);

      this.kidRoots = this._findKidRoots(root);
      console.info('[SimViewer] clips', (gltf.animations || []).map((c) => c.name));
      this._setupClips(root, gltf.animations || []);

      this.rings = new Map();
      this.kidDefs.forEach((def) => {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.7, 0.95, 28),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(def.color[0], def.color[1], def.color[2]),
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
        );
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(ring);
        this.rings.set(def.id, ring);
      });

      this.followId = this.kidDefs[0]?.id || null;
      this._applyPathTime(this.dayHour);
      this._placeHut();
      this._seatHangingTrees();
      this._connectRoadToHut();
      this._bindSharedHouse();
      this.kidDefs.forEach((def) => {
        const r = this.kidRoots.get(def.id);
        if (r) this._retargetHome(r, def);
      });
      // Init prev positions after first path scrub
      this.kidDefs.forEach((def) => {
        const r = this.kidRoots.get(def.id);
        const loco = this.kidLoco.get(def.id);
        if (r && loco) {
          r.getWorldPosition(loco.prevPos);
          loco.ready = true;
        }
      });

      if (typeof window !== 'undefined') window.__simViewer = this;

      this.onReady({
        kids: this.kidDefs.map((k) => ({ id: k.id, name: k.name, color: cssColor(k.color) })),
        locations: Object.keys(LOCATION_COORDS),
      });
      this._kickLoop();
    } catch (e) {
      if (!this._loadRetried && !this._sceneMounted) {
        this._loadRetried = true;
        console.warn('[SimViewer] scene load failed, retrying', e);
        return this._load();
      }
      console.error(e);
      this.onReady({ error: e.message || 'Failed to load simulation scene.' });
    }
  }

  _worldPos(obj) {
    const v = new THREE.Vector3();
    obj.updateWorldMatrix(true, false);
    obj.getWorldPosition(v);
    return v;
  }

  _placeHut() {
    let hut = null;
    this.scene.traverse((o) => {
      if (!hut && o.name === 'HUT_Root') hut = o;
    });
    if (!hut) return;
    // The crossing sits on the yard center. Keep the hut on the grass beside it, door toward the road.
    hut.position.set(6.2, hut.position.y, -0.2);
    hut.rotation.y = -Math.PI / 2;
    hut.updateWorldMatrix(true, true);
    this.scene.traverse((o) => {
      if (o.name === 'HOME_Yard') o.visible = false;
    });
  }

  _seatHangingTrees() {
    const groups = [];
    this.scene.traverse((o) => {
      if (/^GreyTree/i.test(o.name || '')) groups.push(o);
    });
    groups.forEach((group) => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.min.y < 0.4) return;
      group.position.y -= box.min.y - 0.05;
      group.updateWorldMatrix(true, true);
    });
  }

  _bindSharedHouse() {
    let door = null;
    this.scene.traverse((o) => {
      if (!door && o.name === 'HUT_Door') door = o;
    });
    const doorPos = door ? this._worldPos(door) : LOCATION_COORDS.Home.clone();
    let hut = null;
    this.scene.traverse((o) => {
      if (!hut && o.name === 'HUT_Root') hut = o;
    });
    const center = hut ? this._worldPos(hut) : doorPos.clone();
    const forward = doorPos.clone().sub(center);
    forward.y = 0;
    if (forward.lengthSq() < 0.01) forward.set(0, 0, 1);
    forward.normalize();
    const side = new THREE.Vector3(-forward.z, 0, forward.x);
    const slots = [0, 1, 2].map((i) => {
      const along = i === 2 ? 2.25 : 1.15;
      const across = i === 0 ? -1.05 : i === 1 ? 1.05 : 0;
      return new THREE.Vector3(
        doorPos.x + forward.x * along + side.x * across,
        0.05,
        doorPos.z + forward.z * along + side.z * across
      );
    });
    this.homeAnchors = new Map();
    this.houseSlots = new Map();
    this.kidDefs.forEach((def, i) => {
      const root = this.kidRoots.get(def.id);
      if (!root) return;
      this.homeAnchors.set(def.id, this._worldPos(root).clone());
      this.houseSlots.set(def.id, slots[i] || slots[0]);
    });
  }

  _retargetHome(root, def) {
    const anchor = this.homeAnchors?.get(def.id);
    const slot = this.houseSlots?.get(def.id);
    if (!anchor || !slot) return;
    const pos = this._worldPos(root);
    const reach = THREE.MathUtils.clamp(anchor.distanceTo(slot) + 1.2, 4, 8);
    const d = Math.hypot(pos.x - anchor.x, pos.z - anchor.z);
    const influence = 1 - THREE.MathUtils.smoothstep(d, 0.8, reach);
    if (influence < 0.001) return;
    const target = new THREE.Vector3(
      THREE.MathUtils.lerp(pos.x, slot.x, influence),
      pos.y,
      THREE.MathUtils.lerp(pos.z, slot.z, influence)
    );
    root.parent.updateWorldMatrix(true, false);
    root.parent.worldToLocal(target);
    root.position.x = target.x;
    root.position.z = target.z;
  }

  _animate = () => {
    this._loopQueued = false;
    this._kickLoop();
    if (this._contextLost) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);

    try {
    if (this.playing && this.meta) {
      this.dayHour += (dt * this.speed * 2.5) / 60;
      if (this.dayHour >= this.meta.day_end_hour) this.dayHour = this.meta.day_start_hour;
    }

    this._applyPathTime(this.dayHour);
    this.kidDefs.forEach((def) => {
      const root = this.kidRoots.get(def.id);
      if (root) this._retargetHome(root, def);
    });

    // Soft separation so kids don't fuse when paths overlap
    const roots = this.kidDefs
      .map((def) => this.kidRoots.get(def.id))
      .filter(Boolean);
    for (let i = 0; i < roots.length; i++) {
      for (let j = i + 1; j < roots.length; j++) {
        const a = roots[i];
        const b = roots[j];
        const dx = a.position.x - b.position.x;
        const dz = a.position.z - b.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-4) {
          a.position.x += MIN_SEPARATION * 0.5;
          b.position.x -= MIN_SEPARATION * 0.5;
          continue;
        }
        if (dist < MIN_SEPARATION) {
          const push = (MIN_SEPARATION - dist) * 0.5;
          const nx = dx / dist;
          const nz = dz / dist;
          a.position.x += nx * push;
          a.position.z += nz * push;
          b.position.x -= nx * push;
          b.position.z -= nz * push;
        }
      }
    }

    const states = [];
    this.kidDefs.forEach((def) => {
      const act = this._activityAt(def, this.dayHour);
      const mode = activityMode(act.activity, act.type);
      const traveling = mode === 'walk' || mode === 'carry';
      const root = this.kidRoots.get(def.id);
      const loco = this.kidLoco.get(def.id);
      const pos = root ? this._worldPos(root) : (LOCATION_COORDS[act.location] || LOCATION_COORDS.Home).clone();

      if (loco && root) {
        this._setLocoMode(loco, mode);

        // Velocity-matched walk/carry; other actions play at natural 1x
        Object.entries(loco.actions).forEach(([kind, action]) => {
          if (!action) return;
          const active = kind === loco.mode;
          action.setEffectiveWeight(active ? 1 : 0);
          if (!active) {
            action.setEffectiveTimeScale(0);
            return;
          }
          if ((kind === 'walk' || kind === 'carry') && loco.ready && dt > 1e-4) {
            const moved = pos.distanceTo(loco.prevPos);
            const speedMps = moved / dt;
            const cyclesPerSec = speedMps / STRIDE_M;
            const cycleDur = action.getClip().duration || 1.25;
            const timeScale = THREE.MathUtils.clamp(cyclesPerSec * cycleDur, 0.35, 2.8);
            action.setEffectiveTimeScale(timeScale);
          } else {
            action.setEffectiveTimeScale(1);
          }
        });

        loco.prevPos.copy(pos);
        loco.ready = true;
      }

      const ring = this.rings?.get(def.id);
      if (ring) ring.position.set(pos.x, 0.08, pos.z);

      states.push({
        id: def.id,
        name: def.name,
        color: cssColor(def.color),
        activity: act.activity,
        location: act.location,
        traveling,
        mode,
        position: pos,
      });
    });

    if (this.locoMixer) this.locoMixer.update(dt);

    const t = THREE.MathUtils.clamp((this.dayHour - 6) / 14, 0, 1);
    const ang = t * Math.PI;
    this.sun.position.set(Math.cos(ang) * 40, Math.sin(ang) * 40 + 6, 18);
    this.sun.intensity = 0.9 + Math.sin(ang) * 0.7;
    const dusk = this.dayHour > 17.5;
    this.scene.background.set(dusk ? 0xb48a68 : 0xb9d4ea);
    this.scene.fog.color.copy(this.scene.background);

    if (this.followId && !this.freeLook) {
      const st = states.find((s) => s.id === this.followId);
      if (st?.position) {
        const desired = st.position.clone().add(new THREE.Vector3(-7, 8, 9));
        this.camera.position.lerp(desired, 0.045);
        this.controls.target.lerp(st.position.clone().setY(1.4), 0.07);
      }
    }

    if (this.waterMats) {
      const time = this.clock.elapsedTime;
      const sun = this.sun.position;
      this.waterMats.forEach((mat) => {
        mat.uniforms.uTime.value = time;
        mat.uniforms.uSun.value.set(sun.x, sun.y, sun.z).normalize();
      });
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    const start = this.meta?.day_start_hour ?? 6;
    const end = this.meta?.day_end_hour ?? 20;
    this.onTick({
      hour: this.dayHour,
      clock: formatClock(this.dayHour),
      playing: this.playing,
      followId: this.followId,
      kids: states,
      progress: (this.dayHour - start) / (end - start),
    });
    } catch (err) {
      const gl = this.renderer.getContext();
      if (gl && gl.isContextLost()) this._contextLost = true;
      else console.error(err);
    }
  };

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w < 2 || h < 2) return;
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setPlaying(v) { this.playing = !!v; }
  togglePlay() { this.playing = !this.playing; return this.playing; }
  setSpeed(s) { this.speed = s; }

  setProgress(p) {
    if (!this.meta) return;
    const start = this.meta.day_start_hour;
    const end = this.meta.day_end_hour;
    this.dayHour = start + THREE.MathUtils.clamp(p, 0, 1) * (end - start);
    this._applyPathTime(this.dayHour);
    this.kidDefs.forEach((def) => {
      const r = this.kidRoots.get(def.id);
      const loco = this.kidLoco.get(def.id);
      if (r && loco) r.getWorldPosition(loco.prevPos);
    });
  }

  follow(id) {
    this.followId = id;
    this.freeLook = false;
  }
  clearFollow() {
    this.followId = null;
    this.freeLook = true;
  }

  jumpToLocation(name) {
    const co = LOCATION_COORDS[name];
    if (!co) return;
    this.followId = null;
    this.freeLook = true;
    this.controls.target.set(co.x, 1.5, co.z);
    this.camera.position.set(co.x - 12, 14, co.z + 14);
  }

  nudgeView(yaw, pitch) {
    this.freeLook = true;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += yaw;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + pitch, 0.2, Math.PI * 0.48);
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  zoomBy(scale) {
    this.freeLook = true;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = THREE.MathUtils.clamp(
      offset.length() * scale,
      this.controls.minDistance,
      this.controls.maxDistance
    );
    offset.setLength(dist);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }
}
