// Cities from Natural Earth populated places: nearby cities and cities on the same lines.
import { distanceKm, wrapLng } from './geo.js';

const CITIES_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson';

let cities;

export function loadCities() {
  cities ??= fetch(CITIES_URL)
    .then((r) => r.json())
    .then((fc) =>
      fc.features.map((f) => {
        const p = f.properties;
        const [lng, lat] = f.geometry.coordinates;
        return { name: p.name, country: p.adm0name, pop: p.pop_max || 0, lat, lng };
      })
    )
    .catch(() => []);
  return cities;
}

// The biggest cities within `radiusKm`, plus the single nearest city.
export async function citiesNear(point, radiusKm = 500, limit = 3) {
  const all = await loadCities();
  if (!all.length) return null;
  const withKm = all.map((c) => ({ ...c, km: distanceKm(point, c) }));
  const near = withKm
    .filter((c) => c.km <= radiusKm)
    .sort((a, b) => b.pop - a.pop)
    .slice(0, limit);
  const nearest = withKm.reduce((a, b) => (b.km < a.km ? b : a));
  return { near, nearest };
}

// Most populous candidates first, skipping any too close to one already picked.
function spread(candidates, tooClose, limit = 6) {
  const picked = [];
  for (const c of [...candidates].sort((a, b) => b.pop - a.pop)) {
    if (picked.every((p) => !tooClose(p, c))) picked.push(c);
    if (picked.length === limit) break;
  }
  return picked;
}

// Cities around the parallel through `point`, ordered eastward from it.
export async function sameLatitude(point) {
  const all = (await loadCities()).filter((c) => distanceKm(point, c) > 300);
  const east = (c) => (c.lng - point.lng + 360) % 360;
  let picked = [];
  for (const tolerance of [1, 2.5]) {
    picked = spread(
      all.filter((c) => Math.abs(c.lat - point.lat) <= tolerance),
      (a, b) => Math.abs(wrapLng(a.lng - b.lng)) < 20
    );
    if (picked.length >= 4) break;
  }
  return picked.sort((a, b) => east(a) - east(b));
}

// Cities around the meridian through `point`, including its other half through the antipode.
// Ordered north to south on the near side, then the far side.
export async function sameLongitude(point) {
  const all = (await loadCities()).filter((c) => distanceKm(point, c) > 300);
  let picked = [];
  for (const tolerance of [1, 2.5]) {
    const candidates = all
      .map((c) => {
        if (Math.abs(wrapLng(c.lng - point.lng)) <= tolerance) return { ...c, farSide: false };
        if (Math.abs(wrapLng(c.lng - point.lng - 180)) <= tolerance) return { ...c, farSide: true };
        return null;
      })
      .filter(Boolean);
    picked = spread(candidates, (a, b) => a.farSide === b.farSide && Math.abs(a.lat - b.lat) < 8);
    if (picked.length >= 4) break;
  }
  return picked.sort((a, b) => a.farSide - b.farSide || b.lat - a.lat);
}
