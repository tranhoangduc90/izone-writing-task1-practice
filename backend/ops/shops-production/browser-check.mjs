import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const modules=resolve(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const {chromium}=createRequire(pathToFileURL(resolve(modules,'playwright/package.json')))('playwright');
const local=process.argv.includes('--candidate'),out='C:/Users/ADMIN/Documents/Codex/shops-handout-preview-20261024/production-private';
const files='C:/Users/ADMIN/Documents/Codex/shops-production-worktrees/pages/shops-writing';
const f=JSON.parse(await readFile(out+'/browser-fixture.private.json','utf8'));
const base='https://tranhoangduc90.github.io/izone-ai-team-pages/shops-writing/',api='https://ducizone.ddns.net/shops-writing-api/api/v1/';
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[],bad=[];
context.on('page',page=>{page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().startsWith(base)&&r.status()>=400)bad.push([r.status(),r.url()]);});});
if(local)await context.route(base+'**',async route=>{
 const u=new URL(route.request().url()),relative=decodeURIComponent(u.pathname.slice(new URL(base).pathname.length))||'index.html';
 const path=resolve(files,relative);assert.ok(path.startsWith(resolve(files)+sep));
 const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png'};
 try{await stat(path);await route.fulfill({status:200,body:await readFile(path),contentType:types[extname(path)]||'application/octet-stream'});}catch{bad.push([404,relative]);await route.fulfill({status:404,body:'Missing asset'});}
});
const mode=local?'candidate':'live';
try{
 await context.addCookies([{name:'izone_shops_teacher',value:f.cookie,domain:'ducizone.ddns.net',path:'/shops-writing-api',httpOnly:true,secure:true,sameSite:'None',partitionKey:'https://tranhoangduc90.github.io'}]);
 const student=await context.newPage();
 await student.addInitScript(({f})=>localStorage.setItem('izone:shops-writing:production:identity',JSON.stringify({id:f.sessions[1].studentRef,classRef:f.classRef,sessionRef:f.sessions[1].sessionRef})),{f});
 await student.goto(base);await student.locator('#workspace').waitFor();
 await student.locator('[data-target="result"]').click();await student.locator('#connected-draft-result .lms-draft-summary').waitFor();
 assert.equal(await student.locator('#connected-draft-result .lms-sentence-card').count(),2);
 const next=student.locator('#connected-draft-result .lms-draft-pager button').last();await next.click();
 const index=await student.locator('.lms-sentence-card:not([hidden])').getAttribute('data-sentence-index');
 await student.locator('[data-action="refresh"]').click();await student.locator('#connected-draft-result .lms-draft-summary').waitFor();
 assert.equal(await student.locator('.lms-sentence-card:not([hidden])').getAttribute('data-sentence-index'),index);
 await student.screenshot({path:out+'/'+mode+'-student-desktop.png',fullPage:true});
 await student.setViewportSize({width:390,height:844});await student.locator('[data-target="draft"]').click();
 assert.ok(await student.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await student.screenshot({path:out+'/'+mode+'-student-mobile.png',fullPage:true});
 const teacher=await context.newPage();await teacher.goto(base+'teacher.html?class='+f.classRef+'&session='+f.sessions[1].sessionRef);
 await teacher.locator('#detail[open]').waitFor({timeout:45000});assert.equal(await teacher.locator('#detail-name').textContent(),'Học viên kiểm triển khai 2');
 assert.equal(await teacher.locator('#teacher-class option').count(),1);
 await teacher.locator('#detail .teacher-draft-read').evaluate(e=>e.open=true);await teacher.locator('#connected-draft-result .lms-draft-summary').waitFor();
 assert.equal(await teacher.locator('#connected-draft-result .lms-sentence-card').count(),2);
 await teacher.screenshot({path:out+'/'+mode+'-teacher-desktop.png',fullPage:true});
 await teacher.reload();await teacher.locator('#detail[open]').waitFor();
 const tab=await context.newPage();await tab.goto(base+'teacher.html?class='+f.classRef+'&session='+f.sessions[1].sessionRef);await tab.locator('#detail[open]').waitFor();
 await teacher.setViewportSize({width:390,height:844});assert.ok(await teacher.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await teacher.screenshot({path:out+'/'+mode+'-teacher-mobile.png',fullPage:true});
 const wrong=await teacher.evaluate(async api=>{const r=await fetch(api+'admin/lesson9/sessions/00000000-0000-4000-8000-000000000001',{credentials:'include'});return r.status;},api);assert.ok([403,404].includes(wrong));
 await teacher.locator('[data-action="close-detail"]').click();await teacher.locator('[data-action="teacher-logout"]').click();
 await tab.reload();await tab.locator('#google-signin').waitFor();
 const status=await tab.evaluate(async api=>(await fetch(api+'auth/session',{credentials:'include'})).status,api);assert.equal(status,401);
 assert.equal(errors.length,0,errors.join('\n'));assert.equal(bad.length,0,JSON.stringify(bad));
 const report={outcome:'passed',mode,studentCards:2,teacherCards:2,pagerRetained:true,viewports:[1440,390],horizontalOverflow:false,sharedSourceRestoreReloadNewTabLogout:true,googleVerification:false,realStudentWrites:false,assetErrors:bad,pageErrors:errors};
 await writeFile(out+'/'+mode+'-browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){for(const [i,p]of context.pages().entries())await p.screenshot({path:out+'/'+mode+'-failure-'+i+'.png',fullPage:true}).catch(()=>{});await writeFile(out+'/'+mode+'-browser-failure.json',JSON.stringify({message:error.message,errors,bad}));throw error;}
finally{await context.close();await browser.close();}
