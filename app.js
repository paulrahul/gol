import * as THREE from 'three';
import Globe from 'globe.gl';
import {
  EARTH_DIAMETER_KM,
  antipode,
  describePlace,
  formatCoords,
  isLand,
  landOverlap,
  loadLand,
  loadMirrorLand,
  oceanName,
  searchPlaces,
  subsolarPoint,
  suggestPlaces,
} from './geo.js';
import { citiesNear, loadCities, sameLatitude, sameLongitude } from './cities.js';
import { daylightText, fetchNow, localTime, seasonAt } from './now.js';
import { Digger, LAYERS } from './dig.js';

const IMG = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.6/example/img/';
const PIN_START = '#f0883e';
const PIN_END = '#7cc4e8';

const $ = (id) => document.getElementById(id);
const ui = {
  globe: $('globe'),
  searchForm: $('search'),
  searchInput: $('search-input'),
  searchStatus: $('search-status'),
  searchResults: $('search-results'),
  layers: $('layers'),
  toggleMirror: $('toggle-mirror'),
  toggleLines: $('toggle-lines'),
  mirrorNote: $('mirror-note'),
  panel: $('panel'),
  panelBody: $('panel-body'),
  sheetHandle: $('sheet-handle'),
  layersBtn: $('layers-btn'),
  pairBar: $('pair-bar'),
  pairText: $('pair-text'),
  pairDig: $('pair-dig'),
  pairClose: $('pair-close'),
  clockLayers: $('clock-layers'),
  hud: $('hud'),
  stage: $('stage'),
  marker: $('gauge-marker'),
  readouts: $('readouts'),
  flash: $('flash'),
  skip: $('skip'),
  clock: $('clock'),
};

const phone = window.matchMedia('(max-width: 640px)');
const touch = window.matchMedia('(pointer: coarse)');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Math.round(n).toLocaleString();
const fmtLat = (lat) => `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}`;
const fmtLng = (lng) => `${Math.abs(lng).toFixed(1)}° ${lng >= 0 ? 'E' : 'W'}`;
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

// --- Globe with a live day/night terminator -------------------------------

const globeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    dayTexture: { value: null },
    nightTexture: { value: null },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
    opacity: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D dayTexture;
    uniform sampler2D nightTexture;
    uniform vec3 sunDir;
    uniform float opacity;
    varying vec3 vNormal;
    varying vec2 vUv;
    void main() {
      float light = dot(normalize(vNormal), sunDir);
      // light is sin(sun elevation). Fully lit from sunrise (-0.83°, with refraction),
      // fading to night through civil twilight (-6°), so low winter sun still reads as day.
      float blend = smoothstep(-0.105, -0.015, light);
      vec3 day = texture2D(dayTexture, vUv).rgb * (0.75 + 0.25 * max(light, 0.0));
      vec3 night = texture2D(nightTexture, vUv).rgb;
      gl_FragColor = vec4(mix(night, day, blend), opacity);
    }`,
});

const loader = new THREE.TextureLoader();
loader.load(IMG + 'earth-blue-marble.jpg', (t) => (globeMaterial.uniforms.dayTexture.value = t));
loader.load(IMG + 'earth-night.jpg', (t) => (globeMaterial.uniforms.nightTexture.value = t));

const world = new Globe(ui.globe)
  .width(window.innerWidth)
  .height(window.innerHeight)
  .globeMaterial(globeMaterial)
  .backgroundImageUrl(IMG + 'night-sky.png')
  .atmosphereColor('#8db8ff')
  .atmosphereAltitude(0.15)
  .onGlobeClick(({ lat, lng }) => selectPoint({ lat, lng }))
  // Mirror world: land flipped to its antipode, plus cells with land on both sides.
  .polygonCapColor(() => 'rgba(124, 196, 232, 0.2)')
  .polygonSideColor(() => 'rgba(0, 0, 0, 0)')
  .polygonStrokeColor(() => 'rgba(124, 196, 232, 0.9)')
  .polygonAltitude(0.004)
  .polygonsTransitionDuration(300)
  .onPolygonClick((_, __, coords) => coords && selectPoint(coords))
  .pointRadius(0.35)
  .pointResolution(6)
  .pointsTransitionDuration(0)
  .pointLabel((d) => `${esc(d.country)} ↔ ${esc(d.partner)}`)
  .onPointHover((d) => highlightPair(d?.pair ?? null))
  .onPointClick((p) => tapPair({ lat: p.lat, lng: p.lng, pair: p.pair, text: `${p.country} ↔ ${p.partner}` }))
  // Pair labels are HTML so they stay legible on top of the dots; hidden when behind the globe.
  .htmlAltitude(0.01)
  .htmlTransitionDuration(0)
  .htmlElement(pairLabel)
  .htmlElementVisibilityModifier((el, visible) => {
    el.style.opacity = visible ? '1' : '0';
    el.style.pointerEvents = visible ? 'auto' : 'none';
  })
  // Same latitude / longitude lines through the selected point.
  .pathPoints('points')
  .pathPointLat((p) => p[0])
  .pathPointLng((p) => p[1])
  .pathColor(() => 'rgba(230, 233, 238, 0.75)')
  .pathStroke(0.4)
  .pathDashLength((d) => (d.kind === 'lng' ? 0.01 : 1))
  .pathDashGap((d) => (d.kind === 'lng' ? 0.006 : 0))
  .pathPointAlt(0.002)
  .pathTransitionDuration(0)
  .onPathClick((_, __, coords) => coords && selectPoint(coords));

world.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));
world.pointOfView({ lat: 20, lng: 10, altitude: phone.matches ? 3 : 2.4 });
const controls = world.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
ui.globe.addEventListener('pointerdown', () => (controls.autoRotate = false));

window.addEventListener('resize', () => world.width(window.innerWidth).height(window.innerHeight));

function setGlobeOpacity(o) {
  globeMaterial.uniforms.opacity.value = o;
  const transparent = o < 0.999;
  if (globeMaterial.transparent !== transparent) {
    globeMaterial.transparent = transparent;
    globeMaterial.depthWrite = !transparent;
    globeMaterial.needsUpdate = true;
  }
}

function updateSun() {
  const now = new Date();
  const sun = subsolarPoint(now);
  const c = world.getCoords(sun.lat, sun.lng, 0);
  globeMaterial.uniforms.sunDir.value.set(c.x, c.y, c.z).normalize();
  const hhmm = now.toISOString().slice(11, 16);
  ui.clock.textContent = ui.clockLayers.textContent = `Day and night shown for ${hhmm} UTC`;
}
updateSun();
setInterval(() => {
  updateSun();
  if (state === 'selected' || state === 'done') renderPanel();
}, 60_000);

// --- Pins ----------------------------------------------------------------

const pins = new Set();

function easeOutBounce(x) {
  const n = 7.5625;
  const d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}

function dropPin({ lat, lng }, color) {
  const c = world.getCoords(lat, lng, 0);
  const base = new THREE.Vector3(c.x, c.y, c.z);
  const normal = base.clone().normalize();

  // Local +z points away from the Earth.
  const pin = new THREE.Group();
  pin.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 5, 8).rotateX(Math.PI / 2).translate(0, 0, 2.5),
      new THREE.MeshStandardMaterial({ color: '#d9dde3', metalness: 0.5, roughness: 0.4 })
    ),
    new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 20, 14).translate(0, 0, 5.2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.45 })
    )
  );
  pin.position.copy(base);
  pin.lookAt(base.clone().multiplyScalar(2));
  pin.userData = { base, normal, age: 0 };
  world.scene().add(pin);
  pins.add(pin);
  return pin;
}

function removePin(pin) {
  if (!pin) return;
  world.scene().remove(pin);
  pin.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
  pins.delete(pin);
}

function updatePins(dt) {
  const camDist = world.camera().position.length();
  const scale = Math.min(1.6, Math.max(0.45, camDist / 220));
  for (const pin of pins) {
    const d = pin.userData;
    d.age += dt;
    const fall = 1 - easeOutBounce(Math.min(1, d.age / 0.9));
    pin.scale.setScalar(scale);
    pin.position.copy(d.base).addScaledVector(d.normal, fall * 25 * scale);
  }
}

// --- App state -----------------------------------------------------------

let state = 'idle'; // idle | selected | digging | done
// Places: { lat, lng, name, land, now, nearby, lines }
let start = null;
let end = null;
let exitInfo = null;
let pinA = null;
let pinB = null;
let flyToken = 0;

const digger = new Digger(world, { setGlobeOpacity, lite: phone.matches });

loadLand();
loadCities();

// Re-render when async details for a shown place arrive.
function refresh(place) {
  if ((place === start || place === end) && (state === 'selected' || state === 'done')) renderPanel();
}

function enrich(place) {
  fetchNow(place)
    .then((now) => (place.now = now), () => (place.now = { error: true }))
    .then(() => refresh(place));
  citiesNear(place).then((nearby) => {
    place.nearby = nearby ?? { error: true };
    refresh(place);
  });
}

function selectPoint(point, knownName) {
  if (state === 'digging') return;
  flyToken++;
  hideResults();
  hidePairBar();
  setLayersOpen(false);
  controls.autoRotate = false;
  digger.reset();
  removePin(pinA);
  removePin(pinB);
  pinB = null;

  const current = { lat: point.lat, lng: point.lng, name: knownName ?? null, land: undefined };
  start = current;
  end = antipode(start);
  const exit = end;
  exitInfo = describePlace(exit).then((info) => Object.assign(exit, info));
  pinA = dropPin(start, PIN_START);
  state = 'selected';
  applyLayers();
  setSheet(false);
  renderPanel();

  enrich(start);
  enrich(end);
  Promise.all([sameLatitude(current), sameLongitude(current)]).then(([lat, lng]) => {
    current.lines = { lat, lng };
    refresh(current);
  });
  const info = knownName
    ? isLand(current).then((land) => ({ land, name: knownName }))
    : describePlace(current);
  info.then((r) => {
    Object.assign(current, r);
    refresh(current);
  });
}

async function dig() {
  if (!start || state === 'digging') return;
  state = 'digging';
  document.body.classList.add('digging');
  hidePairBar();
  setLayersOpen(false);
  removePin(pinB);
  pinB = null;
  applyLayers();
  ui.panel.hidden = true;
  ui.hud.hidden = false;
  ui.skip.hidden = false;
  ui.searchInput.disabled = true;
  hideResults();

  const [startLand, endLand] = await Promise.all([isLand(start), isLand(end)]);
  digger.run(start, end, { startLand, endLand }, {
    onStage: setStage,
    onTelemetry: renderTelemetry,
    onShake: (px) =>
      (ui.globe.style.transform = px ? `translate(${(Math.random() - 0.5) * 2 * px}px, ${(Math.random() - 0.5) * 2 * px}px)` : ''),
    onHeat: (v) => (ui.flash.style.opacity = String(v * 0.22)),
    onArrive: () => (pinB = dropPin(end, PIN_END)),
    onDone: async () => {
      ui.skip.hidden = true;
      ui.searchInput.disabled = false;
      await exitInfo;
      state = 'done';
      document.body.classList.remove('digging');
      ui.hud.hidden = true;
      applyLayers();
      setSheet(false);
      renderPanel();
    },
  });
}

function clearSelection() {
  flyToken++;
  digger.reset();
  removePin(pinA);
  removePin(pinB);
  pinA = pinB = null;
  start = end = exitInfo = null;
  state = 'idle';
  applyLayers();
  renderPanel();
}

// --- Map layers ----------------------------------------------------------

const layers = { mirror: false, lines: false };
let mirror = null; // { features, points, labels, pairs, overlap }
let hoverPair = null;

// Lights up every dot of a country pair, at both ends of the Earth.
function highlightPair(key) {
  hoverPair = key;
  world
    .pointColor((d) => (d.pair === hoverPair ? PIN_START : 'rgba(124, 196, 232, 0.8)'))
    .pointAltitude((d) => (d.pair === hoverPair ? 0.02 : 0.006));
  document.querySelectorAll('.pair-label').forEach((el) => el.classList.toggle('active', el.dataset.pair === key));
}

function pairLabel(d) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'pair-label';
  el.dataset.pair = d.pair;
  el.textContent = d.text;
  el.addEventListener('click', () => tapPair(d));
  el.addEventListener('pointerenter', () => !touch.matches && highlightPair(d.pair));
  el.addEventListener('pointerleave', () => !touch.matches && highlightPair(null));
  return el;
}

// With a mouse, clicking a dot or label selects it. On touch there's no hover, so a tap
// first names and highlights the pair in a bar with a "Dig here" button.
let pendingPair = null;

function tapPair(d) {
  if (!touch.matches) return selectPoint({ lat: d.lat, lng: d.lng });
  pendingPair = d;
  setLayersOpen(false);
  highlightPair(d.pair);
  ui.pairText.textContent = d.text;
  ui.pairBar.hidden = false;
}

function hidePairBar() {
  if (ui.pairBar.hidden) return;
  ui.pairBar.hidden = true;
  pendingPair = null;
  highlightPair(null);
}

ui.pairDig.addEventListener('click', () => {
  const d = pendingPair;
  if (!d) return;
  selectPoint({ lat: d.lat, lng: d.lng });
  dig();
});
ui.pairClose.addEventListener('click', hidePairBar);
highlightPair(null);

// The biggest pairs between named countries, each labelled at both ends.
function mirrorPairs(overlap) {
  if (!overlap) return { pairs: [], labels: [] };
  const pairs = overlap.pairs
    .filter((p) => p.ends.length === 2 && p.ends.every((e) => !e.country.startsWith('Island in')))
    .slice(0, phone.matches ? 6 : 12);
  const labels = pairs.flatMap(({ key, ends: [a, b] }) => [
    { pair: key, lat: a.lat, lng: a.lng, text: `${a.country} ↔ ${b.country}` },
    { pair: key, lat: b.lat, lng: b.lng, text: `${b.country} ↔ ${a.country}` },
  ]);
  return { pairs, labels };
}

function renderPairList() {
  const list = $('mirror-pairs');
  const pairs = mirror?.pairs.slice(0, 8) ?? [];
  list.hidden = !layers.mirror || !pairs.length;
  list.innerHTML = `
    <p class="muted">Biggest land-to-land pairs</p>
    <ol>${pairs
      .map(
        ({ ends: [a, b] }, i) =>
          `<li><button type="button" data-pair="${i}">${esc(a.country)} ↔ ${esc(b.country)}</button></li>`
      )
      .join('')}</ol>`;
}

$('mirror-pairs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pair]');
  if (!btn) return;
  const { ends } = mirror.pairs[+btn.dataset.pair];
  goTo({ lat: ends[0].lat, lng: ends[0].lng });
});

function linePaths(p) {
  const parallel = [];
  for (let lng = -180; lng <= 180; lng += 2) parallel.push([p.lat, lng]);
  // The meridian is a full great circle, so it also runs through the antipode.
  const meridian = [];
  for (let lat = -90; lat <= 90; lat += 2) meridian.push([lat, p.lng]);
  for (let lat = 90; lat >= -90; lat -= 2) meridian.push([lat, p.lng + 180]);
  return [
    { kind: 'lat', points: parallel },
    { kind: 'lng', points: meridian },
  ];
}

function applyLayers() {
  const show = state !== 'digging';
  ui.layers.hidden = !show;
  const showMirror = show && layers.mirror && mirror;
  world.polygonsData(showMirror ? mirror.features : []);
  world.pointsData(showMirror ? mirror.points : []);
  world.htmlElementsData(showMirror ? mirror.labels : []);
  world.pathsData(show && layers.lines && start ? linePaths(start) : []);
}

function renderMirrorNote() {
  ui.mirrorNote.hidden = !layers.mirror;
  if (!mirror) {
    ui.mirrorNote.textContent = 'Flipping the continents…';
    return;
  }
  ui.mirrorNote.textContent = mirror.overlap
    ? `Only ${(mirror.overlap.landShare * 100).toFixed(1)}% of land has land directly opposite.`
    : '';
  ui.mirrorNote.hidden = !layers.mirror || !mirror.overlap;
}

// Info tooltips show on hover and focus via CSS; a click toggles them for touch screens.
function closeTips(except) {
  ui.layers.querySelectorAll('.switch-row.open').forEach((row) => row !== except && row.classList.remove('open'));
}

ui.layers.addEventListener('click', (e) => {
  const row = e.target.closest('.info')?.closest('.switch-row');
  if (!row) return;
  closeTips(row);
  row.classList.toggle('open');
});

ui.toggleMirror.addEventListener('change', async () => {
  layers.mirror = ui.toggleMirror.checked;
  renderMirrorNote();
  renderPairList();
  if (layers.mirror && !mirror) {
    const [features, overlap] = await Promise.all([loadMirrorLand(), landOverlap()]);
    mirror = { features, points: overlap?.points ?? [], overlap, ...mirrorPairs(overlap) };
    renderMirrorNote();
    renderPairList();
  }
  applyLayers();
});

ui.toggleLines.addEventListener('change', () => {
  layers.lines = ui.toggleLines.checked;
  applyLayers();
  if (state === 'selected' || state === 'done') renderPanel();
});

// --- Panel ---------------------------------------------------------------

const collapsed = new Set();

function section(key, title, body) {
  return `
    <details class="section" data-section="${key}" ${collapsed.has(key) ? '' : 'open'}>
      <summary>${title}</summary>
      ${body}
    </details>`;
}

function rows(list) {
  return `<dl class="rows">${list.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

function nearbyRow(p) {
  const c = p.nearby;
  if (!c) return ['Nearby', '<span class="muted">Looking…</span>'];
  if (c.error) return ['Nearby', '<span class="muted">Unavailable</span>'];
  if (c.near.length) return ['Big cities nearby', c.near.map((x) => `${esc(x.name)} (${fmt(x.km)} km)`).join(', ')];
  const n = c.nearest;
  return ['Nearest city', `${esc(n.name)}, ${esc(n.country)}, ${fmt(n.km)} km away`];
}

function nowSection(key, p) {
  const n = p.now;
  const season = seasonAt(p.lat);
  const list = [];
  if (!n) list.push(['Local time', '<span class="muted">Checking…</span>']);
  else if (n.error) list.push(['Conditions', '<span class="muted">Unavailable right now</span>']);
  else {
    list.push(
      ['Local time', `${localTime(n.offsetSec)} ${esc(n.tz)} · ${n.isDay ? 'daytime' : 'night'}`],
      ['Weather', `${Math.round(n.tempC)} °C, ${n.weather}, wind ${Math.round(n.windKmh)} km/h`],
      ['Daylight', daylightText(n)]
    );
  }
  list.push(['Season', season ? capitalize(season) : 'Tropics, little seasonal change'], nearbyRow(p));
  return section(key, 'Right now', rows(list));
}

function placeBlock(label, p, color, key) {
  const land = p.land === true ? 'Land' : p.land === false ? oceanName(p) : '';
  return `
    <div class="place">
      <div class="label"><span class="dot" style="background:${color}"></span>${label}</div>
      <h2>${p.name ? esc(p.name) : '<span class="muted">Locating…</span>'}</h2>
      <p class="coords">${formatCoords(p)}</p>
      ${land ? `<p class="muted">${land}</p>` : ''}
      ${nowSection(key, p)}
    </div>`;
}

function cityList(items, detail) {
  if (!items.length) return '<p class="muted">No major cities near this line.</p>';
  return `<ul class="cities">${items
    .map(
      (c) => `
      <li>
        <button type="button" data-action="goto" data-lat="${c.lat}" data-lng="${c.lng}" data-name="${esc(`${c.name}, ${c.country}`)}">
          ${esc(c.name)}<span class="muted">, ${esc(c.country)}</span>
        </button>
        <span class="muted">${detail(c)}</span>
      </li>`
    )
    .join('')}</ul>`;
}

function linesSections(p) {
  if (!layers.lines) return '';
  const loading = '<p class="muted">Finding cities on this line…</p>';
  return `
    <div class="lines">
      ${section('lat', `Same latitude, ${fmtLat(p.lat)}`, p.lines ? cityList(p.lines.lat, (c) => fmtLng(c.lng)) : loading)}
      ${section(
        'lng',
        `Same longitude, ${fmtLng(p.lng)}`,
        p.lines ? cityList(p.lines.lng, (c) => fmtLat(c.lat) + (c.farSide ? ', far side' : '')) : loading
      )}
    </div>`;
}

function facts() {
  const a = seasonAt(start.lat);
  const b = seasonAt(end.lat);
  const seasons = a && b
    ? `It's ${a} where you started and ${b} on the other side, and your daylight hours and theirs always add up to about 24.`
    : 'Both ends are in the tropics, where days stay close to 12 hours all year.';
  return `<p class="facts">${EARTH_DIAMETER_KM.toLocaleString()} km straight through the centre. Falling freely, the trip would take about 42 minutes. ${seasons}</p>`;
}

// Phones show the panel as a bottom sheet: collapsed to the place name and actions,
// expanded by tapping or dragging the handle. Desktop ignores the collapsed class.
function setSheet(expanded) {
  ui.panel.classList.toggle('collapsed', !expanded);
  ui.sheetHandle.setAttribute('aria-expanded', String(expanded));
  ui.sheetHandle.setAttribute('aria-label', expanded ? 'Show less' : 'Show more');
  if (!expanded) ui.panel.scrollTop = 0;
}

let dragStartY = null;
ui.sheetHandle.addEventListener('pointerdown', (e) => {
  dragStartY = e.clientY;
  ui.sheetHandle.setPointerCapture(e.pointerId);
});
ui.sheetHandle.addEventListener('pointerup', (e) => {
  if (dragStartY === null) return;
  const dy = e.clientY - dragStartY;
  dragStartY = null;
  setSheet(Math.abs(dy) < 10 ? ui.panel.classList.contains('collapsed') : dy < 0);
});

// One-time notice on phones; dismissal is remembered when storage is available.
const NOTE_KEY = 'gol.mobileNoteDismissed';
let noteDismissed = false;
try {
  noteDismissed = localStorage.getItem(NOTE_KEY) === '1';
} catch {}
$('mobile-note').hidden = !phone.matches || noteDismissed;
$('mobile-note-ok').addEventListener('click', () => {
  $('mobile-note').hidden = true;
  try {
    localStorage.setItem(NOTE_KEY, '1');
  } catch {}
});

function setLayersOpen(open) {
  document.body.classList.toggle('layers-open', open);
  ui.layersBtn.setAttribute('aria-expanded', String(open));
}

ui.layersBtn.addEventListener('click', () => {
  hidePairBar();
  setLayersOpen(!document.body.classList.contains('layers-open'));
});

function renderPanel() {
  ui.panel.hidden = false;
  ui.panelBody.dataset.state = state;
  if (state === 'idle') {
    ui.panelBody.innerHTML = `
      <h2>Pick a starting point</h2>
      <p class="muted">Click anywhere on the globe, or search for a place, then dig straight down to see where you come out.</p>`;
  } else if (state === 'selected') {
    ui.panelBody.innerHTML = `
      ${placeBlock('Start', start, PIN_START, 'now-start')}
      <div class="actions">
        <button class="primary" data-action="dig">Dig straight down</button>
        <button class="ghost" data-action="clear">Clear</button>
      </div>
      ${linesSections(start)}`;
  } else if (state === 'done') {
    ui.panelBody.innerHTML = `
      ${placeBlock('You started at', start, PIN_START, 'now-start')}
      ${placeBlock('You came out at', end, PIN_END, 'now-end')}
      ${facts()}
      <div class="actions">
        <button class="primary" data-action="dig">Replay</button>
        <button class="ghost" data-action="clear">Pick another spot</button>
      </div>
      ${linesSections(start)}`;
  }
}

ui.panel.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  const action = btn?.dataset.action;
  if (action === 'dig') dig();
  if (action === 'clear') clearSelection();
  if (action === 'goto') goTo({ lat: +btn.dataset.lat, lng: +btn.dataset.lng, name: btn.dataset.name });
});

