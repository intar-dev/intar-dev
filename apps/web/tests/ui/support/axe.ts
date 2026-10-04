import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export async function expectNoAxeViolations(page: Page, testInfo: TestInfo) {
  // Fades still play under reduced motion; measure contrast at rest. Loops
  // never finish, so they are left running.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime ?? 0),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22a",
      "wcag22aa",
    ])
    .analyze();

  await testInfo.attach("axe-results", {
    body: Buffer.from(JSON.stringify(results, null, 2)),
    contentType: "application/json",
  });

  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap((node) => node.target),
  }));

  expect(summary, "WCAG 2.2 A/AA violations").toEqual([]);
}
