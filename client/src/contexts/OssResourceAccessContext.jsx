/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useAuthing } from "./AuthingContext";
import { clearOssGrantCache, invalidateOssGrant, resolveOssGrant } from "../utils/ossResourceUrl";

const API_BASE_URL = String(import.meta.env.VITE_BASE_URL || "").replace(/\/$/, "");
const OssResourceAccessContext = createContext(null);

const readJsonSafely = async (response) => {
  try { return await response.json(); } catch { return null; }
};

export const OssResourceAccessProvider = ({ children }) => {
  const { getToken, isSignedIn, user } = useAuthing();
  const ownerKey = user?.id || user?.user_id || "signed-out";
  const previousOwnerRef = useRef(ownerKey);

  useEffect(() => {
    if (previousOwnerRef.current !== ownerKey) {
      clearOssGrantCache(previousOwnerRef.current);
      previousOwnerRef.current = ownerKey;
    }
  }, [ownerKey]);

  const requestGrant = useCallback(async (body) => {
    if (!isSignedIn) throw Object.assign(new Error("Authentication is required to access this resource"), { status: 401 });
    const token = await getToken();
    if (!token) throw Object.assign(new Error("Authentication token is unavailable"), { status: 401 });
    const response = await fetch(`${API_BASE_URL}/api/proxy/oss/grant`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await readJsonSafely(response);
    if (!response.ok) {
      throw Object.assign(new Error(payload?.message || `Failed to authorize resource (${response.status})`), {
        status: response.status,
        code: payload?.code,
      });
    }
    return payload;
  }, [getToken, isSignedIn]);

  const grantPrivateAsset = useCallback((source, options = {}) => resolveOssGrant({
    source,
    ownerKey,
    requestGrant,
    force: Boolean(options.force),
  }), [ownerKey, requestGrant]);
  const resolvePrivateUrl = useCallback(async (source, options = {}) => (await grantPrivateAsset(source, options)).url, [grantPrivateAsset]);
  const invalidatePrivateUrl = useCallback((source) => invalidateOssGrant(source, ownerKey), [ownerKey]);
  const value = useMemo(() => ({ grantPrivateAsset, invalidatePrivateUrl, resolvePrivateUrl }), [grantPrivateAsset, invalidatePrivateUrl, resolvePrivateUrl]);

  return <OssResourceAccessContext.Provider value={value}>{children}</OssResourceAccessContext.Provider>;
};

export const useOssResourceAccess = () => {
  const context = useContext(OssResourceAccessContext);
  if (!context) throw new Error("useOssResourceAccess must be used within OssResourceAccessProvider");
  return context;
};

export default OssResourceAccessContext;
