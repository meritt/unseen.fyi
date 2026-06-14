import { describe, expect, test } from 'bun:test';

import { cacheControlFor, SECURITY_HEADERS, withSecurityHeaders } from '../src/static/headers.ts';

describe('security headers', () => {
  test('Cache-Control: SPA shell revalidates (no-cache), hashed assets are immutable', () => {
    expect(cacheControlFor(false)).toBe('no-cache');
    expect(cacheControlFor(true)).toContain('immutable');
  });

  test('CSP locks defaults and only allows same-origin scripts/styles/connections', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test('CSP connect-src is same-origin only — no wss: host wildcard', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).not.toMatch(/connect-src[^;]*wss:/u);
    expect(csp).not.toMatch(/connect-src[^;]*\*/u);
  });

  test('CSP enforces Trusted Types with a pinned policy allowlist', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain('trusted-types lit-html unseen-worker-url');
    expect(csp).not.toMatch(/trusted-types[^;]*'allow-duplicates'/u);
    expect(csp).not.toMatch(/trusted-types[^;]*\*/u);
  });

  test('CSP locks worker-src to same-origin only', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toMatch(/worker-src[^;]*blob:/u);
    expect(csp).not.toMatch(/worker-src[^;]*data:/u);
    expect(csp).not.toMatch(/worker-src[^;]*\*/u);
  });

  test('HSTS asks for two-year max-age, includeSubDomains, and preload', () => {
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  test('Permissions-Policy denies camera, microphone, geolocation, and device APIs', () => {
    const policy = SECURITY_HEADERS['Permissions-Policy'];
    expect(policy).toContain('camera=()');
    expect(policy).toContain('microphone=()');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('idle-detection=()');
    expect(policy).toContain('clipboard-write=(self)');
    expect(policy).not.toContain('browsing-topics');
    expect(policy).not.toContain('interest-cohort');
    expect(policy).not.toContain('attribution-reporting');
  });

  test('cross-origin isolation directives present', () => {
    expect(SECURITY_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });

  describe('withSecurityHeaders', () => {
    test('stamps every security header onto an arbitrary response', () => {
      const res = withSecurityHeaders(new Response('Not found', { status: 404 }));
      for (const name of Object.keys(SECURITY_HEADERS)) {
        expect(res.headers.get(name)).toBe(SECURITY_HEADERS[name]!);
      }
    });

    test('defaults Cache-Control to no-store for responses that did not set one', () => {
      const res = withSecurityHeaders(new Response('ok', { status: 200 }));
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    test('does not override a Cache-Control the response already set', () => {
      const res = withSecurityHeaders(
        new Response('asset', { headers: { 'Cache-Control': cacheControlFor(true) } }),
      );
      expect(res.headers.get('Cache-Control')).toContain('immutable');
    });
  });
});
