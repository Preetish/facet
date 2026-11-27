import type { FacetConfig } from "@facet/core";
import { useMemo, useState, type ReactElement } from "react";
import type { StudioCapabilities } from "../../shared/types.js";
import { summarizeExperienceMatch } from "../helpers/campaign-model.js";
import { formatSiteHostname } from "../helpers/live-preview.js";
import styles from "../Studio.module.css";
import { GlobeIcon, PlusIcon, SearchIcon } from "./Icons.js";

export type StudioMode = "campaigns" | "tables" | "history" | "setup";

export interface LeftRailProps {
  mode: StudioMode;
  config: FacetConfig | null;
  selectedCampaignId: string | null;
  selectedTableName: string | null;
  snapshotCount: number;
  siteUrl: string;
  capabilities: StudioCapabilities;
  onChangeMode: (mode: StudioMode) => void;
  onSelectCampaign: (id: string) => void;
  onCreateCampaign: () => void;
  onSelectTable: (tableName: string) => void;
  onCreateTable: () => void;
}

export function LeftRail({
  mode,
  config,
  selectedCampaignId,
  selectedTableName,
  snapshotCount,
  siteUrl,
  capabilities,
  onChangeMode,
  onSelectCampaign,
  onCreateCampaign,
  onSelectTable,
  onCreateTable,
}: LeftRailProps): ReactElement {
  const [query, setQuery] = useState("");
  const totalCampaigns = config?.experiences.length ?? 0;

  const experiences = useMemo(() => {
    const list = config?.experiences ?? [];
    const sorted = [...list].sort((a, b) => b.priority - a.priority);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sorted;
    return sorted.filter(
      (exp) =>
        exp.name.toLowerCase().includes(trimmed) ||
        exp.id.toLowerCase().includes(trimmed) ||
        summarizeExperienceMatch(exp).toLowerCase().includes(trimmed),
    );
  }, [config, query]);

  const tableEntries = useMemo(() => {
    const data = config?.data ?? {};
    return Object.entries(data).map(([name, table]) => ({
      name,
      rowCount: Object.keys(table).length,
    }));
  }, [config]);

  const siteHostname = formatSiteHostname(siteUrl);

  return (
    <aside className={styles.rail} aria-label="Workspace navigation">
      <div className={styles.railSection}>
        <div className={styles.segmented} role="tablist" aria-label="Studio workspace views">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "campaigns"}
            className={`${styles.segmentedBtn} ${mode === "campaigns" ? styles.segmentedBtnActive : ""}`}
            onClick={() => onChangeMode("campaigns")}
          >
            Campaigns
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "tables"}
            className={`${styles.segmentedBtn} ${mode === "tables" ? styles.segmentedBtnActive : ""}`}
            onClick={() => onChangeMode("tables")}
          >
            Accounts
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "history"}
            className={`${styles.segmentedBtn} ${mode === "history" ? styles.segmentedBtnActive : ""}`}
            onClick={() => onChangeMode("history")}
          >
            History
          </button>
        </div>
      </div>

      {mode === "campaigns" ? (
        <>
          {totalCampaigns > 3 ? (
            <div className={styles.railSection}>
              <div className={styles.searchWrap}>
                <SearchIcon size={14} className={styles.searchIcon} />
                <label htmlFor="studio-campaign-search" className="sr-only">
                  Filter campaigns
                </label>
                <input
                  id="studio-campaign-search"
                  type="search"
                  className={styles.searchInput}
                  placeholder="Filter campaigns..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          <ul className={styles.railList} aria-label="Campaigns list">
            {experiences.length === 0 ? (
              <li className={styles.railNote}>
                {query.trim()
                  ? "No campaigns match that filter."
                  : "No campaigns yet. Create your first campaign below."}
              </li>
            ) : (
              experiences.map((exp) => {
                const isSelected = exp.id === selectedCampaignId;
                return (
                  <li key={exp.id} className={styles.railItem}>
                    <button
                      type="button"
                      className={`${styles.railItemBtn} ${isSelected ? styles.railItemBtnActive : ""}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => onSelectCampaign(exp.id)}
                    >
                      <span className={styles.railItemTop}>
                        <span
                          className={exp.enabled ? styles.liveDot : styles.pausedDot}
                          title={exp.enabled ? "Live" : "Paused"}
                          aria-label={exp.enabled ? "Live" : "Paused"}
                        />
                        <span
                          className={`${styles.railItemName} ${isSelected ? styles.railItemNameActive : ""}`}
                        >
                          {exp.name}
                        </span>
                      </span>
                      <span className={styles.railItemMeta}>
                        <span className={styles.railMatchText}>
                          {summarizeExperienceMatch(exp)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <div className={styles.railFooter}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              style={{ width: "100%" }}
              onClick={onCreateCampaign}
            >
              <PlusIcon size={14} />
              New campaign
            </button>
          </div>
        </>
      ) : null}

      {mode === "tables" ? (
        <>
          <ul className={styles.railList} aria-label="Account tables list">
            {tableEntries.length === 0 ? (
              <li className={styles.railNote}>
                No account tables yet. Import a CSV to personalize copy per account.
              </li>
            ) : (
              tableEntries.map((item) => {
                const isSelected = item.name === selectedTableName;
                return (
                  <li key={item.name} className={styles.railItem}>
                    <button
                      type="button"
                      className={`${styles.railItemBtn} ${isSelected ? styles.railItemBtnActive : ""}`}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => onSelectTable(item.name)}
                    >
                      <span className={styles.railItemTop}>
                        <span className={styles.liveDot} aria-hidden="true" />
                        <span
                          className={`${styles.railItemName} ${isSelected ? styles.railItemNameActive : ""}`}
                        >
                          {item.name}
                        </span>
                      </span>
                      <span className={styles.railItemMeta}>
                        <span className={styles.tabular}>
                          {item.rowCount} {item.rowCount === 1 ? "account" : "accounts"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          <div className={styles.railFooter}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              style={{ width: "100%" }}
              onClick={onCreateTable}
            >
              <PlusIcon size={14} />
              Import CSV / New table
            </button>
          </div>
        </>
      ) : null}

      {mode === "history" ? (
        <div className={`${styles.railNote} ${styles.railFlexFill}`}>
          <p style={{ marginTop: 0 }}>
            <strong className={styles.tabular}>{snapshotCount}</strong> published{" "}
            {snapshotCount === 1 ? "version" : "versions"}.
          </p>
          <p style={{ marginBottom: 0 }}>
            Every publish saves an immutable snapshot you can restore in one click.
          </p>
        </div>
      ) : null}

      {mode === "setup" ? (
        <div className={`${styles.railNote} ${styles.railFlexFill}`}>
          <p style={{ marginTop: 0 }}>
            Connect any live site URL to preview campaigns and click elements directly on the page.
          </p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={() => onChangeMode("campaigns")}
          >
            Back to campaigns
          </button>
        </div>
      ) : null}

      <div className={styles.railSiteFooter}>
        <button
          type="button"
          className={`${styles.railSiteBtn} ${mode === "setup" ? styles.railSiteBtnActive : ""}`}
          aria-current={mode === "setup" ? "page" : undefined}
          onClick={() => onChangeMode("setup")}
        >
          <span className={styles.railSiteTitleRow}>
            <GlobeIcon size={14} />
            <span className={styles.railSiteTitle}>Site &amp; Setup</span>
          </span>
          <span className={styles.railSiteMeta}>
            {siteHostname ?? "No site connected"} · {capabilities.storageLabel}
          </span>
        </button>
      </div>
    </aside>
  );
}