// `toggle` doesn't bubble, so listen in the capture phase.
ui.panel.addEventListener(
  'toggle',
  (e) => {
    const key = e.target.dataset?.section;
    if (key) e.target.open ? collapsed.delete(key) : collapsed.add(key);
  },
  true
);

ui.skip.addEventListener('click', () => digger.skip());

// --- HUD -----------------------------------------------------------------

function setStage(text) {
  ui.stage.textContent = text;
  ui.stage.classList.remove('enter');
  void ui.stage.offsetWidth;
  ui.stage.classList.add('enter');
}

const readout = Object.fromEntries(
  [...ui.readouts.querySelectorAll('[data-key]')].map((el) => [el.dataset.key, el])
);

function renderTelemetry(d) {
  ui.marker.style.setProperty('--s', d.s);
  const mm = Math.floor(d.tripSeconds / 60);
  const ss = String(Math.floor(d.tripSeconds % 60)).padStart(2, '0');
  readout.layer.textContent = d.layer;
  readout.depth.textContent = `${fmt(d.depthKm)} km`;
  readout.temp.textContent = `${fmt(d.tempC)} °C`;
  readout.speed.textContent = `${d.speedKms.toFixed(2)} km/s`;
  readout.time.textContent = `${mm}:${ss}`;
  readout.dist.textContent = `${fmt(d.distKm)} km`;
}

