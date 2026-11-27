import type {
  FacetChange,
  FacetConfig,
  FacetDataTable,
  FacetExperience,
  MatchCondition,
  MatchScalar,
  MatchValue,
} from "@facet/core";
import { serializeFacetConfig } from "../../shared/yaml-serializer.js";
import { validateFacetYamlFull, type FullValidationResult } from "../../shared/validation.js";

export interface AudienceFormFields {
  path: string;
  utmCampaign: string;
  utmSource: string;
  utmMedium: string;
  utmTerm: string;
  acctMode: "off" | "any" | "list";
  acctValues: string;
  geoCountry: string;
  geoContinent: string;
  returning: "any" | "returning" | "new";
  hasAdvancedRules: boolean;
}

function matchValueToCsv(value: MatchValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  if (value.equals !== undefined) return String(value.equals);
  if (value.in && value.in.length > 0) return value.in.map(String).join(", ");
  if (value.contains !== undefined) return value.contains;
  return "";
}

function csvToMatchValue(raw: string): MatchValue | undefined {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts;
}

function getNestedValue(
  match: MatchCondition,
  prefix: "query" | "geo",
  key: string,
): MatchValue | undefined {
  const dottedKey = `${prefix}.${key}` as `${"query" | "geo"}.${string}`;
  if (match[dottedKey] !== undefined) {
    return match[dottedKey];
  }
  const nestedMap = match[prefix];
  if (nestedMap && Object.prototype.hasOwnProperty.call(nestedMap, key)) {
    return nestedMap[key];
  }
  return undefined;
}

function isSimpleAcctValue(val: MatchValue | undefined): "off" | "any" | "list" {
  if (val === undefined) return "off";
  if (
    typeof val === "object" &&
    !Array.isArray(val) &&
    val.exists === true &&
    Object.keys(val).length === 1
  ) {
    return "any";
  }
  return "list";
}

export function extractAudienceFields(match: MatchCondition): AudienceFormFields {
  const acctVal = getNestedValue(match, "query", "acct");
  const acctMode = isSimpleAcctValue(acctVal);

  let returning: "any" | "returning" | "new" = "any";
  if (match.returning === true) returning = "returning";
  else if (match.returning === false) returning = "new";

  const hasAdvancedRules = Boolean(
    match.any ||
    match.all ||
    match.not ||
    match.company ||
    match.header ||
    match.cookie ||
    match.referrer ||
    match.host ||
    Object.keys(match).some(
      (k) =>
        k.startsWith("company.") ||
        k.startsWith("header.") ||
        k.startsWith("cookie.") ||
        (k.startsWith("query.") && k !== "query.acct") ||
        (k.startsWith("geo.") && k !== "geo.country" && k !== "geo.continent"),
    ),
  );

  return {
    path: matchValueToCsv(match.path),
    utmCampaign: matchValueToCsv(match.utm_campaign),
    utmSource: matchValueToCsv(match.utm_source),
    utmMedium: matchValueToCsv(match.utm_medium),
    utmTerm: matchValueToCsv(match.utm_term),
    acctMode,
    acctValues: acctMode === "list" ? matchValueToCsv(acctVal) : "",
    geoCountry: matchValueToCsv(getNestedValue(match, "geo", "country")),
    geoContinent: matchValueToCsv(getNestedValue(match, "geo", "continent")),
    returning,
    hasAdvancedRules,
  };
}

