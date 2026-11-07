import crypto from "node:crypto";
import path from "node:path";

const MIGRATION_FILENAME = /^(\d{3,})_[a-z0-9][a-z0-9_]*\.sql$/;
const SAFE_METADATA = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;

export const parseMigrationFilename = (filePath) => {
  const filename = path.basename(String(filePath || ""));
  const match = MIGRATION_FILENAME.exec(filename);
  if (!match) throw Object.assign(new Error("Migration filename is invalid"), { code: "INVALID_MIGRATION_FILENAME" });
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw Object.assign(new Error("Migration version is invalid"), { code: "INVALID_MIGRATION_VERSION" });
  }
  return { version, filename };
};

export const sha256Migration = (source) => crypto.createHash("sha256").update(String(source), "utf8").digest("hex");

const metadata = (value, name, max) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max || !SAFE_METADATA.test(normalized)) {
    throw Object.assign(new Error(`${name} is invalid`), { code: `INVALID_${name.toUpperCase()}` });
  }
  return normalized;
};

export const normalizeMigrationMetadata = ({ appliedBy, releaseVersion } = {}) => ({
  appliedBy: metadata(appliedBy, "applied_by", 255),
  releaseVersion: metadata(releaseVersion, "release_version", 128),
});
