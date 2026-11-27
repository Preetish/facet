import type { FacetChange } from "@facet/core";

export interface PickedElement {
  selector: string;
  tagName: string;
  text: string;
  href: string | null;
}

export interface AppliedStatus {
  matchedCount: number;
  totalCount: number;
  missingSelectors: string[];
}

export type BridgeIncomingMessage =
  | {
      type: "facet:ready";
      url: string;
      title: string;
    }
  | {
      type: "facet:applied";
      matchedCount: number;
      totalCount: number;
      missingSelectors: string[];
    }
  | {
      type: "facet:picked";
      selector: string;
      tagName: string;
      text: string;
      href: string | null;
    }
  | {
      type: "facet:pick-cancelled";
    };

const PLACEHOLDER_TEXTS = new Set([
  "",
  "tailored headline for your campaign visitors",
  "personalized section copy",
  "book a demo",
  "personalized copy",
]);

/**
 * Normalizes a marketer-entered site URL (allowing bare domains like "facet.preetish.me")
 * and ensures only http:// or https:// URLs are accepted.
 */
export function normalizeSiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Extracts a concise host label (e.g. "facet.preetish.me" or "localhost:3000") for display.
 */
export function formatSiteHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = normalizeSiteUrl(raw);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return parsed.host || parsed.hostname || null;
  } catch {
    return null;
  }
}

export function buildLivePreviewIframeSrc(siteUrl: string): string {
  return `/api/live-preview?url=${encodeURIComponent(siteUrl)}`;
}

/**
 * Validates and narrows incoming postMessage payloads from the preview bridge script.
 */
export function parseBridgeMessage(data: unknown): BridgeIncomingMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return null;

  if (type === "facet:ready") {
    return {
      type: "facet:ready",
      url: typeof record["url"] === "string" ? record["url"] : "",
      title: typeof record["title"] === "string" ? record["title"] : "",
    };
  }

  if (type === "facet:applied") {
    const matchedCount =
      typeof record["matchedCount"] === "number" && Number.isFinite(record["matchedCount"])
        ? record["matchedCount"]
        : 0;
    const totalCount =
      typeof record["totalCount"] === "number" && Number.isFinite(record["totalCount"])
        ? record["totalCount"]
        : 0;
    const missingSelectors = Array.isArray(record["missingSelectors"])
      ? record["missingSelectors"].filter((item): item is string => typeof item === "string")
      : [];
    return {
      type: "facet:applied",
      matchedCount,
      totalCount,
      missingSelectors,
    };
  }

  if (type === "facet:picked") {
    const selector = typeof record["selector"] === "string" ? record["selector"].trim() : "";
    if (!selector) return null;
    const tagName =
      typeof record["tagName"] === "string" ? record["tagName"].trim().toLowerCase() : "";
    const text = typeof record["text"] === "string" ? record["text"].trim() : "";
    const href =
      typeof record["href"] === "string" && record["href"].trim().length > 0
        ? record["href"].trim()
        : null;
    return {
      type: "facet:picked",
      selector,
      tagName,
      text,
      href,
    };
  }

  if (type === "facet:pick-cancelled") {
    return { type: "facet:pick-cancelled" };
  }

  return null;
}

function isPlaceholderText(text: string | undefined): boolean {
  if (text === undefined) return true;
  return PLACEHOLDER_TEXTS.has(text.trim().toLowerCase());
}

/**
 * Applies a picked page element to a campaign's changes list:
 * - When `targetIndex` points to an existing change, updates its selector (and prefills empty/placeholder copy & link href).
 * - Otherwise appends a new change for the picked element.
 */
export function applyPickedElementToChanges(
  changes: readonly FacetChange[],
  picked: PickedElement,
  targetIndex: number | null,
): FacetChange[] {
  const isAnchor = picked.tagName.toLowerCase() === "a";
  const cleanedText = picked.text.trim();

  if (targetIndex !== null && targetIndex >= 0 && targetIndex < changes.length) {
    return changes.map((existing, idx) => {
      if (idx !== targetIndex) return existing;
      const updated: FacetChange = {
        ...existing,
        selector: picked.selector,
      };
      if (
        existing.slot === undefined &&
        existing.html === undefined &&
        cleanedText.length > 0 &&
        isPlaceholderText(existing.text)
      ) {
        updated.text = cleanedText;
      }
      if (isAnchor && picked.href && existing.slot === undefined && existing.html === undefined) {
        const currentHref = existing.attrs?.["href"];
        if (!currentHref || currentHref === "/demo" || currentHref.startsWith("/demo?")) {
          updated.attrs = { ...(existing.attrs ?? {}), href: picked.href };
        }
      }
      return updated;
    });
  }

  const nextChange: FacetChange = {
    selector: picked.selector,
    text: cleanedText.length > 0 ? cleanedText : "Personalized copy",
    ...(isAnchor && picked.href ? { attrs: { href: picked.href } } : {}),
  };

  return [...changes, nextChange];
}
