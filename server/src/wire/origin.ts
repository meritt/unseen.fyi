export const isAllowedOrigin = ({
  request,
  url,
  allowedOrigins,
}: {
  readonly request: Request;
  readonly url: URL;
  readonly allowedOrigins: readonly string[] | undefined;
}): boolean => {
  const origin = request.headers.get('origin');
  if (origin === null || origin === '') {
    return false;
  }
  if (allowedOrigins !== undefined) {
    return allowedOrigins.includes(origin);
  }
  return origin === url.origin;
};
