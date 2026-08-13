import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(8),
  ALLOWED_ORIGINS: z.string().min(1),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(1),
  INTERNAL_API_TOKEN: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().trim().min(1)
});

export function loadConfig(env = process.env) {
  const value = schema.parse(env);
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    dbPoolMax: value.DB_POOL_MAX,
    allowedOrigins: new Set(value.ALLOWED_ORIGINS.split(',').map(item => item.trim()).filter(Boolean)),
    trustProxyHops: value.TRUST_PROXY_HOPS,
    internalApiToken: value.INTERNAL_API_TOKEN,
    googleClientId: value.GOOGLE_CLIENT_ID
  };
}
