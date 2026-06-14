import { describe, expect, test } from 'bun:test';

import {
  aadFor,
  isRelayKind,
  RELAY_KIND_CHUNK,
  RELAY_KIND_MODE_UPGRADED,
  RELAY_KIND_MSG,
  RELAY_KIND_REKEY_ACK,
  RELAY_KIND_REKEY_DONE,
  RELAY_KIND_REKEY_INIT,
} from '../src/wire/file-frame.ts';
import {
  decodeModeUpgradedPayload,
  decodeRekeyDonePayload,
  decodeRekeyPubkeyPayload,
  encodeModeUpgradedPayload,
  encodeRekeyAckPayload,
  encodeRekeyDonePayload,
  encodeRekeyInitPayload,
} from '../src/wire/mode-frame.ts';

describe('mode-frame kind byte constants', () => {
  test('all six kinds have distinct byte values in expected ranges', () => {
    const bytes = [
      RELAY_KIND_MSG,
      RELAY_KIND_CHUNK,
      RELAY_KIND_MODE_UPGRADED,
      RELAY_KIND_REKEY_INIT,
      RELAY_KIND_REKEY_ACK,
      RELAY_KIND_REKEY_DONE,
    ];
    expect(bytes).toEqual([0x00, 0x01, 0x10, 0x11, 0x12, 0x13]);
    expect(new Set(bytes).size).toBe(bytes.length);
  });

  test('isRelayKind accepts all six and rejects gaps', () => {
    expect(isRelayKind(0x00)).toBe(true);
    expect(isRelayKind(0x01)).toBe(true);
    expect(isRelayKind(0x10)).toBe(true);
    expect(isRelayKind(0x11)).toBe(true);
    expect(isRelayKind(0x12)).toBe(true);
    expect(isRelayKind(0x13)).toBe(true);
    expect(isRelayKind(0x02)).toBe(false);
    expect(isRelayKind(0x0f)).toBe(false);
    expect(isRelayKind(0x14)).toBe(false);
    expect(isRelayKind(0xff)).toBe(false);
  });

  test('aadFor binds the kind byte after `unseen:v1:` prefix', () => {
    const aadInit = aadFor(RELAY_KIND_REKEY_INIT);
    expect(aadInit.byteLength).toBe(11);
    expect(new TextDecoder().decode(aadInit.slice(0, 10))).toBe('unseen:v1:');
    expect(aadInit[10]).toBe(0x11);

    const aadDone = aadFor(RELAY_KIND_REKEY_DONE);
    expect(aadDone[10]).toBe(0x13);
  });
});

describe('mode-frame payload codecs', () => {
  test('mode_upgraded: empty payload round-trip', () => {
    const encoded = encodeModeUpgradedPayload();
    expect(encoded.byteLength).toBe(0);
    expect(decodeModeUpgradedPayload(encoded)).toBe(true);
    expect(decodeModeUpgradedPayload(new Uint8Array(1))).toBe(false);
  });

  test('rekey_init / rekey_ack: 32-byte pubkey round-trip', () => {
    const pub = new Uint8Array(32);
    crypto.getRandomValues(pub);
    const initBuf = encodeRekeyInitPayload(pub);
    expect(initBuf.byteLength).toBe(32);
    expect(decodeRekeyPubkeyPayload(initBuf)).toEqual(pub);

    const ackBuf = encodeRekeyAckPayload(pub);
    expect(decodeRekeyPubkeyPayload(ackBuf)).toEqual(pub);
  });

  test('rekey_init / rekey_ack throw on non-32-byte input', () => {
    expect(() => encodeRekeyInitPayload(new Uint8Array(31))).toThrow();
    expect(() => encodeRekeyAckPayload(new Uint8Array(33))).toThrow();
  });

  test('decodeRekeyPubkeyPayload rejects wrong length', () => {
    expect(decodeRekeyPubkeyPayload(new Uint8Array(0))).toBeUndefined();
    expect(decodeRekeyPubkeyPayload(new Uint8Array(16))).toBeUndefined();
    expect(decodeRekeyPubkeyPayload(new Uint8Array(64))).toBeUndefined();
  });

  test('rekey_done: empty payload round-trip', () => {
    expect(encodeRekeyDonePayload().byteLength).toBe(0);
    expect(decodeRekeyDonePayload(new Uint8Array(0))).toBe(true);
    expect(decodeRekeyDonePayload(new Uint8Array(1))).toBe(false);
  });
});
