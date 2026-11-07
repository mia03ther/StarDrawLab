import axios from "axios";
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";

const inFlightGetRequests = new Map();
const GET_RETRY_LIMIT = 3;
const GET_TIMEOUT_MS = 15000;

const isCanceledRequest = (error) => axios.isCancel(error)
  || error?.code === "ERR_CANCELED"
  || error?.name === "CanceledError"
  || error?.name === "AbortError";

const retryDelayMs = (retryCount, response) => {
  const retryAfterHeader = response?.headers?.["retry-after"];
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(5000, Math.max(250, retryAfterSeconds * 1000));
  }
  return Math.min(4000, 500 * (2 ** Math.max(0, retryCount - 1)));
};

const serializeParams = (params) => {
  if (!params) return "";
  if (typeof URLSearchParams !== "undefined" && params instanceof URLSearchParams) {
    return params.toString();
  }
  if (typeof params !== "object") return String(params);
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key] ?? "")}`)
    .join("&");
};

const useAuthAxios = () => {
  const { getToken, getAccountToken, handleAuthorizationFailure } = useAuthing();
  const { locale } = useLanguage();

  const authAxios = useMemo(() => {
    const instance = axios.create({
      baseURL: import.meta.env.VITE_BASE_URL || "",
    });

    // A fast double click should not create duplicate reads of the same
    // page data. Mutating requests, including generation, are never deduped.
    const originalGet = instance.get.bind(instance);
    instance.get = (url, config = {}) => {
      if (config.signal || config.cancelToken) return originalGet(url, config);

      const key = `${instance.defaults.baseURL || ""}|${url}|${serializeParams(config.params)}|${locale}`;
      const existing = inFlightGetRequests.get(key);
      if (existing) return existing;

      const request = originalGet(url, { ...config, timeout: config.timeout ?? GET_TIMEOUT_MS });
      inFlightGetRequests.set(key, request);
      request.then(
        () => inFlightGetRequests.delete(key),
        () => inFlightGetRequests.delete(key),
      );
      return request;
    };

    instance.interceptors.request.use(async (config) => {
      config.headers["Accept-Language"] = locale;
      try {
        const token = await getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        const requestPath = String(config.url || "").split("?")[0];
        const isAccountRequest = /(^|\/)api\/(?:account|auth)(?:\/|$)/.test(requestPath)
          || /(^|\/)api\/user\/identity\/(?:account|password)(?:\/|$)/.test(requestPath);
        if (isAccountRequest) {
          const accountToken = await getAccountToken();
          if (accountToken) config.headers["X-Identity-Account-Token"] = accountToken;
        }
      } catch (error) {
        console.error("Error getting Authing token:", error);
      }

      // 为所有会改变状态的请求自动注入幂等键
      const mutatingMethods = ["post", "put", "patch", "delete"];
      if (mutatingMethods.includes(config.method?.toLowerCase())) {
        if (!config.headers["X-Idempotency-Key"]) {
          config.headers["X-Idempotency-Key"] = uuidv4();
        }
      }

      return config;
    });

    instance.interceptors.response.use(
      (response) => response,
      (error) => {
        const response = error?.response;
        const config = error?.config;
        const status = Number(response?.status || 0);
        const retryCount = Number(config?.__stardrawRetryCount || 0);
        const retryableGet = !isCanceledRequest(error)
          && config?.method?.toLowerCase() === "get"
          && retryCount < GET_RETRY_LIMIT
          && (!response || [408, 425, 429, 502, 503, 504].includes(status));
        if (retryableGet) {
          config.__stardrawRetryCount = retryCount + 1;
          const delay = retryDelayMs(config.__stardrawRetryCount, response);
          return new Promise((resolve) => window.setTimeout(resolve, delay))
            .then(() => instance.request(config));
        }
        if (response) {
          handleAuthorizationFailure({
            status: response.status,
            code: response.data?.code,
            message: response.data?.message,
          });
        }
        return Promise.reject(error);
      },
    );

    return instance;
  }, [getToken, getAccountToken, handleAuthorizationFailure, locale]);

  return authAxios;
};

export default useAuthAxios;
