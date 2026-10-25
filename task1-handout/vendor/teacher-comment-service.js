import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';

const task1Fields = {
  overview: new Set(['overview']),
  outline: new Set(['body1', 'body2']),
  draft: new Set(['draft1', 'draft2'])
};

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stringArray = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

function matchingSuffix(left, right) {
  let count = 0;
  while (count < left.length && count < right.length
    && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function matchingPrefix(left, right) {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

// Dữ liệu nhận vào: nội dung hiện tại và tọa độ/đoạn chữ lúc giảng viên tạo comment.
// Việc chính: giữ tọa độ cũ nếu còn đúng; nếu học viên sửa trước đoạn đó thì tìm lại bằng quote và ngữ cảnh.
// Kết quả: trả vị trí highlight hiện tại hoặc detached=true nhưng vẫn giữ nguyên thread.
// Khi không còn tìm thấy đoạn chữ: comment không mất, chỉ chuyển thành “đoạn gốc đã thay đổi”.
export function relocateTeacherCommentAnchor(text, anchor) {
  const source = String(text ?? '');
  const quote = String(anchor?.quote ?? '');
  const originalStart = Number(anchor?.start ?? 0);
  const originalEnd = Number(anchor?.end ?? originalStart + quote.length);
  if (quote && source.slice(originalStart, originalEnd) === quote) {
    return { start: originalStart, end: originalEnd, quote, detached: false };
  }
  if (!quote) return { start: null, end: null, quote, detached: true };
  const candidates = [];
  let index = source.indexOf(quote);
  while (index >= 0) {
    const before = source.slice(Math.max(0, index - 120), index);
    const after = source.slice(index + quote.length, index + quote.length + 120);
    const score = matchingSuffix(String(anchor?.prefix ?? ''), before) * 4
      + matchingPrefix(String(anchor?.suffix ?? ''), after) * 4
      - Math.min(Math.abs(index - originalStart), 10_000) / 10_000;
    candidates.push({ start: index, end: index + quote.length, quote, detached: false, score });
    index = source.indexOf(quote, index + 1);
  }
  if (!candidates.length) return { start: null, end: null, quote, detached: true };
  candidates.sort((left, right) => right.score - left.score || left.start - right.start);
  const { start, end, detached } = candidates[0];
  return { start, end, quote, detached };
}

function publicMessage(row) {
  return {
    messageRef: row.messageRef,
    authorRole: row.authorRole,
    authorLabel: row.authorRole === 'teacher' ? 'Giảng viên' : 'Học viên',
    body: row.body,
    createdAt: row.messageCreatedAt
  };
}

function fieldText(session, fieldKey) {
  const responses = session.responseData && typeof session.responseData === 'object' ? session.responseData : {};
  if (Object.hasOwn(responses, fieldKey)) return typeof responses[fieldKey] === 'string' ? responses[fieldKey] : '';
  return typeof session[fieldKey] === 'string' ? session[fieldKey] : '';
}

export function createTeacherCommentService({ pool }) {
  async function sessionContext(sessionRef, client = pool, lock = '') {
    const result = await client.query(`SELECT session.id,session.public_id AS "sessionRef",session.activity_id AS "activityId",
      session.student_public_id AS "studentRef",session.draft_version AS "draftVersion",
      session.overview,session.body1,session.body2,session.draft1,session.draft2,
      COALESCE(session.response_data,'{}'::jsonb) AS "responseData"
      FROM writing_practice.activity_session session WHERE session.public_id=$1 ${lock}`, [sessionRef]);
    if (!result.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
    return result.rows[0];
  }

  async function assertField(session, sectionKey, fieldKey, client = pool) {
    const configured = await client.query(`SELECT input_fields FROM writing_practice.activity_section_definition
      WHERE activity_id=$1 AND section_key=$2`, [session.activityId, sectionKey]);
    const allowed = configured.rowCount
      ? new Set(stringArray(configured.rows[0].input_fields))
      : task1Fields[sectionKey];
    if (!allowed?.has(fieldKey)) throw new ApiError(400, 'COMMENT_FIELD_NOT_ALLOWED', 'Không thể comment vào ô này.');
  }

  async function list({ sessionRef }, client = pool) {
    const session = await sessionContext(sessionRef, client);
    const result = await client.query(`SELECT thread.id AS "threadId",thread.public_id AS "threadRef",
      thread.section_key AS "sectionKey",thread.field_key AS "fieldKey",thread.anchor_start AS "anchorStart",
      thread.anchor_end AS "anchorEnd",thread.anchor_quote AS "anchorQuote",thread.anchor_prefix AS "anchorPrefix",
      thread.anchor_suffix AS "anchorSuffix",thread.anchor_revision AS "anchorRevision",thread.status,
      thread.created_at AS "createdAt",thread.updated_at AS "updatedAt",
      message.public_id AS "messageRef",message.author_role AS "authorRole",message.body,
      message.created_at AS "messageCreatedAt"
      FROM writing_practice.teacher_comment_thread thread
      JOIN writing_practice.teacher_comment_message message ON message.thread_id=thread.id
      WHERE thread.session_id=$1 ORDER BY thread.created_at,message.created_at,message.id`, [session.id]);
    const grouped = new Map();
    for (const row of result.rows) {
      if (!grouped.has(row.threadRef)) {
        const anchor = relocateTeacherCommentAnchor(fieldText(session, row.fieldKey), {
          start: row.anchorStart,
          end: row.anchorEnd,
          quote: row.anchorQuote,
          prefix: row.anchorPrefix,
          suffix: row.anchorSuffix
        });
        grouped.set(row.threadRef, {
          threadRef: row.threadRef,
          sectionKey: row.sectionKey,
          fieldKey: row.fieldKey,
          status: row.status,
          anchor: { ...anchor, originalStart: row.anchorStart, originalEnd: row.anchorEnd },
          anchorRevision: row.anchorRevision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          messages: []
        });
      }
      grouped.get(row.threadRef).messages.push(publicMessage(row));
    }
    const threads = [...grouped.values()];
    return { threads, version: hash(threads).slice(0, 24) };
  }

  async function one(threadRef, client = pool) {
    const result = await client.query(`SELECT session.public_id AS "sessionRef" FROM writing_practice.teacher_comment_thread thread
      JOIN writing_practice.activity_session session ON session.id=thread.session_id WHERE thread.public_id=$1`, [threadRef]);
    if (!result.rowCount) throw new ApiError(404, 'TEACHER_COMMENT_NOT_FOUND', 'Không tìm thấy comment giảng viên.');
    const all = await list({ sessionRef: result.rows[0].sessionRef }, client);
    const thread = all.threads.find(item => item.threadRef === threadRef);
    if (!thread) throw new ApiError(404, 'TEACHER_COMMENT_NOT_FOUND', 'Không tìm thấy comment giảng viên.');
    return thread;
  }

  async function create({ sessionRef, sectionKey, fieldKey, start, end, baseVersion, body, requestId, actorRef }) {
    const requestHash = hash({ sessionRef, sectionKey, fieldKey, start, end, baseVersion, body });
    return withTransaction(pool, async client => {
      const prior = await client.query(`SELECT public_id AS "threadRef",request_hash AS "requestHash"
        FROM writing_practice.teacher_comment_thread WHERE request_id=$1`, [requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].requestHash !== requestHash) throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã comment đã được dùng cho nội dung khác.');
        return one(prior.rows[0].threadRef, client);
      }
      const session = await sessionContext(sessionRef, client, 'FOR SHARE');
      await assertField(session, sectionKey, fieldKey, client);
      if (session.draftVersion !== baseVersion) throw new ApiError(409, 'COMMENT_ANCHOR_STALE', 'Bài làm vừa thay đổi. Hãy bôi lại đoạn cần comment.');
      const text = fieldText(session, fieldKey);
      if (start < 0 || end <= start || end > text.length || end - start > 2000) {
        throw new ApiError(400, 'INVALID_COMMENT_ANCHOR', 'Đoạn được chọn không hợp lệ.');
      }
      const quote = text.slice(start, end);
      if (!quote.trim()) throw new ApiError(400, 'EMPTY_COMMENT_ANCHOR', 'Hãy bôi một đoạn có nội dung.');
      const inserted = await client.query(`INSERT INTO writing_practice.teacher_comment_thread(
        session_id,section_key,field_key,anchor_start,anchor_end,anchor_quote,anchor_prefix,anchor_suffix,
        anchor_revision,created_by,request_id,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,public_id AS "threadRef"`,
      [session.id, sectionKey, fieldKey, start, end, quote, text.slice(Math.max(0, start - 120), start),
        text.slice(end, end + 120), baseVersion, actorRef, requestId, requestHash]);
      await client.query(`INSERT INTO writing_practice.teacher_comment_message(
        thread_id,author_role,author_ref,body,request_id,request_hash) VALUES($1,'teacher',$2,$3,$4,$5)`,
      [inserted.rows[0].id, actorRef, body, requestId, hash({ threadRef: inserted.rows[0].threadRef, body, role: 'teacher' })]);
      return one(inserted.rows[0].threadRef, client);
    });
  }

  async function reply({ threadRef, sessionRef = null, body, requestId, actorRole, actorRef }) {
    const requestHash = hash({ threadRef, sessionRef, body, actorRole });
    return withTransaction(pool, async client => {
      const prior = await client.query(`SELECT thread.public_id AS "threadRef",message.request_hash AS "requestHash"
        FROM writing_practice.teacher_comment_message message
        JOIN writing_practice.teacher_comment_thread thread ON thread.id=message.thread_id
        WHERE message.request_id=$1`, [requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].requestHash !== requestHash) throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã trả lời đã được dùng cho nội dung khác.');
        return one(prior.rows[0].threadRef, client);
      }
      const thread = await client.query(`SELECT thread.id,session.public_id AS "sessionRef",session.student_public_id AS "studentRef"
        FROM writing_practice.teacher_comment_thread thread
        JOIN writing_practice.activity_session session ON session.id=thread.session_id
        WHERE thread.public_id=$1 FOR SHARE OF thread,session`, [threadRef]);
      if (!thread.rowCount) throw new ApiError(404, 'TEACHER_COMMENT_NOT_FOUND', 'Không tìm thấy comment giảng viên.');
      if (sessionRef && thread.rows[0].sessionRef !== sessionRef) throw new ApiError(404, 'TEACHER_COMMENT_NOT_FOUND', 'Không tìm thấy comment giảng viên.');
      const safeActorRef = actorRole === 'student' ? String(thread.rows[0].studentRef) : actorRef;
      await client.query(`INSERT INTO writing_practice.teacher_comment_message(
        thread_id,author_role,author_ref,body,request_id,request_hash) VALUES($1,$2,$3,$4,$5,$6)`,
      [thread.rows[0].id, actorRole, safeActorRef, body, requestId, requestHash]);
      await client.query(`UPDATE writing_practice.teacher_comment_thread SET updated_at=now() WHERE id=$1`, [thread.rows[0].id]);
      return one(threadRef, client);
    });
  }

  async function setStatus({ threadRef, status, requestId, actorRef }) {
    const requestHash = hash({ threadRef, status });
    return withTransaction(pool, async client => {
      const prior = await client.query(`SELECT thread.public_id AS "threadRef",event.request_hash AS "requestHash" FROM writing_practice.teacher_comment_status_event event
        JOIN writing_practice.teacher_comment_thread thread ON thread.id=event.thread_id WHERE event.request_id=$1`, [requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].requestHash !== requestHash) throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã đổi trạng thái đã được dùng cho thao tác khác.');
        return one(prior.rows[0].threadRef, client);
      }
      const thread = await client.query(`SELECT id FROM writing_practice.teacher_comment_thread WHERE public_id=$1 FOR UPDATE`, [threadRef]);
      if (!thread.rowCount) throw new ApiError(404, 'TEACHER_COMMENT_NOT_FOUND', 'Không tìm thấy comment giảng viên.');
      await client.query(`UPDATE writing_practice.teacher_comment_thread SET status=$2,
        addressed_at=CASE WHEN $2='addressed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`, [thread.rows[0].id, status]);
      await client.query(`INSERT INTO writing_practice.teacher_comment_status_event(thread_id,status,actor_ref,request_id,request_hash)
        VALUES($1,$2,$3,$4,$5)`, [thread.rows[0].id, status, actorRef, requestId, requestHash]);
      return one(threadRef, client);
    });
  }

  return { list, create, reply, setStatus };
}
