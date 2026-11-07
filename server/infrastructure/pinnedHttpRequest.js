import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const fail = (message, code = "PINNED_HTTP_REQUEST_FAILED") => Object.assign(new Error(message), { code });
const stripIpv6Brackets = (value) => String(value || "").replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");

const asHeaderObject = (headers = {}) => {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  const normalized = {};
  for (const [name, value] of entries) {
    if (value == null || String(name).toLowerCase() === "host") continue;
    normalized[name] = value;
  }
  return normalized;
};

const hasHeader = (headers, expectedName) => Object.keys(headers)
  .some((name) => name.toLowerCase() === expectedName);

/** Create a Node lookup callback that can return only the validated DNS snapshot. */
export const createPinnedAddressLookup = ({ hostname, addresses }) => {
  const expectedHost = stripIpv6Brackets(hostname);
  const snapshot = (Array.isArray(addresses) ? addresses : []).map((entry) => ({
    address: stripIpv6Brackets(entry.address),
    family: Number(entry.family),
  })).filter((entry) => isIP(entry.address) === entry.family && (entry.family === 4 || entry.family === 6));
  if (snapshot.length === 0) throw fail("Pinned HTTP target has no validated address", "PINNED_HTTP_DNS_EMPTY");

  return (lookupHostname, options, callback) => {
    let lookupOptions = options;
    let done = callback;
    if (typeof lookupOptions === "function") {
      done = lookupOptions;
      lookupOptions = {};
    }
    if (typeof done !== "function") throw new TypeError("Pinned lookup requires a callback");
    if (stripIpv6Brackets(lookupHostname) !== expectedHost) {
      done(fail("Pinned HTTP lookup hostname changed", "PINNED_HTTP_HOST_MISMATCH"));
      return;
    }
    const requestedFamily = Number(typeof lookupOptions === "number" ? lookupOptions : lookupOptions?.family || 0);
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? snapshot.filter((entry) => entry.family === requestedFamily)
      : snapshot;
    if (candidates.length === 0) {
      done(fail("Pinned HTTP target has no address for the requested family", "PINNED_HTTP_DNS_FAMILY_UNAVAILABLE"));
      return;
    }
    if (typeof lookupOptions === "object" && lookupOptions?.all) {
      done(null, candidates.map((entry) => ({ ...entry })));
      return;
    }
    done(null, candidates[0].address, candidates[0].family);
  };
};

/** Build the exact Node request options used to preserve the original Host and TLS SNI. */
export const buildPinnedRequestOptions = ({ target, addresses, method = "GET", headers = {}, body = null, signal } = {}) => {
  const url = target?.url instanceof URL ? target.url : target instanceof URL ? target : new URL(String(target || ""));
  const pinnedAddresses = addresses || target?.addresses;
  const outgoingHeaders = asHeaderObject(headers);
  outgoingHeaders.host = url.host;
  const payload = body == null || Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (payload != null && !hasHeader(outgoingHeaders, "content-length") && !hasHeader(outgoingHeaders, "transfer-encoding")) {
    outgoingHeaders["content-length"] = String(payload.length);
  }
  const hostname = stripIpv6Brackets(url.hostname);
  return {
    url,
    payload,
    options: {
      method,
      headers: outgoingHeaders,
      lookup: createPinnedAddressLookup({ hostname, addresses: pinnedAddresses }),
      // A global pooled socket could have been created by unrelated code and
      // would bypass this request's pinned lookup entirely.
      agent: false,
      signal,
      ...(url.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
    },
  };
};

/**
 * Perform one non-redirecting HTTP(S) request against a validated DNS snapshot.
 * The promise resolves only after the bounded response body has been read, so an
 * AbortSignal covers DNS, connect, headers, and body transfer.
 */
export const requestPinnedHttp = ({
  target,
  addresses,
  method = "GET",
  headers = {},
  body = null,
  signal,
  maxResponseBytes,
  responseTooLargeError = () => fail("Pinned HTTP response is too large", "PINNED_HTTP_RESPONSE_TOO_LARGE"),
} = {}) => new Promise((resolve, reject) => {
  const maximum = Number(maxResponseBytes);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    reject(new TypeError("Pinned HTTP request requires a positive maxResponseBytes"));
    return;
  }

  let requestConfig;
  try {
    requestConfig = buildPinnedRequestOptions({ target, addresses, method, headers, body, signal });
  } catch (error) {
    reject(error);
    return;
  }
  const transport = requestConfig.url.protocol === "https:" ? https : http;
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    callback(value);
  };
  const request = transport.request(requestConfig.url, requestConfig.options, (response) => {
    const declaredLength = Number(response.headers["content-length"] || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
      finish(reject, responseTooLargeError());
      response.destroy();
      return;
    }
    const chunks = [];
    let received = 0;
    response.on("data", (chunk) => {
      if (settled) return;
      received += chunk.length;
      if (received > maximum) {
        const error = responseTooLargeError();
        finish(reject, error);
        response.destroy(error);
        return;
      }
      chunks.push(chunk);
    });
    response.on("aborted", () => finish(reject, fail("Pinned HTTP response was aborted", "PINNED_HTTP_RESPONSE_ABORTED")));
    response.on("error", (error) => finish(reject, error));
    response.on("end", () => {
      if (settled) return;
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      }
      const bytes = Buffer.concat(chunks, received);
      finish(resolve, new Response(bytes.length ? bytes : null, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });
  });
  request.on("error", (error) => finish(reject, error));
  if (requestConfig.payload != null) request.write(requestConfig.payload);
  request.end();
});
