import { useCallback, useEffect, useRef, useState } from "react";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { isOssProxyUrl } from "../utils/ossResourceUrl";

const REFRESH_SKEW_MS = 30_000;
const TRANSIENT_RETRY_DELAY_MS = 1_200;
const passthroughState = (source) => ({ url: source || "", loading: false, error: null });
const isTransientError = (error) => !error?.status || error.status === 429 || error.status >= 500;

const usePrivateOssUrl = (source, { enabled = true } = {}) => {
  const { grantPrivateAsset, invalidatePrivateUrl } = useOssResourceAccess();
  const shouldAuthorize = enabled && isOssProxyUrl(source);
  const [state, setState] = useState(() => shouldAuthorize ? { url: "", loading: true, error: null } : passthroughState(source));
  const [refreshVersion, setRefreshVersion] = useState(0);
  const mediaRetryCountRef = useRef(0);

  useEffect(() => { mediaRetryCountRef.current = 0; }, [source, enabled]);
  useEffect(() => {
    if (!shouldAuthorize) {
      setState(passthroughState(source));
      return undefined;
    }
    let active = true;
    let refreshTimer = null;
    let retryTimer = null;
    let attempt = 0;
    const load = async () => {
      attempt += 1;
      setState((current) => ({ ...current, loading: !current.url, error: null }));
      try {
        const result = await grantPrivateAsset(source);
        if (!active) return;
        setState({ url: result.url, loading: false, error: null });
        if (Number.isFinite(result.expiresAt)) {
          const refreshAfter = Math.max(1_000, result.expiresAt - Date.now() - REFRESH_SKEW_MS);
          refreshTimer = window.setTimeout(() => {
            invalidatePrivateUrl(source);
            setRefreshVersion((value) => value + 1);
          }, refreshAfter);
        }
      } catch (error) {
        if (!active) return;
        if (attempt < 2 && isTransientError(error)) {
          retryTimer = window.setTimeout(load, TRANSIENT_RETRY_DELAY_MS);
          return;
        }
        setState({ url: "", loading: false, error });
      }
    };
    void load();
    return () => {
      active = false;
      if (refreshTimer) window.clearTimeout(refreshTimer);
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [grantPrivateAsset, invalidatePrivateUrl, refreshVersion, shouldAuthorize, source]);

  const retry = useCallback(() => {
    if (shouldAuthorize) invalidatePrivateUrl(source);
    setRefreshVersion((value) => value + 1);
  }, [invalidatePrivateUrl, shouldAuthorize, source]);
  const handleMediaError = useCallback(() => {
    if (!shouldAuthorize || mediaRetryCountRef.current >= 1) return false;
    mediaRetryCountRef.current += 1;
    retry();
    return true;
  }, [retry, shouldAuthorize]);
  return { ...state, retry, handleMediaError, isPrivateOss: shouldAuthorize };
};

export default usePrivateOssUrl;
