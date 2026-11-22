import { normalizeClassList, type ResolvedChange } from "@facet/core";

export interface FacetRewriterContentOptions {
  html?: boolean;
}

export interface FacetHtmlElement {
  readonly removed?: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): unknown;
  removeAttribute(name: string): unknown;
  setInnerContent(content: string, options?: FacetRewriterContentOptions): unknown;
  prepend(content: string, options?: FacetRewriterContentOptions): unknown;
  append(content: string, options?: FacetRewriterContentOptions): unknown;
  remove(): unknown;
}

export interface FacetElementHandler {
  element?(element: FacetHtmlElement): void | Promise<void>;
}

export interface FacetHtmlRewriter {
  on(selector: string, handlers: FacetElementHandler): FacetHtmlRewriter;
  transform(response: Response): Response | Promise<Response>;
}

export type CreateRewriterFn = () => FacetHtmlRewriter;

export interface RewriteHtmlOptions {
  changes: readonly ResolvedChange[];
  analyticsSnippet?: string;
  createRewriter?: CreateRewriterFn;
}

export function createDefaultRewriter(): FacetHtmlRewriter {
  if (typeof HTMLRewriter !== "function") {
    throw new Error(
      "Global HTMLRewriter is not available in this runtime. Provide a custom createRewriter hook.",
    );
  }
  return new HTMLRewriter();
}

export function applyChangeToElement(element: FacetHtmlElement, change: ResolvedChange): void {
  if (element.removed === true) {
    return;
  }

  if (change.remove === true) {
    element.remove();
    return;
  }

  if (change.text !== undefined) {
    element.setInnerContent(change.text, { html: false });
  } else if (change.html !== undefined) {
    element.setInnerContent(change.html, { html: true });
  }

  if (change.attrs !== undefined) {
    for (const [attrName, attrValue] of Object.entries(change.attrs)) {
      if (attrValue === null) {
        element.removeAttribute(attrName);
      } else {
        element.setAttribute(attrName, attrValue);
      }
    }
  }

  const hasAddClass = change.addClass !== undefined && change.addClass.length > 0;
  const hasRemoveClass = change.removeClass !== undefined && change.removeClass.length > 0;

  if (hasAddClass || hasRemoveClass) {
    const existingAttr = element.getAttribute("class");
    const currentTokens = normalizeClassList(existingAttr ?? undefined);
    const removeSet = new Set(change.removeClass ?? []);
    const nextTokens: string[] = [];
    const seen = new Set<string>();

    for (const token of currentTokens) {
      if (!removeSet.has(token) && !seen.has(token)) {
        seen.add(token);
        nextTokens.push(token);
      }
    }

    if (change.addClass !== undefined) {
      for (const token of change.addClass) {
        if (!seen.has(token)) {
          seen.add(token);
          nextTokens.push(token);
        }
      }
    }

    if (nextTokens.length === 0) {
      if (existingAttr !== null) {
        element.removeAttribute("class");
      }
    } else {
      element.setAttribute("class", nextTokens.join(" "));
    }
  }

  if (change.prepend !== undefined) {
    element.prepend(change.prepend, { html: true });
  }

  if (change.append !== undefined) {
    element.append(change.append, { html: true });
  }
}

export async function rewriteHtmlResponse(
  response: Response,
  options: RewriteHtmlOptions,
): Promise<Response> {
  const hasChanges = options.changes.length > 0;
  const analyticsSnippet = options.analyticsSnippet ?? "";
  const hasAnalytics = analyticsSnippet.length > 0;

  if (!hasChanges && !hasAnalytics) {
    return response;
  }

  const createRewriter = options.createRewriter ?? createDefaultRewriter;
  const rewriter = createRewriter();

  for (const change of options.changes) {
    rewriter.on(change.selector, {
      element(element: FacetHtmlElement): void {
        applyChangeToElement(element, change);
      },
    });
  }

  if (hasAnalytics) {
    let injected = false;
    rewriter.on("body", {
      element(element: FacetHtmlElement): void {
        if (injected || element.removed === true) {
          return;
        }
        injected = true;
        element.append(analyticsSnippet, { html: true });
      },
    });
  }

  const transformed = await rewriter.transform(response);
  const headers = new Headers(transformed.headers);
  headers.delete("content-length");
  headers.delete("etag");

  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}
