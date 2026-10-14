/**
 * Group by (plan 53, ODDHALLS_LAYOUT_PLAN 3 "Groupings"): labelled sections of a photo list by capture hour, day,
 * camera, lens or place, from the folder index's facts (plans 38 and 52). The Cull grid draws them as divider rows and
 * the Design filmstrip (plan 56) reuses them; plan 39's bursts are a different thing (they change cells, these only
 * add dividers).
 *
 * Pure: no editor import. `taken` is the camera's wall clock stored as UTC epoch ms, so hours and days are read with
 * the UTC getters (the clock the photographer saw, whatever the machine's time zone). Place is coordinates until an
 * offline geocoder exists (IMPLEMENTATION_PLAN_38-56 section 1).
 */

/** What a grouping groups on. */
export type GroupByKey = 'hour' | 'day' | 'camera' | 'lens' | 'place';

/** Every key, in the order the menus list them. */
export const GROUP_BY_KEYS: readonly GroupByKey[] = ['hour', 'day', 'camera', 'lens', 'place'];

export const GROUP_BY_LABELS: Record<GroupByKey, string> = {
  hour: 'Hour',
  day: 'Day',
  camera: 'Camera',
  lens: 'Lens',
  place: 'Place',
};

/** One photo as Group by sees it: the caller's id and the index facts it reads (extra fields are ignored). */
export interface GroupByEntry {
  id: string;
  /** Capture time, epoch ms of the camera's clock read as UTC. */
  taken?: number;
  make?: string;
  model?: string;
  lens?: string;
  /** Decimal degrees. */
  gps?: { lat: number; lon: number };
}

/** One section: a stable key, the divider's label and the ids in it, in the input's order. */
export interface GroupBySection {
  key: string;
  label: string;
  ids: string[];
}

/** Two photos within this distance of a place's first photo are the same place, metres. */
export const PLACE_RADIUS_M = 500;

/** The key of the section holding photos without the fact (always the last section). */
export const MISSING_KEY = '';

const MISSING_LABELS: Record<GroupByKey, string> = {
  hour: 'No capture time',
  day: 'No capture time',
  camera: 'Unknown camera',
  lens: 'Unknown lens',
  place: 'No location',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "Mon 14 Sep 2026", from the UTC fields (the camera's clock). */
function dayLabel(d: Date): string {
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14 Sep 2026 · 18:00". */
function hourLabel(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${pad2(d.getUTCHours())}:00`;
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The camera's name: the model, after the make unless the model already starts with it ("Canon EOS R6"). */
export function cameraName(make: string | undefined, model: string | undefined): string | undefined {
  const mk = make?.trim() ?? '';
  const md = model?.trim() ?? '';
  if (!md) return mk || undefined;
  if (!mk || md.toLowerCase().startsWith(mk.toLowerCase())) return md;
  return `${mk} ${md}`;
}

/** "38.714° N, 9.139° W". */
export function coordinatesLabel(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`;
}

/** Great-circle distance between two positions, metres. */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const validGps = (g: GroupByEntry['gps']): g is { lat: number; lon: number } =>
  !!g && Number.isFinite(g.lat) && Number.isFinite(g.lon);

/**
 * The sections of `entries` by `key`, in the order each section first appears in `entries`, ids in input order; the
 * photos without the fact are one last section (`MISSING_KEY`). A place is the first photo of it plus every later
 * photo within `PLACE_RADIUS_M` of that photo (the first such place in order), labelled by its first photo's
 * coordinates.
 */
export function groupBy(entries: readonly GroupByEntry[], key: GroupByKey): GroupBySection[] {
  const sections: GroupBySection[] = [];
  const byKey = new Map<string, GroupBySection>();
  const missing: string[] = [];
  const places: { at: { lat: number; lon: number }; section: GroupBySection }[] = [];
  const put = (k: string, label: string, id: string) => {
    let section = byKey.get(k);
    if (!section) {
      section = { key: k, label, ids: [] };
      byKey.set(k, section);
      sections.push(section);
    }
    section.ids.push(id);
  };
  for (const e of entries) {
    switch (key) {
      case 'hour':
      case 'day': {
        if (e.taken === undefined || !Number.isFinite(e.taken)) {
          missing.push(e.id);
          break;
        }
        const d = new Date(e.taken);
        if (key === 'day') put(dayKey(d), dayLabel(d), e.id);
        else put(`${dayKey(d)}T${pad2(d.getUTCHours())}`, hourLabel(d), e.id);
        break;
      }
      case 'camera': {
        const name = cameraName(e.make, e.model);
        if (name) put(name.toLowerCase(), name, e.id);
        else missing.push(e.id);
        break;
      }
      case 'lens': {
        const lens = e.lens?.trim();
        if (lens) put(lens.toLowerCase(), lens, e.id);
        else missing.push(e.id);
        break;
      }
      case 'place': {
        const at = e.gps;
        if (!validGps(at)) {
          missing.push(e.id);
          break;
        }
        const place = places.find((p) => distanceM(p.at, at) <= PLACE_RADIUS_M);
        if (place) place.section.ids.push(e.id);
        else {
          const section = {
            key: `${at.lat.toFixed(4)},${at.lon.toFixed(4)}`,
            label: coordinatesLabel(at.lat, at.lon),
            ids: [e.id],
          };
          places.push({ at, section });
          sections.push(section);
        }
        break;
      }
    }
  }
  if (missing.length > 0) sections.push({ key: MISSING_KEY, label: MISSING_LABELS[key], ids: missing });
  return sections;
}
