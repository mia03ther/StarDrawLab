import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { assertLocalIdentityMode, startLocalIdentity } from './localIdentity.mjs';

const env = { NODE_ENV: 'development', LOCAL_DEVELOPMENT_MODE: 'true' };
const origin = 'http://127.0.0.1:5173';
const client = 'stardraw-local-web';
const audience = 'http://localhost:5000';
const callback = origin + '/callback';
const challenge = (value) => createHash('sha256').update(value).digest('base64url');
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const formHeaders = { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' };

async function fixture(t, options = {}) {
  const local = await startLocalIdentity({ ...options, env, port: 0 });
  t.after(() => local.close());
  return local;
}
async function authorization(local, options = {}) {
  const verifier = randomBytes(48).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const parameters = new URLSearchParams({
    client_id: client, redirect_uri: callback, response_type: 'code',
    scope: 'openid profile email offline_access', state, nonce,
    resource: audience, code_challenge_method: 'S256', code_challenge: challenge(verifier),
    ...options,
  });
  const page = await fetch(local.issuer + '/authorize?' + parameters);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const policy = page.headers.get('content-security-policy');
  const formAction = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('form-action '));
  assert.equal(formAction, "form-action 'self' " + callback);
  const html = await page.text();
  assert.match(html, /本地测试账号/);
  assert.match(html, /不会读取线上用户记录/);
  assert.doesNotMatch(html, /access_token|id_token/);
  assert.match(html, /<form method="post" action="\/authorize">/);
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  assert.ok(ticket);
  const confirmed = await fetch(local.issuer + '/authorize', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: local.issuer, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket }),
  });
  assert.equal(confirmed.status, 303);
  const destination = new URL(confirmed.headers.get('location'));
  assert.equal(destination.origin + destination.pathname, callback);
  assert.equal(destination.searchParams.get('state'), state);
  return { verifier, nonce, state, code: destination.searchParams.get('code'), ticket };
}
async function exchange(local, authorization, extra = {}) {
  return fetch(local.issuer + '/token', {
    method: 'POST', headers: formHeaders,
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client, redirect_uri: callback,
      resource: audience, code: authorization.code, code_verifier: authorization.verifier, ...extra,
    }),
  });
}
async function signIn(local) {
  const transaction = await authorization(local);
  const response = await exchange(local, transaction);
  assert.equal(response.status, 200);
  return { ...await response.json(), transaction };
}
async function refresh(local, token, withResource = true) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: client, refresh_token: token });
  if (withResource) body.set('resource', audience);
  return fetch(local.issuer + '/token', { method: 'POST', headers: formHeaders, body });
}

