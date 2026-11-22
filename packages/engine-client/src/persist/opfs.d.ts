// OPFS synchronous access handles (Worker only) are not in TypeScript's DOM lib yet.
interface FileSystemSyncAccessHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
