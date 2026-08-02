import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const screenshotStyle = fileURLToPath(
  new URL("../screenshot.css", import.meta.url),
);

export async function expectRouteScreenshot(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    scale: "css",
    stylePath: screenshotStyle,
  });
}
