import sql from "../configs/db.js";

export const DEFAULT_GLOBAL_AGENT_PREFERENCES = Object.freeze({
  agentModel: "",
  imageModel: "",
  videoModel: "",
  imageSize: "",
  videoSize: "",
  videoSeconds: "",
  reasoningEffort: "",
});

export const GLOBAL_AGENT_ACCESS_MODES = new Set([
  "ask_for_approval",
  "approve_for_me",
  "full_access",
]);

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export const normalizeGlobalAgentPreferences = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const videoSeconds = source.videoSeconds ?? source.video_seconds;
  return {
    agentModel: clean(source.agentModel ?? source.agent_model, 100),
    imageModel: clean(source.imageModel ?? source.image_model, 100),
    videoModel: clean(source.videoModel ?? source.video_model, 100),
    imageSize: clean(source.imageSize ?? source.image_size, 40),
    videoSize: clean(source.videoSize ?? source.video_size, 40),
    videoSeconds: videoSeconds == null || videoSeconds === "" ? "" : clean(videoSeconds, 6),
    reasoningEffort: clean(source.reasoningEffort ?? source.reasoning_effort, 20).toLowerCase(),
  };
};

const normalizeMode = (value) => {
  const mode = clean(value, 40);
  return GLOBAL_AGENT_ACCESS_MODES.has(mode) ? mode : "approve_for_me";
};

const publicPreferences = (row) => ({
  mode: normalizeMode(row?.access_mode),
  agentPreferences: normalizeGlobalAgentPreferences(row?.preferences),
  updatedAt: row?.updated_at || null,
});

export const getGlobalAgentPreferences = async ({ userId, db = sql } = {}) => {
  const ownerId = clean(userId, 255);
  if (!ownerId) throw Object.assign(new Error("Authenticated user is required"), { status: 401, code: "USER_REQUIRED" });
  const [row] = await db`
    SELECT access_mode, preferences, updated_at
    FROM global_agent_preferences
    WHERE user_id = ${ownerId}
    LIMIT 1
  `;
  return publicPreferences(row);
};

export const saveGlobalAgentPreferences = async ({ userId, mode, preferences, db = sql } = {}) => {
  const ownerId = clean(userId, 255);
  if (!ownerId) throw Object.assign(new Error("Authenticated user is required"), { status: 401, code: "USER_REQUIRED" });
  const normalizedMode = normalizeMode(mode);
  const normalizedPreferences = normalizeGlobalAgentPreferences(preferences);
  const [row] = await db`
    INSERT INTO global_agent_preferences (user_id, access_mode, preferences)
    VALUES (${ownerId}, ${normalizedMode}, ${db.json(normalizedPreferences)})
    ON CONFLICT (user_id) DO UPDATE SET
      access_mode = EXCLUDED.access_mode,
      preferences = EXCLUDED.preferences,
      updated_at = NOW()
    RETURNING access_mode, preferences, updated_at
  `;
  return publicPreferences(row);
};
