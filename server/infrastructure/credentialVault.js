import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CredentialVaultPort } from "../ports/mcpPort.js";

const VERSION = "v1";

const normalizeKey = (value) => {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const raw = String(value || "").trim();
  if (!raw) throw Object.assign(new Error("MCP_CREDENTIAL_MASTER_KEY is required"), { code: "MCP_CREDENTIAL_KEY_MISSING", status: 503 });
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fail below with a non-sensitive configuration error.
  }
  throw Object.assign(new Error("MCP_CREDENTIAL_MASTER_KEY must encode exactly 32 bytes"), {
    code: "MCP_CREDENTIAL_KEY_INVALID",
    status: 503,
  });
};

export const credentialMasterKeyFromEnv = () => normalizeKey(process.env.MCP_CREDENTIAL_MASTER_KEY);

/** AES-256-GCM vault. Ciphertexts are self-describing but never contain key material. */
export class AesGcmCredentialVault extends CredentialVaultPort {
  #key;

  constructor({ masterKey } = {}) {
    super();
    this.#key = normalizeKey(masterKey);
  }

  encrypt(value) {
    const plaintext = String(value ?? "");
    if (!plaintext) throw Object.assign(new Error("Credential value cannot be empty"), { code: "EMPTY_CREDENTIAL", status: 400 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
  }

  decrypt(value) {
    const parts = String(value || "").split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw Object.assign(new Error("Credential ciphertext format is invalid"), { code: "CREDENTIAL_CIPHERTEXT_INVALID", status: 503 });
    }
    try {
      const iv = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      const ciphertext = Buffer.from(parts[3], "base64url");
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid ciphertext lengths");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw Object.assign(new Error("Credential decryption failed"), { code: "CREDENTIAL_DECRYPTION_FAILED", status: 503 });
    }
  }
}

