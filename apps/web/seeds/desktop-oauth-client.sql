-- The desktop app's OAuth client (#399): a public native client that belongs
-- to nobody, signs in with PKCE on a loopback redirect (any port) and may ask
-- only for a refresh token and local runs. An existing row is left as it is,
-- so disabling it turns the app's sign-in off.
INSERT INTO oauth_client (id, client_id, name, redirect_uris, public, type, application_type,
  token_endpoint_auth_method, grant_types, response_types, scopes, require_pkce, skip_consent, disabled)
VALUES ('intar-jumper', 'intar-jumper', 'Intar desktop app', '["http://127.0.0.1/callback"]', 1, 'native', 'native',
  'none', '["authorization_code","refresh_token"]', '["code"]', '["offline_access","local-runs"]', 1, 0, 0)
ON CONFLICT DO NOTHING;
