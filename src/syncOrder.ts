import type { Row } from "./model";

export const editTime = (row?: Pick<Row, "editedAt" | "updatedAt">) =>
  Date.parse(row?.editedAt || row?.updatedAt || "") || 0;

// Match the server order: edit time, deletion on ties, then operation UUID.
export function compareEdits(a: Row, b: Row) {
  return editTime(a) - editTime(b) || Number(a.deleted) - Number(b.deleted) ||
    ((a.editId || "") > (b.editId || "") ? 1 : (a.editId || "") < (b.editId || "") ? -1 : 0);
}
