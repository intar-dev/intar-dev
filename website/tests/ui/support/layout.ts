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
