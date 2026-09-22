import { ApiError } from './service.js';
import { seal } from './writing-flow-crypto.js';

// Dữ liệu nhận vào: kết quả có cấu trúc từ bộ chấm Term Test đang dùng cho khóa 67.
// Việc chính: kiểm đúng bốn tiêu chí và đúng 9/10 khía cạnh, rồi tự tính lại điểm.
// Kết quả: backend chỉ lưu kết quả đầy đủ, không tin điểm tổng do AI tự cộng.
// Khi lỗi: toàn bộ transaction bị hủy; bài được retry hoặc đưa vào Cần kiểm tra.
export const TEST_TASK_DEFINITIONS = Object.freeze({
  1: Object.freeze({
    criteria: Object.freeze({
      TA: Object.freeze(['ta_key_features_overview', 'ta_data_support']),
      CC: Object.freeze(['cc_organization', 'cc_cohesive_devices', 'cc_referencing']),
      LR: Object.freeze(['lr_range', 'lr_word_choice', 'lr_word_formation_spelling']),
      GRA: Object.freeze(['gra_detail']),
    }),
    componentCount: 9,
  }),
  2: Object.freeze({
    criteria: Object.freeze({
      TR: Object.freeze(['tr_task_coverage', 'tr_position', 'tr_idea_development']),
      CC: Object.freeze(['cc_organization', 'cc_cohesive_devices', 'cc_referencing']),
      LR: Object.freeze(['lr_range', 'lr_word_choice', 'lr_word_formation_spelling']),
      GRA: Object.freeze(['gra_detail']),
    }),
    componentCount: 10,
  }),
});

function band(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 9
    || Math.round(parsed * 2) !== parsed * 2) {
    throw new ApiError(400, 'TEST_RESULT_BAND_INVALID', `${field} phải từ 0 đến 9 theo bước 0,5.`);
  }
  return parsed;
}

function text(value, maximum = 180_000) {
  return String(value ?? '').replace(/\u0000/gu, '').slice(0, maximum);
}

export function calculateTestTaskScore(criteria) {
  const average = criteria.reduce((sum, item) => sum + band(item.bandScore, item.code), 0) / 4;
  return Math.floor((average * 2) + 1e-9) / 2;
}

export function calculateTestWritingScore(task1Score, task2Score) {
  const task1 = band(task1Score, 'Task 1');
  const task2 = band(task2Score, 'Task 2');
  return Math.ceil((((task1 + (2 * task2)) / 3) * 2) - 1e-9) / 2;
}

export function normalizeWritingTestResult(taskNumber, input) {
  const definition = TEST_TASK_DEFINITIONS[Number(taskNumber)];
  if (!definition) throw new ApiError(400, 'TEST_TASK_INVALID', 'Task Writing không hợp lệ.');
  const source = input?.testResult || input?.result || input;
  const sourceCriteria = Array.isArray(source?.criteria) ? source.criteria : [];
  const expectedCodes = Object.keys(definition.criteria);
  const sourceCodes = sourceCriteria.map(item => String(item?.code || '').trim().toUpperCase());
  if (sourceCriteria.length !== 4 || new Set(sourceCodes).size !== 4
    || expectedCodes.some(code => !sourceCodes.includes(code))) {
    throw new ApiError(400, 'TEST_RESULT_CRITERIA_INCOMPLETE',
      `Task ${taskNumber} chưa đủ đúng bốn tiêu chí.`);
  }
  const criteria = expectedCodes.map(code => {
    const criterion = sourceCriteria.find(item => String(item?.code || '').trim().toUpperCase() === code);
    const components = Array.isArray(criterion?.components) ? criterion.components : [];
    const expectedComponents = definition.criteria[code];
    const componentCodes = components.map(item => String(item?.code || '').trim());
    if (components.length !== expectedComponents.length
      || new Set(componentCodes).size !== expectedComponents.length
      || expectedComponents.some(componentCode => !componentCodes.includes(componentCode))) {
      throw new ApiError(400, 'TEST_RESULT_COMPONENTS_INCOMPLETE',
        `Tiêu chí ${code} của Task ${taskNumber} chưa đủ đúng khía cạnh.`);
    }
    return {
      code,
      name: text(criterion?.name || code, 200).trim(),
      bandScore: band(criterion?.bandScore, code),
      feedback: text(criterion?.feedback, 120_000),
      components: expectedComponents.map(componentCode => {
        const component = components.find(item => String(item?.code || '').trim() === componentCode);
        return {
          code: componentCode,
          label: text(component?.label || componentCode, 200).trim(),
          summary: text(component?.summary, 30_000),
          feedback: text(component?.feedback, 80_000),
        };
      }),
    };
  });
  const componentCount = criteria.reduce((sum, item) => sum + item.components.length, 0);
  if (componentCount !== definition.componentCount) {
    throw new ApiError(400, 'TEST_RESULT_COMPONENT_COUNT_INVALID',
      `Task ${taskNumber} phải có đúng ${definition.componentCount} khía cạnh.`);
  }
  const taskScore = calculateTestTaskScore(criteria);
  if (source?.taskScore !== undefined && source?.taskScore !== null
    && Math.abs(band(source.taskScore, `Task ${taskNumber}`) - taskScore) > 0.001) {
    throw new ApiError(400, 'TEST_RESULT_SCORE_MISMATCH',
      `Điểm Task ${taskNumber} không khớp bốn tiêu chí.`);
  }
  return { taskNumber: Number(taskNumber), taskScore, criteria,
    report: text(source?.report, 180_000), componentCount };
}

