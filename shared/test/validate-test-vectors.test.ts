import { describe, expect, test } from 'bun:test';
// Independent oracle for the frozen vectors: re-derives every value from PRIVATE inputs
// using node:crypto (a separate codepath from shared/src) and anchors X25519 to the
// RFC 7748 §6.1 constants. The crypto-vectors / file-vectors suites re-derive through the
// app's own WebCrypto helpers and so pass for any internally-consistent fixture; this file
// closes that loop — deriving pubkeys from privkeys and ECDH from scalars — so a
// consistent-but-wrong vector (e.g. a corrupted public key) fails here.
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';

import fileVectorsFile from '../src/protocol/test-vectors-file-v1.json' with { type: 'json' };
import vectorsFile from '../src/protocol/test-vectors-v1.json' with { type: 'json' };

const V = vectorsFile.vectors;
const F = fileVectorsFile.vectors;

const HX = (h: string): Buffer => Buffer.from(h, 'hex');
const hx = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const u8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const EMPTY = Buffer.alloc(0);

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len));

const PKCS8 = HX('302e020100300506032b656e04220420');
const SPKI = HX('302a300506032b656e032100');
const privOf = (h: string) =>
  createPrivateKey({ key: Buffer.concat([PKCS8, HX(h)]), format: 'der', type: 'pkcs8' });
const pubFromPriv = (h: string): string => {
  const spki = createPublicKey(privOf(h)).export({ format: 'der', type: 'spki' });
  return hx(spki.subarray(spki.length - 32));
};
const ecdh = (privH: string, pubH: string): string =>
  hx(
    diffieHellman({
      privateKey: privOf(privH),
      publicKey: createPublicKey({
        key: Buffer.concat([SPKI, HX(pubH)]),
        format: 'der',
        type: 'spki',
      }),
    }),
  );

const gcm = (
  keyHex: string,
  nonceHex: string,
  aad: Uint8Array,
  ptHex: string,
): { ct: string; tag: string } => {
  const cipher = createCipheriv('aes-256-gcm', HX(keyHex), HX(nonceHex));
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(HX(ptHex)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct: hx(Buffer.concat([body, tag])), tag: hx(tag) };
};

const lexConcat = (aHex: string, bHex: string): Buffer => {
  const a = HX(aHex);
  const b = HX(bHex);
  return Buffer.compare(a, b) <= 0 ? Buffer.concat([a, b]) : Buffer.concat([b, a]);
};

const RFC7748 = {
  alicePriv: '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  alicePub: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
  bobPriv: '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
  bobPub: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
  shared: '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742',
} as const;

const secret = HX(V.v1_hkdf_derivation.secret_hex);
const sasAnchor = hkdf(secret, EMPTY, u8('unseen:v1:sas-anchor'), 32);
const sessionKey = hkdf(
  HX(V.v2_x25519.shared_secret_hex),
  sasAnchor,
  Buffer.concat([
    u8('unseen:v1:session-key'),
    lexConcat(V.v2_x25519.alice_pub_hex, V.v2_x25519.bob_pub_hex),
  ]),
  32,
);

describe('independent oracle — V1 room-key HKDF', () => {
  const o = V.v1_hkdf_derivation.outputs;
  test('roomId / handshake_key / sas_anchor', () => {
    expect(hx(hkdf(secret, EMPTY, u8('unseen:v1:roomId'), 16))).toBe(o.roomId_hex);
    expect(hx(hkdf(secret, EMPTY, u8('unseen:v1:handshake'), 32))).toBe(o.handshake_key_hex);
    expect(hx(sasAnchor)).toBe(o.sas_anchor_hex);
  });
  test('storageKey / lockKey / prf_salt / opfs_dir KATs', () => {
    expect(b64url(hkdf(secret, EMPTY, u8('unseen:v1:storage'), 8))).toBe(o.storageKey_b64url);
    expect(b64url(hkdf(secret, EMPTY, u8('unseen:v1:lock'), 8))).toBe(o.lockKey_b64url);
    expect(hx(hkdf(secret, EMPTY, u8('unseen:v1:prf-salt'), 32))).toBe(o.prf_salt_hex);
    expect(b64url(hkdf(secret, EMPTY, u8('unseen:v1:opfs:transfers'), 8))).toBe(o.opfs_dir_b64url);
  });
});

