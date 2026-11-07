import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = "__stardrawAlipayProviderTest";
globalThis[stateKey] = { response: null, pageExecuteCalls: [] };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "alipay-sdk"
        && context.parentURL
        && new URL(context.parentURL).pathname.endsWith("/providers/alipayAPI.js")) {
      return { shortCircuit: true, url: "stardraw-alipay-provider-test:sdk" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== "stardraw-alipay-provider-test:sdk") return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        const state = globalThis.${stateKey};
        export class AlipaySdk {
          constructor() {}
          async exec() {
            return { alipay_trade_query_response: state.response };
          }
          pageExecute(...args) {
            state.pageExecuteCalls.push(args);
            return "https://openapi.alipay.com/gateway.do?signed=1";
          }
          checkNotifySign() { return true; }
        }
      `,
    };
  },
});

const provider = await import("../providers/alipayAPI.js?provider-identity-test");

test("page payment returns a signed browser redirect URL", async () => {
  const previous = {
    appId: process.env.ALIPAY_APP_ID,
    sellerId: process.env.ALIPAY_SELLER_ID,
    privateKey: process.env.ALIPAY_PRIVATE_KEY,
    publicKey: process.env.ALIPAY_PUBLIC_KEY,
    notifyUrl: process.env.ALIPAY_NOTIFY_URL,
    returnUrl: process.env.ALIPAY_RETURN_URL,
  };
  process.env.ALIPAY_APP_ID = "configured-app";
  process.env.ALIPAY_SELLER_ID = "configured-seller";
  process.env.ALIPAY_PRIVATE_KEY = "private-key";
  process.env.ALIPAY_PUBLIC_KEY = "public-key";
  process.env.ALIPAY_NOTIFY_URL = "https://example.com/api/payments/alipay/notify";
  process.env.ALIPAY_RETURN_URL = "https://example.com/ai/billing";
  globalThis[stateKey].pageExecuteCalls = [];

  try {
    const result = await provider.createPagePayment({
      orderNo: "SO-1",
      subject: "StarDraw subscription",
      amountCents: 100,
    });
    assert.equal(result, "https://openapi.alipay.com/gateway.do?signed=1");
    assert.equal(globalThis[stateKey].pageExecuteCalls.length, 1);
    const [method, httpMethod, params] = globalThis[stateKey].pageExecuteCalls[0];
    assert.equal(method, "alipay.trade.page.pay");
    assert.equal(httpMethod, "GET");
    assert.equal(params.notifyUrl, process.env.ALIPAY_NOTIFY_URL);
    assert.equal(params.returnUrl, process.env.ALIPAY_RETURN_URL);
    assert.equal(params.bizContent.totalAmount, "1.00");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envKey = {
        appId: "ALIPAY_APP_ID",
        sellerId: "ALIPAY_SELLER_ID",
        privateKey: "ALIPAY_PRIVATE_KEY",
        publicKey: "ALIPAY_PUBLIC_KEY",
        notifyUrl: "ALIPAY_NOTIFY_URL",
        returnUrl: "ALIPAY_RETURN_URL",
      }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});

test("payment query preserves explicit provider identity fields", async () => {
  const previous = {
    appId: process.env.ALIPAY_APP_ID,
    sellerId: process.env.ALIPAY_SELLER_ID,
    privateKey: process.env.ALIPAY_PRIVATE_KEY,
    publicKey: process.env.ALIPAY_PUBLIC_KEY,
  };
  process.env.ALIPAY_APP_ID = "configured-app";
  process.env.ALIPAY_SELLER_ID = "configured-seller";
  process.env.ALIPAY_PRIVATE_KEY = "private-key";
  process.env.ALIPAY_PUBLIC_KEY = "public-key";
  globalThis[stateKey].response = {
    code: "10000",
    trade_status: "TRADE_SUCCESS",
    app_id: "provider-app",
    seller_id: "provider-seller",
    out_trade_no: "SO-1",
    trade_no: "TRADE-1",
    total_amount: "99.00",
  };

  try {
    const result = await provider.queryPayment({ outTradeNo: "SO-1" });
    assert.equal(result.appId, "provider-app");
    assert.equal(result.sellerId, "provider-seller");
    assert.equal(result.outTradeNo, "SO-1");
    assert.equal(result.totalAmount, "99.00");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
