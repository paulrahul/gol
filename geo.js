// Geography helpers: antipodes, sun position, geocoding and land/ocean lookup.

export const EARTH_RADIUS_KM = 6371;
export const EARTH_DIAMETER_KM = EARTH_RADIUS_KM * 2;

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io/api/';
const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const LAND_URL = NATURAL_EARTH + 'ne_50m_land.geojson';
const LAND_OUTLINE_URL = NATURAL_EARTH + 'ne_110m_land.geojson';
const COUNTRIES_URL = NATURAL_EARTH + 'ne_50m_admin_0_countries.geojson';

const RAD = Math.PI / 180;

export const wrapLng = (lng) => (((lng % 360) + 540) % 360) - 180;

export function antipode({ lat, lng }) {
  return { lat: -lat, lng: wrapLng(lng + 180) };
}

// Point on Earth where the sun is directly overhead (low-precision almanac formula).
export function subsolarPoint(date = new Date()) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
  const gmstHours = 18.697374558 + 24.06570982441908 * d;
  return { lat: dec, lng: wrapLng(ra - gmstHours * 15) };
}

export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatCoords({ lat, lng }) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
}

// Rough ocean naming by region; good enough for a label.
export function oceanName({ lat, lng }) {
  if (lat <= -60) return 'Southern Ocean';
  if (lat >= 66) return 'Arctic Ocean';
  if (lat > 30 && lat < 46 && lng > -6 && lng < 37) return 'Mediterranean Sea';
  if (lng >= -70 && lng < 20) return 'Atlantic Ocean';
  if (lng >= -100 && lng < -70 && lat > 8 && lat < 32) return 'Atlantic Ocean';
  if (lng >= 20 && lng < 100 && lat < 30) return 'Indian Ocean';
  if (lng >= 100 && lng < 147 && lat < -10) return 'Indian Ocean';
  return 'Pacific Ocean';
}

// --- Nominatim (OpenStreetMap). Usage policy allows at most 1 request per second.

let queue = Promise.resolve();

function nominatim(path) {
  const request = queue.then(() =>
    fetch(NOMINATIM + path).then((res) => {
      if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
      return res.json();
    })
  );
  queue = request.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return request;
}

export async function searchPlaces(query) {
  const data = await nominatim(
    `/search?format=jsonv2&limit=5&accept-language=en&q=${encodeURIComponent(query)}`
  );
  return data.map((r) => {
    const parts = r.display_name.split(', ');
    return {
      lat: +r.lat,
      lng: +r.lon,
      name: parts[0],
      detail: parts.slice(1, 4).join(', '),
      title: parts.slice(0, 3).join(', '),
    };
  });
}

// --- Photon (komoot), built for type-ahead; Nominatim's policy forbids autocomplete.

export async function suggestPlaces(query, signal) {
  const res = await fetch(`${PHOTON}?q=${encodeURIComponent(query)}&limit=6&lang=en`, { signal });
  if (!res.ok) throw new Error(`Suggestions returned ${res.status}`);
  const fc = await res.json();
  return fc.features.map((f) => {
    const p = f.properties;
    const [lng, lat] = f.geometry.coordinates;
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || p.country;
    const detail = [...new Set([p.city, p.state, p.country])].filter((x) => x && x !== name).join(', ');
    const title = [name, p.country !== name ? p.country : null].filter(Boolean).join(', ');
    return { lat, lng, name, detail, title };
  });
}

export async function reverseGeocode({ lat, lng }) {
  try {
    const d = await nominatim(
      `/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`
    );
    if (d.error) return null;
    const a = d.address || {};
    const local =
      a.city || a.town || a.village || a.municipality || a.county || a.state_district || a.state;
    return [local, a.country].filter(Boolean).join(', ') || d.display_name || null;
  } catch {
    return null;
  }
}

// --- Land / ocean, using Natural Earth 1:50m land polygons.

const polygonsOf = (fc) =>
  fc.features.flatMap((f) =>
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
  );