describe('independent oracle — V2 X25519 anchored to RFC 7748 §6.1', () => {
  test('vector matches the RFC reference byte-for-byte', () => {
    expect(V.v2_x25519.alice_priv_hex).toBe(RFC7748.alicePriv);
    expect(V.v2_x25519.alice_pub_hex).toBe(RFC7748.alicePub);
    expect(V.v2_x25519.bob_priv_hex).toBe(RFC7748.bobPriv);
    expect(V.v2_x25519.bob_pub_hex).toBe(RFC7748.bobPub);
    expect(V.v2_x25519.shared_secret_hex).toBe(RFC7748.shared);
  });
  test('public keys are X25519(priv, base); ECDH agrees both directions', () => {
    expect(pubFromPriv(V.v2_x25519.alice_priv_hex)).toBe(V.v2_x25519.alice_pub_hex);
    expect(pubFromPriv(V.v2_x25519.bob_priv_hex)).toBe(V.v2_x25519.bob_pub_hex);
    expect(ecdh(V.v2_x25519.alice_priv_hex, V.v2_x25519.bob_pub_hex)).toBe(
      V.v2_x25519.shared_secret_hex,
    );
    expect(ecdh(V.v2_x25519.bob_priv_hex, V.v2_x25519.alice_pub_hex)).toBe(
      V.v2_x25519.shared_secret_hex,
    );
  });
});

describe('independent oracle — V3/V4 session_key + SAS', () => {
  test('transcript ordering and session_key', () => {
    const transcript = lexConcat(V.v2_x25519.alice_pub_hex, V.v2_x25519.bob_pub_hex);
    expect(hx(transcript.subarray(0, 32))).toBe(V.v3_session_key.transcript_first_pub_hex);
    expect(hx(transcript.subarray(32))).toBe(V.v3_session_key.transcript_second_pub_hex);
    expect(hx(sessionKey)).toBe(V.v3_session_key.session_key_hex);
  });
  test('SAS bytes and emoji indices', () => {
    const sas = hkdf(sessionKey, sasAnchor, u8('unseen:v1:sas'), 5);
    expect(hx(sas)).toBe(V.v4_sas_bytes.sas_bytes_hex);
    expect([...sas]).toEqual([...V.v4_sas_bytes.sas_emoji_indices]);
  });
});

describe('independent oracle — V5/V6 message AEAD + wire frame', () => {
  test('plaintext, AAD, ciphertext, tag', () => {
    expect(hx(u8(V.v5_aes_gcm_message.plaintext_utf8))).toBe(V.v5_aes_gcm_message.plaintext_hex);
    const aad = Buffer.concat([u8('unseen:v1:'), HX('00')]);
    expect(hx(aad)).toBe(V.v5_aes_gcm_message.aad_hex);
    const out = gcm(
      hx(sessionKey),
      V.v5_aes_gcm_message.nonce_hex,
      aad,
      V.v5_aes_gcm_message.plaintext_hex,
    );
    expect(out.ct).toBe(V.v5_aes_gcm_message.ciphertext_hex);
    expect(out.tag).toBe(V.v5_aes_gcm_message.auth_tag_hex);
  });
  test('full RELAY frame', () => {
    const ct = HX(V.v5_aes_gcm_message.ciphertext_hex);
    const ctLen = Buffer.alloc(2);
    ctLen.writeUInt16LE(ct.length, 0);
    expect(hx(ctLen)).toBe(V.v6_wire_format.ct_len_hex_le);
    const frame = Buffer.concat([
      HX('05'),
      HX('00'),
      HX(V.v5_aes_gcm_message.nonce_hex),
      ctLen,
      ct,
    ]);
    expect(hx(frame)).toBe(V.v6_wire_format.full_frame_hex);
    expect(frame.length).toBe(V.v6_wire_format.full_frame_length_bytes);
  });
});

