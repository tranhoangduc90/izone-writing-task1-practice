"""Bounded concurrent consumer of the independent Shops production queue."""
import concurrent.futures,datetime,json,os,pathlib,signal,time,urllib.request
STOP=False
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
def stop(*_):
 global STOP
 STOP=True
def request(url,body=None,headers=None,timeout=20):
 q=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**(headers or {})})
 with urllib.request.urlopen(q,timeout=timeout) as r:
  raw=r.read(1024*1024);return r.status,json.loads(raw) if raw.strip() else None
def main():
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 c=json.loads(pathlib.Path(os.environ['SW_PREVIEW_WORKER_CONFIG']).read_text())
 assert c['workflowId']=='o1loAzKOWq3OIJbC'
 assert c['statusUrl']=='http://127.0.0.1:18935/api/v1/sw/status'
 assert c['recoverUrl']=='http://127.0.0.1:18935/api/v1/internal/grading-jobs/recover'
 assert c['webhookUrl']=='http://127.0.0.1:5678/webhook/sw_task2_preview_worker'
 directory=pathlib.Path(os.environ.get('STATE_DIRECTORY','/var/lib/sw-task2-preview-worker'));directory.mkdir(exist_ok=True)
 state={'workflowId':c['workflowId'],'startedAt':now(),'dispatches':0,'failures':0,'recoverCalls':0,'maxConcurrent':2}
 def record(outcome,**extra):
  state.update(at=now(),outcome=outcome,**extra)
  if outcome!='unknown':state.pop('errorType',None)
  temp=directory/'heartbeat.tmp';temp.write_text(json.dumps(state)+'\n');temp.replace(directory/'heartbeat.json')
 def dispatch():return request(c['webhookUrl'],{'source':'sw-task2-preview-worker','version':1},{'X-Shops-Worker-Key':c['headerKey']},1250)
 executor=concurrent.futures.ThreadPoolExecutor(max_workers=2);pending=set();last_recover=0
 try:
  while not STOP:
   delay=5
   try:
    _,status=request(c['statusUrl'])
    assert status.get('environment')=='isolated-preview' and status.get('database')=='sw_task2_preview_20261025','WRONG_SHOPS_TARGET'
    queued=status.get('queued');assert type(queued) is int and queued>=0
    for future in list(pending):
     if not future.done():continue
     pending.remove(future)
     try:future.result()
     except Exception:state['failures']+=1
    if time.monotonic()-last_recover>=30:
     request(c['recoverUrl'],{}, {'Authorization':'Bearer '+c['apiToken']});last_recover=time.monotonic();state['recoverCalls']+=1
    for _ in range(min(queued,2-len(pending))):
     pending.add(executor.submit(dispatch));state['dispatches']+=1
    record('working' if pending else 'idle',queued=queued,active=len(pending))
   except Exception as error:
    state['failures']+=1;record('unknown',active=len(pending),errorType=type(error).__name__);delay=30
   deadline=time.monotonic()+delay
   while not STOP and time.monotonic()<deadline:time.sleep(min(1,max(0,deadline-time.monotonic())))
 finally:
  executor.shutdown(wait=False,cancel_futures=True);record('stopped',active=len(pending))
if __name__=='__main__':main()
