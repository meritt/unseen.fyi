import { type Bytes, base64urlDecode } from '@unseen/shared/crypto/encoding.ts';

const HASH_LENGTH = 44;
const SECRET_LENGTH = 32;

export type Route =
  | { readonly kind: 'landing' }
  | { readonly kind: 'chat'; readonly secret: Bytes }
  | { readonly kind: 'invalid' };

export const parseLocation = (location: Location): Route => {
  const { pathname, hash } = location;
  if (pathname === '/') {
    return { kind: 'landing' };
  }
  if (pathname !== '/r402') {
    return { kind: 'invalid' };
  }
  if (hash.length !== HASH_LENGTH || !hash.startsWith('#')) {
    return { kind: 'invalid' };
  }
  try {
    const bytes = base64urlDecode(hash.slice(1));
    if (bytes.length !== SECRET_LENGTH) {
      return { kind: 'invalid' };
    }
    return { kind: 'chat', secret: bytes };
  } catch {
    return { kind: 'invalid' };
  }
};
