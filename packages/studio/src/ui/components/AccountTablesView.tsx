import {
  isForbiddenTemplateKey,
  type FacetConfig,
  type FacetDataRow,
  type FacetDataTable,
} from "@facet/core";
import { useMemo, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { importCsvApi } from "../api.js";
import styles from "../Studio.module.css";
import { AlertIcon, PlusIcon, TrashIcon, UploadIcon } from "./Icons.js";

export interface AccountTablesViewProps {
  config: FacetConfig;
  activeYaml: string;
  selectedTableName: string | null;
  onSelectTable: (name: string) => void;
  onUpdateTable: (tableName: string, table: FacetDataTable) => void;
  onCsvImported: (yaml: string, config: FacetConfig, tableName: string) => void;
}

const SAMPLE_CSV = `slug,name,team,headline,cta
meridian,Meridian Cloud,infrastructure,Zero-latency edge routing built for Meridian Cloud,Open Meridian's walkthrough
alder,Alder Data,platform,Resilient pipelines tailored for Alder Data,Explore Alder's benchmark`;

export function AccountTablesView({
  config,
  activeYaml,
  selectedTableName,
  onSelectTable,
  onUpdateTable,
  onCsvImported,
}: AccountTablesViewProps): ReactElement {
  const [csvText, setCsvText] = useState("");
  const [importTableName, setImportTableName] = useState(selectedTableName || "accounts");
  const [keyColumn, setKeyColumn] = useState("slug");
  const [mergeMode, setMergeMode] = useState<"merge" | "replace">("merge");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [newRowKey, setNewRowKey] = useState("");
  const [newColName, setNewColName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeTable: FacetDataTable = useMemo(() => {
    if (!selectedTableName || !config.data) return {};
    return config.data[selectedTableName] ?? {};
  }, [config.data, selectedTableName]);

  const columns = useMemo(() => {
    const set = new Set<string>();
    for (const row of Object.values(activeTable)) {
      for (const col of Object.keys(row)) {
        set.add(col);
      }
    }
    return Array.from(set);
  }, [activeTable]);

  const rows = useMemo(() => Object.entries(activeTable), [activeTable]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      setCsvText(content);
      const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
      const firstHeader = firstLine
        .split(",")[0]
        ?.replace(/^["'\uFEFF]+|["']+$/g, "")
        .trim();
      if (firstHeader) {
        setKeyColumn(firstHeader);
      }
      setImportError(null);
    };
    reader.readAsText(file);
  }

  async function handleImportCsv(): Promise<void> {
    setImportError(null);
    setImportSuccess(null);
    if (!csvText.trim()) {
      setImportError("Paste CSV rows or upload a .csv file first.");
      return;
    }

    setImporting(true);
    try {
      const result = await importCsvApi({
        csv: csvText,
        tableName: importTableName.trim() || "accounts",
        keyColumn: keyColumn.trim() || "slug",
        baseYaml: activeYaml,
        mergeMode,
      });

      if (!result.ok || !result.yaml || !result.config || !result.tableName) {
        setImportError(result.error ?? "Failed to import CSV.");
        return;
      }

      onCsvImported(result.yaml, result.config, result.tableName);
      onSelectTable(result.tableName);
      setImportSuccess(
        `Imported ${result.rowCount ?? 0} rows into "${result.tableName}". Review and click Publish when ready.`,
      );
      setCsvText("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "CSV import request failed.");
    } finally {
      setImporting(false);
    }
  }

  function handleCellChange(rowKey: string, col: string, value: string): void {
    if (!selectedTableName) return;
    const nextTable: FacetDataTable = { ...activeTable };
    const existingRow: FacetDataRow = { ...(nextTable[rowKey] ?? {}) };
    existingRow[col] = value;
    nextTable[rowKey] = existingRow;
    onUpdateTable(selectedTableName, nextTable);
  }

  function handleDeleteRow(rowKey: string): void {
    if (!selectedTableName) return;
    const nextTable: FacetDataTable = { ...activeTable };
    delete nextTable[rowKey];
    onUpdateTable(selectedTableName, nextTable);
  }

  function handleAddRow(): void {
    if (!selectedTableName) return;
    const key = newRowKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-");
    if (!key || isForbiddenTemplateKey(key)) return;
    const nextTable: FacetDataTable = { ...activeTable };
    const row: FacetDataRow = {};
    for (const col of columns.length > 0 ? columns : ["name", "headline", "cta"]) {
      row[col] = col === "name" ? newRowKey.trim() : "";
    }
    nextTable[key] = row;
    onUpdateTable(selectedTableName, nextTable);
    setNewRowKey("");
  }

  function handleAddColumn(): void {
    if (!selectedTableName) return;
    const col = newColName.trim().replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!col || isForbiddenTemplateKey(col) || columns.includes(col)) return;
    const nextTable: FacetDataTable = {};
    for (const [rowKey, rowVal] of Object.entries(activeTable)) {
      nextTable[rowKey] = { ...rowVal, [col]: "" };
    }
    onUpdateTable(selectedTableName, nextTable);
    setNewColName("");
  }

  return (
    <div className={styles.centerPane}>
      <div className={styles.editorHeader}>
        <h1 className={styles.pageHeading}>Account Tables</h1>
        <p className={styles.pageDescription}>
          Upload or edit account rows powering 1:1 ABM experiences. Columns become template
          variables such as <code>{"{{data.name}}"}</code> and <code>{"{{data.headline}}"}</code>.
        </p>
      </div>

      {/* CSV Importer */}
      <section className={styles.section} aria-labelledby="section-csv-import">
        <div className={styles.sectionHeader}>
          <h2 id="section-csv-import" className={styles.sectionTitle}>
            Import CSV into Account Table
          </h2>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => {
                setCsvText(SAMPLE_CSV);
                setKeyColumn("slug");
                setImportError(null);
              }}
            >
              Load example CSV
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon size={14} />
              Upload .csv file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={handleFileChange}
            />
          </div>
        </div>

        <div className={styles.fieldGridThree}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="csv-table-name">
              Target Table Name
            </label>
            <input
              id="csv-table-name"
              type="text"
              className={`${styles.input} ${styles.monoInput}`}
              value={importTableName}
              onChange={(e) => setImportTableName(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="csv-key-col">
              Key Column (Row Slug)
            </label>
            <input
              id="csv-key-col"
              type="text"
              className={`${styles.input} ${styles.monoInput}`}
              value={keyColumn}
              onChange={(e) => setKeyColumn(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="csv-merge-mode">
              Import Mode
            </label>
            <select
              id="csv-merge-mode"
              className={styles.select}
              value={mergeMode}
              onChange={(e) => setMergeMode(e.target.value as "merge" | "replace")}
            >
              <option value="merge">Merge with existing rows</option>
              <option value="replace">Replace entire table</option>
            </select>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="csv-paste-area">
            CSV Data
          </label>
          <textarea
            id="csv-paste-area"
            className={`${styles.textarea} ${styles.monoInput}`}
            rows={4}
            placeholder="slug,name,headline,cta"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
          />
        </div>

        {importError ? (
          <div className={styles.bannerError} style={{ margin: 0 }} role="alert">
            <div className={styles.bannerTitle}>
              <AlertIcon size={15} />
              {importError}
            </div>
          </div>
        ) : null}

        {importSuccess ? (
          <div className={styles.toastLive} role="status" aria-live="polite">
            {importSuccess}
          </div>
        ) : null}

        <div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
            disabled={importing}
            onClick={() => void handleImportCsv()}
          >
            {importing ? "Importing..." : "Import CSV"}
          </button>
        </div>
      </section>

      {/* Editable Table */}
      <section className={styles.section} aria-labelledby="section-table-rows">
        <div className={styles.sectionHeader}>
          <h2 id="section-table-rows" className={styles.sectionTitle}>
            {selectedTableName ? `Table: ${selectedTableName}` : "Select or import a table"}
          </h2>
          {selectedTableName ? (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                type="text"
                aria-label="New account slug"
                className={`${styles.input} ${styles.inputCompact} ${styles.monoInput}`}
                placeholder="new-account-slug"
                value={newRowKey}
                onChange={(e) => setNewRowKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddRow();
                }}
              />
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                onClick={handleAddRow}
              >
                <PlusIcon size={14} />
                Add Row
              </button>

              <input
                type="text"
                aria-label="New column name"
                className={`${styles.input} ${styles.inputCompact} ${styles.monoInput}`}
                placeholder="new_column"
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddColumn();
                }}
              />
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                onClick={handleAddColumn}
              >
                <PlusIcon size={14} />
                Add Column
              </button>
            </div>
          ) : null}
        </div>

        {selectedTableName && rows.length > 0 ? (
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>Key</th>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                  <th style={{ width: "44px" }}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([rowKey, rowVal]) => (
                  <tr key={rowKey}>
                    <td>
                      <code className={styles.hashChip}>{rowKey}</code>
                    </td>
                    {columns.map((col) => (
                      <td key={col}>
                        <input
                          type="text"
                          aria-label={`${rowKey} ${col}`}
                          className={styles.cellInput}
                          value={String(rowVal[col] ?? "")}
                          onChange={(e) => handleCellChange(rowKey, col, e.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
                        aria-label={`Delete row ${rowKey}`}
                        onClick={() => handleDeleteRow(rowKey)}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.sectionHelp}>
            {selectedTableName
              ? "This table has no rows yet. Add a row above or import a CSV."
              : "Import a CSV above to create your first account lookup table."}
          </p>
        )}
      </section>
    </div>
  );
}
