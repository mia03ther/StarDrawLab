const CHUNK_RELOAD_KEY = "stardraw_chunk_reload_at";
const RETRY_WINDOW_MS = 30_000;

export const createChunkLoadRecovery = ({
  storage,
  now = Date.now,
  reload,
} = {}) => (event) => {
  event?.preventDefault?.();
  const timestamp = Number(storage?.getItem(CHUNK_RELOAD_KEY) || 0);
  const currentTime = Number(now());
  if (timestamp > 0 && currentTime - timestamp < RETRY_WINDOW_MS) return false;

  storage?.setItem(CHUNK_RELOAD_KEY, String(currentTime));
  reload?.();
  return true;
};

export const installChunkLoadRecovery = (browserWindow = window) => {
  const recover = createChunkLoadRecovery({
    storage: browserWindow.sessionStorage,
    reload: () => browserWindow.location.reload(),
  });
  browserWindow.addEventListener("vite:preloadError", recover);

  const clearMarker = browserWindow.setTimeout(() => {
    browserWindow.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  }, RETRY_WINDOW_MS);

  return () => {
    browserWindow.clearTimeout(clearMarker);
    browserWindow.removeEventListener("vite:preloadError", recover);
  };
};
