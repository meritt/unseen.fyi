import { Signal } from '../state/signal.ts';
import { currentOpaqueDir, purgeSessionDir } from '../storage/opfs-transfers.ts';

export const fileTransferSupported: Signal<boolean> = new Signal<boolean>(true);

export const fileTransferReady: Signal<boolean> = new Signal<boolean>(false);

export type TransferState =
  | {
      readonly tid: string;
      readonly phase: 'offered';
      readonly name: string;
      readonly size: number;
      readonly file: File;
      readonly abort: AbortSignal;
    }
  | {
      readonly tid: string;
      readonly phase: 'sending';
      readonly name: string;
      readonly size: number;
      sentBytes: number;
      readonly worker: Worker;
      readonly abort: AbortSignal;
    }
  | {
      readonly tid: string;
      readonly phase: 'verifying';
      readonly name: string;
      readonly size: number;
      readonly abort: AbortSignal;
    };

export type IncomingState =
  | {
      readonly tid: string;
      readonly phase: 'offer-pending';
      readonly name: string;
      readonly size: number;
    }
  | {
      readonly tid: string;
      readonly phase: 'receiving';
      readonly name: string;
      readonly size: number;
      readonly expectedSize: number;
      nextExpectedSeq: number;
      networkReceivedBytes: number;
      bytesWritten: number;
      receiveCredit: number;
      pendingChunkQueue: Array<{ readonly seq: number; readonly data: ArrayBuffer }>;
      senderSha256?: string;
      finalizeRequested?: boolean;
      readonly worker: Worker;
      readonly abort: AbortSignal;
    };

export const transferActive: Signal<TransferState | null> = new Signal<TransferState | null>(null);
export const incomingActive: Signal<IncomingState | null> = new Signal<IncomingState | null>(null);

export type AttachmentRecord =
  | {
      readonly source: 'opfs';
      readonly handle: FileSystemFileHandle;
      readonly name: string;
      readonly size: number;
    }
  | {
      readonly source: 'sender';
      readonly senderFile: File;
      readonly name: string;
      readonly size: number;
    };

export const attachmentMap: Map<string, AttachmentRecord> = new Map();

export const attachmentChanged: Signal<number> = new Signal<number>(0);

export const notifyAttachmentChanged = (): void => {
  attachmentChanged.value += 1;
};

export const blobUrlRegistry: Set<string> = new Set();

export const sessionReceivedBytes: Signal<number> = new Signal<number>(0);

let purgeDone: Promise<void> = Promise.resolve();

export const opfsPurgeDone = async (): Promise<void> => await purgeDone;

export const resetFileStateOnTerminate = async (): Promise<void> => {
  const opaqueDir = currentOpaqueDir.value;

  transferActive.value = null;
  incomingActive.value = null;
  attachmentMap.clear();
  attachmentChanged.value = 0;

  for (const url of blobUrlRegistry) {
    URL.revokeObjectURL(url);
  }
  blobUrlRegistry.clear();

  sessionReceivedBytes.value = 0;
  currentOpaqueDir.value = undefined;

  if (opaqueDir !== undefined) {
    purgeDone = purgeSessionDir(opaqueDir);
  }
  await purgeDone;
};
