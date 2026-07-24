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
