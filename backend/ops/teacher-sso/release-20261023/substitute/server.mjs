import { mkdirSync,readFileSync } from 'node:fs';
import {createSharedTeacherHandler} from './teacher-shared-handler.mjs';
import {createSharedTeacherVerifier} from './teacher-shared-session.mjs';
import { dirname } from 'node:path';
import { SubstituteStore } from './store.mjs';
import { createService } from './service.mjs';
import { createHttpServer } from './http.mjs';
import { ensure,configureClassCatalog } from './contract.mjs';
import { createPortalPolicy } from './portal-policy.mjs';
import { OAuth2Client } from 'google-auth-library';
import { createOutboxWorker } from './outbox.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {createReleaseLatch} from './release-latch.mjs';

// Tất cả cấu hình nhạy cảm được cung cấp ngoài Git; không có fallback sang Term.
process.umask(0o077);
const config=loadRuntimeConfig();
const releaseReady=createReleaseLatch(process.env.SUBSTITUTE_RELEASE_MARKER || '');
if(config.classCatalog)configureClassCatalog(config.classCatalog.tests);
const file = config.dbPath;
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
const store = new SubstituteStore({ file, encryptionKey: config.encryptionKey,
  portalColumns: config.portalColumns,portalMetadata: config.portalMetadata,
  portalPolicy: config.portalPolicy ? createPortalPolicy(config.portalPolicy) : null });
const reviewers = config.reviewers;
store.replaceReviewerAccounts(reviewers);
const google = new OAuth2Client(config.googleClientId);
const createHandle = verifyTeacher => createService({ store, keys: config.keys,externalWrites:Object.keys(config.outboxTargets).length>0,
  releaseReady,
  allowedOrigin: config.allowedOrigin, googleClientId: config.googleClientId,
  verifyTeacher });
const nativeHandle=createHandle(async token => { const ticket = await google.verifyIdToken({ idToken: token, audience: config.googleClientId });
    const claims = ticket.getPayload(); return { sub: claims?.sub, email: claims?.email, emailVerified: claims?.email_verified === true }; });
// Bật sau khi duyệt; không thay grant, bài làm, điểm hoặc cấu hình ghi ra ngoài.
const ssoUrl=process.env.SUBSTITUTE_TEACHER_SSO_URL,ssoKeyFile=process.env.SUBSTITUTE_TEACHER_SSO_KEY_FILE;
if(Boolean(ssoUrl)!==Boolean(ssoKeyFile))throw Error('SSO_CONSUMER_CONFIG_REQUIRED');
const handle=ssoUrl?createSharedTeacherHandler({handle:nativeHandle,createHandle,allowedOrigin:config.allowedOrigin,verifyShared:createSharedTeacherVerifier({url:ssoUrl,key:readFileSync(ssoKeyFile,'utf8').trim()})}):nativeHandle;
const server = createHttpServer(handle);
server.listen(config.port, config.bind);
const targets=config.outboxTargets;
const outbox=createOutboxWorker({store,targets,onEvent:event=>console.log(JSON.stringify(event))});
const timer=setInterval(()=>{if(releaseReady())outbox.tick().catch(()=>console.log(JSON.stringify({event:'outbox_unavailable'})));},30000);timer.unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {clearInterval(timer);server.close(() => { store.close(); process.exit(0); });});