// Depth gauge: the full diameter, crust to crust.
const gauge = $('gauge-bands');
const [inner, outer, mantle, crust] = LAYERS;
[
  [crust, 0],
  [mantle, mantle.r - outer.r],
  [outer, outer.r - inner.r],
  [inner, inner.r * 2],
  [outer, outer.r - inner.r],
  [mantle, mantle.r - outer.r],
  [crust, 0],
].forEach(([layer, thickness], i) => {
  const band = document.createElement('div');
  band.className = 'band';
  band.style.background = layer.color;
  band.style.flex = thickness ? `${thickness} 1 0` : '0 0 3px';
  if (i > 0 && i <= 3) band.dataset.label = layer.name;
  gauge.append(band);
});

// --- Search --------------------------------------------------------------

// Results are { lat, lng, name, detail, title }, from Photon suggestions or a Nominatim search.
let results = [];
let active = -1;
let suggestTimer;
let suggestAbort;

function hideResults() {
  ui.searchResults.hidden = true;
  ui.searchResults.innerHTML = '';
  results = [];
  active = -1;
}

function showResults(list) {
  if (!list.length) return hideResults();
  results = list;
  active = -1;
  ui.searchResults.innerHTML = list
    .map(
      (r, i) => `
      <li>
        <button type="button" data-index="${i}" tabindex="-1">
          <span>${esc(r.name)}</span>
          ${r.detail ? `<span class="muted">${esc(r.detail)}</span>` : ''}
        </button>
      </li>`
    )
    .join('');
  ui.searchResults.hidden = false;
}

