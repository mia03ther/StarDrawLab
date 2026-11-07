/**
 * Provider-neutral object storage seam.
 *
 * Application modules exchange object keys and short-lived URLs through this
 * interface. They never need to know whether the backing adapter is Aliyun
 * OSS, S3-compatible storage, or a local test fake.
 */
export class ObjectStoragePort {
  buildObjectKey() {
    throw new Error("ObjectStoragePort.buildObjectKey is not implemented");
  }

  async uploadBuffer() {
    throw new Error("ObjectStoragePort.uploadBuffer is not implemented");
  }

  async uploadFromUrl() {
    throw new Error("ObjectStoragePort.uploadFromUrl is not implemented");
  }

  /** Return { exists, sizeBytes, contentType } without downloading the object. */
  async getObjectMetadata() {
    throw new Error("ObjectStoragePort.getObjectMetadata is not implemented");
  }

  async downloadBuffer() {
    throw new Error("ObjectStoragePort.downloadBuffer is not implemented");
  }

  async deleteObject() {
    throw new Error("ObjectStoragePort.deleteObject is not implemented");
  }

  async deleteObjectsStrict() {
    throw new Error("ObjectStoragePort.deleteObjectsStrict is not implemented");
  }

  getSignedDownloadUrl() {
    throw new Error("ObjectStoragePort.getSignedDownloadUrl is not implemented");
  }
}
