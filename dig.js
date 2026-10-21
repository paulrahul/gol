// The digging sequence: drill, tunnel, debris particles, Earth layers and camera choreography.
import * as THREE from 'three';
import { EARTH_RADIUS_KM, EARTH_DIAMETER_KM } from './geo.js';

// A frictionless fall through a uniform-density Earth ("gravity train").
const FALL_SECONDS = 2532;
const MAX_SPEED_KMS = 7.9;

export const LAYERS = [
  { name: 'Inner core', r: 1221, color: '#ffe3a1', debris: '#ffe7a0' },
  { name: 'Outer core', r: 3480, color: '#f29a3b', debris: '#f39a3a' },
  { name: 'Mantle', r: 6336, color: '#c24e2a', debris: '#d0562c' },
  { name: 'Crust', r: 6371, color: '#8a6239', debris: '#8a6239' },
];

// [depth km, °C], approximate textbook values.
const TEMPS = [[0, 15], [35, 500], [100, 1300], [660, 1900], [2890, 3700], [5150, 5000], [6371, 5400]];

// Timeline, in seconds.
const T = { ground: 1.6, plunge: 3.8, core: 8.0, coreEnd: 9.4, surface: 13.6, arrive: 15.0, end: 16.4 };

const DIRT = ['#6b4a2b', '#8a6239', '#5a3d22', '#a07a4f'].map((c) => new THREE.Color(c));
const WATER = ['#e6f5ff', '#a9d8f2', '#5aa7d6'].map((c) => new THREE.Color(c));
const SPARKS = ['#fff4d6', '#ffd27a', '#ffae4a'].map((c) => new THREE.Color(c));

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const prog = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export const layerAt = (rKm) => LAYERS.find((l) => rKm <= l.r) ?? LAYERS[3];

function tempAtDepth(depth) {
  for (let i = 1; i < TEMPS.length; i++) {
    const [d1, t1] = TEMPS[i];
    const [d0, t0] = TEMPS[i - 1];
    if (depth <= d1) return lerp(t0, t1, (depth - d0) / (d1 - d0));
  }
  return TEMPS[TEMPS.length - 1][1];
}

function randomUnit() {
  const v = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1));
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(1, 0, 0);
}

function randomTangent(n) {
  const v = randomUnit();
  v.addScaledVector(n, -v.dot(n));
  return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
}

function slerpDir(a, b, k) {
  const angle = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
  if (angle < 1e-4) return a.clone().lerp(b, k).normalize();
  const s = Math.sin(angle);
  return a.clone().multiplyScalar(Math.sin((1 - k) * angle) / s).addScaledVector(b, Math.sin(k * angle) / s);
}

function glowTexture() {
  const size = 128;
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

class Particles {
  constructor(max = 3000) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    this.attrs = {
      position: new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
      pColor: new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage),
      alpha: new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
      size: new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
    };
    for (const [name, attr] of Object.entries(this.attrs)) geo.setAttribute(name, attr);

    this.material = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute vec3 pColor;
        attribute float alpha;
        attribute float size;
        uniform float scale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = pColor;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = alpha > 0.0 ? size * scale / -mv.z : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.3, d));
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(p, v, color, size, life, grav = 0) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.life[i] = this.maxLife[i] = life;
    this.grav[i] = grav;
    this.alpha[i] = 1;
  }

  update(dt) {
    const { pos, vel } = this;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      const j = i * 3;
      if (this.grav[i]) {
        // Pull toward the Earth's centre.
        const len = Math.hypot(pos[j], pos[j + 1], pos[j + 2]) || 1;
        const g = (60 * this.grav[i] * dt) / len;
        vel[j] -= pos[j] * g;
        vel[j + 1] -= pos[j + 1] * g;
        vel[j + 2] -= pos[j + 2] * g;
      }
      const drag = 1 - 0.8 * dt;
      vel[j] *= drag;
      vel[j + 1] *= drag;
      vel[j + 2] *= drag;
      pos[j] += vel[j] * dt;
      pos[j + 1] += vel[j + 1] * dt;
      pos[j + 2] += vel[j + 2] * dt;
      this.alpha[i] = Math.min(1, (this.life[i] / this.maxLife[i]) * 1.6);
    }
    for (const attr of Object.values(this.attrs)) attr.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.attrs.alpha.needsUpdate = true;
  }
}

