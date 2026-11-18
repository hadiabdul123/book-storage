import { db, get, list, save } from "./db";
import { now, uid } from "./model";

export const priorities = { important: "Important", lower: "Lower priority" } as const;
export type HighlightPriority = keyof typeof priorities;
export type HighlightStudy = { id: string; priority: HighlightPriority };
export type HighlightFollowup = { id: string; annotationId: string; text: string; createdAt: string };
export const followupLimit = 12000;

export function validHighlightStudy(value: unknown): value is HighlightStudy {
  const study = value as HighlightStudy | null;
  return !!study && typeof study.id === "string" && study.id.length > 0 && study.id.length <= 100 && Object.hasOwn(priorities, study.priority);
}

export function validHighlightFollowup(value: unknown): value is HighlightFollowup {
  const note = value as HighlightFollowup | null;
  return !!note && [note.id, note.annotationId].every(id => typeof id === "string" && id.length > 0 && id.length <= 100) &&
    typeof note.text === "string" && !!note.text.trim() && note.text.length <= followupLimit &&
    typeof note.createdAt === "string" && Number.isFinite(Date.parse(note.createdAt));
}

export async function highlightStudyData() {
  const [study, followups] = await Promise.all([list("highlight-study"), list("highlight-followup")]);
  return { study, followups };
}

async function withHighlight(id: string, action: () => Promise<void>) {
  await db.transaction("rw", [db.rows, db.outbox, db.conflicts, db.meta], async () => {
    const annotation = await get("annotation", id);
    if (!annotation || annotation.type === "page-note") throw new Error("This highlight is unavailable.");
    await action();
  });
}

export function setHighlightPriority(id: string, priority?: HighlightPriority) {
  return withHighlight(id, async () => {
    const current = await get("highlight-study", id);
    if (priority) await save("highlight-study", { id, priority });
    else if (current) await save("highlight-study", current, true);
  });
}

export function setHighlightTags(id: string, tags: string[]) {
  return withHighlight(id, async () => {
    const annotation = (await get("annotation", id))!;
    await save("annotation", { ...annotation, tags });
  });
}

export function saveFollowup(annotationId: string, text: string, id?: string, deleted = false) {
  return withHighlight(annotationId, async () => {
    const previous = id ? await get("highlight-followup", id) : undefined;
    if (id && previous?.annotationId !== annotationId) throw new Error("This follow-up note is unavailable.");
    const draft = { id: id ?? uid(), annotationId, text: text.trim(), createdAt: previous?.createdAt ?? now() };
    if (!validHighlightFollowup(draft)) throw new Error("Enter a follow-up note before saving.");
    await save("highlight-followup", draft, deleted);
  });
}
