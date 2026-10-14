import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createWritingFlowService} from '../src/writing-flow-service.js';

function stageScans(node,result=[]){
  if(node['Relation Name']==='stage_result'&&/^s(?:_\d+)?$/u.test(node.Alias||''))result.push(node);
  for(const child of node.Plans||[])stageScans(child,result);
  return result;
}
function historyAggregates(node,result=[]){
  if(node['Node Type'].includes('Aggregate')&&node.Output?.some(value=>value.includes('array_agg(peer')))
    result.push(node);
  for(const child of node.Plans||[])historyAggregates(child,result);
  return result;
}
test('listPairs giữ bước, fallback, phục hồi và cảnh báo; không tìm bước lặp cho từng bài',async t=>{
  const db=new PGlite();
  try{
    await db.exec(await readFile(new URL('./fixtures/writing-flow-pairs-latency.sql',import.meta.url),'utf8'));
    const originalSql=await readFile(new URL('./fixtures/writing-flow-pairs-original.sql',import.meta.url),'utf8');
    let captured;
    const pool={async query(sql,values){captured={sql,values};const result=await db.query(sql,values);
      return {...result,rowCount:result.rows.length};}};
    const service=createWritingFlowService({pool});
    const scenarios=[{sourceKind:'homework',stageKey:'main'},
      {sourceKind:'homework',stageKey:'main',offset:50},
      {sourceKind:'homework',stageKey:'precheck'},
      {sourceKind:'homework',stageKey:'intake'},
      {sourceKind:'test',stageKey:'main'},
      {sourceKind:'test',stageKey:'precheck'},
      {sourceKind:'test',stageKey:'deliver'},
      {sourceKind:'test',view:'review'},
      {sourceKind:'homework',view:'review'},
      {view:'review'},
      {sourceKind:'homework',view:'delivered'},
      {sourceKind:'homework',stageKey:'main',dateFrom:'2099-01-01'}];
    for(const args of scenarios){
      const rows=await service.listPairs({...args,limit:50});
      const {sql,values}=captured;
      assert.deepEqual((await db.query(sql,values)).rows,(await db.query(originalSql,values)).rows,
        'Toàn bộ hàng SQL phải giữ nguyên: '+JSON.stringify(args));
      if(args.stageKey==='intake')assert.deepEqual(rows.map(r=>r.pair_id),['44444444-4444-4444-8444-444444444444']);
      if(args.view==='review'&&args.sourceKind!=='homework')
        assert.equal(rows.some(r=>r.historical_review_code==='TEST_HISTORICAL_EVIDENCE_CONFLICT'),true);
      if(args.stageKey==='main'&&args.sourceKind==='homework'&&!args.dateFrom){
        assert.equal(rows.length,50);
        assert.equal(rows.every(r=>r.stage_key==='main'&&r.stage_status==='pending'),true);
      }
    }
    await t.test('bước hiện tại chỉ quét một lần trong fixture nhiều bài',async()=>{
      await service.listPairs({sourceKind:'homework',stageKey:'main',limit:50});
      const plan=(await db.query('EXPLAIN (ANALYZE, FORMAT JSON) '+captured.sql,captured.values))
        .rows[0]['QUERY PLAN'][0].Plan;
      const scans=stageScans(plan);
      assert.equal(scans.length>0,true);
      assert.equal(scans.every(n=>n['Actual Loops']<=1),true,
        'stage_result alias s Actual Loops: '+JSON.stringify(scans.map(n=>n['Actual Loops'])));
    });
    await t.test('Review gom peer một lần, giữ identity và SQL NULL như baseline',async()=>{
      const rows=await service.listPairs({sourceKind:'test',view:'review',limit:50});
      const first=rows.find(row=>row.pair_id==='11111111-1111-4111-8111-111111111111');
      assert.equal(first.historical_peer_pair_ids.includes('55555555-5555-4555-8555-555555555555'),true);
      assert.equal(first.historical_peer_pair_ids.includes('66666666-6666-4666-8666-666666666666'),false);
      assert.equal(first.historical_peer_pair_ids.includes('77777777-7777-4777-8777-777777777777'),false);
      assert.equal(first.historical_peer_pair_ids.includes('88888888-8888-4888-8888-888888888888'),true);
      assert.equal(first.historical_peer_pair_ids.includes('99999999-9999-4999-8999-999999999999'),false);
      const plan=(await db.query('EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) '+captured.sql,captured.values))
        .rows[0]['QUERY PLAN'][0].Plan;
      const aggregates=historyAggregates(plan);
      assert.equal(aggregates.length>0,true);
      assert.equal(aggregates.every(n=>n['Actual Loops']<=1),true,
        'historical peer Aggregate Actual Loops: '+JSON.stringify(aggregates.map(n=>n['Actual Loops'])));
    });
  }finally{await db.close();}
});
