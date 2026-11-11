import type { Annotation, Locator } from "./model";
const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const object = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export function validLocator(value: unknown): value is Locator {
  if (
    !object(value) ||
    value.v !== 1 ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash)
  )
    return false;
  if (
    value.quote !== undefined &&
    (!object(value.quote) ||
      !["exact", "prefix", "suffix"].every(
        (k) => typeof value.quote[k] === "string",
      ))
  )
    return false;
  if (value.type === "epub")
    return (
      typeof value.cfi === "string" &&
      value.cfi.startsWith("epubcfi(") &&
      typeof value.href === "string"
    );
  if (value.type === "docx")
    return (
      Number.isInteger(value.start) &&
      value.start >= 0 &&
      Number.isInteger(value.end) &&
      value.end >= value.start
    );
  if (value.type === "pdf")
    return (
      Number.isInteger(value.page) &&
      value.page > 0 &&
      finite(value.y) &&
      value.y >= 0 &&
      value.y <= 1 &&
      (value.point === undefined ||
        (Array.isArray(value.point) &&
          value.point.length === 2 &&
          value.point.every(finite))) &&
      (value.regions === undefined ||
        (Array.isArray(value.regions) &&
          value.regions.every(
            (r: unknown) =>
              object(r) &&
              Number.isInteger(r.page) &&
              r.page > 0 &&
              Array.isArray(r.rects) &&
              r.rects.every(
                (a: unknown) =>
                  Array.isArray(a) && a.length === 4 && a.every(finite),
              ),
          )))
    );
  return false;
}
export function validAnnotation(a: unknown): a is Annotation {
  return (
    object(a) &&
    typeof a.id === "string" &&
    !!a.id &&
    typeof a.bookId === "string" &&
    typeof a.text === "string" &&
    typeof a.note === "string" &&
    Array.isArray(a.tags) &&
    a.tags.every((t: unknown) => typeof t === "string") &&
    ["yellow", "green", "blue", "pink", "purple"].includes(a.color) &&
    typeof a.createdAt === "string" &&
    Number.isFinite(Date.parse(a.createdAt)) &&
    validLocator(a.locator)
  );
}
