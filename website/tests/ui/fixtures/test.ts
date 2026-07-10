import {
  expect,
  test as base,
  type Page,
  type TestInfo,
} from "@playwright/test";
import {
  createMockApiState,
  FIXED_NOW,
  type DataVariant,
  type RunFixtureState,
} from "./data";
import { createMockApiServer, type MockApiServer } from "./mock-api";
import type { SessionRole } from "./sessions";
import { installTerminalWebSocketMock } from "./websocket";

export type UiTheme = "light" | "dark";

export interface OpenRouteOptions {
  path: string;
  sessionRole: SessionRole;
  theme?: UiTheme;
  variant?: DataVariant;
  runState?: RunFixtureState;
}

export interface UiHarness {
  server: MockApiServer;
  configure(options: Omit<OpenRouteOptions, "path" | "theme">): void;
  open(options: OpenRouteOptions): Promise<void>;
  settle(): Promise<void>;
}

interface UiFixtures {
  ui: UiHarness;
}

const EXPECTED_MOCK_503_CONSOLE_ERROR =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

function actionableConsoleError(text: string, variant: DataVariant) {
  if (variant === "error" && text === EXPECTED_MOCK_503_CONSOLE_ERROR) {
    return false;
  }
  return !text.includes("favicon.ico") && !text.includes("ResizeObserver loop");
}

async function waitForReady(page: Page) {
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("h1").first()).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts?.ready;
  });
  await page.waitForTimeout(150);
}

function attachDiagnostics(
  testInfo: TestInfo,
  server: MockApiServer,
  consoleErrors: string[],
  pageErrors: string[],
) {
  return Promise.all([
    testInfo.attach("mock-api-requests", {
      body: Buffer.from(server.requests.join("\n")),
      contentType: "text/plain",
    }),
    testInfo.attach("browser-errors", {
      body: Buffer.from([...consoleErrors, ...pageErrors].join("\n")),
      contentType: "text/plain",
    }),
  ]);
}

export const test = base.extend<UiFixtures>({
  ui: async ({ page }, use, testInfo) => {
    const server = createMockApiServer(createMockApiState());
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        actionableConsoleError(message.text(), server.state.variant)
      ) {
        consoleErrors.push(`console: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));

    await page.clock.setFixedTime(FIXED_NOW);
    await page.route("**/api/**", (route) => server.handle(route));
    await installTerminalWebSocketMock(page, server);

    const harness: UiHarness = {
      server,
      configure(options) {
        server.state = createMockApiState(options);
        server.requests.length = 0;
        server.unhandled.length = 0;
      },
      async open(options) {
        harness.configure(options);
        const theme = options.theme ?? "light";
        await page.emulateMedia({
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await page.addInitScript((selectedTheme: UiTheme) => {
          try {
            window.localStorage.setItem("intar-theme", selectedTheme);
          } catch {
            // Opaque initial documents do not expose storage. The script runs
            // again for the real application origin before its bootstrap.
          }
        }, theme);
        await page.goto(options.path, { waitUntil: "domcontentloaded" });
        await waitForReady(page);
      },
      settle: () => waitForReady(page),
    };

    await use(harness);
    await attachDiagnostics(testInfo, server, consoleErrors, pageErrors);

    expect(
      server.unhandled,
      "Every /api/** request must have an explicit deterministic fixture",
    ).toEqual([]);
    expect(consoleErrors, "Browser console errors").toEqual([]);
    expect(pageErrors, "Unhandled page errors").toEqual([]);
  },
});

export { expect } from "@playwright/test";
