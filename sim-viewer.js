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

    // Use the viewport (not just the canvas) so drag/zoom hit the full stage
    const orbitEl = this.canvas.parentElement || this.canvas;
    this.controls = new OrbitControls(this.camera, orbitEl);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 120;
    this.controls.target.set(0, 1.5, 0);
    // Follow-cam fights orbit unless we release it while the user drags/zooms
    this.controls.addEventListener('start', () => {
      this.freeLook = true;
    });

    window.addEventListener('resize', () => this.resize());
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
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a8a90, roughness: 0.85 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x664829, roughness: 0.9 });
    const water = new THREE.MeshStandardMaterial({ color: 0x4d8ccc, roughness: 0.35 });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.0, 20), stone);
    ring.position.set(0, 0.5, 0);
    ring.castShadow = true;
    g.add(ring);
    const pool = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.2, 20), water);
    pool.position.set(0, 0.35, 0);
    g.add(pool);
    [[-1], [1]].forEach(([x]) => {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.0, 0.15), wood);
      post.position.set(x, 1.2, 0);
      g.add(post);
    });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.15, 0.15), wood);
    beam.position.set(0, 2.2, 0);
    g.add(beam);
    g.position.copy(c);
    this.scene.add(g);
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
      this._ensureWell();

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
      this._animate();
    } catch (e) {
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

  _animate = () => {
    requestAnimationFrame(this._animate);
    const dt = this.clock.getDelta();

    if (this.playing && this.meta) {
      this.dayHour += (dt * this.speed * 2.5) / 60;
      if (this.dayHour >= this.meta.day_end_hour) this.dayHour = this.meta.day_start_hour;
    }

    this._applyPathTime(this.dayHour);

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
  };

  resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
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
}