export async function storeWritingTestMainResult(client, {
  pairId, taskNumber, result, encryptionKey,
}) {
  const normalized = normalizeWritingTestResult(taskNumber, result);
  for (const criterion of normalized.criteria) {
    await client.query(`INSERT INTO writing_flow.test_criterion_result
      (pair_id,criterion_code,band_score,name,feedback_ciphertext,completed_at)
      VALUES ($1,$2,$3,$4,$5,now())
      ON CONFLICT (pair_id,criterion_code) DO UPDATE SET
        band_score=EXCLUDED.band_score,name=EXCLUDED.name,
        feedback_ciphertext=EXCLUDED.feedback_ciphertext,completed_at=now()`,
    [pairId, criterion.code, criterion.bandScore,
      criterion.name, seal(criterion.feedback, encryptionKey)]);
    for (const component of criterion.components) {
      await client.query(`INSERT INTO writing_flow.test_component_result
        (pair_id,criterion_code,component_code,label,summary_ciphertext,
         feedback_ciphertext,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT (pair_id,component_code) DO UPDATE SET
          criterion_code=EXCLUDED.criterion_code,label=EXCLUDED.label,
          summary_ciphertext=EXCLUDED.summary_ciphertext,
          feedback_ciphertext=EXCLUDED.feedback_ciphertext,completed_at=now()`,
      [pairId, criterion.code, component.code,
        component.label, seal(component.summary, encryptionKey), seal(component.feedback, encryptionKey)]);
    }
  }
  await client.query(`UPDATE writing_flow.test_pair
    SET status='graded',task_score=$2,component_count=$3,graded_at=now(),updated_at=now()
    WHERE pair_id=$1`, [pairId, normalized.taskScore, normalized.componentCount]);
  const group = await client.query(`SELECT group_row.test_group_id,group_row.topology,
      task_row.task_number,task_row.task_score,task_row.status
    FROM writing_flow.test_pair AS current
    JOIN writing_flow.test_group AS group_row ON group_row.test_group_id=current.test_group_id
    JOIN writing_flow.test_pair AS task_row ON task_row.test_group_id=group_row.test_group_id
    WHERE current.pair_id=$1 ORDER BY task_row.task_number`, [pairId]);
  if (!group.rowCount) throw new ApiError(409, 'TEST_PAIR_LINK_MISSING', 'Bài Test chưa được ghép đúng nhóm.');
  const topology = group.rows[0].topology;
  const task1 = group.rows.find(row => Number(row.task_number) === 1 && row.status === 'graded');
  const task2 = group.rows.find(row => Number(row.task_number) === 2 && row.status === 'graded');
  const ready = topology === 'task_2_only' ? Boolean(task2) : Boolean(task1 && task2);
  const writingScore = ready
    ? topology === 'task_2_only' ? Number(task2.task_score)
      : calculateTestWritingScore(task1.task_score, task2.task_score)
    : null;
  await client.query(`INSERT INTO writing_flow.test_final
    (test_group_id,task_1_score,task_2_score,writing_score,status,ready_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,CASE WHEN $5='ready' THEN now() ELSE NULL END,now())
    ON CONFLICT (test_group_id) DO UPDATE SET task_1_score=EXCLUDED.task_1_score,
      task_2_score=EXCLUDED.task_2_score,writing_score=EXCLUDED.writing_score,
      status=EXCLUDED.status,ready_at=CASE WHEN EXCLUDED.status='ready'
        THEN coalesce(writing_flow.test_final.ready_at,now()) ELSE NULL END,updated_at=now()`,
  [group.rows[0].test_group_id, task1?.task_score ?? null, task2?.task_score ?? null,
    writingScore, ready ? 'ready' : 'waiting']);
  await client.query(`UPDATE writing_flow.test_group SET status=$2,updated_at=now()
    WHERE test_group_id=$1`, [group.rows[0].test_group_id, ready ? 'running' : 'pending']);
  return { ...normalized, writingScore, wholeTestReady: ready };
}

export async function storeWritingTestDelivery(client, { pairId, result }) {
  await client.query(`INSERT INTO writing_flow.test_delivery
    (pair_id,destination,status,result_url,readback_ok,completed_at,updated_at)
    VALUES ($1,'google_docs','complete',$2,true,now(),now())
    ON CONFLICT (pair_id,destination) DO UPDATE SET status='complete',
      result_url=EXCLUDED.result_url,readback_ok=true,completed_at=now(),updated_at=now()`,
  [pairId, result.resultUrl]);
  await client.query(`UPDATE writing_flow.test_pair SET status='delivered',delivered_at=now(),updated_at=now()
    WHERE pair_id=$1`, [pairId]);
  const group = await client.query(`SELECT current.test_group_id,
      bool_and(all_tasks.status='delivered') AS all_delivered
    FROM writing_flow.test_pair AS current
    JOIN writing_flow.test_pair AS all_tasks ON all_tasks.test_group_id=current.test_group_id
    WHERE current.pair_id=$1 GROUP BY current.test_group_id`, [pairId]);
  if (group.rows[0]?.all_delivered) {
    await client.query(`UPDATE writing_flow.test_group
      SET status='complete',completed_at=now(),updated_at=now() WHERE test_group_id=$1`,
    [group.rows[0].test_group_id]);
  }
}
