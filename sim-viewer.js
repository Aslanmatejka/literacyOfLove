/**
 * Literacy of Love — Blender sim viewer
 * Paths scrub with the day timeline; Walk/Idle play in real-time
 * at a rate matched to each kid's travel speed (no foot-slide).
 *
 * The whole village is always in play: the camera orbits freely (drag,
 * scroll/pinch, right-drag), drifts slowly around the village when idle,
 * and the sky, sun and shadows follow the time of day.
 */
import * as THREE from './vendor/three-r170/three.module.min.js';
import { OrbitControls } from './vendor/three-r170/addons/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/three-r170/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from './vendor/three-r170/addons/utils/BufferGeometryUtils.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/three-r170/addons/renderers/CSS2DRenderer.js';
import { buildCountryside } from './sim-countryside.js';

const SCENE_URL = 'simulation/web/assets/scene.glb';
const SCHEDULE_URL = 'simulation/web/schedule.json';

/** Idle time before the camera starts its slow drift around the village */
const IDLE_ORBIT_MS = 8000;
const PLACE_ICONS = {
  Home: 'fa-house', School: 'fa-book-open', Farm: 'fa-seedling',
  Shops: 'fa-store', Wood: 'fa-tree', Well: 'fa-tint',
};

/**
 * Time-of-day lighting keyframes (sRGB hex). Everything between two keys is
 * blended, so dawn → noon → sunset changes smoothly instead of switching.
 */
