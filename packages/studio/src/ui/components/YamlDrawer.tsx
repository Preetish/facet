import { useEffect, useMemo, useState, type ReactElement } from "react";
import { validateFacetYamlFull } from "../../shared/validation.js";
import styles from "../Studio.module.css";
import { AlertIcon, CheckIcon, CopyIcon, XIcon } from "./Icons.js";

export interface YamlDrawerProps {
  open: boolean;
  yaml: string;
  onClose: () => void;
  onApplyYaml: (nextYaml: string) => void;
}

export function YamlDrawer({
  open,
  yaml,
  onClose,
  onApplyYaml,
}: YamlDrawerProps): ReactElement | null {
  const [draftYaml, setDraftYaml] = useState(yaml);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDraftYaml(yaml);
  }, [yaml, open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const validation = useMemo(() => validateFacetYamlFull(draftYaml), [draftYaml]);
  const lineCount = useMemo(() => Math.max(1, draftYaml.split("\n").length), [draftYaml]);

  if (!open) return null;

  async function handleCopy(): Promise<void> {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(draftYaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div
      className={styles.drawerBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Inspect facet.yaml"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.drawerPanel}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.sectionTitle}>Inspect facet.yaml</h2>
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => void handleCopy()}
            >
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
              aria-label="Close YAML drawer"
              onClick={onClose}
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {!validation.ok ? (
          <div className={styles.bannerError} style={{ margin: "12px 18px 0" }} role="alert">
            <div className={styles.bannerTitle}>
              <AlertIcon size={15} />
              YAML validation error
            </div>
            <ul className={styles.bannerList}>
              {validation.errors.slice(0, 4).map((err, idx) => (
                <li key={idx}>
                  {err.line ? `Line ${err.line}: ` : ""}
                  {err.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className={styles.drawerBody}>
          <div className={styles.lineGutter} aria-hidden="true">
            {Array.from({ length: lineCount }, (_, idx) => (
              <div key={idx}>{idx + 1}</div>
            ))}
          </div>
          <textarea
            aria-label="facet.yaml editor"
            className={styles.yamlTextarea}
            spellCheck={false}
            value={draftYaml}
            onChange={(e) => setDraftYaml(e.target.value)}
          />
        </div>

        <div className={styles.drawerFooter}>
          <span className={styles.hint}>
            {validation.ok
              ? "Valid Facet v1 schema"
              : `${validation.errors.length} syntax/schema issues`}
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
              disabled={!validation.ok || draftYaml === yaml}
              onClick={() => {
                onApplyYaml(draftYaml);
                onClose();
              }}
            >
              Apply YAML
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
