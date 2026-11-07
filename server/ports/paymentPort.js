/**
 * Provider-neutral payment seam used by subscription application logic.
 *
 * The application knows about payment capabilities and stable result shapes,
 * but not Alipay SDK objects, gateway URLs, or provider naming conventions.
 * A future provider or a sandbox adapter can fill this seam without changing
 * subscription state transitions.
 */
export class PaymentGatewayPort {
  isConfigured() {
    throw new Error("PaymentGatewayPort.isConfigured is not implemented");
  }

  getAccountConfig() {
    throw new Error("PaymentGatewayPort.getAccountConfig is not implemented");
  }

  verifyNotification() {
    throw new Error("PaymentGatewayPort.verifyNotification is not implemented");
  }

  async createPagePayment() {
    throw new Error("PaymentGatewayPort.createPagePayment is not implemented");
  }

  async queryPayment() {
    throw new Error("PaymentGatewayPort.queryPayment is not implemented");
  }

  async closePayment() {
    throw new Error("PaymentGatewayPort.closePayment is not implemented");
  }

  async createPeriodicAgreement() {
    throw new Error("PaymentGatewayPort.createPeriodicAgreement is not implemented");
  }

  async createPeriodicPayment() {
    throw new Error("PaymentGatewayPort.createPeriodicPayment is not implemented");
  }

  async refundPayment() {
    throw new Error("PaymentGatewayPort.refundPayment is not implemented");
  }

  async queryRefund() {
    throw new Error("PaymentGatewayPort.queryRefund is not implemented");
  }
}
