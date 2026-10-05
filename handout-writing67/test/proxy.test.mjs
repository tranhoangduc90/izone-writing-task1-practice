import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/http.mjs';

// Fixture chỉ thay DB bằng auth đã xác minh; rủi ro nằm ở HTTP bucket thật sau một proxy.
test('T-PROXY · hai phiên qua cùng proxy không dùng chung giới hạn học viên; health độc lập',async t=>{
  const service={authorizeSession(ref,token){assert.equal(token,'capability-'+ref);},read:async ref=>({ref})};
  const server=createApi({service,origins:[],internalSecret:'fixture'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/handout67/v1`;
  const refs=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  for(let i=0;i<125;i++) {
    const ref=refs[i%2];
    const response=await fetch(`${base}/sessions/${ref}`,{headers:{Authorization:'Bearer capability-'+ref}});
    assert.equal(response.status,200,`request ${i+1} không được chặn học viên khác cùng proxy`);
    await response.text();
  }
  // Một phiên vẫn bị giới hạn riêng; phiên còn lại và health không chịu quota của nó.
  for(let i=0;i<57;i++) {
    const response=await fetch(`${base}/sessions/${refs[0]}`,{headers:{Authorization:'Bearer capability-'+refs[0]}});
    assert.equal(response.status,200);await response.text();
  }
  const limited=await fetch(`${base}/sessions/${refs[0]}`,{headers:{Authorization:'Bearer capability-'+refs[0]}});
  assert.equal(limited.status,429);await limited.text();
  const other=await fetch(`${base}/sessions/${refs[1]}`,{headers:{Authorization:'Bearer capability-'+refs[1]}});
  assert.equal(other.status,200);await other.text();
  const health=await fetch(base+'/health');assert.equal(health.status,200);
  await health.text();
});
