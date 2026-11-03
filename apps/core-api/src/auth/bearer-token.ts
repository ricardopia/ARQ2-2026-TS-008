/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const [scheme, ...rest] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return undefined;
  }
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}
