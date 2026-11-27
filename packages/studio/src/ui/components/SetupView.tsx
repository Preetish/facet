import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { StudioCapabilities } from "../../shared/types.js";
import { formatSiteHostname, normalizeSiteUrl } from "../helpers/live-preview.js";
import styles from "../Studio.module.css";
import { CheckIcon, ChevronDownIcon, CopyIcon, ExternalLinkIcon, GlobeIcon } from "./Icons.js";

export interface SetupViewProps {
  siteUrl: string;
  capabilities: StudioCapabilities;
  onLoadLiveSite: (url: string) => void;
  onClearSiteUrl: () => void;
}

type HandoffTab = "worker" | "nextjs";

function buildWorkerSnippet(originUrl: string): string {
  const origin = originUrl || "https://yoursite.com";
  return `// src/index.ts — Cloudflare Worker in front of your site
import { createFacetWorker } from "@facet/worker";
import configYaml from "./facet.yaml?raw";

export default createFacetWorker({
  origin: "${origin}",
  config: configYaml,
});`;
}

function buildNextSnippet(): string {
  return `// middleware.ts — Hydration-safe Next.js App Router
import { createFacetMiddleware } from "@facet/next";
import configYaml from "./facet.yaml?raw";

export const middleware = createFacetMiddleware({ config: configYaml });

// app/page.tsx — Zero-flicker Server Component slot
import { FacetSlot } from "@facet/next";

export default function HomePage() {
  return <FacetSlot id="hero-headline">Your default headline</FacetSlot>;
}`;
}

