import { escapeHtml, normalizeClassList } from "@facet/core";
import {
  createElement,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactElement,
  type ReactNode,
} from "react";
import { resolveSlotChange, type FacetRequestState } from "./state.js";

export type FacetSlotElement = keyof JSX.IntrinsicElements;

export type FacetSlotProps<T extends FacetSlotElement = "div"> = Omit<
  ComponentPropsWithoutRef<T>,
  "id" | "children"
> & {
  id: string;
  state: FacetRequestState;
  as?: T;
  htmlId?: string;
  children?: ReactNode;
};

const HTML_TO_REACT_ATTR_MAP: Readonly<Record<string, string>> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  colspan: "colSpan",
  rowspan: "rowSpan",
  contenteditable: "contentEditable",
  crossorigin: "crossOrigin",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  novalidate: "noValidate",
  referrerpolicy: "referrerPolicy",
  srcset: "srcSet",
  allowfullscreen: "allowFullScreen",
};

const BLOCKED_ATTR_KEYS = new Set<string>([
  "__proto__",
  "constructor",
  "prototype",
  "dangerouslysetinnerhtml",
  "children",
  "key",
  "ref",
]);

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function mapAttrKeyToReactProp(rawKey: string): string | null {
  const lower = rawKey.toLowerCase();
  if (BLOCKED_ATTR_KEYS.has(lower) || /^on[a-z]/i.test(rawKey)) {
    return null;
  }
  if (hasOwn(HTML_TO_REACT_ATTR_MAP, lower)) {
    return HTML_TO_REACT_ATTR_MAP[lower] ?? rawKey;
  }
  return rawKey;
}

function parseInlineStyleString(styleText: string): Record<string, string> {
  const styleObj: Record<string, string> = {};
  const declarations = styleText.split(";");
  for (const decl of declarations) {
    const colonIdx = decl.indexOf(":");
    if (colonIdx <= 0) {
      continue;
    }
    const rawProp = decl.slice(0, colonIdx).trim();
    const rawVal = decl.slice(colonIdx + 1).trim();
    if (!rawProp || !rawVal) {
      continue;
    }
    const propName = rawProp.startsWith("--")
      ? rawProp
      : rawProp.replace(/-([a-z])/gi, (_, ch: string) => ch.toUpperCase());
    if (!BLOCKED_ATTR_KEYS.has(propName.toLowerCase())) {
      styleObj[propName] = rawVal;
    }
  }
  return styleObj;
}

function mergeClassNames(
  baseClassName: unknown,
  addClass: readonly string[] | undefined,
  removeClass: readonly string[] | undefined,
): string | undefined {
  const baseTokens = typeof baseClassName === "string" ? normalizeClassList(baseClassName) : [];
  const removeSet = new Set<string>(removeClass ?? []);
  const filtered = baseTokens.filter((token) => !removeSet.has(token));
  const seen = new Set<string>(filtered);

  for (const token of addClass ?? []) {
    if (!seen.has(token)) {
      seen.add(token);
      filtered.push(token);
    }
  }

  return filtered.length > 0 ? filtered.join(" ") : undefined;
}

export function FacetSlot<T extends FacetSlotElement = "div">(
  props: FacetSlotProps<T>,
): ReactElement | null {
  const { id, state, as, htmlId, children, ...restProps } = props;
  const tag: FacetSlotElement = as ?? "div";
  const change = resolveSlotChange(state, id);

  if (change === undefined) {
    const baseProps: Record<string, unknown> = {
      ...(restProps as Record<string, unknown>),
      "data-facet-slot": id,
    };
    if (htmlId !== undefined) {
      baseProps.id = htmlId;
    }
    return children === undefined
      ? createElement(tag, baseProps)
      : createElement(tag, baseProps, children);
  }

  if (change.remove === true) {
    return null;
  }

  const mergedProps: Record<string, unknown> = {
    ...(restProps as Record<string, unknown>),
    "data-facet-slot": id,
  };

  if (htmlId !== undefined) {
    mergedProps.id = htmlId;
  }

  if (change.attrs !== undefined) {
    for (const [rawKey, rawVal] of Object.entries(change.attrs)) {
      const reactKey = mapAttrKeyToReactProp(rawKey);
      if (reactKey === null) {
        continue;
      }
      if (rawVal === null) {
        delete mergedProps[reactKey];
      } else if (reactKey === "style") {
        mergedProps.style = parseInlineStyleString(rawVal);
      } else {
        mergedProps[reactKey] = rawVal;
      }
    }
  }

  if (change.addClass !== undefined || change.removeClass !== undefined) {
    const nextClassName = mergeClassNames(
      mergedProps.className,
      change.addClass,
      change.removeClass,
    );
    if (nextClassName !== undefined) {
      mergedProps.className = nextClassName;
    } else {
      delete mergedProps.className;
    }
  }

  if (change.html !== undefined) {
    const prefix = change.prepend !== undefined ? escapeHtml(change.prepend) : "";
    const suffix = change.append !== undefined ? escapeHtml(change.append) : "";
    mergedProps.dangerouslySetInnerHTML = {
      __html: `${prefix}${change.html}${suffix}`,
    };
    return createElement(tag, mergedProps);
  }

  if (change.text !== undefined) {
    const textBody = `${change.prepend ?? ""}${change.text}${change.append ?? ""}`;
    return createElement(tag, mergedProps, textBody);
  }

  if (change.prepend !== undefined || change.append !== undefined) {
    const parts: ReactNode[] = [];
    if (change.prepend !== undefined) {
      parts.push(change.prepend);
    }
    if (children !== undefined) {
      parts.push(children);
    }
    if (change.append !== undefined) {
      parts.push(change.append);
    }
    return createElement(tag, mergedProps, ...parts);
  }

  return children === undefined
    ? createElement(tag, mergedProps)
    : createElement(tag, mergedProps, children);
}
