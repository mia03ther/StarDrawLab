import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const CATALOGS = {
  agent: [
    { model_key: "gpt-5.6-sol", display_name: "GPT" },
    { model_key: "gpt-5.6-luna", display_name: "GPT Fast" },
  ],
  image: [
    { model_key: "nana-banana-2", display_name: "Nano Banana 2" },
    { model_key: "gpt-image2-2k", display_name: "GPT Image 2K" },
  ],
  video: [
    { model_key: "veo-3-1", display_name: "Veo 3.1" },
  ],
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/modules/canvas-agent/modelPreferencesService.js")) {
      if (specifier === "../../configs/db.js") return { shortCircuit: true, url: "canvas-model-test:db" };
      if (specifier === "../../services/modelConfigurationService.js") return { shortCircuit: true, url: "canvas-model-test:catalog" };
      if (specifier === "../../services/creativeLlmConfiguration.js") return { shortCircuit: true, url: "canvas-model-test:creative" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "canvas-model-test:db") {
      return { format: "module", shortCircuit: true, source: "export default function forbidden() { throw new Error('database access forbidden'); }" };
    }
    if (url === "canvas-model-test:catalog") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const listAvailableModels = async ({ outputType }) => globalThis.__canvasModelPreferenceCatalogs[outputType] || [];",
      };
    }
    if (url === "canvas-model-test:creative") {
      return { format: "module", shortCircuit: true, source: "export const getCreativeLlmModelKey = () => 'gpt-5.6-sol';" };
    }
    return nextLoad(url, context);
  },
});

globalThis.__canvasModelPreferenceCatalogs = CATALOGS;

const {
  getCanvasModelPreferences,
  saveCanvasModelPreferences,
} = await import("../modules/canvas-agent/modelPreferencesService.js");

const createPreferenceDb = () => {
  const rows = new Map();
  const writes = [];
  const db = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT text_model_key")) {
      const row = rows.get(String(values[0]));
      return row ? [row] : [];
    }
    if (query.startsWith("INSERT INTO canvas_model_preferences")) {
      const [userId, textModel, imageModel, videoModel] = values;
      const row = {
        text_model_key: textModel,
        image_model_key: imageModel,
        video_model_key: videoModel,
        updated_at: "2026-08-17T00:00:00.000Z",
      };
      rows.set(String(userId), row);
      writes.push({ userId, textModel, imageModel, videoModel });
      return [row];
    }
    throw new Error(`Unexpected test query: ${query}`);
  };
  return { db, rows, writes };
};

test("Canvas Agent model defaults come from the current account catalog", async () => {
  const { db } = createPreferenceDb();
  const result = await getCanvasModelPreferences({ userId: "user-1", db });

  assert.deepEqual(result.preferences, {
    textModel: "gpt-5.6-sol",
    imageModel: "nana-banana-2",
    videoModel: "veo-3-1",
  });
  assert.equal(result.catalogs.text.length, 2);
});

test("Canvas Agent model choices persist per account and partial updates retain other choices", async () => {
  const { db, writes } = createPreferenceDb();
  await saveCanvasModelPreferences({
    userId: "user-1",
    patch: { textModel: "gpt-5.6-luna", imageModel: "gpt-image2-2k" },
    db,
  });
  const updated = await saveCanvasModelPreferences({
    userId: "user-1",
    patch: { videoModel: "veo-3-1" },
    db,
  });

  assert.deepEqual(updated.preferences, {
    textModel: "gpt-5.6-luna",
    imageModel: "gpt-image2-2k",
    videoModel: "veo-3-1",
  });
  assert.deepEqual(writes.at(-1), {
    userId: "user-1",
    textModel: "gpt-5.6-luna",
    imageModel: "gpt-image2-2k",
    videoModel: "veo-3-1",
  });
});

test("Canvas Agent rejects a model that is unavailable to the current account", async () => {
  const { db, writes } = createPreferenceDb();
  await assert.rejects(
    saveCanvasModelPreferences({ userId: "user-1", patch: { imageModel: "hidden-model" }, db }),
    (error) => error.code === "CANVAS_MODEL_UNAVAILABLE" && error.status === 403,
  );
  assert.equal(writes.length, 0);
});
