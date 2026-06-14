export type Bytes = Uint8Array<ArrayBuffer>;

export const hexEncode = (bytes: Bytes): string => bytes.toHex();

export const hexDecode = (hex: string): Bytes => Uint8Array.fromHex(hex);

export const base64urlEncode = (bytes: Bytes): string =>
  bytes.toBase64({ alphabet: 'base64url', omitPadding: true });

export const base64urlDecode = (input: string): Bytes =>
  Uint8Array.fromBase64(input, { alphabet: 'base64url' });
