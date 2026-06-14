const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types lit-html unseen-worker-url',
];

const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'clipboard-write=(self)',
  'clipboard-read=()',
  'idle-detection=()',
  'display-capture=()',
  'screen-wake-lock=()',
];

const TWO_YEARS_SECONDS = 63_072_000;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP_DIRECTIVES.join('; '),
  'Strict-Transport-Security': `max-age=${String(TWO_YEARS_SECONDS)}; includeSubDomains; preload`,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': PERMISSIONS_POLICY.join(', '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export const cacheControlFor = (immutable: boolean): string =>
  immutable ? 'public, max-age=31536000, immutable' : 'no-cache';

export const withSecurityHeaders = (response: Response): Response => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  if (!response.headers.has('Cache-Control')) {
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
};
