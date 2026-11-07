const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const server = path.join(root, 'server');
const state = path.join(root, '.local');
const logs = path.join(state, 'logs');
require('dotenv').config({ path: path.join(server, '.env'), quiet: true });
if (process.env.NODE_ENV !== 'development' || process.env.LOCAL_DEVELOPMENT_MODE !== 'true') {
  throw new Error('This launcher only starts the explicitly configured local development environment.');
}
fs.mkdirSync(logs, { recursive: true });
const pg = path.join(state, 'runtime', 'pgsql', 'bin', 'pg_ctl.exe');
const pgData = path.join(state, 'postgres');
const schema = path.join(__dirname, 'schema-snapshot.sql');
const records = {};
function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: server, env: process.env, windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || 'Command failed');
  return result.stdout;
}
async function health(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function frontendReady() {
  try {
    const response = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(1500) });
    if (response.status !== 200) return false;
    const html = await response.text();
    return html.includes('/@vite/client') && html.includes('<title>StarDraw</title>');
  } catch {
    return false;
  }
}
async function waitUntil(check, label) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(label + ' did not become ready. See ' + logs);
}
function start(name, args, cwd = server) {
  const stdout = fs.openSync(path.join(logs, name + '.stdout.log'), 'a');
  const stderr = fs.openSync(path.join(logs, name + '.stderr.log'), 'a');
  const child = spawn(process.execPath, args, { cwd, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  child.unref(); fs.closeSync(stdout); fs.closeSync(stderr);
  records[name] = { pid: child.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(state, 'services.json'), JSON.stringify(records, null, 2));
}
async function main() {
  if (!fs.existsSync(pg)) throw new Error('Portable PostgreSQL runtime is missing.');
  const pgStatus = spawnSync(pg, ['status', '-D', pgData], { windowsHide: true, encoding: 'utf8' });
  if (pgStatus.status !== 0) {
    // PostgreSQL stays detached after pg_ctl exits; do not let its inherited
    // pipe handles keep spawnSync waiting forever on Windows.
    const started = spawnSync(pg, ['start', '-D', pgData, '-l', path.join(logs, 'postgres.log'), '-o', '-h 127.0.0.1 -p 54329', '-w', '-t', '60'], { windowsHide: true, stdio: 'ignore', timeout: 70000 });
    if (started.error || started.status !== 0) throw new Error('Local PostgreSQL could not start. See ' + path.join(logs, 'postgres.log'));
  }
  console.log('PostgreSQL: 127.0.0.1:54329');
  console.log(command(process.execPath, [path.join(__dirname, 'bootstrap-local-database.mjs'), '--project', root, '--schema-file', schema]).trim());

  const identity = await health('http://127.0.0.1:4300/health');
  if (!identity?.localDevelopment) start('identity', [path.join(__dirname, 'localIdentity.mjs')]);
  await waitUntil(async () => (await health('http://127.0.0.1:4300/health'))?.localDevelopment, 'Local identity');

  const provider = await health('http://127.0.0.1:4311/health');
  if (!provider?.localMock) start('providers', [path.join(__dirname, 'local-provider.mjs')]);
  await waitUntil(async () => (await health('http://127.0.0.1:4311/health'))?.localMock, 'Local providers');

  const api = await health('http://127.0.0.1:5000/health');
  if (api && api.release !== process.env.RELEASE_VERSION) throw new Error('Another API occupies port 5000.');
  if (!api) start('api', [path.join(__dirname, 'dev-entry.mjs')]);
  await waitUntil(async () => (await health('http://127.0.0.1:5000/ready'))?.status === 'ready', 'Local API/database');

  const heartbeat = path.join(logs, 'worker-health.json');
  let workerFresh = false;
  try { workerFresh = Date.now() - fs.statSync(heartbeat).mtimeMs < 30000; } catch {}
  if (!workerFresh) start('worker', [path.join(__dirname, 'dev-entry.mjs'), '--worker']);

  const frontend = await frontendReady();
  if (!frontend) start('frontend', [path.join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], path.join(root, 'client'));
  await waitUntil(frontendReady, 'Local frontend');
  console.log('API ready: http://127.0.0.1:5000/ready');
  console.log('Frontend: http://127.0.0.1:5173/');
  console.log('Local test account and simulated image/chat only. Video and real provider credentials are not configured.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
