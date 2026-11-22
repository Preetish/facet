import type { Bucket } from "./bucketing.js";
import type { MatchedExperience } from "./evaluator.js";
import type { AnalyticsProvider } from "./schema.js";

export interface AnalyticsExposure {
  experienceId: string;
  bucket: Bucket;
}

export function toAnalyticsExposures(matched: readonly MatchedExperience[]): AnalyticsExposure[] {
  return matched.map((item) => ({
    experienceId: item.experienceId,
    bucket: item.bucket,
  }));
}

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildAnalyticsSnippet(
  exposures: readonly AnalyticsExposure[],
  providers: readonly AnalyticsProvider[],
): string {
  if (exposures.length === 0 || providers.length === 0) {
    return "";
  }

  const uniqueProviders = Array.from(new Set(providers));
  const sanitizedExposures: AnalyticsExposure[] = exposures.map((e) => ({
    experienceId: String(e.experienceId),
    bucket: e.bucket === "control" ? "control" : "variant",
  }));

  const payloadJson = safeJsonForScript(sanitizedExposures);
  const dispatches: string[] = [];

  for (const provider of uniqueProviders) {
    switch (provider) {
      case "ga4":
        dispatches.push(
          'if(typeof window.gtag==="function"){window.gtag("event","facet_exposure",{experience_id:e.experienceId,bucket:e.bucket});}',
        );
        break;
      case "umami":
        dispatches.push(
          'if(window.umami&&typeof window.umami.track==="function"){window.umami.track("facet_exposure",{experience_id:e.experienceId,bucket:e.bucket});}',
        );
        break;
      case "posthog":
        dispatches.push(
          'if(window.posthog&&typeof window.posthog.capture==="function"){window.posthog.capture("facet_exposure",{experience_id:e.experienceId,bucket:e.bucket});}',
        );
        break;
      case "custom":
        dispatches.push(
          'if(typeof window.dispatchEvent==="function"&&typeof CustomEvent==="function"){window.dispatchEvent(new CustomEvent("facet:exposure",{detail:{experienceId:e.experienceId,bucket:e.bucket}}));}',
        );
        break;
    }
  }

  return `<script data-facet-analytics>(function(){try{var exposures=${payloadJson};for(var i=0;i<exposures.length;i++){var e=exposures[i];${dispatches.join("")}}}catch(_){}})();</script>`;
}
