import {
  ANALYTICS_PROVIDERS,
  DEFAULT_COOKIE_NAME,
  DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
  DEFAULT_ENRICHMENT_TIMEOUT_MS,
  DEFAULT_PREVIEW_PARAM,
  DEFAULT_PREVIEW_SIG_PARAM,
} from "./schema.js";

export type JsonSchemaObject = Record<string, unknown>;

export function exportFacetJsonSchema(): JsonSchemaObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://facet.dev/schemas/facet.v1.schema.json",
    title: "Facet Configuration (v1)",
    description: "Configuration schema for facet.yaml edge personalization and ad message-match.",
    type: "object",
    additionalProperties: false,
    required: ["version"],
    properties: {
      version: {
        const: 1,
        description: "Facet schema version (must be 1).",
      },
      settings: {
        $ref: "#/$defs/Settings",
      },
      experiences: {
        type: "array",
        description:
          "Ordered list of personalization experiences evaluated against incoming requests.",
        items: {
          $ref: "#/$defs/Experience",
        },
        default: [],
      },
    },
    $defs: {
      Settings: {
        type: "object",
        additionalProperties: false,
        properties: {
          cookieName: {
            type: "string",
            minLength: 1,
            default: DEFAULT_COOKIE_NAME,
            description: "First-party cookie name used for sticky visitor bucketing.",
          },
          previewParam: {
            type: "string",
            minLength: 1,
            default: DEFAULT_PREVIEW_PARAM,
            description: "Query parameter name for previewing an experience.",
          },
          previewSigParam: {
            type: "string",
            minLength: 1,
            default: DEFAULT_PREVIEW_SIG_PARAM,
            description: "Query parameter name for signed preview tokens.",
          },
          analytics: {
            type: "object",
            additionalProperties: false,
            properties: {
              providers: {
                type: "array",
                items: {
                  type: "string",
                  enum: [...ANALYTICS_PROVIDERS],
                },
                default: [],
                description: "Analytics providers that receive facet_exposure events.",
              },
            },
          },
          slots: {
            type: "object",
            additionalProperties: {
              type: "string",
            },
            default: {},
            description: "Reusable named HTML fragments referenced by change.slot.",
          },
          enrichment: {
            type: "object",
            additionalProperties: false,
            properties: {
              timeoutMs: {
                type: "integer",
                minimum: 1,
                default: DEFAULT_ENRICHMENT_TIMEOUT_MS,
                description: "Hard fail-open timeout in milliseconds for enrichment adapters.",
              },
              cacheTtlSeconds: {
                type: "integer",
                minimum: 0,
                default: DEFAULT_ENRICHMENT_CACHE_TTL_SECONDS,
                description: "Cache TTL in seconds for enrichment lookups.",
              },
            },
          },
        },
      },
      MatchScalar: {
        type: ["string", "number", "boolean"],
      },
      MatchOperator: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          equals: { $ref: "#/$defs/MatchScalar" },
          in: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/MatchScalar" },
          },
          contains: { type: "string" },
          startsWith: { type: "string" },
          endsWith: { type: "string" },
          regex: { type: "string", minLength: 1 },
          gt: { type: "number" },
          gte: { type: "number" },
          lt: { type: "number" },
          lte: { type: "number" },
          exists: { type: "boolean" },
        },
      },
      MatchValue: {
        oneOf: [
          { $ref: "#/$defs/MatchScalar" },
          {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/MatchScalar" },
          },
          { $ref: "#/$defs/MatchOperator" },
        ],
      },
      NestedMatchMap: {
        type: "object",
        additionalProperties: {
          $ref: "#/$defs/MatchValue",
        },
      },
      MatchCondition: {
        type: "object",
        additionalProperties: false,
        properties: {
          all: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/MatchCondition" },
          },
          any: {
            type: "array",
            minItems: 1,
            items: { $ref: "#/$defs/MatchCondition" },
          },
          not: { $ref: "#/$defs/MatchCondition" },
          path: { $ref: "#/$defs/MatchValue" },
          host: { $ref: "#/$defs/MatchValue" },
          utm_source: { $ref: "#/$defs/MatchValue" },
          utm_medium: { $ref: "#/$defs/MatchValue" },
          utm_campaign: { $ref: "#/$defs/MatchValue" },
          utm_term: { $ref: "#/$defs/MatchValue" },
          utm_content: { $ref: "#/$defs/MatchValue" },
          referrer: { $ref: "#/$defs/MatchValue" },
          returning: { $ref: "#/$defs/MatchValue" },
          query: { $ref: "#/$defs/NestedMatchMap" },
          cookie: { $ref: "#/$defs/NestedMatchMap" },
          header: { $ref: "#/$defs/NestedMatchMap" },
          geo: { $ref: "#/$defs/NestedMatchMap" },
          company: { $ref: "#/$defs/NestedMatchMap" },
        },
        patternProperties: {
          "^(query|cookie|header|geo|company)\\..+$": {
            $ref: "#/$defs/MatchValue",
          },
        },
      },
      ClassList: {
        oneOf: [
          { type: "string", minLength: 1 },
          {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        ],
      },
      Change: {
        type: "object",
        additionalProperties: false,
        required: ["selector"],
        properties: {
          selector: {
            type: "string",
            minLength: 1,
            description: "CSS selector targeting the element(s) to transform.",
          },
          text: {
            type: "string",
            description: "Safe HTML-escaped text replacement.",
          },
          html: {
            type: "string",
            description: "Explicit raw HTML replacement.",
          },
          slot: {
            type: "string",
            minLength: 1,
            description:
              "Named slot key resolved from settings.slots (if defined) or by a downstream adapter such as <FacetSlot />.",
          },
          attrs: {
            type: "object",
            additionalProperties: {
              type: ["string", "null"],
            },
            description: "Attributes to set (string) or remove (null).",
          },
          addClass: {
            $ref: "#/$defs/ClassList",
          },
          removeClass: {
            $ref: "#/$defs/ClassList",
          },
          remove: {
            type: "boolean",
            description: "When true, removes the matched element from the DOM.",
          },
          prepend: {
            type: "string",
            description: "HTML or text prepended inside the matched element.",
          },
          append: {
            type: "string",
            description: "HTML or text appended inside the matched element.",
          },
        },
      },
      Experience: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "match", "changes"],
        properties: {
          id: {
            type: "string",
            minLength: 1,
            pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
            description: "Unique identifier for this experience.",
          },
          name: {
            type: "string",
            minLength: 1,
            description: "Human-readable name for reporting and preview UI.",
          },
          enabled: {
            type: "boolean",
            default: true,
          },
          priority: {
            type: "number",
            default: 0,
            description: "Higher priority experiences are evaluated first.",
          },
          stopOnMatch: {
            type: "boolean",
            default: true,
            description: "Stop evaluating lower-priority experiences when this experience matches.",
          },
          holdout: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0,
            description:
              "Fraction of matched visitors deterministically held back as control (0..1).",
          },
          match: {
            $ref: "#/$defs/MatchCondition",
          },
          changes: {
            type: "array",
            minItems: 1,
            items: {
              $ref: "#/$defs/Change",
            },
          },
        },
      },
    },
  };
}
