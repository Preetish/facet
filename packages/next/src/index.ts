export {
  FACET_STATE_HEADER,
  MAX_FACET_STATE_HEADER_BYTES,
  createEmptyFacetState,
  createFacetStateFromEvaluation,
  deserializeFacetState,
  resolveSlotChange,
  serializeFacetState,
} from "./state.js";
export type { FacetMatchedSummary, FacetRequestState } from "./state.js";

export { createFacetMiddleware } from "./middleware.js";
export type {
  FacetConfigSource,
  FacetCookieOptions,
  FacetEnrichCallback,
  FacetMiddlewareOptions,
  FacetNextMiddleware,
} from "./middleware.js";

export { readFacetState } from "./server.js";
export type { HeadersLike } from "./server.js";

export { FacetSlot } from "./FacetSlot.js";
export type { FacetSlotElement, FacetSlotProps } from "./FacetSlot.js";

export { FacetAnalytics } from "./FacetAnalytics.js";
export type { FacetAnalyticsProps } from "./FacetAnalytics.js";
