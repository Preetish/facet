import {
  DEFAULT_PREVIEW_BUCKET_PARAM,
  DEFAULT_PREVIEW_PARAM,
  escapeHtml,
  escapeHtmlAttr,
  safeJsonForScript,
  type EvaluationResult,
  type FacetConfig,
} from "@facet/core";

export const LOCAL_MODE_COOKIE_NAME = "__facet_local_mode";
export const LOCAL_MODE_QUERY_PARAM = "__facet_local_mode";

export type LocalPreviewMode =
  | { kind: "auto" }
  | { kind: "default" }
  | { kind: "experience"; experienceId: string; bucket: "variant" | "control" };

export interface ResolvedLocalPreviewMode {
  mode: LocalPreviewMode;
  fromQuery: boolean;
  setCookieValue?: string;
}

export interface PreviewBarOptions {
  config: FacetConfig;
  evaluation: EvaluationResult;
  mode: LocalPreviewMode;
}

export function serializeLocalPreviewMode(mode: LocalPreviewMode): string {
  switch (mode.kind) {
    case "auto":
      return "auto";
    case "default":
      return "default";
    case "experience":
      return `exp:${mode.experienceId}:${mode.bucket}`;
  }
}

export function deserializeLocalPreviewMode(raw: string | undefined): LocalPreviewMode {
  if (!raw || raw === "auto") {
    return { kind: "auto" };
  }
  if (raw === "default") {
    return { kind: "default" };
  }
  if (raw.startsWith("exp:")) {
    const rest = raw.slice(4);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const experienceId = rest.slice(0, lastColon);
      const bucket = rest.slice(lastColon + 1);
      if (experienceId.length > 0 && (bucket === "variant" || bucket === "control")) {
        return { kind: "experience", experienceId, bucket };
      }
    }
  }
  return { kind: "auto" };
}

