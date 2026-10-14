/**
 * The UR rooms page's data (public/data/ur-rooms.json), fetched only when the
 * page is opened so the dashboard never waits for it. Revalidated on every
 * load, like the other published files.
 */
import type { UrRoomsPayload } from "../../domain/urRooms";

export const UR_ROOMS_ASSET = "ur-rooms.json";

export function parseUrRoomsPayload(value: unknown): UrRoomsPayload {
  const payload = value as UrRoomsPayload | null;
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.rooms) || !Array.isArray(payload.estates)) {
    throw new Error(`${UR_ROOMS_ASSET} is not a UR rooms payload`);
  }
  return payload;
}

export async function fetchUrRooms(baseUrl: string, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<UrRoomsPayload> {
  const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${UR_ROOMS_ASSET}`, { cache: "no-cache", signal: options.signal });
  if (!response.ok) throw new Error(`${UR_ROOMS_ASSET}: HTTP ${response.status}`);
  return parseUrRoomsPayload(await response.json());
}
