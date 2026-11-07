import { createOssObjectStorageAdapter } from "../infrastructure/ossObjectStorageAdapter.js";
import { ObjectStoragePort } from "../ports/objectStoragePort.js";

let adapter;

const getAdapter = () => {
  if (!adapter) adapter = createOssObjectStorageAdapter();
  return adapter;
};

class ObjectStorageRuntime extends ObjectStoragePort {
  buildObjectKey(...args) { return getAdapter().buildObjectKey(...args); }
  uploadBuffer(...args) { return getAdapter().uploadBuffer(...args); }
  uploadFromUrl(...args) { return getAdapter().uploadFromUrl(...args); }
  getObjectMetadata(...args) {
    const current = getAdapter();
    if (typeof current.getObjectMetadata !== "function") {
      throw new Error("Object storage adapter does not support metadata verification");
    }
    return current.getObjectMetadata(...args);
  }
  downloadBuffer(...args) { return getAdapter().downloadBuffer(...args); }
  deleteObject(...args) { return getAdapter().deleteObject(...args); }
  deleteObjectsStrict(...args) { return getAdapter().deleteObjectsStrict(...args); }
  getSignedDownloadUrl(...args) { return getAdapter().getSignedDownloadUrl(...args); }
}

const runtime = new ObjectStorageRuntime();

/** Composition root for the object storage adapter. */
export const getObjectStorage = () => runtime;

export const setObjectStorageForTests = (candidate) => {
  const required = [
    "buildObjectKey",
    "uploadBuffer",
    "uploadFromUrl",
    "downloadBuffer",
    "deleteObject",
    "deleteObjectsStrict",
    "getSignedDownloadUrl",
  ];
  for (const method of required) {
    if (typeof candidate?.[method] !== "function") {
      throw new TypeError(`Object storage adapter requires ${method}`);
    }
  }
  // Keep the runtime object stable so already-imported controllers and
  // workers see the replacement on their next call.
  adapter = candidate;
  return runtime;
};

export const resetObjectStorage = () => {
  adapter = null;
};
