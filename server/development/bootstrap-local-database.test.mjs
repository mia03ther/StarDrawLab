import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { assertLocalConfiguration, normalizeSchemaSql, collectBaselineMigrations, modelJsonParameters } from './bootstrap-local-database.mjs';

const env = { NODE_ENV: 'development', LOCAL_DEVELOPMENT_MODE: 'true', ROOT_ADMIN_USER_ID: 'local_dev_admin' };
const url = 'postgres://dev:local-test-password@127.0.0.1:54329/stardraw_local';

test('bootstrap accepts only explicit local development database configuration', () => {
  assert.equal(assertLocalConfiguration(url, env).pathname, '/stardraw_local');
  for (const invalid of [
    url.replace('127.0.0.1', '8.138.82.228'), url.replace('127.0.0.1', 'db.example.com'),
    url.replace('54329', '5432'), url.replace('stardraw_local', 'production'),
    url + '?options=-csearch_path%3Dother', url.replace('dev:local-test-password', 'dev'),
  ]) assert.throws(() => assertLocalConfiguration(invalid, env));
  assert.throws(() => assertLocalConfiguration(url, { ...env, NODE_ENV: 'production' }));
  assert.throws(() => assertLocalConfiguration(url, { ...env, LOCAL_DEVELOPMENT_MODE: 'false' }));
  assert.throws(() => assertLocalConfiguration(url, { ...env, ROOT_ADMIN_USER_ID: 'real_user' }));
});

test('both server address checks request host text without PostgreSQL INET netmasks', async () => {
  // inet_server_addr()::text can return 127.0.0.1/32 or ::1/128. host(inet)
  // is required before the strict plain-address allowlist can compare it.
  const source = await readFile(new URL('./bootstrap-local-database.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/host\(inet_server_addr\(\)\) AS address/g)?.length, 2);
  assert.doesNotMatch(source, /inet_server_addr\(\)::text/);
});

test('schema normalization retains SQL and removes only known pg_dump markers', () => {
  const input = Buffer.from('\\restrict ABC123\r\nCREATE TABLE public.fixture (id int);\r\n\\unrestrict ABC123\r\n');
  const hash = createHash('sha256').update(input).digest('hex');
  const result = normalizeSchemaSql(input, hash);
  assert.equal(result.sha256, hash);
  assert.equal(result.sql.trim(), 'CREATE TABLE public.fixture (id int);');
  assert.throws(() => normalizeSchemaSql(Buffer.from('different'), hash), /checksum/);
});

test('schema snapshot refuses unexpected psql commands and row-data exports', () => {
  for (const input of ['\\! calc.exe\n', 'COPY public.users FROM stdin;\n', 'INSERT INTO public.users VALUES (1);\n']) {
    const buffer = Buffer.from(input);
    const hash = createHash('sha256').update(buffer).digest('hex');
    assert.throws(() => normalizeSchemaSql(buffer, hash));
  }
});

test('local baseline covers exactly migrations 041 through 063 with real source hashes', async () => {
  const migrations = await collectBaselineMigrations('D:\\StarDrawLab');
  assert.equal(migrations.length, 23);
  assert.equal(migrations[0].filename, '041_schema_migration_ledger.sql');
  assert.equal(migrations.at(-1).version, 63);
  assert.ok(migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.sha256)));
});

test('catalog JSONB values preserve object and array shapes for the real postgres.js serializer', async () => {
  const requireFromServer = createRequire('D:/StarDrawLab/server/package.json');
  const postgres = requireFromServer('postgres');
  const sql = postgres({ max: 1 }); // Lazy; this test never makes a connection.
  try {
    const model = { capabilities: { local_development: true }, resolutions: ['1K'], ratios: ['1:1'] };
    const parameters = modelJsonParameters(sql, model);
    for (const field of ['capabilities', 'resolutions', 'ratios']) {
      assert.equal(parameters[field].type, 3802);
      assert.deepEqual(parameters[field].value, model[field]);
      assert.equal(typeof parameters[field].value, 'object');
    }
    assert.ok(Array.isArray(parameters.resolutions.value));
    assert.ok(Array.isArray(parameters.ratios.value));
  } finally { await sql.end(); }
});
