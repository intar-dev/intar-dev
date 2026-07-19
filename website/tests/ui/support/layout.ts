import { expect, type Page } from "@playwright/test";

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const bodyRect = document.body.getBoundingClientRect();
    const documentRect = document.documentElement.getBoundingClientRect();
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
            "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      })
      .filter(
        (element) =>
          element.left < -1 ||
          element.right > document.documentElement.clientWidth + 1,
      )
      .slice(0, 12);
    const overflowingText = [] as Array<{
      text: string;
      parent: string;
      left: number;
      right: number;
    }>;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode() && overflowingText.length < 20) {
      const node = walker.currentNode as Text;
      if (!node.data.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (
          rect.left < -1 ||
          rect.right > document.documentElement.clientWidth + 1
        ) {
          overflowingText.push({
            text: node.data.trim().replace(/\s+/g, " ").slice(0, 80),
            parent: (node.parentElement?.className ?? "").toString().slice(0, 120),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          });
        }
      }
    }

    return {
      body: document.body.scrollWidth - document.body.clientWidth,
      document:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      metrics: {
        innerWidth: window.innerWidth,
        scrollX: window.scrollX,
        bodyClientWidth: document.body.clientWidth,
        bodyOffsetWidth: document.body.offsetWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyLeft: Math.round(bodyRect.left),
        bodyRight: Math.round(bodyRect.right),
        documentClientWidth: document.documentElement.clientWidth,
        documentOffsetWidth: document.documentElement.offsetWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentLeft: Math.round(documentRect.left),
        documentRight: Math.round(documentRect.right),
      },
      offenders,
      overflowingText,
    };
  });

  expect(
    overflow.body,
    `body horizontal overflow in CSS pixels; metrics=${JSON.stringify(overflow.metrics)}; offenders=${JSON.stringify(overflow.offenders)}; text=${JSON.stringify(overflow.overflowingText)}`,
  ).toBeLessThanOrEqual(1);
  expect(
    overflow.document,
    `document horizontal overflow in CSS pixels; metrics=${JSON.stringify(overflow.metrics)}; offenders=${JSON.stringify(overflow.offenders)}; text=${JSON.stringify(overflow.overflowingText)}`,
  ).toBeLessThanOrEqual(1);
}

export async function coarsePointerTargetViolations(page: Page) {
  return page.evaluate(() => {
    const selector = [
      "button:not([disabled])",
      "input:not([type='hidden']):not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[role='button']:not([aria-disabled='true'])",
      "[role='tab']:not([aria-disabled='true'])",
      "a[href]",
    ].join(",");

    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((element) => {
        const inlineTextLink =
          element instanceof HTMLAnchorElement &&
          Boolean(element.closest("p, li, dd, td")) &&
          !element.closest("nav") &&
          !element.hasAttribute("data-slot");
        if (inlineTextLink) return false;

        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          element.tabIndex >= 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().slice(0, 80) ??
            element.tagName,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((target) => target.width < 44 || target.height < 44);
  });
}

export async function expectTimelineMarkerTitleAlignment(
  page: Page,
  toleranceCssPixels = 2,
) {
  const measurements = await page
    .locator('ol[aria-label="Run timeline"] > li')
    .evaluateAll((rows) =>
      rows.map((row, index) => {
        const marker = row.querySelector<HTMLElement>(
          "[data-timeline-marker]",
        );
        const title = row.querySelector<HTMLElement>("[data-timeline-title]");
        const connector = marker?.parentElement?.querySelector<HTMLElement>(
          ".absolute",
        );
        const nextMarker = rows[index + 1]?.querySelector<HTMLElement>(
          "[data-timeline-marker]",
        );
        const markerRect = marker?.getBoundingClientRect() ?? null;
        const titleRect = title?.getBoundingClientRect() ?? null;
        const connectorRect = connector?.getBoundingClientRect() ?? null;
        const nextMarkerRect = nextMarker?.getBoundingClientRect() ?? null;
        return {
          index,
          title: title?.textContent?.trim().replace(/\s+/g, " ") ?? null,
          markerCenterY: markerRect
            ? markerRect.top + markerRect.height / 2
            : null,
          titleCenterY: titleRect ? titleRect.top + titleRect.height / 2 : null,
          connectorBottomY: connectorRect?.bottom ?? null,
          nextMarkerTopY: nextMarkerRect?.top ?? null,
        };
      }),
    );

  expect(measurements.length, "timeline must contain events").toBeGreaterThan(
    0,
  );
  for (const measurement of measurements) {
    expect(
      measurement.markerCenterY,
      `timeline event ${measurement.index + 1} (${measurement.title ?? "untitled"}) is missing [data-timeline-marker]`,
    ).not.toBeNull();
    expect(
      measurement.titleCenterY,
      `timeline event ${measurement.index + 1} is missing [data-timeline-title]`,
    ).not.toBeNull();

    const delta = Math.abs(
      (measurement.markerCenterY ?? Number.POSITIVE_INFINITY) -
        (measurement.titleCenterY ?? Number.NEGATIVE_INFINITY),
    );
    expect(
      delta,
      `timeline marker/title center delta for ${measurement.title ?? `event ${measurement.index + 1}`} in CSS pixels`,
    ).toBeLessThanOrEqual(toleranceCssPixels);

    if (measurement.nextMarkerTopY !== null) {
      expect(
        measurement.connectorBottomY,
        `timeline event ${measurement.index + 1} (${measurement.title ?? "untitled"}) is missing its connector`,
      ).not.toBeNull();
      const connectorGap = Math.abs(
        measurement.nextMarkerTopY -
          (measurement.connectorBottomY ?? Number.NEGATIVE_INFINITY),
      );
      expect(
        connectorGap,
        `timeline connector gap before event ${measurement.index + 2} in CSS pixels`,
      ).toBeLessThanOrEqual(toleranceCssPixels);
    }
  }
}

export async function expectTimelineSurfaceWidths(
  page: Page,
  toleranceCssPixels = 2,
) {
  const measurements = await page
    .locator("[data-timeline-surface]")
    .evaluateAll((surfaces) =>
      surfaces.map((surface, index) => {
        const rect = surface.getBoundingClientRect();
        return {
          index,
          label:
            surface.getAttribute("data-timeline-surface") ??
            surface.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
            surface.tagName,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      }),
    );

  expect(
    measurements.length,
    "timeline must contain at least two structured-content surfaces",
  ).toBeGreaterThanOrEqual(2);

  const [reference, ...remaining] = measurements;
  if (!reference) {
    throw new Error("timeline has no structured-content surfaces");
  }

  for (const measurement of remaining) {
    for (const edge of ["left", "right", "width"] as const) {
      const delta = Math.abs(measurement[edge] - reference[edge]);
      expect(
        delta,
        `timeline surface ${measurement.index + 1} (${measurement.label}) ${edge} differs from ${reference.label} by ${delta.toFixed(2)} CSS pixels`,
      ).toBeLessThanOrEqual(toleranceCssPixels);
    }
  }
}
