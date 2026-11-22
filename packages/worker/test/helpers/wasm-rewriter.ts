import { HTMLRewriter as WasmHTMLRewriter, type Element as WasmElement } from "html-rewriter-wasm";
import type {
  CreateRewriterFn,
  FacetElementHandler,
  FacetHtmlElement,
  FacetHtmlRewriter,
} from "../../src/index.js";

interface RegisteredHandler {
  selector: string;
  handlers: FacetElementHandler;
}

const textEncoder = new TextEncoder();

export function createWasmRewriterFactory(): CreateRewriterFn {
  return (): FacetHtmlRewriter => {
    const registrations: RegisteredHandler[] = [];

    const adapter: FacetHtmlRewriter = {
      on(selector: string, handlers: FacetElementHandler): FacetHtmlRewriter {
        registrations.push({ selector, handlers });
        return adapter;
      },

      async transform(response: Response): Promise<Response> {
        const html = await response.text();
        const chunks: Uint8Array[] = [];

        const rewriter = new WasmHTMLRewriter((outputChunk: Uint8Array) => {
          chunks.push(outputChunk.slice());
        });

        try {
          for (const { selector, handlers } of registrations) {
            if (handlers.element) {
              const elementCb = handlers.element;
              rewriter.on(selector, {
                element(el: WasmElement): void | Promise<void> {
                  return elementCb(el as unknown as FacetHtmlElement);
                },
              });
            }
          }

          await rewriter.write(textEncoder.encode(html));
          await rewriter.end();
        } finally {
          rewriter.free();
        }

        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const headers = new Headers(response.headers);
        headers.delete("content-length");

        return new Response(merged, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      },
    };

    return adapter;
  };
}
