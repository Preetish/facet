import { assignBucket, generateVisitorId, type Bucket } from "./bucketing.js";
import type { ContextPrimitive, RequestContext } from "./context.js";
import { extractPathParams, matchesConditionWithParams, matchesPathValue } from "./matcher.js";
import type { ExperienceLookup, FacetConfig, FacetExperience } from "./schema.js";
import {
  STICKY_SIGNAL_KEYS,
  normalizeNowSeconds,
  parseStickyCookie,
  parseStickyDurationSeconds,
  serializeStickyCookie,
  type StickyCookieDirective,
  type StickyExperienceEntry,
  type StickySignals,
  type StickyState,
} from "./sticky.js";
import {
  buildTemplateContext,
  interpolateTemplate,
  isForbiddenTemplateKey,
  type TemplateContext,
} from "./templates.js";
import { resolveChange, type ResolvedChange } from "./transforms.js";

export type PreviewBucket = "variant" | "control" | "default";

export const PERSONALIZED_CACHE_CONTROL = "private, no-store";

export interface EvaluateOptions {
  visitorId?: string;
  previewExperienceId?: string;
  previewBucket?: PreviewBucket;
  generateVisitorId?: () => string;
  now?: number;
}

export interface MatchedExperience {
  experienceId: string;
  name: string;
  priority: number;
  bucket: Bucket;
  holdout: number;
  applied: boolean;
  preview: boolean;
}

