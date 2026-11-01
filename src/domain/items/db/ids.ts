/**
 * Identifiers for new items and mutations: RFC 4122 version 4 UUIDs.
 *
 * Items saved before SQLite keep the ids they were given
 * (`Date.now().toString(36) + random`) — an id is identity, and the photo, any
 * open screen and the legacy snapshot all refer to it. New items get UUIDs,
 * the shape the backend's `uuid` columns take, so the first sync does not have
 * to remap anything created from here on.
 *
 * Uses `crypto.getRandomValues` where the runtime has it and `Math.random`
 * where it does not (Hermes ships no Web Crypto without a polyfill). These ids
 * need to be unique, not secret: they are never a credential.
 */
export function newId(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
