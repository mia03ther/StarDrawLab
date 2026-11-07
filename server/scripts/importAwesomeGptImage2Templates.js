import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const SOURCE_KEY = "awesome-gpt-image-2";
const SOURCE_REPOSITORY = "https://github.com/freestylefly/awesome-gpt-image-2";
const SOURCE_COMMIT = String(process.env.AWESOME_GPT_IMAGE_2_SOURCE_COMMIT || "76fcd0e6b3961ef2b041547aac654f1efd1ef270").trim();
const EXPECTED_CASES = 517;
const EXPECTED_STYLE_TEMPLATES = 22;
const EXPECTED_TEMPLATES = EXPECTED_CASES + EXPECTED_STYLE_TEMPLATES;
const DEFAULT_REPOSITORY_ROOT = "/home/admin/references/awesome-gpt-image-2";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

const argumentList = process.argv.slice(2);
const hasFlag = (flag) => argumentList.includes(flag);
const valueAfter = (flag) => {
  const index = argumentList.indexOf(flag);
  return index >= 0 && argumentList[index + 1] && !argumentList[index + 1].startsWith("--")
    ? argumentList[index + 1]
    : null;
};
const validateOnly = hasFlag("--validate-only");
const reuseExistingPreviews = hasFlag("--reuse-existing-previews");
const repositoryRoot = path.resolve(
  valueAfter("--repository")
  || process.env.AWESOME_GPT_IMAGE_2_REPOSITORY_ROOT
  || DEFAULT_REPOSITORY_ROOT,
);
const casesPath = path.resolve(
  valueAfter("--cases")
  || process.env.AWESOME_GPT_IMAGE_2_CATALOG_PATH
  || path.join(repositoryRoot, "data/cases.json"),
);
const styleLibraryPath = path.resolve(
  valueAfter("--styles")
  || process.env.AWESOME_GPT_IMAGE_2_STYLE_LIBRARY_PATH
  || path.join(repositoryRoot, "data/style-library.json"),
);
const skillPath = path.resolve(
  valueAfter("--skill")
  || process.env.AWESOME_GPT_IMAGE_2_SKILL_PATH
  || path.join(repositoryRoot, "agents/skills/gpt-image-2-style-library/SKILL.md"),
);
const skillReferencePath = path.resolve(
  valueAfter("--skill-reference")
  || process.env.AWESOME_GPT_IMAGE_2_SKILL_REFERENCE_PATH
  || path.join(repositoryRoot, "agents/skills/gpt-image-2-style-library/references/style-library.md"),
);
const imageRoot = path.resolve(repositoryRoot, "data/images");

const requiredText = (value, label, maxLength = null) => {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return maxLength == null ? text : text.slice(0, maxLength);
};

const normalizeList = (value, maxItems = 24) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, maxItems)
  : [];

const bilingualText = (value, maxLength = 2000) => {
  if (!value || typeof value !== "object") return String(value || "").trim().slice(0, maxLength);
  const zh = String(value.zh || "").trim();
  const en = String(value.en || "").trim();
  return [zh, en && en !== zh ? `English: ${en}` : ""].filter(Boolean).join("\n\n").slice(0, maxLength);
};

const imageFileName = (value, label) => {
  const name = path.posix.basename(requiredText(value, label, 255));
  if (!/^case\d+\.(?:avif|gif|jpe?g|png|webp)$/i.test(name)) {
    throw new Error(`${label} has an unsupported image path`);
  }
  return name;
};

const contentTypeFor = (fileName) => ({
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}[path.extname(fileName).toLowerCase()] || "application/octet-stream");

