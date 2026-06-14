import { unwrapSessionKey } from '@unseen/shared/crypto/aeskw.ts';
import { deriveWrapKey } from '@unseen/shared/crypto/derive-room-keys.ts';
import { type Bytes, base64urlDecode, base64urlEncode } from '@unseen/shared/crypto/encoding.ts';

const USER_HANDLE_BYTES = 16;
const CHALLENGE_BYTES = 32;
const ED25519_COSE_ALG = -8;
const ES256_COSE_ALG = -7;
const CRED_TIMEOUT_MS = 60_000;

const PASSKEY_LABEL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PASSKEY_LABEL_SUFFIX_LENGTH = 5;

const generatePasskeyLabel = (): string => {
  const bytes = new Uint8Array(PASSKEY_LABEL_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes]
    .map((b) => PASSKEY_LABEL_ALPHABET[b % PASSKEY_LABEL_ALPHABET.length] ?? '')
    .join('');
  return `Room 402 ${suffix}`;
};

export type RegisterOutcome =
  | {
      readonly status: 'ok';
      readonly wrapKey: CryptoKey;
      readonly credentialId: ArrayBuffer;
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly reason: string };

const cloneToBytes = (source: ArrayBuffer | ArrayBufferView): Bytes => {
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return new Uint8Array(view);
};

const expectPrfOutput = (cred: PublicKeyCredential): Bytes => {
  const prfResults = cred.getClientExtensionResults().prf?.results;
  const first = prfResults?.first;
  if (first === undefined) {
    throw new Error('prf_unavailable');
  }
  return cloneToBytes(first);
};

const isUserCancelError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'NotAllowedError';

export const registerSessionPasskey = async (args: {
  readonly rpId: string;
  readonly prfSalt: Bytes;
  readonly roomIdBytes: Bytes;
}): Promise<RegisterOutcome> => {
  const userHandle = crypto.getRandomValues(new Uint8Array(USER_HANDLE_BYTES));
  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  const label = generatePasskeyLabel();
  let cred: PublicKeyCredential | null;
  try {
    const raw = await navigator.credentials.create({
      publicKey: {
        rp: { id: args.rpId, name: 'Unseen' },
        user: { id: userHandle, name: label, displayName: label },
        challenge,
        pubKeyCredParams: [
          { alg: ED25519_COSE_ALG, type: 'public-key' },
          { alg: ES256_COSE_ALG, type: 'public-key' },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'discouraged',
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: args.prfSalt } } },
        timeout: CRED_TIMEOUT_MS,
      },
    });
    cred = raw instanceof PublicKeyCredential ? raw : null;
  } catch (err) {
    if (isUserCancelError(err)) {
      return { status: 'cancelled' };
    }
    return { status: 'failed', reason: 'passkey_register_failed' };
  }

  if (cred === null) {
    return { status: 'failed', reason: 'passkey_register_failed' };
  }
  let prfOutput: Bytes;
  try {
    prfOutput = expectPrfOutput(cred);
  } catch {
    return { status: 'failed', reason: 'passkey_register_prf_unavailable' };
  }
  const wrapKey = await deriveWrapKey({ prfOutput, roomIdBytes: args.roomIdBytes });
  return { status: 'ok', wrapKey, credentialId: cred.rawId };
};

export type ResumedSessionMaterial = {
  readonly sessionKey: CryptoKey;
  readonly wrapKey: CryptoKey;
};

export const resumeKeyExtractable = (modePhase: 'soft' | 'hardened' | undefined): boolean =>
  modePhase !== 'hardened';

export const resumeSessionKey = async (args: {
  readonly rpId: string;
  readonly prfSalt: Bytes;
  readonly roomIdBytes: Bytes;
  readonly credentialIdBase64Url: string;
  readonly wrappedSessionKeyBase64Url: string;
  readonly extractable: boolean;
}): Promise<ResumedSessionMaterial> => {
  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  const credentialIdBytes = base64urlDecode(args.credentialIdBase64Url);
  let assertion: PublicKeyCredential | null;
  try {
    const raw = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ id: credentialIdBytes, type: 'public-key' }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: args.prfSalt } } },
        timeout: CRED_TIMEOUT_MS,
      },
    });
    assertion = raw instanceof PublicKeyCredential ? raw : null;
  } catch (err) {
    globalThis.console.error('[unseen] credentials.get() rejected:', err);
    throw new Error('passkey_resume_get_rejected', { cause: err });
  }
  if (assertion === null) {
    globalThis.console.error('[unseen] credentials.get() returned non-PublicKeyCredential');
    throw new Error('passkey_resume_no_credential');
  }
  let prfOutput: Bytes;
  try {
    prfOutput = expectPrfOutput(assertion);
  } catch (err) {
    globalThis.console.error('[unseen] PRF results missing on assertion:', err);
    throw new Error('passkey_resume_prf_missing', { cause: err });
  }
  const wrapKey = await deriveWrapKey({ prfOutput, roomIdBytes: args.roomIdBytes });
  const wrapped = base64urlDecode(args.wrappedSessionKeyBase64Url);
  try {
    const sessionKey = await unwrapSessionKey(wrapped, wrapKey, args.extractable);
    return { sessionKey, wrapKey };
  } catch (err) {
    globalThis.console.error('[unseen] AES-KW unwrap failed (wrap_key mismatch):', err);
    throw new Error('passkey_resume_unwrap_failed', { cause: err });
  }
};

type SignalUnknownCredential = (input: { rpId: string; credentialId: string }) => Promise<void>;

type WithSignal = { signalUnknownCredential: SignalUnknownCredential };

const isWithSignal = (value: unknown): value is WithSignal => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  const maybe = (value as { signalUnknownCredential?: unknown }).signalUnknownCredential;
  return typeof maybe === 'function';
};

const getSignalUnknownCredential = (): SignalUnknownCredential | undefined => {
  const namespace: unknown = globalThis.PublicKeyCredential;
  return isWithSignal(namespace) ? namespace.signalUnknownCredential : undefined;
};

export const signalSessionCredentialUnknown = async (args: {
  readonly rpId: string;
  readonly credentialId: ArrayBuffer;
}): Promise<void> => {
  const signal = getSignalUnknownCredential();
  if (signal === undefined) {
    return;
  }
  try {
    await signal({
      rpId: args.rpId,
      credentialId: base64urlEncode(new Uint8Array(args.credentialId)),
    });
  } catch {
    /* best-effort */
  }
};
