const MAX_ORIGIN_LENGTH = 200;

/**
 * Normalises a configured public storefront origin such as `https://example.co.uk`
 * (a trailing slash is tolerated). Returns null for anything that is not a bare
 * http(s) origin, so canonical URLs can never inherit a path, query or credentials.
 */
export function parsePublicSiteOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  return url.origin.length <= MAX_ORIGIN_LENGTH ? url.origin : null;
}
