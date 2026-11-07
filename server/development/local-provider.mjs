/** Local development fixtures. This is not an AI provider or a production storage backend. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = '[LOCAL MOCK] 本地开发模拟结果，不是真实 AI 生成';
const MAX_BYTES = 24 * 1024 * 1024;
const fail = (message, status = 400, code = 'LOCAL_DEVELOPMENT_ERROR') => Object.assign(new Error(message), { status, code });
export function assertLocalDevelopment(env = process.env) {
  if (env.NODE_ENV !== 'development' || env.LOCAL_DEVELOPMENT_MODE !== 'true') {
    throw fail('Local fixtures require NODE_ENV=development and LOCAL_DEVELOPMENT_MODE=true', 503, 'LOCAL_MODE_REQUIRED');
  }
}
export function assertLocalOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw fail('Only HTTP loopback origins are permitted');
  return url.origin;
}
function objectKey(value) {
  const key = String(value || '');
  if (!key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || /[\x00-\x1f?#]/.test(key)
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(key) || /%2f|%5c/i.test(key)) throw fail('Invalid local object key');
  return key;
}
function contentType(value) {
  const type = String(value || '').toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream';
}
function equal(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && timingSafeEqual(first, second);
}

export class LocalFileStorage {
  constructor({ root, secret, baseUrl = 'http://127.0.0.1:4311', env = process.env }) {
    assertLocalDevelopment(env);
    if (String(secret || '').length < 32) throw fail('LOCAL_STORAGE_SECRET must be at least 32 characters');
    this.root = path.resolve(root);
    this.secret = secret;
    this.baseUrl = assertLocalOrigin(baseUrl);
  }
  files(key) {
    const normalized = objectKey(key);
    const hash = createHash('sha256').update(normalized).digest('hex');
    return { key: normalized, data: path.join(this.root, hash + '.bin'), meta: path.join(this.root, hash + '.json') };
  }
  buildObjectKey(userId, type, ext = 'jpg') {
    for (const segment of [userId, type, ext]) {
      if (!/^[a-zA-Z0-9_-]{1,255}$/.test(String(segment))) throw fail('Invalid local object key segment');
    }
    return `quickai/${userId}/${type}_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 16)}.${ext}`;
  }
  async uploadBuffer(buffer, key, type = 'application/octet-stream') {
    const value = Buffer.from(buffer);
    if (!value.length || value.length > MAX_BYTES) throw fail('Local object must contain 1 byte to 24 MiB', 422);
    const files = this.files(key);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(files.data, value);
    await fs.writeFile(files.meta, JSON.stringify({ key: files.key, contentType: contentType(type), bytes: value.length, localMock: true }));
    return { objectKey: files.key, url: '/oss-proxy/' + files.key };
  }
  async uploadFromUrl(remoteUrl, key, type) {
    const target = new URL(remoteUrl);
    if (target.origin !== this.baseUrl || !/^\/(?:assets|objects)\//.test(target.pathname)
        || target.username || target.password) throw fail('Local storage only imports this fixture service; external fetch is disabled', 422);
    const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw fail('Local fixture download failed', 502);
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_BYTES) throw fail('Local fixture is too large', 413);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw fail('Local fixture is too large', 413);
      chunks.push(chunk);
    }
    return this.uploadBuffer(Buffer.concat(chunks), key, type || response.headers.get('content-type'));
  }
  async getObjectMetadata(key) {
    const files = this.files(key);
    try {
      const [metadata, stat] = await Promise.all([fs.readFile(files.meta, 'utf8'), fs.stat(files.data)]);
      const meta = JSON.parse(metadata);
      if (meta.key !== files.key || stat.size !== meta.bytes) throw fail('Local object metadata mismatch', 500);
      return { exists: true, sizeBytes: stat.size, contentType: meta.contentType };
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, sizeBytes: null, contentType: null };
      throw error;
    }
  }
  async downloadBuffer(key) {
    const files = this.files(key);
    try {
      const [metadata, buffer] = await Promise.all([fs.readFile(files.meta, 'utf8'), fs.readFile(files.data)]);
      const meta = JSON.parse(metadata);
      if (meta.key !== files.key || buffer.length !== meta.bytes || !buffer.length) throw fail('Local object metadata mismatch', 500);
      return { buffer, contentType: meta.contentType };
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('Local object not found', 404, 'RESOURCE_NOT_FOUND');
      throw error;
    }
  }
  async headObject(key) {
    const result = await this.downloadBuffer(key);
    return { contentLength: result.buffer.length, contentType: result.contentType };
  }
  async deleteObject(key) {
    if (!key) return;
    const files = this.files(key);
    await Promise.all([fs.rm(files.data, { force: true }), fs.rm(files.meta, { force: true })]);
  }
  async deleteObjectsStrict(keys) {
    for (const key of keys.filter(Boolean)) await this.deleteObject(key);
  }
  signature(key, expiry, processValue = '') {
    return createHmac('sha256', this.secret).update(JSON.stringify([objectKey(key), String(expiry), processValue])).digest('hex');
  }
  getSignedDownloadUrl(key, expiresSeconds = 300, processValue = null) {
    if (processValue) throw fail('Local video snapshot processing is not supported', 501, 'LOCAL_MOCK_PROCESS_UNAVAILABLE');
    const expiry = Math.floor(Date.now() / 1000) + Math.min(900, Math.max(1, Number(expiresSeconds) || 300));
    const query = new URLSearchParams({ expires: String(expiry), signature: this.signature(key, expiry) });
    return this.baseUrl + '/objects/' + encodeURIComponent(objectKey(key)) + '?' + query;
  }
  verifySignedUrl(key, query) {
    const expiry = String(query.get('expires') || '');
    const now = Math.floor(Date.now() / 1000);
    if (!/^\d{10}$/.test(expiry) || Number(expiry) < now || Number(expiry) > now + 900
        || !equal(this.signature(key, expiry), query.get('signature') || '')) throw fail('Local object signature is invalid or expired', 403);
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Local-Mock': 'true' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw fail('Request too large', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (!raw.length || !String(req.headers['content-type']).includes('application/json')) return {};
  try { return JSON.parse(raw.toString()); } catch { throw fail('Invalid JSON'); }
}
const xml = (value) => String(value).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));
export async function renderMockImage({ projectRoot, prompt = '', size = '1024x1024' }) {
  const [width, height] = String(size).split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 2048 || height > 2048) {
    throw fail('Local image fixtures support dimensions from 128 to 2048 pixels', 422);
  }
  const require = createRequire(path.join(projectRoot, 'server', 'package.json'));
  const sharp = require('sharp');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#17191d"/><rect x="5%" y="8%" width="90%" height="84%" rx="30" fill="#263038" stroke="#ee9d47" stroke-width="5"/><text x="50%" y="35%" font-family="Arial" font-size="${Math.round(width/12)}" fill="#ee9d47" text-anchor="middle">LOCAL MOCK</text><text x="50%" y="48%" font-family="Arial" font-size="${Math.round(width/32)}" fill="white" text-anchor="middle">Development fixture - not AI generated</text><text x="50%" y="63%" font-family="Arial" font-size="${Math.round(width/40)}" fill="#dfe2eb" text-anchor="middle">${xml(String(prompt).slice(0, 48))}</text><text x="50%" y="76%" font-family="Arial" font-size="${Math.round(width/40)}" fill="#dfe2eb" text-anchor="middle">${width} x ${height}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
export function mockChatContent(body) {
  const system = (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
  if (body.response_format?.type === 'json_object' || /JSON|json object|JSON schema/.test(system)) {
    if (/independent StarDraw Canvas Agent/.test(system)) return JSON.stringify({ action: 'finish', summary: LABEL + '。这里只验证对话接线；请使用图片生成页面测试本地图片流程，复杂工作流需要真实模型。' });
    if (system.includes('"actions"')) return JSON.stringify({ summary: LABEL + '。已准备测试提示词，尚未执行生成。', actions: [{ type: 'set_image_prompt', prompt: '[LOCAL MOCK] local development test image' }] });
    return JSON.stringify({ summary: LABEL, response: LABEL + '。本地模型接口连接正常，复杂推理与自动工具编排需要真实模型。', execution_mode: 'reactive', calls: [], content: LABEL, prompt: LABEL, optimized_prompt: LABEL, script: LABEL });
  }
  return LABEL + '。本地模型接口连接正常；该回复仅用于开发测试。';
}
export function createLocalProviderServer({ storage, projectRoot, providerKey = 'local-development-only', env = process.env }) {
  assertLocalDevelopment(env);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, storage.baseUrl);
      if (req.headers.origin && !['http://localhost:5173', 'http://127.0.0.1:5173'].includes(req.headers.origin)) throw fail('Origin not allowed', 403);
      if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-api-key' }); return res.end();
      }
      if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok', localMock: true, capabilities: { images: true, chat: true, videos: false }, label: LABEL });
      if (url.pathname.startsWith('/objects/') && ['GET','HEAD'].includes(req.method)) {
        const key = objectKey(decodeURIComponent(url.pathname.slice('/objects/'.length)));
        storage.verifySignedUrl(key, url.searchParams);
        const { buffer, contentType } = await storage.downloadBuffer(key);
        let start = 0, end = buffer.length - 1, status = 200;
        const headers = { 'Content-Type': contentType, 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'X-Local-Mock': 'true' };
        if (req.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!range || (!range[1] && !range[2])) throw fail('Unsupported byte range', 416);
          if (!range[1]) start = Math.max(0, buffer.length - Number(range[2]));
          else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
          if (start > end || start >= buffer.length) { res.writeHead(416, { 'Content-Range': 'bytes */' + buffer.length }); return res.end(); }
          status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${buffer.length}`;
        }
        headers['Content-Length'] = end - start + 1;
        res.writeHead(status, headers);
        return res.end(req.method === 'HEAD' ? undefined : buffer.subarray(start, end + 1));
      }
      if (req.method === 'GET' && url.pathname === '/assets/local-mock.png') {
        const buffer = await renderMockImage({ projectRoot, prompt: 'Local development fixture' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length, 'X-Local-Mock': 'true' }); return res.end(buffer);
      }
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
      if (!equal(key || '', providerKey)) throw fail('Local provider key required', 401);
      if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(url.pathname)) {
        const body = await readBody(req);
        const buffer = await renderMockImage({ projectRoot, prompt: body.prompt, size: body.size || '1024x1024' });
        return sendJson(res, 200, { created: Math.floor(Date.now()/1000), data: [{ b64_json: buffer.toString('base64'), revised_prompt: LABEL }], localMock: true, note: LABEL });
      }
      if (url.pathname.startsWith('/v1/videos')) return sendJson(res, 501, { error: { code: 'LOCAL_MOCK_VIDEO_UNAVAILABLE', message: '本地模拟环境尚未配置可播放视频样例，视频生成未执行。' }, localMock: true });
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req), content = mockChatContent(body);
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Local-Mock': 'true' });
          res.write('data: ' + JSON.stringify({ id: 'local-mock-' + randomUUID(), model: 'local-mock', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }], localMock: true }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage, localMock: true }) + '\n\n');
          return res.end('data: [DONE]\n\n');
        }
        return sendJson(res, 200, { id: 'local-mock-' + randomUUID(), object: 'chat.completion', model: 'local-mock', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage, localMock: true });
      }
      return sendJson(res, 404, { error: { code: 'LOCAL_MOCK_ENDPOINT_UNAVAILABLE', message: 'This endpoint is not implemented by the local fixture service.' } });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status || 500, { error: { code: error.code || 'LOCAL_FIXTURE_ERROR', message: error.message } });
      else res.end();
    }
  });
}

async function main() {
  const projectRoot = path.resolve(process.env.LOCAL_PROJECT_ROOT || fileURLToPath(new URL('../..', import.meta.url)));
  const require = createRequire(path.join(projectRoot, 'server', 'package.json'));
  require('dotenv').config({ path: path.join(projectRoot, 'server', '.env'), quiet: true });
  assertLocalDevelopment();
  const storage = new LocalFileStorage({ root: path.join(projectRoot, '.local', 'object-storage'), secret: process.env.LOCAL_STORAGE_SECRET });
  const server = createLocalProviderServer({ storage, projectRoot, providerKey: process.env.LOCAL_PROVIDER_API_KEY || 'local-development-only' });
  server.listen(4311, '127.0.0.1', () => console.log('Local fixture provider/storage listening on http://127.0.0.1:4311; images/chat simulated, videos unavailable.'));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