function highlight(i) {
  active = i;
  ui.searchResults.querySelectorAll('button').forEach((b, j) => b.classList.toggle('current', j === i));
}

function pick(r) {
  hideResults();
  ui.searchInput.value = r.title;
  goTo(r);
}

function goTo(r) {
  if (state === 'digging') return;
  const token = ++flyToken;
  controls.autoRotate = false;
  world.pointOfView({ lat: r.lat, lng: r.lng, altitude: 1.6 }, 1600);
  setTimeout(() => {
    if (token === flyToken) selectPoint(r, r.title ?? r.name);
  }, 1650);
}

ui.searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  suggestAbort?.abort();
  ui.searchStatus.textContent = '';
  const q = ui.searchInput.value.trim();
  if (q.length < 3) return hideResults();
  suggestTimer = setTimeout(async () => {
    suggestAbort = new AbortController();
    try {
      const list = await suggestPlaces(q, suggestAbort.signal);
      if (ui.searchInput.value.trim() === q) showResults(list);
    } catch {
      // Aborted or failed; Enter still falls back to a full search.
    }
  }, 250);
});

ui.searchInput.addEventListener('keydown', (e) => {
  const n = results.length;
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault();
    highlight((active + 1) % n);
  } else if (e.key === 'ArrowUp' && n) {
    e.preventDefault();
    highlight((active - 1 + n) % n);
  }
});

ui.searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = ui.searchInput.value.trim();
  if (!q || state === 'digging') return;
  if (results.length) return pick(results[Math.max(0, active)]);

  clearTimeout(suggestTimer);
  suggestAbort?.abort();
  ui.searchStatus.textContent = 'Searching…';
  let found;
  try {
    found = await searchPlaces(q);
  } catch {
    ui.searchStatus.textContent = 'Search failed. Try again in a moment.';
    return;
  }
  if (!found.length) {
    ui.searchStatus.textContent = 'No matches found.';
    return;
  }
  ui.searchStatus.textContent = '';
  if (found.length === 1) return pick(found[0]);
  showResults(found);
  highlight(0);
});

ui.searchResults.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-index]');
  if (btn) pick(results[+btn.dataset.index]);
});

document.addEventListener('pointerdown', (e) => {
  if (!ui.searchForm.contains(e.target)) hideResults();
  if (!e.target.closest('.switch-row')) closeTips();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideResults();
    closeTips();
  }
});

// --- Main loop -----------------------------------------------------------

let last = performance.now();
requestAnimationFrame(function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  digger.update(dt);
  updatePins(dt);
  requestAnimationFrame(frame);
});

renderPanel();
