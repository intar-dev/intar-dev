import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

test.describe("frame decisions", () => {
  test("the sidebar trigger is 36px", async ({ page, ui }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("runs"), theme: "light" });
    const box = await page.locator('[data-slot="sidebar-trigger"]').boundingBox();
    expect(box?.width).toBe(36);
    expect(box?.height).toBe(36);
  });

  test("a menu is non-modal: the page stays scrollable and outside controls stay live", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("runs"), theme: "light" });
    await page.locator('[data-slot="dropdown-menu-trigger"]').first().click();
    await expect(page.getByRole("menu")).toBeVisible();
    // A modal menu locks the body's scroll and blocks pointers outside it.
    expect(
      await page.evaluate(() => getComputedStyle(document.body).overflow),
    ).not.toBe("hidden");
    // The sidebar trigger sits outside the menu and still answers the first
    // click; the menu closes with it.
    await page.locator('[data-slot="sidebar-trigger"]').click();
    await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("hover text lives in a tooltip that focus opens, not in title attributes", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const id of [
      "runs",
      "organizations",
      "organization-detail",
      "admin-hosts",
      "admin-people",
      "admin-overview",
      "course-catalog",
    ] as const) {
      await ui.open({ ...routeCase(id), theme: "light" });
      const titled = await page.evaluate(() =>
        [...document.querySelectorAll("[title]")]
          .filter((node) => !(node instanceof SVGElement))
          .map((node) => `${node.tagName}: ${node.getAttribute("title")}`),
      );
      expect(titled, `title attributes on ${id}`).toEqual([]);
    }
  });

  test("an absolute time opens on keyboard focus and describes the time", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("runs"), theme: "light" });
    const time = page.locator("main time[tabindex='0']").first();
    await expect(time).toBeVisible();
    await time.focus();
    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(tip).toBeVisible();
    const absolute = await tip.innerText();
    expect(absolute).not.toBe(await time.innerText());
    const described = await time.getAttribute("aria-describedby");
    await expect(page.locator(`[id="${described}"]`)).toHaveText(absolute, {
      useInnerText: false,
    });
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
  });

  test("warning-subtle is the design system's value in both themes", async ({
    page,
    ui,
  }) => {
    for (const [theme, value] of [
      ["light", "#f3ede5"],
      ["dark", "#343028"],
    ] as const) {
      await ui.open({ ...routeCase("runs"), theme });
      const token = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--warning-subtle")
          .trim(),
      );
      expect(token).toBe(value);
    }
  });

  test("an icon trims its side of a button's padding", async ({ page, ui }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("organizations"), theme: "light" });
    const button = page.getByRole("button", { name: "New organization" });
    await expect(button).toHaveAttribute("data-icon-start", "true");
    const padding = await button.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.paddingLeft, style.paddingRight];
    });
    // size sm: 12px normally, 10px (0.625rem) on the icon side.
    expect(padding).toEqual(["10px", "12px"]);
  });

  test("an inline-confirm trigger rests in the foreground colour", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("profile"), theme: "light" });
    const trigger = page.locator("[data-inline-confirm-trigger]").first();
    await expect(trigger).toBeVisible();
    const [own, ink] = await trigger.evaluate((node) => [
      getComputedStyle(node).color,
      getComputedStyle(document.body).color,
    ]);
    expect(own).toBe(ink);
  });

  test("a section's description is muted", async ({ page, ui }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("profile"), theme: "light" });
    const description = page.locator("section > div > div > p.text-metadata").first();
    await expect(description).toBeVisible();
    const [own, muted] = await description.evaluate((node) => {
      const probe = document.createElement("span");
      probe.className = "text-muted-foreground";
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(node).color, color];
    });
    expect(own).toBe(muted);
  });

  test("under reduced motion the outline ghost and checks segments keep their fades", async ({
    page,
    ui,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ui.open({ ...routeCase("lecture"), theme: "light" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ghost = await page
      .locator("[data-outline-ghost]")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.transitionProperty, style.transitionDuration];
      });
    expect(ghost).toEqual(["opacity", "0.15s"]);

    await ui.open({ ...routeCase("run-workspace"), theme: "light" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const segment = await page
      .locator("[data-checks-bar] > span")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.transitionProperty, style.transitionDuration];
      });
    expect(segment).toEqual(["background-color", "0.5s"]);
  });
});
