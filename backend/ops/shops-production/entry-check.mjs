import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
const modules=resolve(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const {chromium}=createRequire(pathToFileURL(resolve(modules,'playwright/package.json')))('playwright');
const out='C:/Users/ADMIN/Documents/Codex/shops-handout-preview-20261024/production-private',root='https://tranhoangduc90.github.io/izone-ai-team-pages/';
const b=await chromium.launch({channel:'msedge',headless:true}),c=await b.newContext(),p=await c.newPage();
const writes=[],errors=[];c.on('request',r=>{if(r.method()==='POST'&&/\/(?:checks|lesson9\/sessions|lesson-sessions)$/.test(new URL(r.url()).pathname))writes.push(r.url());});p.on('pageerror',e=>errors.push(e.message));
try{
 await p.goto(root+'shops-writing/');await p.locator('#identity-form').waitFor();
 const classes=await p.locator('#identity-class option').evaluateAll(nodes=>nodes.map(n=>({ref:n.value,code:n.textContent}))),counts={};
 assert.deepEqual(classes.map(x=>x.code),['CS.181026','CS.160826','CS.070626']);
 for(const x of classes){await p.locator('#identity-class').selectOption(x.ref);counts[x.code]=await p.locator('#identity-person option').count();}
 assert.deepEqual(counts,{'CS.181026':24,'CS.160826':23,'CS.070626':23});
 await p.goto(root+'writing-handouts/lesson.html?task=writing-task2-public-health-ban&class=CS.160826');await p.locator('#identity-form').waitFor();
 assert.ok(p.url().startsWith(root+'shops-writing/index.html'));assert.equal(await p.locator('#identity-class option').count(),1);assert.equal(await p.locator('#identity-person option').count(),23);
 await p.screenshot({path:out+'/live-official-student-entry.private.png',fullPage:true});
 await p.goto(root+'writing-handouts/teacher.html?task=writing-task2-public-health-ban&class=CS.181026');await p.locator('#google-signin').waitFor({timeout:45000});
 assert.ok(p.url().startsWith(root+'shops-writing/teacher.html'));assert.equal(new URL(p.url()).searchParams.get('class'),'CS.181026');
 await p.locator('#google-signin iframe').waitFor({timeout:25000});
 await p.screenshot({path:out+'/live-official-google-entry.png',fullPage:true});
 assert.equal(writes.length,0);assert.equal(errors.length,0,errors.join('\n'));
 const report={outcome:'passed',classes:counts,syntheticRosterHidden:true,oldStudentAndTeacherLinksRedirectCorrectly:true,googleButtonLoadedOnOfficialOrigin:true,realGoogleSignInRepeated:false,realStudentSessionsOpened:0,pageErrors:errors};
 await writeFile(out+'/official-entry.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await c.close();await b.close();}
