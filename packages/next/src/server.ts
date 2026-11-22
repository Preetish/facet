import {
  FACET_STATE_HEADER,
  createEmptyFacetState,
  deserializeFacetState,
  type FacetRequestState,
} from "./state.js";

export interface HeadersLike {
  get(name: string): string | null;
}

export function readFacetState(headersLike: HeadersLike | null | undefined): FacetRequestState {
  if (!headersLike) {
    return createEmptyFacetState();
  }
  try {
    const raw = headersLike.get(FACET_STATE_HEADER);
    return deserializeFacetState(raw);
  } catch {
    return createEmptyFacetState();
  }
}
