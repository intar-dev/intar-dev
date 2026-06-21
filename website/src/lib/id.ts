import { createId as createCuid2Id, init as initCuid2 } from "@paralleldrive/cuid2";

let createShortCuid2Id: (() => string) | undefined;

function getShortCuid2Id(): () => string {
  if (!createShortCuid2Id) {
    createShortCuid2Id = initCuid2({ length: 8 });
  }

  return createShortCuid2Id;
}

export function createAppId(): string {
  return createCuid2Id();
}

export function createShortAppId(): string {
  return getShortCuid2Id()();
}