const normalizeCase = (entry, index) => {
  const id = Number(entry?.id);
  if (!Number.isSafeInteger(id) || id < 1 || id > 1_000_000) {
    throw new Error(`Invalid case id: ${entry?.id}`);
  }
  const title = requiredText(entry.title, `case ${id} title`, 100);
  const prompt = requiredText(entry.prompt, `case ${id} prompt`);
  if (prompt.length > 32_000) throw new Error(`case ${id} prompt exceeds 32000 characters`);
  const fileName = imageFileName(entry.image, `case ${id} image`);
  const category = requiredText(entry.category, `case ${id} category`, 120);
  const styles = normalizeList(entry.styles);
  const scenes = normalizeList(entry.scenes);
  return {
    kind: "case",
    sourceItemId: String(id),
    sceneKey: `awesome_gpt_image_2_case_${id}`,
    title,
    description: String(entry.promptPreview || prompt).trim().slice(0, 600),
    systemPrompt: [
      "Use this repository-backed visual example as creative direction. Preserve its composition, visual language, material treatment, typography discipline, and production quality while following the user's requested subject and changes. Do not copy logos, signatures, or watermarks unless explicitly requested.",
      `Source template prompt:\n${prompt}`,
    ].join("\n\n"),
    starterPrompt: prompt,
    placeholderText: "Describe the subject or changes you want for this template...",
    fileName,
    isFeatured: Boolean(entry.featured),
    displayOrder: 1000 + index,
    tags: [...new Set([category, ...styles, ...scenes])].slice(0, 24),
    metadata: {
      sourceType: "case",
      sourceCommit: SOURCE_COMMIT,
      category,
      styles,
      scenes,
      imageAlt: String(entry.imageAlt || title).trim().slice(0, 240),
      sourceLabel: String(entry.sourceLabel || "").trim().slice(0, 240),
      sourceUrl: String(entry.sourceUrl || "").trim().slice(0, 2000),
      githubUrl: String(entry.githubUrl || "").trim().slice(0, 2000),
    },
  };
};

const normalizeStyleTemplate = (entry, index) => {
  const id = requiredText(entry?.id, `style template ${index + 1} id`, 80);
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) throw new Error(`Invalid style template id: ${id}`);
  const titleZh = requiredText(entry?.title?.zh || entry?.title?.en, `style template ${id} title`, 120);
  const titleEn = requiredText(entry?.title?.en || entry?.title?.zh, `style template ${id} English title`, 120);
  const guidance = normalizeList(entry?.guidance?.en, 12);
  const pitfalls = normalizeList(entry?.pitfalls?.en, 12);
  const useWhen = String(entry?.useWhen?.en || entry?.useWhen?.zh || "").trim();
  const systemPrompt = [
    `Apply the ${titleEn} creative system to the user's request.`,
    useWhen ? `Use case: ${useWhen}` : "",
    guidance.length ? `Guidance:\n- ${guidance.join("\n- ")}` : "",
    pitfalls.length ? `Avoid:\n- ${pitfalls.join("\n- ")}` : "",
    "Produce a concrete, production-ready image prompt with explicit composition, visual hierarchy, readable text requirements, aspect ratio, materials, lighting, and negative constraints when relevant.",
  ].filter(Boolean).join("\n\n");
  const category = requiredText(entry?.category, `style template ${id} category`, 120);
  const styles = normalizeList(entry?.styles);
  const scenes = normalizeList(entry?.scenes);
  const tags = normalizeList([category, ...styles, ...scenes, ...normalizeList(entry?.tags)], 24);
  return {
    kind: "style-template",
    sourceItemId: `style-template:${id}`,
    // prompt_templates.scene_key is VARCHAR(50) in the current production
    // schema. Keep provenance in source_key/source_item_id and use a compact,
    // deterministic execution key here.
    sceneKey: `agpt2_style_${id.replaceAll("-", "_")}`,
    title: titleZh,
    description: bilingualText(entry?.description, 600),
    systemPrompt,
    starterPrompt: `Create a production-ready visual using the ${titleEn} system. Subject and requirements:`,
    placeholderText: bilingualText({
      zh: "描述主题、构图、文字、比例和你希望修改的内容…",
      en: "Describe the subject, composition, text, aspect ratio, and requested changes...",
    }, 300),
    fileName: imageFileName(entry?.cover, `style template ${id} cover`),
    isFeatured: true,
    displayOrder: 200 + index,
    tags,
    metadata: {
      sourceType: "style-template",
      sourceCommit: SOURCE_COMMIT,
      sourceTemplateId: id,
      anchor: String(entry?.anchor || "").trim().slice(0, 120),
      title: entry?.title || {},
      description: entry?.description || {},
      category,
      styles,
      scenes,
      tags: normalizeList(entry?.tags),
      useWhen: entry?.useWhen || {},
      guidance: entry?.guidance || {},
      pitfalls: entry?.pitfalls || {},
      exampleCases: Array.isArray(entry?.exampleCases) ? entry.exampleCases.slice(0, 24) : [],
    },
  };
};

const validateUnique = (templates) => {
  const sourceIds = new Set(templates.map((template) => template.sourceItemId));
  const sceneKeys = new Set(templates.map((template) => template.sceneKey));
  if (sourceIds.size !== templates.length || sceneKeys.size !== templates.length) {
    throw new Error("Catalog contains duplicate template identifiers");
  }
};

