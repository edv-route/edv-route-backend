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
  JWT_EXPIRES_IN: string;
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
    SUPABASE_URL: { type: 'string', default: '' },
    SUPABASE_SERVICE_ROLE_KEY: { type: 'string', default: '' },
    STORAGE_BUCKET: { type: 'string', default: 'documents' },
    FIREBASE_PROJECT_ID: { type: 'string', default: '' },
    FIREBASE_CLIENT_EMAIL: { type: 'string', default: '' },
    FIREBASE_PRIVATE_KEY: { type: 'string', default: '' },
  },
} as const;

/**
 * Loads and validates environment variables (including .env in development).
 * Fails fast on boot if a required variable is missing or malformed.
 */
export function loadConfig(): AppConfig {
  return envSchema<AppConfig>({ schema, dotenv: true });
}
