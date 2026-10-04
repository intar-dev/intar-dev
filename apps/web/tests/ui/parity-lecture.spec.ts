import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test.describe("lecture parity", () => {
  test("the head carries the course context and keeps its title visible on a phone", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await expect(page.getByText(/ · Lecture \d+ of \d+$/)).toBeVisible();
    // The reading page's title is its one h1, in the page, not only the bar.
    const title = page.getByRole("article").getByRole("heading", { level: 1 });
    await expect(title).toBeVisible();
    await expect(title).toHaveClass(/text-content-title/);
  });

  test("the outline column is an 18rem track beside the lecture", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    const rail = page.locator("[data-course-outline-rail]");
    await expect(rail).toBeVisible();
    const box = await rail.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(18 * 16 + 1);
    expect(box?.width).toBeGreaterThanOrEqual(15 * 16 - 1);
  });

  test("a code block has a header bar with an always-visible Copy", async ({
    page,
    ui,
  }) => {
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    const copy = page.getByRole("button", { name: "Copy code" }).first();
    await expect(copy).toBeVisible();
    await expect(copy).toHaveCSS("opacity", "1");
  });
});
