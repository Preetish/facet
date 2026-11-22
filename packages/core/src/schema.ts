import { z } from "zod";

export const ANALYTICS_PROVIDERS = ["ga4", "umami", "posthog", "custom"] as const;
export type AnalyticsProvider = (typeof ANALYTICS_PROVIDERS)[number];

export const DEFAULT_COOKIE_NAME = "__facet_vid";
export const DEFAULT_PREVIEW_PARAM = "__facet_preview";
export const DEFAULT_PREVIEW_SIG_PARAM = "__facet_sig";
export const DEFAULT_PREVIEW_BUCKET_PARAM = "__facet_bucket";
export const DEFAULT_ENRICHMENT_TIMEOUT_MS = 150;
export const DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS = 3600;

export const DOTTED_MATCH_PREFIXES = ["query", "cookie", "header", "geo", "company"] as const;
export type DottedMatchPrefix = (typeof DOTTED_MATCH_PREFIXES)[number];

export const MATCH_TOP_LEVEL_KEYS = [
  "path",
  "host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "referrer",
  "returning",
] as const;

export const MATCH_COMBINATOR_KEYS = ["all", "any", "not"] as const;

const KNOWN_TOP_LEVEL_SET = new Set<string>(MATCH_TOP_LEVEL_KEYS);
const KNOWN_NESTED_MAP_SET = new Set<string>(DOTTED_MATCH_PREFIXES);
const KNOWN_COMBINATOR_SET = new Set<string>(MATCH_COMBINATOR_KEYS);
const DOTTED_KEY_PATTERN = /^(query|cookie|header|geo|company)\..+$/;
const EXPERIENCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type MatchScalar = string | number | boolean;

export interface MatchOperator {
  equals?: MatchScalar;
  in?: MatchScalar[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  regex?: string;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  exists?: boolean;
}

export type MatchValue = MatchScalar | MatchScalar[] | MatchOperator;

export interface MatchCondition {
  all?: MatchCondition[];
  any?: MatchCondition[];
  not?: MatchCondition;
  path?: MatchValue;
  host?: MatchValue;
  utm_source?: MatchValue;
  utm_medium?: MatchValue;
  utm_campaign?: MatchValue;
  utm_term?: MatchValue;
  utm_content?: MatchValue;
  referrer?: MatchValue;
  returning?: MatchValue;
  query?: Record<string, MatchValue>;
  cookie?: Record<string, MatchValue>;
  header?: Record<string, MatchValue>;
  geo?: Record<string, MatchValue>;
  company?: Record<string, MatchValue>;
  [dottedKey: `${DottedMatchPrefix}.${string}`]: MatchValue | undefined;
}

export const analyticsProviderSchema = z.enum(ANALYTICS_PROVIDERS);

export const enrichmentSettingsSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(DEFAULT_ENRICHMENT_TIMEOUT_MS),
    cacheTtlSeconds: z.number().int().nonnegative().default(DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS),
  })
  .strict();

export type EnrichmentSettings = z.infer<typeof enrichmentSettingsSchema>;

export const analyticsSettingsSchema = z
  .object({
    providers: z.array(analyticsProviderSchema).default([]),
  })
  .strict();

export type AnalyticsSettings = z.infer<typeof analyticsSettingsSchema>;

export const settingsSchema = z
  .object({
    cookieName: z.string().trim().min(1).default(DEFAULT_COOKIE_NAME),
    previewParam: z.string().trim().min(1).default(DEFAULT_PREVIEW_PARAM),
    previewSigParam: z.string().trim().min(1).default(DEFAULT_PREVIEW_SIG_PARAM),
    analytics: analyticsSettingsSchema.default({ providers: [] }),
    slots: z.record(z.string().min(1), z.string()).default({}),
    enrichment: enrichmentSettingsSchema.optional(),
  })
  .strict();

export type FacetSettings = z.infer<typeof settingsSchema>;

export const matchScalarSchema: z.ZodType<MatchScalar> = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

