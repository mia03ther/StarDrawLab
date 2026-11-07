import sql from "../../configs/db.js";
import { getCreativeLlmModelKey } from "../../services/creativeLlmConfiguration.js";
import { listAvailableModels } from "../../services/modelConfigurationService.js";

const MODEL_TYPES = Object.freeze(["agent", "image", "video"]);
const FIELD_BY_TYPE = Object.freeze({
  agent: "text_model_key",
  image: "image_model_key",
  video: "video_model_key",
});

const fail = (message, code = "INVALID_CANVAS_MODEL_PREFERENCES", status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};

const cleanModelKey = (value) => String(value || "").trim().toLowerCase().slice(0, 100);

const mapPreferences = (row = {}) => ({
  textModel: cleanModelKey(row.text_model_key),
  imageModel: cleanModelKey(row.image_model_key),
  videoModel: cleanModelKey(row.video_model_key),
});

const firstModel = (catalog, preferred = "") => {
  const requested = cleanModelKey(preferred);
  return catalog.some((model) => model.model_key === requested)
    ? requested
    : cleanModelKey(catalog[0]?.model_key);
};

export const listCanvasModelCatalogs = async ({ userId, db = sql } = {}) => {
  const catalogs = Object.fromEntries(await Promise.all(MODEL_TYPES.map(async (type) => [
    type === "agent" ? "text" : type,
    await listAvailableModels({ userId, outputType: type, db }),
  ])));
  return catalogs;
};

export const getCanvasModelPreferences = async ({ userId, db = sql } = {}) => {
  const [catalogs, rows] = await Promise.all([
    listCanvasModelCatalogs({ userId, db }),
    db`
      SELECT text_model_key, image_model_key, video_model_key, updated_at
      FROM canvas_model_preferences
      WHERE user_id = ${userId}
      LIMIT 1
    `,
  ]);
  const stored = mapPreferences(rows[0]);
  const preferences = {
    textModel: firstModel(catalogs.text, stored.textModel || getCreativeLlmModelKey()),
    imageModel: firstModel(catalogs.image, stored.imageModel),
    videoModel: firstModel(catalogs.video, stored.videoModel),
  };
  return { preferences, catalogs, updatedAt: rows[0]?.updated_at || null };
};

const validateSelection = (catalog, value, label) => {
  const key = cleanModelKey(value);
  if (!key) fail(`${label} is required`, "CANVAS_MODEL_REQUIRED");
  if (!catalog.some((model) => model.model_key === key)) {
    fail(`${label} is not available for this account`, "CANVAS_MODEL_UNAVAILABLE", 403);
  }
  return key;
};

export const saveCanvasModelPreferences = async ({ userId, patch = {}, db = sql } = {}) => {
  const current = await getCanvasModelPreferences({ userId, db });
  const requested = {
    textModel: patch.textModel ?? patch.text_model ?? current.preferences.textModel,
    imageModel: patch.imageModel ?? patch.image_model ?? current.preferences.imageModel,
    videoModel: patch.videoModel ?? patch.video_model ?? current.preferences.videoModel,
  };
  const next = {
    textModel: validateSelection(current.catalogs.text, requested.textModel, "textModel"),
    imageModel: validateSelection(current.catalogs.image, requested.imageModel, "imageModel"),
    videoModel: validateSelection(current.catalogs.video, requested.videoModel, "videoModel"),
  };
  const [saved] = await db`
    INSERT INTO canvas_model_preferences
      (user_id, text_model_key, image_model_key, video_model_key)
    VALUES
      (${userId}, ${next.textModel}, ${next.imageModel}, ${next.videoModel})
    ON CONFLICT (user_id) DO UPDATE
    SET text_model_key = EXCLUDED.text_model_key,
        image_model_key = EXCLUDED.image_model_key,
        video_model_key = EXCLUDED.video_model_key,
        updated_at = NOW()
    RETURNING text_model_key, image_model_key, video_model_key, updated_at
  `;
  return {
    preferences: mapPreferences(saved),
    catalogs: current.catalogs,
    updatedAt: saved.updated_at,
  };
};

export const validateCanvasConversationModels = async ({ userId, preferences = {}, db = sql } = {}) => {
  const current = await getCanvasModelPreferences({ userId, db });
  return {
    textModel: validateSelection(current.catalogs.text, preferences.textModel ?? preferences.text_model ?? current.preferences.textModel, "textModel"),
    imageModel: validateSelection(current.catalogs.image, preferences.imageModel ?? preferences.image_model ?? current.preferences.imageModel, "imageModel"),
    videoModel: validateSelection(current.catalogs.video, preferences.videoModel ?? preferences.video_model ?? current.preferences.videoModel, "videoModel"),
  };
};

export { FIELD_BY_TYPE };
