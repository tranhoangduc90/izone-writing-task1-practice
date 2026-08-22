export function classQuery(search = "") {
  return new URLSearchParams(search).get("class")?.trim() || "";
}

export function resolveClassRef(classes = [], requestedClass = "") {
  const requested = requestedClass.trim().toLocaleLowerCase("vi");
  if (!requested) return "";
  const match = classes.find((item) => [item.classRef, item.className]
    .some((value) => String(value || "").trim().toLocaleLowerCase("vi") === requested));
  return match?.classRef || "";
}
