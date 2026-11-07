import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentSkillRegistry } from "../services/agentSkillRegistry.js";

test("root file skill registry exposes bounded metadata and relevant instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardraw-skill-test-"));
  const skillDirectory = path.join(root, "storyboard-director");
  await mkdir(skillDirectory);
  await writeFile(path.join(skillDirectory, "SKILL.md"), [
    "---",
    "title: Storyboard Director",
    "description: storyboard camera shot planning",
    "---",
    "Split the request into bounded shots and never invent asset ids.",
  ].join("\n"));

  const registry = new AgentSkillRegistry({ root });
  const catalog = await registry.list();
  assert.deepEqual(catalog, [{
    name: "storyboard-director",
    title: "Storyboard Director",
    description: "storyboard camera shot planning",
  }]);
  const context = await registry.contextForInstruction("Please create a storyboard with camera moves");
  assert.match(context, /never invent asset ids/);
});

test("missing skill directory is an empty catalog", async () => {
  const registry = new AgentSkillRegistry({ root: path.join(os.tmpdir(), `missing-skill-${Date.now()}`) });
  assert.deepEqual(await registry.list(), []);
});

test("database skills remain available when the root file directory is absent", async () => {
  const database = {
    listDatabaseSkills: async () => [{
      name: "gpt-image-2-style-library",
      title: "GPT Image 2 Style Library",
      description: "production style guidance",
      version: 3,
    }],
    getDatabaseSkill: async () => ({
      name: "gpt-image-2-style-library",
      title: "GPT Image 2 Style Library",
      description: "production style guidance",
      content: "Use an explicit visual hierarchy.",
      version: 3,
    }),
  };
  const registry = new AgentSkillRegistry({
    root: path.join(os.tmpdir(), `missing-skill-${Date.now()}-database`),
    database,
  });

  assert.deepEqual(await registry.list(), [{
    name: "gpt-image-2-style-library",
    title: "GPT Image 2 Style Library",
    description: "production style guidance",
    source: "database",
    version: 3,
  }]);
  assert.match(await registry.contextForInstruction("Use the GPT image style library"), /explicit visual hierarchy/);
});
