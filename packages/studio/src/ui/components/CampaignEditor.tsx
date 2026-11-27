import type {
  FacetChange,
  FacetConfig,
  FacetExperience,
  FacetValidationError,
  StickyDuration,
} from "@facet/core";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ValidationWarning } from "../../shared/types.js";
import {
  applyAudienceFields,
  detectChangeMode,
  extractAudienceFields,
  getFriendlyChangeTitle,
  type AudienceFormFields,
  type ChangeEditorMode,
} from "../helpers/campaign-model.js";
import styles from "../Studio.module.css";
import {
  AlertIcon,
  ChevronDownIcon,
  CrosshairIcon,
  DuplicateIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "./Icons.js";

export interface CampaignEditorProps {
  config: FacetConfig;
  experience: FacetExperience;
  errors: readonly FacetValidationError[];
  warnings: readonly ValidationWarning[];
  canPickElement: boolean;
  pickMode: boolean;
  pickTargetChangeIndex: number | null;
  onChange: (updated: FacetExperience) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenYaml: () => void;
  onStartPickElement: (changeIndex: number | null) => void;
}

type OptionalConditionKey =
  "utmCampaign" | "utmSource" | "utmTerm" | "acct" | "geoCountry" | "returning" | "accountTable";

const CONDITION_CATALOG: ReadonlyArray<{ key: OptionalConditionKey; label: string }> = [
  { key: "utmCampaign", label: "Paid ad campaign" },
  { key: "utmSource", label: "Ad source" },
  { key: "utmTerm", label: "Search keyword" },
  { key: "acct", label: "1:1 Account link" },
  { key: "geoCountry", label: "Country" },
  { key: "returning", label: "Visitor type" },
  { key: "accountTable", label: "Account table" },
];

const HOLDOUT_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "Off", value: 0 },
  { label: "10%", value: 0.1 },
  { label: "20%", value: 0.2 },
  { label: "50%", value: 0.5 },
];

