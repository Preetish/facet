import { normalizeClassList, type ResolvedChange } from "@facet/core";
import { HTMLRewriter, type Element } from "html-rewriter-wasm";

export interface RewriteHtmlOptions {
  html: string | Uint8Array;
  changes: readonly ResolvedChange[];
  analyticsSnippet?: string;
  previewBarHtml?: string;
}

const textEncoder = new TextEncoder();

export function applyResolvedChange(element: Element, change: ResolvedChange): void {
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
    for (const [name, value] of Object.entries(change.attrs)) {
      if (value === null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
    }
  }

  if (change.addClass !== undefined || change.removeClass !== undefined) {
    const existingAttr = element.getAttribute("class");
    const currentClasses = normalizeClassList(existingAttr ?? undefined);
    const removeSet = new Set(change.removeClass ?? []);
    const nextClasses = currentClasses.filter((cls) => !removeSet.has(cls));
    const existingSet = new Set(nextClasses);

    for (const cls of change.addClass ?? []) {
      if (!existingSet.has(cls)) {
        existingSet.add(cls);
        nextClasses.push(cls);
      }
    }

    if (nextClasses.length > 0) {
      element.setAttribute("class", nextClasses.join(" "));
    } else if (existingAttr !== null) {
      element.removeAttribute("class");
    }
  }

  if (change.prepend !== undefined) {
    element.prepend(change.prepend, { html: true });
  }

  if (change.append !== undefined) {
    element.append(change.append, { html: true });
  }
}

export async function rewriteHtml(options: RewriteHtmlOptions): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const rewriter = new HTMLRewriter((chunk: Uint8Array) => {
    chunks.push(chunk.slice());
  });

  try {
    for (const change of options.changes) {
      rewriter.on(change.selector, {
        element(element: Element): void {
          applyResolvedChange(element, change);
        },
      });
    }

    const injectionParts: string[] = [];
    if (options.analyticsSnippet && options.analyticsSnippet.length > 0) {
      injectionParts.push(options.analyticsSnippet);
    }
    if (options.previewBarHtml && options.previewBarHtml.length > 0) {
      injectionParts.push(options.previewBarHtml);
    }

    if (injectionParts.length > 0) {
      const injectionHtml = injectionParts.join("\n");
      let injected = false;

      rewriter.on("body", {
        element(element: Element): void {
          element.onEndTag((endTag) => {
            if (!injected) {
              injected = true;
              endTag.before(injectionHtml, { html: true });
            }
          });
        },
      });

      rewriter.onDocument({
        end(end): void {
          if (!injected) {
            injected = true;
            end.append(injectionHtml, { html: true });
          }
        },
      });
    }

    const inputBytes =
      typeof options.html === "string" ? textEncoder.encode(options.html) : options.html;

    await rewriter.write(inputBytes);
    await rewriter.end();

    return Buffer.concat(chunks);
  } finally {
    rewriter.free();
  }
}
