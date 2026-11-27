import type {
  FacetConfig,
  FacetDataTable,
  FacetExperience,
  FacetValidationError,
} from "@facet/core";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  ConfigSnapshot,
  ConfigSnapshotMeta,
  StudioCapabilities,
  ValidationWarning,
} from "../shared/types.js";
import { validateFacetYamlFull } from "../shared/validation.js";
import { serializeFacetConfig } from "../shared/yaml-serializer.js";
import { fetchStudioState, publishConfigApi, rollbackSnapshotApi, saveDraftApi } from "./api.js";
import { AccountTablesView } from "./components/AccountTablesView.js";
import { CampaignEditor } from "./components/CampaignEditor.js";
import { HistoryView } from "./components/HistoryView.js";
import { AlertIcon, PlusIcon } from "./components/Icons.js";
import { LeftRail, type StudioMode } from "./components/LeftRail.js";
import { PreviewPane } from "./components/PreviewPane.js";
import { SetupView } from "./components/SetupView.js";
import { TopBar } from "./components/TopBar.js";
import { YamlDrawer } from "./components/YamlDrawer.js";
import {
  createStarterCampaign,
  getFriendlyChangeTitle,
  slugifyCampaignId,
  updateAccountTableInConfig,
} from "./helpers/campaign-model.js";
import {
  applyPickedElementToChanges,
  formatSiteHostname,
  normalizeSiteUrl,
  type PickedElement,
} from "./helpers/live-preview.js";
import styles from "./Studio.module.css";

