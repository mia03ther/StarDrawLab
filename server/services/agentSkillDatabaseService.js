import { createHash } from "node:crypto";
import sql from "../configs/db.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 500;

const fail = (message, code = "AGENT_SKILL_INVALID", status = 400) => Object.assign(new Error(message), { code, status });

const text = (value, field, maxLength, { required = false } = {}) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) throw fail(`${field} is required`);
  if (normalized.length > maxLength) throw fail(`${field} is too long`);
  return normalized;
};

const normalizeName = (value) => {
  const name = text(value, "name", 64, { required: true });
  if (!NAME_PATTERN.test(name)) throw fail("Skill name is invalid");
  return name;
};

const normalizeContent = (value) => {
  const content = String(value ?? "").trim();
  if (!content) throw fail("content is required");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw fail("Skill content is too large", "AGENT_SKILL_TOO_LARGE", 413);
  }
  return content;
};

export const normalizeDatabaseSkillInput = (input = {}) => {
  const name = normalizeName(input.name);
  const content = normalizeContent(input.content);
  const title = text(input.title || name, "title", MAX_TITLE_LENGTH, { required: true });
  const description = text(input.description, "description", MAX_DESCRIPTION_LENGTH);
  return {
    name,
    title,
    description,
    content,
    sourceKey: text(input.sourceKey || input.source_key, "sourceKey", 120),
    contentSha256: createHash("sha256").update(content).digest("hex"),
  };
};

export const normalizeDatabaseSkillRow = (row = {}) => ({
  id: String(row.id),
  name: row.name,
  title: row.title,
  description: row.description || "",
  content: row.content,
  version: Number(row.version || 1),
  status: row.status,
  content_sha256: row.content_sha256,
  source_key: row.source_key || null,
  created_by_user_id: row.created_by_user_id,
  updated_by_user_id: row.updated_by_user_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const listDatabaseSkills = async ({ includeInactive = false, db = sql } = {}) => {
  const rows = await db`
    SELECT id, name, title, description, content, version, status,
           content_sha256, source_key, created_by_user_id, updated_by_user_id,
           created_at, updated_at
    FROM agent_skills
    WHERE ${includeInactive} OR status = 'active'
    ORDER BY name ASC
  `;
  return rows.map(normalizeDatabaseSkillRow);
};

export const getDatabaseSkill = async (name, { includeInactive = false, db = sql } = {}) => {
  const normalizedName = normalizeName(name);
  const [row] = await db`
    SELECT id, name, title, description, content, version, status,
           content_sha256, source_key, created_by_user_id, updated_by_user_id,
           created_at, updated_at
    FROM agent_skills
    WHERE name = ${normalizedName}
      AND (${includeInactive} OR status = 'active')
    LIMIT 1
  `;
  return row ? normalizeDatabaseSkillRow(row) : null;
};

export const upsertDatabaseSkill = async ({ input, actorUserId, existingName = null, db = sql } = {}) => {
  const normalized = normalizeDatabaseSkillInput(input);
  const targetName = existingName ? normalizeName(existingName) : normalized.name;
  const mutate = async (tx) => {
    if (existingName) {
      const [updated] = await tx`
        UPDATE agent_skills
        SET name = ${normalized.name}, title = ${normalized.title},
            description = ${normalized.description}, content = ${normalized.content},
            content_sha256 = ${normalized.contentSha256}, source_key = ${normalized.sourceKey || null},
            version = version + 1, status = 'active', updated_by_user_id = ${actorUserId},
            updated_at = NOW()
        WHERE name = ${targetName}
        RETURNING id, name, title, description, content, version, status,
                  content_sha256, source_key, created_by_user_id, updated_by_user_id,
                  created_at, updated_at
      `;
      if (!updated) throw fail("Skill not found", "AGENT_SKILL_NOT_FOUND", 404);
      return [updated];
    }

    const [created] = await tx`
      INSERT INTO agent_skills
        (name, title, description, content, version, status, content_sha256,
         source_key, created_by_user_id, updated_by_user_id)
      VALUES
        (${normalized.name}, ${normalized.title}, ${normalized.description}, ${normalized.content},
         1, 'active', ${normalized.contentSha256}, ${normalized.sourceKey || null},
         ${actorUserId}, ${actorUserId})
      RETURNING id, name, title, description, content, version, status,
                content_sha256, source_key, created_by_user_id, updated_by_user_id,
                created_at, updated_at
    `;
    return [created];
  };
  const [row] = db?.begin ? await db.begin(mutate) : await mutate(db);
  return normalizeDatabaseSkillRow(row);
};

export const deactivateDatabaseSkill = async ({ name, actorUserId, db = sql } = {}) => {
  const normalizedName = normalizeName(name);
  const mutate = async (tx) => tx`
    UPDATE agent_skills
    SET status = 'inactive', updated_by_user_id = ${actorUserId}, updated_at = NOW()
    WHERE name = ${normalizedName}
    RETURNING id, name, title, description, content, version, status,
              content_sha256, source_key, created_by_user_id, updated_by_user_id,
              created_at, updated_at
  `;
  const [row] = db?.begin ? await db.begin(mutate) : await mutate(db);
  if (!row) throw fail("Skill not found", "AGENT_SKILL_NOT_FOUND", 404);
  return normalizeDatabaseSkillRow(row);
};
