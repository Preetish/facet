import {
  parseFacetYaml,
  validateTemplateSyntax,
  type FacetConfig,
  type FacetValidationError,
} from "@facet/core";
import type { ValidationWarning } from "./types.js";

export interface FullValidationResult {
  ok: boolean;
  config?: FacetConfig;
  errors: FacetValidationError[];
  warnings: ValidationWarning[];
}

function checkTemplateString(
  value: string | undefined,
  path: string,
  errors: FacetValidationError[],
): void {
  if (!value || (!value.includes("{{") && !value.includes("}}"))) {
    return;
  }
  const result = validateTemplateSyntax(value);
  if (!result.valid) {
    for (const issue of result.errors) {
      errors.push({
        path,
        message: `${issue.message} (${issue.expression})`,
        code: "invalid_template_syntax",
      });
    }
  }
}

export function validateConfigTemplatesAndRefs(config: FacetConfig): {
  errors: FacetValidationError[];
  warnings: ValidationWarning[];
} {
  const errors: FacetValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const tables = config.data ?? {};
  const slots = config.settings.slots ?? {};

  for (let i = 0; i < config.experiences.length; i++) {
    const exp = config.experiences[i];
    if (!exp) continue;
    const prefix = `experiences[${i}]`;

    checkTemplateString(exp.originPath, `${prefix}.originPath`, errors);

    if (exp.lookup) {
      checkTemplateString(exp.lookup.key, `${prefix}.lookup.key`, errors);
      if (!Object.prototype.hasOwnProperty.call(tables, exp.lookup.table)) {
        warnings.push({
          path: `${prefix}.lookup.table`,
          message: `Account table "${exp.lookup.table}" is not defined in data yet. Import a CSV or create the table in Account Tables.`,
        });
      }
    }

    for (let j = 0; j < exp.changes.length; j++) {
      const change = exp.changes[j];
      if (!change) continue;
      const changePath = `${prefix}.changes[${j}]`;

      checkTemplateString(change.text, `${changePath}.text`, errors);
      checkTemplateString(change.html, `${changePath}.html`, errors);
      checkTemplateString(change.slot, `${changePath}.slot`, errors);
      checkTemplateString(change.prepend, `${changePath}.prepend`, errors);
      checkTemplateString(change.append, `${changePath}.append`, errors);

      if (change.attrs) {
        for (const [attrName, attrVal] of Object.entries(change.attrs)) {
          if (typeof attrVal === "string") {
            checkTemplateString(attrVal, `${changePath}.attrs.${attrName}`, errors);
          }
        }
      }

      if (
        change.slot &&
        !change.slot.includes("{{") &&
        !Object.prototype.hasOwnProperty.call(slots, change.slot)
      ) {
        warnings.push({
          path: `${changePath}.slot`,
          message: `HTML slot "${change.slot}" is not defined under settings.slots.`,
        });
      }
    }
  }

  return { errors, warnings };
}

export function validateFacetYamlFull(yamlText: string): FullValidationResult {
  const parsed = parseFacetYaml(yamlText);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors,
      warnings: [],
    };
  }

  const { errors: templateErrors, warnings } = validateConfigTemplatesAndRefs(parsed.config);
  if (templateErrors.length > 0) {
    return {
      ok: false,
      config: parsed.config,
      errors: templateErrors,
      warnings,
    };
  }

  return {
    ok: true,
    config: parsed.config,
    errors: [],
    warnings,
  };
}
