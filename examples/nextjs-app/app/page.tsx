import { FacetAnalytics, FacetSlot, readFacetState } from "@facet/next";
import { headers } from "next/headers";
import type { ReactElement } from "react";

/**
 * Hydration-safe Next.js App Router Server Component.
 *
 * Middleware evaluates `facet.yaml` once per request and forwards a sanitized
 * `x-facet-state` header. Reading it on the server ensures both SSR HTML and
 * React hydration match identically — zero flicker and zero hydration warnings.
 */
export default async function HomePage(): Promise<ReactElement> {
  const state = readFacetState(await headers());

  return (
    <main>
      <section>
        <FacetSlot id="hero-eyebrow" as="p" state={state} className="eyebrow">
          Global edge compute platform
        </FacetSlot>

        <FacetSlot id="hero-headline" as="h1" state={state}>
          Fast, reliable cloud infrastructure for modern B2B teams
        </FacetSlot>

        <FacetSlot id="hero-subhead" as="p" state={state} className="subhead">
          Deploy APIs, queues, and edge routing in 300+ cities with predictable pricing.
        </FacetSlot>

        <FacetSlot id="hero-cta" as="a" href="/demo" state={state} className="btn-primary">
          Request a demo
        </FacetSlot>
      </section>

      <FacetSlot id="logo-strip" as="section" htmlId="logo-strip" state={state}>
        <div className="logo-row">
          <span>Acme Corp</span>
          <span>Linear</span>
          <span>Vercel</span>
          <span>Retool</span>
        </div>
      </FacetSlot>

      {/* Emits minimal { experience_id, bucket } exposure events to GA4 / Umami / PostHog */}
      <FacetAnalytics state={state} />
    </main>
  );
}
