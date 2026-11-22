import { buildAnalyticsSnippet, type AnalyticsExposure, type AnalyticsProvider } from "@facet/core";
import { createElement, type ReactElement } from "react";
import type { FacetRequestState } from "./state.js";

export interface FacetAnalyticsProps {
  state: FacetRequestState;
  providers?: readonly AnalyticsProvider[];
  nonce?: string;
  includePreview?: boolean;
}

const SCRIPT_OPEN_TAG = "<script data-facet-analytics>";
const SCRIPT_CLOSE_TAG = "</script>";

function extractInlineScript(snippet: string): string {
  if (snippet.startsWith(SCRIPT_OPEN_TAG) && snippet.endsWith(SCRIPT_CLOSE_TAG)) {
    return snippet.slice(SCRIPT_OPEN_TAG.length, snippet.length - SCRIPT_CLOSE_TAG.length);
  }
  return "";
}

export function FacetAnalytics(props: FacetAnalyticsProps): ReactElement | null {
  const { state, providers, nonce, includePreview = false } = props;

  if (state.previewMode && !includePreview) {
    return null;
  }

  const effectiveProviders = providers ?? state.analyticsProviders;
  if (state.matched.length === 0 || effectiveProviders.length === 0) {
    return null;
  }

  const exposures: AnalyticsExposure[] = state.matched.map((item) => ({
    experienceId: item.experienceId,
    bucket: item.bucket,
  }));

  const snippet = buildAnalyticsSnippet(exposures, effectiveProviders);
  const inlineCode = extractInlineScript(snippet);
  if (inlineCode.length === 0) {
    return null;
  }

  return createElement("script", {
    "data-facet-analytics": "",
    ...(nonce !== undefined ? { nonce } : {}),
    dangerouslySetInnerHTML: { __html: inlineCode },
  });
}
