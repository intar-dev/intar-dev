import { describe, expect, it } from "vitest";
import {
  layoutMapPins,
  MAP_PIN_COARSE_PX,
  MAP_PIN_PX,
  projectToMapPoint,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
  type MapPinPosition,
} from "./projection";

// Nuremberg and Falkenstein are the two places a seeded fleet reports. They
// are about one degree apart, which is roughly one pixel on a phone.
const NUREMBERG = { latitude: 49.4521, longitude: 11.0767 };
const FALKENSTEIN = { latitude: 50.4773, longitude: 12.3692 };

const WIDTHS = [320, 390, 768, 1200] as const;
/** Percent coordinates round-trip through floats, so allow a sub-pixel loss. */
const SEPARATION_TOLERANCE_PX = 0.5;

function toPixel(pin: MapPinPosition, widthPx: number) {
  const heightPx = widthPx * (WORLD_MAP_HEIGHT / WORLD_MAP_WIDTH);
  return {
    x: (pin.leftPercent / 100) * widthPx,
    y: (pin.topPercent / 100) * heightPx,
  };
}

function closestPair(
  pins: readonly MapPinPosition[],
  widthPx: number,
): number {
  let closest = Number.POSITIVE_INFINITY;
  const pixels = pins.map((pin) => toPixel(pin, widthPx));
  for (let left = 0; left < pixels.length; left += 1) {
    for (let right = left + 1; right < pixels.length; right += 1) {
      const a = pixels[left]!;
      const b = pixels[right]!;
      closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  return closest;
}

function expectInsideBox(pins: readonly MapPinPosition[]) {
  for (const pin of pins) {
    expect(pin.leftPercent).toBeGreaterThanOrEqual(0);
    expect(pin.leftPercent).toBeLessThanOrEqual(100);
    expect(pin.topPercent).toBeGreaterThanOrEqual(0);
    expect(pin.topPercent).toBeLessThanOrEqual(100);
  }
}

describe("fleet map projection", () => {
  it("puts the equator below the middle, because Antarctica is cut", () => {
    expect(projectToMapPoint({ latitude: 0, longitude: 0 })).toEqual({
      x: WORLD_MAP_WIDTH / 2,
      y: 90,
    });
  });

  it("clamps an address outside the drawn box", () => {
    expect(projectToMapPoint({ latitude: -80, longitude: 200 })).toEqual({
      x: WORLD_MAP_WIDTH,
      y: WORLD_MAP_HEIGHT,
    });
  });

  it("places one host at its projected place", () => {
    const [pin] = layoutMapPins([NUREMBERG], { widthPx: 1200 });
    expect(pin).toEqual({
      leftPercent: ((NUREMBERG.longitude + 180) / WORLD_MAP_WIDTH) * 100,
      topPercent: ((90 - NUREMBERG.latitude) / WORLD_MAP_HEIGHT) * 100,
    });
  });

  it("keeps the raw place before the box is measured", () => {
    const pins = layoutMapPins([NUREMBERG, FALKENSTEIN], { widthPx: 0 });
    expect(pins[0]).toEqual(layoutMapPins([NUREMBERG], { widthPx: 0 })[0]);
  });

  it("separates a crowd around one shared center, at every width", () => {
    for (const widthPx of WIDTHS) {
      const hosts = Array.from({ length: 4 }, () => NUREMBERG);
      const pins = layoutMapPins(hosts, { widthPx });
      expect(closestPair(pins, widthPx)).toBeGreaterThanOrEqual(
        MAP_PIN_PX - SEPARATION_TOLERANCE_PX,
      );
      expectInsideBox(pins);
    }
  });

  it("separates two hosts in nearby places at every width", () => {
    for (const widthPx of WIDTHS) {
      const pins = layoutMapPins([NUREMBERG, FALKENSTEIN], { widthPx });
      expect(closestPair(pins, widthPx)).toBeGreaterThanOrEqual(
        MAP_PIN_PX - SEPARATION_TOLERANCE_PX,
      );
      expectInsideBox(pins);
    }
  });

  it("separates hosts that start apart and pull together", () => {
    // The reported regression: two centers 40px apart with 44px targets.
    const heightPx = 390 * (WORLD_MAP_HEIGHT / WORLD_MAP_WIDTH);
    const at = (yPx: number) => ({
      latitude: 90 - (yPx / heightPx) * WORLD_MAP_HEIGHT,
      longitude: 0,
    });
    const pins = layoutMapPins([at(90), at(50)], {
      widthPx: 390,
      pinPx: MAP_PIN_COARSE_PX,
    });
    expect(closestPair(pins, 390)).toBeGreaterThanOrEqual(
      MAP_PIN_COARSE_PX - SEPARATION_TOLERANCE_PX,
    );
  });

  it("separates a crowd for a fingertip", () => {
    const hosts = Array.from({ length: 6 }, () => NUREMBERG);
    const pins = layoutMapPins(hosts, { widthPx: 390, pinPx: MAP_PIN_COARSE_PX });
    expect(closestPair(pins, 390)).toBeGreaterThanOrEqual(
      MAP_PIN_COARSE_PX - SEPARATION_TOLERANCE_PX,
    );
    expectInsideBox(pins);
  });

  it("keeps a crowd whose ring cannot fit in its true place", () => {
    // Ten 44px targets need a 142px ring. The box is only 133px tall, so a
    // ring would leave the map. The pins stay where they are, and the host
    // list beside the map carries the facts.
    const hosts = Array.from({ length: 10 }, () => NUREMBERG);
    const pins = layoutMapPins(hosts, { widthPx: 320, pinPx: MAP_PIN_COARSE_PX });
    expectInsideBox(pins);
    const raw = layoutMapPins([NUREMBERG], { widthPx: 0 })[0]!;
    for (const pin of pins) {
      expect(pin).toEqual(raw);
    }
  });

  it("never moves a crowd onto a settled pin", () => {
    const heightPx = 390 * (WORLD_MAP_HEIGHT / WORLD_MAP_WIDTH);
    const at = (yPx: number) => ({
      latitude: 90 - (yPx / heightPx) * WORLD_MAP_HEIGHT,
      longitude: 0,
    });
    // A lone pin at 40px, and a pair whose ring would land on it.
    const pins = layoutMapPins([at(40), at(84), at(104)], {
      widthPx: 390,
      pinPx: MAP_PIN_COARSE_PX,
    });
    expectInsideBox(pins);
    // The lone pin keeps its place, and the pair keeps away from it.
    expect(pins[0]).toEqual(
      layoutMapPins([at(40)], { widthPx: 390, pinPx: MAP_PIN_COARSE_PX })[0],
    );
    const lone = toPixel(pins[0]!, 390);
    for (const pin of [pins[1]!, pins[2]!]) {
      const point = toPixel(pin, 390);
      expect(Math.hypot(point.x - lone.x, point.y - lone.y)).toBeGreaterThanOrEqual(
        MAP_PIN_COARSE_PX - SEPARATION_TOLERANCE_PX,
      );
    }
  });

  it("places the same fleet the same way twice", () => {
    const hosts = [NUREMBERG, NUREMBERG, FALKENSTEIN];
    expect(layoutMapPins(hosts, { widthPx: 1200 })).toEqual(
      layoutMapPins(hosts, { widthPx: 1200 }),
    );
  });

  it("keeps every pin inside the box for a full fleet", () => {
    const hosts = Array.from({ length: 40 }, (_, index) => ({
      latitude: 40 + (index % 8),
      longitude: -120 + (index % 10) * 4,
    }));
    const pins = layoutMapPins(hosts, { widthPx: 320, pinPx: MAP_PIN_COARSE_PX });
    expect(pins).toHaveLength(40);
    expectInsideBox(pins);
  });
});
