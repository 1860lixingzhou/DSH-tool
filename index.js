/**
 * dsh-safety-guard — Cordis plugin entry.
 *
 * A Harness profile bundle that, under `danger-full-access` (fully-permissive)
 * sessions:
 *  1. appends a `[DSH-GENERATED]` footer marker to files DSH writes;
 *  2. records every DSH-authored file in an origin registry and exposes
 *     `dsh_file_origin` so the agent (or a person) can tell DSH files from
 *     user-downloaded ones;
 *  3. backs up an existing file to `D:\DSH备份` before the agent modifies or
 *     (via a destructive shell command) deletes it.
 *
 * Intentionally dependency-free: it imports only Node built-ins and its own
 * `lib/` modules. A profile bundle installed as a `link:`/junction resolves
 * to its source directory, where `@deepseek-ai/*` packages are not on the
 * module path, so importing `schemastery` here would fail at load. Config is
 * normalized defensively in `lib/core.js` instead.
 *
 * Install into the active profile with the desktop CLI:
 *   dsh plugin --profile desktop add <absolute package dir>
 * then restart DeepSeek Harness so the Host bundle loads.
 */
import { createGuard } from './lib/wiring.js'
import { defaultConfig } from './lib/core.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-safety-guard'

/** Requires the tool registry; without it there is nothing to guard. */
export const inject = ['tools']

/** Defaults for the profile row's `config`. */
export const defaults = defaultConfig()

/**
 * @param ctx - Cordis context with the `tools` service.
 * @param config - the row's raw config object.
 * @returns the plugin disposer.
 */
export function apply(ctx, config) {
  const guard = createGuard(ctx, config)
  return guard.install()
}
