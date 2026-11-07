import * as ossProvider from "../configs/oss.js";
import { ObjectStoragePort } from "../ports/objectStoragePort.js";

/** Adapter for the current Aliyun OSS implementation. */
export class OssObjectStorageAdapter extends ObjectStoragePort {
  buildObjectKey(userId, type, ext) {
    return ossProvider.buildObjectKey(userId, type, ext);
  }

  uploadBuffer(buffer, objectKey, contentType) {
    return ossProvider.uploadBuffer(buffer, objectKey, contentType);
  }

  uploadFromUrl(remoteUrl, objectKey, contentType) {
    return ossProvider.uploadFromUrl(remoteUrl, objectKey, contentType);
  }

  getObjectMetadata(objectKey) {
    return ossProvider.getObjectMetadata(objectKey);
  }

  downloadBuffer(objectKey) {
    return ossProvider.downloadBuffer(objectKey);
  }

  deleteObject(objectKey) {
    return ossProvider.deleteObject(objectKey);
  }

  deleteObjectsStrict(objectKeys) {
    return ossProvider.deleteObjectsStrict(objectKeys);
  }

  getSignedDownloadUrl(objectKey, expiresSeconds, process) {
    return ossProvider.getSignedDownloadUrl(objectKey, expiresSeconds, process);
  }
}

export const createOssObjectStorageAdapter = () => new OssObjectStorageAdapter();