const STICKY_OPTIONS: ReadonlyArray<{ label: string; value: StickyDuration | undefined }> = [
  { label: "Off", value: undefined },
  { label: "Session", value: "session" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
];

function getPageMode(path: string): "homepage" | "account-link" | "all" | "custom" {
  const trimmed = path.trim();
  if (trimmed === "/") return "homepage";
  if (/^\/for\/:[a-zA-Z0-9_]+$/.test(trimmed)) return "account-link";
  if (trimmed === "") return "all";
  return "custom";
}

function getStickyValueKey(sticky: StickyDuration | undefined): string {
  if (sticky === undefined || sticky === false) return "off";
  if (sticky === true || sticky === "session") return "session";
  return sticky;
}

export function CampaignEditor({
  config,
  experience,
  errors,
  warnings,
  canPickElement,
  pickMode,
  pickTargetChangeIndex,
  onChange,
  onDuplicate,
  onDelete,
  onOpenYaml,
  onStartPickElement,
}: CampaignEditorProps): ReactElement {
  const [addedConditions, setAddedConditions] = useState<OptionalConditionKey[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [openVarIndex, setOpenVarIndex] = useState<number | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAddedConditions([]);
    setAddMenuOpen(false);
    setOpenVarIndex(null);
  }, [experience.id]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [addMenuOpen]);

  const audience = useMemo(() => extractAudienceFields(experience.match), [experience.match]);
  const tableNames = useMemo(() => Object.keys(config.data ?? {}), [config.data]);
  const slotNames = useMemo(
    () => Object.keys(config.settings.slots ?? {}),
    [config.settings.slots],
  );

  const activeConditions = useMemo(() => {
    const active = new Set<OptionalConditionKey>(addedConditions);
    if (audience.utmCampaign.trim().length > 0) active.add("utmCampaign");
    if (audience.utmSource.trim().length > 0) active.add("utmSource");
    if (audience.utmTerm.trim().length > 0) active.add("utmTerm");
    if (audience.acctMode !== "off") active.add("acct");
    if (audience.geoCountry.trim().length > 0) active.add("geoCountry");
    if (audience.returning !== "any") active.add("returning");
    if (experience.lookup) active.add("accountTable");
    return CONDITION_CATALOG.filter((item) => active.has(item.key));
  }, [addedConditions, audience, experience.lookup]);

  const unusedConditions = useMemo(() => {
    const activeKeys = new Set(activeConditions.map((item) => item.key));
    return CONDITION_CATALOG.filter((item) => !activeKeys.has(item.key));
  }, [activeConditions]);

  const variableChips = useMemo(() => {
    const chips: string[] = [];
    if (experience.lookup && config.data && config.data[experience.lookup.table]) {
      const table = config.data[experience.lookup.table];
      const cols = new Set<string>();
      for (const row of Object.values(table ?? {})) {
        for (const col of Object.keys(row)) {
          cols.add(col);
        }
      }
      for (const col of Array.from(cols).slice(0, 6)) {
        chips.push(`{{data.${col}}}`);
      }
      if (audience.path.includes(":")) {
        chips.push("{{params.acct}}");
      } else {
        chips.push("{{query.acct}}");
      }
      return Array.from(new Set(chips));
    }
    return ["{{utm_campaign}}", "{{utm_term}}", "{{utm_source}}", "{{query.acct}}"];
  }, [experience.lookup, config.data, audience.path]);

  function updateAudience(patch: Partial<AudienceFormFields>): void {
    const nextFields: AudienceFormFields = { ...audience, ...patch };
    onChange({
      ...experience,
      match: applyAudienceFields(experience.match, nextFields),
    });
  }

  function handleAddCondition(key: OptionalConditionKey): void {
    setAddMenuOpen(false);
    setAddedConditions((prev) => (prev.includes(key) ? prev : [...prev, key]));

    if (key === "acct" && audience.acctMode === "off") {
      updateAudience({ acctMode: "any" });
    } else if (key === "returning" && audience.returning === "any") {
      updateAudience({ returning: "returning" });
    } else if (key === "accountTable" && !experience.lookup) {
      onChange({
        ...experience,
        lookup: {
          table: tableNames[0] ?? "accounts",
          key: audience.path.includes(":acct") ? "{{params.acct}}" : "{{query.acct}}",
          required: true,
        },
      });
    }
  }

  function handleRemoveCondition(key: OptionalConditionKey): void {
    setAddedConditions((prev) => prev.filter((item) => item !== key));
    if (key === "utmCampaign") {
      updateAudience({ utmCampaign: "" });
    } else if (key === "utmSource") {
      updateAudience({ utmSource: "" });
    } else if (key === "utmTerm") {
      updateAudience({ utmTerm: "" });
    } else if (key === "acct") {
      updateAudience({ acctMode: "off", acctValues: "" });
    } else if (key === "geoCountry") {
      updateAudience({ geoCountry: "" });
    } else if (key === "returning") {
      updateAudience({ returning: "any" });
    } else if (key === "accountTable") {
      const next: FacetExperience = { ...experience };
      delete next.lookup;
      onChange(next);
    }
  }

  function updateChange(index: number, nextChange: FacetChange): void {
    const nextChanges = experience.changes.map((item, idx) => (idx === index ? nextChange : item));
    onChange({ ...experience, changes: nextChanges });
  }

  function handleChangeModeSwitch(index: number, mode: ChangeEditorMode): void {
    const current = experience.changes[index];
    if (!current) return;
    const base: FacetChange = { selector: current.selector };
    if (mode === "text") {
      base.text = current.text ?? "";
    } else if (mode === "cta") {
      base.text = current.text ?? "Book a demo";
      base.attrs = { ...(current.attrs ?? {}), href: current.attrs?.["href"] ?? "/demo" };
    } else if (mode === "slot") {
      base.slot = current.slot ?? slotNames[0] ?? "fintech-logos";
    } else if (mode === "html") {
      base.html = current.html ?? "<span>Custom HTML block</span>";
    }
    updateChange(index, base);
  }

  function appendTokenToChange(index: number, token: string): void {
    const current = experience.changes[index];
    if (!current) return;
    const mode = detectChangeMode(current);
    if (mode === "slot") {
      updateChange(index, { ...current, slot: `${current.slot ?? ""}${token}` });
    } else if (mode === "html") {
      updateChange(index, { ...current, html: `${current.html ?? ""}${token}` });
    } else {
      const prefix =
        current.text && !current.text.endsWith(" ") ? `${current.text} ` : (current.text ?? "");
      updateChange(index, { ...current, text: `${prefix}${token}` });
    }
    setOpenVarIndex(null);
  }

  function addChange(): void {
    onChange({
      ...experience,
      changes: [
        ...experience.changes,
        {
          selector: "h2",
          text: "Personalized section copy",
        },
      ],
    });
  }

  function removeChange(index: number): void {
    if (experience.changes.length <= 1) return;
    if (openVarIndex === index) setOpenVarIndex(null);
    onChange({
      ...experience,
      changes: experience.changes.filter((_, idx) => idx !== index),
    });
  }

  const holdoutPct = Math.round(experience.holdout * 100);
  const isCustomHoldout = !HOLDOUT_PRESETS.some((p) => Math.round(p.value * 100) === holdoutPct);
  const activeStickyKey = getStickyValueKey(experience.sticky);

  return (
    <div className={styles.centerPane}>
      <div className={styles.editorHeader}>
        <div className={styles.editorTitleRow}>
          <label htmlFor="campaign-name-input" className="sr-only">
            Campaign name
          </label>
          <input
            id="campaign-name-input"
            type="text"
            className={styles.titleInput}
            value={experience.name}
            placeholder="Untitled campaign"
            onChange={(e) => onChange({ ...experience, name: e.target.value })}
          />

          <div className={styles.headerActions}>
            <label className={styles.switchRow}>
              <input
                type="checkbox"
                className="sr-only"
                checked={experience.enabled}
                onChange={(e) => onChange({ ...experience, enabled: e.target.checked })}
              />
              <span
                className={`${styles.switchTrack} ${experience.enabled ? styles.switchTrackOn : ""}`}
                aria-hidden="true"
              >
                <span
                  className={`${styles.switchThumb} ${experience.enabled ? styles.switchThumbOn : ""}`}
                />
              </span>
              <span className={styles.switchLabel}>{experience.enabled ? "Live" : "Paused"}</span>
            </label>

            <button
              type="button"
              className={`${styles.btn} ${styles.btnIcon} ${styles.btnGhost}`}
              onClick={onDuplicate}
              aria-label="Duplicate campaign"
              title="Duplicate campaign"
            >
              <DuplicateIcon size={15} />
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnIcon} ${styles.btnGhostDanger}`}
              onClick={onDelete}
              aria-label="Delete campaign"
              title="Delete campaign"
            >
              <TrashIcon size={15} />
            </button>
          </div>
        </div>
      </div>

      {errors.length > 0 ? (
        <div className={styles.bannerError} role="alert">
          <div className={styles.bannerTitle}>
            <AlertIcon size={16} />
            Fix {errors.length} {errors.length === 1 ? "issue" : "issues"} before publishing
          </div>
          <ul className={styles.bannerList}>
            {errors.map((err, idx) => (
              <li key={`${err.path}-${idx}`}>
                <code>{err.path}</code>: {err.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className={styles.bannerWarn} role="status">
          <div className={styles.bannerTitle}>Attention</div>
          <ul className={styles.bannerList}>
            {warnings.map((warn, idx) => (
              <li key={`${warn.path}-${idx}`}>{warn.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Section 1 — Who sees this? */}
      <section className={styles.section} aria-labelledby="section-audience">
        <div className={styles.sectionHeader}>
          <h2 id="section-audience" className={styles.sectionTitle}>
            Who sees this?
          </h2>
          {audience.hasAdvancedRules ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
              onClick={onOpenYaml}
            >
              Custom YAML rules
            </button>
          ) : null}
        </div>

        <div className={styles.conditionList}>
          {/* Always-visible Page condition */}
          <div className={styles.conditionRow}>
            <label className={styles.conditionLabel} htmlFor="field-page-mode">
              Page
            </label>
            <div className={styles.conditionControl}>
              {(() => {
                const pageMode = getPageMode(audience.path);
                const sampleSlugs =
                  experience.lookup && config.data?.[experience.lookup.table]
                    ? Object.keys(config.data[experience.lookup.table]!).slice(0, 2)
                    : ["stripe", "acme"];

                return (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%" }}
                  >
                    <select
                      id="field-page-mode"
                      className={styles.select}
                      value={pageMode}
                      onChange={(e) => {
                        const nextMode = e.target.value as ReturnType<typeof getPageMode>;
                        if (nextMode === "homepage") {
                          updateAudience({ path: "/" });
                        } else if (nextMode === "account-link") {
                          const nextExp: FacetExperience = {
                            ...experience,
                            match: applyAudienceFields(experience.match, {
                              ...audience,
                              path: "/for/:acct",
                            }),
                          };
                          if (!nextExp.originPath) {
                            nextExp.originPath = "/";
                          }
                          onChange(nextExp);
                        } else if (nextMode === "all") {
                          updateAudience({ path: "" });
                        } else {
                          updateAudience({ path: "/pricing" });
                        }
                      }}
                    >
                      <option value="homepage">Homepage (/)</option>
                      <option value="account-link">1:1 account links (/for/company)</option>
                      <option value="all">Every page on site</option>
                      <option value="custom">Specific page URL...</option>
                    </select>

                    {pageMode === "account-link" ? (
                      <span className={styles.hint}>
                        e.g.{" "}
                        {sampleSlugs.map((slug, idx) => (
                          <span key={slug}>
                            {idx > 0 ? ", " : ""}
                            <code>/for/{slug}</code>
                          </span>
                        ))}
                      </span>
                    ) : null}

                    {pageMode === "custom" ? (
                      <input
                        id="field-path"
                        type="text"
                        aria-label="Custom page URL path"
                        className={`${styles.input} ${styles.monoInput}`}
                        placeholder="/pricing or /solutions/*"
                        value={audience.path}
                        onChange={(e) => updateAudience({ path: e.target.value })}
                      />
                    ) : null}
                  </div>
                );
              })()}
            </div>
            <span className={styles.conditionSpacer} aria-hidden="true" />
          </div>

          {/* Only active optional conditions */}
          {activeConditions.map((cond) => (
            <div key={cond.key} className={styles.conditionRow}>
              <label className={styles.conditionLabel} htmlFor={`field-cond-${cond.key}`}>
                {cond.label}
              </label>

              <div className={styles.conditionControl}>
                {cond.key === "utmCampaign" ? (
                  <input
                    id="field-cond-utmCampaign"
                    type="text"
                    className={styles.input}
                    placeholder="fintech-q4, abm-banking"
                    value={audience.utmCampaign}
                    onChange={(e) => updateAudience({ utmCampaign: e.target.value })}
                  />
                ) : null}

                {cond.key === "utmSource" ? (
                  <input
                    id="field-cond-utmSource"
                    type="text"
                    className={styles.input}
                    placeholder="google, linkedin"
                    value={audience.utmSource}
                    onChange={(e) => updateAudience({ utmSource: e.target.value })}
                  />
                ) : null}

                {cond.key === "utmTerm" ? (
                  <input
                    id="field-cond-utmTerm"
                    type="text"
                    className={styles.input}
                    placeholder="edge personalization"
                    value={audience.utmTerm}
                    onChange={(e) => updateAudience({ utmTerm: e.target.value })}
                  />
                ) : null}

                {cond.key === "acct" ? (
                  <div className={styles.conditionSplit}>
                    <select
                      id="field-cond-acct"
                      className={styles.select}
                      value={audience.acctMode === "off" ? "any" : audience.acctMode}
                      onChange={(e) =>
                        updateAudience({
                          acctMode: e.target.value as AudienceFormFields["acctMode"],
                        })
                      }
                    >
                      <option value="any">Any ?acct= link</option>
                      <option value="list">Specific accounts</option>
                    </select>
                    {audience.acctMode === "list" ? (
                      <input
                        id="field-acct-values"
                        type="text"
                        aria-label="Account slugs"
                        className={styles.input}
                        placeholder="meridian, alder, stripe"
                        value={audience.acctValues}
                        onChange={(e) => updateAudience({ acctValues: e.target.value })}
                      />
                    ) : null}
                  </div>
                ) : null}

                {cond.key === "geoCountry" ? (
                  <input
                    id="field-cond-geoCountry"
                    type="text"
                    className={styles.input}
                    placeholder="US, GB, DE"
                    value={audience.geoCountry}
                    onChange={(e) => updateAudience({ geoCountry: e.target.value.toUpperCase() })}
                  />
                ) : null}

                {cond.key === "returning" ? (
                  <select
                    id="field-cond-returning"
                    className={styles.select}
                    value={audience.returning === "any" ? "returning" : audience.returning}
                    onChange={(e) =>
                      updateAudience({
                        returning: e.target.value as AudienceFormFields["returning"],
                      })
                    }
                  >
                    <option value="returning">Returning visitors</option>
                    <option value="new">First-time visitors</option>
                  </select>
                ) : null}

                {cond.key === "accountTable" && experience.lookup ? (
                  tableNames.length > 0 ? (
                    <select
                      id="field-cond-accountTable"
                      className={styles.select}
                      value={experience.lookup.table}
                      onChange={(e) =>
                        onChange({
                          ...experience,
                          lookup: { ...experience.lookup!, table: e.target.value },
                        })
                      }
                    >
                      {!tableNames.includes(experience.lookup.table) ? (
                        <option value={experience.lookup.table}>{experience.lookup.table}</option>
                      ) : null}
                      {tableNames.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="field-cond-accountTable"
                      type="text"
                      className={styles.input}
                      value={experience.lookup.table}
                      onChange={(e) =>
                        onChange({
                          ...experience,
                          lookup: { ...experience.lookup!, table: e.target.value.trim() },
                        })
                      }
                    />
                  )
                ) : null}
              </div>

              <button
                type="button"
                className={`${styles.btn} ${styles.btnIconSm} ${styles.btnGhost}`}
                onClick={() => handleRemoveCondition(cond.key)}
                aria-label={`Remove ${cond.label}`}
                title={`Remove ${cond.label}`}
              >
                <XIcon size={14} />
              </button>
            </div>
          ))}
        </div>

        {unusedConditions.length > 0 ? (
          <div className={styles.conditionAddWrap} ref={addMenuRef}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <PlusIcon size={14} />
              Add condition
            </button>

            {addMenuOpen ? (
              <div className={styles.conditionMenu} role="menu" aria-label="Add audience condition">
                {unusedConditions.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className={styles.conditionMenuItem}
                    onClick={() => handleAddCondition(item.key)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Section 2 — What changes on the page? */}
      <section className={styles.section} aria-labelledby="section-changes">
        <div className={styles.sectionHeader}>
          <h2 id="section-changes" className={styles.sectionTitle}>
            What changes on the page?
          </h2>
          <div className={styles.sectionHeaderActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost} ${
                pickMode && pickTargetChangeIndex === null ? styles.btnActive : ""
              }`}
              disabled={!canPickElement}
              title={
                canPickElement
                  ? "Click an element on the live preview to add a change"
                  : "Enter a live website URL in Preview to pick elements"
              }
              onClick={() => onStartPickElement(null)}
            >
              <CrosshairIcon size={14} />
              {pickMode && pickTargetChangeIndex === null ? "Picking..." : "Pick on page"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
              onClick={addChange}
            >
              <PlusIcon size={14} />
              Add change
            </button>
          </div>
        </div>

        <div className={styles.changeList}>
          {experience.changes.map((change, idx) => {
            const mode = detectChangeMode(change);
            const title = getFriendlyChangeTitle(change);
            const varsOpen = openVarIndex === idx;
            const isPickingThisRow = pickMode && pickTargetChangeIndex === idx;

            return (
              <div key={idx} className={styles.changeRow}>
                <div className={styles.changeHeaderRow}>
                  <span className={styles.changeFriendlyTitle}>{title}</span>

                  <div className={styles.changeRowActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnIconSm} ${styles.btnGhost} ${
                        isPickingThisRow ? styles.btnActive : ""
                      }`}
                      disabled={!canPickElement}
                      aria-pressed={isPickingThisRow}
                      aria-label={`Pick ${title} selector on page`}
                      title={
                        canPickElement
                          ? `Re-pick selector for ${title} on page`
                          : "Connect a live website URL to pick selectors"
                      }
                      onClick={() => onStartPickElement(idx)}
                    >
                      <CrosshairIcon size={14} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnXs} ${styles.btnGhost} ${varsOpen ? styles.btnActive : ""}`}
                      aria-expanded={varsOpen}
                      onClick={() => setOpenVarIndex(varsOpen ? null : idx)}
                    >
                      + Variable
                    </button>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnIconSm} ${styles.btnGhostDanger}`}
                      disabled={experience.changes.length <= 1}
                      onClick={() => removeChange(idx)}
                      aria-label={`Remove ${title}`}
                      title={`Remove ${title}`}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                </div>

                {/* Primary copy / CTA / slot / HTML input FIRST */}
                {mode === "text" ? (
                  <div className={styles.field}>
                    <label className="sr-only" htmlFor={`change-text-${idx}`}>
                      {title} copy
                    </label>
                    <input
                      id={`change-text-${idx}`}
                      type="text"
                      className={`${styles.input} ${styles.copyInput}`}
                      placeholder="Enter replacement copy..."
                      value={change.text ?? ""}
                      onChange={(e) => updateChange(idx, { ...change, text: e.target.value })}
                    />
                  </div>
                ) : null}

                {mode === "cta" ? (
                  <div className={styles.ctaFieldRow}>
                    <div className={styles.field}>
                      <label className="sr-only" htmlFor={`change-text-${idx}`}>
                        Button label
                      </label>
                      <input
                        id={`change-text-${idx}`}
                        type="text"
                        className={`${styles.input} ${styles.copyInput}`}
                        placeholder="Button text"
                        value={change.text ?? ""}
                        onChange={(e) => updateChange(idx, { ...change, text: e.target.value })}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className="sr-only" htmlFor={`change-href-${idx}`}>
                        Button link URL
                      </label>
                      <input
                        id={`change-href-${idx}`}
                        type="text"
                        className={`${styles.input} ${styles.monoInput}`}
                        placeholder="/demo"
                        value={change.attrs?.["href"] ?? ""}
                        onChange={(e) =>
                          updateChange(idx, {
                            ...change,
                            attrs: { ...(change.attrs ?? {}), href: e.target.value },
                          })
                        }
                      />
                    </div>
                  </div>
                ) : null}

                {mode === "slot" ? (
                  <div className={styles.field}>
                    <label className="sr-only" htmlFor={`change-slot-${idx}`}>
                      HTML slot name
                    </label>
                    <input
                      id={`change-slot-${idx}`}
                      type="text"
                      list={`slot-options-${idx}`}
                      className={`${styles.input} ${styles.monoInput}`}
                      placeholder="fintech-logos"
                      value={change.slot ?? ""}
                      onChange={(e) => updateChange(idx, { ...change, slot: e.target.value })}
                    />
                    <datalist id={`slot-options-${idx}`}>
                      {slotNames.map((slotName) => (
                        <option key={slotName} value={slotName} />
                      ))}
                    </datalist>
                  </div>
                ) : null}

                {mode === "html" ? (
                  <div className={styles.field}>
                    <label className="sr-only" htmlFor={`change-html-${idx}`}>
                      HTML markup
                    </label>
                    <textarea
                      id={`change-html-${idx}`}
                      className={`${styles.textarea} ${styles.monoInput}`}
                      value={change.html ?? ""}
                      onChange={(e) => updateChange(idx, { ...change, html: e.target.value })}
                    />
                  </div>
                ) : null}

                {/* Collapsible variable picker (only shown when + Variable clicked) */}
                {varsOpen ? (
                  <div className={styles.chipBar} role="group" aria-label="Insert variable">
                    {variableChips.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        className={styles.varChip}
                        onClick={() => appendTokenToChange(idx, chip)}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* Compact quiet technical sub-row */}
                <div className={styles.changeTechRow}>
                  <label className={styles.changeTechField} htmlFor={`change-selector-${idx}`}>
                    <span>Selector</span>
                    <input
                      id={`change-selector-${idx}`}
                      type="text"
                      className={styles.quietMonoInput}
                      placeholder="h1"
                      value={change.selector}
                      onChange={(e) => updateChange(idx, { ...change, selector: e.target.value })}
                    />
                  </label>

                  <label className={styles.changeTechField} htmlFor={`change-type-${idx}`}>
                    <span>Type</span>
                    <select
                      id={`change-type-${idx}`}
                      className={styles.quietSelect}
                      value={mode}
                      onChange={(e) =>
                        handleChangeModeSwitch(idx, e.target.value as ChangeEditorMode)
                      }
                    >
                      <option value="text">Text</option>
                      <option value="cta">Button / Link</option>
                      <option value="slot">HTML slot</option>
                      <option value="html">Raw HTML</option>
                    </select>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 3 — Holdout & stickiness */}
      <section className={styles.section} aria-labelledby="section-delivery">
        <h2 id="section-delivery" className={styles.sectionTitle}>
          Holdout &amp; stickiness
        </h2>

        <div className={styles.compactControlGrid}>
          <div className={styles.field}>
            <span className={styles.label}>Holdout group</span>
            <div className={styles.segmentedControl} role="radiogroup" aria-label="Holdout group">
              {HOLDOUT_PRESETS.map((preset) => {
                const active = Math.round(preset.value * 100) === holdoutPct;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`${styles.segOption} ${
                      active
                        ? preset.value > 0
                          ? styles.segOptionOchre
                          : styles.segOptionActive
                        : ""
                    }`}
                    onClick={() => onChange({ ...experience, holdout: preset.value })}
                  >
                    {preset.label}
                  </button>
                );
              })}
              {isCustomHoldout ? (
                <span className={`${styles.segOption} ${styles.segOptionOchre} ${styles.tabular}`}>
                  {holdoutPct}%
                </span>
              ) : null}
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>Keep across pages</span>
            <div
              className={styles.segmentedControl}
              role="radiogroup"
              aria-label="Keep across pages"
            >
              {STICKY_OPTIONS.map((opt) => {
                const key = getStickyValueKey(opt.value);
                const active = activeStickyKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`${styles.segOption} ${active ? styles.segOptionActive : ""}`}
                    onClick={() => {
                      const next: FacetExperience = { ...experience };
                      if (opt.value === undefined) {
                        delete next.sticky;
                      } else {
                        next.sticky = opt.value;
                      }
                      onChange(next);
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Collapsed Advanced Settings */}
      <details className={styles.advancedDetails}>
        <summary className={styles.advancedSummary}>
          <ChevronDownIcon size={14} className={styles.disclosureChevron} />
          Advanced settings
        </summary>

        <div className={styles.advancedBody}>
          <div className={styles.fieldGrid}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="campaign-id-input">
                Campaign ID
              </label>
              <input
                id="campaign-id-input"
                type="text"
                className={`${styles.input} ${styles.monoInput}`}
                value={experience.id}
                onChange={(e) => onChange({ ...experience, id: e.target.value.trim() })}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="campaign-priority-input">
                Priority
              </label>
              <input
                id="campaign-priority-input"
                type="number"
                className={`${styles.input} ${styles.tabular}`}
                value={experience.priority}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  onChange({ ...experience, priority: Number.isFinite(parsed) ? parsed : 0 });
                }}
              />
              <span className={styles.hint}>
                Higher priority runs first when campaigns overlap.
              </span>
            </div>

            <div className={`${styles.field} ${styles.fieldSpan2}`}>
              <label className={styles.label} htmlFor="field-origin-path">
                Virtual URL origin path
              </label>
              <input
                id="field-origin-path"
                type="text"
                className={`${styles.input} ${styles.monoInput}`}
                placeholder="/ (serve homepage HTML at matched path)"
                value={experience.originPath ?? ""}
                onChange={(e) => {
                  const trimmed = e.target.value.trim();
                  const next: FacetExperience = { ...experience };
                  if (trimmed.length > 0) {
                    next.originPath = trimmed;
                  } else {
                    delete next.originPath;
                  }
                  onChange(next);
                }}
              />
            </div>

            {experience.lookup ? (
              <>
                <div className={`${styles.field} ${styles.fieldSpan2}`}>
                  <label className={styles.label} htmlFor="field-lookup-key">
                    Account table lookup key
                  </label>
                  <input
                    id="field-lookup-key"
                    type="text"
                    className={`${styles.input} ${styles.monoInput}`}
                    value={experience.lookup.key}
                    onChange={(e) =>
                      onChange({
                        ...experience,
                        lookup: { ...experience.lookup!, key: e.target.value },
                      })
                    }
                  />
                  <div className={styles.chipBar}>
                    <button
                      type="button"
                      className={styles.varChip}
                      onClick={() =>
                        onChange({
                          ...experience,
                          lookup: { ...experience.lookup!, key: "{{params.acct}}" },
                        })
                      }
                    >
                      {"{{params.acct}}"}
                    </button>
                    <button
                      type="button"
                      className={styles.varChip}
                      onClick={() =>
                        onChange({
                          ...experience,
                          lookup: { ...experience.lookup!, key: "{{query.acct}}" },
                        })
                      }
                    >
                      {"{{query.acct}}"}
                    </button>
                  </div>
                </div>

                <label className={`${styles.switchRow} ${styles.fieldSpan2}`}>
                  <input
                    type="checkbox"
                    checked={experience.lookup.required}
                    onChange={(e) =>
                      onChange({
                        ...experience,
                        lookup: { ...experience.lookup!, required: e.target.checked },
                      })
                    }
                  />
                  <span>Require matching account row (skip campaign for unknown slugs)</span>
                </label>
              </>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}
