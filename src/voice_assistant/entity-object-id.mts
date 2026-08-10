/**
 * Client-side reconstruction of an ESPHome entity's `object_id`.
 *
 * WHY THIS EXISTS: `ListEntities*Response.object_id` used to be the way to tell
 * which entity is which (the mic-mute switch, the volume number, the media
 * player). ESPHome stopped sending it:
 *
 *   - <= 2025.12 — object_id always sent.
 *   - 2026.1.0 - 2026.6.x — sent ONLY to clients advertising API < 1.14
 *     (`api_connection.cpp`, gated on `client_supports_api_version(1, 14)`).
 *   - 2026.7.0+ — the backward-compat block was deleted; never sent to anyone.
 *
 * The field is declared `(force) = true`, so it still arrives on the wire — as
 * an EMPTY STRING. Every `if (message.objectId)` therefore goes quietly false
 * on current firmware, which is why the client derives the value itself
 * whenever the device omits it.
 *
 * The rule is ESPHome's own, from `EntityBase::write_object_id_to()`:
 * `to_sanitized_char(to_snake_case_char(c))` applied per BYTE of the entity
 * name (`esphome/core/entity_base.cpp` + `helpers.h`):
 *
 *   snake_case: ' ' -> '_', 'A'-'Z' -> lowercase, everything else unchanged
 *   sanitize:   keep [a-z0-9_-], replace everything else with '_'
 *
 * Per byte, not per character, matters for non-ASCII names: the firmware turns
 * each UTF-8 byte into its own '_' ("温度" -> six underscores). Home Assistant's
 * `aioesphomeapi` iterates Python characters instead and so produces two — we
 * follow the firmware, since the goal is to reproduce the id it would have sent.
 */

// Buffer size in the firmware is OBJECT_ID_MAX_LEN (128) and it writes at most
// buf_size - 1 bytes, so a very long name is truncated at 127 bytes.
const OBJECT_ID_MAX_BYTES = 127;

/** Apply ESPHome's snake_case + sanitize to one byte. */
function sanitizeByte(byte: number): number {
  const SPACE = 0x20, UNDERSCORE = 0x5F, DASH = 0x2D;
  const A = 0x41, Z = 0x5A, a = 0x61, z = 0x7A, ZERO = 0x30, NINE = 0x39;

  if (byte === SPACE) {
    return UNDERSCORE;
  }
  // to_snake_case_char lowercases A-Z, so sanitize only ever sees lowercase.
  const lowered = byte >= A && byte <= Z ? byte + (a - A) : byte;
  if (lowered === DASH || lowered === UNDERSCORE
    || (lowered >= ZERO && lowered <= NINE)
    || (lowered >= a && lowered <= z)) {
    return lowered;
  }
  return UNDERSCORE;
}

/**
 * The object_id ESPHome would compute for an entity called `name`.
 * An empty/missing name yields '' — the firmware would fall back to the device
 * (or sub-device) name there, which no lookup in this client keys on, so there
 * is deliberately no device-name fallback here (see computeObjectId callers).
 */
export function computeObjectId(name: string | undefined | null): string {
  if (!name) {
    return '';
  }
  const bytes = Buffer.from(String(name), 'utf8').subarray(0, OBJECT_ID_MAX_BYTES);
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = sanitizeByte(bytes[i]!);
  }
  return out.toString('latin1');
}

/**
 * The object_id for one ListEntities*Response: what the device sent, or the
 * value derived from the entity name when the device omitted it.
 */
export function resolveEntityObjectId(message: { objectId?: string; name?: string }): string {
  return message?.objectId || computeObjectId(message?.name);
}
