import { useEffect, useRef, useState, type ReactElement } from "react";
import { formatSiteHostname } from "../helpers/live-preview.js";
import styles from "../Studio.module.css";
import { CheckIcon, CodeIcon, FacetMark, GlobeIcon } from "./Icons.js";

export interface TopBarProps {
  siteUrl: string;
  isDemoMode: boolean;
  isSetupActive: boolean;
  hasUnsavedDraft: boolean;
  hasSavedDraft: boolean;
  errorCount: number;
  isSavingDraft: boolean;
  isPublishing: boolean;
  yamlDrawerOpen: boolean;
  user: string | null;
  statusMessage: string | null;
  onOpenSetup: () => void;
  onToggleYamlDrawer: () => void;
  onSaveDraft: () => void;
  onPublish: (author: string, note: string) => Promise<boolean>;
}

export function TopBar({
  siteUrl,
  isDemoMode,
  isSetupActive,
  hasUnsavedDraft,
  hasSavedDraft,
  errorCount,
  isSavingDraft,
  isPublishing,
  yamlDrawerOpen,
  user,
  statusMessage,
  onOpenSetup,
  onToggleYamlDrawer,
  onSaveDraft,
  onPublish,
}: TopBarProps): ReactElement {
  const [publishOpen, setPublishOpen] = useState(false);
  const [author, setAuthor] = useState(user ?? "");
  const [note, setNote] = useState("");
  const noteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user && !author) {
      setAuthor(user);
    }
  }, [user, author]);

  useEffect(() => {
    if (!publishOpen) return;
    noteInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPublishOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [publishOpen]);

  async function handleConfirmPublish(): Promise<void> {
    const ok = await onPublish(author.trim(), note.trim());
    if (ok) {
      setNote("");
      setPublishOpen(false);
    }
  }

  const siteHostname = formatSiteHostname(siteUrl);
  const connectionLabel = siteHostname
    ? isDemoMode
      ? `${siteHostname} · Demo`
      : siteHostname
    : isDemoMode
      ? "Demo mode · Connect site"
      : "Connect site";

  return (
    <header className={styles.topBar}>
      <div className={styles.brandGroup}>
        <FacetMark size={24} />
        <span className={styles.wordmark}>Facet</span>
        <span className={styles.studioTitle}>Studio</span>
        <span className={styles.topBarDivider} aria-hidden="true" />
        <button
          type="button"
          className={`${styles.siteChip} ${
            isSetupActive
              ? styles.siteChipActive
              : siteHostname
                ? styles.siteChipConnected
                : isDemoMode
                  ? styles.siteChipDemo
                  : ""
          }`}
          aria-current={isSetupActive ? "page" : undefined}
          title="Configure connected website and setup"
          onClick={onOpenSetup}
        >
          <GlobeIcon size={13} />
          <span className={styles.siteChipText}>{connectionLabel}</span>
        </button>
      </div>

      <div className={styles.topCenter}>
        {errorCount > 0 ? (
          <span className={`${styles.statusPill} ${styles.statusPillError}`} role="status">
            <span className={styles.statusDot} aria-hidden="true" />
            {errorCount} {errorCount === 1 ? "issue" : "issues"}
          </span>
        ) : hasUnsavedDraft ? (
          <span className={`${styles.statusPill} ${styles.statusPillDraft}`} role="status">
            <span className={`${styles.statusDot} ${styles.statusDotOchre}`} aria-hidden="true" />
            Unsaved changes
          </span>
        ) : hasSavedDraft ? (
          <span className={`${styles.statusPill} ${styles.statusPillDraft}`} role="status">
            <span className={`${styles.statusDot} ${styles.statusDotOchre}`} aria-hidden="true" />
            Draft saved
          </span>
        ) : (
          <span className={`${styles.statusPill} ${styles.statusPillLive}`} role="status">
            <span className={styles.statusDot} aria-hidden="true" />
            Live
          </span>
        )}

        {statusMessage ? (
          <span className={styles.toastLive} role="status" aria-live="polite">
            {statusMessage}
          </span>
        ) : null}
      </div>

      <div className={styles.topActions}>
        {hasUnsavedDraft ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            disabled={isSavingDraft || errorCount > 0}
            onClick={onSaveDraft}
          >
            {isSavingDraft ? "Saving..." : "Save Draft"}
          </button>
        ) : null}

        <button
          type="button"
          className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost} ${yamlDrawerOpen ? styles.btnActive : ""}`}
          aria-expanded={yamlDrawerOpen}
          onClick={onToggleYamlDrawer}
        >
          <CodeIcon size={14} />
          YAML
        </button>

        <button
          type="button"
          className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
          disabled={isPublishing || errorCount > 0}
          aria-expanded={publishOpen}
          onClick={() => setPublishOpen((open) => !open)}
        >
          <CheckIcon size={14} />
          {isPublishing ? "Publishing..." : "Publish"}
        </button>

        {publishOpen ? (
          <div className={styles.publishPopover} role="dialog" aria-label="Publish live snapshot">
            <h2 className={styles.popoverTitle}>Publish changes</h2>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="studio-publish-note">
                Release note
              </label>
              <input
                ref={noteInputRef}
                id="studio-publish-note"
                type="text"
                className={styles.input}
                placeholder="e.g. Updated Q4 fintech headline"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleConfirmPublish();
                  }
                }}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="studio-publish-author">
                Author (optional)
              </label>
              <input
                id="studio-publish-author"
                type="text"
                className={styles.input}
                placeholder="e.g. maya@company.com"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </div>

            <div className={styles.popoverActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm}`}
                onClick={() => setPublishOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                disabled={isPublishing || errorCount > 0}
                onClick={() => void handleConfirmPublish()}
              >
                {isPublishing ? "Publishing..." : "Confirm Publish"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
