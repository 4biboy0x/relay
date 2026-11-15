const uploadFilenamePattern = /^[0-9a-f-]+\\.(?:jpg|jpeg|png|webp|gif|webm|ogg|m4a|mp3|wav|aac|flac|opus)$/i;

/**
 * Resolve a persisted upload reference to the canonical local storage path.
 * Supports both current /uploads paths and legacy full Neon presigned URLs.
 * Only URLs from the configured storage endpoint and bucket are accepted.
 */
export const resolveStoredUploadPath = (
  value: string,
  endpoint: string | undefined,
  bucket: string,
): string | null => {
  if (value.startsWith("/uploads/")) {
    const filename = value.slice("/uploads/".length);
    return uploadFilenamePattern.test(filename) ? value : null;
  }

  if (!endpoint) return null;
  try {
    const candidate = new URL(value);
    const configuredEndpoint = new URL(endpoint);
    if (candidate.origin !== configuredEndpoint.origin) return null;

    const segments = candidate.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== bucket) return null;
    const filename = decodeURIComponent(segments[1]);
    if (!uploadFilenamePattern.test(filename)) return null;
    return `/uploads/${filename}`;
  } catch {
    return null;
  }
};
