import { envSchema } from 'env-schema';

export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  CORS_ORIGIN: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  /** File storage. Optional: without them the app boots with uploads disabled. */
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  STORAGE_BUCKET: string;
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
    JWT_SECRET: { type: 'string', minLength: 32 },
    JWT_EXPIRES_IN: { type: 'string', default: '8h' },
    SUPABASE_URL: { type: 'string', default: '' },
    SUPABASE_SERVICE_ROLE_KEY: { type: 'string', default: '' },
    STORAGE_BUCKET: { type: 'string', default: 'documents' },
  },
} as const;

/**
 * Loads and validates environment variables (including .env in development).
 * Fails fast on boot if a required variable is missing or malformed.
 */
export function loadConfig(): AppConfig {
  return envSchema<AppConfig>({ schema, dotenv: true });
}
