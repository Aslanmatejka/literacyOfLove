/**
 * Hybrid 3D Ambassador village — schedule-driven Three.js overview.
 * Loads assets/sim/daily_schedule.json; optional village_overview.glb.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SCHEDULE_URL = 'assets/sim/daily_schedule.json';
const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function parseClock(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h + (m || 0) / 60;
}

function formatClock(hour) {
  let h = Math.floor(hour) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60) % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

function ugandaHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Kampala',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date());
  let h = 0;
  let m = 0;
  let s = 0;
  parts.forEach((p) => {
    if (p.type === 'hour') h = +p.value === 24 ? 0 : +p.value;
    else if (p.type === 'minute') m = +p.value;
    else if (p.type === 'second') s = +p.value;
  });
  return h + m / 60 + s / 3600;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexColor(hex) {
  return new THREE.Color(hex || '#e8553d');
}

function buildKidTimeline(kid, meta, locations) {
  const events = kid.events || [];
  const segments = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const start = parseClock(ev.time);
    const end = i + 1 < events.length ? parseClock(events[i + 1].time) : meta.day_end_hour;
    const loc = locations[ev.location];
    const pos = loc?.pos || [0, 0, 0];
    segments.push({
      start,
      end,
      type: ev.type || 'hold',
      location: ev.location,
      activity: ev.activity,
      pos: new THREE.Vector3(pos[0], pos[1] || 0, pos[2]),
      eventIndex: i,
    });
  }
  return segments;
}

function positionAtHour(segments, hour) {
  if (!segments.length) return { pos: new THREE.Vector3(), seg: null };
  if (hour <= segments[0].start) {
    return { pos: segments[0].pos.clone(), seg: segments[0] };
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (hour < seg.end || i === segments.length - 1) {
      if (seg.type === 'travel' && i > 0) {
        const from = segments[i - 1].pos;
        const t = clamp((hour - seg.start) / Math.max(0.001, seg.end - seg.start), 0, 1);
        const pos = new THREE.Vector3().lerpVectors(from, seg.pos, t);
        pos.y = Math.sin(t * Math.PI) * 0.35;
        return { pos, seg };
      }
      return { pos: seg.pos.clone(), seg };
    }
  }
  const last = segments[segments.length - 1];
  return { pos: last.pos.clone(), seg: last };
}

function activityAtHour(segments, hour) {
  return positionAtHour(segments, hour).seg;
}

function stopIndices(segments) {
  const stops = [];
  segments.forEach((s, i) => {
    if (s.type === 'hold' || i === 0) stops.push(i);
  });
  if (!stops.length) segments.forEach((_, i) => stops.push(i));
  return stops;
}

function showSimError(message) {
  const fallback = document.getElementById('simFallback');
  const host = document.getElementById('simCanvasHost');
  const status = document.getElementById('simStatus');
  if (status) status.hidden = true;
  if (host) host.classList.add('is-failed');
  if (fallback) {
    fallback.hidden = false;
    fallback.innerHTML = `<strong>Village could not start.</strong><br>${message}<br><span style="opacity:.8;font-weight:500">Open via <code>http://127.0.0.1:8765/track-dolls.html</code> (not a file:// link).</span>`;
  }
  console.error('[track-sim]', message);
}

function hostSize(canvasHost, stage) {
  const w = Math.max(canvasHost.clientWidth || 0, stage?.clientWidth || 0, 320);
  const h = Math.max(canvasHost.clientHeight || 0, stage?.clientHeight || 0, 240);
  return { w, h };
}

export async function bootTrackSim() {
  const stage = $('#simStage');
  const canvasHost = $('#simCanvasHost');
  const fallback = $('#simFallback');
  const status = $('#simStatus');
  if (!stage || !canvasHost) {
    showSimError('Missing stage markup.');
    return;
  }

  // Wait for layout so the canvas is not 0×0
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  let schedule;
  try {
    const res = await fetch(SCHEDULE_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Schedule HTTP ${res.status}`);
    schedule = await res.json();
  } catch (err) {
    showSimError(`Could not load schedule (${err.message}).`);
    return;
  }

  const meta = schedule.meta;
  const locations = schedule.locations;
  const dayStart = meta.day_start_hour;
  const dayEnd = meta.day_end_hour;

  const kids = schedule.kids.map((k) => ({
    ...k,
    segments: buildKidTimeline(k, meta, locations),
    stops: null,
    mesh: null,
    pathLine: null,
  }));
  kids.forEach((k) => {
    k.stops = stopIndices(k.segments);
  });

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: !REDUCE_MOTION,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch (e) {
    showSimError('WebGL is not available in this browser.');
    if (canvasHost) canvasHost.hidden = true;
    return;
  }

  const { w: startW, h: startH } = hostSize(canvasHost, stage);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(startW, startH, false);
  renderer.shadowMap.enabled = !REDUCE_MOTION;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  canvasHost.innerHTML = '';
  canvasHost.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'Interactive 3D village map');
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#c8dff0');
  scene.fog = new THREE.Fog('#c8dff0', 55, 120);

  const camera = new THREE.PerspectiveCamera(42, startW / Math.max(startH, 1), 0.1, 200);
  camera.position.set(28, 32, 36);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minDistance = 12;
  controls.maxDistance = 80;
  controls.target.set(0, 0, 0);

  const hemi = new THREE.HemisphereLight(0xfff2dd, 0x6b8f5e, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe6c0, 1.15);
  sun.position.set(30, 40, 12);
  sun.castShadow = !REDUCE_MOTION;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 100;
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(48, 64),
    new THREE.MeshStandardMaterial({ color: '#8fbc6b', roughness: 0.92, metalness: 0.02 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(18, 19.2, 64),
    new THREE.MeshStandardMaterial({ color: '#c4a574', roughness: 1, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  scene.add(ring);

  const locMeshes = {};
  const locGroup = new THREE.Group();
  scene.add(locGroup);

  function makeLocationMarker(key, loc) {
    const g = new THREE.Group();
    g.position.set(loc.pos[0], 0, loc.pos[2]);
    const colors = {
      Home: '#d99a3a',
      School: '#4a7ec8',
      Farm: '#5aa83a',
      Shops: '#d96a7a',
      Wood: '#4a7a3a',
      Well: '#4aa8c8',
    };
    const c = new THREE.Color(colors[key] || '#888');
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.3, 0.35, 10),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 })
    );
    base.position.y = 0.18;
    base.castShadow = true;
    g.add(base);

    let building;
    if (key === 'School') {
      building = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 2.2, 2.0),
        new THREE.MeshStandardMaterial({ color: '#e8eef6', roughness: 0.65 })
      );
      building.position.y = 1.4;
    } else if (key === 'Well') {
      building = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 0.85, 1.2, 12),
        new THREE.MeshStandardMaterial({ color: '#7a8a94', roughness: 0.8 })
      );
      building.position.y = 0.9;
    } else if (key === 'Wood') {
      building = new THREE.Mesh(
        new THREE.ConeGeometry(1.2, 2.8, 7),
        new THREE.MeshStandardMaterial({ color: '#2f6b3a', roughness: 0.85 })
      );
      building.position.y = 1.8;
    } else if (key === 'Farm') {
      building = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 0.4, 2.6),
        new THREE.MeshStandardMaterial({ color: '#6a9a3a', roughness: 1 })
      );
      building.position.y = 0.45;
    } else if (key === 'Shops') {
      building = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 1.6, 2.2),
        new THREE.MeshStandardMaterial({ color: '#f0d0c0', roughness: 0.7 })
      );
      building.position.y = 1.1;
    } else {
      const hut = new THREE.Group();
      const wall = new THREE.Mesh(
        new THREE.CylinderGeometry(1.15, 1.25, 1.5, 10),
        new THREE.MeshStandardMaterial({ color: '#e8c89a', roughness: 0.9 })
      );
      wall.position.y = 1.0;
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(1.7, 1.4, 10),
        new THREE.MeshStandardMaterial({ color: '#8b5a2b', roughness: 0.85 })
      );
      roof.position.y = 2.2;
      hut.add(wall, roof);
      building = hut;
    }
    if (building.isMesh) building.castShadow = true;
    building.traverse?.((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    g.add(building);

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(15,27,45,0.72)';
    ctx.fillRect(8, 8, 240, 48);
    ctx.fillStyle = '#fff';
    ctx.font = '600 28px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(loc.label || key, 128, 34);
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(4.5, 1.15, 1);
    sprite.position.y = 4.2;
    g.add(sprite);

    g.userData.key = key;
    locMeshes[key] = g;
    locGroup.add(g);
  }

  Object.entries(locations).forEach(([key, loc]) => makeLocationMarker(key, loc));

  const glbUrl = schedule.web?.villageGlb;
  if (glbUrl) {
    const loader = new GLTFLoader();
    loader.load(
      glbUrl,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        scene.add(root);
      },
      undefined,
      () => {
        /* Procedural village markers are enough when GLB is missing. */
      }
    );
  }

  const texLoader = new THREE.TextureLoader();
  kids.forEach((kid, idx) => {
    const group = new THREE.Group();
    // Capsule-like body (compatible everywhere CapsuleGeometry may fail)
    const bodyMat = new THREE.MeshStandardMaterial({ color: hexColor(kid.colorHex), roughness: 0.55 });
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.85, 12), bodyMat);
    torso.position.y = 1.05;
    torso.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 12), bodyMat);
    head.position.y = 1.75;
    head.castShadow = true;
    group.add(torso, head);

    const faceMat = new THREE.SpriteMaterial({
      map: texLoader.load(kid.face),
      transparent: true,
    });
    const face = new THREE.Sprite(faceMat);
    face.scale.set(1.4, 1.4, 1);
    face.position.y = 2.35;
    group.add(face);

    const pathPts = [];
    kid.segments.forEach((s) => {
      const p = s.pos.clone().setY(0.08);
      if (!pathPts.length || pathPts[pathPts.length - 1].distanceTo(p) > 0.01) pathPts.push(p);
    });
    if (pathPts.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(pathPts);
      const line = new THREE.Line(
        geo,
        new THREE.LineDashedMaterial({
          color: hexColor(kid.colorHex),
          dashSize: 0.6,
          gapSize: 0.35,
          transparent: true,
          opacity: 0.35,
        })
      );
      line.computeLineDistances();
      scene.add(line);
      kid.pathLine = line;
    }

    const start = positionAtHour(kid.segments, dayStart);
    group.position.copy(start.pos);
    scene.add(group);
    kid.mesh = group;
    kid.idx = idx;
  });

  let hour = clamp(ugandaHour(), dayStart, dayEnd);
  let liveMode = true;
  let followedIdx = 0;
  let scrubbing = false;
  let followLocked = false;

  const els = {
    roster: $('#dollRoster'),
    clock: $('#simClock'),
    trackClock: $('#simTrackClock'),
    dollName: $('#simDollName'),
    count: $('#simCount'),
    phase: $('#simPhaseLabel'),
    liveBadge: $('.sim-live--inline'),
    liveToggle: $('#simLiveToggle'),
    liveLabel: $('#simLiveLabel'),
    prev: $('#simPrev'),
    next: $('#simNext'),
    scrub: $('#simScrub'),
    rail: $('#simTrackRail'),
    fill: $('#simProgressFill'),
    marker: $('#simTrackMarker'),
    stops: $('#simTrackStops'),
    actTime: $('#simActivityTime'),
    actTitle: $('#simActivityTitle'),
    actDesc: $('#simActivityDesc'),
    journal: $('#simJournal'),
    stopStill: $('#stopStill'),
    stopLabel: $('#stopLabel'),
    stopCaption: $('#stopCaption'),
    stopVideo: $('#stopVideo'),
    stopVideoWrap: $('#stopVideoWrap'),
    stopClipNote: $('#stopClipNote'),
    followCam: $('#simFollowCam'),
  };

  if (els.count) els.count.textContent = String(kids.length);

  function dayFraction(h) {
    return clamp((h - dayStart) / (dayEnd - dayStart), 0, 1);
  }

  function phaseOf(h) {
    if (h < 8) return { icon: 'fa-cloud-sun', text: 'Sunrise' };
    if (h < 17) return { icon: 'fa-sun', text: 'Daytime' };
    if (h < 19) return { icon: 'fa-cloud-moon', text: 'Sunset' };
    return { icon: 'fa-moon', text: 'Evening' };
  }

  function setLiveMode(on) {
    liveMode = on;
    if (els.liveToggle) {
      els.liveToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      els.liveToggle.classList.toggle('is-explore', !on);
    }
    if (els.liveLabel) els.liveLabel.textContent = on ? 'Live' : 'Explore';
    if (els.liveBadge) els.liveBadge.hidden = !on;
    if (on) hour = clamp(ugandaHour(), dayStart, dayEnd);
  }

  function enterManual() {
    if (liveMode) setLiveMode(false);
  }

  function updateSkyTint(h) {
    const t = dayFraction(h);
    const dawn = new THREE.Color('#a8c4e8');
    const day = new THREE.Color('#c8dff0');
    const dusk = new THREE.Color('#e8b898');
    const night = new THREE.Color('#3a4560');
    let c;
    if (t < 0.15) c = dawn.clone().lerp(day, t / 0.15);
    else if (t < 0.7) c = day;
    else if (t < 0.9) c = day.clone().lerp(dusk, (t - 0.7) / 0.2);
    else c = dusk.clone().lerp(night, (t - 0.9) / 0.1);
    scene.background = c;
    if (scene.fog) scene.fog.color.copy(c);
    sun.intensity = lerp(0.55, 1.2, Math.sin(clamp(t, 0.05, 0.95) * Math.PI));
  }

  function highlightLocation(key) {
    Object.entries(locMeshes).forEach(([k, g]) => {
      g.scale.setScalar(k === key ? 1.18 : 1);
    });
  }

  const mediaCache = new Map();

  function updateStopStory(kid, seg) {
    if (!seg) return;
    const loc = locations[seg.location];
    if (els.stopStill && loc?.still) {
      els.stopStill.src = loc.still;
      els.stopStill.alt = loc.label || seg.location;
    }
    if (els.stopLabel) els.stopLabel.textContent = loc?.label || seg.location;
    if (els.stopCaption) els.stopCaption.textContent = `${kid.name} — ${seg.activity}`;
    const mediaUrl = `assets/sim/media/${kid.id}_${seg.location}.mp4`;
    if (!els.stopVideo || !els.stopVideoWrap) return;

    const applyMedia = (ok) => {
      if (ok) {
        els.stopVideoWrap.hidden = false;
        if (els.stopClipNote) els.stopClipNote.hidden = true;
        if (els.stopVideo.getAttribute('src') !== mediaUrl) els.stopVideo.src = mediaUrl;
      } else {
        els.stopVideoWrap.hidden = true;
        if (els.stopClipNote) els.stopClipNote.hidden = false;
      }
    };

    if (mediaCache.has(mediaUrl)) {
      applyMedia(mediaCache.get(mediaUrl));
      return;
    }
    fetch(mediaUrl, { method: 'HEAD' })
      .then((r) => {
        mediaCache.set(mediaUrl, r.ok);
        applyMedia(r.ok);
      })
      .catch(() => {
        mediaCache.set(mediaUrl, false);
        applyMedia(false);
      });
  }

  function syncJournal(kid, hourNow) {
    if (!els.journal) return;
    const items = kid.segments.filter((s) => s.type === 'hold' && hourNow >= s.start - 0.001);
    if (!items.length) {
      els.journal.innerHTML =
        '<li class="sim-journal__empty">Stops appear here as the day unfolds. Use <strong>Back</strong> / <strong>Next</strong> or scrub the timeline.</li>';
      return;
    }
    els.journal.innerHTML = items
      .map(
        (s) => `<li class="sim-journal__item">
        <span class="sim-journal__time">${formatClock(s.start)}</span>
        <span class="sim-journal__icon"><i class="fas fa-map-marker-alt"></i></span>
        <span class="sim-journal__text">${s.activity}</span>
      </li>`
      )
      .join('');
    els.journal.scrollTop = els.journal.scrollHeight;
  }

  function updateHUD() {
    const label = formatClock(hour);
    if (els.clock) els.clock.textContent = label;
    if (els.trackClock) els.trackClock.textContent = label;
    const f = dayFraction(hour);
    const pct = `${(f * 100).toFixed(1)}%`;
    if (els.fill) els.fill.style.width = pct;
    if (els.marker) els.marker.style.left = pct;
    if (els.scrub && !scrubbing) els.scrub.value = String(Math.round(f * 1000));
    if (els.rail) {
      els.rail.setAttribute('aria-valuenow', String(Math.round(f * 100)));
      els.rail.setAttribute('aria-valuetext', label);
    }
    const ph = phaseOf(hour);
    if (els.phase) els.phase.innerHTML = `<i class="fas ${ph.icon}" aria-hidden="true"></i> ${ph.text}`;

    const kid = kids[followedIdx];
    if (els.dollName) els.dollName.textContent = kid.name;
    const seg = activityAtHour(kid.segments, hour);
    if (seg) {
      if (els.actTime) els.actTime.textContent = formatClock(seg.start);
      if (els.actTitle) els.actTitle.textContent = seg.activity;
      if (els.actDesc) {
        const loc = locations[seg.location];
        els.actDesc.textContent = `${kid.name} is at ${loc?.label || seg.location}. ${
          seg.type === 'travel' ? 'On the path between stops.' : 'Paused here for this part of the day.'
        }`;
      }
      highlightLocation(seg.location);
      updateStopStory(kid, seg);
    }
    syncJournal(kid, hour);

    kids.forEach((k, i) => {
      if (k.pathLine) k.pathLine.material.opacity = i === followedIdx ? 0.75 : 0.22;
      if (k.mesh) k.mesh.scale.setScalar(i === followedIdx ? 1.25 : 1);
    });
  }

  function applyHour(h, { pan = false } = {}) {
    hour = clamp(h, dayStart, dayEnd);
    kids.forEach((kid) => {
      const { pos } = positionAtHour(kid.segments, hour);
      if (kid.mesh) {
        if (scrubbing || Math.abs(kid.mesh.position.distanceTo(pos)) > 8) kid.mesh.position.copy(pos);
        else kid.mesh.position.lerp(pos, 1);
      }
    });
    updateSkyTint(hour);
    updateHUD();
    if (pan && kids[followedIdx]?.mesh) controls.target.lerp(kids[followedIdx].mesh.position, 0.5);
  }

  function goStop(delta) {
    enterManual();
    const kid = kids[followedIdx];
    const stops = kid.stops;
    let cur = 0;
    for (let i = stops.length - 1; i >= 0; i--) {
      if (hour >= kid.segments[stops[i]].start - 0.01) {
        cur = i;
        break;
      }
    }
    const next = clamp(cur + delta, 0, stops.length - 1);
    applyHour(kid.segments[stops[next]].start, { pan: true });
  }

  function buildTrackStops() {
    if (!els.stops) return;
    els.stops.innerHTML = '';
    const kid = kids[followedIdx];
    kid.stops.forEach((si) => {
      const s = kid.segments[si];
      const f = dayFraction(s.start);
      const li = document.createElement('li');
      li.className = 'sim-track__stop';
      li.style.left = `${f * 100}%`;
      li.innerHTML = `<span class="sim-track__dot"><i class="fas fa-map-marker-alt"></i></span>
        <span class="sim-track__tip">${formatClock(s.start)} · ${locations[s.location]?.label || s.location}</span>`;
      li.addEventListener('click', () => {
        enterManual();
        applyHour(s.start, { pan: true });
      });
      els.stops.appendChild(li);
    });
  }

  if (els.roster) {
    els.roster.innerHTML = '';
    kids.forEach((kid, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'doll-chip doll-chip--student' + (idx === 0 ? ' is-active' : '');
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', idx === 0 ? 'true' : 'false');
      btn.style.setProperty('--dc', kid.colorHex);
      btn.innerHTML = `
        <span class="doll-chip__face doll-chip__face--img"><img src="${kid.face}" alt="" loading="lazy"></span>
        <span class="doll-chip__copy">
          <span class="doll-chip__role">Ambassador</span>
          <span class="doll-chip__name">${kid.name}</span>
          <span class="doll-chip__tag">${kid.tagline || ''}</span>
        </span>
        <span class="doll-chip__follow" aria-hidden="true">Follow</span>`;
      btn.addEventListener('click', () => {
        followedIdx = idx;
        $$('.doll-chip', els.roster).forEach((c, i) => {
          c.classList.toggle('is-active', i === idx);
          c.setAttribute('aria-checked', i === idx ? 'true' : 'false');
        });
        buildTrackStops();
        applyHour(hour, { pan: true });
      });
      els.roster.appendChild(btn);
      kid.chip = btn;
    });
  }

  els.prev?.addEventListener('click', () => goStop(-1));
  els.next?.addEventListener('click', () => goStop(1));
  els.liveToggle?.addEventListener('click', () => setLiveMode(!liveMode));
  els.followCam?.addEventListener('click', () => {
    followLocked = !followLocked;
    els.followCam.classList.toggle('is-active', followLocked);
    els.followCam.setAttribute('aria-pressed', followLocked ? 'true' : 'false');
    if (followLocked && kids[followedIdx]?.mesh) {
      const p = kids[followedIdx].mesh.position;
      controls.target.copy(p);
      camera.position.set(p.x + 14, 16, p.z + 14);
    }
  });

  els.scrub?.addEventListener('input', () => {
    enterManual();
    scrubbing = true;
    applyHour(dayStart + (+els.scrub.value / 1000) * (dayEnd - dayStart));
  });
  els.scrub?.addEventListener('change', () => {
    scrubbing = false;
    applyHour(dayStart + (+els.scrub.value / 1000) * (dayEnd - dayStart), { pan: true });
  });

  function fractionFromClientX(clientX) {
    if (!els.rail) return dayFraction(hour);
    const rect = els.rail.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }

  if (els.rail) {
    els.rail.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.sim-track__stop')) return;
      enterManual();
      scrubbing = true;
      els.rail.setPointerCapture(e.pointerId);
      applyHour(dayStart + fractionFromClientX(e.clientX) * (dayEnd - dayStart));
    });
    els.rail.addEventListener('pointermove', (e) => {
      if (!scrubbing) return;
      applyHour(dayStart + fractionFromClientX(e.clientX) * (dayEnd - dayStart));
    });
    const end = (e) => {
      if (!scrubbing) return;
      scrubbing = false;
      applyHour(dayStart + fractionFromClientX(e.clientX) * (dayEnd - dayStart), { pan: true });
    };
    els.rail.addEventListener('pointerup', end);
    els.rail.addEventListener('pointercancel', end);
    els.rail.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goStop(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goStop(1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        enterManual();
        applyHour(dayStart, { pan: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        enterManual();
        applyHour(dayEnd, { pan: true });
      }
    });
  }

  const keyEl = $('#simKey');
  const keyToggle = $('#simKeyToggle');
  if (keyToggle && keyEl) {
    keyToggle.addEventListener('click', () => {
      const collapsed = keyEl.classList.toggle('is-collapsed');
      keyToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(Object.values(locMeshes), true);
    if (!hits.length) return;
    let obj = hits[0].object;
    while (obj && !obj.userData.key) obj = obj.parent;
    if (!obj?.userData.key) return;
    enterManual();
    const kid = kids[followedIdx];
    const match =
      kid.segments.find((s) => s.location === obj.userData.key && s.type === 'hold') ||
      kid.segments.find((s) => s.location === obj.userData.key);
    if (match) applyHour(match.start, { pan: true });
  });

  function onResize() {
    const { w, h } = hostSize(canvasHost, stage);
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', onResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(stage);
  }

  buildTrackStops();
  applyHour(hour);
  setLiveMode(true);
  onResize();
  if (status) status.hidden = true;
  if (fallback) fallback.hidden = true;
  stage.classList.add('is-ready');

  let last = performance.now();
  let hudTick = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (liveMode && !scrubbing) hour = clamp(ugandaHour(), dayStart, dayEnd);
    kids.forEach((kid) => {
      const { pos } = positionAtHour(kid.segments, hour);
      if (kid.mesh) {
        const speed = REDUCE_MOTION ? 1 : 1 - Math.exp(-dt * 6);
        kid.mesh.position.lerp(pos, speed);
        kid.mesh.position.y = pos.y + Math.sin(now * 0.004 + kid.idx) * (REDUCE_MOTION ? 0 : 0.04);
      }
    });
    if (followLocked && kids[followedIdx]?.mesh) {
      controls.target.lerp(kids[followedIdx].mesh.position, 0.08);
    }
    updateSkyTint(hour);
    hudTick += dt;
    if (hudTick > 0.25) {
      hudTick = 0;
      updateHUD();
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  bootNameTags(kids);
}

function bootNameTags(kids) {
  const grid = $('#nametagGrid');
  if (!grid) return;
  const baseUrl = location.href.split('#')[0];
  grid.innerHTML = '';
  kids.forEach((d) => {
    const slug = d.name.toLowerCase();
    const card = document.createElement('article');
    card.className = 'nametag';
    card.style.setProperty('--tag-color', d.colorHex);
    card.innerHTML = `
      <div class="nametag__header">
        <img class="nametag__logo" src="images/logo-mark.png" alt="">
        <span class="nametag__brand">Literacy of Love</span>
        <span class="nametag__badge">Ambassador</span>
      </div>
      <div class="nametag__body">
        <img class="nametag__photo" src="${d.face}" alt="${d.name}" width="72" height="72" loading="lazy">
        <div class="nametag__info">
          <h3 class="nametag__name">${d.name}</h3>
          <p class="nametag__bio">${d.tagline || 'A day in Ggala with an Ambassador Doll.'}</p>
        </div>
        <div class="nametag__qr">
          <canvas class="nametag__qr-canvas" data-slug="${slug}" aria-label="QR for ${d.name}"></canvas>
          <span class="nametag__qr-label">Scan for video</span>
        </div>
      </div>
      <p class="nametag__footer">Ggala, Uganda · literacyoflove.org</p>`;
    grid.appendChild(card);
  });
  if (typeof QRCode !== 'undefined') {
    grid.querySelectorAll('.nametag__qr-canvas').forEach((canvas) => {
      QRCode.toCanvas(canvas, `${baseUrl}#video-${canvas.dataset.slug}`, {
        width: 108,
        margin: 1,
        color: { dark: '#0f1b2d', light: '#ffffff' },
      });
    });
  }
}

bootTrackSim().catch((e) => {
  showSimError(e && e.message ? e.message : String(e));
});
