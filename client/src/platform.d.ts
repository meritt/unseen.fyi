// Platform APIs absent from the configured TS lib (["ESNext","DOM"]):
// OPFS synchronous access (worker-only), Trusted Types, File System Access save picker.

interface FileSystemSyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  write(buffer: AllowSharedBufferSource, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface TrustedTypePolicy {
  createScriptURL(input: string): string;
}

interface TrustedTypePolicyFactory {
  createPolicy(
    policyName: string,
    policyOptions: { createScriptURL(input: string): string },
  ): TrustedTypePolicy;
}

declare var trustedTypes: TrustedTypePolicyFactory;

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: readonly unknown[];
  startIn?: 'downloads' | 'documents' | 'desktop' | 'music' | 'pictures' | 'videos';
}

declare var showSaveFilePicker:
  | ((options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>)
  | undefined;