const DAY_KEYS = [
  { h: 6.0, top: 0x4a64a0, horizon: 0xf3c29a, sun: 0xffb985, sunI: 1.2, sky: 0xc6d0e8, ground: 0x6a6a4e, hemiI: 0.95 },
  { h: 7.5, top: 0x5f93d8, horizon: 0xf3dcbc, sun: 0xffdcb0, sunI: 1.5, sky: 0xd3e2f3, ground: 0x6c7a4c, hemiI: 0.82 },
  { h: 10.0, top: 0x4f93e4, horizon: 0xd3e8f7, sun: 0xfff3e0, sunI: 1.85, sky: 0xe0eefa, ground: 0x7b8d55, hemiI: 0.9 },
  { h: 15.5, top: 0x4f93e4, horizon: 0xd3e8f7, sun: 0xfff3e0, sunI: 1.85, sky: 0xe0eefa, ground: 0x7b8d55, hemiI: 0.9 },
  { h: 17.8, top: 0x5a86cb, horizon: 0xf4d8aa, sun: 0xffcf8c, sunI: 1.5, sky: 0xe4ddd0, ground: 0x786f4c, hemiI: 0.82 },
  { h: 19.2, top: 0x485896, horizon: 0xf2a676, sun: 0xff9a62, sunI: 1.1, sky: 0xc9bac6, ground: 0x655844, hemiI: 0.82 },
  { h: 20.0, top: 0x313c6c, horizon: 0xd8907c, sun: 0xff875e, sunI: 0.85, sky: 0xaaa5c0, ground: 0x544c3c, hemiI: 0.72 },
].map((k) => ({
  h: k.h,
  top: new THREE.Color(k.top),
  horizon: new THREE.Color(k.horizon),
  sun: new THREE.Color(k.sun),
  sky: new THREE.Color(k.sky),
  ground: new THREE.Color(k.ground),
  sunI: k.sunI,
  hemiI: k.hemiI,
}));

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
  // Round to whole minutes first so 6:59.7 carries to 7:00 (not 6:00)
  const total = Math.round(hour * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
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
    /** (fraction 0–1, stage) while the scene downloads; stage 'building' once it's in */
    this.onProgress = opts.onProgress || (() => {});

    this.playing = true;
    this.speed = 1;
    this.dayHour = 6;
    /** Kid whose name tag is emphasised (no camera lock — the view stays free) */
    this.highlightId = null;
    this.labelsVisible = true;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /** Phones / low-power devices get a lighter countryside */
    this.lite = window.matchMedia('(max-width: 700px)').matches || (navigator.hardwareConcurrency || 8) <= 4;
    this.onInteract = opts.onInteract || (() => {});
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

    this.camera = new THREE.PerspectiveCamera(40, rect.width / Math.max(rect.height, 1), 0.5, 1200);
    this.camera.position.set(-40, 48, 62);

    // Free orbit from any angle: drag = rotate 360°, scroll/pinch = zoom,
    // right-drag/two fingers = pan along the ground. Arrow keys pan,
    // Shift+arrows rotate, +/- zoom (canvas must have focus).
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.screenSpacePanning = false;
    this.controls.minPolarAngle = 0.02;
    this.controls.maxPolarAngle = Math.PI * 0.47; // down to just above the grass
    this.controls.minDistance = 6;
    this.controls.maxDistance = 150;
    this.controls.autoRotateSpeed = 0.45; // ~2 minutes per lap
    this.controls.target.set(3, 1, -1.5);
    this.controls.listenToKeyEvents(this.canvas);

    this._lastInteraction = performance.now();
    const viewport = this.canvas.parentElement;
    this.controls.addEventListener('start', () => {
      this._interacting = true;
      this._tween = null;
      this.controls.autoRotate = false;
      this._lastInteraction = performance.now();
      viewport.classList.add('is-dragging');
      this.onInteract();
    });
    this.controls.addEventListener('end', () => {
      this._interacting = false;
      this._lastInteraction = performance.now();
      viewport.classList.remove('is-dragging');
    });
    this.canvas.addEventListener('keydown', (event) => {
      this._lastInteraction = performance.now();
      this.controls.autoRotate = false;
      if (event.key === '+' || event.key === '=') { this.zoomBy(0.85); event.preventDefault(); }
      else if (event.key === '-' || event.key === '_') { this.zoomBy(1.18); event.preventDefault(); }
      this.onInteract();
    });

    // Floating name tags / place names, drawn as HTML over the canvas
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'sim3d-labels';
    this.labelRenderer.setSize(rect.width, rect.height);
    viewport.appendChild(this.labelRenderer.domElement);

    window.addEventListener('resize', () => this.resize());
    this._bindDisplayRecovery();
  }

  _bindDisplayRecovery() {
    const parent = this.canvas.parentElement;
    if (parent && typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(parent);
    }

    // Stop rendering while the 3D view is scrolled out of sight (e.g. while
    // watching the videos further down the page); resume when it returns.
    if (parent && typeof IntersectionObserver !== 'undefined') {
      this._visibilityObserver = new IntersectionObserver((entries) => {
        const onScreen = entries[entries.length - 1].isIntersecting;
        this._offscreen = !onScreen;
        if (onScreen) {
          this.clock.getDelta(); // don't count the time spent off-screen
          this._kickLoop();
        }
      }, { rootMargin: '150px 0px' });
      this._visibilityObserver.observe(parent);
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
    if (this._loopQueued || this._offscreen) return;
    this._loopQueued = true;
    this._raf = requestAnimationFrame(this._animate);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    // Fog fades the far grass into the horizon colour, so there is no visible edge
    this.scene.fog = new THREE.Fog(0xd3e8f7, 90, 380);
    this._initSky();
    this._initGround();
  }

  /** Gradient sky dome with a soft sun glow; colours follow the time of day. */
  _initSky() {
    this.skyUniforms = {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float up = clamp(d.y, 0.0, 1.0);
            vec3 col = mix(uHorizon, uTop, pow(up, 0.5));
            float s = max(dot(d, normalize(uSunDir)), 0.0);
            col += uSunColor * (pow(s, 900.0) * 2.0 + pow(s, 14.0) * 0.32);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      })
    );
    sky.name = 'ENV_Sky';
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);
  }

  /** Grass that runs out to the horizon (the Blender ground stops at ±40 m). */
  _initGround() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const g = canvas.getContext('2d');
    g.fillStyle = '#6f9a48';
    g.fillRect(0, 0, 256, 256);
    const blotch = (count, rMin, rMax, colors, alpha) => {
      for (let i = 0; i < count; i += 1) {
        const x = Math.random() * 256;
        const y = Math.random() * 256;
        const r = rMin + Math.random() * (rMax - rMin);
        g.globalAlpha = alpha * (0.5 + Math.random() * 0.5);
        g.fillStyle = colors[i % colors.length];
        // draw wrapped so the tile repeats seamlessly
        for (const ox of [-256, 0, 256]) {
          for (const oy of [-256, 0, 256]) {
            g.beginPath();
            g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    };
    blotch(60, 14, 34, ['#5f8c3d', '#7da653', '#86a856'], 0.28);
    blotch(500, 1, 3, ['#4f7a32', '#8db35e', '#a3b86a', '#5c8a3a'], 0.55);
    g.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.repeat.set(170, 170); // ~7 m per tile on the 1.2 km disc
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
    // Blend in a second, much larger sample of the same tile to hide repetition
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 grassA = texture2D(map, vMapUv);
          vec4 grassB = texture2D(map, vMapUv * 0.083 + vec2(0.37, 0.11));
          diffuseColor *= mix(grassA, grassB, 0.45);
        #endif
      `);
    };
    const ground = new THREE.Mesh(new THREE.CircleGeometry(600, 96), mat);
    ground.name = 'ENV_Grass';
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  _initLights() {
    this.hemi = new THREE.HemisphereLight(0xe0eefa, 0x7b8d55, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff3e0, 1.85);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 5;
    this.sun.shadow.camera.far = 200;
    this.sun.shadow.camera.left = -42;
    this.sun.shadow.camera.right = 42;
    this.sun.shadow.camera.top = 42;
    this.sun.shadow.camera.bottom = -42;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.villageCenter = new THREE.Vector3(3, 0, -1.5);
    this._updateDaylight(this.dayHour);
  }

  /** Sun path, sun colour, sky and fog for a given hour (6 AM–8 PM). */
  _updateDaylight(hour) {
    let i = 0;
    while (i < DAY_KEYS.length - 2 && hour > DAY_KEYS[i + 1].h) i += 1;
    const a = DAY_KEYS[i];
    const b = DAY_KEYS[i + 1];
    const t = THREE.MathUtils.clamp((hour - a.h) / (b.h - a.h), 0, 1);

    const u = this.skyUniforms;
    u.uTop.value.lerpColors(a.top, b.top, t);
    u.uHorizon.value.lerpColors(a.horizon, b.horizon, t);
    u.uSunColor.value.lerpColors(a.sun, b.sun, t);
    this.scene.fog.color.copy(u.uHorizon.value);
    this.sun.color.copy(u.uSunColor.value);
    this.sun.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, t);
    this.hemi.color.lerpColors(a.sky, b.sky, t);
    this.hemi.groundColor.lerpColors(a.ground, b.ground, t);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemiI, b.hemiI, t);

    // Rises in the east (+x), arcs high overhead (near the equator), sets west
    const p = THREE.MathUtils.clamp((hour - 5.7) / 14.6, 0, 1);
    // (kept at least 12° up so early/late light still reaches the ground)
    const elevation = Math.max(THREE.MathUtils.degToRad(12), Math.sin(Math.PI * p) * THREE.MathUtils.degToRad(70));
    const dir = this._tmp.set(Math.cos(Math.PI * p), 0, 0.42).normalize()
      .multiplyScalar(Math.cos(elevation));
    dir.y = Math.sin(elevation);
    u.uSunDir.value.copy(dir);
    this.sun.target.position.copy(this.villageCenter);
    this.sun.position.copy(this.villageCenter).addScaledVector(dir, 90);
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
        uSky: { value: new THREE.Color(0.84, 0.93, 0.97) }, // reflected sky, follows time of day
        uLight: { value: 1 }, // dims the water at dawn and dusk
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
        uniform vec3 uSky;
        uniform float uLight;
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
          vec3 sky = uSky;
          vec3 col = mix(water, water * 1.35, rush * 0.45);
          col = mix(col, sky, fres * 0.65);
          col += spec * vec3(0.95, 0.98, 1.0) * 0.5;
          gl_FragColor = vec4(col * uLight, 0.8);
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
    g.fillStyle = '#9a7a52';
    g.fillRect(0, 0, 256, 128);
    for (let i = 0; i < 2200; i += 1) {
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      const shade = 70 + Math.random() * 90;
      g.fillStyle = `rgba(${shade + 30}, ${Math.floor(shade * 0.72)}, ${Math.floor(shade * 0.42)}, 0.45)`;
      g.fillRect(x, y, 2 + Math.random() * 2, 2);
    }
    // Two faint foot-worn tracks
    g.fillStyle = 'rgba(70, 48, 28, 0.16)';
    g.fillRect(0, 36, 256, 12);
    g.fillRect(0, 80, 256, 12);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this._dirtMap = tex;
    return tex;
  }

  /** Alpha across the road's width: solid in the middle, feathered into the grass. */
  _roadEdgeAlpha() {
    if (this._roadAlpha) return this._roadAlpha;
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 64;
    const g = canvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#000');
    grad.addColorStop(0.24, '#fff');
    grad.addColorStop(0.76, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this._roadAlpha = tex;
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
    // Out-and-back routes are exported side by side (~1–1.5 m apart); draw them
    // as one footpath instead of a double lane.
    return sum / n < 1.7;
  }

  _addDirtRoad(points, index) {
    const route = this._filletRoute(points);
    const half = 0.95; // includes the feathered edge
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
    // One shared material so all roads can be merged into a single draw call
    if (!this._dirtRoadMat) {
      this._dirtRoadMat = new THREE.MeshStandardMaterial({
        map: this._dirtTexture(),
        alphaMap: this._roadEdgeAlpha(),
        transparent: true,
        opacity: 0.9, // worn footpaths, not painted stripes
        depthWrite: false,
        roughness: 0.96,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
    }
    const mesh = new THREE.Mesh(geo, this._dirtRoadMat);
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

  /**
   * Bake every static mesh into one mesh per material. The village is ~500
   * separate meshes (the farm alone is 370+), and each one costs a draw call
   * in both the camera pass and the shadow pass, every frame. After merging
   * it is a few dozen. Run once, after all setup that moves, hides or
   * re-materials objects. The animated kids are left alone.
   */
  _mergeStatic(root) {
    this.scene.updateMatrixWorld(true);
    const skip = new Set(this.kidRoots.values());
    const candidates = [];
    const visit = (obj, parentVisible) => {
      if (skip.has(obj)) return; // animated subtree
      const visible = parentVisible && obj.visible;
      if (visible && SimViewer._isMergeable(obj)) candidates.push(obj);
      obj.children.forEach((child) => visit(child, visible));
    };
    visit(root, true);
    this.scene.children
      .filter((o) => /^DIRT_Road_/.test(o.name))
      .forEach((o) => visit(o, true));

    const groups = new Map();
    candidates.forEach((mesh) => {
      const geo = mesh.geometry;
      const layout = Object.keys(geo.attributes).sort().map((name) => {
        const a = geo.attributes[name];
        return `${name}:${a.itemSize}:${a.array.constructor.name}:${a.normalized}`;
      }).join(',');
      const key = [mesh.material.uuid, mesh.castShadow, mesh.receiveShadow, mesh.renderOrder, !!geo.index, layout].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(mesh);
    });

    let before = 0;
    let after = 0;
    groups.forEach((meshes) => {
      before += meshes.length;
      if (meshes.length < 2) { after += meshes.length; return; }
      const geos = meshes.map((mesh) => {
        const g = mesh.geometry.clone();
        g.applyMatrix4(mesh.matrixWorld);
        // A mirrored transform reverses triangle winding once baked in; flip it back
        if (mesh.matrixWorld.determinant() < 0) SimViewer._flipWinding(g);
        return g;
      });
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) { after += meshes.length; return; } // incompatible — keep originals
      merged.computeBoundingSphere();
      const first = meshes[0];
      const mesh = new THREE.Mesh(merged, first.material);
      mesh.name = `STATIC_${first.material.name || first.name}`;
      mesh.castShadow = first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.renderOrder = first.renderOrder;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      after += 1;
      meshes.forEach((m) => {
        // Leaf meshes can go; a mesh with children just stops drawing itself
        if (m.children.length === 0) m.removeFromParent();
        else m.layers.disableAll();
      });
    });
    console.info(`[SimViewer] static meshes: ${before} -> ${after} draw calls`);
  }

  static _isMergeable(obj) {
    if (!obj.isMesh || obj.isSkinnedMesh || obj.isInstancedMesh) return false;
    if (Array.isArray(obj.material) || !obj.material || obj.material.isShaderMaterial) return false;
    const geo = obj.geometry;
    if (!geo || !geo.attributes.position) return false;
    if (Object.keys(geo.morphAttributes).length) return false;
    if (geo.drawRange.start !== 0 || geo.drawRange.count !== Infinity) return false;
    return Object.values(geo.attributes).every((a) => !a.isInterleavedBufferAttribute);
  }

  static _flipWinding(geo) {
    if (geo.index) {
      const a = geo.index.array;
      for (let i = 0; i + 2 < a.length; i += 3) {
        const t = a[i + 1];
        a[i + 1] = a[i + 2];
        a[i + 2] = t;
      }
      return;
    }
    Object.values(geo.attributes).forEach((attr) => {
      const n = attr.itemSize;
      const arr = attr.array;
      for (let v = 0; v + 2 < attr.count; v += 3) {
        for (let k = 0; k < n; k += 1) {
          const i1 = (v + 1) * n + k;
          const i2 = (v + 2) * n + k;
          const t = arr[i1];
          arr[i1] = arr[i2];
          arr[i2] = t;
        }
      }
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

  /**
   * Download the village scene. A gzipped copy (scene.glb.gz, ~2 MB instead
   * of ~8 MB) is unpacked in the browser; if anything about that fails (an
   * older browser, a proxy that already unpacked it, a network error) the
   * plain scene.glb is loaded instead.
   */
  async _fetchScene() {
    const loader = new GLTFLoader();
    const base = this.sceneUrl.slice(0, this.sceneUrl.lastIndexOf('/') + 1);
    if (typeof DecompressionStream === 'function' && !this._skipGzip) {
      try {
        const res = await fetch(`${this.sceneUrl}.gz`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        let bytes;
        if (res.body && total) {
          const reader = res.body.getReader();
          const chunks = [];
          let loaded = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            this.onProgress(Math.min(1, loaded / total));
          }
          bytes = new Uint8Array(loaded);
          let at = 0;
          chunks.forEach((c) => { bytes.set(c, at); at += c.byteLength; });
        } else {
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        let data = bytes.buffer;
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) { // gzip: unpack it here
          data = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        }
        return await loader.parseAsync(data, base);
      } catch (err) {
        console.warn('[SimViewer] compressed scene unavailable, loading the plain file', err);
      }
    }
    return loader.loadAsync(this.sceneUrl, (e) => {
      if (e.lengthComputable && e.total) this.onProgress(Math.min(1, e.loaded / e.total));
    });
  }

  /** Optional extras must never take the village down with them. */
  _safely(label, fn) {
    try {
      return fn();
    } catch (err) {
      console.warn(`[SimViewer] ${label} skipped`, err);
      return null;
    }
  }

  async _load() {
    try {
      const [schedRes, gltf] = await Promise.all([
        fetch(this.scheduleUrl).then((r) => {
          if (!r.ok) throw new Error(`Schedule failed to load (HTTP ${r.status})`);
          return r.json();
        }),
        this._fetchScene(),
      ]);
      this.onProgress(1, 'building');
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
      // The Blender ground is an 80 m square whose edge shows from low angles;
      // the endless grass from _initGround replaces it.
      root.traverse((o) => { if (o.name === 'ENV_Ground') o.visible = false; });

      this.kidRoots = this._findKidRoots(root);
      console.info('[SimViewer] clips', (gltf.animations || []).map((c) => c.name));
      this._setupClips(root, gltf.animations || []);

      this.rings = new Map();
      this.kidDefs.forEach((def) => {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.62, 0.9, 32),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color(def.color[0], def.color[1], def.color[2]),
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.renderOrder = 3; // above the (transparent) dirt roads
        this.scene.add(ring);
        this.rings.set(def.id, ring);
      });

      this._applyPathTime(this.dayHour);
      this._placeHut();
      this._seatHangingTrees();
      this._connectRoadToHut();
      this._bindSharedHouse();
      this.kidDefs.forEach((def) => {
        const r = this.kidRoots.get(def.id);
        if (r) this._retargetHome(r, def);
      });
      // Measure places and copy the hut/tree models before merging
      // (merging empties the LOC_* groups)
      const places = this._measurePlaces(root);
      const props = this._safely('copying the hut and tree models', () => this._captureProps(root));
      this._safely('merging static meshes', () => this._mergeStatic(root));
      this._safely('labels', () => this._buildLabels(places));
      if (props && props.hut) {
        // Roads, homesteads, farms, forests, swamps and animals around the village
        const t0 = performance.now();
        this.countryside = this._safely('countryside', () => buildCountryside({
          scene: this.scene,
          center: this.villageCenter,
          roadRoutes: this.roadRoutes,
          places,
          props,
          lite: this.lite,
        }));
        if (this.countryside) {
          console.info(`[SimViewer] countryside built in ${Math.round(performance.now() - t0)} ms`, JSON.stringify(this.countryside.stats));
        }
      }
      this._frameVillage(true);
      this._updateDaylight(this.dayHour);
      // Start the slow drift around the village a few seconds after loading
      this._lastInteraction = performance.now() - IDLE_ORBIT_MS + 3500;
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
        this._skipGzip = true; // second try: the plain file
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

  /** Visible bounds of each LOC_* place (for its label) and of the whole village. */
  _measurePlaces(root) {
    root.updateMatrixWorld(true);
    const village = new THREE.Box3();
    const meshBox = new THREE.Box3();
    const places = [];
    let hut = null;
    root.traverse((o) => { if (!hut && o.name === 'HUT_Root') hut = o; });
    root.children.forEach((loc) => {
      const m = /^LOC_(\w+)/.exec(loc.name || '');
      if (!m) return;
      const box = new THREE.Box3();
      loc.traverseVisible((o) => { if (o.isMesh) box.union(meshBox.setFromObject(o)); });
      const name = m[1];
      // Label sits over the spot the kids actually walk to (Home = the hut);
      // some LOC groups hold scattered props that would skew a bounds centre.
      const spot = name === 'Home' && hut ? this._worldPos(hut) : LOCATION_COORDS[name];
      const top = box.isEmpty() ? 0.5 : box.max.y;
      const anchor = (spot ? spot.clone() : box.getCenter(new THREE.Vector3()))
        .setY(THREE.MathUtils.clamp(top + 1.1, 1.6, 5));
      if (!box.isEmpty()) village.union(box);
      places.push({ name, anchor });
    });
    // Roads and the stream are part of the village too
    this.scene.children.forEach((o) => {
      if (o.visible && /^(DIRT_Road_|WELL_WaterSurface)/.test(o.name)) village.union(meshBox.setFromObject(o));
    });
    if (village.isEmpty()) village.setFromCenterAndSize(new THREE.Vector3(3, 1, -1.5), new THREE.Vector3(56, 3, 48));
    this.villageBox = village;
    this.villageCenter.copy(village.getCenter(new THREE.Vector3())).setY(0);
    return places;
  }

  /** Name tags that ride above each kid, and quiet labels over each place. */
  _buildLabels(places) {
    this.placeLabels = places.map(({ name, anchor }) => {
      const el = document.createElement('div');
      el.className = 'sim3d-place-tag';
      const icon = document.createElement('i');
      icon.className = `fas ${PLACE_ICONS[name] || 'fa-map-pin'}`;
      icon.setAttribute('aria-hidden', 'true');
      el.append(icon, document.createTextNode(` ${name}`));
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1);
      obj.position.copy(anchor);
      this.scene.add(obj);
      return obj;
    });
    this.kidTags = new Map();
    this.kidDefs.forEach((def) => {
      const el = document.createElement('div');
      el.className = 'sim3d-tag';
      el.style.setProperty('--kc', cssColor(def.color));
      const dot = document.createElement('span');
      dot.className = 'sim3d-tag__dot';
      const name = document.createElement('span');
      name.className = 'sim3d-tag__name';
      name.textContent = def.name;
      const act = document.createElement('span');
      act.className = 'sim3d-tag__act';
      el.append(dot, name, act);
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1);
      this.scene.add(obj);
      this.kidTags.set(def.id, { obj, el, act, text: '' });
    });
  }

  /** Camera pose that fits the whole village from a three-quarter angle. */
  _homeView() {
    const box = this.villageBox;
    const target = box.getCenter(new THREE.Vector3()).setY(0.8);
    const size = box.getSize(new THREE.Vector3());
    const radius = 0.5 * Math.hypot(size.x, size.z);
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    // Portrait screens need a little more room so the slow orbit never crops a place
    const fit = this.camera.aspect < 1 ? 0.92 : 0.6;
    const dist = (radius * fit) / Math.sin(Math.min(vfov, hfov) / 2);
    const elev = THREE.MathUtils.degToRad(46);
    const az = THREE.MathUtils.degToRad(-32);
    const pos = new THREE.Vector3(
      Math.sin(az) * Math.cos(elev),
      Math.sin(elev),
      Math.cos(az) * Math.cos(elev)
    ).multiplyScalar(dist).add(target);
    return { pos, target, dist };
  }

  _frameVillage(instant) {
    if (!this.villageBox) return;
    const home = this._homeView();
    this.controls.maxDistance = Math.max(150, home.dist * 1.5);
    if (instant || this.reduceMotion) {
      this._tween = null;
      this.camera.position.copy(home.pos);
      this.controls.target.copy(home.target);
      this.controls.update();
      return;
    }
    this._tween = {
      t: 0,
      start: performance.now(),
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos: home.pos,
      toTarget: home.target,
    };
  }

  /**
   * When kids stand together their tags would sit on top of each other;
   * lift overlapping tags so every name stays readable.
   */
  _stackTags() {
    if (!this.kidTags) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const toScreen = (pos) => {
      const p = this._tmp.copy(pos).project(this.camera);
      return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
    };
    const items = [];
    this.kidTags.forEach((tag) => {
      const s = toScreen(tag.obj.position);
      items.push({ tag, x: s.x, y: s.y, top: 0 });
    });
    items.sort((a, b) => b.y - a.y); // lowest tag keeps its place
    const placed = [];
    items.forEach((it) => {
      it.top = it.y;
      for (let pass = 0; pass < 3; pass += 1) {
        placed.forEach((o) => {
          if (Math.abs(o.x - it.x) < 96 && Math.abs(o.top - it.top) < 26) it.top = o.top - 26;
        });
      }
      placed.push(it);
      const lift = Math.round(it.y - it.top);
      if (it.tag.lift !== lift) {
        it.tag.lift = lift;
        it.tag.el.style.translate = lift ? `0 ${-lift}px` : '';
      }
    });
    // A place name hidden under a child's tag fades out of the way
    (this.placeLabels || []).forEach((label) => {
      const s = toScreen(label.position);
      const covered = placed.some((o) => Math.abs(o.x - s.x) < 90 && Math.abs(o.top - s.y) < 24);
      if (label.userData.covered !== covered) {
        label.userData.covered = covered;
        label.element.classList.toggle('is-covered', covered);
      }
    });
  }

  /** Keep the orbit centre over the village so it can't be panned away. */
  _clampTarget() {
    const b = this.villageBox;
    if (!b) return;
    const t = this.controls.target;
    // (a little beyond the village so the neighbouring homesteads can be visited)
    const x = THREE.MathUtils.clamp(t.x, b.min.x - 16, b.max.x + 16);
    const y = THREE.MathUtils.clamp(t.y, 0, 6);
    const z = THREE.MathUtils.clamp(t.z, b.min.z - 16, b.max.z + 16);
    if (x !== t.x || y !== t.y || z !== t.z) {
      const shift = this._tmp.set(x - t.x, y - t.y, z - t.z);
      t.add(shift);
      this.camera.position.add(shift);
    }
  }

  /**
   * Copy the hut and a tree out of the Blender scene so they can be repeated
   * across the countryside, and note what new homesteads must keep clear of.
   */
  _captureProps(root) {
    root.updateMatrixWorld(true);
    const props = {
      hut: this._captureModel(root.getObjectByName('HUT_Root')),
      tree: this._captureModel(root.getObjectByName('Normal_tree')),
      obstacles: [],
      water: null,
    };
    if (props.hut) {
      // Which way the hut's door faces, so copies can open onto their yard
      const door = props.hut.parts.find((p) => /door|wood/i.test(p.name));
      const c = door ? door.geometry.boundingSphere.center : new THREE.Vector3(0, 0, 1);
      props.hut.doorAngle = Math.atan2(c.x, c.z);
    }
    root.traverse((o) => {
      if (/^(Normal_tree|GreyTree|Cylinder)/.test(o.name || '')) {
        const p = o.getWorldPosition(new THREE.Vector3());
        props.obstacles.push({ x: p.x, z: p.z, r: 5 });
      }
    });
    const water = this.scene.getObjectByName('WELL_WaterSurface');
    if (water) props.water = new THREE.Box3().setFromObject(water);
    return props;
  }

  /** Meshes of one object, baked around its ground point (for instancing). */
  _captureModel(obj) {
    if (!obj) return null;
    const meshes = [];
    const box = new THREE.Box3();
    obj.traverseVisible((o) => {
      if (o.isMesh && !o.isSkinnedMesh && o.geometry && !Array.isArray(o.material)) {
        meshes.push(o);
        box.union(new THREE.Box3().setFromObject(o));
      }
    });
    if (!meshes.length) return null;
    const origin = obj.getWorldPosition(new THREE.Vector3());
    origin.y = box.min.y;
    const toLocal = new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z);
    const parts = meshes.map((m) => {
      const g = m.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, m.matrixWorld));
      if (m.matrixWorld.determinant() < 0) SimViewer._flipWinding(g);
      g.computeBoundingSphere();
      return { geometry: g, material: m.material, name: `${m.name} ${m.material.name || ''}` };
    });
    return { parts };
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

      // Ground ring pulses gently; the highlighted kid's ring is bigger and brighter
      const lit = this.highlightId === def.id;
      const ring = this.rings?.get(def.id);
      if (ring) {
        const pulse = this.reduceMotion ? 1 : 1 + 0.1 * Math.sin(this.clock.elapsedTime * 2.6 + def.color[0] * 9);
        ring.position.set(pos.x, 0.13, pos.z);
        ring.scale.setScalar((lit ? 1.45 : 1) * pulse);
        ring.material.opacity = this.highlightId && !lit ? 0.45 : 0.92;
      }
      const tag = this.kidTags?.get(def.id);
      if (tag) {
        tag.obj.position.set(pos.x, pos.y + 1.95, pos.z);
        if (tag.text !== act.activity) {
          tag.text = act.activity;
          tag.act.textContent = act.activity;
        }
        tag.el.classList.toggle('is-active', lit);
        tag.el.classList.toggle('is-dim', !!this.highlightId && !lit);
      }

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

    this._updateDaylight(this.dayHour);
    // Animals keep living at a calm pace (frozen while paused)
    if (this.countryside) this.countryside.update(this.playing ? dt * Math.min(this.speed, 2) : 0);

    if (this.waterMats) {
      const time = this.clock.elapsedTime;
      const light = THREE.MathUtils.clamp(this.sun.intensity / 3.7 + this.hemi.intensity / 1.8, 0.45, 1);
      this.waterMats.forEach((mat) => {
        mat.uniforms.uTime.value = time;
        mat.uniforms.uSun.value.copy(this.skyUniforms.uSunDir.value);
        mat.uniforms.uSky.value.copy(this.skyUniforms.uHorizon.value).convertLinearToSRGB();
        mat.uniforms.uLight.value = light;
      });
    }

    // Camera: "reset view" glide, then free orbit with a slow idle drift
    const now = performance.now();
    if (this._tween) {
      const tw = this._tween;
      // Timed by the wall clock so the glide takes ~1.1 s even on slow devices
      tw.t = Math.min(1, (now - tw.start) / 1100);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - ((-2 * tw.t + 2) ** 3) / 2;
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      if (tw.t >= 1) {
        this._tween = null;
        this._lastInteraction = now;
      }
    }
    if (!this.reduceMotion && !this._interacting && !this._tween && now - this._lastInteraction > IDLE_ORBIT_MS) {
      this.controls.autoRotate = true;
    }
    this.controls.update(dt);
    this._clampTarget();
    this.sky.position.copy(this.camera.position);

    this.renderer.render(this.scene, this.camera);
    if (this.labelsVisible) {
      this._stackTags();
      this.labelRenderer.render(this.scene, this.camera);
    }

    const start = this.meta?.day_start_hour ?? 6;
    const end = this.meta?.day_end_hour ?? 20;
    this.onTick({
      hour: this.dayHour,
      clock: formatClock(this.dayHour),
      playing: this.playing,
      highlightId: this.highlightId,
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
    // Seen from above, the near half of the village looks bigger, so sit the
    // orbit centre a little above the middle of the picture (from any angle).
    // (Portrait screens are width-limited and already have room above and below.)
    this.camera.setViewOffset(w, h, 0, w >= h ? Math.round(h * 0.08) : 0, w, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
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

  /** Glide back to the whole-village view. */
  resetView() {
    this.controls.autoRotate = false;
    this._lastInteraction = performance.now();
    this._frameVillage(false);
  }

  setLabelsVisible(visible) {
    this.labelsVisible = !!visible;
    this.labelRenderer.domElement.hidden = !this.labelsVisible;
  }

  /** Emphasise one kid's name tag and ring (null clears). The camera stays free. */
  highlight(id) {
    this.highlightId = id || null;
  }

  zoomBy(scale) {
    this.controls.autoRotate = false;
    this._lastInteraction = performance.now();
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
