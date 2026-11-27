import {
  DEFAULT_COOKIE_NAME,
  DEFAULT_PREVIEW_PARAM,
  DEFAULT_PREVIEW_SIG_PARAM,
  DEFAULT_STICKY_COOKIE_NAME,
  type FacetChange,
  type FacetConfig,
  type FacetExperience,
} from "@facet/core";
import { stringify } from "yaml";

function cleanChange(change: FacetChange): Record<string, unknown> {
  const out: Record<string, unknown> = {
    selector: change.selector,
  };
  if (change.text !== undefined) out["text"] = change.text;
  if (change.html !== undefined) out["html"] = change.html;
  if (change.slot !== undefined) out["slot"] = change.slot;
  if (change.attrs !== undefined && Object.keys(change.attrs).length > 0) {
    out["attrs"] = change.attrs;
  }
  if (change.addClass !== undefined) out["addClass"] = change.addClass;
  if (change.removeClass !== undefined) out["removeClass"] = change.removeClass;
  if (change.remove === true) out["remove"] = true;
  if (change.prepend !== undefined) out["prepend"] = change.prepend;
  if (change.append !== undefined) out["append"] = change.append;
  return out;
}

function cleanExperience(exp: FacetExperience): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: exp.id,
    name: exp.name,
  };
  if (exp.enabled === false) {
    out["enabled"] = false;
  }
  out["priority"] = exp.priority;
  if (exp.stopOnMatch === false) {
    out["stopOnMatch"] = false;
  }
  if (exp.holdout > 0) {
    out["holdout"] = exp.holdout;
  }
  if (exp.originPath !== undefined && exp.originPath.trim().length > 0) {
    out["originPath"] = exp.originPath;
  }
  if (exp.sticky !== undefined && exp.sticky !== false) {
    out["sticky"] = exp.sticky;
  }
  if (exp.lookup !== undefined) {
    out["lookup"] = {
      table: exp.lookup.table,
      key: exp.lookup.key,
      required: exp.lookup.required,
    };
  }
  out["match"] = exp.match;
  out["changes"] = exp.changes.map(cleanChange);
  return out;
}

export function serializeFacetConfig(config: FacetConfig): string {
  const settingsOut: Record<string, unknown> = {
    cookieName: config.settings.cookieName || DEFAULT_COOKIE_NAME,
    stickyCookieName: config.settings.stickyCookieName || DEFAULT_STICKY_COOKIE_NAME,
    previewParam: config.settings.previewParam || DEFAULT_PREVIEW_PARAM,
    previewSigParam: config.settings.previewSigParam || DEFAULT_PREVIEW_SIG_PARAM,
    analytics: {
      providers: config.settings.analytics.providers,
    },
  };

  if (config.settings.enrichment) {
    settingsOut["enrichment"] = config.settings.enrichment;
  }
  if (config.settings.slots && Object.keys(config.settings.slots).length > 0) {
    settingsOut["slots"] = config.settings.slots;
  }

  const root: Record<string, unknown> = {
    version: 1,
    settings: settingsOut,
  };

  if (config.data && Object.keys(config.data).length > 0) {
    root["data"] = config.data;
  }

  root["experiences"] = config.experiences.map(cleanExperience);

  return stringify(root, {
    indent: 2,
    lineWidth: 100,
    minContentWidth: 20,
  });
}