describe('independent oracle — V7 handshake AEAD', () => {
  test('encrypts alice_pub under handshake_key', () => {
    expect(V.v7_handshake_encrypt.plaintext_hex).toBe(V.v2_x25519.alice_pub_hex);
    const hsKey = hkdf(secret, EMPTY, u8('unseen:v1:handshake'), 32);
    const out = gcm(
      hx(hsKey),
      V.v7_handshake_encrypt.nonce_hex,
      u8('unseen:v1:handshake'),
      V.v7_handshake_encrypt.plaintext_hex,
    );
    expect(out.ct).toBe(V.v7_handshake_encrypt.ciphertext_hex);
    expect(out.tag).toBe(V.v7_handshake_encrypt.auth_tag_hex);
  });
});

describe('independent oracle — V8 wrap_key HKDF', () => {
  test('info concatenation and wrap_key', () => {
    const info = Buffer.concat([u8('unseen:v1:wrap'), HX(V.v1_hkdf_derivation.outputs.roomId_hex)]);
    expect(hx(info)).toBe(V.v8_wrap_key_derivation.info_hex);
    expect(hx(hkdf(HX(V.v8_wrap_key_derivation.prf_output_hex), EMPTY, info, 32))).toBe(
      V.v8_wrap_key_derivation.wrap_key_hex,
    );
  });
});

describe('independent oracle — V9/V10 chunk AEAD + AAD binding', () => {
  test('chunk layout, ciphertext, tag', () => {
    const aad = Buffer.concat([u8('unseen:v1:'), HX('01')]);
    expect(hx(aad)).toBe(F.v9_chunk_aead.aad_hex);
    const seq = Buffer.alloc(4);
    seq.writeUInt32LE(F.v9_chunk_aead.seq, 0);
    const pt = Buffer.concat([HX(F.v9_chunk_aead.tid_hex), seq, HX(F.v9_chunk_aead.data_hex)]);
    expect(hx(pt)).toBe(F.v9_chunk_aead.plaintext_hex);
    const out = gcm(hx(sessionKey), F.v9_chunk_aead.nonce_hex, aad, F.v9_chunk_aead.plaintext_hex);
    expect(out.ct).toBe(F.v9_chunk_aead.ciphertext_hex);
    expect(out.tag).toBe(F.v9_chunk_aead.auth_tag_hex);
  });
  test('msg-AAD vs chunk-AAD ciphertexts are distinct', () => {
    const underMsg = gcm(
      hx(sessionKey),
      F.v10_aad_binding.shared_nonce_hex,
      HX(F.v10_aad_binding.aad_msg_hex),
      F.v10_aad_binding.shared_plaintext_hex,
    );
    const underChunk = gcm(
      hx(sessionKey),
      F.v10_aad_binding.shared_nonce_hex,
      HX(F.v10_aad_binding.aad_chunk_hex),
      F.v10_aad_binding.shared_plaintext_hex,
    );
    expect(underMsg.ct).toBe(F.v10_aad_binding.ciphertext_under_msg_aad_hex);
    expect(underChunk.ct).toBe(F.v10_aad_binding.ciphertext_under_chunk_aad_hex);
    expect(underMsg.ct).not.toBe(underChunk.ct);
  });
});

describe('independent oracle — V11 rekeyed session_key', () => {
  const r = V.v11_rekeyed_session_key;
  test('fresh pubs from privs and ECDH', () => {
    expect(pubFromPriv(r.initiator_priv_hex)).toBe(r.initiator_pub_hex);
    expect(pubFromPriv(r.joiner_priv_hex)).toBe(r.joiner_pub_hex);
    expect(ecdh(r.initiator_priv_hex, r.joiner_pub_hex)).toBe(r.shared_secret_hex);
    expect(ecdh(r.joiner_priv_hex, r.initiator_pub_hex)).toBe(r.shared_secret_hex);
  });
  test('rekeyed_session_key = HKDF(shared, sas_anchor, "unseen:v1:rekeyed-session-key")', () => {
    const out = hkdf(HX(r.shared_secret_hex), sasAnchor, u8('unseen:v1:rekeyed-session-key'), 32);
    expect(hx(out)).toBe(r.rekeyed_session_key_hex);
  });
});
