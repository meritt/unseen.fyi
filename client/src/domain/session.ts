import { importAesGcmKey } from '@unseen/shared/crypto/aesgcm.ts';
import { wrapSessionKey } from '@unseen/shared/crypto/aeskw.ts';
import { deriveRoomKeys, type RoomKeys } from '@unseen/shared/crypto/derive-room-keys.ts';
import {
  type Bytes,
  base64urlDecode,
  base64urlEncode,
  hexEncode,
} from '@unseen/shared/crypto/encoding.ts';
import { deriveRekeyedSessionKey, generateRekeyKeyPair } from '@unseen/shared/crypto/rekey.ts';
import { encodeHandshake, encodeHello, type ServerFrame } from '@unseen/shared/wire/codec.ts';
import { encodeEnvelope, type PlaintextEnvelope } from '@unseen/shared/wire/envelope.ts';
import {
  RELAY_KIND_CHUNK,
  RELAY_KIND_MODE_UPGRADED,
  RELAY_KIND_MSG,
  RELAY_KIND_REKEY_ACK,
  RELAY_KIND_REKEY_DONE,
  RELAY_KIND_REKEY_INIT,
  type RelayKind,
} from '@unseen/shared/wire/file-frame.ts';
import type { HelloIntent } from '@unseen/shared/wire/intent.ts';
import {
  decodeRekeyDonePayload,
  decodeModeUpgradedPayload,
  decodeRekeyPubkeyPayload,
} from '@unseen/shared/wire/mode-frame.ts';
import type { Role } from '@unseen/shared/wire/role.ts';

import { isPageHiding } from '../lifecycle/page-hide.ts';
import {
  appendMessage,
  appendSystemMessage,
  clearMessages,
  removeSystemMessage,
} from '../state/message-log.ts';
import {
  myRole,
  peerMode,
  reconnectAttemptAtMs,
  sessionMode,
  sessionState,
} from '../state/session-state.ts';
import {
  clearStoredSession,
  decodeRole,
  encodeRole,
  mirrorStoredSession,
  readStoredSession,
  type StoredSessionMirror,
  writeStoredSession,
} from '../storage/session-store.ts';
import { nextReconnectDelayMs } from '../transport/reconnect.ts';
import { type Connection, type ConnectionHandlers, openConnection } from '../transport/ws.ts';
import { browserClock, type Clock } from './clock.ts';
import { claimRoom, type RoomClaim } from './duplicate-tab.ts';
import { createFileReceiver, type FileReceiver } from './file-receive.ts';
import { createFileSender, type FileSender } from './file-send.ts';
import { incomingActive, resetFileStateOnTerminate, transferActive } from './file-state.ts';
import {
  completeHandshake,
  generateLocalHandshake,
  unwrapPeerPublicKey,
  wrapLocalPublicKey,
} from './handshake.ts';
import {
  registerSessionPasskey,
  resumeKeyExtractable,
  resumeSessionKey,
  signalSessionCredentialUnknown,
} from './passkey.ts';
import {
  type CounterMode,
  type ReceiveState,
  decryptIncoming,
  validateAndDecryptFrame,
} from './receive.ts';
import { allocateCounter, createSendSerializer, runRelaySendTask, type SendState } from './send.ts';

const RESUME_ID_BYTES = 8;

export const generateResumeId = (): string => {
  const bytes = new Uint8Array(RESUME_ID_BYTES);
  crypto.getRandomValues(bytes);
  return hexEncode(bytes);
};

const SAS_BYTE_LENGTH = 5;

declare const __UNSEEN_DEV__: boolean;

declare global {
  var __unseenTest: Record<string, unknown> | undefined;
}

export type SessionDependencies = {
  readonly secret: Bytes;
  readonly wsUrl: string;
  readonly rpId: string;
  readonly clock?: Clock;
  readonly onSas?: (sasBytes: Bytes) => void;
};

type EphemeralPair = Awaited<ReturnType<typeof generateLocalHandshake>>;

type ActiveContext = {
  readonly role: Role;
  sessionKey: CryptoKey;
  readonly clock: Clock;
  mirror?: StoredSessionMirror;
  sasBytes: Bytes;
  counterCommitted: bigint;
  counterReserved: bigint;
  counterRecv: bigint;
  nextRecvMode: CounterMode;
};

type InternalState =
  | { readonly kind: 'pre-active'; readonly keys: RoomKeys; ephemeral?: EphemeralPair }
  | { readonly kind: 'resuming'; readonly keys: RoomKeys; readonly active: ActiveContext }
  | { readonly kind: 'active'; readonly keys: RoomKeys; readonly active: ActiveContext };

export type RunningSession = {
  readonly send: (body: string) => Promise<void>;
  readonly sendFile: (file: File) => Promise<void>;
  readonly cancelTransfer: () => void;
  readonly acceptFileOffer: () => Promise<void>;
  readonly declineFileOffer: () => void;
  readonly upgradeToPrf: () => Promise<void>;
  readonly retryResume: () => Promise<void>;
  readonly terminate: (reason: string) => void;
};