function getOwn(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function resolveLocalPreviewMode(
  url: URL,
  cookies: Readonly<Record<string, string>>,
  options?: { previewParam?: string; previewBucketParam?: string },
): ResolvedLocalPreviewMode {
  const previewParam = options?.previewParam ?? DEFAULT_PREVIEW_PARAM;
  const previewBucketParam = options?.previewBucketParam ?? DEFAULT_PREVIEW_BUCKET_PARAM;

  const queryLocalMode = url.searchParams.get(LOCAL_MODE_QUERY_PARAM);
  if (queryLocalMode !== null) {
    const parsed = deserializeLocalPreviewMode(queryLocalMode.trim());
    return {
      mode: parsed,
      fromQuery: true,
      setCookieValue: serializeLocalPreviewMode(parsed),
    };
  }

  const queryPreviewExp = url.searchParams.get(previewParam)?.trim();
  const queryBucket = url.searchParams.get(previewBucketParam)?.trim();

  if (queryBucket === "default") {
    return {
      mode: { kind: "default" },
      fromQuery: true,
    };
  }

  if (queryPreviewExp && queryPreviewExp.length > 0) {
    const bucket: "variant" | "control" = queryBucket === "control" ? "control" : "variant";
    return {
      mode: { kind: "experience", experienceId: queryPreviewExp, bucket },
      fromQuery: true,
    };
  }

  const cookieVal = getOwn(cookies, LOCAL_MODE_COOKIE_NAME);
  return {
    mode: deserializeLocalPreviewMode(cookieVal),
    fromQuery: false,
  };
}

export function buildPreviewBarHtml(options: PreviewBarOptions): string {
  const { config, evaluation, mode } = options;
  const selectedExpId = mode.kind === "experience" ? mode.experienceId : "";
  const selectedBucket = mode.kind === "experience" ? mode.bucket : "variant";

  const matchedSummary =
    evaluation.matched.length > 0
      ? evaluation.matched
          .map((item) => `${escapeHtml(item.experienceId)} (${escapeHtml(item.bucket)})`)
          .join(", ")
      : "None (original page)";

  const modeLabel =
    mode.kind === "auto"
      ? "Auto"
      : mode.kind === "default"
        ? "Default"
        : `Forced: ${mode.experienceId} (${mode.bucket})`;

  const optionTags = config.experiences
    .map((exp) => {
      const selected = exp.id === selectedExpId ? " selected" : "";
      const disabledSuffix = exp.enabled ? "" : " [disabled]";
      return `<option value="${escapeHtmlAttr(exp.id)}"${selected}>${escapeHtml(exp.name)} (${escapeHtml(exp.id)})${disabledSuffix}</option>`;
    })
    .join("");

  const barConfigJson = safeJsonForScript({
    cookieName: LOCAL_MODE_COOKIE_NAME,
    queryLocalMode: LOCAL_MODE_QUERY_PARAM,
    previewParam: config.settings.previewParam,
    previewBucketParam: DEFAULT_PREVIEW_BUCKET_PARAM,
    previewSigParam: config.settings.previewSigParam,
  });

  const autoActive = mode.kind === "auto" ? " is-active" : "";
  const defaultActive = mode.kind === "default" ? " is-active" : "";
  const variantActive =
    mode.kind === "experience" && selectedBucket === "variant" ? " is-active" : "";
  const controlActive =
    mode.kind === "experience" && selectedBucket === "control" ? " is-active" : "";
  const bucketDisabled = mode.kind !== "experience" ? " disabled" : "";

  return `<div id="__facet-preview-bar" data-facet-preview-bar="true" data-facet-mode="${escapeHtmlAttr(serializeLocalPreviewMode(mode))}">
<style>
#__facet-preview-bar{position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.4;color:#f8fafc;background:rgba(15,23,42,.95);border:1px solid rgba(148,163,184,.28);border-radius:12px;box-shadow:0 12px 32px rgba(2,6,23,.45);padding:10px 12px;max-width:calc(100vw - 32px);backdrop-filter:blur(8px)}
#__facet-preview-bar *{box-sizing:border-box;font-family:inherit}
#__facet-preview-bar .fpb-row{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
#__facet-preview-bar .fpb-row+.fpb-row{margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,184,.18)}
#__facet-preview-bar .fpb-brand{display:inline-flex;align-items:center;gap:6px;font-weight:700;letter-spacing:.02em;color:#fff;margin-right:4px}
#__facet-preview-bar .fpb-dot{width:8px;height:8px;border-radius:999px;background:#38bdf8;display:inline-block}
#__facet-preview-bar .fpb-btn{appearance:none;border:1px solid rgba(148,163,184,.3);background:rgba(30,41,59,.9);color:#e2e8f0;padding:4px 8px;border-radius:6px;font-size:12px;cursor:pointer;line-height:1.2}
#__facet-preview-bar .fpb-btn:hover:not(:disabled){border-color:#38bdf8;color:#fff}
#__facet-preview-bar .fpb-btn.is-active{background:#0284c7;border-color:#38bdf8;color:#fff;font-weight:600}
#__facet-preview-bar .fpb-btn:disabled{opacity:.45;cursor:not-allowed}
#__facet-preview-bar .fpb-select{background:#1e293b;color:#f8fafc;border:1px solid rgba(148,163,184,.35);border-radius:6px;padding:4px 6px;font-size:12px;max-width:220px}
#__facet-preview-bar .fpb-meta{color:#cbd5e1;font-size:11px}
#__facet-preview-bar .fpb-meta strong{color:#f8fafc}
</style>
<div class="fpb-row">
  <span class="fpb-brand"><span class="fpb-dot"></span>Facet Preview</span>
  <button type="button" class="fpb-btn${autoActive}" data-fpb-action="auto">Auto</button>
  <button type="button" class="fpb-btn${defaultActive}" data-fpb-action="default">Default</button>
  <select class="fpb-select" data-fpb-select aria-label="Select Facet experience">
    <option value="">— Experience —</option>
    ${optionTags}
  </select>
  <button type="button" class="fpb-btn${variantActive}" data-fpb-bucket="variant"${bucketDisabled}>Variant</button>
  <button type="button" class="fpb-btn${controlActive}" data-fpb-bucket="control"${bucketDisabled}>Control</button>
</div>
<div class="fpb-row fpb-meta">
  <span>Mode: <strong>${escapeHtml(modeLabel)}</strong></span>
  <span>&middot;</span>
  <span>Active: <strong>${matchedSummary}</strong></span>
</div>
<script data-facet-preview-bar-script>(function(){try{var cfg=${barConfigJson};var root=document.getElementById("__facet-preview-bar");if(!root)return;function setMode(val){document.cookie=cfg.cookieName+"="+encodeURIComponent(val)+"; path=/; SameSite=Lax";var u=new URL(window.location.href);u.searchParams.delete(cfg.queryLocalMode);u.searchParams.delete(cfg.previewParam);u.searchParams.delete(cfg.previewBucketParam);u.searchParams.delete(cfg.previewSigParam);window.location.assign(u.toString());}var sel=root.querySelector("[data-fpb-select]");root.querySelectorAll("[data-fpb-action]").forEach(function(btn){btn.addEventListener("click",function(){setMode(btn.getAttribute("data-fpb-action")||"auto");});});if(sel){sel.addEventListener("change",function(){if(!sel.value){setMode("auto");}else{setMode("exp:"+sel.value+":variant");}});}root.querySelectorAll("[data-fpb-bucket]").forEach(function(btn){btn.addEventListener("click",function(){var expId=sel&&sel.value;if(!expId)return;var b=btn.getAttribute("data-fpb-bucket")==="control"?"control":"variant";setMode("exp:"+expId+":"+b);});});}catch(_){}})();</script>
</div>`;
}
