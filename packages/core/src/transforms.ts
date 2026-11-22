import type { FacetChange } from "./schema.js";

export interface ResolvedChange {
  experienceId: string;
  selector: string;
  text?: string;
  html?: string;
  slot?: string;
  attrs?: Record<string, string | null>;
  addClass?: string[];
  removeClass?: string[];
  remove?: boolean;
  prepend?: string;
  append?: string;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export function escapeHtmlAttr(value: string): string {
  return escapeHtml(value);
}

export function normalizeClassList(classes: string | readonly string[] | undefined): string[] {
  if (classes === undefined) {
    return [];
  }
  const items = typeof classes === "string" ? [classes] : classes;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const tokens = item.split(/\s+/);
    for (const token of tokens) {
      const trimmed = token.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }

  return result;
}

export function resolveChange(
  change: FacetChange,
  experienceId: string,
  slots: Readonly<Record<string, string>>,
): ResolvedChange {
  const resolved: ResolvedChange = {
    experienceId,
    selector: change.selector,
  };

  if (change.text !== undefined) {
    resolved.text = change.text;
  } else if (change.html !== undefined) {
    resolved.html = change.html;
  } else if (change.slot !== undefined) {
    resolved.slot = change.slot;
    if (Object.prototype.hasOwnProperty.call(slots, change.slot)) {
      const slotHtml = slots[change.slot];
      if (slotHtml !== undefined) {
        resolved.html = slotHtml;
      }
    }
  }

  if (change.attrs !== undefined) {
    resolved.attrs = { ...change.attrs };
  }

  if (change.addClass !== undefined) {
    const list = normalizeClassList(change.addClass);
    if (list.length > 0) {
      resolved.addClass = list;
    }
  }

  if (change.removeClass !== undefined) {
    const list = normalizeClassList(change.removeClass);
    if (list.length > 0) {
      resolved.removeClass = list;
    }
  }

  if (change.remove === true) {
    resolved.remove = true;
  }

  if (change.prepend !== undefined) {
    resolved.prepend = change.prepend;
  }

  if (change.append !== undefined) {
    resolved.append = change.append;
  }

  return resolved;
}
