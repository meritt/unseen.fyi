import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import type { Config } from '../config.ts';
import type { IpLimiter } from '../ratelimit/ip-limiter.ts';
import { extractIp } from '../wire/ip.ts';
import { cacheControlFor } from './headers.ts';

const gzipCache = new Map<string, Uint8Array<ArrayBuffer>>();
const brotliCache = new Map<string, Uint8Array<ArrayBuffer>>();

const etagCache = new Map<string, string>();

const COMPRESS_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.css', '.svg', '.html']);

const acceptsEncoding = (request: Request, token: 'br' | 'gzip'): boolean => {
  const accept = request.headers.get('accept-encoding') ?? '';
  return accept.split(',').some((part) => part.trim().toLowerCase().startsWith(token));
};

const negotiateEncoding = (request: Request): 'br' | 'gzip' | undefined => {
  if (acceptsEncoding(request, 'br')) {
    return 'br';
  }
  return acceptsEncoding(request, 'gzip') ? 'gzip' : undefined;
};

const compress = (
  encoding: 'br' | 'gzip',
  raw: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> => {
  if (encoding === 'gzip') {
    return Bun.gzipSync(raw);
  }
  return new Uint8Array(
    brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
  );
};

const hexDigest = (bytes: Uint8Array<ArrayBuffer>): string => {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
};

const computeEtag = async (
  file: ReturnType<typeof Bun.file>,
  filePath: string,
): Promise<string> => {
  const cached = etagCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  const raw = await file.bytes();
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const etag = `W/"${hexDigest(new Uint8Array(digest))}"`;
  etagCache.set(filePath, etag);
  return etag;
};

const normalizeEtag = (raw: string): string => (raw.startsWith('W/') ? raw.slice(2) : raw);

const etagMatches = (clientHeader: string | null, serverEtag: string): boolean => {
  if (clientHeader === null) {
    return false;
  }
  const normalizedServer = normalizeEtag(serverEtag);
  return clientHeader
    .split(',')
    .map((part) => normalizeEtag(part.trim()))
    .some((candidate) => candidate === normalizedServer);
};

const SPA_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/', 'index.html'],
  ['/r402', 'r402.html'],
]);

const STATIC_ALLOWLIST: readonly RegExp[] = [
  /^\/assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2|svg|png|webp|avif|ico)$/u,
  /^\/favicon\.svg$/u,
  /^\/robots\.txt$/u,
  /^\/sitemap\.xml$/u,
  /^\/og-image\.png$/u,
];

type RequestIpProvider = {
  requestIP: (request: Request) => { address: string } | null;
};

export type HandleHttpRequestParams = {
  readonly request: Request;
  readonly url: URL;
  readonly server: RequestIpProvider;
  readonly config: Config;
  readonly ipLimiter: IpLimiter;
};

const notFound = (): Response => new Response('Not found', { status: 404 });

const handleHealthz = (params: HandleHttpRequestParams): Response => {
  const ip = extractIp(params.request, params.server, params.config.trustedProxyHeader);
  if (!params.ipLimiter.check(ip, 'health')) {
    return new Response('rate_limited', { status: 429 });
  }
  return new Response('ok', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};

const respondWithFile = async (
  file: ReturnType<typeof Bun.file>,
  filePath: string,
  request: Request,
  options: { readonly immutable: boolean },
): Promise<Response> => {
  const extension = path.extname(filePath).toLowerCase();
  const headers: Record<string, string> = {
    'Cache-Control': cacheControlFor(options.immutable),
  };
  const etag = await computeEtag(file, filePath);
  headers.etag = etag;

  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const encoding = COMPRESS_EXTENSIONS.has(extension) ? negotiateEncoding(request) : undefined;
  if (encoding !== undefined) {
    const cache = encoding === 'br' ? brotliCache : gzipCache;
    let payload = cache.get(filePath);
    if (payload === undefined) {
      const raw = await file.bytes();
      payload = compress(encoding, raw);
      cache.set(filePath, payload);
    }
    const compressedHeaders: Record<string, string> = {
      ...headers,
      'content-encoding': encoding,
      'content-length': String(payload.length),
      vary: 'accept-encoding',
    };
    if (file.type !== '') {
      compressedHeaders['content-type'] = file.type;
    }
    return new Response(payload, { headers: compressedHeaders });
  }
  return new Response(file, { headers });
};

const serveStaticAsset = async (
  pathname: string,
  root: string,
  request: Request,
): Promise<Response> => {
  const allowed = STATIC_ALLOWLIST.some((re) => re.test(pathname));
  if (!allowed) {
    return notFound();
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return notFound();
  }

  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  const filePath = path.resolve(root, `.${decodedPath}`);
  if (!filePath.startsWith(rootPrefix)) {
    return notFound();
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return notFound();
  }
  return await respondWithFile(file, filePath, request, { immutable: true });
};

export const handleHttpRequest = async (params: HandleHttpRequestParams): Promise<Response> => {
  const { url, config } = params;

  if (url.pathname === '/healthz') {
    return handleHealthz(params);
  }

  const spaFileName = SPA_ROUTES.get(url.pathname);
  if (spaFileName !== undefined) {
    const spaPath = path.join(config.clientDistDir, spaFileName);
    const spaFile = Bun.file(spaPath);
    if (!(await spaFile.exists())) {
      return notFound();
    }
    return await respondWithFile(spaFile, spaPath, params.request, { immutable: false });
  }

  return await serveStaticAsset(url.pathname, config.clientDistDir, params.request);
};