export const matchOperatorSchema: z.ZodType<MatchOperator> = z
  .object({
    equals: matchScalarSchema.optional(),
    in: z.array(matchScalarSchema).min(1).optional(),
    contains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    regex: z
      .string()
      .min(1)
      .superRefine((pattern, ctx) => {
        try {
          new RegExp(pattern);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid regular expression "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })
      .optional(),
    gt: z.number().finite().optional(),
    gte: z.number().finite().optional(),
    lt: z.number().finite().optional(),
    lte: z.number().finite().optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .superRefine((op, ctx) => {
    const definedKeys = Object.entries(op).filter(([, value]) => value !== undefined);
    if (definedKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Match operator object must specify at least one operator",
      });
    }
  });

export const matchValueSchema: z.ZodType<MatchValue> = z.union([
  matchScalarSchema,
  z.array(matchScalarSchema).min(1),
  matchOperatorSchema,
]);

const nestedMatchRecordSchema = z.record(z.string().min(1), matchValueSchema);

export const matchConditionSchema: z.ZodType<MatchCondition, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .record(z.string(), z.unknown())
    .superRefine((obj, ctx) => {
      for (const [key, rawValue] of Object.entries(obj)) {
        if (key === "all" || key === "any") {
          const parsed = z.array(matchConditionSchema).min(1).safeParse(rawValue);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) {
              ctx.addIssue({
                ...issue,
                path: [key, ...issue.path],
              });
            }
          }
          continue;
        }

        if (key === "not") {
          const parsed = matchConditionSchema.safeParse(rawValue);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) {
              ctx.addIssue({
                ...issue,
                path: [key, ...issue.path],
              });
            }
          }
          continue;
        }

        if (KNOWN_NESTED_MAP_SET.has(key)) {
          const parsed = nestedMatchRecordSchema.safeParse(rawValue);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) {
              ctx.addIssue({
                ...issue,
                path: [key, ...issue.path],
              });
            }
          }
          continue;
        }

        if (KNOWN_TOP_LEVEL_SET.has(key) || DOTTED_KEY_PATTERN.test(key)) {
          const parsed = matchValueSchema.safeParse(rawValue);
          if (!parsed.success) {
            for (const issue of parsed.error.issues) {
              ctx.addIssue({
                ...issue,
                path: [key, ...issue.path],
              });
            }
          }
          continue;
        }

        if (!KNOWN_COMBINATOR_SET.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `Unknown match key "${key}". Use a built-in field, combinator (all/any/not), or dotted key (query.*, cookie.*, header.*, geo.*, company.*).`,
          });
        }
      }
    })
    .transform((obj) => obj as MatchCondition),
);

const classListSchema = z.union([
  z.string().trim().min(1),
  z.array(z.string().trim().min(1)).min(1),
]);

export const changeSchema = z
  .object({
    selector: z.string().trim().min(1, "Selector must be a non-empty CSS selector"),
    text: z.string().optional(),
    html: z.string().optional(),
    slot: z.string().trim().min(1).optional(),
    attrs: z.record(z.string().min(1), z.union([z.string(), z.null()])).optional(),
    addClass: classListSchema.optional(),
    removeClass: classListSchema.optional(),
    remove: z.boolean().optional(),
    prepend: z.string().optional(),
    append: z.string().optional(),
  })
  .strict()
  .superRefine((change, ctx) => {
    const bodyMutations: string[] = [];
    if (change.text !== undefined) bodyMutations.push("text");
    if (change.html !== undefined) bodyMutations.push("html");
    if (change.slot !== undefined) bodyMutations.push("slot");

    if (bodyMutations.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Change for selector "${change.selector}" cannot combine mutually exclusive body replacements: ${bodyMutations.join(", ")}`,
      });
    }

    const hasAttrs = change.attrs !== undefined && Object.keys(change.attrs).length > 0;
    const hasNonRemoveMutation =
      bodyMutations.length > 0 ||
      hasAttrs ||
      change.addClass !== undefined ||
      change.removeClass !== undefined ||
      change.prepend !== undefined ||
      change.append !== undefined;

    if (change.remove === true && hasNonRemoveMutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Change for selector "${change.selector}" cannot combine "remove: true" with other mutations`,
      });
    }

    const hasMutation = hasNonRemoveMutation || change.remove === true;

    if (!hasMutation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Change for selector "${change.selector}" must specify at least one mutation (text, html, slot, attrs, addClass, removeClass, remove, prepend, or append)`,
      });
    }
  });

export type FacetChange = z.infer<typeof changeSchema>;

export const experienceSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1, "Experience id is required")
      .regex(
        EXPERIENCE_ID_PATTERN,
        "Experience id must start with an alphanumeric character and contain only letters, digits, '.', '_', or '-'",
      ),
    name: z.string().trim().min(1, "Experience name is required"),
    enabled: z.boolean().default(true),
    priority: z.number().finite().default(0),
    stopOnMatch: z.boolean().default(true),
    holdout: z
      .number()
      .min(0, "Holdout must be between 0 and 1")
      .max(1, "Holdout must be between 0 and 1")
      .default(0),
    match: matchConditionSchema,
    changes: z.array(changeSchema).min(1, "Experience must specify at least one change"),
  })
  .strict();

export type FacetExperience = z.infer<typeof experienceSchema>;

export const facetConfigSchema = z
  .object({
    version: z.literal(1),
    settings: settingsSchema.default({}),
    experiences: z.array(experienceSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seenIds = new Set<string>();

    for (let i = 0; i < config.experiences.length; i++) {
      const exp = config.experiences[i];
      if (!exp) continue;

      if (seenIds.has(exp.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["experiences", i, "id"],
          message: `Duplicate experience id "${exp.id}"`,
        });
      } else {
        seenIds.add(exp.id);
      }
    }
  });

export type FacetConfig = z.infer<typeof facetConfigSchema>;
