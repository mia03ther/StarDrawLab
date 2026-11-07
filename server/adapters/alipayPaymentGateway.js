import * as alipayProvider from "../providers/alipayAPI.js";
import { PaymentGatewayPort } from "../ports/paymentPort.js";

/**
 * Alipay adapter. Keep SDK-specific calls here so the subscription module
 * depends only on PaymentGatewayPort.
 */
export class AlipayPaymentGateway extends PaymentGatewayPort {
  #provider;

  constructor({ provider = alipayProvider } = {}) {
    super();
    const required = [
      "isAlipayConfigured",
      "getAlipayAccountConfig",
      "verifyNotify",
      "createPagePayment",
      "queryPayment",
      "closePayment",
      "createPeriodicAgreement",
      "createPeriodicPayment",
      "refundPayment",
      "queryRefund",
    ];
    for (const method of required) {
      if (typeof provider?.[method] !== "function") {
        throw new TypeError(`Alipay payment adapter requires ${method}`);
      }
    }
    this.#provider = provider;
  }

  isConfigured() {
    return this.#provider.isAlipayConfigured();
  }

  getAccountConfig() {
    return this.#provider.getAlipayAccountConfig();
  }

  verifyNotification(params) {
    return this.#provider.verifyNotify(params);
  }

  createPagePayment(params) {
    return this.#provider.createPagePayment(params);
  }

  queryPayment(params) {
    return this.#provider.queryPayment(params);
  }

  closePayment(params) {
    return this.#provider.closePayment(params);
  }

  createPeriodicAgreement(params) {
    return this.#provider.createPeriodicAgreement(params);
  }

  createPeriodicPayment(params) {
    return this.#provider.createPeriodicPayment(params);
  }

  refundPayment(params) {
    return this.#provider.refundPayment(params);
  }

  queryRefund(params) {
    return this.#provider.queryRefund(params);
  }
}

export const createAlipayPaymentGateway = (options = {}) => new AlipayPaymentGateway(options);