function makeDrill() {
  const steel = new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.7, roughness: 0.35, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: '#5b6470', metalness: 0.6, roughness: 0.4, flatShading: true });
  const accent = new THREE.MeshStandardMaterial({ color: '#f0883e', metalness: 0.3, roughness: 0.5, flatShading: true });

  // Local +y is the direction of travel; the bit's tip sits at the origin.
  const spinner = new THREE.Group();
  spinner.add(new THREE.Mesh(new THREE.ConeGeometry(1.4, 4, 6).translate(0, -2, 0), steel));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.4, 0.9), dark);
    fin.position.set(Math.cos(a) * 0.95, -2.6, Math.sin(a) * 0.95);
    fin.lookAt(0, -2.6, 0);
    fin.rotateZ(0.5);
    spinner.add(fin);
  }

  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 4, 10).translate(0, -6, 0), steel);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.58, 1.58, 0.8, 10).translate(0, -5, 0), accent);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 1.2, 10).translate(0, -8.6, 0), dark);

  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: '#ffb066',
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0,
    })
  );
  glow.scale.setScalar(14);
  glow.position.y = -1.5;
  glow.renderOrder = 6;

  const group = new THREE.Group();
  group.add(spinner, body, band, cap, glow);
  group.visible = false;
  return { group, spinner, glow };
}

function makeTunnel() {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);
  const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#f0883e' }));
  const halo = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: '#ffb066',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  halo.renderOrder = 4;
  const group = new THREE.Group();
  group.add(core, halo);
  group.visible = false;
  return { group, core, halo };
}

