/** Shared admission and native batch claims for one product database. */
import {claimWebWorkBatch,releaseUnstartedWebWork} from './web-work-claims.js';
const intervals = {grading:750,docs:500};
const scopeKey = scope => JSON.stringify([scope.code,scope.version]);

export function createWebWorkCoordinator({db,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
  const lanes=new Map();let closed=false;
  function report(handler,error){try{handler.onError(error);}catch{/* Reporting must not stop durable work. */}}
  function laneFor(name) {
    if(!Object.hasOwn(intervals,name))throw Error('WORK_LANE_INVALID');
    if(!lanes.has(name))lanes.set(name,{name,handlers:new Map(),timer:null,due:Infinity,selecting:null,wakePending:false,scans:0,degraded:0,runs:0});
    return lanes.get(name);
  }
  function schedule(lane,delay=intervals[lane.name]) {
    if(closed||!lane.handlers.size)return;
    if(lane.selecting){if(delay===0)lane.wakePending=true;return;}
    const due=clock()+delay;
    if(lane.timer&&lane.due<=due)return;
    clearTimer(lane.timer);lane.due=due;
    lane.timer=setTimer(()=>{lane.timer=null;lane.due=Infinity;void scan(lane);},delay);
    lane.timer?.unref?.();
  }
  function launch(lane,key,handler,job) {
    if(closed||handler.closed||handler.running)return false;
    lane.runs++;
    handler.running=Promise.resolve().then(()=>handler.run(job)).then(worked=>{
      if(worked)schedule(lane,0);
    }).catch(error=>report(handler,error)).finally(()=>{
      handler.running=null;
      if(lane.wakePending){lane.wakePending=false;schedule(lane,0);}
    });
    return true;
  }
  async function scan(lane) {
    if(closed||lane.selecting)return;
    lane.selecting=(async()=>{
      const eligible=[...lane.handlers].filter(([,h])=>!h.closed&&!h.running);
      if(!eligible.length)return;
      await Promise.all(eligible.map(async([,handler])=>{
        if(!handler.maintain||clock()-handler.lastMaintenance<30000)return;
        try{await handler.maintain();handler.lastMaintenance=clock();}catch(error){report(handler,error);}
      }));
      try {
        lane.scans++;
        const batch=eligible.filter(([,h])=>h.batchClaim),legacy=eligible.filter(([,h])=>!h.batchClaim);
        if(batch.length){
          const claimed=await claimWebWorkBatch(db,lane.name,batch.map(([,h])=>h.scope)),unstarted=[];
          for(const item of claimed){
            const key=scopeKey(item),handler=lane.handlers.get(key);
            if(!handler||!launch(lane,key,handler,item.job))unstarted.push(item);
          }
          // Shutdown can race a committed batch claim; return only jobs never handed to a worker.
          if(unstarted.length)await releaseUnstartedWebWork(db,lane.name,unstarted);
        }
        if(legacy.length){
          const ready=await selectReadyWebScopes(db,lane.name,legacy.map(([,h])=>h.scope));
          for(const scope of ready){const key=scopeKey(scope),handler=lane.handlers.get(key);if(handler)launch(lane,key,handler);}
        }
      } catch(error) {
        // A selector failure must not strand work. Native scoped claims remain authoritative.
        lane.degraded++;
        for(const [key,handler] of eligible){report(handler,error);launch(lane,key,handler);}
      }
    })();
    try{await lane.selecting;}finally{
      lane.selecting=null;
      const delay=lane.wakePending?0:intervals[lane.name];lane.wakePending=false;schedule(lane,delay);
    }
  }
  function register({lane:name,scope,run,maintain,batchClaim=false,onError=()=>{}}) {
    if(closed||!scope?.code||!scope?.version||typeof run!=='function')throw Error('WORK_REGISTRATION_INVALID');
    const lane=laneFor(name),key=scopeKey(scope);
    if(lane.handlers.has(key))throw Error('WORK_SCOPE_ALREADY_REGISTERED');
    const handler={scope:{code:scope.code,version:scope.version,validation:!!scope.validation},run,maintain,batchClaim,onError,running:null,closed:false,lastMaintenance:-Infinity};
    lane.handlers.set(key,handler);schedule(lane,0);
    return {async close(){handler.closed=true;lane.handlers.delete(key);if(!lane.handlers.size){clearTimer(lane.timer);lane.timer=null;lane.due=Infinity;}await lane.selecting;await handler.running;}};
  }
  return {
    register,
    wake(name){if(closed)return;if(name)schedule(laneFor(name),0);else for(const lane of lanes.values())schedule(lane,0);},
    snapshot(){return {closed,lanes:[...lanes.values()].map(l=>({name:l.name,registered:l.handlers.size,running:[...l.handlers.values()].filter(h=>h.running).length,scans:l.scans,degraded:l.degraded,runs:l.runs}))};},
    async close(){closed=true;for(const lane of lanes.values())clearTimer(lane.timer);await Promise.all([...lanes.values()].flatMap(l=>[l.selecting,...[...l.handlers.values()].map(h=>h.running)]));}
  };
}

export async function selectReadyWebScopes(db,lane,scopes) {
  if(!scopes.length)return [];
  if(!Object.hasOwn(intervals,lane))throw Error('WORK_LANE_INVALID');
  const scopeSql='SELECT code,version,validation FROM jsonb_to_recordset($1::jsonb) AS s(code text,version text,validation boolean)';
  let query;
  if(lane==='grading') {
    const validation=scopes.some(s=>s.validation);
    query=`WITH scopes AS (${scopeSql}) SELECT a.assignment_code AS code,a.content_version AS version,
      min(${validation?'COALESCE(v.next_attempt_at,j.created_at)':'j.created_at'}) AS ready_at
      FROM reading_listening67.web_job j JOIN reading_listening67.web_attempt a ON a.id=j.attempt_id
      JOIN scopes s ON s.code=a.assignment_code AND s.version=a.content_version
      ${validation?'LEFT JOIN reading_listening67.web_validation v ON v.job_id=j.id':''}
      WHERE j.status='queued' ${validation?'AND (NOT s.validation OR v.next_attempt_at IS NULL OR v.next_attempt_at<=now())':''}
      GROUP BY a.assignment_code,a.content_version ORDER BY ready_at,a.assignment_code,a.content_version`;
  } else {
    query=`WITH scopes AS (${scopeSql}) SELECT b.assignment_code AS code,b.content_version AS version,min(j.created_at) AS ready_at
      FROM reading_listening67.web_homework_job j JOIN reading_listening67.web_homework_binding b ON b.id=j.binding_id
      JOIN scopes s ON s.code=b.assignment_code AND s.version=b.content_version
      WHERE ((j.status='pending' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<now()))
      AND NOT EXISTS(SELECT 1 FROM reading_listening67.web_homework_job old WHERE old.binding_id=j.binding_id AND old.sequence<j.sequence AND old.status<>'verified')
      GROUP BY b.assignment_code,b.content_version ORDER BY ready_at,b.assignment_code,b.content_version`;
  }
  return (await db.query(query,[JSON.stringify(scopes)])).rows;
}
