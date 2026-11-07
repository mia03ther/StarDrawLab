const STORAGE_PREFIX = "stardraw_generation_request:";
const MAX_REQUEST_AGE_MS = 30 * 60 * 1000;

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value ?? null;
};

const storageKey = (scope) => `${STORAGE_PREFIX}${String(scope || "media").replace(/[^a-z0-9_-]/gi, "_")}`;

const newRequestKey = (randomUUID) => {
  const createUuid = randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return createUuid ? createUuid() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const generationRequestFingerprint = (value) => JSON.stringify(stableValue(value));

export const getGenerationRequestKey = ({
  storage = globalThis.sessionStorage,
  scope,
  fingerprint,
  now = Date.now,
  randomUUID,
}) => {
  const key = storageKey(scope);
  const currentTime = Number(now());
  try {
    const existing = JSON.parse(storage?.getItem(key) || "null");
    if (existing?.requestKey
      && existing.fingerprint === fingerprint
      && currentTime - Number(existing.createdAt || 0) >= 0
      && currentTime - Number(existing.createdAt || 0) < MAX_REQUEST_AGE_MS) {
      return existing.requestKey;
    }
  } catch {
    // Replace malformed or inaccessible browser state with a fresh key.
  }

  const requestKey = newRequestKey(randomUUID);
  try {
    storage?.setItem(key, JSON.stringify({ requestKey, fingerprint, createdAt: currentTime }));
  } catch {
    // Idempotency still works for the current request when storage is blocked.
  }
  return requestKey;
};

export const clearGenerationRequestKey = ({
  storage = globalThis.sessionStorage,
  scope,
  requestKey,
}) => {
  const key = storageKey(scope);
  try {
    const existing = JSON.parse(storage?.getItem(key) || "null");
    if (!requestKey || existing?.requestKey === requestKey) storage?.removeItem(key);
  } catch {
    storage?.removeItem?.(key);
  }
};

export const shouldKeepGenerationRequestKey = (error) => {
  const code = String(error?.response?.data?.code || "");
  return !error?.response || ["EXECUTION_IN_PROGRESS", "EXECUTION_CONCURRENCY_LIMITED"].includes(code);
};
