import { hasMeaningfulText } from "./core.js";

export function sectionDefinitions(manifest = {}) {
  return Array.isArray(manifest.sections) ? manifest.sections : [];
}

export function fieldDefinitions(manifest = {}) {
  return sectionDefinitions(manifest).flatMap((section) => section.fields || []);
}

export function blankLessonProgress(manifest = {}) {
  const responses = Object.fromEntries(fieldDefinitions(manifest).map((field) => [field.key, ""]));
  const sections = Object.fromEntries(sectionDefinitions(manifest).map((section) => [section.key, {
    status: "draft",
    attemptsWithoutPass: 0,
  }]));
  return { revision: 0, responses, sections, comments: [], attempts: [], updatedAt: null };
}

export function normalizeLessonProgress(value = {}, manifest = {}) {
  const blank = blankLessonProgress(manifest);
  const sourceSections = Array.isArray(value.sections)
    ? Object.fromEntries(value.sections.map((item) => [item.section, item]))
    : value.sections || {};
  for (const section of sectionDefinitions(manifest)) {
    const source = sourceSections[section.key] || {};
    blank.sections[section.key] = {
      status: ["draft", "queued", "revision", "passed"].includes(source.status) ? source.status : "draft",
      attemptsWithoutPass: Number.isInteger(source.attemptsWithoutPass) ? source.attemptsWithoutPass : Number(source.failStreak || 0),
    };
  }
  const responses = value.responses || value.responseData || {};
  for (const field of fieldDefinitions(manifest)) {
    blank.responses[field.key] = typeof responses[field.key] === "string" ? responses[field.key] : "";
  }
  blank.revision = value.draftVersion ?? value.version ?? value.revision ?? 0;
  blank.comments = Array.isArray(value.comments) ? value.comments : [];
  blank.attempts = Array.isArray(value.attempts) ? value.attempts : [];
  blank.updatedAt = value.updatedAt || value.updated_at || null;
  return blank;
}

export function sectionIsFilled(section, responses = {}) {
  const required = Array.isArray(section.requiredFields) && section.requiredFields.length
    ? section.requiredFields
    : (section.fields || []).map((field) => field.key);
  const filled = required.map((key) => hasMeaningfulText(responses[key]));
  return section.validationMode === "any" ? filled.some(Boolean) : filled.length > 0 && filled.every(Boolean);
}

export function responsesForSection(section, responses = {}) {
  return Object.fromEntries((section.fields || []).map((field) => [field.key, responses[field.key] || ""]));
}

export function fieldLabelMap(manifest = {}) {
  return Object.fromEntries(fieldDefinitions(manifest).map((field) => [field.key, field.label]));
}
