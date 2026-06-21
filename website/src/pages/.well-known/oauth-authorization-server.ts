import type { APIRoute } from "astro";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "../../lib/auth";

export const prerender = false;

const handler = oauthProviderAuthServerMetadata(auth);

export const GET: APIRoute = ({ request }) => handler(request);
