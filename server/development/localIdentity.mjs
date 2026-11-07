/**
 * Local OIDC fixture. Never use for public or production authentication.
 * Application token verification and database RBAC remain unchanged.
 */
import http from 'node:http';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SUBJECT = 'local_dev_admin';
const CLIENT_ID = 'stardraw-local-web';
const API_AUDIENCE = 'http://localhost:5000';
const ACCOUNT_AUDIENCE = 'stardraw-local-account-api';
const FRONTEND = 'http://127.0.0.1:5173';
const CALLBACK = FRONTEND + '/callback';
const CODE_TTL = 120_000;
const REFRESH_TTL = 8 * 60 * 60 * 1000;
const ACCESS_TTL = 600;
const SCOPES = new Set(['openid', 'profile', 'email', 'phone', 'identities', 'urn:logto:scope:sessions', 'offline_access']);
const b64 = (value) => Buffer.from(value).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('base64url');
const randomToken = () => randomBytes(32).toString('base64url');
const fail = (error, description, status = 400) => Object.assign(new Error(description), { oauthError: error, status });
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function assertLocalIdentityMode(env = process.env) {
  if (env.NODE_ENV !== 'development' || env.LOCAL_DEVELOPMENT_MODE !== 'true') {
    throw new Error('Local identity requires NODE_ENV=development and LOCAL_DEVELOPMENT_MODE=true.');
  }
}

