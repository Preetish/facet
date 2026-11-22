export type Bucket = "variant" | "control";

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const UINT32_RANGE = 0x100000000;

const textEncoder = new TextEncoder();

export function fnv1a32(input: string): number {
  const bytes = textEncoder.encode(input);
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      hash ^= byte;
      hash = Math.imul(hash, FNV_PRIME_32);
    }
  }
  return hash >>> 0;
}

export function hashToUnitInterval(visitorId: string, experienceId: string): number {
  const hash = fnv1a32(`${visitorId}:${experienceId}`);
  return hash / UINT32_RANGE;
}

export function assignBucket(visitorId: string, experienceId: string, holdout: number): Bucket {
  if (!Number.isFinite(holdout) || holdout <= 0) {
    return "variant";
  }
  if (holdout >= 1) {
    return "control";
  }
  return hashToUnitInterval(visitorId, experienceId) < holdout ? "control" : "variant";
}

export function generateVisitorId(): string {
  return globalThis.crypto.randomUUID();
}
