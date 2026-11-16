import type { BookFile } from "./model";

type Bytes = { data: ArrayBuffer; type: string };
export type StoredBookBytes = Omit<BookFile, "source" | "derived"> & {
  encoding: "array-buffer-v1";
  source: Bytes;
  derived?: Bytes;
};

export async function encodeBookFile(file: BookFile): Promise<StoredBookBytes> {
  const bytes = async (blob: Blob): Promise<Bytes> => ({ data: await blob.arrayBuffer(), type: blob.type });
  const [source, derived] = await Promise.all([bytes(file.source), file.derived ? bytes(file.derived) : undefined]);
  return { id: file.id, uploaded: file.uploaded, encoding: "array-buffer-v1", source, derived };
}

export function decodeBookFile(file: BookFile | StoredBookBytes): BookFile;
export function decodeBookFile(file: BookFile | StoredBookBytes | undefined): BookFile | undefined;
export function decodeBookFile(file: BookFile | StoredBookBytes | undefined): BookFile | undefined {
  if (!file || !("encoding" in file)) return file;
  const blob = (value: Bytes) => new Blob([value.data], { type: value.type });
  return { id: file.id, uploaded: file.uploaded, source: blob(file.source), derived: file.derived ? blob(file.derived) : undefined };
}

export function isBlobStorageError(error: unknown) {
  return error instanceof Error && /preparing.*blob|blob\/file/i.test(error.message);
}