export function SetupView({
  siteUrl,
  capabilities,
  onLoadLiveSite,
  onClearSiteUrl,
}: SetupViewProps): ReactElement {
  const [urlInput, setUrlInput] = useState(siteUrl || capabilities.targetUrl || "");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [handoffTab, setHandoffTab] = useState<HandoffTab>("worker");
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  useEffect(() => {
    setUrlInput(siteUrl || capabilities.targetUrl || "");
  }, [siteUrl, capabilities.targetUrl]);

  const activeHostname = formatSiteHostname(siteUrl);
  const snippetOrigin = normalizeSiteUrl(siteUrl || capabilities.targetUrl || "") ?? "";
  const snippetText =
    handoffTab === "worker" ? buildWorkerSnippet(snippetOrigin) : buildNextSnippet();

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeSiteUrl(urlInput);
    if (!normalized) {
      setUrlError(
        "Enter a valid http:// or https:// website URL (for example, https://facet.preetish.me).",
      );
      return;
    }
    setUrlError(null);
    onLoadLiveSite(normalized);
  }

  async function handleCopySnippet(): Promise<void> {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
    await navigator.clipboard.writeText(snippetText);
    setCopiedSnippet(true);
    window.setTimeout(() => setCopiedSnippet(false), 2000);
  }

  const publishExplanation = capabilities.isDemoMode
    ? "Clicking Publish saves a validated snapshot in this session's memory so you can test publishing and rollback safely without affecting any live site."
    : `Clicking Publish validates your campaigns, records a rollback snapshot, and writes the active configuration directly to ${capabilities.storageLabel}.`;

  return (
    <div className={styles.setupPane}>
      <div className={styles.setupContainer}>
        <header className={styles.setupHeader}>
          <h1 className={styles.pageHeading}>Site &amp; Setup</h1>
          <p className={styles.pageDescription}>
            Connect your live website to preview personalized copy in place, pick page elements with
            one click, and see where published changes are saved.
          </p>
        </header>

        {capabilities.isDemoMode ? (
          <div className={styles.setupNoticeOchre} role="status">
            <strong>Demo mode</strong> — You&apos;re exploring sample demo campaigns in memory.
            Enter any real website URL below to preview live changes on your own page.
          </div>
        ) : null}

        {/* Connected Website Card */}
        <section className={styles.setupCard} aria-labelledby="setup-website-heading">
          <div className={styles.setupCardHeader}>
            <div className={styles.setupCardTitleRow}>
              <h2 id="setup-website-heading" className={styles.sectionTitle}>
                Connected website
              </h2>
              {activeHostname ? (
                <span className={`${styles.statusPill} ${styles.statusPillLive}`}>
                  <span className={styles.statusDot} aria-hidden="true" />
                  {activeHostname}
                </span>
              ) : (
                <span className={styles.statusPill}>Not connected</span>
              )}
            </div>
            <p className={styles.sectionHelp}>
              Studio loads this page in the live preview pane so you can click headlines,
              subheadlines, or buttons to personalize them immediately.
            </p>
          </div>

          <form className={styles.setupUrlForm} onSubmit={handleSubmit} noValidate>
            <div className={styles.setupUrlField}>
              <label htmlFor="setup-site-url" className="sr-only">
                Live website URL
              </label>
              <input
                id="setup-site-url"
                type="url"
                className={`${styles.input} ${styles.monoInput}`}
                placeholder="https://facet.preetish.me"
                value={urlInput}
                onChange={(e) => {
                  setUrlInput(e.target.value);
                  if (urlError) setUrlError(null);
                }}
              />
            </div>

            <button
              type="submit"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!capabilities.canLivePreview}
            >
              <GlobeIcon size={15} />
              Load live site
            </button>
          </form>

          {urlError ? (
            <p className={styles.setupInlineError} role="alert">
              {urlError}
            </p>
          ) : null}

          {!capabilities.canLivePreview ? (
            <p className={styles.hint}>
              Live site proxying is disabled on this Studio server. You can still edit campaigns and
              inspect copy using the Specimen preview.
            </p>
          ) : siteUrl ? (
            <div className={styles.setupUrlMeta}>
              <a href={siteUrl} target="_blank" rel="noreferrer" className={styles.setupInlineLink}>
                Open {activeHostname ?? siteUrl} in new tab
                <ExternalLinkIcon size={13} />
              </a>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnXs} ${styles.btnGhost}`}
                onClick={() => {
                  setUrlInput("");
                  setUrlError(null);
                  onClearSiteUrl();
                }}
              >
                Use specimen preview instead
              </button>
            </div>
          ) : null}
        </section>

        {/* Where Publish Saves Card */}
        <section className={styles.setupCard} aria-labelledby="setup-storage-heading">
          <div className={styles.setupCardTitleRow}>
            <h2 id="setup-storage-heading" className={styles.sectionTitle}>
              Where Publish saves
            </h2>
            <span
              className={`${styles.statusPill} ${
                capabilities.isDemoMode ? styles.statusPillDraft : styles.statusPillLive
              }`}
            >
              {capabilities.storageLabel}
            </span>
          </div>
          <p className={styles.setupBodyText}>{publishExplanation}</p>
        </section>

        {/* How Facet Works (3 crisp hairline-divided steps inside one sheet) */}
        <section className={styles.setupCard} aria-labelledby="setup-how-heading">
          <h2 id="setup-how-heading" className={styles.sectionTitle}>
            How Facet works
          </h2>
          <ol className={styles.setupStepsGrid}>
            <li className={styles.setupStep}>
              <span className={`${styles.setupStepNum} ${styles.tabular}`}>1</span>
              <strong className={styles.setupStepTitle}>
                Put Facet in front of your site once
              </strong>
              <p className={styles.setupStepDesc}>
                Place a lightweight Cloudflare Worker or Next.js middleware in front of your
                existing marketing site — no CMS migration required.
              </p>
            </li>
            <li className={styles.setupStep}>
              <span className={`${styles.setupStepNum} ${styles.tabular}`}>2</span>
              <strong className={styles.setupStepTitle}>
                Pick any element &amp; write your tailored copy here
              </strong>
              <p className={styles.setupStepDesc}>
                Click any headline, paragraph, or CTA on your live page and match rules by ad
                campaign, account link, or visitor segment.
              </p>
            </li>
            <li className={styles.setupStep}>
              <span className={`${styles.setupStepNum} ${styles.tabular}`}>3</span>
              <strong className={styles.setupStepTitle}>
                Publish live — zero code deploys, zero flicker
              </strong>
              <p className={styles.setupStepDesc}>
                Facet rewrites HTML before first paint with built-in holdout groups so you can
                measure real lift in your analytics tool.
              </p>
            </li>
          </ol>
        </section>

        {/* Collapsible Engineer Handoff */}
        <details className={styles.setupHandoff}>
          <summary className={styles.setupHandoffSummary}>
            <ChevronDownIcon size={14} className={styles.disclosureChevron} />
            <span>Engineer handoff — deploy Facet in front of your site</span>
          </summary>

          <div className={styles.setupHandoffBody}>
            <div className={styles.setupHandoffBar}>
              <div
                className={styles.segmentedControl}
                role="tablist"
                aria-label="Deployment target"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={handoffTab === "worker"}
                  className={`${styles.segOption} ${
                    handoffTab === "worker" ? styles.segOptionActive : ""
                  }`}
                  onClick={() => {
                    setHandoffTab("worker");
                    setCopiedSnippet(false);
                  }}
                >
                  Cloudflare Worker
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={handoffTab === "nextjs"}
                  className={`${styles.segOption} ${
                    handoffTab === "nextjs" ? styles.segOptionActive : ""
                  }`}
                  onClick={() => {
                    setHandoffTab("nextjs");
                    setCopiedSnippet(false);
                  }}
                >
                  Next.js
                </button>
              </div>

              <button
                type="button"
                className={`${styles.btn} ${styles.btnSm} ${copiedSnippet ? styles.btnActive : ""}`}
                onClick={() => void handleCopySnippet()}
              >
                {copiedSnippet ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                {copiedSnippet ? "Copied" : "Copy snippet"}
              </button>
            </div>

            <pre className={styles.setupCodeBlock}>
              <code>{snippetText}</code>
            </pre>
          </div>
        </details>
      </div>
    </div>
  );
}
