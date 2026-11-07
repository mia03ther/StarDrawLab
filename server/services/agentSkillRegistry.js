import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const SKILL_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILLS = 64;
const MAX_CONTEXT_BYTES = 24 * 1024;

const skillRoot = () => String(process.env.AGENT_SKILL_ROOT || "/app/skills").trim();

const fail = (message, code = "AGENT_SKILL_INVALID", status = 400) => Object.assign(new Error(message), { code, status });

const safeName = (value) => {
  const name = String(value || "").trim();
  if (!SKILL_DIRECTORY_PATTERN.test(name)) throw fail("Skill name is invalid");
  return name;
};

const parseFrontMatter = (text) => {
  const match = String(text || "").match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { body: String(text || "").trim(), metadata: {} };
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(key)) metadata[key] = value.slice(0, 240);
  }
  return { body: String(text || "").slice(match[0].length).trim(), metadata };
};

const loadOne = async (root, name) => {
  const safeSkillName = safeName(name);
  const skillPath = path.join(root, safeSkillName, "SKILL.md");
  const resolvedRoot = await realpath(root);
  const resolvedSkill = await realpath(skillPath);
  if (!resolvedSkill.startsWith(`${resolvedRoot}${path.sep}`)) throw fail("Skill path escapes the configured root", "AGENT_SKILL_PATH_INVALID", 403);
  const content = await readFile(resolvedSkill, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw fail("Skill file is too large", "AGENT_SKILL_TOO_LARGE", 413);
  const parsed = parseFrontMatter(content);
  return {
    name: safeSkillName,
    title: String(parsed.metadata.title || safeSkillName).slice(0, 160),
    description: String(parsed.metadata.description || "").slice(0, 500),
    content: parsed.body.slice(0, MAX_SKILL_BYTES),
  };
};

export class AgentSkillRegistry {
  #root;
  #database;

  constructor({ root = skillRoot(), database = null } = {}) {
    this.#root = path.resolve(String(root || "/app/skills"));
    this.#database = database;
  }

  async #databaseService() {
    if (this.#database) return this.#database;
    this.#database = await import("./agentSkillDatabaseService.js");
    return this.#database;
  }

  async #listDatabase() {
    try {
      const service = await this.#databaseService();
      return await service.listDatabaseSkills();
    } catch (error) {
      // The registry remains usable while migration 038 is being rolled out.
      // A missing table or temporarily unavailable DB must not disable the
      // root-managed read-only file Skills.
      return [];
    }
  }

  async list() {
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") entries = [];
      else throw error;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && SKILL_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_SKILLS);
    const skills = [];
    for (const name of names) {
      try {
        const skill = await loadOne(this.#root, name);
        skills.push({ name: skill.name, title: skill.title, description: skill.description });
      } catch {
        // A malformed root skill is ignored from the Agent catalog; it is not
        // allowed to turn a normal canvas request into arbitrary file access.
      }
    }
    const databaseSkills = await this.#listDatabase();
    const fileNames = new Set(skills.map((skill) => skill.name));
    return [
      ...skills,
      ...databaseSkills
        .filter((skill) => !fileNames.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          title: skill.title,
          description: skill.description,
          source: "database",
          version: skill.version,
        })),
    ].slice(0, MAX_SKILLS);
  }

  async get(name) {
    try {
      return await loadOne(this.#root, name);
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") throw error;
      let skill = null;
      try {
        skill = await this.#databaseService().then((service) => service.getDatabaseSkill(name));
      } catch {
        skill = null;
      }
      if (!skill) throw error;
      return {
        name: skill.name,
        title: skill.title,
        description: skill.description,
        content: skill.content,
        source: "database",
        version: skill.version,
      };
    }
  }

  async contextForInstruction(instruction) {
    const catalog = await this.list();
    if (catalog.length === 0) return "";
    const input = String(instruction || "").toLowerCase();
    const selected = catalog.filter((skill) => `${skill.name} ${skill.title} ${skill.description}`.toLowerCase()
      .split(/\s+/).some((word) => word.length > 2 && input.includes(word)));
    const names = (selected.length > 0 ? selected : catalog.slice(0, 4)).map((skill) => skill.name);
    const blocks = [];
    for (const name of names) {
      try {
        const skill = await this.get(name);
        blocks.push(`## Skill: ${skill.title}\n${skill.content}`);
      } catch {
        // Keep the Agent request usable when a root file is edited mid-request.
      }
    }
    return blocks.join("\n\n").slice(0, MAX_CONTEXT_BYTES);
  }
}

let registry;

export const getAgentSkillRegistry = () => {
  if (!registry) registry = new AgentSkillRegistry();
  return registry;
};

export const resetAgentSkillRegistryForTests = () => {
  registry = null;
};