test('requires explicit development mode and loopback binding', async () => {
  assert.throws(() => assertLocalIdentityMode({ NODE_ENV: 'production', LOCAL_DEVELOPMENT_MODE: 'true' }));
  assert.throws(() => assertLocalIdentityMode({ NODE_ENV: 'development' }));
  await assert.rejects(startLocalIdentity({ env, host: '0.0.0.0', port: 0 }), /127.0.0.1/);
});
test('opaque or foreign form origins remain rejected without consuming same-origin confirmation', async (t) => {
  const local = await fixture(t);
  const verifier = randomBytes(48).toString('base64url');
  const parameters = new URLSearchParams({
    client_id: client, redirect_uri: callback, response_type: 'code',
    scope: 'openid profile email offline_access', state: 'origin-regression-state',
    nonce: 'origin-regression-nonce', resource: audience,
    code_challenge_method: 'S256', code_challenge: challenge(verifier),
  });
  const page = await fetch(local.issuer + '/authorize?' + parameters);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const ticket = (await page.text()).match(/name="ticket" value="([^"]+)"/)?.[1];
  assert.ok(ticket);
  for (const requestOrigin of ['null', 'https://evil.example', 'http://127.0.0.1:4999']) {
    const denied = await fetch(local.issuer + '/authorize', {
      method: 'POST', redirect: 'manual',
      headers: { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('location'), null);
  }
  const confirmed = await fetch(local.issuer + '/authorize', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: local.issuer, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket }),
  });
  assert.equal(confirmed.status, 303);
  const code = new URL(confirmed.headers.get('location')).searchParams.get('code');
  assert.equal((await exchange(local, { code, verifier })).status, 200);
});
test('publishes discovery/JWKS, only allows the frontend Origin, and rejects unknown Host', async (t) => {
  const local = await fixture(t);
  const discovery = await fetch(local.issuer + '/.well-known/openid-configuration', { headers: { Origin: origin } });
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('access-control-allow-origin'), origin);
  const metadata = await discovery.json();
  assert.equal(metadata.issuer, local.issuer);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  const jwks = await (await fetch(metadata.jwks_uri)).json();
  assert.equal(jwks.keys[0].alg, 'RS256');
  assert.equal(jwks.keys[0].use, 'sig');
  assert.equal(jwks.keys[0].d, undefined);
  const evil = await fetch(local.issuer + '/jwks', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(local.issuer + '/jwks', { headers: { Host: 'evil.example' } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(badHostStatus, 403);
});
test('authorization code preserves state/nonce, validates PKCE, is one-use, and tokens verify with JWKS', async (t) => {
  const local = await fixture(t), transaction = await authorization(local);
  const bad = await exchange(local, transaction, { code_verifier: randomBytes(48).toString('base64url') });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_grant');
  const response = await exchange(local, transaction);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  const payload = decode(tokens.access_token), identity = decode(tokens.id_token);
  assert.equal(payload.sub, 'local_dev_admin');
  assert.equal(payload.aud, audience);
  assert.equal(payload.iss, local.issuer);
  assert.equal(payload.email_verified, true);
  assert.equal(payload.role, undefined);
  assert.equal(payload.roles, undefined);
  assert.equal(payload.admin, undefined);
  assert.equal(identity.aud, client);
  assert.equal(identity.nonce, transaction.nonce);
  const jwk = (await (await fetch(local.issuer + '/jwks')).json()).keys[0];
  const parts = tokens.access_token.split('.');
  assert.ok(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
    createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url')));
  const replay = await exchange(local, transaction);
  assert.equal(replay.status, 400);
  const confirmationReplay = await fetch(local.issuer + '/authorize', {
    method: 'POST', redirect: 'manual', headers: formHeaders,
    body: new URLSearchParams({ ticket: transaction.ticket }),
  });
  assert.equal(confirmationReplay.status, 400);
});
test('rejects invalid client, callback, resource, unsupported flow, and plain PKCE before confirming login', async (t) => {
  const local = await fixture(t);
  const valid = {
    client_id: client, redirect_uri: callback, response_type: 'code',
    resource: audience, scope: 'openid', state: '1234567890123456',
    nonce: '1234567890123456', code_challenge_method: 'S256',
    code_challenge: challenge('a'.repeat(64)),
  };
  for (const change of [
    { client_id: 'other' }, { redirect_uri: 'https://evil.example/callback' },
    { redirect_uri: origin + '/other-route' }, { redirect_uri: callback + '/extra' },
    { redirect_uri: callback + '?next=https://evil.example/' },
    { resource: 'https://api.production.example' }, { response_type: 'token' },
    { code_challenge_method: 'plain' }, { scope: 'openid admin' },
  ]) {
    const response = await fetch(local.issuer + '/authorize?' + new URLSearchParams({ ...valid, ...change }), { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  }
});
test('supports separate API/account refresh audiences and profile operations without granting roles', async (t) => {
  const local = await fixture(t), login = await signIn(local);
  const [apiResponse, accountResponse] = await Promise.all([
    refresh(local, login.refresh_token), refresh(local, login.refresh_token, false),
  ]);
  assert.equal(apiResponse.status, 200); assert.equal(accountResponse.status, 200);
  const apiTokens = await apiResponse.json(), accountTokens = await accountResponse.json();
  assert.equal(decode(apiTokens.access_token).aud, audience);
  assert.equal(decode(accountTokens.access_token).aud, 'stardraw-local-account-api');
  const denied = await fetch(local.issuer + '/api/my-account', { headers: { Authorization: 'Bearer ' + apiTokens.access_token } });
  assert.equal(denied.status, 401);
  const headers = { Authorization: 'Bearer ' + accountTokens.access_token };
  const account = await (await fetch(local.issuer + '/api/my-account', { headers })).json();
  assert.equal(account.id, 'local_dev_admin');
  assert.equal(account.primaryEmail, 'dev-admin@stardraw.local');
  const patched = await fetch(local.issuer + '/api/my-account', {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '开发测试' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).name, '开发测试');
  const rolePatch = await fetch(local.issuer + '/api/my-account', {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'root' }),
  });
  assert.equal(rolePatch.status, 400);
  const password = await fetch(local.issuer + '/api/my-account/password', { method: 'POST', headers });
  assert.equal(password.status, 501);
  const mfa = await fetch(local.issuer + '/api/my-account/mfa-verifications', { headers });
  assert.deepEqual(await mfa.json(), []);
});
test('logout checks signed identity hint and exact callback, then revokes refresh tokens', async (t) => {
  const local = await fixture(t), login = await signIn(local);
  const badRedirect = await fetch(local.issuer + '/logout?' + new URLSearchParams({
    id_token_hint: login.id_token, post_logout_redirect_uri: 'https://evil.example/',
  }), { redirect: 'manual' });
  assert.equal(badRedirect.status, 400);
  const signedParts = login.id_token.split('.');
  signedParts[2] = 'invalid-signature';
  const badHint = await fetch(local.issuer + '/logout?' + new URLSearchParams({
    id_token_hint: signedParts.join('.'), post_logout_redirect_uri: origin + '/',
  }), { redirect: 'manual' });
  assert.equal(badHint.status, 401);
  const logout = await fetch(local.issuer + '/logout?' + new URLSearchParams({
    id_token_hint: login.id_token, post_logout_redirect_uri: origin + '/',
  }), { redirect: 'manual' });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), origin + '/');
  assert.equal((await refresh(local, login.refresh_token)).status, 400);
});
test('expires unused authorization codes and rejects expired access tokens', async (t) => {
  let clock = Date.now();
  const local = await fixture(t, { now: () => clock });
  const transaction = await authorization(local), login = await signIn(local);
  clock += 121_000;
  assert.equal((await exchange(local, transaction)).status, 400);
  clock += 600_000;
  const userinfo = await fetch(local.issuer + '/userinfo', { headers: { Authorization: 'Bearer ' + login.access_token } });
  assert.equal(userinfo.status, 401);
});
test('persists only the signing key to a caller-supplied local state directory', async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'stardraw-local-identity-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const first = await startLocalIdentity({ env, port: 0, stateDirectory });
  const jwk1 = (await (await fetch(first.issuer + '/jwks')).json()).keys[0];
  await first.close();
  const second = await fixture(t, { stateDirectory });
  const jwk2 = (await (await fetch(second.issuer + '/jwks')).json()).keys[0];
  assert.equal(jwk1.kid, jwk2.kid);
  const key = await readFile(path.join(stateDirectory, 'local-identity-private-key.pem'), 'utf8');
  assert.match(key, /^-----BEGIN PRIVATE KEY-----/);
});
test('tokens verify through the unchanged application OIDC adapter', { skip: !process.env.STARDRAW_PROJECT_ROOT }, async (t) => {
  const project = process.env.STARDRAW_PROJECT_ROOT;
  const { createOidcIdentityProviderAdapter } = await import(pathToFileURL(path.join(project, 'server', 'infrastructure', 'oidcIdentityProviderAdapter.js')).href);
  const local = await fixture(t), login = await signIn(local);
  const adapter = createOidcIdentityProviderAdapter({
    issuer: local.issuer, audience, jwksUri: local.issuer + '/jwks',
    production: false, requireVerifiedEmail: true,
  });
  const claims = await adapter.verifyAccessToken(login.access_token);
  assert.equal(claims.sub, 'local_dev_admin');
  assert.equal(claims.email_verified, true);
  const account = await (await refresh(local, login.refresh_token, false)).json();
  await assert.rejects(adapter.verifyAccessToken(account.access_token), /audience/i);
  await assert.rejects(adapter.verifyAccessToken(login.id_token), /audience/i);
});
