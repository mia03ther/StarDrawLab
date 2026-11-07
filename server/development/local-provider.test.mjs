import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFileStorage, assertLocalDevelopment, assertLocalOrigin, createLocalProviderServer } from './local-provider.mjs';

const env = { NODE_ENV: 'development', LOCAL_DEVELOPMENT_MODE: 'true' };
const projectRoot = process.env.LOCAL_PROJECT_ROOT || fileURLToPath(new URL('../..', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stardraw-local-storage-test-'));
  const storage = new LocalFileStorage({ root, secret: 'test-local-storage-secret-that-is-at-least-32-characters', env });
  const server = createLocalProviderServer({ storage, projectRoot, env });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  storage.baseUrl = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('stardraw-local-storage-test-')) throw new Error('Unsafe test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { storage, url: storage.baseUrl };
}
test('local fixtures refuse production or missing explicit opt-in', () => {
  assert.throws(() => assertLocalDevelopment({ NODE_ENV: 'production', LOCAL_DEVELOPMENT_MODE: 'true' }), /require/);
  assert.throws(() => assertLocalDevelopment({ NODE_ENV: 'development' }), /require/);
  assert.throws(() => assertLocalOrigin('https://example.com'), /loopback/);
  assert.throws(() => assertLocalOrigin('http://user:pass@localhost:4311'), /loopback/);
});
test('storage verifies signatures, supports real bytes/ranges and refuses traversal', async t => {
  const { storage } = await fixture(t);
  const key = storage.buildObjectKey('local_dev_admin', 'image', 'png');
  await storage.uploadBuffer(Buffer.from('abcdef'), key, 'image/png');
  assert.deepEqual(await storage.getObjectMetadata(key), { exists: true, sizeBytes: 6, contentType: 'image/png' });
  const url = storage.getSignedDownloadUrl(key);
  const fetched = await fetch(url);
  assert.equal(fetched.status, 200);
  assert.equal(await fetched.text(), 'abcdef');
  const ranged = await fetch(url, { headers: { Range: 'bytes=1-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 1-3/6');
  assert.equal(await ranged.text(), 'bcd');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '6');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const tampered = new URL(url); tampered.searchParams.set('signature', 'a'.repeat(64));
  assert.equal((await fetch(tampered)).status, 403);
  const expired = new URL(url), expiry = Math.floor(Date.now()/1000)-1;
  expired.searchParams.set('expires', String(expiry)); expired.searchParams.set('signature', storage.signature(key, expiry));
  assert.equal((await fetch(expired)).status, 403);
  assert.throws(() => storage.getSignedDownloadUrl('../outside'), /Invalid/);
  assert.throws(() => storage.getSignedDownloadUrl('quickai/%2fprivate'), /Invalid/);
  await assert.rejects(storage.uploadBuffer(Buffer.alloc(0), 'empty.png'), /1 byte/);
  await assert.rejects(storage.uploadFromUrl('http://example.com/test.png', 'test.png'), /external fetch is disabled/);
  await storage.deleteObjectsStrict([key]);
  assert.deepEqual(await storage.getObjectMetadata(key), { exists: false, sizeBytes: null, contentType: null });
  await assert.rejects(storage.downloadBuffer(key), error => error.status === 404);
});
test('fixture image is a valid PNG and service says it is mock; video never falsely succeeds', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/v1/images/generations', {
    method: 'POST', headers: { Authorization: 'Bearer local-development-only', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Local test <not trusted SVG>', size: '256x256' }),
  });
  assert.equal(response.status, 200);
  const image = await response.json();
  assert.equal(image.localMock, true);
  assert.match(image.data[0].revised_prompt, /LOCAL MOCK/);
  const png = Buffer.from(image.data[0].b64_json, 'base64');
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  const video = await fetch(url + '/v1/videos', { method: 'POST', headers: { Authorization: 'Bearer local-development-only' } });
  assert.equal(video.status, 501);
  const failure = await video.json();
  assert.equal(failure.error.code, 'LOCAL_MOCK_VIDEO_UNAVAILABLE');
  assert.equal('video_url' in failure, false);
  const rejected = await fetch(url + '/v1/images/generations', { method: 'POST' });
  assert.equal(rejected.status, 401);
});
test('chat uses the same OpenAI stream shape and labels its response as a local mock', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer local-development-only', 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: true, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Respond as JSON.' }] }),
  });
  assert.match(response.headers.get('content-type'), /event-stream/);
  const stream = await response.text();
  assert.match(stream, /LOCAL MOCK/);
  assert.match(stream, /\[DONE\]/);
  const payload = JSON.parse(stream.split('\n')[0].slice(6));
  const content = JSON.parse(payload.choices[0].delta.content);
  assert.deepEqual(content.calls, []);
  assert.match(content.response, /本地开发模拟结果/);
  const wrongOrigin = await fetch(url + '/health', { headers: { Origin: 'https://example.com' } });
  assert.equal(wrongOrigin.status, 403);
});
