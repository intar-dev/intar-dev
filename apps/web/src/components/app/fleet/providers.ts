// The sponsor mark for a pin card. The mark is a plain image: a hover card is
// not a place to make a learner chase a link.

import hetznerLogo from "@/assets/hetzner-logo.webp";
import namespaceLogo from "@/assets/namespace-logo.png";
import type { HostProvider } from "@/db/schema/shared";
import { HOST_PROVIDER_LABELS } from "@/lib/host-provider";

export interface ProviderMark {
  label: string;
  src: string;
  width: number;
  height: number;
  className: string;
}

const PROVIDER_MARKS: Partial<Record<HostProvider, ProviderMark>> = {
  hetzner: {
    label: HOST_PROVIDER_LABELS.hetzner,
    src: hetznerLogo.src,
    width: hetznerLogo.width,
    height: hetznerLogo.height,
    className: "h-5 w-auto rounded-sm",
  },
  namespace: {
    label: HOST_PROVIDER_LABELS.namespace,
    src: namespaceLogo.src,
    width: namespaceLogo.width,
    height: namespaceLogo.height,
    // The namespace mark is dark ink, like on the landing page.
    className: "h-4 w-auto dark:invert",
  },
};

export function providerMark(provider: HostProvider | null): ProviderMark | null {
  if (provider === null) return null;
  return PROVIDER_MARKS[provider] ?? null;
}