const readCatalog = async () => {
  const [casesRaw, stylesRaw, skillRaw, referenceRaw] = await Promise.all([
    readFile(casesPath, "utf8"),
    readFile(styleLibraryPath, "utf8"),
    readFile(skillPath, "utf8"),
    readFile(skillReferencePath, "utf8"),
  ]);
  const casesCatalog = JSON.parse(casesRaw);
  const styleCatalog = JSON.parse(stylesRaw);
  if (casesCatalog?.repository !== SOURCE_REPOSITORY || styleCatalog?.repository !== SOURCE_REPOSITORY) {
    throw new Error("Unexpected source repository in awesome-gpt-image-2 data");
  }
  if (Number(casesCatalog?.totalCases) !== EXPECTED_CASES || casesCatalog?.cases?.length !== EXPECTED_CASES) {
    throw new Error(`Expected ${EXPECTED_CASES} cases, received ${casesCatalog?.cases?.length || 0}`);
  }
  if (styleCatalog?.templates?.length !== EXPECTED_STYLE_TEMPLATES) {
    throw new Error(`Expected ${EXPECTED_STYLE_TEMPLATES} style templates, received ${styleCatalog?.templates?.length || 0}`);
  }
  const templates = [
    ...casesCatalog.cases.map(normalizeCase),
    ...styleCatalog.templates.map(normalizeStyleTemplate),
  ];
  validateUnique(templates);
  const imageNames = [...new Set(templates.map((template) => template.fileName))];
  await Promise.all(imageNames.map((fileName) => access(path.join(imageRoot, fileName))));
  const skillContent = `${skillRaw.trim()}\n\n# Embedded style library reference\n\n${referenceRaw.trim()}`;
  if (Buffer.byteLength(skillContent, "utf8") > 64 * 1024) {
    throw new Error("Combined GPT-Image2 Skill exceeds the 64 KiB database limit");
  }
  return { templates, imageNames, skillContent };
};

