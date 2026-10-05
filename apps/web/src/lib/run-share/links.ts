import { canonicalApplicationOrigin } from "@/lib/request-security";
import { shareUrl } from "./protocol";

export function runShareUrl(shareId: string): string {
  return shareUrl(canonicalApplicationOrigin(), shareId);
}