export interface EvaluationResult {
  visitorId: string;
  isNewVisitor: boolean;
  matched: MatchedExperience[];
  activeChanges: ResolvedChange[];
  personalized: boolean;
  previewMode: boolean;
  cacheControl: string | null;
  originPath: string | null;
  stickyCookie: StickyCookieDirective | null;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveVisitor(
  config: FacetConfig,
  context: RequestContext,
  options?: EvaluateOptions,
): { visitorId: string; isNewVisitor: boolean } {
  if (options?.visitorId && options.visitorId.length > 0) {
    return { visitorId: options.visitorId, isNewVisitor: false };
  }
  if (context.visitorId && context.visitorId.length > 0) {
    return { visitorId: context.visitorId, isNewVisitor: false };
  }
  const cookieName = config.settings.cookieName;
  const cookieVid = hasOwn(context.cookies, cookieName) ? context.cookies[cookieName] : undefined;
  if (cookieVid && cookieVid.length > 0) {
    return { visitorId: cookieVid, isNewVisitor: false };
  }
  const factory = options?.generateVisitorId ?? generateVisitorId;
  return { visitorId: factory(), isNewVisitor: true };
}

function resolveExperienceChanges(
  experience: FacetExperience,
  slots: Readonly<Record<string, string>>,
  templateContext: TemplateContext,
): ResolvedChange[] {
  return experience.changes.map((change) =>
    resolveChange(change, experience.id, slots, templateContext),
  );
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveSafeOriginPath(
  rawOriginPath: string,
  templateContext: TemplateContext,
): string | null {
  const resolved = interpolateTemplate(rawOriginPath, templateContext, { escapeHtml: false });
  if (
    !resolved.startsWith("/") ||
    resolved.startsWith("//") ||
    resolved.includes("\\") ||
    /[\r\n]/.test(resolved)
  ) {
    return null;
  }
  const pathnamePart = resolved.split(/[?#]/, 1)[0] ?? "";
  if (/(^|\/)\.\.(\/|$)/.test(pathnamePart)) {
    return null;
  }
  const decodedPathname = safeDecodeUri(pathnamePart);
  if (decodedPathname.includes("\\") || /(^|\/)\.\.(\/|$)/.test(decodedPathname)) {
    return null;
  }
  return resolved;
}

interface LookupResult {
  found: boolean;
  key?: string;
  row?: Record<string, ContextPrimitive>;
}

function resolveExperienceLookup(
  config: FacetConfig,
  lookup: ExperienceLookup,
  templateContext: TemplateContext,
  forcedKey?: string,
): LookupResult {
  const key =
    forcedKey !== undefined
      ? forcedKey
      : interpolateTemplate(lookup.key, templateContext, { escapeHtml: false });

  if (key.length === 0 || isForbiddenTemplateKey(lookup.table) || isForbiddenTemplateKey(key)) {
    return { found: false };
  }

  const tables = config.data;
  if (!tables || !hasOwn(tables, lookup.table)) {
    return { found: false, key };
  }

  const table = tables[lookup.table];
  if (!table || !hasOwn(table, key)) {
    return { found: false, key };
  }

  const row = table[key];
  if (!row) {
    return { found: false, key };
  }

  return { found: true, key, row };
}

function hydrateContextFromSticky(
  context: RequestContext,
  signals: StickySignals,
): { effectiveContext: RequestContext; hydratedAny: boolean } {
  const nextQuery: Record<string, string> = { ...context.query };
  const effectiveContext: RequestContext = {
    ...context,
    query: nextQuery,
  };
  let hydratedAny = false;

  const utmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

  for (const key of utmKeys) {
    const stickyVal = signals[key];
    if (stickyVal === undefined || stickyVal.length === 0) {
      continue;
    }
    const currentVal = effectiveContext[key];
    if (currentVal === undefined || currentVal.length === 0) {
      effectiveContext[key] = stickyVal;
      if (!hasOwn(nextQuery, key) || (nextQuery[key]?.length ?? 0) === 0) {
        nextQuery[key] = stickyVal;
      }
      hydratedAny = true;
    }
  }

  const stickyAcct = signals.acct;
  if (stickyAcct !== undefined && stickyAcct.length > 0) {
    const currentAcct = hasOwn(nextQuery, "acct") ? nextQuery["acct"] : undefined;
    if (currentAcct === undefined || currentAcct.length === 0) {
      nextQuery["acct"] = stickyAcct;
      hydratedAny = true;
    }
  }

  return { effectiveContext, hydratedAny };
}

function extractFreshAttributionSignals(context: RequestContext): StickySignals {
  const fresh: StickySignals = {};
  if (context.utm_source && context.utm_source.length > 0) {
    fresh.utm_source = context.utm_source;
  }
  if (context.utm_medium && context.utm_medium.length > 0) {
    fresh.utm_medium = context.utm_medium;
  }
  if (context.utm_campaign && context.utm_campaign.length > 0) {
    fresh.utm_campaign = context.utm_campaign;
  }
  if (context.utm_term && context.utm_term.length > 0) {
    fresh.utm_term = context.utm_term;
  }
  if (context.utm_content && context.utm_content.length > 0) {
    fresh.utm_content = context.utm_content;
  }
  const queryAcct = hasOwn(context.query, "acct") ? context.query["acct"] : undefined;
  if (queryAcct && queryAcct.length > 0) {
    fresh.acct = queryAcct;
  }
  return fresh;
}

function cloneStickyState(state: StickyState): StickyState {
  const experiences: Record<string, StickyExperienceEntry> = {};
  for (const [id, entry] of Object.entries(state.experiences)) {
    experiences[id] = { ...entry };
  }
  return {
    v: 1,
    experiences,
    signals: { ...state.signals },
  };
}

function computeMaxDuration(durations: readonly (number | null)[]): number | null {
  let maxSeconds: number | null = null;
  for (const d of durations) {
    if (d !== null && (maxSeconds === null || d > maxSeconds)) {
      maxSeconds = d;
    }
  }
  return maxSeconds;
}

function computeStickyCookieMaxAge(state: StickyState, nowSec: number): number | null {
  let maxExp: number | null = null;
  for (const entry of Object.values(state.experiences)) {
    if (entry.exp !== undefined && (maxExp === null || entry.exp > maxExp)) {
      maxExp = entry.exp;
    }
  }
  if (state.signals.exp !== undefined && (maxExp === null || state.signals.exp > maxExp)) {
    maxExp = state.signals.exp;
  }
  if (maxExp === null) {
    return null;
  }
  return Math.max(0, maxExp - nowSec);
}

export function evaluate(
  config: FacetConfig,
  context: RequestContext,
  options?: EvaluateOptions,
): EvaluationResult {
  const { visitorId, isNewVisitor } = resolveVisitor(config, context, options);
  const slots = config.settings.slots;
  const nowSec = normalizeNowSeconds(options?.now);
  const stickyCookieName = config.settings.stickyCookieName;
  const rawStickyCookie = hasOwn(context.cookies, stickyCookieName)
    ? context.cookies[stickyCookieName]
    : undefined;
  const incomingSticky = parseStickyCookie(rawStickyCookie, nowSec);
  const { effectiveContext, hydratedAny } = hydrateContextFromSticky(
    context,
    incomingSticky.signals,
  );

  if (options?.previewBucket === "default") {
    return {
      visitorId,
      isNewVisitor,
      matched: [],
      activeChanges: [],
      personalized: false,
      previewMode: true,
      cacheControl: PERSONALIZED_CACHE_CONTROL,
      originPath: null,
      stickyCookie: null,
    };
  }

  if (options?.previewExperienceId !== undefined && options.previewExperienceId.length > 0) {
    const target = config.experiences.find((exp) => exp.id === options.previewExperienceId);
    if (!target) {
      return {
        visitorId,
        isNewVisitor,
        matched: [],
        activeChanges: [],
        personalized: false,
        previewMode: true,
        cacheControl: PERSONALIZED_CACHE_CONTROL,
        originPath: null,
        stickyCookie: null,
      };
    }

    const params = extractPathParams(target.match, effectiveContext.path);
    const baseTplCtx = buildTemplateContext(effectiveContext, { params });
    const lookupRes =
      target.lookup !== undefined
        ? resolveExperienceLookup(config, target.lookup, baseTplCtx)
        : undefined;
    const tplCtx = buildTemplateContext(effectiveContext, {
      params,
      ...(lookupRes?.row !== undefined ? { data: lookupRes.row } : {}),
    });

    const bucket: Bucket = options.previewBucket === "control" ? "control" : "variant";
    const applied = bucket === "variant";
    const activeChanges = applied ? resolveExperienceChanges(target, slots, tplCtx) : [];
    const originPath =
      target.originPath !== undefined ? resolveSafeOriginPath(target.originPath, tplCtx) : null;

    return {
      visitorId,
      isNewVisitor,
      matched: [
        {
          experienceId: target.id,
          name: target.name,
          priority: target.priority,
          bucket,
          holdout: target.holdout,
          applied,
          preview: true,
        },
      ],
      activeChanges,
      personalized: applied && activeChanges.length > 0,
      previewMode: true,
      cacheControl: PERSONALIZED_CACHE_CONTROL,
      originPath,
      stickyCookie: null,
    };
  }

  const enabledExperiences = config.experiences
    .map((experience, index) => ({ experience, index }))
    .filter(({ experience }) => experience.enabled)
    .sort((a, b) => {
      if (b.experience.priority !== a.experience.priority) {
        return b.experience.priority - a.experience.priority;
      }
      return a.index - b.index;
    });

  const allStickyDurations: Array<number | null> = [];
  for (const { experience } of enabledExperiences) {
    const dur = parseStickyDurationSeconds(experience.sticky);
    if (dur !== undefined) {
      allStickyDurations.push(dur);
    }
  }
  const hasAnyStickyExperience = allStickyDurations.length > 0;

  const matched: MatchedExperience[] = [];
  const activeChanges: ResolvedChange[] = [];
  let resolvedOriginPath: string | null = null;

  const nextSticky = cloneStickyState(incomingSticky);
  const matchedStickyDurations: Array<number | null> = [];
  let stickyDirty = false;
  let usedStickyReadMatch = false;

  for (const { experience } of enabledExperiences) {
    const stickyDuration = parseStickyDurationSeconds(experience.sticky);
    const isStickyEnabled = stickyDuration !== undefined;

    let params: Record<string, string> = {};
    let dataRow: Record<string, ContextPrimitive> | undefined;
    let resolvedDataKey: string | undefined;
    let isFreshMatch = false;
    let isHydratedMatch = false;
    let matchedExperience = false;
    let explicitFreshLookupMissed = false;

    // Tier 1: Fresh match against raw context (condition + lookup)
    const freshCond = matchesConditionWithParams(experience.match, context);
    if (freshCond.matched) {
      if (experience.lookup === undefined) {
        matchedExperience = true;
        isFreshMatch = true;
        params = freshCond.params;
      } else {
        const rawTplCtx = buildTemplateContext(context, { params: freshCond.params });
        const freshLookup = resolveExperienceLookup(config, experience.lookup, rawTplCtx);
        if (freshLookup.found) {
          matchedExperience = true;
          isFreshMatch = true;
          params = freshCond.params;
          dataRow = freshLookup.row;
          resolvedDataKey = freshLookup.key;
        } else if (freshLookup.key !== undefined && freshLookup.key.length > 0) {
          // An explicit fresh key was provided and did not exist in the lookup table;
          // do not override it with stale sticky state.
          explicitFreshLookupMissed = true;
          if (experience.lookup.required === false) {
            matchedExperience = true;
            isFreshMatch = true;
            params = freshCond.params;
          }
        }
      }
    }

    // Tier 2: Hydrated match using unexpired sticky attribution signals (utm_* / query.acct)
    if (!matchedExperience && !explicitFreshLookupMissed && hydratedAny) {
      const hydratedCond = matchesConditionWithParams(experience.match, effectiveContext);
      if (hydratedCond.matched) {
        if (experience.lookup === undefined) {
          matchedExperience = true;
          isHydratedMatch = true;
          params = hydratedCond.params;
          usedStickyReadMatch = true;
        } else {
          const hydratedTplCtx = buildTemplateContext(effectiveContext, {
            params: hydratedCond.params,
          });
          const hydratedLookup = resolveExperienceLookup(config, experience.lookup, hydratedTplCtx);
          if (hydratedLookup.found) {
            matchedExperience = true;
            isHydratedMatch = true;
            params = hydratedCond.params;
            dataRow = hydratedLookup.row;
            resolvedDataKey = hydratedLookup.key;
            usedStickyReadMatch = true;
          }
        }
      }
    }

    // Tier 3: Stored sticky experience entry fallback (respects top-level match.path and stored dataKey)
    if (
      !matchedExperience &&
      !explicitFreshLookupMissed &&
      isStickyEnabled &&
      hasOwn(incomingSticky.experiences, experience.id)
    ) {
      let pathOk = true;
      let stickyParams: Record<string, string> = {};
      if (experience.match.path !== undefined) {
        const pathCheck = matchesPathValue(experience.match.path, context.path);
        pathOk = pathCheck.matched;
        stickyParams = pathCheck.params;
      }

      if (pathOk) {
        const stickyEntry = incomingSticky.experiences[experience.id];
        if (experience.lookup === undefined) {
          matchedExperience = true;
          params = stickyParams;
          usedStickyReadMatch = true;
        } else {
          const baseTplCtx = buildTemplateContext(effectiveContext, { params: stickyParams });
          const stickyLookup = resolveExperienceLookup(
            config,
            experience.lookup,
            baseTplCtx,
            stickyEntry?.dataKey,
          );
          if (stickyLookup.found || experience.lookup.required === false) {
            matchedExperience = true;
            params = stickyParams;
            if (stickyLookup.found) {
              dataRow = stickyLookup.row;
              resolvedDataKey = stickyLookup.key;
            }
            usedStickyReadMatch = true;
          }
        }
      }
    }

    // Fallback for optional lookup (`required: false`) when fresh condition matched with an empty key
    // and neither hydrated signals nor stored sticky state provided a row.
    if (
      !matchedExperience &&
      !explicitFreshLookupMissed &&
      freshCond.matched &&
      experience.lookup !== undefined &&
      experience.lookup.required === false
    ) {
      matchedExperience = true;
      isFreshMatch = true;
      params = freshCond.params;
    }

    if (!matchedExperience) {
      continue;
    }

    const tplCtx = buildTemplateContext(effectiveContext, {
      params,
      ...(dataRow !== undefined ? { data: dataRow } : {}),
    });

    const bucket = assignBucket(visitorId, experience.id, experience.holdout);
    const applied = bucket === "variant";

    matched.push({
      experienceId: experience.id,
      name: experience.name,
      priority: experience.priority,
      bucket,
      holdout: experience.holdout,
      applied,
      preview: false,
    });

    if (resolvedOriginPath === null && experience.originPath !== undefined) {
      resolvedOriginPath = resolveSafeOriginPath(experience.originPath, tplCtx);
    }

    if (applied) {
      activeChanges.push(...resolveExperienceChanges(experience, slots, tplCtx));
    }

    if (isStickyEnabled) {
      if (isFreshMatch) {
        const entry: StickyExperienceEntry = {};
        if (stickyDuration !== null) {
          entry.exp = nowSec + stickyDuration;
        }
        if (resolvedDataKey !== undefined) {
          entry.dataKey = resolvedDataKey;
        }
        nextSticky.experiences[experience.id] = entry;
        matchedStickyDurations.push(stickyDuration);
        stickyDirty = true;
      } else if (isHydratedMatch && !hasOwn(incomingSticky.experiences, experience.id)) {
        const entry: StickyExperienceEntry = {};
        const signalExp = incomingSticky.signals.exp;
        if (stickyDuration === null) {
          if (signalExp !== undefined) {
            entry.exp = signalExp;
          }
        } else if (signalExp !== undefined) {
          entry.exp = Math.min(signalExp, nowSec + stickyDuration);
        } else {
          entry.exp = nowSec + stickyDuration;
        }
        if (resolvedDataKey !== undefined) {
          entry.dataKey = resolvedDataKey;
        }
        nextSticky.experiences[experience.id] = entry;
        stickyDirty = true;
      }
    }

    if (experience.stopOnMatch) {
      break;
    }
  }

  if (hasAnyStickyExperience) {
    const freshSignals = extractFreshAttributionSignals(context);
    const freshKeys = STICKY_SIGNAL_KEYS.filter((k) => freshSignals[k] !== undefined);
    if (freshKeys.length > 0) {
      const anySignalChanged = freshKeys.some((k) => freshSignals[k] !== incomingSticky.signals[k]);
      if (anySignalChanged || stickyDirty) {
        for (const k of freshKeys) {
          const val = freshSignals[k];
          if (val !== undefined) {
            nextSticky.signals[k] = val;
          }
        }
        const signalDuration =
          matchedStickyDurations.length > 0
            ? computeMaxDuration(matchedStickyDurations)
            : computeMaxDuration(allStickyDurations);
        if (signalDuration !== null) {
          nextSticky.signals.exp = nowSec + signalDuration;
        } else {
          delete nextSticky.signals.exp;
        }
        stickyDirty = true;
      }
    }
  }

  const stickyCookie: StickyCookieDirective | null = stickyDirty
    ? {
        name: stickyCookieName,
        value: serializeStickyCookie(nextSticky, nowSec),
        maxAgeSeconds: computeStickyCookieMaxAge(nextSticky, nowSec),
      }
    : null;

  const personalized = activeChanges.length > 0;
  const cacheControl =
    matched.length > 0 || stickyCookie !== null || usedStickyReadMatch
      ? PERSONALIZED_CACHE_CONTROL
      : null;

  return {
    visitorId,
    isNewVisitor,
    matched,
    activeChanges,
    personalized,
    previewMode: false,
    cacheControl,
    originPath: resolvedOriginPath,
    stickyCookie,
  };
}