export function applyAudienceFields(
  previous: MatchCondition,
  fields: AudienceFormFields,
): MatchCondition {
  const next: Record<string, unknown> = { ...previous };

  // Clean managed keys before re-applying
  delete next["path"];
  delete next["utm_campaign"];
  delete next["utm_source"];
  delete next["utm_medium"];
  delete next["utm_term"];
  delete next["returning"];
  delete next["query.acct"];
  delete next["geo.country"];
  delete next["geo.continent"];

  if (previous.query && Object.prototype.hasOwnProperty.call(previous.query, "acct")) {
    const restQuery = { ...previous.query };
    delete restQuery["acct"];
    if (Object.keys(restQuery).length > 0) {
      next["query"] = restQuery;
    } else {
      delete next["query"];
    }
  }

  if (previous.geo) {
    const restGeo = { ...previous.geo };
    delete restGeo["country"];
    delete restGeo["continent"];
    if (Object.keys(restGeo).length > 0) {
      next["geo"] = restGeo;
    } else {
      delete next["geo"];
    }
  }

  const pathVal = csvToMatchValue(fields.path);
  if (pathVal !== undefined) next["path"] = pathVal;

  const utmCampaign = csvToMatchValue(fields.utmCampaign);
  if (utmCampaign !== undefined) next["utm_campaign"] = utmCampaign;

  const utmSource = csvToMatchValue(fields.utmSource);
  if (utmSource !== undefined) next["utm_source"] = utmSource;

  const utmMedium = csvToMatchValue(fields.utmMedium);
  if (utmMedium !== undefined) next["utm_medium"] = utmMedium;

  const utmTerm = csvToMatchValue(fields.utmTerm);
  if (utmTerm !== undefined) next["utm_term"] = utmTerm;

  if (fields.acctMode === "any") {
    next["query.acct"] = { exists: true };
  } else if (fields.acctMode === "list") {
    const acctList = csvToMatchValue(fields.acctValues);
    if (acctList !== undefined) {
      next["query.acct"] = acctList;
    }
  }

  const geoCountry = csvToMatchValue(fields.geoCountry);
  if (geoCountry !== undefined) next["geo.country"] = geoCountry;

  const geoContinent = csvToMatchValue(fields.geoContinent);
  if (geoContinent !== undefined) next["geo.continent"] = geoContinent;

  if (fields.returning === "returning") next["returning"] = true;
  else if (fields.returning === "new") next["returning"] = false;

  return next as MatchCondition;
}

export function summarizeExperienceMatch(exp: FacetExperience): string {
  const parts: string[] = [];
  const fields = extractAudienceFields(exp.match);

  if (fields.utmCampaign) {
    const first = fields.utmCampaign.split(",")[0]?.trim();
    if (first) parts.push(`UTM: ${first}`);
  } else if (fields.utmSource) {
    const first = fields.utmSource.split(",")[0]?.trim();
    if (first) parts.push(`Source: ${first}`);
  }

  if (fields.acctMode === "any") {
    parts.push("?acct=*");
  } else if (fields.acctMode === "list" && fields.acctValues) {
    const first = fields.acctValues.split(",")[0]?.trim();
    if (first) parts.push(`?acct=${first}`);
  }

  if (exp.lookup) {
    parts.push(`Table: ${exp.lookup.table}`);
  }

  if (fields.path) {
    const firstPath = fields.path.split(",")[0]?.trim() ?? "/";
    if (/^\/for\/:[a-zA-Z0-9_]+$/.test(firstPath)) {
      parts.push("1:1 links (/for/...)");
    } else if (firstPath === "/") {
      parts.push("Homepage");
    } else {
      parts.push(firstPath);
    }
  }

  if (fields.geoCountry) {
    parts.push(`Country: ${fields.geoCountry}`);
  } else if (fields.geoContinent) {
    parts.push(`Region: ${fields.geoContinent}`);
  }

  if (fields.returning === "returning") {
    parts.push("Returning");
  }

  if (parts.length === 0) {
    if (exp.match.any) return "Multi-rule (any)";
    if (exp.match.all) return "Multi-rule (all)";
    return "All visitors";
  }

  return parts.slice(0, 2).join(" · ");
}

export function slugifyCampaignId(name: string, existingIds: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "campaign";
  const used = new Set(existingIds);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}

export function createStarterCampaign(existingIds: readonly string[]): FacetExperience {
  const id = slugifyCampaignId("new-campaign", existingIds);
  return {
    id,
    name: "New Campaign",
    enabled: true,
    priority: 20,
    stopOnMatch: true,
    holdout: 0.2,
    sticky: "7d",
    match: {
      path: "/",
      utm_campaign: id,
    },
    changes: [
      {
        selector: "h1",
        text: "Tailored headline for your campaign visitors",
      },
      {
        selector: "[data-cta='hero']",
        text: "Book a demo",
        attrs: {
          href: `/demo?campaign=${id}`,
        },
      },
    ],
  };
}

