import assert from "node:assert/strict";
import test from "node:test";

import { createCsrfProtection } from "../middlewares/csrfProtection.js";

const invoke = ({ method = "POST", headers = {}, production = true } = {}) => {
  const middleware = createCsrfProtection({
    allowedOrigins: ["https://stardraw.example"],
    production,
  });
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  middleware({ method, headers }, response, () => { nextCalled = true; });
  return { response, nextCalled };
};

test("CSRF guard rejects cross-site bearer-authenticated mutations", () => {
  const result = invoke({
    headers: {
      authorization: "Bearer signed-token",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.statusCode, 403);
  assert.equal(result.response.body.code, "CSRF_REQUEST_REJECTED");
});

test("CSRF guard allows configured frontend and non-browser bearer clients", () => {
  const browser = invoke({
    headers: {
      authorization: "Bearer signed-token",
      origin: "https://stardraw.example",
      "sec-fetch-site": "same-origin",
    },
  });
  const cli = invoke({ headers: { authorization: "Bearer signed-token" } });
  assert.equal(browser.nextCalled, true);
  assert.equal(cli.nextCalled, true);
});

test("CSRF guard leaves safe methods and signed public callbacks to their own validators", () => {
  const safe = invoke({ method: "GET", headers: { origin: "https://attacker.example" } });
  const callback = invoke({
    method: "POST",
    headers: { origin: "https://provider.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(safe.nextCalled, true);
  assert.equal(callback.nextCalled, true);
});
