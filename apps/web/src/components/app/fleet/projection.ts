// Pure geometry for the equirectangular fleet map. One map unit is one degree
// of longitude, the viewBox is 360 by 150, so latitude 90 is the top edge and
// latitude 60 south is the bottom edge.

export const WORLD_MAP_WIDTH = 360;
export const WORLD_MAP_HEIGHT = 150;

/**
 * A pin target is 24px on a fine pointer. The global coarse-pointer rule grows
 * every button to 44px, so a touch device needs the larger separation.
 */
export const MAP_PIN_PX = 26;
export const MAP_PIN_COARSE_PX = 44;

export interface MapPoint {
  x: number;
  y: number;
}

export interface MapPinPosition {
  /** Center of the pin inside the map box, in percent, for an inline style. */
  leftPercent: number;
  topPercent: number;
}

export interface MapLayoutOptions {
  /** Rendered width of the map box. Zero keeps the raw projected places. */
  widthPx: number;
  pinPx?: number;
}

export function projectToMapPoint(location: {
  latitude: number;
  longitude: number;
}): MapPoint {
  return {
    x: clamp(location.longitude + 180, 0, WORLD_MAP_WIDTH),
    y: clamp(90 - location.latitude, 0, WORLD_MAP_HEIGHT),
  };
}

/**
 * Places every host, in the order given.
 *
 * Two hosts whose targets would overlap on screen move together onto a ring
 * around their shared center. The ring, the group, and the distances are all
 * measured in pixels, because a degree is a different distance on a phone and
 * on a desktop, and a covered pin is a host nobody can open.
 *
 * A host that cannot move (a lone pin, a crowd whose ring is wider than the
 * map, or a ring that would land on an already placed pin) keeps its true
 * place. This function is a best effort: the host list beside the map is what
 * guarantees that every host stays readable.
 */
export function layoutMapPins(
  hosts: readonly { latitude: number; longitude: number }[],
  options: MapLayoutOptions,
): MapPinPosition[] {
  const points = hosts.map((host) => projectToMapPoint(host));
  const positions = points.map((point) => ({
    leftPercent: (point.x / WORLD_MAP_WIDTH) * 100,
    topPercent: (point.y / WORLD_MAP_HEIGHT) * 100,
  }));
  const { widthPx } = options;
  if (!(widthPx > 0) || points.length < 2) return positions;

  const pinPx = options.pinPx ?? MAP_PIN_PX;
  const heightPx = widthPx * (WORLD_MAP_HEIGHT / WORLD_MAP_WIDTH);
  const pixels = points.map((point) => ({
    x: (point.x / WORLD_MAP_WIDTH) * widthPx,
    y: (point.y / WORLD_MAP_HEIGHT) * heightPx,
  }));
  // A single pin is already the only pin at its place, so it is placed first
  // and never moves to make room.
  const groups = starGroups(pixels, pinPx).sort(
    (left, right) => left.length - right.length,
  );
  const settled: MapPoint[] = [];

  for (const group of groups) {
    if (group.length < 2) {
      const index = group[0]!;
      settled.push(pixels[index]!);
      continue;
    }
    const ring = ringForGroup(
      group,
      pixels,
      pinPx,
      widthPx,
      heightPx,
      settled,
    );
    if (!ring) {
      for (const index of group) settled.push(pixels[index]!);
      continue;
    }
    ring.forEach((point, slot) => {
      settled.push(point);
      const position = positions[group[slot]!];
      if (!position) return;
      position.leftPercent = (point.x / widthPx) * 100;
      position.topPercent = (point.y / heightPx) * 100;
    });
  }
  return positions;
}

/** Hosts whose targets sit closer than one pin, taken in input order. */
function starGroups(pixels: readonly MapPoint[], pinPx: number): number[][] {
  const groups: number[][] = [];
  const claimed = new Array<boolean>(pixels.length).fill(false);
  for (let index = 0; index < pixels.length; index += 1) {
    if (claimed[index]) continue;
    claimed[index] = true;
    const group = [index];
    const origin = pixels[index]!;
    for (let other = index + 1; other < pixels.length; other += 1) {
      if (claimed[other]) continue;
      const candidate = pixels[other]!;
      if (distance(origin, candidate) < pinPx) {
        claimed[other] = true;
        group.push(other);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * The ring for one group, or null when the group must stay where it is: a ring
 * wider than the map, or one that would land on a settled pin, is worse than a
 * crowded place.
 */
function ringForGroup(
  group: readonly number[],
  pixels: readonly MapPoint[],
  pinPx: number,
  widthPx: number,
  heightPx: number,
  settled: readonly MapPoint[],
): MapPoint[] | null {
  const members = group.map((index) => pixels[index]!);
  const center = {
    x: members.reduce((sum, point) => sum + point.x, 0) / members.length,
    y: members.reduce((sum, point) => sum + point.y, 0) / members.length,
  };
  const radiusPx = pinPx / (2 * Math.sin(Math.PI / group.length));
  // A ring wider than the map cannot fit, however it moves.
  if (2 * radiusPx > widthPx || 2 * radiusPx > heightPx) {
    return null;
  }
  // A ring that only overhangs the edge moves back inside. One rigid move
  // keeps every distance, which a per-pin clamp would not.
  const shift = {
    x:
      -Math.min(0, center.x - radiusPx) -
      Math.max(0, center.x + radiusPx - widthPx),
    y:
      -Math.min(0, center.y - radiusPx) -
      Math.max(0, center.y + radiusPx - heightPx),
  };
  const ring = members.map((_, slot) => {
    const angle = (2 * Math.PI * slot) / group.length - Math.PI / 2;
    return {
      x: center.x + shift.x + radiusPx * Math.cos(angle),
      y: center.y + shift.y + radiusPx * Math.sin(angle),
    };
  });
  const collides = ring.some((point) =>
    settled.some((other) => distance(point, other) < pinPx),
  );
  return collides ? null : ring;
}

function distance(left: MapPoint, right: MapPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