// Buckets polygons ({ rings, name? }) into 1° latitude bands so lookups only test nearby shapes.
function buildIndex(entries) {
  const bands = Array.from({ length: 180 }, () => []);
  for (const entry of entries) {
    let minX = 180, maxX = -180, minY = 90, maxY = -90;
    for (const [x, y] of entry.rings[0]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const poly = { ...entry, minX, maxX, minY, maxY };
    for (let b = Math.max(0, Math.floor(minY + 90)); b <= Math.min(179, Math.floor(maxY + 90)); b++) {
      bands[b].push(poly);
    }
  }
  return bands;
}

let landIndex;

export function loadLand() {
  landIndex ??= fetch(LAND_URL)
    .then((r) => r.json())
    .then((fc) => buildIndex(polygonsOf(fc).map((rings) => ({ rings }))))
    .catch(() => null);
  return landIndex;
}

let countryIndex;

export function loadCountries() {
  countryIndex ??= fetch(COUNTRIES_URL)
    .then((r) => r.json())
    .then((fc) =>
      buildIndex(
        fc.features.flatMap((f) => {
          const name = f.properties.NAME ?? f.properties.ADMIN ?? f.properties.name;
          return polygonsOf({ features: [f] }).map((rings) => ({ rings, name }));
        })
      )
    )
    .catch(() => null);
  return countryIndex;
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function findIn(bands, { lat, lng }) {
  const band = bands[Math.min(179, Math.max(0, Math.floor(lat + 90)))];
  return band.find(
    ({ rings: [outer, ...holes], minX, maxX, minY, maxY }) =>
      lng >= minX && lng <= maxX && lat >= minY && lat <= maxY &&
      inRing(outer, lng, lat) && !holes.some((h) => inRing(h, lng, lat))
  );
}

const isLandIn = (bands, point) => Boolean(findIn(bands, point));

// Country name at a land point; small islands missing from the outlines get their ocean.
const countryIn = (bands, point) =>
  (bands && findIn(bands, point)?.name) || `Island in the ${oceanName(point)}`;

// Average position of points, via 3D vectors so groups straddling ±180° work.
function centroid(points) {
  let x = 0, y = 0, z = 0;
  for (const { lat, lng } of points) {
    x += Math.cos(lat * RAD) * Math.cos(lng * RAD);
    y += Math.cos(lat * RAD) * Math.sin(lng * RAD);
    z += Math.sin(lat * RAD);
  }
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lng: Math.atan2(y, x) / RAD };
}

// Resolves to true/false, or null when the land data could not be loaded.
export async function isLand(point) {
  const bands = await loadLand();
  return bands ? isLandIn(bands, point) : null;
}

export async function describePlace(point) {
  const [land, name] = await Promise.all([isLand(point), reverseGeocode(point)]);
  if (land === false) {
    const ocean = oceanName(point);
    return { land, name: name ? `${ocean}, off ${name}` : ocean };
  }
  return { land, name: name || 'Remote land' };
}

// --- Mirror world ---------------------------------------------------------

let mirrorLand;

// Every landmass moved to its antipode, as GeoJSON features. Each polygon is shifted by
// ±180° as a whole (not wrapped) so it stays continuous, and rings are reversed because
// the antipodal flip mirrors their winding.
export function loadMirrorLand() {
  mirrorLand ??= fetch(LAND_OUTLINE_URL)
    .then((r) => r.json())
    .then((fc) =>
      polygonsOf(fc).map((rings) => {
        const meanLng = rings[0].reduce((sum, [x]) => sum + x, 0) / rings[0].length;
        const shift = meanLng < 0 ? 180 : -180;
        return {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: rings.map((ring) => ring.map(([x, y]) => [x + shift, -y]).reverse()),
          },
        };
      })
    )
    .catch(() => []);
  return mirrorLand;
}

let overlap;

// Samples a 1° grid for land cells whose antipode is also land, and groups them by
// country pair. Points are { lat, lng, country, partner, pair }; pairs are sorted by area.
export function landOverlap() {
  overlap ??= Promise.all([loadLand(), loadCountries()]).then(([bands, countries]) => {
    if (!bands) return null;
    const points = [];
    const pairs = new Map();
    let surface = 0;
    let land = 0;
    let both = 0;
    for (let lat = -89.5; lat < 90; lat++) {
      const w = Math.cos(lat * RAD);
      for (let lng = -179.5; lng < 180; lng++) {
        surface += w;
        if (!isLandIn(bands, { lat, lng })) continue;
        land += w;
        const opposite = antipode({ lat, lng });
        if (!isLandIn(bands, opposite)) continue;
        both += w;
        const country = countryIn(countries, { lat, lng });
        const partner = countryIn(countries, opposite);
        const key = [country, partner].sort().join(' ↔ ');
        if (!pairs.has(key)) pairs.set(key, { key, weight: 0, ends: new Map() });
        const pair = pairs.get(key);
        pair.weight += w;
        if (!pair.ends.has(country)) pair.ends.set(country, []);
        pair.ends.get(country).push({ lat, lng });
        points.push({ lat, lng, country, partner, pair: key });
      }
    }
    const ranked = [...pairs.values()]
      .sort((a, b) => b.weight - a.weight)
      .map(({ key, weight, ends }) => ({
        key,
        weight,
        ends: [...ends].map(([country, pts]) => ({ country, ...centroid(pts) })),
      }));
    return { points, pairs: ranked, landShare: both / land, surfaceShare: both / surface };
  });
  return overlap;
}
