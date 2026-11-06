# Reading Share JSON and progress recovery — 2026-11-06

The stopping-rule recognizer accepts plain JSON and JSON enclosed in a Markdown
code fence, matching the existing completion recognizer. Malformed/empty replies
remain failures (`SHARE_RESULT_INVALID`); evidence, confidence and candidate checks
are unchanged. A negative reply remains rejected and does not unlock Reading.

Before a Reading draft/attempt exists, practice progress now says Reading has not
started and includes the teacher-link anchor required by the native Docs writer.
This prevents `DOC_LINK_INVALID` for both accepted and rejected Share progress.

## Recovery contract

- Do not blindly requeue an unknown AI outcome or clear analysis intent. Recover
  only from saved replies whose original request, transcript fingerprint, policy,
  class, owner, assignment, version, practice and request IDs have been verified.
- Replay the original replies offline through the production validators. A rejected
  outcome must remain rejected; never infer completion from message count.
- Back up the current row and use a transaction with compare-and-swap checks against
  the unchanged quarantined request. Seed its validated `analysis_response` while
  retaining `analysis_intent`, then let the normal worker finish. This avoids AI
  duplication and preserves the native progress event/Docs sequence.
- If an existing progress job was blocked because its teacher anchor was absent,
  recompute its payload using native `previewStatus`, check the same binding,
  sequence, owner, version and target, and retry that exact job. Do not create an
  attempt, another progress event, or a synthetic accepted Share.
- Verify the actual Reading cell and hyperlink under the IZONE account, Classroom
  submission ownership, applied sequence, unchanged manual/other document content,
  student-facing status and closed gate. Metadata alone is not a Docs readback.

Production deployment used overlays on the exact live Reading Homework image,
preserving existing worker/session/owner-scope changes, environment, mounts and
ports. The final image is
`sha256:5c89d8f74a834daceee97fb0eee1f87dc0f14de74cd219148e3d3c33b14f690d`.
Private deployment backups and recovery receipts remain outside this public repo.
Rollback the named code overlay/container only; never restore an old whole student
database. Stop if the request or learner state has advanced since the backup.

## Evidence

- Same new parser regression failed on base with a fenced-JSON SyntaxError and
  passed on the fix. Plain/fenced positive and negative replies, invalid evidence,
  and malformed JSON are covered.
- The native Docs regression failed on base with a blocked job and passed on the
  fix for both accepted/rejected practice before Reading starts.
- Stored rejected-response recovery is tested with zero external calls, one native
  progress event, preserved snapshot, owner isolation and a closed Reading gate.
- Final backend suite: 568 passed, 31 source-dependent skips, zero failures (599
  tests). Parser canaries ran without a network or production database.
- One explicitly authorized production recovery reused two stored replies, made no
  AI calls, preserved all 47 messages, created no Reading draft/attempt and verified
  the original Docs job at sequence 1. Native public status and gate were checked;
  this was not a browser session impersonating the student.