type PersistenceHooks = {
  persistCounterReserved?: (counter: bigint) => void;
  persistCounterRecv?: (counter: bigint) => void;
};

const buildPersistence = (mirror: StoredSessionMirror | undefined): PersistenceHooks => {
  if (mirror === undefined) {
    return {};
  }
  return {
    persistCounterReserved: (counter): void => mirror.setCounterSend(counter),
    persistCounterRecv: (counter): void => mirror.setCounterRecv(counter),
  };
};

const allocateSendCounter = (active: ActiveContext, kind: RelayKind): bigint => {
  const sendState: SendState = {
    counterCommitted: active.counterCommitted,
    counterReserved: active.counterReserved,
    role: active.role,
    sessionKey: active.sessionKey,
    ...buildPersistence(active.mirror),
  };
  const counter = allocateCounter(sendState, kind);
  active.counterCommitted = sendState.counterCommitted;
  active.counterReserved = sendState.counterReserved;
  return counter;
};

export const startSession = async (deps: SessionDependencies): Promise<RunningSession> => {
  const clock: Clock = deps.clock ?? browserClock;
  const keys = await deriveRoomKeys(deps.secret);
  let stored = readStoredSession(keys.storageKey);
  if (stored?.rekey_in_progress === true) {
    clearStoredSession(keys.storageKey);
    stored = undefined;
  }

  const connectionRef: { current: Connection | undefined } = { current: undefined };
  const claimRef: { current: RoomClaim | undefined } = { current: undefined };
  let fileSender: FileSender | undefined;
  let fileReceiver: FileReceiver | undefined;
  let internal: InternalState = { kind: 'pre-active', keys };
  let credentialIdForCleanup: ArrayBuffer | undefined;
  let currentWrapKey: CryptoKey | undefined;
  let terminated = false;
  let intentTried: HelloIntent = stored === undefined ? 'create' : 'resume';
  let connectionGen = 0;
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let reconnectAttempt = 0;
  let reconnectStartMs = 0;
  let pendingResumeId: string | undefined;
  let rekeyInFlight = false;
  let pendingRekeyPair: { privateKey: CryptoKey; publicKeyRaw: Bytes } | undefined;
  let inboundChain: Promise<void> = Promise.resolve();
  const enqueueOutbound = createSendSerializer();

  sessionMode.value = stored === undefined ? 'RAM' : 'PRF';
  peerMode.value = stored?.mode_phase === 'hardened' ? 'PRF' : 'RAM';
  clearMessages();
  sessionState.value = stored === undefined ? 'CONNECTING' : 'RESUMING';

  const lifecycleAbort = new AbortController();

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== undefined) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    reconnectAttemptAtMs.value = undefined;
  };

  const FATAL_BUFFER_MS = 3000;
  const INSTANT_TERMINATION_REASONS = new Set(['user_panic', 'duplicate_tab']);
  const ACTIVE_OR_RECONNECTING_STATES = new Set<string>([
    'ACTIVE',
    'PEER_RECONNECTING',
    'RECONNECTING',
  ]);

  const finalizeTermination = (): void => {
    sessionState.value = 'TERMINATED';
    fileSender?.shutdown();
    fileSender = undefined;
    fileReceiver?.shutdown();
    fileReceiver = undefined;
    if (credentialIdForCleanup !== undefined) {
      void signalSessionCredentialUnknown({
        rpId: deps.rpId,
        credentialId: credentialIdForCleanup,
      });
    }
    clearStoredSession(keys.storageKey);
    claimRef.current?.release();
    claimRef.current = undefined;
    currentWrapKey = undefined;
    internal = { kind: 'pre-active', keys };
    void resetFileStateOnTerminate();
  };

  const terminate = (reason: string): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    appendSystemMessage(
      reason === 'duplicate_tab' ? 'duplicate_tab_blocked' : 'session_ended',
      clock.nowIso(),
    );
    clearReconnectTimer();
    connectionRef.current?.close(1000);
    lifecycleAbort.abort();

    const shouldBuffer =
      !INSTANT_TERMINATION_REASONS.has(reason) &&
      ACTIVE_OR_RECONNECTING_STATES.has(sessionState.value);
    if (shouldBuffer) {
      sessionState.value = 'FATAL_ENDING';
      globalThis.setTimeout(() => {
        finalizeTermination();
      }, FATAL_BUFFER_MS);
      return;
    }
    finalizeTermination();
  };

  const canRetryReconnect = (): boolean => {
    if (sessionMode.value !== 'PRF') {
      return false;
    }
    if (internal.kind !== 'active' && internal.kind !== 'resuming') {
      return false;
    }
    const state = sessionState.value;
    return (
      state === 'ACTIVE' ||
      state === 'PEER_RECONNECTING' ||
      state === 'RECONNECTING' ||
      state === 'RESUMING'
    );
  };

  const scheduleReconnect = (): void => {
    const wasReconnecting =
      sessionState.value === 'RECONNECTING' || sessionState.value === 'RESUMING';
    if (!wasReconnecting) {
      reconnectStartMs = performance.now();
      reconnectAttempt = 0;
    }
    const elapsed = performance.now() - reconnectStartMs;
    const delay = nextReconnectDelayMs(reconnectAttempt, elapsed);
    if (delay === null) {
      terminate('reconnect_exhausted');
      return;
    }
    sessionState.value = 'RECONNECTING';
    reconnectAttemptAtMs.value = performance.now() + delay;
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = undefined;
      reconnectAttemptAtMs.value = undefined;
      if (terminated) {
        return;
      }
      reconnectAttempt += 1;
      if (internal.kind === 'active') {
        internal.active.nextRecvMode = 'first-gap-allowed';
        internal = { kind: 'resuming', keys: internal.keys, active: internal.active };
      }
      openWith('resume');
    }, delay);
  };

  const installLifecycleHandlers = (): void => {
    const pagehideHandler = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        return;
      }
      connectionRef.current?.close(1000);
    };
    globalThis.addEventListener('pagehide', pagehideHandler, { signal: lifecycleAbort.signal });

    const visibilityHandler = (): void => {
      if (terminated || globalThis.document.visibilityState !== 'visible') {
        return;
      }
      if (sessionState.value !== 'ACTIVE' && sessionState.value !== 'PEER_RECONNECTING') {
        return;
      }
      const conn = connectionRef.current;
      if (conn !== undefined && conn.socket.readyState !== WebSocket.OPEN) {
        terminate('ws_dead_on_visibility_wake');
      }
    };
    globalThis.document.addEventListener('visibilitychange', visibilityHandler, {
      signal: lifecycleAbort.signal,
    });
  };

  installLifecycleHandlers();

  const requireConnection = (): Connection | undefined =>
    terminated ? undefined : connectionRef.current;

  const transitionToActive = (active: ActiveContext): void => {
    internal = { kind: 'active', keys, active };
    sessionState.value = 'ACTIVE';
    reconnectAttempt = 0;
    reconnectStartMs = 0;
    clearReconnectTimer();
    fileSender ??= createFileSender({
      sendEnvelope: async (envelope) => {
        if (internal.kind !== 'active') {
          return false;
        }
        return await sendEncoded(internal.active, envelope);
      },
      getWs: (): WebSocket | undefined => connectionRef.current?.socket,
      sendChunk: async (plaintext): Promise<boolean> => {
        if (internal.kind !== 'active') {
          return false;
        }
        return await enqueueRelaySend(
          internal.active,
          RELAY_KIND_CHUNK,
          plaintext,
          'chunk_encrypt_failed',
        );
      },
      appendSystemEvent: (event): void => {
        appendSystemMessage(event, clock.nowIso());
      },
    });
    fileReceiver ??= createFileReceiver({
      sendEnvelope: async (envelope) => {
        if (internal.kind !== 'active') {
          return false;
        }
        return await sendEncoded(internal.active, envelope);
      },
      getReceiveState: (): ReceiveState => ({
        counterRecv: active.counterRecv,
        role: active.role,
        sessionKey: active.sessionKey,
      }),
      syncReceiveState: (state): void => {
        active.counterRecv = state.counterRecv;
      },
      appendSystemEvent: (event): void => {
        appendSystemMessage(event, clock.nowIso());
      },
    });
  };

  const handleEnvelopeMessage = (envelope: Extract<PlaintextEnvelope, { kind: 'msg' }>): void => {
    appendMessage({
      kind: 'chat',
      id: crypto.randomUUID(),
      direction: 'in',
      body: envelope.body,
      receivedAtIso: clock.nowIso(),
    });
  };

  const enqueueRelaySend = async (
    active: ActiveContext,
    kind: RelayKind,
    plaintext: Bytes,
    encryptFailReason: string,
  ): Promise<boolean> =>
    await enqueueOutbound(
      async () =>
        await runRelaySendTask({
          isTerminated: () => terminated,
          getConnection: requireConnection,
          terminate,
          allocate: (k) => allocateSendCounter(active, k),
          keys: active,
          kind,
          plaintext,
          encryptFailReason,
        }),
    );

  async function sendEncoded(active: ActiveContext, envelope: PlaintextEnvelope): Promise<boolean> {
    return await enqueueRelaySend(
      active,
      RELAY_KIND_MSG,
      encodeEnvelope(envelope),
      'encrypt_failed',
    );
  }

  const sendFromActive = async (body: string): Promise<void> => {
    if (internal.kind !== 'active') {
      terminate('send_before_active');
      return;
    }
    const envelope: PlaintextEnvelope = { kind: 'msg', body, t: clock.nowIso() };
    const ok = await sendEncoded(internal.active, envelope);
    if (ok) {
      appendMessage({
        kind: 'chat',
        id: crypto.randomUUID(),
        direction: 'out',
        body,
        receivedAtIso: clock.nowIso(),
      });
    }
  };

  const sendResumeProbe = async (active: ActiveContext): Promise<void> => {
    pendingResumeId = generateResumeId();
    await sendEncoded(active, { kind: 'resume', _id: pendingResumeId });
  };

  const sendResumeAck = async (active: ActiveContext, peerId: string): Promise<void> => {
    await sendEncoded(active, { kind: 'resume_ack', _id: peerId });
  };

  let ephemeralPromise: Promise<EphemeralPair> | undefined;
  let localHandshakeSent = false;

  const ensureEphemeral = async (): Promise<EphemeralPair | undefined> => {
    ephemeralPromise ??= generateLocalHandshake();
    const pair = await ephemeralPromise;
    if (internal.kind !== 'pre-active') {
      return undefined;
    }
    if (internal.ephemeral === undefined) {
      internal = { kind: 'pre-active', keys, ephemeral: pair };
    }
    return pair;
  };

  const handleHandshakeFrame = async (nonce: Bytes, ciphertext: Bytes): Promise<void> => {
    if (internal.kind !== 'pre-active') {
      terminate('handshake_unexpected');
      return;
    }
    void sendLocalHandshake();
    const myKeyPair = await ensureEphemeral();
    if (myKeyPair === undefined) {
      terminate('handshake_unexpected');
      return;
    }
    let peerPublicKeyRaw: Bytes;
    try {
      peerPublicKeyRaw = await unwrapPeerPublicKey({
        nonce,
        ciphertext,
        handshakeKey: keys.handshakeKey,
      });
    } catch {
      terminate('handshake_decrypt_failed');
      return;
    }
    let material;
    try {
      material = await completeHandshake({
        myKeyPair,
        peerPublicKeyRaw,
        sasAnchor: keys.sasAnchor,
        extractability: 'extractable',
      });
    } catch {
      terminate('handshake_invariant_failed');
      return;
    }
    if (material.sasBytes.length !== SAS_BYTE_LENGTH) {
      terminate('sas_length_invariant');
      return;
    }
    deps.onSas?.(material.sasBytes);
    const role = myRole.value;
    if (role === undefined) {
      terminate('role_missing');
      return;
    }
    transitionToActive({
      role,
      sessionKey: material.sessionKey,
      clock,
      sasBytes: material.sasBytes,
      counterCommitted: 0n,
      counterReserved: 0n,
      counterRecv: 0n,
      nextRecvMode: 'strict',
    });
    appendSystemMessage('session_started', clock.nowIso());
  };

  const sendLocalHandshake = async (): Promise<void> => {
    if (localHandshakeSent) {
      return;
    }
    const connection = requireConnection();
    if (connection === undefined || internal.kind !== 'pre-active') {
      terminate('handshake_unexpected');
      return;
    }
    localHandshakeSent = true;
    const pair = await ensureEphemeral();
    if (pair === undefined) {
      return;
    }
    const wrapped = await wrapLocalPublicKey({
      publicKeyRaw: pair.publicKeyRaw,
      handshakeKey: keys.handshakeKey,
    });
    connection.send(encodeHandshake(wrapped.nonce, wrapped.ciphertext));
    if (sessionState.value === 'CONNECTING' || sessionState.value === 'WAITING_FOR_PEER') {
      sessionState.value = 'HANDSHAKING';
    }
  };

  const routeFileCancel = (envelope: Extract<PlaintextEnvelope, { kind: 'file_cancel' }>): void => {
    if (transferActive.value !== null && transferActive.value.tid === envelope.tid) {
      fileSender?.dispatchFromReceiver(envelope);
      return;
    }
    if (incomingActive.value !== null && incomingActive.value.tid === envelope.tid) {
      fileReceiver?.dispatchCancel(envelope);
    }
  };

  const dispatchFileEnvelope = (
    envelope: Extract<
      PlaintextEnvelope,
      {
        kind:
          | 'file_offer'
          | 'file_accept'
          | 'file_decline'
          | 'file_progress'
          | 'file_complete'
          | 'file_complete_ack'
          | 'file_cancel';
      }
    >,
  ): void => {
    switch (envelope.kind) {
      case 'file_accept':
      case 'file_decline':
      case 'file_progress':
      case 'file_complete_ack': {
        fileSender?.dispatchFromReceiver(envelope);
        return;
      }
      case 'file_offer': {
        fileReceiver?.dispatchOffer(envelope);
        return;
      }
      case 'file_complete': {
        fileReceiver?.dispatchComplete(envelope);
        return;
      }
      case 'file_cancel': {
        routeFileCancel(envelope);
      }
    }
  };

  const handleRelayActive = async (
    active: ActiveContext,
    nonce: Bytes,
    ciphertext: Bytes,
    mode: CounterMode,
  ): Promise<void> => {
    const recvState = {
      counterRecv: active.counterRecv,
      role: active.role,
      sessionKey: active.sessionKey,
      ...buildPersistence(active.mirror),
    };
    const result = await decryptIncoming(recvState, nonce, ciphertext, mode);
    if (result.status !== 'ok') {
      terminate(`relay_${result.status}`);
      return;
    }
    active.counterRecv = recvState.counterRecv;

    const { envelope } = result;
    if (envelope.kind === 'msg') {
      handleEnvelopeMessage(envelope);
      return;
    }
    if (envelope.kind === 'resume') {
      if (sessionState.value !== 'PEER_RECONNECTING') {
        terminate('resume_unexpected');
        return;
      }
      await sendResumeAck(active, envelope._id);
      sessionState.value = 'ACTIVE';
      appendSystemMessage('peer_reconnected', clock.nowIso());
      return;
    }
    if (envelope.kind === 'resume_ack') {
      if (internal.kind !== 'resuming') {
        terminate('resume_ack_unexpected');
        return;
      }
      if (envelope._id !== pendingResumeId) {
        terminate('resume_ack_id_mismatch');
        return;
      }
      pendingResumeId = undefined;
      transitionToActive(active);
      return;
    }
    dispatchFileEnvelope(envelope);
  };

  const handleRelay = async (kind: RelayKind, nonce: Bytes, ciphertext: Bytes): Promise<void> => {
    if (internal.kind === 'pre-active') {
      terminate('relay_before_active');
      return;
    }
    const { active } = internal;
    const mode = active.nextRecvMode;
    active.nextRecvMode = 'strict';
    if (kind === RELAY_KIND_CHUNK) {
      try {
        await fileReceiver?.dispatchChunkFrame(nonce, ciphertext, mode);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : 'relay_chunk_dispatch_failed';
        terminate(reason);
      }
      return;
    }
    if (
      kind === RELAY_KIND_MODE_UPGRADED ||
      kind === RELAY_KIND_REKEY_INIT ||
      kind === RELAY_KIND_REKEY_ACK ||
      kind === RELAY_KIND_REKEY_DONE
    ) {
      const payload = await decryptModeFrame({ active, kind, nonce, ciphertext, mode });
      if (payload === undefined) {
        return;
      }
      if (kind === RELAY_KIND_MODE_UPGRADED) {
        if (!decodeModeUpgradedPayload(payload)) {
          terminate('mode_upgraded_invalid_payload');
          return;
        }
        await handleModeUpgraded(active);
        return;
      }
      if (kind === RELAY_KIND_REKEY_INIT) {
        const peerPub = decodeRekeyPubkeyPayload(payload);
        if (peerPub === undefined) {
          terminate('rekey_init_invalid_payload');
          return;
        }
        await handleRekeyInit(active, peerPub);
        return;
      }
      if (kind === RELAY_KIND_REKEY_ACK) {
        const peerPub = decodeRekeyPubkeyPayload(payload);
        if (peerPub === undefined) {
          terminate('rekey_ack_invalid_payload');
          return;
        }
        await handleRekeyAck(active, peerPub);
        return;
      }
      if (!decodeRekeyDonePayload(payload)) {
        terminate('rekey_done_invalid_payload');
        return;
      }
      handleRekeyDone();
      return;
    }
    await handleRelayActive(active, nonce, ciphertext, mode);
  };

  const onPeerDisconnected = (): void => {
    if (internal.kind !== 'active') {
      terminate('peer_gone');
      return;
    }
    if (peerMode.value !== 'PRF') {
      terminate('peer_gone');
      return;
    }
    sessionState.value = 'PEER_RECONNECTING';
    internal.active.nextRecvMode = 'first-gap-allowed';
    appendSystemMessage('peer_disconnected', clock.nowIso());
  };

  const onPeerJoined = (): void => {
    removeSystemMessage('waiting_for_peer');
    if (internal.kind === 'pre-active') {
      void sendLocalHandshake();
      return;
    }
    if (sessionState.value === 'PEER_RECONNECTING') {
      internal.active.nextRecvMode = 'first-gap-allowed';
    }
  };

  const sendModeFrame = async (
    active: ActiveContext,
    kind: RelayKind,
    payload: Bytes,
  ): Promise<boolean> => await enqueueRelaySend(active, kind, payload, 'mode_frame_encrypt_failed');

  const decryptModeFrame = async ({
    active,
    kind,
    nonce,
    ciphertext,
    mode,
  }: {
    readonly active: ActiveContext;
    readonly kind: RelayKind;
    readonly nonce: Bytes;
    readonly ciphertext: Bytes;
    readonly mode: CounterMode;
  }): Promise<Bytes | undefined> => {
    const frame = await validateAndDecryptFrame({ state: active, kind, nonce, ciphertext, mode });
    if (frame.status !== 'ok') {
      terminate(`mode_frame_${frame.status}`);
      return undefined;
    }
    active.counterRecv = frame.counter;
    return frame.plaintext;
  };

  const persistWrappedSessionKey = async ({
    active,
    rawForWrap,
    wrapKey,
    modePhase,
    credentialId,
  }: {
    readonly active: ActiveContext;
    readonly rawForWrap: Bytes | CryptoKey;
    readonly wrapKey: CryptoKey;
    readonly modePhase: 'soft' | 'hardened';
    readonly credentialId: ArrayBuffer;
  }): Promise<boolean> => {
    let wrapped: Bytes;
    try {
      const keyToWrap =
        rawForWrap instanceof Uint8Array
          ? await importAesGcmKey(rawForWrap, 'extractable')
          : rawForWrap;
      wrapped = await wrapSessionKey(keyToWrap, wrapKey);
    } catch {
      terminate('session_key_wrap_failed');
      return false;
    }
    const record = {
      r: encodeRole(active.role),
      k: base64urlEncode(wrapped),
      s: active.counterReserved.toString(),
      n: active.counterRecv.toString(),
      cid: base64urlEncode(new Uint8Array(credentialId)),
      sas: base64urlEncode(active.sasBytes),
      mode_phase: modePhase,
    };
    try {
      writeStoredSession(keys.storageKey, record);
    } catch {
      terminate('storage_fail');
      return false;
    }
    active.mirror = mirrorStoredSession(keys.storageKey, record);
    return true;
  };

  const upgradeToPrf = async (): Promise<void> => {
    if (
      terminated ||
      sessionMode.value !== 'RAM' ||
      sessionState.value !== 'ACTIVE' ||
      internal.kind !== 'active'
    ) {
      return;
    }
    const { active } = internal;
    sessionState.value = 'UPGRADING_LOCAL';
    const outcome = await registerSessionPasskey({
      rpId: deps.rpId,
      prfSalt: keys.prfSalt,
      roomIdBytes: keys.roomIdBytes,
    });
    if (outcome.status === 'cancelled') {
      sessionState.value = 'ACTIVE';
      appendSystemMessage('mode_upgrade_dismissed_by_user', clock.nowIso());
      return;
    }
    if (outcome.status === 'failed') {
      sessionState.value = 'ACTIVE';
      appendSystemMessage('mode_upgrade_failed', clock.nowIso());
      return;
    }
    credentialIdForCleanup = outcome.credentialId;
    currentWrapKey = outcome.wrapKey;
    const persisted = await persistWrappedSessionKey({
      active,
      rawForWrap: active.sessionKey,
      wrapKey: outcome.wrapKey,
      modePhase: 'soft',
      credentialId: outcome.credentialId,
    });
    if (!persisted) {
      return;
    }
    sessionMode.value = 'PRF';
    sessionState.value = 'ACTIVE';
    appendSystemMessage('mode_upgraded_locally', clock.nowIso());
    await sendModeFrame(active, RELAY_KIND_MODE_UPGRADED, new Uint8Array(0));
    if (peerMode.value === 'PRF') {
      await startRekeyIfInitiator(active);
    }
  };

  const handleModeUpgraded = async (active: ActiveContext): Promise<void> => {
    peerMode.value = 'PRF';
    if (sessionMode.value === 'PRF') {
      await startRekeyIfInitiator(active);
    } else {
      appendSystemMessage('mode_upgrade_invited', clock.nowIso());
    }
  };

  const startRekeyIfInitiator = async (active: ActiveContext): Promise<void> => {
    if (rekeyInFlight || sessionState.value === 'REKEYING') {
      return;
    }
    rekeyInFlight = true;
    sessionState.value = 'REKEYING';
    fileSender?.cancelActive('session_rekey');
    fileReceiver?.cancelActive('session_rekey');
    if (active.mirror !== undefined) {
      try {
        writeStoredSession(keys.storageKey, {
          ...active.mirror.initial,
          rekey_in_progress: true,
        });
      } catch {
        terminate('storage_fail');
        return;
      }
    }
    if (active.role !== 'initiator') {
      return;
    }
    try {
      pendingRekeyPair = await generateRekeyKeyPair();
    } catch {
      terminate('rekey_keygen_failed');
      return;
    }
    await sendModeFrame(active, RELAY_KIND_REKEY_INIT, pendingRekeyPair.publicKeyRaw);
  };

  const handleRekeyInit = async (active: ActiveContext, peerPubRaw: Bytes): Promise<void> => {
    if (active.role !== 'joiner') {
      terminate('rekey_init_unexpected_role');
      return;
    }
    rekeyInFlight = true;
    sessionState.value = 'REKEYING';
    fileSender?.cancelActive('session_rekey');
    fileReceiver?.cancelActive('session_rekey');
    if (active.mirror !== undefined) {
      try {
        writeStoredSession(keys.storageKey, {
          ...active.mirror.initial,
          rekey_in_progress: true,
        });
      } catch {
        terminate('storage_fail');
        return;
      }
    }
    let pair;
    try {
      pair = await generateRekeyKeyPair();
    } catch {
      terminate('rekey_keygen_failed');
      return;
    }
    let material;
    try {
      material = await deriveRekeyedSessionKey({
        privSelf: pair.privateKey,
        myPubRaw: pair.publicKeyRaw,
        peerPubRaw,
        salt: keys.sasAnchor,
      });
    } catch {
      terminate('rekey_derive_failed');
      return;
    }
    const sent = await sendModeFrame(active, RELAY_KIND_REKEY_ACK, pair.publicKeyRaw);
    if (!sent) {
      return;
    }
    await commitRekey(active, material.sessionKey, material.sessionKeyRaw);
  };

  const handleRekeyAck = async (active: ActiveContext, peerPubRaw: Bytes): Promise<void> => {
    if (active.role !== 'initiator') {
      terminate('rekey_ack_unexpected_role');
      return;
    }
    if (pendingRekeyPair === undefined) {
      terminate('rekey_ack_no_pending');
      return;
    }
    let material;
    try {
      material = await deriveRekeyedSessionKey({
        privSelf: pendingRekeyPair.privateKey,
        myPubRaw: pendingRekeyPair.publicKeyRaw,
        peerPubRaw,
        salt: keys.sasAnchor,
      });
    } catch {
      terminate('rekey_derive_failed');
      return;
    }
    pendingRekeyPair = undefined;
    await commitRekey(active, material.sessionKey, material.sessionKeyRaw);
  };

  const commitRekey = async (
    active: ActiveContext,
    newSessionKey: CryptoKey,
    newSessionKeyRaw: Bytes,
  ): Promise<void> => {
    active.sessionKey = newSessionKey;
    active.counterCommitted = 0n;
    active.counterReserved = 0n;
    active.counterRecv = 0n;
    if (
      active.mirror !== undefined &&
      currentWrapKey !== undefined &&
      credentialIdForCleanup !== undefined
    ) {
      const persisted = await persistWrappedSessionKey({
        active,
        rawForWrap: newSessionKeyRaw,
        wrapKey: currentWrapKey,
        modePhase: 'hardened',
        credentialId: credentialIdForCleanup,
      });
      if (!persisted) {
        return;
      }
    }
    rekeyInFlight = false;
    sessionState.value = 'ACTIVE';
    appendSystemMessage('session_hardened', clock.nowIso());
    await sendModeFrame(active, RELAY_KIND_REKEY_DONE, new Uint8Array(0));
  };

  const handleRekeyDone = (): void => {
    /* optional ack */
  };

  const runInbound = async (prev: Promise<void>, task: () => Promise<void>): Promise<void> => {
    await prev;
    if (terminated) {
      return;
    }
    try {
      await task();
    } catch {
      /* handlers self-terminate */
    }
  };

  const enqueueInbound = (task: () => Promise<void>): void => {
    inboundChain = runInbound(inboundChain, task);
  };

  const handleServerFrame = (frame: ServerFrame): void => {
    if (terminated) {
      return;
    }
    if (frame.type === 'ACK') {
      myRole.value = frame.role;
      if (internal.kind === 'resuming') {
        void sendResumeProbe(internal.active);
        return;
      }
      if (frame.role === 'initiator') {
        sessionState.value = 'WAITING_FOR_PEER';
        appendSystemMessage('waiting_for_peer', clock.nowIso());
        return;
      }
      void sendLocalHandshake();
      return;
    }
    if (frame.type === 'PEER_JOINED') {
      onPeerJoined();
      return;
    }
    if (frame.type === 'HANDSHAKE') {
      enqueueInbound(async () => await handleHandshakeFrame(frame.nonce, frame.ciphertext));
      return;
    }
    if (frame.type === 'RELAY') {
      enqueueInbound(async () => await handleRelay(frame.kind, frame.nonce, frame.ciphertext));
      return;
    }
    if (frame.type === 'PEER_DISCONNECTED') {
      onPeerDisconnected();
      return;
    }
    if (frame.type === 'PEER_LEFT') {
      terminate('peer_gone');
      return;
    }
    if (frame.code === 'ROOM_ALREADY_EXISTS' && intentTried === 'create') {
      reopenAsJoiner();
      return;
    }
    terminate(`server_error_${frame.code.toLowerCase()}`);
  };

  function openWith(intent: HelloIntent): void {
    intentTried = intent;
    connectionGen += 1;
    const gen = connectionGen;
    const handlers: ConnectionHandlers = {
      onFrame: (frame): void => {
        if (gen === connectionGen) {
          handleServerFrame(frame);
        }
      },
      onClose: (kind): void => {
        if (gen !== connectionGen || terminated || isPageHiding()) {
          return;
        }
        fileSender?.onWsClose();
        fileReceiver?.onWsClose();
        if (canRetryReconnect()) {
          scheduleReconnect();
          return;
        }
        terminate(`ws_close_${kind}`);
      },
      onProtocolError: (kind): void => {
        if (gen === connectionGen && !isPageHiding()) {
          terminate(`protocol_${kind}`);
        }
      },
    };
    const connection = openConnection(deps.wsUrl, handlers);
    connectionRef.current = connection;
    connection.socket.addEventListener(
      'open',
      () => {
        if (!terminated && gen === connectionGen) {
          connection.send(encodeHello({ roomId: keys.roomIdBytes, intent }));
        }
      },
      { once: true },
    );
  }

  function reopenAsJoiner(): void {
    const previous = connectionRef.current;
    connectionRef.current = undefined;
    previous?.close(1000);
    sessionState.value = 'CONNECTING';
    openWith('join');
  }

  const sendFile = async (file: File): Promise<void> => {
    if (fileSender === undefined) {
      return;
    }
    await fileSender.startTransfer(file);
  };

  const cancelTransfer = (): void => {
    fileSender?.cancelActive();
    fileReceiver?.cancelActive();
  };

  const acceptFileOffer = async (): Promise<void> => {
    if (fileReceiver === undefined) {
      return;
    }
    await fileReceiver.acceptOffer();
  };

  const declineFileOffer = (): void => {
    fileReceiver?.declineOffer();
  };

  const claim = await claimRoom(keys.lockKey);
  if (claim === null) {
    terminate('duplicate_tab');
    return {
      send: sendFromActive,
      sendFile,
      cancelTransfer,
      acceptFileOffer,
      declineFileOffer,
      upgradeToPrf,
      retryResume,
      terminate,
    };
  }
  claimRef.current = claim;

  async function attemptResume(
    storedRecord: NonNullable<typeof stored>,
  ): Promise<'ok' | 'locked' | 'failed'> {
    let resumedKey: CryptoKey;
    let resumedWrap: CryptoKey;
    try {
      const r = await resumeSessionKey({
        rpId: deps.rpId,
        prfSalt: keys.prfSalt,
        roomIdBytes: keys.roomIdBytes,
        credentialIdBase64Url: storedRecord.cid,
        wrappedSessionKeyBase64Url: storedRecord.k,
        extractable: resumeKeyExtractable(storedRecord.mode_phase),
      });
      resumedKey = r.sessionKey;
      resumedWrap = r.wrapKey;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'passkey_resume_failed';
      if (reason === 'passkey_resume_get_rejected' && !terminated) {
        sessionState.value = 'RESUME_LOCKED';
        return 'locked';
      }
      terminate(reason);
      return 'failed';
    }
    currentWrapKey = resumedWrap;
    if (storedRecord.sas !== undefined) {
      try {
        deps.onSas?.(base64urlDecode(storedRecord.sas));
      } catch {
        /* malformed sas */
      }
    }
    const role = decodeRole(storedRecord.r);
    myRole.value = role;
    try {
      credentialIdForCleanup = base64urlDecode(storedRecord.cid).buffer;
    } catch {
      /* malformed cid */
    }
    const mirror = mirrorStoredSession(keys.storageKey, storedRecord);
    const storedReserved = BigInt(storedRecord.s);
    let restoredSas: Bytes;
    if (storedRecord.sas !== undefined) {
      try {
        restoredSas = base64urlDecode(storedRecord.sas);
      } catch {
        restoredSas = new Uint8Array(SAS_BYTE_LENGTH);
      }
    } else {
      restoredSas = new Uint8Array(SAS_BYTE_LENGTH);
    }
    internal = {
      kind: 'resuming',
      keys,
      active: {
        role,
        sessionKey: resumedKey,
        clock,
        mirror,
        sasBytes: restoredSas,
        counterCommitted: storedReserved,
        counterReserved: storedReserved,
        counterRecv: BigInt(storedRecord.n),
        nextRecvMode: 'first-gap-allowed',
      },
    };
    openWith('resume');
    return 'ok';
  }

  async function retryResume(): Promise<void> {
    if (terminated || sessionState.value !== 'RESUME_LOCKED' || stored === undefined) {
      return;
    }
    sessionState.value = 'RESUMING';
    await attemptResume(stored);
  }

  if (stored !== undefined) {
    try {
      await attemptResume(stored);
    } catch {
      terminate('resume_failed');
    }
  } else {
    openWith('create');
  }

  if (__UNSEEN_DEV__) {
    globalThis.__unseenTest = {
      ...globalThis.__unseenTest,
      forceCloseWs: (): void => {
        connectionRef.current?.close(4000, 'test-force-close');
      },
      fileTransfer: {
        sendFile,
        cancelTransfer,
        acceptOffer: acceptFileOffer,
        declineOffer: declineFileOffer,
        simulateIncomingOffer: (envelope: {
          readonly kind: 'file_offer';
          readonly tid: string;
          readonly name: string;
          readonly size: number;
        }): void => {
          fileReceiver?.dispatchOffer(envelope);
        },
      },
    };
  }

  return {
    send: sendFromActive,
    sendFile,
    cancelTransfer,
    acceptFileOffer,
    declineFileOffer,
    upgradeToPrf,
    retryResume,
    terminate,
  };
};
