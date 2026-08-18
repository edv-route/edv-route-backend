/** Files the platform accepts: scanned papers and photos of documents. */
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export interface StoredFile {
  /** Storage key (bucket-relative path). Persisted in documents.file_url. */
  path: string;
}

/**
 * Storage abstraction: the rest of the codebase never talks to a vendor.
 * Swapping Supabase Storage for R2/S3 means writing another implementation
 * and changing configuration - no route or service is aware of the provider
 * (decision 2026-07-15: Supabase now, escape hatch kept cheap).
 */
export interface StorageProvider {
  upload(path: string, body: Buffer, contentType: string): Promise<StoredFile>;
  /** Time-limited URL: buckets are private, nothing is ever public. */
  getSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  /**
   * Signs MANY paths in one round trip, keyed by path. Signing avatars one by
   * one costs an HTTP call per row of a list; this costs one per page. A path
   * that cannot be signed is simply absent from the map (the caller falls back
   * to initials): a single broken photo must not fail the whole listing.
   */
  getSignedUrls(paths: string[], expiresInSeconds: number): Promise<Map<string, string>>;
  remove(path: string): Promise<void>;
}

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

/** Extension used when storing; derived from the MIME type, never from user input. */
export function extensionFor(mimeType: AllowedMimeType): string {
  return mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
}

/**
 * Magic-number sniffing: a renamed .exe must not pass as a PDF. Covers the
 * three accepted formats; anything else returns null and is rejected. Trusts
 * the file contents, never the client's declared type or filename.
 */
export function sniffMimeType(buffer: Buffer): AllowedMimeType | null {
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') {
    return 'application/pdf';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length >= 8 && PNG_SIGNATURE.every((byte, i) => buffer[i] === byte)) {
    return 'image/png';
  }
  return null;
}
