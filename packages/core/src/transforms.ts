import type { FacetChange } from "./schema.js";
import { escapeHtml, interpolateTemplate, type TemplateContext } from "./templates.js";

export { escapeHtml };

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
  templateContext?: TemplateContext,
): ResolvedChange {
  const resolved: ResolvedChange = {
    experienceId,
    selector: change.selector,
  };

  if (change.text !== undefined) {
    resolved.text =
      templateContext !== undefined
        ? interpolateTemplate(change.text, templateContext, { escapeHtml: false })
        : change.text;
  } else if (change.html !== undefined) {
    resolved.html =
      templateContext !== undefined
        ? interpolateTemplate(change.html, templateContext, { escapeHtml: true })
        : change.html;
  } else if (change.slot !== undefined) {
    const resolvedSlot =
      templateContext !== undefined
        ? interpolateTemplate(change.slot, templateContext, { escapeHtml: true })
        : change.slot;
    resolved.slot = resolvedSlot;
    if (Object.prototype.hasOwnProperty.call(slots, resolvedSlot)) {
      const slotHtml = slots[resolvedSlot];
      if (slotHtml !== undefined) {
        resolved.html =
          templateContext !== undefined
            ? interpolateTemplate(slotHtml, templateContext, { escapeHtml: true })
            : slotHtml;
      }
    }
  }

  if (change.attrs !== undefined) {
    if (templateContext !== undefined) {
      const attrs: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(change.attrs)) {
        attrs[key] =
          value === null
            ? null
            : interpolateTemplate(value, templateContext, { escapeHtml: false });
      }
      resolved.attrs = attrs;
    } else {
      resolved.attrs = { ...change.attrs };
    }
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
    resolved.prepend =
      templateContext !== undefined
        ? interpolateTemplate(change.prepend, templateContext, { escapeHtml: true })
        : change.prepend;
  }

  if (change.append !== undefined) {
    resolved.append =
      templateContext !== undefined
        ? interpolateTemplate(change.append, templateContext, { escapeHtml: true })
        : change.append;
  }

  return resolved;
}