export function App(): ReactElement {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<StudioMode>("campaigns");
  const [liveSnapshot, setLiveSnapshot] = useState<ConfigSnapshot | null>(null);
  const [savedDraftYaml, setSavedDraftYaml] = useState<string | null>(null);
  const [activeYaml, setActiveYaml] = useState<string>("");
  const [config, setConfig] = useState<FacetConfig | null>(null);
  const [errors, setErrors] = useState<FacetValidationError[]>([]);
  const [warnings, setWarnings] = useState<ValidationWarning[]>([]);
  const [snapshots, setSnapshots] = useState<ConfigSnapshotMeta[]>([]);
  const [capabilities, setCapabilities] = useState<StudioCapabilities>({
    canSignPreview: false,
    targetUrl: null,
    authRequired: false,
    user: null,
    isDemoMode: false,
    storageLabel: "Local store",
    canLivePreview: true,
  });

  const [siteUrl, setSiteUrl] = useState<string>("");
  const siteUrlTouchedRef = useRef(false);
  const [pickMode, setPickMode] = useState(false);
  const [pickTargetChangeIndex, setPickTargetChangeIndex] = useState<number | null>(null);

  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null);
  const [yamlDrawerOpen, setYamlDrawerOpen] = useState(false);

  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  function showStatus(msg: string): void {
    setStatusMessage(msg);
    window.setTimeout(() => {
      setStatusMessage((current) => (current === msg ? null : current));
    }, 3000);
  }

  async function refreshState(): Promise<void> {
    try {
      const state = await fetchStudioState();
      setLiveSnapshot(state.live);
      setSavedDraftYaml(state.draft);
      setActiveYaml(state.activeYaml);
      setConfig(state.config);
      setErrors(state.errors);
      setWarnings(state.warnings);
      setSnapshots(state.snapshots);
      setCapabilities(state.capabilities);

      if (!siteUrlTouchedRef.current && state.capabilities.targetUrl) {
        setSiteUrl(state.capabilities.targetUrl);
      }

      if (state.config) {
        const firstCampaign = state.config.experiences[0]?.id ?? null;
        setSelectedCampaignId((prev) =>
          prev && state.config!.experiences.some((e) => e.id === prev) ? prev : firstCampaign,
        );
        const firstTable = Object.keys(state.config.data ?? {})[0] ?? null;
        setSelectedTableName((prev) =>
          prev && state.config!.data && prev in state.config!.data ? prev : firstTable,
        );
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load Studio state.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshState();
  }, []);

  // Automatically exit pick mode when switching campaigns or leaving Campaigns view
  useEffect(() => {
    setPickMode(false);
    setPickTargetChangeIndex(null);
  }, [selectedCampaignId, mode]);

  function commitConfigEdit(nextConfig: FacetConfig): void {
    const nextYaml = serializeFacetConfig(nextConfig);
    const validation = validateFacetYamlFull(nextYaml);
    setConfig(nextConfig);
    setActiveYaml(nextYaml);
    setErrors(validation.errors);
    setWarnings(validation.warnings);
  }

  function handleApplyRawYaml(nextYaml: string): void {
    const validation = validateFacetYamlFull(nextYaml);
    setActiveYaml(nextYaml);
    setErrors(validation.errors);
    setWarnings(validation.warnings);
    if (validation.config) {
      setConfig(validation.config);
      if (
        selectedCampaignId &&
        !validation.config.experiences.some((e) => e.id === selectedCampaignId)
      ) {
        setSelectedCampaignId(validation.config.experiences[0]?.id ?? null);
      }
    }
    showStatus("Applied YAML changes");
  }

  function handleCampaignChange(updated: FacetExperience): void {
    if (!config || !selectedCampaignId) return;
    const nextExperiences = config.experiences.map((exp) =>
      exp.id === selectedCampaignId ? updated : exp,
    );
    setSelectedCampaignId(updated.id);
    commitConfigEdit({ ...config, experiences: nextExperiences });
  }

  function handleCreateCampaign(): void {
    if (!config) return;
    const starter = createStarterCampaign(config.experiences.map((e) => e.id));
    const nextConfig: FacetConfig = {
      ...config,
      experiences: [starter, ...config.experiences],
    };
    commitConfigEdit(nextConfig);
    setSelectedCampaignId(starter.id);
    setMode("campaigns");
    showStatus("Created new campaign");
  }

  function handleDuplicateCampaign(): void {
    if (!config || !selectedCampaign) return;
    const newId = slugifyCampaignId(
      `${selectedCampaign.id}-copy`,
      config.experiences.map((e) => e.id),
    );
    const copy: FacetExperience = {
      ...structuredClone(selectedCampaign),
      id: newId,
      name: `${selectedCampaign.name} (Copy)`,
      enabled: false,
    };
    commitConfigEdit({
      ...config,
      experiences: [copy, ...config.experiences],
    });
    setSelectedCampaignId(newId);
    showStatus("Duplicated campaign");
  }

  function handleDeleteCampaign(): void {
    if (!config || !selectedCampaignId) return;
    const remaining = config.experiences.filter((exp) => exp.id !== selectedCampaignId);
    commitConfigEdit({ ...config, experiences: remaining });
    setSelectedCampaignId(remaining[0]?.id ?? null);
    showStatus("Removed campaign");
  }

  function handleUpdateTable(tableName: string, table: FacetDataTable): void {
    if (!config) return;
    const nextConfig = updateAccountTableInConfig(config, tableName, table);
    commitConfigEdit(nextConfig);
  }

  function handleSiteUrlChange(nextUrl: string): void {
    siteUrlTouchedRef.current = true;
    setSiteUrl(nextUrl);
    setPickMode(false);
    setPickTargetChangeIndex(null);
  }

  function handleLoadLiveSiteFromSetup(nextUrl: string): void {
    handleSiteUrlChange(nextUrl);
    setMode("campaigns");
    const host = formatSiteHostname(nextUrl);
    showStatus(host ? `Connected ${host}` : "Loaded live site");
  }

  function handleStartPickElement(changeIndex: number | null): void {
    if (pickMode && pickTargetChangeIndex === changeIndex) {
      setPickMode(false);
      setPickTargetChangeIndex(null);
      return;
    }
    setPickTargetChangeIndex(changeIndex);
    setPickMode(true);
  }

  function handlePickModeChange(enabled: boolean): void {
    setPickMode(enabled);
    if (!enabled) {
      setPickTargetChangeIndex(null);
    }
  }

  function handleElementPicked(picked: PickedElement): void {
    setPickMode(false);
    const targetIdx = pickTargetChangeIndex;
    setPickTargetChangeIndex(null);
    if (!selectedCampaign) return;

    const nextChanges = applyPickedElementToChanges(selectedCampaign.changes, picked, targetIdx);
    handleCampaignChange({
      ...selectedCampaign,
      changes: nextChanges,
    });
    showStatus(`Picked ${picked.selector} from page`);
  }

  async function handleSaveDraft(): Promise<void> {
    setIsSavingDraft(true);
    try {
      const res = await saveDraftApi(activeYaml);
      if (res.ok) {
        setSavedDraftYaml(activeYaml);
        showStatus("Draft saved");
      } else if (res.errors) {
        setErrors(res.errors);
      }
    } finally {
      setIsSavingDraft(false);
    }
  }

  async function handlePublish(author: string, note: string): Promise<boolean> {
    setIsPublishing(true);
    try {
      const res = await publishConfigApi({
        yaml: activeYaml,
        ...(author ? { author } : {}),
        ...(note ? { note } : {}),
      });
      if (!res.ok) {
        if (res.errors) setErrors(res.errors);
        return false;
      }
      await refreshState();
      showStatus("Published live");
      return true;
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleRollback(snapshotId: string): Promise<void> {
    setIsRollingBack(true);
    try {
      const res = await rollbackSnapshotApi({ snapshotId });
      if (res.ok) {
        await refreshState();
        showStatus("Rolled back to snapshot");
      } else if (res.errors) {
        setErrors(res.errors);
      }
    } finally {
      setIsRollingBack(false);
    }
  }

  const selectedCampaign = useMemo(() => {
    if (!config || !selectedCampaignId) return null;
    return config.experiences.find((e) => e.id === selectedCampaignId) ?? null;
  }, [config, selectedCampaignId]);

  const canPickElement = capabilities.canLivePreview && normalizeSiteUrl(siteUrl) !== null;

  const pickTargetLabel = useMemo(() => {
    if (pickTargetChangeIndex === null || !selectedCampaign) return null;
    const change = selectedCampaign.changes[pickTargetChangeIndex];
    return change ? getFriendlyChangeTitle(change) : null;
  }, [pickTargetChangeIndex, selectedCampaign]);

  const baselineYaml = savedDraftYaml ?? liveSnapshot?.yaml ?? "";
  const hasUnsavedDraft = activeYaml.trim() !== baselineYaml.trim();
  const hasSavedDraft =
    savedDraftYaml !== null && savedDraftYaml.trim() !== (liveSnapshot?.yaml ?? "").trim();

  if (loading) {
    return (
      <div className={styles.shell}>
        <header className={styles.topBar}>
          <div className={styles.skeletonBar} style={{ width: "140px" }} />
          <div className={styles.skeletonBar} style={{ width: "200px" }} />
        </header>
        <div className={styles.workspace}>
          <div className={styles.rail} style={{ padding: "18px", gap: "12px" }}>
            <div className={styles.skeletonBar} style={{ width: "100%", height: "32px" }} />
            <div className={styles.skeletonBar} style={{ width: "85%" }} />
            <div className={styles.skeletonBar} style={{ width: "70%" }} />
          </div>
          <div className={styles.centerPane} style={{ padding: "28px", gap: "16px" }}>
            <div className={styles.skeletonBar} style={{ width: "45%", height: "28px" }} />
            <div className={styles.skeletonBar} style={{ width: "90%" }} />
            <div className={styles.skeletonBar} style={{ width: "75%" }} />
          </div>
          <div className={styles.previewPane} style={{ padding: "20px", gap: "12px" }}>
            <div className={styles.skeletonBar} style={{ width: "60%" }} />
            <div className={styles.skeletonBar} style={{ width: "100%", height: "160px" }} />
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.shell}>
        <div className={styles.bannerError} style={{ maxWidth: "600px", margin: "40px auto" }}>
          <div className={styles.bannerTitle}>
            <AlertIcon size={16} />
            Unable to connect to Facet Studio API
          </div>
          <p style={{ margin: 0 }}>{loadError}</p>
          <div>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => void refreshState()}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <TopBar
        siteUrl={siteUrl}
        isDemoMode={capabilities.isDemoMode}
        isSetupActive={mode === "setup"}
        hasUnsavedDraft={hasUnsavedDraft}
        hasSavedDraft={hasSavedDraft}
        errorCount={errors.length}
        isSavingDraft={isSavingDraft}
        isPublishing={isPublishing}
        yamlDrawerOpen={yamlDrawerOpen}
        user={capabilities.user}
        statusMessage={statusMessage}
        onOpenSetup={() => setMode("setup")}
        onToggleYamlDrawer={() => setYamlDrawerOpen((open) => !open)}
        onSaveDraft={() => void handleSaveDraft()}
        onPublish={handlePublish}
      />

      <main className={`${styles.workspace} ${mode !== "campaigns" ? styles.workspaceWide : ""}`}>
        <LeftRail
          mode={mode}
          config={config}
          selectedCampaignId={selectedCampaignId}
          selectedTableName={selectedTableName}
          snapshotCount={snapshots.length}
          siteUrl={siteUrl}
          capabilities={capabilities}
          onChangeMode={setMode}
          onSelectCampaign={(id) => {
            setSelectedCampaignId(id);
            setMode("campaigns");
          }}
          onCreateCampaign={handleCreateCampaign}
          onSelectTable={(name) => {
            setSelectedTableName(name);
            setMode("tables");
          }}
          onCreateTable={() => setMode("tables")}
        />

        {mode === "campaigns" ? (
          config && selectedCampaign ? (
            <CampaignEditor
              config={config}
              experience={selectedCampaign}
              errors={errors}
              warnings={warnings}
              canPickElement={canPickElement}
              pickMode={pickMode}
              pickTargetChangeIndex={pickTargetChangeIndex}
              onChange={handleCampaignChange}
              onDuplicate={handleDuplicateCampaign}
              onDelete={handleDeleteCampaign}
              onOpenYaml={() => setYamlDrawerOpen(true)}
              onStartPickElement={handleStartPickElement}
            />
          ) : (
            <div className={styles.centerPane}>
              <div className={styles.emptyState}>
                <h1 className={styles.pageHeading}>No campaign selected</h1>
                <p className={styles.pageDescription}>
                  Create a campaign to personalize hero copy, CTAs, or 1:1 ABM landing pages at the
                  edge with zero flicker.
                </p>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={handleCreateCampaign}
                >
                  <PlusIcon size={16} />
                  Create Campaign
                </button>
              </div>
            </div>
          )
        ) : null}

        {mode === "tables" && config ? (
          <AccountTablesView
            config={config}
            activeYaml={activeYaml}
            selectedTableName={selectedTableName}
            onSelectTable={setSelectedTableName}
            onUpdateTable={handleUpdateTable}
            onCsvImported={(nextYaml, nextConfig, tableName) => {
              setActiveYaml(nextYaml);
              setConfig(nextConfig);
              setSelectedTableName(tableName);
              const validation = validateFacetYamlFull(nextYaml);
              setErrors(validation.errors);
              setWarnings(validation.warnings);
              showStatus(`Imported CSV into ${tableName}`);
            }}
          />
        ) : null}

        {mode === "history" ? (
          <HistoryView
            snapshots={snapshots}
            liveSnapshotId={liveSnapshot?.id ?? null}
            isRollingBack={isRollingBack}
            onRollback={handleRollback}
          />
        ) : null}

        {mode === "setup" ? (
          <SetupView
            siteUrl={siteUrl}
            capabilities={capabilities}
            onLoadLiveSite={handleLoadLiveSiteFromSetup}
            onClearSiteUrl={() => {
              handleSiteUrlChange("");
              showStatus("Switched to specimen preview");
            }}
          />
        ) : null}

        {mode === "campaigns" ? (
          <PreviewPane
            config={config}
            experience={selectedCampaign}
            capabilities={capabilities}
            siteUrl={siteUrl}
            pickMode={pickMode}
            pickTargetLabel={pickTargetLabel}
            onSiteUrlChange={handleSiteUrlChange}
            onPickModeChange={handlePickModeChange}
            onElementPicked={handleElementPicked}
          />
        ) : null}
      </main>

      <YamlDrawer
        open={yamlDrawerOpen}
        yaml={activeYaml}
        onClose={() => setYamlDrawerOpen(false)}
        onApplyYaml={handleApplyRawYaml}
      />
    </div>
  );
}
