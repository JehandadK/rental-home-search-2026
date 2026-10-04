import { canonicalJson } from "../domain/canonicalJson";
export { canonicalJson } from "../domain/canonicalJson";

export async function contentFingerprint(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
