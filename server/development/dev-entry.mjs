/** Separate local-development entry. Production continues to run server.js. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { LocalFileStorage, assertLocalDevelopment } from './local-provider.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(serverRoot, 'package.json'));
require('dotenv').config({ path: path.join(serverRoot, '.env'), quiet: true });
assertLocalDevelopment();
const database = new URL(process.env.DATABASE_URL || '');
if (!['postgres:','postgresql:'].includes(database.protocol) || !['127.0.0.1','localhost','[::1]'].includes(database.hostname)
    || database.port !== '54329' || database.pathname !== '/stardraw_local') throw new Error('Local entry requires loopback PostgreSQL :54329/stardraw_local');
if (process.env.AUTH_PROVIDER !== 'oidc' || process.env.OIDC_ISSUER !== 'http://127.0.0.1:4300'
    || process.env.OIDC_JWKS_URI !== 'http://127.0.0.1:4300/jwks') throw new Error('Local entry requires the dedicated local OIDC provider');
const origins = String(process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
if (!origins.length || origins.some(origin => !['http://localhost:5173','http://127.0.0.1:5173'].includes(origin))) throw new Error('Local entry permits only the localhost frontend origins');
if (process.env.HOST !== '127.0.0.1' || process.env.ALLOW_DEV_AUTH_HEADERS !== 'false') throw new Error('Local entry requires HOST=127.0.0.1 and normal signed-token authentication');
if (process.env.PROVIDER_MOCKS_ENABLED !== 'false') throw new Error('Legacy external provider mocks must be disabled');
for (const name of ['IMAGE_PROVIDER_BASE_URL','SORA_BASE_URL','CREATIVE_LLM_BASE_URL','CANVAS_AGENT_LLM_BASE_URL']) {
  const value = new URL(process.env[name] || '');
  if (value.origin !== 'http://127.0.0.1:4311' || value.username || value.password) throw new Error(`${name} must point to the local fixture service`);
}
for (const name of ['SUBSCRIPTION_PURCHASES_ENABLED','ALIPAY_PERIODIC_ENABLED','SUBSCRIPTION_REFUND_RECONCILIATION_ENABLED','SUBSCRIPTION_PAYMENT_RECONCILIATION_ENABLED']) {
  if (process.env[name] !== 'false') throw new Error(`${name} must be false in the local fixture environment`);
}
const { setObjectStorageForTests } = await import('../services/objectStorageComposition.js');
setObjectStorageForTests(new LocalFileStorage({
  root: path.join(serverRoot, '..', '.local', 'object-storage'),
  secret: process.env.LOCAL_STORAGE_SECRET,
}));
console.log('LOCAL DEVELOPMENT: isolated database, signed local OIDC, local storage and explicitly simulated providers.');
if (process.argv.includes('--worker')) {
  process.env.JOB_WORKER_ENABLED = 'true';
  process.env.WORKER_HEALTH_FILE = path.join(serverRoot, '..', '.local', 'logs', 'worker-health.json');
  await import('../workerEntry.js');
} else {
  await import('../server.js');
}