export function buildDefaultTestPathForExperience(
  exp: FacetExperience,
  config: FacetConfig,
  preferredAccountKey?: string,
): { pathAndQuery: string; returning: boolean; country?: string; continent?: string } {
  const fields = extractAudienceFields(exp.match);
  const firstPath = (fields.path.split(",")[0] ?? "/").trim() || "/";

  let accountKey = preferredAccountKey;
  if (!accountKey && exp.lookup && config.data) {
    const table = config.data[exp.lookup.table];
    if (table) {
      accountKey = Object.keys(table)[0];
    }
  }
  accountKey = accountKey || "meridian";

  let resolvedPath = firstPath.replace(/:([a-zA-Z0-9_]+)/g, () => encodeURIComponent(accountKey));
  if (resolvedPath.includes("*")) {
    resolvedPath = resolvedPath.replace(/\*/g, "overview");
  }
  if (!resolvedPath.startsWith("/")) {
    resolvedPath = "/" + resolvedPath;
  }

  const params = new URLSearchParams();

  if (fields.utmCampaign) {
    const first = fields.utmCampaign.split(",")[0]?.trim();
    if (first) params.set("utm_campaign", first);
  }
  if (fields.utmSource) {
    const first = fields.utmSource.split(",")[0]?.trim();
    if (first) params.set("utm_source", first);
  }
  if (fields.utmMedium) {
    const first = fields.utmMedium.split(",")[0]?.trim();
    if (first) params.set("utm_medium", first);
  }
  if (fields.utmTerm) {
    const first = fields.utmTerm.split(",")[0]?.trim();
    if (first) params.set("utm_term", first);
  }

  if (fields.acctMode === "any") {
    params.set("acct", accountKey);
  } else if (fields.acctMode === "list") {
    const first = fields.acctValues.split(",")[0]?.trim() || accountKey;
    params.set("acct", first);
  }

  // Also check `any` clauses for a friendly sample utm_campaign if top-level didn't set one
  if (params.toString().length === 0 && Array.isArray(exp.match.any)) {
    for (const branch of exp.match.any) {
      if (branch.utm_campaign) {
        const val = matchValueToCsv(branch.utm_campaign).split(",")[0]?.trim();
        if (val) {
          params.set("utm_campaign", val);
          break;
        }
      }
      if (branch["query.acct"]) {
        const val = matchValueToCsv(branch["query.acct"]).split(",")[0]?.trim();
        if (val) {
          params.set("acct", val);
          break;
        }
      }
    }
  }

  const qs = params.toString();
  const pathAndQuery = qs ? `${resolvedPath}?${qs}` : resolvedPath;

  const country = fields.geoCountry.split(",")[0]?.trim() || undefined;
  const continent = fields.geoContinent.split(",")[0]?.trim() || undefined;
  let returning = fields.returning === "returning";

  if (!returning && Array.isArray(exp.match.all)) {
    for (const branch of exp.match.all) {
      if (branch.returning === true) returning = true;
    }
  }

  return {
    pathAndQuery,
    returning,
    ...(country ? { country } : {}),
    ...(continent ? { continent } : {}),
  };
}

export type ChangeEditorMode = "text" | "cta" | "slot" | "html";

export function detectChangeMode(change: FacetChange): ChangeEditorMode {
  if (change.slot !== undefined) return "slot";
  if (change.html !== undefined) return "html";
  if (change.attrs && Object.prototype.hasOwnProperty.call(change.attrs, "href")) {
    return "cta";
  }
  return "text";
}

export function getFriendlyChangeTitle(change: FacetChange): string {
  const sel = change.selector.trim().toLowerCase();
  const mode = detectChangeMode(change);

  if (mode === "slot") {
    const slotVal = (change.slot ?? "").toLowerCase();
    if (sel.includes("logo") || slotVal.includes("logo")) {
      return "Logo strip";
    }
    return "HTML slot";
  }

  if (sel === "h1" || sel.includes("headline")) {
    return "Headline";
  }
  if (sel.includes("subhead") || sel === "p") {
    return "Subheadline";
  }
  if (mode === "cta" || sel.includes("cta") || sel === "a" || sel === "button") {
    return "Primary button";
  }
  if (sel === "h2" || sel === "h3") {
    return "Section heading";
  }
  return "Page element";
}

export function roundTripConfigUpdate(config: FacetConfig): {
  yaml: string;
  validation: FullValidationResult;
} {
  const yaml = serializeFacetConfig(config);
  const validation = validateFacetYamlFull(yaml);
  return { yaml, validation };
}

export function updateAccountTableInConfig(
  config: FacetConfig,
  tableName: string,
  table: FacetDataTable,
): FacetConfig {
  const nextData = { ...(config.data ?? {}) };
  nextData[tableName] = table;
  return {
    ...config,
    data: nextData,
  };
}

export function coerceScalarValue(raw: string): MatchScalar {
  return raw;
}
