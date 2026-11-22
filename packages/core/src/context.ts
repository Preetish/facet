import { DEFAULT_COOKIE_NAME } from "./schema.js";

export type ContextPrimitive = string | number | boolean;

export interface GeoContext {
  country?: string;
  region?: string;
  city?: string;
  continent?: string;
  timezone?: string;
  [key: string]: ContextPrimitive | undefined;
}

export interface CompanyContext {
  name?: string;
  domain?: string;
  industry?: string;
  size?: string;
  employees?: number;
  revenue?: string;
  [key: string]: ContextPrimitive | undefined;
}

export interface RequestContext {
  url: string;
  host: string;
  path: string;
  query: Record<string, string>;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  referrer?: string;
  cookies: Record<string, string>;
  headers: Record<string, string>;
  returning: boolean;
  visitorId?: string;
  geo: GeoContext;
  company: CompanyContext;
}

export interface BuildContextExtras {
  cookieName?: string;
  geo?: GeoContext;
  company?: CompanyContext;
  returning?: boolean;
  visitorId?: string;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function getOwn<T>(obj: Record<string, T>, key: string): T | undefined {
  return hasOwn(obj, key) ? obj[key] : undefined;
}

export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) {
    return cookies;
  }

  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const rawName = pair.slice(0, eqIndex).trim();
    const rawValue = pair.slice(eqIndex + 1).trim();
    if (!rawName) {
      continue;
    }
    const name = safeDecodeURIComponent(rawName);
    const value = safeDecodeURIComponent(rawValue);
    if (!hasOwn(cookies, name)) {
      cookies[name] = value;
    }
  }

  return cookies;
}

export function buildContextFromRequest(
  request: Request,
  extras?: BuildContextExtras,
): RequestContext {
  const parsedUrl = new URL(request.url);
  const query: Record<string, string> = {};
  parsedUrl.searchParams.forEach((value, key) => {
    if (!hasOwn(query, key)) {
      query[key] = value;
    }
  });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const cookies = parseCookies(getOwn(headers, "cookie") ?? null);
  const cookieName = extras?.cookieName ?? DEFAULT_COOKIE_NAME;
  const cookieVisitorId = getOwn(cookies, cookieName);
  const resolvedVisitorId =
    extras?.visitorId && extras.visitorId.length > 0
      ? extras.visitorId
      : cookieVisitorId && cookieVisitorId.length > 0
        ? cookieVisitorId
        : undefined;

  const returning = extras?.returning ?? Boolean(cookieVisitorId && cookieVisitorId.length > 0);

  const context: RequestContext = {
    url: parsedUrl.toString(),
    host: parsedUrl.hostname,
    path: parsedUrl.pathname,
    query,
    cookies,
    headers,
    returning,
    geo: extras?.geo ? { ...extras.geo } : {},
    company: extras?.company ? { ...extras.company } : {},
  };

  const utmSource = getOwn(query, "utm_source");
  const utmMedium = getOwn(query, "utm_medium");
  const utmCampaign = getOwn(query, "utm_campaign");
  const utmTerm = getOwn(query, "utm_term");
  const utmContent = getOwn(query, "utm_content");
  const referer = getOwn(headers, "referer");

  if (utmSource !== undefined) context.utm_source = utmSource;
  if (utmMedium !== undefined) context.utm_medium = utmMedium;
  if (utmCampaign !== undefined) context.utm_campaign = utmCampaign;
  if (utmTerm !== undefined) context.utm_term = utmTerm;
  if (utmContent !== undefined) context.utm_content = utmContent;
  if (referer !== undefined) context.referrer = referer;
  if (resolvedVisitorId !== undefined) context.visitorId = resolvedVisitorId;

  return context;
}