export class Digger {
  constructor(world, { setGlobeOpacity, lite = false }) {
    this.world = world;
    // Fewer particles on phones.
    this.density = lite ? 0.5 : 1;
    this.R = world.getGlobeRadius();
    this.setGlobeOpacity = setGlobeOpacity;

    this.group = new THREE.Group();
    world.scene().add(this.group);

    this.particles = new Particles();
    this.drill = makeDrill();
    this.tunnel = makeTunnel();
    this.group.add(this.particles.points, this.drill.group, this.tunnel.group);

    // Mantle, outer core, inner core as nested translucent shells.
    this.layers = [
      { radius: 0.985, opacity: 0.22, layer: LAYERS[2] },
      { radius: LAYERS[1].r / EARTH_RADIUS_KM, opacity: 0.38, layer: LAYERS[1] },
      { radius: LAYERS[0].r / EARTH_RADIUS_KM, opacity: 0.65, layer: LAYERS[0] },
    ].map(({ radius, opacity, layer }, i) => {
      const material = new THREE.MeshBasicMaterial({ color: layer.color, transparent: true, opacity: 0, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(this.R * radius, 64, 32), material);
      mesh.renderOrder = i - 3;
      mesh.visible = false;
      this.group.add(mesh);
      return { mesh, opacity, base: new THREE.Color(layer.color) };
    });

    this.effects = [];
    this.running = false;
    this.timeScale = 1;
  }

  vec({ lat, lng }, alt = 0) {
    const c = this.world.getCoords(lat, lng, alt);
    return new THREE.Vector3(c.x, c.y, c.z);
  }

  run(start, end, { startLand, endLand }, hooks) {
    this.reset();
    const camera = this.world.camera();
    const controls = this.world.controls();
    controls.enabled = false;
    controls.autoRotate = false;

    this.A = this.vec(start);
    this.B = this.vec(end);
    this.aHat = this.A.clone().normalize();
    this.bHat = this.aHat.clone().negate();
    const ref = Math.abs(this.aHat.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.perp = new THREE.Vector3().crossVectors(this.aHat, ref).normalize();
    this.closeA = this.aHat.clone().addScaledVector(this.perp, 0.3).normalize();
    this.closeB = this.bHat.clone().addScaledVector(this.perp, 0.3).normalize();
    this.camStartDir = camera.position.clone().normalize();
    this.camStartDist = camera.position.length();
    this.drill.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.bHat);
    this.tunnel.group.quaternion.copy(this.drill.group.quaternion);
    this.tunnel.group.position.copy(this.A);

    this.startWater = startLand === false;
    this.endWater = endLand === false;
    this.hooks = hooks;
    this.flags = {};
    this.stage = '';
    this.emitAcc = 0;
    this.t = 0;
    this.timeScale = 1;
    this.running = true;
  }

  skip() {
    this.timeScale = 6;
  }

  reset() {
    this.running = false;
    this.particles.clear();
    for (const fx of this.effects) this.disposeEffect(fx);
    this.effects = [];
    this.drill.group.visible = false;
    this.tunnel.group.visible = false;
    for (const l of this.layers) l.mesh.visible = false;
    this.setGlobeOpacity(1);
    const controls = this.world.controls();
    controls.enabled = true;
  }

  disposeEffect(fx) {
    this.group.remove(fx.obj);
    fx.obj.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }

  followDir(s) {
    return this.perp.clone().addScaledVector(this.aHat, 0.35 * (1 - 2 * s)).normalize();
  }

  followDist(s) {
    return this.R * (3.3 - 0.7 * Math.sin(Math.PI * s));
  }

  // --- Effects -----------------------------------------------------------

  addHole(center, normal, t0) {
    const obj = new THREE.Group();
    obj.add(
      new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: '#1a120b' })),
      new THREE.Mesh(new THREE.RingGeometry(1, 1.4, 32), new THREE.MeshBasicMaterial({ color: '#5a3d22' }))
    );
    obj.position.copy(center).addScaledVector(normal, 0.15);
    obj.lookAt(center.clone().addScaledVector(normal, 10));
    obj.scale.setScalar(0.001);
    this.group.add(obj);
    this.effects.push({ obj, update: (t) => obj.scale.setScalar(Math.max(0.001, 2.4 * easeOut(prog(t, t0, t0 + 1.2)))) });
  }

  addRipple(center, normal, t0) {
    const material = new THREE.MeshBasicMaterial({ color: '#e6f5ff', transparent: true, opacity: 0, depthWrite: false });
    const obj = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), material);
    obj.position.copy(center).addScaledVector(normal, 0.2);
    obj.lookAt(center.clone().addScaledVector(normal, 10));
    obj.renderOrder = 4;
    this.group.add(obj);
    this.effects.push({
      obj,
      update: (t) => {
        const k = prog(t, t0, t0 + 1.6);
        obj.scale.setScalar(1 + 15 * easeOut(k));
        material.opacity = t < t0 ? 0 : 0.75 * (1 - k);
      },
    });
  }

  emitSurface(origin, normal, water, speedMin, speedMax) {
    const tangent = randomTangent(normal);
    const p = origin.clone().addScaledVector(tangent, rand(0, 1.6)).addScaledVector(normal, 0.3);
    const v = normal.clone().multiplyScalar(rand(speedMin, speedMax)).addScaledVector(tangent, rand(4, 16));
    if (water) this.particles.emit(p, v, pick(WATER), rand(0.3, 0.8), rand(0.7, 1.4), 1);
    else this.particles.emit(p, v, pick(DIRT), rand(0.4, 1.2), rand(0.8, 1.6), 1);
  }

  emitRate(rate, dt, fn) {
    this.emitAcc += rate * this.density * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      fn();
    }
  }

  once(name, fn) {
    if (!this.flags[name]) {
      this.flags[name] = true;
      fn();
    }
  }

  setStage(text) {
    if (text !== this.stage) {
      this.stage = text;
      this.hooks.onStage(text);
    }
  }

  // --- Frame update ------------------------------------------------------

  update(dt) {
    const renderer = this.world.renderer();
    const camera = this.world.camera();
    this.particles.material.uniforms.scale.value =
      renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));

    if (!this.running) {
      this.particles.update(dt);
      return;
    }

    const sdt = dt * this.timeScale;
    const t = (this.t += sdt);
    const { R, A, B, aHat, bHat } = this;

    // Globe transparency and interior layers.
    const opacity = 1 - 0.8 * easeInOut(prog(t, T.plunge, T.plunge + 1.2)) + 0.8 * easeInOut(prog(t, T.surface - 0.4, T.surface + 1));
    const inside = (1 - opacity) / 0.8;
    this.setGlobeOpacity(opacity);
    const heat = t >= T.core && t < T.coreEnd ? Math.sin(Math.PI * prog(t, T.core, T.coreEnd)) : 0;
    this.layers.forEach((l, i) => {
      l.mesh.visible = inside > 0.001;
      const boost = i === 2 ? heat : i === 1 ? heat * 0.4 : 0;
      l.mesh.material.opacity = Math.min(1, l.opacity * inside + boost * 0.35);
      l.mesh.material.color.copy(l.base).lerp(new THREE.Color('#fff8e8'), boost * 0.6);
    });

    // Drill progress: tau is the fraction of the gravity-train trip, s the fraction of distance.
    let tau = 0;
    if (t >= T.plunge && t < T.core) tau = prog(t, T.plunge, T.core) / 2;
    else if (t >= T.core && t < T.coreEnd) tau = 0.5;
    else if (t >= T.coreEnd) tau = 0.5 + prog(t, T.coreEnd, T.surface) / 2;
    const s = (1 - Math.cos(Math.PI * tau)) / 2;
    const speedFactor = t >= T.plunge && t < T.surface ? Math.sin(Math.PI * tau) : 0;

    const drill = this.drill;
    const tip = new THREE.Vector3();
    let drillScale = 1 + 0.9 * inside;
    if (t < T.ground) {
      tip.copy(A).addScaledVector(aHat, 14);
    } else if (t < T.plunge) {
      const k = prog(t, T.ground, T.plunge);
      tip.copy(A).addScaledVector(aHat, 14 * (1 - easeOut(clamp01(k / 0.35))));
      if (k > 0.35) tip.addScaledVector(randomTangent(aHat), 0.12);
    } else if (t < T.surface) {
      tip.copy(A).lerp(B, s);
    } else {
      const k = prog(t, T.surface, T.surface + 1);
      tip.copy(B).addScaledVector(bHat, 18 * easeOut(k));
      drillScale *= 1 - prog(t, T.surface + 0.9, T.surface + 1.5);
    }
    drill.group.visible = drillScale > 0.01;
    drill.group.position.copy(tip);
    drill.group.scale.setScalar(Math.max(0.001, drillScale));
    drill.spinner.rotation.y += sdt * (t < T.ground ? 4 : 12 + 40 * speedFactor + 50 * heat);
    drill.glow.material.opacity = inside * (0.5 + 0.5 * speedFactor) + heat * 0.5;

    // Tunnel from the entry hole to the drill tip.
    if (t >= T.plunge) {
      const len = A.distanceTo(t >= T.surface ? B : tip);
      this.tunnel.group.visible = len > 0.1;
      const r = 0.7 * (1 + 0.6 * inside);
      this.tunnel.core.scale.set(r, len, r);
      this.tunnel.halo.scale.set(r * 3, len, r * 3);
      this.tunnel.halo.material.opacity = 0.25 * inside;
    }

    // Particles and surface effects.
    if (t >= T.ground + 0.5 && t < T.plunge + 0.6) {
      this.once('holeA', () =>
        this.startWater ? [0, 0.5, 1].forEach((d) => this.addRipple(A, aHat, T.ground + 0.5 + d)) : this.addHole(A, aHat, T.ground + 0.5)
      );
      this.emitRate(this.startWater ? 200 : 260, sdt, () => this.emitSurface(A, aHat, this.startWater, 18, 42));
    } else if (t >= T.plunge && t < T.core) {
      this.emitTrail(tip, sdt, speedFactor);
    } else if (t >= T.core && t < T.coreEnd) {
      this.once('coreBurst', () => {
        for (let i = 0; i < 350 * this.density; i++) this.emitSpark(tip, 30, 80);
      });
      this.emitRate(380, sdt, () => this.emitSpark(tip, 15, 55));
    } else if (t >= T.coreEnd && t < T.surface) {
      this.emitTrail(tip, sdt, speedFactor);
    } else if (t >= T.surface) {
      this.once('exitBurst', () => {
        if (this.endWater) [0, 0.35, 0.7].forEach((d) => this.addRipple(B, bHat, T.surface + d));
        else this.addHole(B, bHat, T.surface);
        for (let i = 0; i < 600 * this.density; i++) this.emitSurface(B, bHat, this.endWater, 25, 70);
      });
      if (t < T.surface + 0.8) this.emitRate(240, sdt, () => this.emitSurface(B, bHat, this.endWater, 20, 50));
    }
    this.particles.update(sdt);
    for (const fx of this.effects) fx.update(t);

    // Camera choreography (always looking at the Earth's centre).
    let camDir;
    let camDist;
    if (t < T.ground) {
      const k = easeInOut(prog(t, 0, T.ground));
      camDir = slerpDir(this.camStartDir, this.closeA, k);
      camDist = lerp(this.camStartDist, 1.55 * R, k);
    } else if (t < T.plunge) {
      camDir = this.closeA.clone();
      camDist = lerp(1.55 * R, 1.42 * R, easeInOut(prog(t, T.ground, T.plunge)));
    } else if (t < T.surface) {
      const k = easeInOut(prog(t, T.plunge, T.plunge + 1.8));
      camDir = slerpDir(this.closeA, this.followDir(s), k);
      camDist = lerp(1.42 * R, this.followDist(s), k);
    } else {
      const k1 = easeInOut(prog(t, T.surface, T.arrive));
      const k2 = easeInOut(prog(t, T.arrive, T.end));
      camDir = slerpDir(this.followDir(1), this.closeB, k1);
      camDist = lerp(lerp(this.followDist(1), 1.6 * R, k1), 2.5 * R, k2);
    }
    camera.position.copy(camDir).multiplyScalar(camDist);
    camera.lookAt(0, 0, 0);

    // Screen effects.
    let shake = 0;
    if (t >= T.ground + 0.5 && t < T.plunge + 0.4) shake = 3;
    else if (t >= T.plunge && t < T.surface) shake = 1.2 * speedFactor + 5 * heat;
    else if (t >= T.surface && t < T.surface + 0.8) shake = 4;
    this.hooks.onShake(shake);
    this.hooks.onHeat(heat);

    // Telemetry for the HUD.
    const rKm = (tip.length() / R) * EARTH_RADIUS_KM;
    const depthKm = t >= T.plunge && t < T.surface ? Math.max(0, EARTH_RADIUS_KM - rKm) : 0;
    const layer = layerAt(EARTH_RADIUS_KM - depthKm);
    this.hooks.onTelemetry({
      s,
      depthKm,
      distKm: s * EARTH_DIAMETER_KM,
      layer: layer.name,
      tempC: tempAtDepth(depthKm),
      speedKms: MAX_SPEED_KMS * speedFactor,
      tripSeconds: tau * FALL_SECONDS,
    });

    if (t < T.ground) this.setStage('Moving to the dig site');
    else if (t < T.plunge) this.setStage('Breaking ground');
    else if (t < T.core) this.setStage(`Drilling down through the ${layer.name.toLowerCase()}`);
    else if (t < T.coreEnd) this.setStage('Passing through the centre of the Earth');
    else if (t < T.surface) this.setStage(`Climbing up through the ${layer.name.toLowerCase()}`);
    else if (t < T.arrive) this.setStage('Breaking through to the other side');
    else this.setStage('You made it');

    if (t >= T.arrive) this.once('arrive', () => this.hooks.onArrive());
    if (t >= T.end) this.finish();
  }

  emitTrail(tip, dt, speedFactor) {
    const layer = layerAt((tip.length() / this.R) * EARTH_RADIUS_KM);
    const base = new THREE.Color(layer.debris);
    const scale = this.drill.group.scale.x;
    this.emitRate(60 + 160 * speedFactor, dt, () => {
      const p = tip.clone().addScaledVector(this.bHat, -rand(3, 9) * scale).addScaledVector(randomUnit(), 1.4 * scale);
      const v = this.bHat.clone().multiplyScalar(-rand(2, 12)).addScaledVector(randomUnit(), 3);
      const c = base.clone().offsetHSL(rand(-0.02, 0.02), 0, rand(-0.1, 0.12));
      this.particles.emit(p, v, c, rand(1, 2.4), rand(0.6, 1.3));
    });
  }

  emitSpark(center, speedMin, speedMax) {
    const p = center.clone().addScaledVector(randomUnit(), 2);
    this.particles.emit(p, randomUnit().multiplyScalar(rand(speedMin, speedMax)), pick(SPARKS), rand(0.8, 2), rand(0.4, 1));
  }

  finish() {
    this.running = false;
    this.drill.group.visible = false;
    for (const l of this.layers) l.mesh.visible = false;
    this.setGlobeOpacity(1);
    this.hooks.onShake(0);
    this.hooks.onHeat(0);
    this.world.controls().enabled = true;
    this.hooks.onDone();
  }
}
