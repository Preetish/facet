import {
  buildContextFromRequest,
  evaluate,
  type FacetConfig,
  type FacetExperience,
} from "@facet/core";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { StudioCapabilities } from "../../shared/types.js";
import { createPreviewLinkApi } from "../api.js";
import { buildDefaultTestPathForExperience } from "../helpers/campaign-model.js";
import {
  buildLivePreviewIframeSrc,
  formatSiteHostname,
  normalizeSiteUrl,
  parseBridgeMessage,
  type AppliedStatus,
  type PickedElement,
} from "../helpers/live-preview.js";
import styles from "../Studio.module.css";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  LinkIcon,
  RefreshIcon,
} from "./Icons.js";

export interface PreviewPaneProps {
  config: FacetConfig | null;
  experience: FacetExperience | null;
  capabilities: StudioCapabilities;
  siteUrl: string;
  pickMode: boolean;
  pickTargetLabel: string | null;
  onSiteUrlChange: (url: string) => void;
  onPickModeChange: (enabled: boolean) => void;
  onElementPicked: (picked: PickedElement) => void;
}

const DEFAULT_HEADLINE = "Ship faster on a single global edge";
const DEFAULT_SUBHEAD =
  "Deploy websites and APIs close to every visitor with zero-flicker edge delivery.";
const DEFAULT_CTA = "Start free";
const DEFAULT_HREF = "/signup";

function isSafeHttpUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function PreviewPane({
  config,
  experience,
  capabilities,
  siteUrl,
  pickMode,
  pickTargetLabel,
  onSiteUrlChange,
  onPickModeChange,
  onElementPicked,
}: PreviewPaneProps): ReactElement {
  const [viewMode, setViewMode] = useState<"original" | "personalized">("personalized");
  const [selectedAccountKey, setSelectedAccountKey] = useState<string>("");
  const [surfacePreference, setSurfacePreference] = useState<"live" | "specimen">("live");

  // Live URL bar + iframe state
  const [urlDraft, setUrlDraft] = useState(siteUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [iframeReady, setIframeReady] = useState(false);
  const [iframeTimedOut, setIframeTimedOut] = useState(false);
  const [appliedStatus, setAppliedStatus] = useState<AppliedStatus | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Latest callbacks in refs to avoid re-subscribing the window message listener on every edit
  const onPickModeChangeRef = useRef(onPickModeChange);
  const onElementPickedRef = useRef(onElementPicked);
  onPickModeChangeRef.current = onPickModeChange;
  onElementPickedRef.current = onElementPicked;

  // Share link state (defaults to Personalized / 7 days / active siteUrl)
  const [shareBucket, setShareBucket] = useState<"variant" | "control">("variant");
  const [shareTtlSeconds, setShareTtlSeconds] = useState(604_800);
  const [shareBaseUrl, setShareBaseUrl] = useState(siteUrl || capabilities.targetUrl || "");
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  const normalizedSiteUrl = useMemo(() => normalizeSiteUrl(siteUrl), [siteUrl]);
  const canUseLiveIframe = capabilities.canLivePreview && normalizedSiteUrl !== null;
  const showLiveIframe = canUseLiveIframe && surfacePreference === "live";

  useEffect(() => {
    setUrlDraft(siteUrl);
    if (siteUrl) {
      setSurfacePreference("live");
      setShareBaseUrl(siteUrl);
    }
  }, [siteUrl]);

  useEffect(() => {
    if (capabilities.targetUrl && !shareBaseUrl) {
      setShareBaseUrl(capabilities.targetUrl);
    }
  }, [capabilities.targetUrl, shareBaseUrl]);

  // If user starts picking from the editor while in specimen view, switch back to live iframe
  useEffect(() => {
    if (pickMode && canUseLiveIframe && surfacePreference !== "live") {
      setSurfacePreference("live");
    }
  }, [pickMode, canUseLiveIframe, surfacePreference]);

  // Reset iframe readiness when URL or reload changes
  useEffect(() => {
    setIframeReady(false);
    setIframeTimedOut(false);
    setAppliedStatus(null);
  }, [normalizedSiteUrl, reloadNonce, showLiveIframe]);

  // Detect stalled / unreachable iframe loads cleanly so users can switch to Specimen
  useEffect(() => {
    if (!showLiveIframe || iframeReady) return;
    const timer = window.setTimeout(() => {
      setIframeTimedOut(true);
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [showLiveIframe, iframeReady, normalizedSiteUrl, reloadNonce]);

  const accountOptions = useMemo(() => {
    if (!experience?.lookup || !config?.data) return [];
    const table = config.data[experience.lookup.table];
    if (!table) return [];
    return Object.entries(table).map(([key, row]) => ({
      key,
      label: typeof row["name"] === "string" && row["name"].trim() ? row["name"] : key,
    }));
  }, [experience, config]);

  useEffect(() => {
    setSelectedAccountKey(accountOptions[0]?.key ?? "");
    setSignedUrl(null);
    setShareError(null);
    setCopied(false);
  }, [experience?.id, experience?.lookup?.table]);

  const activeAccountKey = useMemo(() => {
    if (accountOptions.length === 0) return "";
    if (accountOptions.some((opt) => opt.key === selectedAccountKey)) {
      return selectedAccountKey;
    }
    return accountOptions[0]!.key;
  }, [accountOptions, selectedAccountKey]);

  const testDefaults = useMemo(() => {
    if (!config || !experience) return null;
    return buildDefaultTestPathForExperience(experience, config, activeAccountKey || undefined);
  }, [config, experience, activeAccountKey]);

  const evaluation = useMemo(() => {
    if (!config || !experience || !testDefaults) return null;
    const request = new Request(`https://preview.example.com${testDefaults.pathAndQuery}`);
    const context = buildContextFromRequest(request, {
      visitorId: "studio-preview",
      returning: testDefaults.returning,
      geo: {
        ...(testDefaults.country ? { country: testDefaults.country } : {}),
        ...(testDefaults.continent ? { continent: testDefaults.continent } : {}),
      },
    });

    return evaluate(config, context, {
      visitorId: "studio-preview",
      previewExperienceId: experience.id,
      previewBucket: viewMode === "personalized" ? "variant" : "default",
    });
  }, [config, experience, testDefaults, viewMode]);

  // Listen to bridge postMessage events from our same-origin live preview iframe
  useEffect(() => {
    if (!showLiveIframe) return;

    function handleMessage(event: MessageEvent): void {
      if (event.origin !== window.location.origin) return;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;

      const message = parseBridgeMessage(event.data);
      if (!message) return;

      if (message.type === "facet:ready") {
        setIframeReady(true);
        setIframeTimedOut(false);
      } else if (message.type === "facet:applied") {
        setAppliedStatus({
          matchedCount: message.matchedCount,
          totalCount: message.totalCount,
          missingSelectors: message.missingSelectors,
        });
      } else if (message.type === "facet:picked") {
        onPickModeChangeRef.current(false);
        onElementPickedRef.current({
          selector: message.selector,
          tagName: message.tagName,
          text: message.text,
          href: message.href,
        });
      } else if (message.type === "facet:pick-cancelled") {
        onPickModeChangeRef.current(false);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [showLiveIframe]);

  // Push zero-reload personalization updates to the iframe whenever ready or edits change
  useEffect(() => {
    if (!showLiveIframe || !iframeReady) return;
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return;

    const isPersonalized = viewMode === "personalized";
    const changes = isPersonalized ? (evaluation?.activeChanges ?? []) : [];

    frameWindow.postMessage(
      {
        type: "facet:apply",
        changes,
        highlight: isPersonalized,
      },
      window.location.origin,
    );
  }, [showLiveIframe, iframeReady, viewMode, evaluation]);

  // Sync click-to-pick mode state into the iframe
  useEffect(() => {
    if (!showLiveIframe || !iframeReady) return;
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return;

    frameWindow.postMessage(
      {
        type: "facet:pick-mode",
        enabled: pickMode,
      },
      window.location.origin,
    );
  }, [showLiveIframe, iframeReady, pickMode]);

  // Allow pressing Escape in the parent Studio window to cancel pick mode too
  useEffect(() => {
    if (!pickMode) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onPickModeChangeRef.current(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pickMode]);

  const previewModel = useMemo(() => {
    let headline = DEFAULT_HEADLINE;
    let headlineChanged = false;
    let subhead = DEFAULT_SUBHEAD;
    let subheadChanged = false;
    let ctaText = DEFAULT_CTA;
    let ctaHref = DEFAULT_HREF;
    let ctaChanged = false;
    let slotName: string | null = null;
    const extraChanges: string[] = [];

    for (const change of evaluation?.activeChanges ?? []) {
      const sel = change.selector.toLowerCase();
      if (sel === "h1" || sel.includes("headline")) {
        if (change.text) {
          headline = change.text;
          headlineChanged = true;
        }
      } else if (sel.includes("subhead") || sel === "p") {
        if (change.text) {
          subhead = change.text;
          subheadChanged = true;
        }
      } else if (sel.includes("cta") || sel === "a" || sel === "button") {
        if (change.text) {
          ctaText = change.text;
          ctaChanged = true;
        }
        const href = change.attrs?.["href"];
        if (typeof href === "string" && href.length > 0) {
          ctaHref = href;
          ctaChanged = true;
        }
      } else if (change.slot !== undefined || change.html !== undefined) {
        slotName = change.slot ?? change.selector;
      } else if (change.text) {
        extraChanges.push(change.text);
      }
    }

    return {
      headline,
      headlineChanged,
      subhead,
      subheadChanged,
      ctaText,
      ctaHref,
      ctaChanged,
      slotName,
      extraChanges,
    };
  }, [evaluation]);

  function handleUrlSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      setUrlError(null);
      onSiteUrlChange("");
      return;
    }
    const normalized = normalizeSiteUrl(trimmed);
    if (!normalized) {
      setUrlError("Enter a valid http:// or https:// URL.");
      return;
    }
    setUrlError(null);
    setSurfacePreference("live");
    if (normalized === normalizedSiteUrl) {
      setReloadNonce((n) => n + 1);
    } else {
      onSiteUrlChange(normalized);
    }
  }

  async function handleCopyPreviewLink(): Promise<void> {
    if (!experience) return;
    setShareError(null);
    setSharing(true);
    setCopied(false);

    try {
      const result = await createPreviewLinkApi({
        experienceId: experience.id,
        bucket: shareBucket,
        baseUrl: shareBaseUrl.trim() || normalizedSiteUrl || capabilities.targetUrl || undefined,
        ttlSeconds: shareTtlSeconds,
      });

      if (!result.ok || !result.url) {
        setShareError(result.error ?? "Unable to create preview link.");
        return;
      }

      setSignedUrl(result.url);
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(result.url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2400);
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Failed to create preview link.");
    } finally {
      setSharing(false);
    }
  }

  if (!config || !experience) {
    return (
      <aside className={styles.previewPane} aria-label="Preview">
        <div className={styles.previewBlock}>
          <h2 className={styles.previewTitle}>Preview</h2>
          <p className={styles.sectionHelp}>Select a campaign to see how the page changes.</p>
        </div>
      </aside>
    );
  }

  const holdoutPct = Math.round(experience.holdout * 100);
  const isPersonalized = viewMode === "personalized";
  const displayPath = (testDefaults?.pathAndQuery.split("?")[0] ?? "/") || "/";
  const liveHostname = formatSiteHostname(normalizedSiteUrl);
  const livePreviewSrc = normalizedSiteUrl ? buildLivePreviewIframeSrc(normalizedSiteUrl) : "";
  const urlChangedFromActive = normalizeSiteUrl(urlDraft) !== normalizedSiteUrl;
  const externalSiteUrl =
    normalizedSiteUrl ?? (isSafeHttpUrl(capabilities.targetUrl) ? capabilities.targetUrl : null);

  return (
    <aside className={styles.previewPane} aria-label="Preview">
      <div className={styles.previewContent}>
        {/* Compact Live URL Bar */}
        {capabilities.canLivePreview ? (
          <form className={styles.liveUrlBar} onSubmit={handleUrlSubmit} noValidate>
            <label htmlFor="preview-site-url" className="sr-only">
              Website URL to preview
            </label>
            <input
              id="preview-site-url"
              type="url"
              className={`${styles.input} ${styles.monoInput} ${styles.liveUrlInput}`}
              placeholder="https://yoursite.com"
              value={urlDraft}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                if (urlError) setUrlError(null);
              }}
            />
            <button
              type="submit"
              className={`${styles.btn} ${styles.btnSm}`}
              title={urlChangedFromActive || !normalizedSiteUrl ? "Load website" : "Reload website"}
            >
              {!urlChangedFromActive && normalizedSiteUrl ? <RefreshIcon size={13} /> : null}
              {!urlChangedFromActive && normalizedSiteUrl ? "Reload" : "Load"}
            </button>
          </form>
        ) : null}

        {urlError ? (
          <p className={styles.setupInlineError} role="alert" style={{ margin: "-8px 0 0" }}>
            {urlError}
          </p>
        ) : null}

        {/* Version Switcher + Pick Element Controls */}
        <div className={styles.previewHeaderRow}>
          <div className={styles.segmentedControl} role="radiogroup" aria-label="Preview version">
            <button
              type="button"
              role="radio"
              aria-checked={!isPersonalized}
              className={`${styles.segOption} ${!isPersonalized ? styles.segOptionActive : ""}`}
              onClick={() => setViewMode("original")}
            >
              Original
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isPersonalized}
              className={`${styles.segOption} ${isPersonalized ? styles.segOptionPine : ""}`}
              onClick={() => setViewMode("personalized")}
            >
              Personalized
            </button>
          </div>

          {canUseLiveIframe ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${pickMode ? styles.btnPrimary : ""}`}
              disabled={!showLiveIframe || !iframeReady}
              aria-pressed={pickMode}
              title={
                !showLiveIframe
                  ? "Switch to Live view to pick elements on your page"
                  : !iframeReady
                    ? "Waiting for live page to finish loading..."
                    : "Click any element on the page to personalize it"
              }
              onClick={() => onPickModeChange(!pickMode)}
            >
              <CrosshairIcon size={14} />
              {pickMode ? "Picking..." : "Pick element"}
            </button>
          ) : null}
        </div>

        {/* Single-line Match Status Badge */}
        {showLiveIframe ? (
          <div className={styles.matchStatusRow} aria-live="polite">
            {!iframeReady ? (
              iframeTimedOut ? (
                <div className={styles.matchBadgeWarn}>
                  <span>Could not connect to live page.</span>
                  <button
                    type="button"
                    className={styles.matchBadgeLink}
                    onClick={() => setReloadNonce((n) => n + 1)}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className={styles.matchBadgeLink}
                    onClick={() => setSurfacePreference("specimen")}
                  >
                    Use specimen
                  </button>
                </div>
              ) : (
                <span className={styles.matchBadgeNeutral}>Loading {liveHostname}...</span>
              )
            ) : !isPersonalized ? (
              <span className={styles.matchBadgeNeutral}>Showing original page</span>
            ) : appliedStatus ? (
              appliedStatus.totalCount === 0 ? (
                <span className={styles.matchBadgeNeutral}>
                  No changes yet — use Pick element to choose copy
                </span>
              ) : appliedStatus.matchedCount === appliedStatus.totalCount ? (
                <span className={styles.matchBadgeLive}>
                  <CheckIcon size={13} />
                  <span className={styles.tabular}>
                    {appliedStatus.matchedCount} of {appliedStatus.totalCount}
                  </span>{" "}
                  {appliedStatus.totalCount === 1 ? "change" : "changes"} live on page
                </span>
              ) : (
                <span className={styles.matchBadgeWarn}>
                  <span className={styles.tabular}>
                    {appliedStatus.matchedCount} of {appliedStatus.totalCount}
                  </span>{" "}
                  selectors found on this page — use Pick element
                </span>
              )
            ) : (
              <span className={styles.matchBadgeNeutral}>Connected to {liveHostname}</span>
            )}
          </div>
        ) : null}

        {/* Active Pick-Mode Banner */}
        {showLiveIframe && pickMode ? (
          <div className={styles.pickBanner} role="status">
            <span>
              {pickTargetLabel
                ? `Click any element on the page below to update ${pickTargetLabel} (Esc to cancel)`
                : "Click any headline, paragraph, or button on the page below (Esc to cancel)"}
            </span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnXs}`}
              onClick={() => onPickModeChange(false)}
            >
              Cancel
            </button>
          </div>
        ) : null}

        {holdoutPct > 0 ? (
          <p className={styles.previewNote}>
            <span className={styles.tabular}>{holdoutPct}%</span> of matching visitors see Original
            to measure lift
          </p>
        ) : null}

        {accountOptions.length > 0 ? (
          <div className={styles.previewAccountRow}>
            <label className={styles.previewAccountLabel} htmlFor="preview-account-select">
              Preview as
            </label>
            <select
              id="preview-account-select"
              className={styles.select}
              value={activeAccountKey}
              onChange={(e) => setSelectedAccountKey(e.target.value)}
            >
              {accountOptions.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {/* Browser Frame: Real Live Website Iframe OR Specimen Fallback */}
        <div
          className={`${styles.specimenSheet} ${
            showLiveIframe && pickMode ? styles.specimenSheetPicking : ""
          }`}
        >
          <div className={styles.specimenChrome}>
            <span className={styles.chromeDots} aria-hidden="true">
              <span className={styles.chromeDot} />
              <span className={styles.chromeDot} />
              <span className={styles.chromeDot} />
            </span>

            <span
              className={styles.specimenUrl}
              title={showLiveIframe ? normalizedSiteUrl : displayPath}
            >
              {showLiveIframe ? (liveHostname ?? normalizedSiteUrl) : displayPath}
            </span>

            {canUseLiveIframe ? (
              <div
                className={styles.chromeSurfaceToggle}
                role="radiogroup"
                aria-label="Preview source"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={surfacePreference === "live"}
                  className={`${styles.chromeToggleBtn} ${
                    surfacePreference === "live" ? styles.chromeToggleBtnActive : ""
                  }`}
                  onClick={() => setSurfacePreference("live")}
                >
                  Live
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={surfacePreference === "specimen"}
                  className={`${styles.chromeToggleBtn} ${
                    surfacePreference === "specimen" ? styles.chromeToggleBtnActive : ""
                  }`}
                  onClick={() => {
                    onPickModeChange(false);
                    setSurfacePreference("specimen");
                  }}
                >
                  Specimen
                </button>
              </div>
            ) : null}
          </div>

          {showLiveIframe ? (
            <div className={styles.liveIframeWrap}>
              <iframe
                key={`${normalizedSiteUrl}-${reloadNonce}`}
                ref={iframeRef}
                src={livePreviewSrc}
                sandbox="allow-same-origin allow-scripts"
                title={`Live website preview of ${liveHostname ?? normalizedSiteUrl}`}
                className={styles.liveIframe}
                onError={() => setIframeTimedOut(true)}
              />
            </div>
          ) : (
            <div className={styles.specimenBody} aria-live="polite">
              <h3
                className={`${styles.specimenHeadline} ${
                  isPersonalized && previewModel.headlineChanged ? styles.specimenSwapped : ""
                }`}
              >
                {previewModel.headline}
              </h3>

              <p
                className={`${styles.specimenSubhead} ${
                  isPersonalized && previewModel.subheadChanged ? styles.specimenSwapped : ""
                }`}
              >
                {previewModel.subhead}
              </p>

              <div className={styles.specimenCtaWrap}>
                <span
                  className={`${styles.specimenCta} ${
                    isPersonalized && previewModel.ctaChanged ? styles.specimenCtaPersonalized : ""
                  }`}
                >
                  {previewModel.ctaText}
                </span>
              </div>

              {isPersonalized && previewModel.slotName ? (
                <div className={styles.specimenSlotNote}>{previewModel.slotName}</div>
              ) : null}

              {isPersonalized && previewModel.extraChanges.length > 0 ? (
                <div className={styles.specimenExtraList}>
                  {previewModel.extraChanges.map((text, idx) => (
                    <p key={idx} className={`${styles.specimenSubhead} ${styles.specimenSwapped}`}>
                      {text}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* One-Click Copy Preview Link */}
        <div className={styles.previewShareWrap}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnFull} ${copied ? styles.btnActive : ""}`}
            disabled={sharing || !capabilities.canSignPreview}
            onClick={() => void handleCopyPreviewLink()}
          >
            {copied ? <CheckIcon size={14} /> : <LinkIcon size={14} />}
            {sharing ? "Creating link..." : copied ? "Copied link" : "Copy preview link"}
          </button>

          {!capabilities.canSignPreview ? (
            <span className={styles.hint}>
              Set <code>FACET_PREVIEW_SECRET</code> to share signed preview links.
            </span>
          ) : null}

          {shareError ? (
            <div className={styles.bannerError} style={{ margin: 0 }} role="alert">
              {shareError}
            </div>
          ) : null}

          <details className={styles.linkOptionsDetails}>
            <summary className={styles.linkOptionsSummary}>
              <ChevronDownIcon size={13} className={styles.disclosureChevron} />
              Link options
            </summary>

            <div className={styles.linkOptionsBody}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="share-base-url">
                  Site URL
                </label>
                <input
                  id="share-base-url"
                  type="url"
                  className={`${styles.input} ${styles.monoInput}`}
                  placeholder="https://yoursite.com"
                  value={shareBaseUrl}
                  onChange={(e) => setShareBaseUrl(e.target.value)}
                />
              </div>

              <div className={styles.fieldGrid}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="share-bucket">
                    Version
                  </label>
                  <select
                    id="share-bucket"
                    className={styles.select}
                    value={shareBucket}
                    onChange={(e) => setShareBucket(e.target.value as "variant" | "control")}
                  >
                    <option value="variant">Personalized</option>
                    <option value="control">Original (Control)</option>
                  </select>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="share-ttl">
                    Expires in
                  </label>
                  <select
                    id="share-ttl"
                    className={styles.select}
                    value={shareTtlSeconds}
                    onChange={(e) => setShareTtlSeconds(Number(e.target.value))}
                  >
                    <option value={86_400}>24 hours</option>
                    <option value={604_800}>7 days</option>
                    <option value={2_592_000}>30 days</option>
                  </select>
                </div>
              </div>

              {signedUrl ? (
                <div className={styles.signedUrlRow}>
                  <div className={styles.signedUrlBox}>{signedUrl}</div>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm}`}
                    onClick={() => {
                      if (navigator.clipboard) {
                        void navigator.clipboard.writeText(signedUrl).then(() => {
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 2000);
                        });
                      }
                    }}
                  >
                    <CopyIcon size={14} />
                    Copy URL
                  </button>
                </div>
              ) : null}

              {externalSiteUrl ? (
                <a
                  href={`${externalSiteUrl.replace(/\/$/, "")}${testDefaults?.pathAndQuery ?? "/"}`}
                  target="_blank"
                  rel="noreferrer"
                  className={`${styles.btn} ${styles.btnSm}`}
                  style={{ textDecoration: "none" }}
                >
                  <ExternalLinkIcon size={14} />
                  Open live site
                </a>
              ) : null}
            </div>
          </details>
        </div>
      </div>
    </aside>
  );
}
