import { readFileSync } from 'node:fs';
import { createClassroomReadOnlyClient } from '../src/reading-listening67/classroom-cta-google.js';
import { createClassroomCtaServer } from '../src/reading-listening67/classroom-cta-service.js';

const { K67_CTA_READ_OAUTH_FILE: file, K67_CTA_SCANNER_TOKEN_FILE: secret,
  K67_CTA_SCANNER_CLASSES: classes, K67_CTA_SCANNER_GOOGLE_ACCOUNT: account } = process.env;
if (!file || !secret || !classes || !account) throw Error('CTA_SCANNER_ENV_REQUIRED');
const scanner = createClassroomCtaServer({
  token: readFileSync(secret, 'utf8').trim(),
  classes: JSON.parse(classes),
  get: createClassroomReadOnlyClient({ file, account }),
  log: event => console.log(JSON.stringify(event)),
});
scanner.requestTimeout = 10_000;
scanner.headersTimeout = 5_000;
scanner.listen(8788, '0.0.0.0');
