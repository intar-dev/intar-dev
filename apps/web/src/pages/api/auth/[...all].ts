import type { APIRoute } from "astro";
import { auth } from "../../../lib/auth";
import { accessInviteError } from "@/lib/access-invite-http";
import { guardNativeAdminMutation } from "@/lib/beta-admin-guard";

export const prerender = false;

export const ALL: APIRoute = async ({ request }) => {
  try {
    await guardNativeAdminMutation(request);
    return await auth.handler(request);
  } catch (error) {
    return accessInviteError(error, "the authentication request was rejected");
  }
};
