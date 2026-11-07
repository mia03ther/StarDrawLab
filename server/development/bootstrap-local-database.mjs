import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const LOCAL_DATABASE = 'stardraw_local';
export const LOCAL_PORT = '54329';
export const LOCAL_USER_ID = 'local_dev_admin';
export const SNAPSHOT_SHA256 = 'eac94420d156c59f3329bc3a18cff13227967323f2933c2466da7447499c1c12';
export const BASELINE_LABEL = 'local-schema-baseline';
const BOOTSTRAP_VERSION = 1;
const GRANT_POINTS = 100_000;

export function assertLocalConfiguration(databaseUrl, env = process.env) {
  if (env.NODE_ENV !== 'development' || env.LOCAL_DEVELOPMENT_MODE !== 'true') {
    throw new Error('Local bootstrap requires NODE_ENV=development and LOCAL_DEVELOPMENT_MODE=true.');
  }
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new Error('A local DATABASE_URL is required.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.port !== LOCAL_PORT
      || parsed.pathname !== '/' + LOCAL_DATABASE
      || !parsed.username || !parsed.password || parsed.search || parsed.hash) {
    throw new Error('Refusing database URL: only an authenticated loopback connection on port 54329 to stardraw_local is allowed.');
  }
  if (env.ROOT_ADMIN_USER_ID && env.ROOT_ADMIN_USER_ID !== LOCAL_USER_ID) {
    throw new Error('ROOT_ADMIN_USER_ID must be local_dev_admin for this local fixture.');
  }
  return parsed;
}

export function normalizeSchemaSql(source, expectedHash = SNAPSHOT_SHA256) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || sha256 !== expectedHash) {
    throw new Error('Schema snapshot checksum mismatch. No database changes made.');
  }
  const sourceText = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (/^(?:COPY\s|INSERT\s+INTO\s)/im.test(sourceText)) {
    throw new Error('Refusing a snapshot with data-copy statements; use a schema-only export.');
  }
  const sql = sourceText.split(/\r?\n/).filter((line) => {
    if (/^\\(?:un)?restrict\s+[A-Za-z0-9]+\s*$/.test(line)) return false;
    if (/^\s*\\/.test(line)) throw new Error('Unexpected psql meta-command in schema snapshot.');
    return true;
  }).join('\n');
  return { sql, sha256 };
}

export async function collectBaselineMigrations(projectRoot) {
  const directory = path.join(projectRoot, 'server', 'migrations');
  const files = (await fs.readdir(directory)).filter((name) => /^\d{3}_[A-Za-z0-9_]+\.sql$/.test(name));
  const result = [];
  for (let version = 41; version <= 63; version++) {
    const matches = files.filter((name) => Number(name.slice(0, 3)) === version);
    if (matches.length !== 1) throw new Error(`Expected exactly one source file for migration ${version}.`);
    const filename = matches[0];
    result.push({ version, filename, sha256: createHash('sha256').update(await fs.readFile(path.join(directory, filename))).digest('hex') });
  }
  return result;
}

export function modelJsonParameters(sql, model) {
  // postgres.js serializes JSONB parameters itself. Passing JSON.stringify
  // here would encode a JSON string rather than the object/arrays required
  // by the catalog's database constraints.
  return {
    capabilities: sql.json(model.capabilities),
    resolutions: sql.json(model.resolutions),
    ratios: sql.json(model.ratios),
  };
}

