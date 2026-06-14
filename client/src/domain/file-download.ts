import { type AttachmentRecord, blobUrlRegistry } from './file-state.ts';

const REVOKE_BACKSTOP_MS = 60_000;

const fallbackADownload = (file: File, sanitisedName: string): void => {
  const blob = new Blob([file], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  blobUrlRegistry.add(url);

  const a = document.createElement('a');
  a.href = url;
  a.download = sanitisedName;
  document.body.append(a);
  a.click();
  a.remove();

  let revoked = false;
  const revoke = (): void => {
    if (revoked) {
      return;
    }
    revoked = true;
    URL.revokeObjectURL(url);
    blobUrlRegistry.delete(url);
  };
  globalThis.addEventListener('focus', revoke, { once: true });
  globalThis.setTimeout(revoke, REVOKE_BACKSTOP_MS);
};

const resolveFileBytes = async (record: AttachmentRecord): Promise<File> => {
  if (record.source === 'opfs') {
    return await record.handle.getFile();
  }
  return record.senderFile;
};

export const downloadAttachment = async (
  record: AttachmentRecord,
  sanitisedName: string,
): Promise<void> => {
  const { showSaveFilePicker } = globalThis;
  if (showSaveFilePicker !== undefined) {
    try {
      const fh = await showSaveFilePicker({
        suggestedName: sanitisedName,
        types: [],
        startIn: 'downloads',
      });
      const writable = await fh.createWritable();
      const file = await resolveFileBytes(record);
      await writable.write(file);
      await writable.close();
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (
        error instanceof DOMException &&
        (error.name === 'NotFoundError' || error.name === 'NotReadableError')
      ) {
        throw error;
      }
    }
  }
  const file = await resolveFileBytes(record);
  fallbackADownload(file, sanitisedName);
};
