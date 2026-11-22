import { assignBucket, generateVisitorId, type Bucket } from "./bucketing.js";
import type { RequestContext } from "./context.js";
import { matchesCondition } from "./matcher.js";
import type { FacetConfig, FacetExperience } from "./schema.js";
import { resolveChange, type ResolvedChange } from "./transforms.js";

export type PreviewBucket = "variant" | "control" | "default";

export const PERSONALIZED_CACHE_CONTROL = "private, no-store";

export interface EvaluateOptions {
  visitorId?: string;
  previewExperienceId?: string;
  previewBucket?: PreviewBucket;
  generateVisitorId?: () => string;
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
  const cookieVid = Object.prototype.hasOwnProperty.call(context.cookies, cookieName)
    ? context.cookies[cookieName]
    : undefined;
  if (cookieVid && cookieVid.length > 0) {
    return { visitorId: cookieVid, isNewVisitor: false };
  }
  const factory = options?.generateVisitorId ?? generateVisitorId;
  return { visitorId: factory(), isNewVisitor: true };
}

function resolveExperienceChanges(
  experience: FacetExperience,
  slots: Readonly<Record<string, string>>,
): ResolvedChange[] {
  return experience.changes.map((change) => resolveChange(change, experience.id, slots));
}

export function evaluate(
  config: FacetConfig,
  context: RequestContext,
  options?: EvaluateOptions,
): EvaluationResult {
  const { visitorId, isNewVisitor } = resolveVisitor(config, context, options);
  const slots = config.settings.slots;

  if (options?.previewBucket === "default") {
    return {
      visitorId,
      isNewVisitor,
      matched: [],
      activeChanges: [],
      personalized: false,
      previewMode: true,
      cacheControl: PERSONALIZED_CACHE_CONTROL,
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
      };
    }

    const bucket: Bucket = options.previewBucket === "control" ? "control" : "variant";
    const applied = bucket === "variant";
    const activeChanges = applied ? resolveExperienceChanges(target, slots) : [];

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

  const matched: MatchedExperience[] = [];
  const activeChanges: ResolvedChange[] = [];

  for (const { experience } of enabledExperiences) {
    if (!matchesCondition(experience.match, context)) {
      continue;
    }

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

    if (applied) {
      activeChanges.push(...resolveExperienceChanges(experience, slots));
    }

    if (experience.stopOnMatch) {
      break;
    }
  }

  const personalized = activeChanges.length > 0;
  const cacheControl = matched.length > 0 ? PERSONALIZED_CACHE_CONTROL : null;

  return {
    visitorId,
    isNewVisitor,
    matched,
    activeChanges,
    personalized,
    previewMode: false,
    cacheControl,
  };
}
