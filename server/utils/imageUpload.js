import path from "path";
import sharp from "sharp";

const JPEG_MIME = "image/jpeg";

const buildJpegName = (originalname = "upload.jpg") => {
  const ext = path.extname(originalname);
  const base = path.basename(originalname, ext) || "upload";
  return `${base}.jpg`;
};

export const normalizeUploadedImage = async (file) => {
  if (!file?.buffer) return file;

  const inputMime = (file.mimetype || "").toLowerCase();
  if (inputMime === "image/jpeg" || inputMime === "image/jpg") {
    return {
      ...file,
      mimetype: JPEG_MIME,
      originalname: buildJpegName(file.originalname),
    };
  }

  const converted = await sharp(file.buffer, { animated: false })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();

  return {
    ...file,
    buffer: converted,
    mimetype: JPEG_MIME,
    originalname: buildJpegName(file.originalname),
  };
};

export const normalizeUploadedImages = async (files = []) =>
  Promise.all((Array.isArray(files) ? files : []).map(normalizeUploadedImage));