async function seedFixtures(tx) {
  await tx`
    INSERT INTO user_profiles
      (user_id, display_name, email, full_name, app_role, account_status, auth_valid_after, role_updated_at)
    VALUES
      (${LOCAL_USER_ID}, '本地开发测试员', 'dev-admin@stardraw.local', '本地开发测试员', 'root', 'active', to_timestamp(0), NOW())
    ON CONFLICT (user_id) DO NOTHING
  `;
  await tx`
    INSERT INTO user_point_accounts (user_id, balance_points, held_points, membership_tier)
    VALUES (${LOCAL_USER_ID}, 0, 0, 'free') ON CONFLICT (user_id) DO NOTHING
  `;
  const grantKey = 'local-bootstrap:points:local_dev_admin:v1';
  const [existingLot] = await tx`SELECT id FROM point_lots WHERE idempotency_key = ${grantKey}`;
  if (!existingLot) {
    const [account] = await tx`SELECT balance_points, held_points FROM user_point_accounts WHERE user_id = ${LOCAL_USER_ID} FOR UPDATE`;
    const [lot] = await tx`
      INSERT INTO point_lots
        (user_id, source_type, source_id, category, total_points, available_points, idempotency_key, metadata)
      VALUES
        (${LOCAL_USER_ID}, 'local_development', 'bootstrap-v1', 'manual', ${GRANT_POINTS}, ${GRANT_POINTS}, ${grantKey},
         '{"local_development":true,"monetary_value":false}'::jsonb)
      RETURNING id
    `;
    const balance = Number(account.balance_points) + GRANT_POINTS;
    await tx`UPDATE user_point_accounts SET balance_points = ${balance}, version = version + 1, updated_at = NOW() WHERE user_id = ${LOCAL_USER_ID}`;
    await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key, change_points,
         held_points_change, balance_after, held_after, lot_id, note, metadata)
      VALUES
        (${LOCAL_USER_ID}, 'recharge', 'local_development', 'bootstrap-v1', ${grantKey}, ${GRANT_POINTS},
         0, ${balance}, ${Number(account.held_points)}, ${lot.id}, '仅本地测试积分，不代表真实付款',
         '{"local_development":true,"monetary_value":false}'::jsonb)
    `;
  }

  const models = [
    { key: 'gpt-image-2', name: '本地模拟图片', type: 'image', provider: 'image_provider', active: true,
      capabilities: { reference_images: true, local_development: true }, resolutions: ['1K', '2K', '4K'], ratios: ['1:1', '16:9', '9:16'] },
    { key: 'gpt-5.6-sol', name: '本地模拟 Agent', type: 'agent', provider: 'canvas_agent', active: true,
      capabilities: { tool_calling: true, mcp: true, skills: true, local_development: true }, resolutions: [], ratios: [] },
    { key: 'veo-3-1', name: '本地视频（未配置）', type: 'video', provider: 'sora', active: false,
      capabilities: { reference_images: true, local_development: true }, resolutions: ['720p'], ratios: ['16:9', '9:16'] },
  ];
  for (const model of models) {
    const json = modelJsonParameters(tx, model);
    await tx`
      INSERT INTO model_catalog
        (model_key, display_name, output_type, description, capabilities, resolutions, aspect_ratios,
         minimum_membership_tier, is_active, display_order, metadata)
      VALUES
        (${model.key}, ${model.name}, ${model.type}, 'Local development fixture; not a real AI provider.',
         ${json.capabilities}, ${json.resolutions},
         ${json.ratios}, 'free', ${model.active}, 1,
         '{"local_development":true,"mock":true}'::jsonb)
      ON CONFLICT (model_key) DO NOTHING
    `;
    await tx`
      INSERT INTO model_routes (model_key, provider_key, upstream_model_id, priority, is_active, route_config)
      VALUES (${model.key}, ${model.provider}, ${model.key}, 1, ${model.active}, '{"local_development":true}'::jsonb)
      ON CONFLICT (model_key, provider_key, upstream_model_id) DO NOTHING
    `;
    await tx`
      INSERT INTO generation_charge_rules
        (output_type, provider, scene_key, model, seconds, size, points_cost, priority, is_active, generation_mode, meta_rule)
      SELECT ${model.type}, ${model.provider}, NULL, ${model.key}, NULL, NULL,
             ${model.type === 'video' ? 2 : 1}, 1, ${model.active}, 'all',
             '{"billing_type":"fixed","local_development":true}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM generation_charge_rules
        WHERE output_type = ${model.type} AND provider = ${model.provider}
          AND model = ${model.key} AND scene_key IS NULL AND seconds IS NULL AND size IS NULL
          AND generation_mode = 'all'
      )
    `;
  }
  for (const template of [
    { key: 'freeform_image', name: '本地模拟图片', type: 'image', provider: 'image_provider', model: 'gpt-image-2', size: '1024x1024', seconds: null, active: true },
    { key: 'local_demo_image', name: '本地开发示例', type: 'image', provider: 'image_provider', model: 'gpt-image-2', size: '1024x1024', seconds: null, active: true },
    { key: 'freeform_video', name: '本地视频（暂未配置）', type: 'video', provider: 'sora', model: 'veo-3-1', size: '1280x720', seconds: 8, active: false },
  ]) {
    await tx`
      INSERT INTO prompt_templates
        (scene_key, scene_name, output_type, target_provider, default_model, default_size, default_seconds,
         system_prompt, display_order, is_active, is_featured, featured_order, preview_title,
         preview_description, starter_prompt, placeholder_text, requires_reference, tags,
         visibility, approval_status, required_membership_tier, catalog_metadata)
      VALUES
        (${template.key}, ${template.name}, ${template.type}, ${template.provider}, ${template.model},
         ${template.size}, ${template.seconds}, 'This is a LOCAL MOCK fixture. Return only clearly marked local development samples.',
         1, ${template.active}, ${template.key === 'local_demo_image'}, 1, ${template.name},
         '仅用于本地开发联调，结果不是模型真实生成的作品。', '生成一张本地测试图片', '输入测试描述', false,
         '["local-development","mock"]'::jsonb, 'public', 'approved', 'free',
         '{"local_development":true,"mock":true}'::jsonb)
      ON CONFLICT (scene_key) DO NOTHING
    `;
  }
}

export async function bootstrapLocalDatabase({ projectRoot, schemaFile, databaseUrl, expectedHash = SNAPSHOT_SHA256, env = process.env }) {
  const parsed = assertLocalConfiguration(databaseUrl, env);
  const schema = normalizeSchemaSql(await fs.readFile(schemaFile), expectedHash);
  const migrations = await collectBaselineMigrations(projectRoot);
  const requireFromServer = createRequire(path.join(path.resolve(projectRoot), 'server', 'package.json'));
  const postgres = requireFromServer('postgres');
  const connectionOptions = { max: 1, ssl: false, connect_timeout: 10, onnotice: () => {} };
  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), connectionOptions);
  try {
    const [server] = await admin`SELECT current_setting('server_version_num')::int AS version, host(inet_server_addr()) AS address`;
    if (server.version < 160000 || server.version >= 170000 || !['127.0.0.1', '::1'].includes(server.address)) {
      throw new Error('Refusing server: local PostgreSQL 16 on a loopback address is required.');
    }
    const [exists] = await admin`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${LOCAL_DATABASE}) AS found`;
    if (!exists.found) await admin.unsafe('CREATE DATABASE stardraw_local');
  } finally { await admin.end({ timeout: 5 }); }

  const sql = postgres(parsed.toString(), connectionOptions);
  let imported = false;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(523493029)`;
      const [database] = await tx`SELECT current_database() AS name, host(inet_server_addr()) AS address`;
      if (database.name !== LOCAL_DATABASE || !['127.0.0.1', '::1'].includes(database.address)) {
        throw new Error('Connected database is not the expected local fixture.');
      }
      const [state] = await tx`
        SELECT to_regclass('public.stardraw_local_bootstrap_meta')::text AS marker,
               (SELECT COUNT(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')) AS table_count
      `;
      if (!state.marker && state.table_count > 0) {
        throw new Error('Existing database has tables without a local-bootstrap marker. Refusing to overwrite it.');
      }
      if (!state.marker) {
        await tx.unsafe(schema.sql).simple();
        await tx`SET LOCAL search_path TO public`;
        await tx`
          CREATE TABLE public.stardraw_local_bootstrap_meta (
            singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
            environment text NOT NULL CHECK (environment = 'local-development'),
            schema_sha256 char(64) NOT NULL,
            bootstrap_version integer NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            note text NOT NULL
          )
        `;
        await tx`
          INSERT INTO public.stardraw_local_bootstrap_meta
            (singleton, environment, schema_sha256, bootstrap_version, note)
          VALUES (true, 'local-development', ${schema.sha256}, ${BOOTSTRAP_VERSION},
            'Schema-only local snapshot. Ledger entries below are local baselines, not production execution history.')
        `;
        imported = true;
      } else {
        const [marker] = await tx`SELECT environment, schema_sha256, bootstrap_version FROM public.stardraw_local_bootstrap_meta WHERE singleton`;
        if (!marker || marker.environment !== 'local-development' || marker.schema_sha256 !== schema.sha256 || marker.bootstrap_version !== BOOTSTRAP_VERSION) {
          throw new Error('Existing local marker does not match this bootstrap/schema version. No changes applied.');
        }
        await tx`SET LOCAL search_path TO public`;
      }
      for (const migration of migrations) {
        const [existing] = await tx`SELECT filename, sha256, applied_by, release_version FROM schema_migrations WHERE version = ${migration.version}`;
        if (existing) {
          if (existing.filename !== migration.filename || existing.sha256 !== migration.sha256
              || existing.applied_by !== 'local-bootstrap' || existing.release_version !== BASELINE_LABEL) {
            throw new Error(`Migration ledger ${migration.version} is not the expected local baseline. Refusing replacement.`);
          }
        } else {
          await tx`
            INSERT INTO schema_migrations (version, filename, sha256, applied_by, release_version, execution_duration_ms)
            VALUES (${migration.version}, ${migration.filename}, ${migration.sha256}, 'local-bootstrap', ${BASELINE_LABEL}, 0)
          `;
        }
      }
      await seedFixtures(tx);
    });
    await sql`SET search_path TO public`;
    const { checkDatabaseReadiness } = await import(pathToFileURL(path.join(projectRoot, 'server', 'services', 'readinessService.js')).href);
    const readiness = await checkDatabaseReadiness({ sqlClient: sql, requiredMigrationVersion: 63 });
    const [account] = await sql`SELECT balance_points, held_points FROM user_point_accounts WHERE user_id = ${LOCAL_USER_ID}`;
    return {
      database: LOCAL_DATABASE, port: Number(LOCAL_PORT), importedSchema: imported,
      schemaSha256: schema.sha256, baseline: BASELINE_LABEL, migration: readiness.migration,
      userId: LOCAL_USER_ID, balancePoints: Number(account.balance_points), heldPoints: Number(account.held_points),
      realUserDataImported: false,
    };
  } finally { await sql.end({ timeout: 5 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      project: { type: 'string', default: process.env.STARDRAW_PROJECT_ROOT || 'D:\\StarDrawLab' },
      'schema-file': { type: 'string' },
      'schema-sha256': { type: 'string', default: SNAPSHOT_SHA256 },
    } });
    if (!values['schema-file']) throw new Error('--schema-file is required.');
    const result = await bootstrapLocalDatabase({
      projectRoot: path.resolve(values.project), schemaFile: path.resolve(values['schema-file']),
      databaseUrl: process.env.DATABASE_URL, expectedHash: values['schema-sha256'],
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Local database bootstrap failed:', error.message);
    process.exitCode = 1;
  }
}
