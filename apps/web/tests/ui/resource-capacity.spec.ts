import { expect, test } from "./fixtures/test";
import { FIXED_NOW } from "./fixtures/data";
import { routeCase } from "./routes";
import { expectNoAxeViolations } from "./support/axe";
import { expectNoHorizontalOverflow } from "./support/layout";

test("capacity updates after 15 seconds and distinguishes zero from unavailable", async ({ page, ui }) => {
  await page.clock.install({ time: FIXED_NOW });
  await ui.open(routeCase("course-catalog"));
  const cpu = page.getByRole("meter", { name: "CPU", exact: true });
  await expect(cpu).toHaveAttribute("aria-valuenow", "65.625");
  const courseList = page.getByRole("link", { name: /Linux operations/ });
  await expect(courseList).toBeVisible();

  ui.server.state.resourceCapacity = {
    cpu: { availableMillis: 0, totalMillis: 8000 },
    memory: { availableMib: 0, totalMib: 16384 },
  };
  await page.clock.fastForward(15_001);
  await expect(cpu).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByRole("meter", { name: "Memory", exact: true })).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByText("Capacity unavailable", { exact: true })).toHaveCount(0);

  ui.server.state.resourceCapacity = null;
  await page.clock.fastForward(15_001);
  await expect(page.getByText("Capacity unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(courseList).toBeVisible();
});

test("capacity refresh failure keeps courses and last values, then recovers", async ({ page, ui }) => {
  await page.clock.install({ time: FIXED_NOW });
  await ui.open(routeCase("course-catalog"));
  const cpu = page.getByRole("meter", { name: "CPU", exact: true });
  await expect(cpu).toHaveAttribute("aria-valuenow", "65.625");
  ui.server.state.variant = "error";
  await page.clock.fastForward(15_001);
  // Advance retries between completed network responses.
  await expect.poll(async () => {
    await page.clock.fastForward(5_000);
    return page.getByText(/Update failed/).count();
  }).toBe(1);
  await expect(page.getByRole("status")).toContainText("Update failed");
  await expect(page.getByRole("link", { name: /Linux operations/ })).toBeVisible();
  await expect(cpu).toHaveAttribute("aria-valuenow", "65.625");

  ui.server.state.variant = "populated";
  ui.server.state.resourceCapacity!.cpu.availableMillis = 8000;
  await page.clock.fastForward(15_001);
  await expect(cpu).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByText(/Update failed/)).toHaveCount(0);
});

test("catalog meters retain exact shares, fit mobile, and respect reduced motion", async ({ page, ui }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ui.open({ ...routeCase("course-catalog"), theme: "dark" });
  const cpu = page.getByRole("meter", { name: "CPU", exact: true });
  await expect(cpu).toHaveAttribute("aria-valuetext", "65.6% available, 5.25 / 8 vCPUs");
  await expect(cpu.locator(":scope > span")).toHaveCount(20);
  const partial = cpu.locator(":scope > span > span").nth(13);
  await expect(partial).toHaveCSS("transform", "matrix(0.125, 0, 0, 1, 0, 0)");
  await expect(partial).toHaveCSS("transition-property", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(partial).toHaveCSS("transition-duration", "0.25s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("textbox", { name: "Search courses and lectures" }).fill("nothing-matches-this-course");
  await expect(page.getByText("No courses match your filters", { exact: true })).toBeVisible();
  await expect(cpu).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page, testInfo);
});

test("organization catalog reads its own capacity and course detail has no meters or polling", async ({ page, ui }, testInfo) => {
  await page.clock.install({ time: FIXED_NOW });
  await ui.open({ ...routeCase("organization-detail"), theme: "light" });
  ui.server.state.resourceCapacity = {
    cpu: { availableMillis: 1000, totalMillis: 2000 },
    memory: { availableMib: 1024, totalMib: 4096 },
  };
  await page.locator("main").getByRole("button", { name: "Courses", exact: true }).click();
  await expect(page.getByRole("meter", { name: "CPU", exact: true })).toHaveAttribute("aria-valuenow", "50");
  await expect(page.getByText("1 / 4 GiB", { exact: true })).toBeVisible();
  await expectNoAxeViolations(page, testInfo);
  await page.getByRole("link", { name: /Platform repair sequence/ }).click();
  await expect(page.getByRole("meter")).toHaveCount(0);
  const catalogRequests = () => ui.server.requests.filter((request) => /^GET \/api\/organizations\/[^/]+\/courses$/.test(request)).length;
  const count = catalogRequests();
  await page.clock.fastForward(45_001);
  expect(catalogRequests()).toBe(count);
});

test("capacity loading and unavailable states do not invent values", async ({ page, ui }) => {
  await ui.open({ ...routeCase("course-catalog"), variant: "loading" });
  await expect(page.getByRole("status")).toContainText("Loading courses");
  await expect(page.getByRole("meter")).toHaveCount(0);
  await ui.open({ ...routeCase("course-catalog"), variant: "empty" });
  await expect(page.getByText("Capacity unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("meter")).toHaveCount(0);
});

test("access denial discards cached courses even when the next retry fails", async ({ page, ui }) => {
  await page.clock.install({ time: FIXED_NOW });
  await ui.open(routeCase("course-catalog"));
  await expect(page.getByRole("meter", { name: "CPU", exact: true })).toBeVisible();
  let denied = true;
  let deniedReads = 0;
  await page.route("**/api/courses", async (route) => {
    if (!denied) return route.fallback();
    deniedReads += 1;
    await route.fulfill({ status: 403, json: { error: "Course access denied" } });
  });
  ui.server.state.variant = "error";
  await page.clock.fastForward(15_001);
  await expect(page.getByText("Course access denied", { exact: true })).toBeVisible();
  await expect(page.getByRole("meter")).toHaveCount(0);
  await page.clock.fastForward(45_001);
  expect(deniedReads).toBe(1);

  denied = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(async () => {
    await page.clock.fastForward(5_000);
    return page.getByText("Deterministic fixture failure", { exact: true }).count();
  }).toBe(1);
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Linux operations/ })).toHaveCount(0);

  ui.server.state.variant = "populated";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("meter", { name: "CPU", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Linux operations/ })).toBeVisible();
});
