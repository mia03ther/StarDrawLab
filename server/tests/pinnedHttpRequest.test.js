import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildPinnedRequestOptions,
  createPinnedAddressLookup,
  requestPinnedHttp,
} from "../infrastructure/pinnedHttpRequest.js";

const listen = async (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve(server.address().port);
  });
});

const close = async (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test("pinned HTTP options preserve the original Host and HTTPS SNI", async () => {
  const config = buildPinnedRequestOptions({
    target: new URL("https://mcp.example.test:8443/mcp"),
    addresses: [{ address: "93.184.216.34", family: 4 }],
    method: "POST",
    body: "{}",
  });
  assert.equal(config.options.headers.host, "mcp.example.test:8443");
  assert.equal(config.options.servername, "mcp.example.test");
  assert.equal(config.options.agent, false);
  assert.equal(config.options.headers["content-length"], "2");
  const resolved = await new Promise((resolve, reject) => config.options.lookup(
    "mcp.example.test",
    {},
    (error, address, family) => error ? reject(error) : resolve({ address, family }),
  ));
  assert.deepEqual(resolved, { address: "93.184.216.34", family: 4 });
});

test("pinned lookup rejects a hostname substitution", async () => {
  const lookup = createPinnedAddressLookup({
    hostname: "mcp.example.test",
    addresses: [{ address: "93.184.216.34", family: 4 }],
  });
  await assert.rejects(
    new Promise((resolve, reject) => lookup("metadata.internal", {}, (error, address) => error ? reject(error) : resolve(address))),
    (error) => error.code === "PINNED_HTTP_HOST_MISMATCH",
  );
});

test("pinned HTTP request connects through the snapshot and enforces the byte limit", async (context) => {
  const seenHosts = [];
  const server = http.createServer((request, response) => {
    seenHosts.push(request.headers.host);
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(64));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const port = await listen(server);
  context.after(() => close(server));
  const common = {
    addresses: [{ address: "127.0.0.1", family: 4 }],
    maxResponseBytes: 32,
  };
  const response = await requestPinnedHttp({
    ...common,
    target: new URL(`http://mcp.example.test:${port}/ok`),
  });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seenHosts[0], `mcp.example.test:${port}`);

  await assert.rejects(
    requestPinnedHttp({
      ...common,
      target: new URL(`http://mcp.example.test:${port}/large`),
      responseTooLargeError: () => Object.assign(new Error("too large"), { code: "TEST_TOO_LARGE" }),
    }),
    (error) => error.code === "TEST_TOO_LARGE",
  );
});
