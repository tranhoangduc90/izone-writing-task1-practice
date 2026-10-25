import fs from 'node:fs';
import {z} from 'zod';
export const PRODUCT='sw-task1';
export function loadConfig(env=process.env){
 const e=z.object({NODE_ENV:z.enum(['test','production']).default('production'),PORT:z.coerce.number().int().min(1024).max(65535).default(8790),TASK1_DATABASE_URL:z.url(),TASK1_PIN_PEPPER:z.string().min(32),TASK1_ALLOWED_ORIGINS:z.string().min(1),TASK1_SSO_URL:z.url().optional(),TASK1_SSO_KEY_FILE:z.string().optional(),TASK1_AI_URL:z.url().default('https://ducizone.ddns.net/dispatcher/webhook/phan_phoi_31_pro')}).parse(env);
 const db=new URL(e.TASK1_DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(db.protocol)||!/^\/sw_task1(?:_test)?$/.test(db.pathname)||db.username!=='task1_api')throw Error('TASK1_DATABASE_REQUIRED');
 if(e.NODE_ENV==='production'&&(!e.TASK1_SSO_URL||!e.TASK1_SSO_KEY_FILE))throw Error('TASK1_SHARED_SSO_REQUIRED');
 if(Boolean(e.TASK1_SSO_URL)!==Boolean(e.TASK1_SSO_KEY_FILE))throw Error('TASK1_SHARED_SSO_REQUIRED');
 if(e.TASK1_SSO_URL&&!new URL(e.TASK1_SSO_URL).pathname.endsWith('/internal/identity/task1'))throw Error('TASK1_SSO_SOURCE_REQUIRED');
 const ai=new URL(e.TASK1_AI_URL);
 if(ai.origin!=='https://ducizone.ddns.net'||ai.pathname!=='/dispatcher/webhook/phan_phoi_31_pro'||ai.search||ai.username||ai.password)throw Error('TASK1_AI_TARGET_REQUIRED');
 const origins=new Set(e.TASK1_ALLOWED_ORIGINS.split(',').map(x=>new URL(x.trim()).origin));
 if(e.NODE_ENV==='production'&&[...origins].some(x=>!x.startsWith('https://')))throw Error('HTTPS_ORIGIN_REQUIRED');
 if(env.TASK1_LEGACY_BASE&&new URL(env.TASK1_LEGACY_BASE).href!=='http://writing-legacy:8790/')throw Error('TASK1_LEGACY_TARGET_REQUIRED');
 if(env.TASK1_AUTHORITY_DATABASE_URL){const u=new URL(env.TASK1_AUTHORITY_DATABASE_URL);if(u.username!=='sw_task1_reader'||u.pathname!=='/mapping_db'||u.hostname!=='task1-authority-source')throw Error('TASK1_AUTHORITY_TARGET_REQUIRED');}
 return {productId:PRODUCT,nodeEnv:e.NODE_ENV,port:e.PORT,databaseUrl:e.TASK1_DATABASE_URL,dbPoolMax:4,pepper:e.TASK1_PIN_PEPPER,origins,aiUrl:e.TASK1_AI_URL,ssoUrl:e.TASK1_SSO_URL,ssoKey:e.TASK1_SSO_KEY_FILE?fs.readFileSync(e.TASK1_SSO_KEY_FILE,'utf8').trim():null,legacyBase:env.TASK1_LEGACY_BASE,authorityUrl:env.TASK1_AUTHORITY_DATABASE_URL};
}
