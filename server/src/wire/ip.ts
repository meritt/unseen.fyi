import { isIP } from 'node:net';

type RequestIpProvider = {
  requestIP: (request: Request) => { address: string } | null;
};

const IPV4_MAPPED = /^::ffff:(?<ipv4>\d+\.\d+\.\d+\.\d+)$/iu;

const normalizeIp = (raw: string): string => {
  const mapped = raw.match(IPV4_MAPPED);
  return mapped?.[1] ?? raw;
};

export const extractIp = (
  request: Request,
  server: RequestIpProvider,
  trustedProxyHeader: string | undefined,
): string => {
  if (trustedProxyHeader !== undefined) {
    const raw = request.headers.get(trustedProxyHeader);
    if (raw !== null && raw !== '') {
      const tokens = raw
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
      const last = tokens.at(-1);
      if (last !== undefined) {
        const candidate = normalizeIp(last);
        if (isIP(candidate) !== 0) {
          return candidate;
        }
      }
    }
  }
  const address = server.requestIP(request)?.address;
  return address === undefined || address === '' ? 'unknown' : normalizeIp(address);
};
