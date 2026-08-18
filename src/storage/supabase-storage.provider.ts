import type { StorageProvider, StoredFile } from './storage-provider.js';

/**
 * Supabase Storage over its REST API using native fetch - no SDK: the
 * official client drags auth/realtime/postgrest for three calls, and the
 * project already talks to Postgres with raw SQL for the same reason.
 */
export class SupabaseStorageProvider implements StorageProvider {
  private readonly baseUrl: string;

  constructor(
    supabaseUrl: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
  ) {
    this.baseUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1`;
  }

  private get headers(): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
    };
  }

  async upload(path: string, body: Buffer, contentType: string): Promise<StoredFile> {
    const response = await fetch(`${this.baseUrl}/object/${this.bucket}/${encodeURI(path)}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: new Uint8Array(body),
    });
    if (!response.ok) throw new Error(await this.errorText(response, 'subir el archivo'));
    return { path };
  }

  async getSignedUrl(path: string, expiresInSeconds: number): Promise<string> {
    const response = await fetch(`${this.baseUrl}/object/sign/${this.bucket}/${encodeURI(path)}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });
    if (!response.ok) throw new Error(await this.errorText(response, 'firmar la URL'));

    const { signedURL } = (await response.json()) as { signedURL: string };
    return `${this.baseUrl}${signedURL.replace(/^\/storage\/v1/, '')}`;
  }

  /**
   * Batch signing (Supabase createSignedUrls): one POST for every path. Returns
   * only what could be signed, so a missing object degrades to "no photo"
   * instead of breaking the listing that asked for it.
   */
  async getSignedUrls(paths: string[], expiresInSeconds: number): Promise<Map<string, string>> {
    const signed = new Map<string, string>();
    if (paths.length === 0) return signed;

    const response = await fetch(`${this.baseUrl}/object/sign/${this.bucket}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds, paths }),
    });
    if (!response.ok) throw new Error(await this.errorText(response, 'firmar las URLs'));

    const items = (await response.json()) as {
      path: string | null;
      signedURL: string | null;
      error: string | null;
    }[];
    for (const item of items) {
      if (item.error || !item.path || !item.signedURL) continue;
      signed.set(item.path, `${this.baseUrl}${item.signedURL.replace(/^\/storage\/v1/, '')}`);
    }
    return signed;
  }

  async remove(path: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/object/${this.bucket}/${encodeURI(path)}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!response.ok) throw new Error(await this.errorText(response, 'eliminar el archivo'));
  }

  private async errorText(response: Response, action: string): Promise<string> {
    const detail = await response.text().catch(() => '');
    return `Storage: no se pudo ${action} (HTTP ${response.status}). ${detail}`;
  }
}
