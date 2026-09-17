declare module "yauzl" {
  import type { Readable } from "node:stream";
  export interface Entry {
    fileName: string;
    fileNameRaw: Buffer;
    generalPurposeBitFlag: number;
    compressionMethod: number;
    compressedSize: number;
    uncompressedSize: number;
    externalFileAttributes: number;
    relativeOffsetOfLocalHeader: number;
    crc32: number;
    extraFields: { id: number; data: Buffer }[];
  }
  export interface ZipFile {
    entryCount: number;
    eachEntry(): AsyncIterable<Entry>;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
    close(): void;
    on(name: string, listener: (err: Error) => void): void;
  }
  export function fromFdPromise(
    fd: number,
    options: {
      autoClose: boolean;
      lazyEntries: boolean;
      decodeStrings: boolean;
      validateEntrySizes: boolean;
      strictFileNames: boolean;
    },
  ): Promise<ZipFile>;
}
