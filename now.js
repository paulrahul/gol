// "Right now" at a place: local time, weather and daylight from Open-Meteo, plus the season.

const WEATHER_CODES = [
  [0, 'clear sky'],
  [1, 'mainly clear'],
  [2, 'partly cloudy'],
  [3, 'overcast'],
  [48, 'fog'],
  [55, 'drizzle'],
  [57, 'freezing drizzle'],
  [65, 'rain'],
  [67, 'freezing rain'],
  [77, 'snow'],
  [82, 'rain showers'],
  [86, 'snow showers'],
  [95, 'thunderstorm'],
  [99, 'thunderstorm with hail'],
];

const weatherLabel = (code) => WEATHER_CODES.find(([max]) => code <= max)?.[1] ?? 'unknown';

export async function fetchNow({ lat, lng }) {
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    '&current=temperature_2m,weather_code,wind_speed_10m,is_day' +
    '&daily=sunrise,sunset,daylight_duration&timezone=auto&forecast_days=1';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  const d = await res.json();
  return {
    offsetSec: d.utc_offset_seconds,
    tz: d.timezone_abbreviation,
    isDay: Boolean(d.current.is_day),
    tempC: d.current.temperature_2m,
    weather: weatherLabel(d.current.weather_code),
    windKmh: d.current.wind_speed_10m,
    sunrise: d.daily.sunrise?.[0]?.slice(11, 16),
    sunset: d.daily.sunset?.[0]?.slice(11, 16),
    daylightSec: d.daily.daylight_duration?.[0] ?? null,
  };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

export function localTime(offsetSec, date = new Date()) {
  const d = new Date(date.getTime() + offsetSec * 1000);
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function daylightText({ daylightSec, sunrise, sunset }) {
  if (daylightSec == null) return 'Unknown';
  if (daylightSec <= 60) return 'Polar night, no sunrise today';
  if (daylightSec >= 86340) return 'Midnight sun, no sunset today';
  const minutes = Math.round(daylightSec / 60);
  return `${sunrise}–${sunset}, ${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

// Astronomical seasons; null inside the tropics, where four seasons don't really apply.
export function seasonAt(lat, date = new Date()) {
  if (Math.abs(lat) < 23.44) return null;
  const md = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const north = md < 320 || md >= 1221 ? 'winter' : md < 621 ? 'spring' : md < 922 ? 'summer' : 'autumn';
  if (lat > 0) return north;
  return { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' }[north];
}
