/**
 * Nudges a field once because its submitted value was refused (the `[data-reject]`
 * rule in global.css) and keeps focus in it. The attribute clears when the
 * animation ends, so the next refusal plays again.
 */
export function reject(element: HTMLElement | null) {
  if (!element) return;
  element.removeAttribute("data-reject");
  // Restart the animation when it is refused twice in a row.
  void element.offsetWidth;
  element.setAttribute("data-reject", "");
  element.addEventListener(
    "animationend",
    () => element.removeAttribute("data-reject"),
    { once: true },
  );
  element.focus();
}

/** The organization name limit; mirrors ORGANIZATION_NAME_MAX in lib/organizations.ts. */
export const ORGANIZATION_NAME_MAX = 60;
