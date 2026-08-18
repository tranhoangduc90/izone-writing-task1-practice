import { appendInlineMarkdown } from "./markdown.js?v=20260818-numbering-v3";

export function manifestVocabularyRows(value) {
  const raw = Array.isArray(value) ? value : [
    ...(value?.overview?.naming || []),
    ...(value?.overview?.insights || []),
    ...(value?.routes || []).flatMap((route) => [...(route.naming || []), ...(route.story || [])]),
  ];
  return raw.map((entry) => ({
    vi: entry?.vi || entry?.meaning || entry?.note || entry?.idea || entry?.label || "",
    en: entry?.en || entry?.term || entry?.title || entry?.example || entry?.terms || entry?.english || "",
  })).filter((entry) => entry.vi || entry.en);
}

export function createVocabularySection(documentRef, rows, {
  title = "Từ vựng hỗ trợ",
  headingTag = "h3",
  className = "",
  scrollHint = "",
} = {}) {
  if (!rows.length) return null;
  const section = documentRef.createElement("section");
  section.className = ["lesson-vocabulary", className].filter(Boolean).join(" ");
  const heading = documentRef.createElement(headingTag); heading.textContent = title;
  const wrapper = documentRef.createElement("div"); wrapper.className = "table-scroll";
  if (scrollHint) {
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", `${title} — cuộn để xem thêm`);
  }
  const table = documentRef.createElement("table"); table.className = "vocab-table";
  const thead = documentRef.createElement("thead"); const headRow = documentRef.createElement("tr");
  for (const label of ["Ý tiếng Việt", "Từ, cụm từ tiếng Anh"]) {
    const cell = documentRef.createElement("th"); cell.scope = "col"; cell.textContent = label; headRow.append(cell);
  }
  thead.append(headRow);
  const tbody = documentRef.createElement("tbody");
  for (const row of rows) {
    const tr = documentRef.createElement("tr"); const vi = documentRef.createElement("td"); const en = documentRef.createElement("td");
    appendInlineMarkdown(vi, row.vi); appendInlineMarkdown(en, row.en); tr.append(vi, en); tbody.append(tr);
  }
  table.append(thead, tbody); wrapper.append(table); section.append(heading, wrapper);
  if (scrollHint) {
    const hint = documentRef.createElement("p");
    hint.className = "vocabulary-scroll-hint";
    hint.textContent = scrollHint;
    section.append(hint);
  }
  return section;
}
