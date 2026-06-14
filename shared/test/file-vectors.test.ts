import { describe, expect, test } from 'bun:test';

import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from '../src/crypto/aesgcm.ts';
import { hexDecode, hexEncode } from '../src/crypto/encoding.ts';
import { V10_AAD_BINDING, V3_SESSION_KEY, V9_CHUNK_AEAD } from '../src/protocol/test-vectors.ts';

const TID_OFFSET = 0;
const TID_LENGTH = 8;
const SEQ_OFFSET = TID_OFFSET + TID_LENGTH;
const SEQ_LENGTH = 4;
const DATA_OFFSET = SEQ_OFFSET + SEQ_LENGTH;

describe('V9 — binary chunk AEAD', () => {
  test('encrypts the chunk plaintext to the recorded ciphertext byte-for-byte', async () => {
    const key = await importAesGcmKey(hexDecode(V3_SESSION_KEY.sessionKeyHex), 'extractable');
    const ciphertext = await aesGcmEncrypt({
      key,
      nonce: hexDecode(V9_CHUNK_AEAD.nonceHex),
      aad: hexDecode(V9_CHUNK_AEAD.aadHex),
      plaintext: hexDecode(V9_CHUNK_AEAD.plaintextHex),
    });
    expect(ciphertext.length).toBe(V9_CHUNK_AEAD.ciphertextLengthBytes);
    expect(hexEncode(ciphertext)).toBe(V9_CHUNK_AEAD.ciphertextHex);
    expect(hexEncode(ciphertext.slice(-16))).toBe(V9_CHUNK_AEAD.authTagHex);
  });

  test('decrypts back to the original chunk plaintext', async () => {
    const key = await importAesGcmKey(hexDecode(V3_SESSION_KEY.sessionKeyHex), 'extractable');
    const plaintext = await aesGcmDecrypt({
      key,
      nonce: hexDecode(V9_CHUNK_AEAD.nonceHex),
      aad: hexDecode(V9_CHUNK_AEAD.aadHex),
      ciphertext: hexDecode(V9_CHUNK_AEAD.ciphertextHex),
    });
    expect(plaintext.length).toBe(V9_CHUNK_AEAD.plaintextLengthBytes);
    expect(hexEncode(plaintext)).toBe(V9_CHUNK_AEAD.plaintextHex);
  });

  test('chunk plaintext layout decodes to recorded tid, seq, and data fields', () => {
    const plaintext = hexDecode(V9_CHUNK_AEAD.plaintextHex);
    const tid = plaintext.slice(TID_OFFSET, TID_OFFSET + TID_LENGTH);
    const seqView = new DataView(plaintext.buffer, plaintext.byteOffset + SEQ_OFFSET, SEQ_LENGTH);
    const seq = seqView.getUint32(0, true);
    const data = plaintext.slice(DATA_OFFSET);

    expect(hexEncode(tid)).toBe(V9_CHUNK_AEAD.tidHex);
    expect(seq).toBe(V9_CHUNK_AEAD.seq);
    expect(hexEncode(data)).toBe(V9_CHUNK_AEAD.dataHex);
    expect(data.length).toBe(V9_CHUNK_AEAD.dataLengthBytes);
  });
});

describe('V10 — AAD-binding property (kind byte bound into AAD)', () => {
  test('same plaintext under aadFor(0x00) vs aadFor(0x01) yields byte-distinct ciphertexts', async () => {
    const key = await importAesGcmKey(hexDecode(V3_SESSION_KEY.sessionKeyHex), 'extractable');
    const nonce = hexDecode(V10_AAD_BINDING.sharedNonceHex);
    const plaintext = hexDecode(V10_AAD_BINDING.sharedPlaintextHex);

    const ciphertextUnderMsg = await aesGcmEncrypt({
      key,
      nonce,
      aad: hexDecode(V10_AAD_BINDING.aadMsgHex),
      plaintext,
    });
    const ciphertextUnderChunk = await aesGcmEncrypt({
      key,
      nonce,
      aad: hexDecode(V10_AAD_BINDING.aadChunkHex),
      plaintext,
    });

    expect(hexEncode(ciphertextUnderMsg)).toBe(V10_AAD_BINDING.ciphertextUnderMsgAadHex);
    expect(hexEncode(ciphertextUnderChunk)).toBe(V10_AAD_BINDING.ciphertextUnderChunkAadHex);
    expect(hexEncode(ciphertextUnderMsg)).not.toBe(hexEncode(ciphertextUnderChunk));
  });

  test('AEAD authentication fails when AAD kind byte is swapped at decrypt time', async () => {
    const key = await importAesGcmKey(hexDecode(V3_SESSION_KEY.sessionKeyHex), 'extractable');
    const nonce = hexDecode(V10_AAD_BINDING.sharedNonceHex);
    const ciphertextUnderChunk = hexDecode(V10_AAD_BINDING.ciphertextUnderChunkAadHex);

    let threw = false;
    try {
      await aesGcmDecrypt({
        key,
        nonce,
        aad: hexDecode(V10_AAD_BINDING.aadMsgHex),
        ciphertext: ciphertextUnderChunk,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
