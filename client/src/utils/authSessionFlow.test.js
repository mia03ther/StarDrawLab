import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldStartAutomaticLogin,
  startLogoutRedirect,
} from "./authSessionFlow.js";

test("protected layout never starts login while logout is in progress", () => {
  assert.equal(shouldStartAutomaticLogin({
    isLoading: false,
    isSignedIn: false,
    isLoggingOut: true,
  }), false);
  assert.equal(shouldStartAutomaticLogin({
    isLoading: false,
    isSignedIn: false,
    isLoggingOut: false,
  }), true);
});

test("logout falls back to the local landing page when no SDK session exists", async () => {
  const redirects = [];
  const result = await startLogoutRedirect({
    sdk: { logoutWithRedirect: async () => assert.fail("SDK logout must not run without its state") },
    hasSdkLoginState: false,
    logoutUri: "https://stardrawai.com/",
    replaceLocation: (uri) => redirects.push(uri),
  });

  assert.equal(result, "local");
  assert.deepEqual(redirects, ["https://stardrawai.com/"]);
});

test("logout delegates to Authing when its SDK session exists", async () => {
  const calls = [];
  const result = await startLogoutRedirect({
    sdk: {
      logoutWithRedirect: async (options) => calls.push(options),
    },
    hasSdkLoginState: true,
    logoutUri: "https://stardrawai.com/",
    replaceLocation: () => assert.fail("local redirect must not replace the Authing logout redirect"),
  });

  assert.equal(result, "provider");
  assert.deepEqual(calls, [{ redirectUri: "https://stardrawai.com/" }]);
});

test("logout returns locally if the Authing redirect fails", async () => {
  const redirects = [];
  const result = await startLogoutRedirect({
    sdk: {
      logoutWithRedirect: async () => {
        throw new Error("provider unavailable");
      },
    },
    hasSdkLoginState: true,
    logoutUri: "https://stardrawai.com/",
    replaceLocation: (uri) => redirects.push(uri),
  });

  assert.equal(result, "fallback");
  assert.deepEqual(redirects, ["https://stardrawai.com/"]);
});
