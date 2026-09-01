import type { StorageProvider } from './storage-provider.js';

/**
 * Avatar TTL: 1 hour, not 60s like documents. Avatars appear on every row of
 * every list and the client caches them by URL; a short TTL would re-download
 * the same faces on each scroll (a face is far less sensitive than a cédula,
 * and the bucket stays private).
 */
export const AVATAR_TTL_SECONDS = 3600;

/**
 * Resolves every stored photo path of a page into a signed URL with a SINGLE
 * round trip to the bucket. Signing row by row would cost one HTTP call per
 * person listed. A path that cannot be signed becomes null and the UI falls
 * back to initials — one broken photo must not fail the listing.
 *
 * Shared by the affiliates and the clients listings (extracted 2026-08-31 when
 * the clients list appeared; it lived private in DriversService).
 */
export async function signAvatars<T extends { photoUrl: string | null }>(
  storage: StorageProvider | null | undefined,
  items: T[],
): Promise<T[]> {
  const paths = items.map((i) => i.photoUrl).filter((p): p is string => Boolean(p));
  if (!storage || paths.length === 0) {
    return items.map((i) => ({ ...i, photoUrl: null }));
  }
  const signed = await storage.getSignedUrls(paths, AVATAR_TTL_SECONDS).catch(() => new Map());
  return items.map((i) => ({ ...i, photoUrl: (i.photoUrl && signed.get(i.photoUrl)) || null }));
}
