export const SECTION_KEYS = ["overview", "outline", "draft"];
export const TEXT_KEYS = ["overview", "body1", "body2", "draft1", "draft2"];

export function createRequestId() {
  return globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function blankSections() {
  return Object.fromEntries(SECTION_KEYS.map((key) => [key, { text: "", status: "draft", attemptsWithoutPass: 0 }]));
}

export function normalizeProgress(value = {}) {
  const sections = blankSections();
  const sectionMap = Array.isArray(value.sections) ? Object.fromEntries(value.sections.map((item) => [item.section, item])) : value.sections;
  for (const key of SECTION_KEYS) {
    const source = sectionMap?.[key] || value.sectionStates?.[key] || {};
    sections[key] = {
      text: typeof source.text === "string" ? source.text : typeof source === "string" ? source : "",
      status: ["draft", "queued", "revision", "passed"].includes(source.status) ? source.status : "draft",
      attemptsWithoutPass: Number.isInteger(source.attemptsWithoutPass) ? source.attemptsWithoutPass : 0,
    };
  }
  return {
    revision: value.draftVersion ?? value.version ?? value.revision ?? null,
    texts: Object.fromEntries(TEXT_KEYS.map((key) => [key,
      typeof value.draft?.[key] === "string" ? value.draft[key]
        : typeof value.texts?.[key] === "string" ? value.texts[key]
          : typeof value[key] === "string" ? value[key] : ""
    ])),
    draft2Unlocked: Boolean(value.draft?.draft2Unlocked ?? value.draft2Unlocked ?? value.draft2_unlocked),
    sections,
    comments: Array.isArray(value.comments) ? value.comments : [],
    attempts: value.attempts || [],
  };
}

export function wordCount(text) { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
export function hasMeaningfulText(value) { return String(value || "").replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, "").length > 0; }
export function safeHttpUrl(value, base = globalThis.location?.href || "https://example.invalid/") {
  try { const url = new URL(String(value || ""), base); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function safeLmsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const safe = safeHttpUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.protocol === "https:"
    && url.hostname.toLowerCase() === "practice.izone.edu.vn"
    && url.pathname.startsWith("/shared/writing-essays/")
    ? url.href
    : null;
}
export function draftPrerequisitesPassed(sections = {}) { return sections.overview?.status === "passed" && sections.outline?.status === "passed"; }
export function canUnlockDraft2(texts = {}) { return hasMeaningfulText(texts.draft1); }
export function rebaseLocalProgress(local = {}, current = {}) {
  const server = normalizeProgress(current);
  return {
    ...server,
    updatedAt: current.updatedAt || current.updated_at || null,
    texts: { ...server.texts, ...(local.texts || {}) },
    draft2Unlocked: Boolean(local.draft2Unlocked),
  };
}
export function pollingDelay(elapsedSinceSubmitMs) {
  if (elapsedSinceSubmitMs <= 20000) return 2000;
  if (elapsedSinceSubmitMs <= 120000) return 5000;
  return 10000;
}
export function claimSectionSubmission(pendingSections, sectionKey) {
  if (pendingSections.has(sectionKey)) return false;
  pendingSections.add(sectionKey);
  return true;
}
export function sectionSubmitLabel(section, status, submitting = false) {
  if (submitting) return "Đang gửi bài…";
  if (status === "queued") return section === "draft"
    ? "Đang tạo kết quả — không cần bấm lại"
    : "Đang chấm — không cần bấm lại";
  if (status === "passed") return section === "draft" ? "Đã có kết quả LMS" : "Phần này đã đạt";
  return section === "draft" ? "Gửi chấm từng câu" : "Gửi để nhận xét";
}
export function isConflict(error) { return error?.status === 409 && error?.data?.error === "DRAFT_VERSION_CONFLICT"; }
export function terminalResult(attempt) {
  const outcome = attempt?.resultStatus || attempt?.status;
  if (attempt?.status === "failed") return true;
  return ["passed", "needs_revision"].includes(outcome) && (attempt?.status !== "completed" || Boolean(attempt?.resultStatus));
}
