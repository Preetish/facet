import { useState, type ReactElement } from "react";
import type { ConfigSnapshotMeta } from "../../shared/types.js";
import { fetchSnapshotApi } from "../api.js";
import styles from "../Studio.module.css";
import { HistoryIcon } from "./Icons.js";

export interface HistoryViewProps {
  snapshots: readonly ConfigSnapshotMeta[];
  liveSnapshotId: string | null;
  isRollingBack: boolean;
  onRollback: (snapshotId: string) => Promise<void>;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryView({
  snapshots,
  liveSnapshotId,
  isRollingBack,
  onRollback,
}: HistoryViewProps): ReactElement {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snapshotYamls, setSnapshotYamls] = useState<Record<string, string>>({});

  async function toggleInspect(id: string): Promise<void> {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!snapshotYamls[id]) {
      try {
        const res = await fetchSnapshotApi(id);
        if (res.ok && res.snapshot) {
          setSnapshotYamls((prev) => ({ ...prev, [id]: res.snapshot!.yaml }));
        }
      } catch {
        // leave empty on error
      }
    }
  }

  return (
    <div className={styles.centerPane}>
      <div className={styles.editorHeader}>
        <h1 className={styles.pageHeading}>Version History &amp; Rollback</h1>
        <p className={styles.pageDescription}>
          Every published configuration is stored as an immutable, schema-validated snapshot. Roll
          back to any previous release in one click.
        </p>
      </div>

      {snapshots.length === 0 ? (
        <div className={styles.emptyState}>
          <HistoryIcon size={24} />
          <h2 className={styles.sectionTitle}>No published snapshots yet</h2>
          <p className={styles.sectionHelp}>
            Publish your current configuration using the Publish button in the top bar to record the
            first snapshot.
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th>Release</th>
                <th>Author</th>
                <th>Campaigns</th>
                <th>Hash</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap, index) => {
                const isLive =
                  snap.id === liveSnapshotId || (liveSnapshotId === null && index === 0);
                const isConfirming = confirmingId === snap.id;
                const isExpanded = expandedId === snap.id;
                return (
                  <tr key={snap.id}>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <strong>{snap.note || "Published configuration"}</strong>
                          {isLive ? (
                            <span className={`${styles.statusPill} ${styles.statusPillLive}`}>
                              Live
                            </span>
                          ) : null}
                        </div>
                        <span className={`${styles.hint} ${styles.tabular}`}>
                          {formatTimestamp(snap.publishedAt)}
                        </span>
                        {isExpanded && snapshotYamls[snap.id] ? (
                          <pre
                            className={styles.signedUrlBox}
                            style={{
                              margin: "8px 0 0",
                              maxHeight: "220px",
                              overflow: "auto",
                              whiteSpace: "pre",
                            }}
                          >
                            {snapshotYamls[snap.id]}
                          </pre>
                        ) : null}
                      </div>
                    </td>
                    <td>{snap.author || "—"}</td>
                    <td className={styles.tabular}>{snap.experienceCount}</td>
                    <td>
                      <code className={styles.hashChip}>{snap.hash.slice(0, 8)}</code>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnSm}`}
                          onClick={() => void toggleInspect(snap.id)}
                        >
                          {isExpanded ? "Hide YAML" : "View YAML"}
                        </button>

                        {!isLive ? (
                          isConfirming ? (
                            <>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                                disabled={isRollingBack}
                                onClick={() => {
                                  void onRollback(snap.id).then(() => setConfirmingId(null));
                                }}
                              >
                                {isRollingBack ? "Restoring..." : "Confirm Rollback"}
                              </button>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnSm}`}
                                onClick={() => setConfirmingId(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.btn} ${styles.btnSm}`}
                              onClick={() => setConfirmingId(snap.id)}
                            >
                              Rollback
                            </button>
                          )
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
