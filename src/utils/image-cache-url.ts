/**
 * Bare-metal-reachable URLs for the discovery-service image cache.
 *
 * IPA on the host cannot resolve cluster DNS (*.svc / *.svc.cluster.local).
 * BMH spec.image.url and checksum must never use those names.
 */

const CONSOLE_HOST_PREFIX = 'console-openshift-console.';
const IMAGE_CACHE_ROUTE_PREFIX = 'image-cache-oct-baremetal';
const IMAGE_CACHE_PATH = '/api/v1/image-cache/images/';

export type ImageCacheUrlFields = {
  name?: string;
  phase?: string;
  downloadUrl?: string;
  checksumUrl?: string;
  externalUrl?: string;
  externalChecksumUrl?: string;
};

export type BareMetalImageUrls = {
  url: string;
  checksum: string;
  source: 'external' | 'synthesized' | 'provided';
};

export type BareMetalImageUrlError = {
  error: 'invalid' | 'not-reachable';
};

export function isHttpUrl(url: string): boolean {
  return Boolean(url) && (url.startsWith('http://') || url.startsWith('https://'));
}

/** True when the URL hostname is a Kubernetes ClusterIP DNS name. */
export function isClusterInternalUrl(url: string): boolean {
  if (!url) {
    return false;
  }
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    const lower = url.toLowerCase();
    return lower.includes('.svc.cluster.local') || /(?:^|[/.])svc(?:[./:]|$)/.test(lower);
  }
  return (
    host === 'svc' ||
    host.endsWith('.svc') ||
    host.includes('.svc.') ||
    host.endsWith('.svc.cluster.local')
  );
}

export function isBareMetalReachableUrl(url: string): boolean {
  return isHttpUrl(url) && !isClusterInternalUrl(url);
}

/**
 * Derive the OpenShift apps domain from the console hostname.
 * console-openshift-console.apps.example.com → apps.example.com
 * foo.apps.example.com → apps.example.com
 */
export function deriveClusterAppsDomain(hostname: string): string | undefined {
  if (!hostname) {
    return undefined;
  }
  if (hostname.startsWith(CONSOLE_HOST_PREFIX)) {
    const rest = hostname.slice(CONSOLE_HOST_PREFIX.length);
    if (rest) {
      return rest;
    }
  }
  const appsIdx = hostname.indexOf('.apps.');
  if (appsIdx !== -1) {
    return hostname.slice(appsIdx + 1);
  }
  return undefined;
}

export function imageCacheFileName(
  status?: ImageCacheUrlFields | null,
  selectedName?: string | null,
  imageUrl?: string,
): string | undefined {
  const candidates = [status?.externalUrl, status?.downloadUrl, imageUrl];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const idx = candidate.indexOf(IMAGE_CACHE_PATH);
    if (idx === -1) {
      continue;
    }
    const name = candidate.slice(idx + IMAGE_CACHE_PATH.length).split(/[?#]/)[0];
    if (name && !name.includes('/') && !name.includes('..')) {
      return name.endsWith('.sha256sum') ? name.replace(/\.sha256sum$/, '') : name;
    }
  }
  const base = status?.name || selectedName || undefined;
  if (!base || base.includes('/') || base.includes('..')) {
    return undefined;
  }
  return base.endsWith('.img') ? base : `${base}.img`;
}

export function synthesizeImageCachePublicUrl(
  fileName: string,
  hostname: string,
): string | undefined {
  if (!fileName || fileName.includes('/') || fileName.includes('..')) {
    return undefined;
  }
  const appsDomain = deriveClusterAppsDomain(hostname);
  if (!appsDomain) {
    return undefined;
  }
  const url = `http://${IMAGE_CACHE_ROUTE_PREFIX}.${appsDomain}${IMAGE_CACHE_PATH}${fileName}`;
  if (!isBareMetalReachableUrl(url)) {
    return undefined;
  }
  return url;
}

function consoleHostname(): string {
  if (typeof window === 'undefined' || !window.location) {
    return '';
  }
  return window.location.hostname;
}

/**
 * Choose image + checksum URLs that IPA can fetch from bare metal.
 *
 * Preference: cacheStatus.externalUrl → synthesized Route URL → any other
 * non-.svc http(s) URL (form / downloadUrl). Never returns a .svc URL.
 */
export function resolveBareMetalImageUrls(
  status: ImageCacheUrlFields | null | undefined,
  imageUrl: string,
  imageChecksum: string,
  selectedName?: string | null,
  hostname: string = consoleHostname(),
): BareMetalImageUrls | BareMetalImageUrlError {
  const fileName = imageCacheFileName(status, selectedName, imageUrl);
  const cacheReady = status?.phase === 'ready';
  const looksLikeCache = Boolean(
    (imageUrl && imageUrl.includes('image-cache')) ||
      (cacheReady && status?.downloadUrl && status.downloadUrl.includes('image-cache')) ||
      (cacheReady && status?.externalUrl && status.externalUrl.includes('image-cache')),
  );

  const synthUrl =
    looksLikeCache && fileName ? synthesizeImageCachePublicUrl(fileName, hostname) : undefined;
  const synthChecksum =
    looksLikeCache && fileName
      ? synthesizeImageCachePublicUrl(`${fileName}.sha256sum`, hostname)
      : undefined;

  const url =
    pickReachable(status?.externalUrl, synthUrl, imageUrl, status?.downloadUrl) || '';
  const checksum =
    pickReachable(
      status?.externalChecksumUrl,
      synthChecksum,
      imageChecksum,
      status?.checksumUrl,
    ) || '';

  const source: BareMetalImageUrls['source'] =
    status?.externalUrl && url === status.externalUrl
      ? 'external'
      : synthUrl && url === synthUrl
        ? 'synthesized'
        : 'provided';

  if (!isBareMetalReachableUrl(url) || !isBareMetalReachableUrl(checksum)) {
    const sawInternal = [status?.externalUrl, status?.downloadUrl, imageUrl, imageChecksum].some(
      (u) => u && isClusterInternalUrl(u),
    );
    if (sawInternal || looksLikeCache) {
      return { error: 'not-reachable' };
    }
    return { error: 'invalid' };
  }

  return { url, checksum, source };
}

function pickReachable(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && isBareMetalReachableUrl(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
