import type { BookFile } from "./model";

type Bytes = { data: ArrayBuffer; type: string };
export type StoredBookBytes = Omit<BookFile, "source" | "derived" | "preparedText"> & {
  encoding: "array-buffer-v1";
  source: Bytes;
  derived?: Bytes;
  preparedText?: Bytes;
};

export async function encodeBookFile(file: BookFile): Promise<StoredBookBytes> {
  const bytes = async (blob: Blob): Promise<Bytes> => ({ data: await blob.arrayBuffer(), type: blob.type });
  const [source, derived, preparedText] = await Promise.all([bytes(file.source), file.derived ? bytes(file.derived) : undefined,
    file.preparedText ? bytes(file.preparedText) : undefined]);
  return { ...file, encoding: "array-buffer-v1", source, derived, preparedText };
}

export function decodeBookFile(file: BookFile | StoredBookBytes): BookFile;
export function decodeBookFile(file: BookFile | StoredBookBytes | undefined): BookFile | undefined;
export function decodeBookFile(file: BookFile | StoredBookBytes | undefined): BookFile | undefined {
  if (!file || (!("encoding" in file) && (!file.preparedText || file.preparedText instanceof Blob))) return file as BookFile | undefined;
  const blob = (value: Bytes) => new Blob([value.data], { type: value.type });
  const { encoding: _encoding, ...metadata } = file as StoredBookBytes;
  const prepared = file.preparedText as Blob | Bytes | undefined;
  return { ...metadata, source: "encoding" in file ? blob(file.source) : file.source,
    derived: "encoding" in file ? file.derived ? blob(file.derived) : undefined : file.derived,
    preparedText: prepared instanceof Blob ? prepared : prepared ? blob(prepared) : undefined };
}

export function isBlobStorageError(error: unknown) {
  return error instanceof Error && /preparing.*blob|blob\/file/i.test(error.message);
}
