import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8790),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(8),
  ALLOWED_ORIGINS: z.string().min(1),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(1),
  INTERNAL_API_TOKEN: z.string().min(32),
  WEB_SUBSTITUTE_API_TOKEN: z.string().min(32).optional(),
  WEB_SUBSTITUTE_GRADER_TOKEN: z.string().min(32).optional(),
  WEB_SUBSTITUTE_PORTAL_TOKEN: z.string().min(32).optional(),
  WEB_SUBSTITUTE_ENABLED: z.enum(['true', 'false']).default('false'),
  WEB_SUBSTITUTE_PORTAL_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_CLIENT_ID: z.string().trim().min(1),
  TEACHER_SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(180).default(90),
  TEACHER_SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(730).default(365),
  TEACHER_SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_]+$/).default('izone_teacher_session'),
  TEACHER_SESSION_COOKIE_PATH: z.string().regex(/^\/[A-Za-z0-9_/-]*$/).default('/writing-api'),
  TEACHER_SESSION_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  TEACHER_SESSION_COOKIE_PARTITIONED: z.enum(['true', 'false']).optional(),
  TEACHER_SESSION_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
  PROVISIONAL_STUDENT_PIN_PEPPER: z.string().min(32),
  WRITING_FLOW_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  WRITING_FLOW_HANDOFF_NOTIFY_URL: z.string().url().optional(),
  WRITING_FLOW_SOURCE_NOTIFY_URL: z.string().url().optional(),
  WRITING_FLOW_NOTIFY_SECRET: z.string().min(32).optional()
}).superRefine((value, context) => {
  if (value.TEACHER_SESSION_ABSOLUTE_DAYS < value.TEACHER_SESSION_IDLE_DAYS) {
    context.addIssue({ code: 'custom', path: ['TEACHER_SESSION_ABSOLUTE_DAYS'], message: 'Hạn tuyệt đối phải lớn hơn hoặc bằng hạn nhàn rỗi.' });
  }
  const notifyUrls = [value.WRITING_FLOW_HANDOFF_NOTIFY_URL,
    value.WRITING_FLOW_SOURCE_NOTIFY_URL].filter(Boolean);
  if (notifyUrls.length && !value.WRITING_FLOW_NOTIFY_SECRET) {
    context.addIssue({ code: 'custom', path: ['WRITING_FLOW_NOTIFY_SECRET'],
      message: 'Đã bật đường đánh thức Writing nhưng thiếu khóa xác thực.' });
  }
  const webTokens = [value.INTERNAL_API_TOKEN,
    value.WEB_SUBSTITUTE_API_TOKEN, value.WEB_SUBSTITUTE_GRADER_TOKEN,
    value.WEB_SUBSTITUTE_PORTAL_TOKEN].filter(Boolean);
  if (new Set(webTokens).size !== webTokens.length) {
    context.addIssue({ code: 'custom', path: ['WEB_SUBSTITUTE_GRADER_TOKEN'],
      message: 'Khóa gateway, bộ chấm và API nội bộ phải khác nhau; khóa Portal cũng phải khác.' });
  }
  if (value.WEB_SUBSTITUTE_ENABLED === 'true'
    && (!value.WEB_SUBSTITUTE_API_TOKEN || !value.WEB_SUBSTITUTE_GRADER_TOKEN
      || !value.WRITING_FLOW_ENCRYPTION_KEY)) {
    context.addIssue({ code: 'custom', path: ['WEB_SUBSTITUTE_ENABLED'],
      message: 'Mở Substitute cần hai khóa riêng và khóa mã hóa Writing.' });
  }
  if (value.WEB_SUBSTITUTE_PORTAL_ENABLED === 'true'
    && (value.WEB_SUBSTITUTE_ENABLED !== 'true'
      || !value.WEB_SUBSTITUTE_PORTAL_TOKEN)) {
    context.addIssue({ code: 'custom', path: ['WEB_SUBSTITUTE_PORTAL_ENABLED'],
      message: 'Mở đồng bộ Portal cần bật Substitute và có khóa Portal riêng.' });
  }
  for (const url of notifyUrls) {
    if (new URL(url).protocol !== 'https:' && value.NODE_ENV === 'production') {
      context.addIssue({ code: 'custom', path: ['WRITING_FLOW_HANDOFF_NOTIFY_URL'],
        message: 'Production chỉ cho phép webhook Writing dùng HTTPS.' });
    }
  }
});

export function loadConfig(env = process.env) {
  const value = schema.parse(env);
  const teacherSessionCookieSecure = value.TEACHER_SESSION_COOKIE_SECURE
    ? value.TEACHER_SESSION_COOKIE_SECURE === 'true'
    : value.NODE_ENV === 'production';
  const teacherSessionCookieSameSite = value.TEACHER_SESSION_COOKIE_SAME_SITE
    || (teacherSessionCookieSecure ? 'none' : 'lax');
  const teacherSessionCookiePartitioned = value.TEACHER_SESSION_COOKIE_PARTITIONED
    ? value.TEACHER_SESSION_COOKIE_PARTITIONED === 'true'
    : value.NODE_ENV === 'production';
  if (teacherSessionCookieSameSite === 'none' && !teacherSessionCookieSecure) {
    throw new Error('Cookie SameSite=None bắt buộc bật Secure.');
  }
  if (teacherSessionCookiePartitioned && !teacherSessionCookieSecure) {
    throw new Error('Cookie Partitioned bắt buộc bật Secure.');
  }
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    dbPoolMax: value.DB_POOL_MAX,
    allowedOrigins: new Set(value.ALLOWED_ORIGINS.split(',').map(item => item.trim()).filter(Boolean)),
    trustProxyHops: value.TRUST_PROXY_HOPS,
    internalApiToken: value.INTERNAL_API_TOKEN,
    webSubstituteApiToken: value.WEB_SUBSTITUTE_API_TOKEN || null,
    webSubstituteGraderToken: value.WEB_SUBSTITUTE_GRADER_TOKEN || null,
    webSubstitutePortalToken: value.WEB_SUBSTITUTE_PORTAL_TOKEN || null,
    webSubstituteEnabled: value.WEB_SUBSTITUTE_ENABLED === 'true',
    webSubstitutePortalEnabled: value.WEB_SUBSTITUTE_PORTAL_ENABLED === 'true',
    googleClientId: value.GOOGLE_CLIENT_ID,
    teacherSessionIdleDays: value.TEACHER_SESSION_IDLE_DAYS,
    teacherSessionAbsoluteDays: value.TEACHER_SESSION_ABSOLUTE_DAYS,
    teacherSessionCookieName: value.TEACHER_SESSION_COOKIE_NAME,
    teacherSessionCookiePath: value.TEACHER_SESSION_COOKIE_PATH,
    teacherSessionCookieSecure,
    teacherSessionCookiePartitioned,
    teacherSessionCookieSameSite: teacherSessionCookieSameSite[0].toUpperCase() + teacherSessionCookieSameSite.slice(1),
    provisionalStudentPinPepper: value.PROVISIONAL_STUDENT_PIN_PEPPER,
    writingFlowEncryptionKey: value.WRITING_FLOW_ENCRYPTION_KEY || null,
    writingFlowHandoffNotifyUrl: value.WRITING_FLOW_HANDOFF_NOTIFY_URL || null,
    writingFlowSourceNotifyUrl: value.WRITING_FLOW_SOURCE_NOTIFY_URL || null,
    writingFlowNotifySecret: value.WRITING_FLOW_NOTIFY_SECRET || null
  };
}
