import { envSchema } from 'env-schema';

export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  CORS_ORIGIN: string;
  DATABASE_URL: string;
  /**
   * Connections this instance may hold. 0 = pick by environment (see db.ts).
   * Exists so production can be retuned from Railway when the Supabase pool
   * size changes, without a redeploy of code.
   */
  DATABASE_POOL_MAX: number;
  JWT_SECRET: string;
  /** Admin (panel) session. Stays SHORT: it is a browser on a shared machine. */
  JWT_EXPIRES_IN: string;
  /**
   * Driver (app) session. Long on purpose: the app must stay logged in across
   * days, or location reporting dies every night and the driver has to type his
   * password to get back on the road.
   *
   * The trade is that a long token cannot be revoked by expiry, so the driver
   * guard checks the account's status on every request instead - see auth.ts.
   */
  DRIVER_JWT_EXPIRES_IN: string;
  /** File storage. Optional: without them the app boots with uploads disabled. */
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STORAGE_BUCKET: string;
  /**
   * Firebase Cloud Messaging. Optional, exactly like the storage keys: without
   * the three of them the dispatcher keeps the log-only sender and nothing ever
   * leaves the building. Push must never be what stops the API from booting.
   */
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  /**
   * Transactional email (Resend). Optional like storage and Firebase: without
   * them the API boots with a log-only sender and password recovery refuses up
   * front instead of promising a code that never leaves.
   */
  RESEND_API_KEY: string;
  /**
   * Verified sender, e.g. `EDV Route <no-responder@tu-dominio.com>`. With SMTP
   * against Gmail it must be the authenticated account itself (Gmail rewrites
   * anything else); left empty there, SMTP_USER is used.
   */
  EMAIL_FROM: string;
  /**
   * Plain SMTP, the fallback while EDV Route has no domain of its own: no ESP
   * sends to arbitrary recipients from an unverified domain. Resend wins when
   * both are configured.
   */
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  /**
   * Gmail through its HTTP API. This is what production uses: Railway blocks
   * outbound SMTP below the Pro plan, but nothing blocks HTTPS, and the mail
   * still leaves Google's servers signed by Google.
   * The refresh token only stays valid if the OAuth app is PUBLISHED - left in
   * "Testing" Google expires it after 7 days.
   */
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
}

const schema = {
  type: 'object',
  required: ['DATABASE_URL', 'JWT_SECRET'],
  properties: {
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'test', 'production'],
      default: 'development',
    },
    HOST: { type: 'string', default: '0.0.0.0' },
    PORT: { type: 'number', default: 3000 },
    LOG_LEVEL: {
      type: 'string',
      enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info',
    },
    CORS_ORIGIN: { type: 'string', default: 'http://localhost:4200' },
    DATABASE_URL: { type: 'string' },
    DATABASE_POOL_MAX: { type: 'number', default: 0 },
    JWT_SECRET: { type: 'string', minLength: 32 },
    JWT_EXPIRES_IN: { type: 'string', default: '8h' },
    DRIVER_JWT_EXPIRES_IN: { type: 'string', default: '365d' },
    SUPABASE_URL: { type: 'string', default: '' },
    SUPABASE_SERVICE_ROLE_KEY: { type: 'string', default: '' },
    STORAGE_BUCKET: { type: 'string', default: 'documents' },
    FIREBASE_PROJECT_ID: { type: 'string', default: '' },
    FIREBASE_CLIENT_EMAIL: { type: 'string', default: '' },
    FIREBASE_PRIVATE_KEY: { type: 'string', default: '' },
    RESEND_API_KEY: { type: 'string', default: '' },
    EMAIL_FROM: { type: 'string', default: '' },
    SMTP_HOST: { type: 'string', default: '' },
    SMTP_PORT: { type: 'number', default: 587 },
    SMTP_USER: { type: 'string', default: '' },
    SMTP_PASSWORD: { type: 'string', default: '' },
    GMAIL_CLIENT_ID: { type: 'string', default: '' },
    GMAIL_CLIENT_SECRET: { type: 'string', default: '' },
    GMAIL_REFRESH_TOKEN: { type: 'string', default: '' },
  },
} as const;

/**
 * Loads and validates environment variables (including .env in development).
 * Fails fast on boot if a required variable is missing or malformed.
 */
export function loadConfig(): AppConfig {
  return envSchema<AppConfig>({ schema, dotenv: true });
}
