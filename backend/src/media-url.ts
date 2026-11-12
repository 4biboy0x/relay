import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const signingWindowMs = 24 * 60 * 60 * 1000;
const signedUrlLifetimeSeconds = 48 * 60 * 60;
const cacheSafetyMarginMs = 5 * 60 * 1000;
const maxCachedMediaUrls = 5000;
const signedMediaUrls = new Map<string, { url: string; validUntil: number }>();
const storageClientIds = new WeakMap<S3Client, number>();
let nextStorageClientId = 1;

export const createSignedMediaUrl = async (
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> => {
  const now = Date.now();
  const signingTime = Math.floor(now / signingWindowMs) * signingWindowMs;
  let clientId = storageClientIds.get(client);
  if (!clientId) {
    clientId = nextStorageClientId++;
    storageClientIds.set(client, clientId);
  }
  const cacheKey = `${clientId}\0${bucket}\0${key}\0${signingTime}`;
  const validUntil = signingTime + signedUrlLifetimeSeconds * 1000 - cacheSafetyMarginMs;
  const cached = signedMediaUrls.get(cacheKey);
  if (cached && now < cached.validUntil) {
    signedMediaUrls.delete(cacheKey);
    signedMediaUrls.set(cacheKey, cached);
    return cached.url;
  }
  if (cached) signedMediaUrls.delete(cacheKey);

  const url = await getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: "inline",
    ResponseCacheControl: "private, max-age=86400",
  }), {
    expiresIn: signedUrlLifetimeSeconds,
    signingDate: new Date(signingTime),
  });
  signedMediaUrls.set(cacheKey, { url, validUntil });
  if (signedMediaUrls.size > maxCachedMediaUrls) {
    const oldestKey = signedMediaUrls.keys().next().value;
    if (oldestKey !== undefined) signedMediaUrls.delete(oldestKey);
  }
  return url;
};