const assertDatabaseReady = async (sql) => {
  const columns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prompt_templates'
  `;
  const columnNames = new Set(columns.map((row) => row.column_name));
  for (const column of ["source_key", "source_item_id", "source_url", "catalog_metadata"]) {
    if (!columnNames.has(column)) throw new Error(`Migration 038 is not applied: prompt_templates.${column} is missing`);
  }
  const [skillsTable] = await sql`
    SELECT 1 AS present
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'agent_skills'
  `;
  if (!skillsTable) throw new Error("Migration 038 is not applied: agent_skills is missing");
  const [modelRoute] = await sql`
    SELECT mc.model_key, mc.is_active AS catalog_active,
           mr.provider_key, mr.is_active AS route_active
    FROM model_catalog mc
    JOIN model_routes mr ON mr.model_key = mc.model_key
    WHERE mc.model_key = 'gpt-image-2'
      AND mc.output_type = 'image'
      AND mc.is_active = TRUE
      AND mr.provider_key = 'image_provider'
      AND mr.is_active = TRUE
    LIMIT 1
  `;
  if (!modelRoute) throw new Error("Active gpt-image-2 -> image_provider model route is required");
  const [chargeRule] = await sql`
    SELECT id
    FROM generation_charge_rules
    WHERE output_type = 'image'
      AND provider = 'image_provider'
      AND is_active = TRUE
      AND generation_mode IN ('template', 'all')
      AND (model IS NULL OR model = 'gpt-image-2')
    ORDER BY priority DESC, id ASC
    LIMIT 1
  `;
  if (!chargeRule) throw new Error("An active image_provider charge rule is required");
};

const uploadCatalogImages = async ({ templates, sql }) => {
  const existingRows = await sql`
    SELECT source_item_id, preview_object_key, preview_image_url, catalog_metadata
    FROM prompt_templates
    WHERE source_key = ${SOURCE_KEY}
  `;
  const existing = new Map(existingRows.map((row) => [String(row.source_item_id), row]));
  const byFileName = new Map();
  for (const template of templates) {
    const row = existing.get(template.sourceItemId);
    if (row?.preview_object_key && row?.preview_image_url && row?.catalog_metadata?.sourceCommit === SOURCE_COMMIT) {
      byFileName.set(template.fileName, {
        objectKey: row.preview_object_key,
        url: row.preview_image_url,
      });
    }
  }

  const pending = [...new Set(templates.map((template) => template.fileName))]
    .filter((fileName) => !byFileName.has(fileName));
  if (pending.length === 0) return byFileName;

  const deterministicLocation = (fileName) => {
    const extension = path.extname(fileName).toLowerCase().replace(/^\./, "") || "jpg";
    const objectKey = `quickai/template-catalog/${SOURCE_KEY}/${SOURCE_COMMIT}/${path.basename(fileName, path.extname(fileName))}.${extension}`;
    return { objectKey, url: `/oss-proxy/${objectKey}` };
  };
  if (reuseExistingPreviews) {
    for (const fileName of pending) byFileName.set(fileName, deterministicLocation(fileName));
    console.log(`Reusing ${pending.length} deterministic catalog preview paths`);
    return byFileName;
  }

  const { getObjectStorage } = await import("../services/objectStorageComposition.js");
  const objectStorage = getObjectStorage();
  const concurrency = 4;
  let uploaded = 0;
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    const batch = pending.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (fileName) => {
      const { objectKey } = deterministicLocation(fileName);
      const buffer = await readFile(path.join(imageRoot, fileName));
      const stored = await objectStorage.uploadBuffer(buffer, objectKey, contentTypeFor(fileName));
      return [fileName, stored];
    }));
    for (const [fileName, stored] of results) byFileName.set(fileName, stored);
    uploaded += results.length;
    if (uploaded % 40 === 0 || uploaded === pending.length) {
      console.log(`Uploaded ${uploaded}/${pending.length} catalog preview assets`);
    }
  }
  return byFileName;
};

const upsertTemplate = async (tx, template, preview) => {
  await tx`
    INSERT INTO prompt_templates
      (scene_key, scene_name, output_type, target_provider, default_model,
       default_size, system_prompt, display_order, is_active, is_featured,
       featured_order, preview_title, preview_description, preview_image_url,
       preview_object_key, starter_prompt, placeholder_text, requires_reference,
       tags, owner_user_id, visibility, approval_status, required_membership_tier,
       source_key, source_item_id, source_url, catalog_metadata)
    VALUES
      (${template.sceneKey}, ${template.title}, 'image', 'image_provider', 'gpt-image-2',
       '1024x1024', ${template.systemPrompt}, ${template.displayOrder}, TRUE,
       ${template.isFeatured}, ${template.displayOrder}, ${template.title},
       ${template.description}, ${preview.url}, ${preview.objectKey},
       ${template.starterPrompt}, ${template.placeholderText}, FALSE,
       ${tx.json(template.tags)}, NULL, 'public', 'approved', 'free',
       ${SOURCE_KEY}, ${template.sourceItemId}, ${SOURCE_REPOSITORY}, ${tx.json(template.metadata)})
    ON CONFLICT (source_key, source_item_id) DO UPDATE
    SET scene_key = EXCLUDED.scene_key,
        scene_name = EXCLUDED.scene_name,
        output_type = EXCLUDED.output_type,
        target_provider = EXCLUDED.target_provider,
        default_model = EXCLUDED.default_model,
        default_size = EXCLUDED.default_size,
        system_prompt = EXCLUDED.system_prompt,
        display_order = EXCLUDED.display_order,
        preview_title = EXCLUDED.preview_title,
        preview_description = EXCLUDED.preview_description,
        preview_image_url = EXCLUDED.preview_image_url,
        preview_object_key = EXCLUDED.preview_object_key,
        starter_prompt = EXCLUDED.starter_prompt,
        placeholder_text = EXCLUDED.placeholder_text,
        requires_reference = FALSE,
        tags = EXCLUDED.tags,
        source_url = EXCLUDED.source_url,
        catalog_metadata = EXCLUDED.catalog_metadata,
        version = prompt_templates.version + 1,
        updated_at = NOW()
    WHERE ROW(
      prompt_templates.scene_key, prompt_templates.scene_name,
      prompt_templates.output_type, prompt_templates.target_provider,
      prompt_templates.default_model, prompt_templates.default_size,
      prompt_templates.system_prompt, prompt_templates.display_order,
      prompt_templates.preview_title, prompt_templates.preview_description,
      prompt_templates.preview_image_url, prompt_templates.preview_object_key,
      prompt_templates.starter_prompt, prompt_templates.placeholder_text,
      prompt_templates.requires_reference, prompt_templates.tags,
      prompt_templates.source_url, prompt_templates.catalog_metadata
    ) IS DISTINCT FROM ROW(
      EXCLUDED.scene_key, EXCLUDED.scene_name, EXCLUDED.output_type,
      EXCLUDED.target_provider, EXCLUDED.default_model, EXCLUDED.default_size,
      EXCLUDED.system_prompt, EXCLUDED.display_order, EXCLUDED.preview_title,
      EXCLUDED.preview_description, EXCLUDED.preview_image_url,
      EXCLUDED.preview_object_key, EXCLUDED.starter_prompt,
      EXCLUDED.placeholder_text, EXCLUDED.requires_reference, EXCLUDED.tags,
      EXCLUDED.source_url, EXCLUDED.catalog_metadata
    )
  `;
};

const run = async () => {
  const catalog = await readCatalog();
  if (catalog.templates.length !== EXPECTED_TEMPLATES) {
    throw new Error(`Expected ${EXPECTED_TEMPLATES} total templates, received ${catalog.templates.length}`);
  }
  if (validateOnly) {
    console.log(JSON.stringify({
      success: true,
      validationOnly: true,
      repositoryRoot,
      sourceKey: SOURCE_KEY,
      sourceCommit: SOURCE_COMMIT,
      cases: EXPECTED_CASES,
      styleTemplates: EXPECTED_STYLE_TEMPLATES,
      templates: catalog.templates.length,
      previewAssets: catalog.imageNames.length,
      skillBytes: Buffer.byteLength(catalog.skillContent, "utf8"),
    }, null, 2));
    return;
  }

  const rootAdminUserId = requiredText(process.env.ROOT_ADMIN_USER_ID, "ROOT_ADMIN_USER_ID", 255);
  const { default: sql } = await import("../configs/db.js");
  try {
    await assertDatabaseReady(sql);
    const conflictingSceneKeys = await sql`
      SELECT scene_key, source_key
      FROM prompt_templates
      WHERE scene_key IN ${sql(catalog.templates.map((template) => template.sceneKey))}
        AND source_key IS DISTINCT FROM ${SOURCE_KEY}
      LIMIT 20
    `;
    if (conflictingSceneKeys.length > 0) {
      throw new Error(`Scene key conflict with another source: ${JSON.stringify(conflictingSceneKeys)}`);
    }

    const previewAssets = await uploadCatalogImages({ templates: catalog.templates, sql });
    const skillHash = createHash("sha256").update(catalog.skillContent).digest("hex");

    const summary = await sql.begin(async (tx) => {
      for (const template of catalog.templates) {
        const preview = previewAssets.get(template.fileName);
        if (!preview?.url || !preview?.objectKey) throw new Error(`Preview upload missing for ${template.fileName}`);
        await upsertTemplate(tx, template, preview);
      }

      await tx`
        INSERT INTO agent_skills
          (name, title, description, content, version, status, content_sha256,
           source_key, created_by_user_id, updated_by_user_id)
        VALUES
          ('gpt-image-2-style-library', 'GPT-Image2 Style Library',
           'Repository-backed style and industrial prompt guidance for gpt-image-2.',
           ${catalog.skillContent}, 1, 'active', ${skillHash}, ${SOURCE_KEY},
           ${rootAdminUserId}, ${rootAdminUserId})
        ON CONFLICT (name) DO UPDATE
        SET title = EXCLUDED.title,
            description = EXCLUDED.description,
            content = EXCLUDED.content,
            content_sha256 = EXCLUDED.content_sha256,
            source_key = EXCLUDED.source_key,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            version = agent_skills.version + 1,
            updated_at = NOW()
        WHERE agent_skills.content_sha256 IS DISTINCT FROM EXCLUDED.content_sha256
           OR agent_skills.title IS DISTINCT FROM EXCLUDED.title
           OR agent_skills.description IS DISTINCT FROM EXCLUDED.description
      `;

      const [templateSummary] = await tx`
        SELECT COUNT(*)::integer AS imported,
               COUNT(*) FILTER (WHERE is_active)::integer AS active,
               COUNT(*) FILTER (WHERE preview_object_key IS NOT NULL)::integer AS persisted_previews
        FROM prompt_templates
        WHERE source_key = ${SOURCE_KEY}
      `;
      const [skillSummary] = await tx`
        SELECT name, status, version, content_sha256
        FROM agent_skills
        WHERE name = 'gpt-image-2-style-library' AND source_key = ${SOURCE_KEY}
      `;
      if (Number(templateSummary?.imported) !== EXPECTED_TEMPLATES) {
        throw new Error(`Template import verification failed: ${JSON.stringify(templateSummary || {})}`);
      }
      if (Number(templateSummary?.persisted_previews) !== EXPECTED_TEMPLATES || !skillSummary) {
        throw new Error("Template preview or Skill verification failed");
      }
      return { templateSummary, skillSummary };
    });

    console.log(JSON.stringify({
      success: true,
      sourceKey: SOURCE_KEY,
      sourceCommit: SOURCE_COMMIT,
      imported: Number(summary.templateSummary.imported),
      active: Number(summary.templateSummary.active),
      persistedPreviews: Number(summary.templateSummary.persisted_previews),
      skill: summary.skillSummary,
    }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
};

await run();
