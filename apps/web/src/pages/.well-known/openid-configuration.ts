import type { APIRoute } from "astro";
import { oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { auth } from "../../lib/auth";

export const prerender = false;

const handler = oauthProviderOpenIdConfigMetadata(auth);

export const GET: APIRoute = ({ request }) => handler(request);
