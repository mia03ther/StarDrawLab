import { forwardRef } from "react";
import usePrivateOssUrl from "../hooks/usePrivateOssUrl";

export const OssImage = forwardRef(function OssImage({ src, authorize = true, onError, ...props }, ref) {
  const asset = usePrivateOssUrl(src, { enabled: authorize });
  return <img {...props} ref={ref} src={asset.url || undefined} aria-busy={asset.loading || undefined} onError={(event) => { if (!asset.handleMediaError()) onError?.(event); }} />;
});

export const OssVideo = forwardRef(function OssVideo({ src, poster, authorize = true, authorizePoster = authorize, onError, ...props }, ref) {
  const asset = usePrivateOssUrl(src, { enabled: authorize });
  const posterAsset = usePrivateOssUrl(poster, { enabled: authorizePoster });
  return <video {...props} ref={ref} src={asset.url || undefined} poster={posterAsset.url || undefined} aria-busy={asset.loading || undefined} onError={(event) => { if (!asset.handleMediaError()) onError?.(event); }} />;
});

export const OssAudio = forwardRef(function OssAudio({ src, authorize = true, onError, ...props }, ref) {
  const asset = usePrivateOssUrl(src, { enabled: authorize });
  return <audio {...props} ref={ref} src={asset.url || undefined} aria-busy={asset.loading || undefined} onError={(event) => { if (!asset.handleMediaError()) onError?.(event); }} />;
});

export const OssBackground = ({ src, authorize = true, style, ...props }) => {
  const asset = usePrivateOssUrl(src, { enabled: authorize });
  const escapedUrl = String(asset.url || "").replace(/"/g, '\\"');
  const backgroundStyle = escapedUrl ? { backgroundImage: `url("${escapedUrl}")`, backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundSize: "cover" } : {};
  return <div {...props} aria-busy={asset.loading || undefined} style={{ ...backgroundStyle, ...style }} />;
};