function loadKeys(directory) {
  let privateKey;
  if (directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'local-identity-private-key.pem');
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local identity key must be a regular file.');
      privateKey = createPrivateKey(fs.readFileSync(file));
    } else {
      privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    }
  } else privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('Local signing key must be RSA.');
  const publicKey = createPublicKey(privateKey);
  const exported = publicKey.export({ format: 'jwk' });
  const kid = digest(exported.n + '.' + exported.e).slice(0, 24);
  return { privateKey, publicKey, kid, jwk: { ...exported, use: 'sig', alg: 'RS256', kid } };
}
function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
async function body(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16_384) throw fail('invalid_request', 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function parameter(parameters, name, required = true, maximum = 512) {
  const values = parameters.getAll(name);
  const value = values[0] || '';
  if (values.length > 1 || (required && !value) || value.length > maximum) throw fail('invalid_request', name + ' is invalid.');
  return value;
}

export async function startLocalIdentity({ port = 4300, host = '127.0.0.1', stateDirectory = null, env = process.env, now = () => Date.now() } = {}) {
  assertLocalIdentityMode(env);
  if (host !== '127.0.0.1') throw new Error('Local identity must bind 127.0.0.1.');
  const keys = loadKeys(stateDirectory);
  const codes = new Map(), refreshTokens = new Map(), confirmations = new Map();
  let issuer;
  const startedAt = new Date(now()).toISOString();
  const profile = {
    id: SUBJECT, sub: SUBJECT, username: SUBJECT, preferred_username: SUBJECT,
    name: '本地测试管理员', email: 'dev-admin@stardraw.local', primaryEmail: 'dev-admin@stardraw.local',
    email_verified: true, emailVerified: true, profile: {}, customData: { localDevelopment: true },
  };
  function claims() {
    return { sub: SUBJECT, username: profile.username, preferred_username: profile.username, name: profile.name,
      email: profile.primaryEmail, email_verified: true, amr: ['local-development'], local_development: true };
  }
  function jwt(audience, additional = {}) {
    const issued = Math.floor(now() / 1000);
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keys.kid }));
    const payload = b64(JSON.stringify({ ...claims(), iss: issuer, aud: audience, azp: CLIENT_ID,
      iat: issued, exp: issued + ACCESS_TTL, jti: randomToken(), ...additional }));
    const input = header + '.' + payload;
    return input + '.' + sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
  }
  function validateJwt(token, audiences) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length !== 3) throw new Error();
      const [header, payload] = parts.slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()));
      if (header.alg !== 'RS256' || header.kid !== keys.kid) throw new Error();
      if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), keys.publicKey, Buffer.from(parts[2], 'base64url'))) throw new Error();
      if (payload.iss !== issuer || payload.sub !== SUBJECT || !audiences.includes(payload.aud)) throw new Error();
      if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(now() / 1000)) throw new Error();
      return payload;
    } catch { throw fail('invalid_token', 'A valid local token with the correct audience is required.', 401); }
  }
  function bearer(request, audiences) {
    const value = String(request.headers.authorization || '');
    if (!value.startsWith('Bearer ')) throw fail('invalid_token', 'Bearer token required.', 401);
    return validateJwt(value.slice(7), audiences);
  }
  function resource(parameters) {
    const value = parameter(parameters, 'resource', false);
    if (value && value !== API_AUDIENCE) throw fail('invalid_target', 'Only the local API resource is allowed.');
    return value;
  }
  function tokens({ resource: target, scope, nonce, refreshToken, authTime }) {
    if (!refreshToken && scope.split(' ').includes('offline_access')) {
      refreshToken = randomToken();
      refreshTokens.set(refreshToken, { clientId: CLIENT_ID, scope, nonce, authTime, expiresAt: now() + REFRESH_TTL });
    }
    return { token_type: 'Bearer', expires_in: ACCESS_TTL, scope, access_token: jwt(target || ACCOUNT_AUDIENCE, { scope }),
      id_token: jwt(CLIENT_ID, { ...(nonce ? { nonce } : {}), auth_time: authTime }),
      ...(refreshToken ? { refresh_token: refreshToken } : {}) };
  }
  function authorization(parameters) {
    if (parameter(parameters, 'client_id') !== CLIENT_ID) throw fail('unauthorized_client', 'Unknown local client.');
    if (parameter(parameters, 'redirect_uri') !== CALLBACK) throw fail('invalid_request', 'Redirect must exactly match the local callback.');
    if (parameter(parameters, 'response_type') !== 'code') throw fail('unsupported_response_type', 'Only code flow is supported.');
    const challenge = parameter(parameters, 'code_challenge');
    if (parameter(parameters, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw fail('invalid_request', 'S256 PKCE is required.');
    const state = parameter(parameters, 'state'), nonce = parameter(parameters, 'nonce');
    if (state.length < 16 || nonce.length < 16) throw fail('invalid_request', 'State and nonce need at least 16 characters.');
    const requested = parameter(parameters, 'scope').split(/\s+/).filter(Boolean);
    if (!requested.includes('openid') || requested.some((s) => !SCOPES.has(s))) throw fail('invalid_scope', 'Unsupported scope.');
    return { challenge, state, nonce, resource: resource(parameters), scope: [...new Set(requested)].join(' ') };
  }
  function prune(map) { for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key); }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    // no-referrer would serialize a browser's form POST Origin as "null".
    // Preserve the issuer Origin for the same-origin confirmation form;
    // the cross-origin callback still receives no Referer.
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      if (request.headers.host !== new URL(issuer).host) throw fail('invalid_request', 'Unexpected Host header.', 403);
      const origin = request.headers.origin;
      if (origin && origin !== FRONTEND && origin !== issuer) throw fail('invalid_request', 'Origin is not allowed.', 403);
      if (origin === FRONTEND) {
        response.setHeader('Access-Control-Allow-Origin', FRONTEND);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url, issuer);
      prune(codes); prune(refreshTokens); prune(confirmations);
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok', service: 'StarDraw local development identity', localDevelopment: true }); return;
      }
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        json(response, 200, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks', userinfo_endpoint: issuer + '/userinfo', end_session_endpoint: issuer + '/logout',
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
          scopes_supported: [...SCOPES], claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name', 'preferred_username'] }); return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') { json(response, 200, { keys: [keys.jwk] }); return; }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const transaction = authorization(url.searchParams), ticket = randomToken();
        if (confirmations.size >= 1000) throw fail('temporarily_unavailable', 'Too many pending local logins.', 429);
        confirmations.set(ticket, { ...transaction, expiresAt: now() + CODE_TTL });
        // Chromium also checks the form submission's redirect against form-action.
        // Permit only the issuer and this client's exact registered callback path.
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' " + CALLBACK + "; frame-ancestors 'none'");
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StarDraw 本地测试登录</title><style>body{font:16px system-ui;background:#f7f5ef;color:#262a30;margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:540px;margin:24px;padding:36px;background:white;border:1px solid #ddd;border-radius:20px}small{color:#a14b00}h1{font-size:26px}p{line-height:1.7}button{background:#e48629;border:0;border-radius:10px;padding:14px 22px;font:inherit;cursor:pointer}code{word-break:break-word}</style><main><small>仅限本机 · 开发测试环境</small><h1>使用本地测试账号</h1><p>此登录只连接这台电脑的开发数据库。生成能力使用本地模拟结果，不是正式 AI 服务；不会读取线上用户记录。</p><p>测试身份：<code>' + escapeHtml(SUBJECT) + '</code><br>邮箱：<code>dev-admin@stardraw.local</code></p><p>账号权限仍由 StarDraw 开发数据库确定。</p><form method="post" action="/authorize"><input type="hidden" name="ticket" value="' + escapeHtml(ticket) + '"><button type="submit">以本地测试账号继续</button></form></main></html>');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/authorize') {
        if (!String(request.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw fail('invalid_request', 'Form content type required.');
        const parameters = new URLSearchParams(await body(request)), ticket = parameter(parameters, 'ticket');
        const transaction = confirmations.get(ticket); confirmations.delete(ticket);
        if (!transaction || transaction.expiresAt <= now()) throw fail('invalid_request', 'Login confirmation expired.');
        const code = randomToken();
        codes.set(code, { ...transaction, expiresAt: now() + CODE_TTL, authTime: Math.floor(now() / 1000) });
        const target = new URL(CALLBACK); target.searchParams.set('code', code); target.searchParams.set('state', transaction.state);
        response.writeHead(303, { Location: target.toString() }); response.end(); return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        if (!String(request.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw fail('invalid_request', 'Form content type required.');
        const parameters = new URLSearchParams(await body(request));
        if (parameter(parameters, 'client_id') !== CLIENT_ID) throw fail('invalid_client', 'Unknown local client.', 401);
        const grant = parameter(parameters, 'grant_type'), target = resource(parameters);
        if (grant === 'authorization_code') {
          const code = parameter(parameters, 'code'), transaction = codes.get(code);
          if (!transaction || transaction.expiresAt <= now()) throw fail('invalid_grant', 'Code expired or already used.');
          if (parameter(parameters, 'redirect_uri') !== CALLBACK || target !== transaction.resource) throw fail('invalid_grant', 'Transaction does not match.');
          const verifier = parameter(parameters, 'code_verifier');
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw fail('invalid_grant', 'Invalid PKCE verifier.');
          const candidate = Buffer.from(digest(verifier)), expected = Buffer.from(transaction.challenge);
          if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw fail('invalid_grant', 'PKCE verification failed.');
          codes.delete(code); json(response, 200, tokens({ ...transaction, resource: target })); return;
        }
        if (grant === 'refresh_token') {
          const refreshToken = parameter(parameters, 'refresh_token'), transaction = refreshTokens.get(refreshToken);
          if (!transaction || transaction.clientId !== CLIENT_ID || transaction.expiresAt <= now()) throw fail('invalid_grant', 'Refresh token expired or revoked.');
          // Stable, bounded local refresh token permits the browser's parallel API/account refreshes.
          json(response, 200, tokens({ ...transaction, resource: target, refreshToken })); return;
        }
        throw fail('unsupported_grant_type', 'Only code and refresh grants are supported.');
      }
      if (request.method === 'GET' && url.pathname === '/userinfo') {
        bearer(request, [API_AUDIENCE, ACCOUNT_AUDIENCE]); json(response, 200, claims()); return;
      }
      if (url.pathname.startsWith('/api/')) {
        bearer(request, [ACCOUNT_AUDIENCE]);
        if (request.method === 'GET' && url.pathname === '/api/my-account') { json(response, 200, { ...profile, ...profile.profile }); return; }
        if (request.method === 'GET' && url.pathname === '/api/my-account/mfa-verifications') { json(response, 200, []); return; }
        if (request.method === 'GET' && url.pathname === '/api/my-account/sessions') {
          json(response, 200, [{ id: 'local-development-session', createdAt: startedAt, isCurrent: true }]); return;
        }
        if (request.method === 'PATCH' && ['/api/my-account', '/api/my-account/profile'].includes(url.pathname)) {
          if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw fail('invalid_request', 'JSON content type required.');
          let input; try { input = JSON.parse(await body(request)); } catch { throw fail('invalid_request', 'Valid JSON required.'); }
          if (!input || Array.isArray(input) || typeof input !== 'object') throw fail('invalid_request', 'Profile patch must be an object.');
          const permitted = url.pathname.endsWith('/profile')
            ? new Set(['familyName', 'givenName', 'middleName', 'nickname', 'website', 'gender', 'birthdate', 'zoneinfo', 'locale'])
            : new Set(['name', 'username', 'avatar']);
          for (const [key, value] of Object.entries(input)) {
            if (!permitted.has(key) || typeof value !== 'string' || value.length > (key === 'avatar' ? 2048 : 200)) throw fail('invalid_request', 'Unsupported profile field.');
            if (['name', 'username'].includes(key) && !value.trim()) throw fail('invalid_request', 'Profile field cannot be empty.');
          }
          for (const [key, value] of Object.entries(input)) {
            if (url.pathname.endsWith('/profile')) profile.profile[key] = value.trim(); else profile[key] = value.trim();
          }
          profile.preferred_username = profile.username;
          json(response, 200, { ...profile, ...profile.profile }); return;
        }
        if (['/api/verifications/password', '/api/my-account/password'].includes(url.pathname)) throw fail('local_operation_unsupported', '本地测试身份不使用真实密码，请在专用测试身份平台验证密码修改。', 501);
        throw fail('not_found', 'Local Account API route not found.', 404);
      }
      if (request.method === 'GET' && url.pathname === '/logout') {
        if (parameter(url.searchParams, 'post_logout_redirect_uri') !== FRONTEND + '/') throw fail('invalid_request', 'Logout redirect must exactly match the local frontend.');
        validateJwt(parameter(url.searchParams, 'id_token_hint', true, 8192), [CLIENT_ID]);
        refreshTokens.clear(); response.writeHead(303, { Location: FRONTEND + '/' }); response.end(); return;
      }
      throw fail('not_found', 'Local identity route not found.', 404);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.oauthError || 'server_error', error_description: error.oauthError ? error.message : 'Local identity request failed.' });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  issuer = 'http://' + host + ':' + server.address().port;
  return { server, issuer, subject: SUBJECT, async close() {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const stateDirectory = process.env.LOCAL_IDENTITY_STATE_DIR || path.resolve(process.cwd(), '..', '.local', 'identity');
    const local = await startLocalIdentity({ stateDirectory });
    console.log('StarDraw local identity ready at ' + local.issuer + '; subject=' + local.subject + '.');
    const stop = async () => { await local.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
