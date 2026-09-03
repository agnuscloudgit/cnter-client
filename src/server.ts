/**
 * The CNTER client for code that runs on a server.
 *
 * This is the entry the first real customer needs. Ciao Enkhuizen renders
 * entirely on the server — seventeen `server-only` files and not one client
 * component — so the hosted browser script would have had nothing to do there.
 *
 * It offers everything the keyless entry offers, plus the apps that need a key:
 * content, contact form. The key never leaves this side.
 *
 * ── Why this cannot reach a browser ──────────────────────────────────────────
 *
 * The packaged version of this file carries `import 'server-only'`, which makes
 * a bundler refuse it outright. That package is not a dependency of this
 * repository, so the guard here is the one `src/lib/supabase/server.ts` already
 * uses: throw at module load if there is a `window`. Both say the same thing —
 * a key in page code is a published key — and the second one at least says it
 * out loud at runtime rather than at build time.
 *
 * `browser-has-no-keys.test.ts` is the check that matters either way: it
 * bundles the browser entry and fails if this module is among its inputs.
 */

import 'server-only'

import { buildClient, missingCapability, type BoundCapability, type CnterClient } from './core/client'
import { CnterError } from './core/errors'
import { fetchManifest, type Manifest } from './core/manifest'

export { CnterError } from './core/errors'
export type { CnterFailureReason } from './core/errors'

export type CnterServerOptions = {
  baseUrl: string
  organizationId: string
  apiKey: string
  /**
   * Which site this is, e.g. `ciao-enkhuizen.nl`.
   *
   * Sent as `Origin`, because a server render sends none and the install table
   * therefore cannot tell one server-rendered site from another. Both rows in
   * it today say `unknown` for exactly that reason. Optional, and the answer to
   * "which site runs which version" is only as good as this.
   */
  siteOrigin?: string
  /** Reported as `?sv=`. Defaults to the version of this package. */
  scriptVersion?: string
  /** How long a manifest may be reused. Ciao holds 60 seconds by hand. */
  manifestTtlSeconds?: number
  fetchImpl?: typeof fetch
}

/** Bumped when this package changes, and reported on every manifest call. */
export const CLIENT_VERSION = '1.0.0'

type Cached = { manifest: Manifest; at: number }

/**
 * One manifest per organization per process, held for a minute.
 *
 * The same sixty seconds Ciao's hand-written client uses for content. It is
 * short enough that a moved endpoint reaches a running site within a minute,
 * and long enough that a busy page does not fetch the manifest once per render.
 */
const cache = new Map<string, Cached>()

export function createCnterClient(options: CnterServerOptions): CnterServerClient {
  return new CnterServerClient(options)
}

export class CnterServerClient {
  private readonly options: CnterServerOptions
  private inFlight: Promise<Manifest> | null = null

  constructor(options: CnterServerOptions) {
    this.options = options
  }

  /**
   * The manifest, from cache when it is fresh.
   *
   * Concurrent callers share one request: a page that renders six components
   * would otherwise ask six times on a cold cache, and they would all be the
   * same answer.
   */
  private async manifest(): Promise<Manifest> {
    const ttl = (this.options.manifestTtlSeconds ?? 60) * 1000
    const key = `${this.options.baseUrl}|${this.options.organizationId}`
    const hit = cache.get(key)

    if (hit && Date.now() - hit.at < ttl) return hit.manifest
    if (this.inFlight) return this.inFlight

    this.inFlight = fetchManifest({
      baseUrl: this.options.baseUrl,
      organizationId: this.options.organizationId,
      scriptVersion: this.options.scriptVersion ?? CLIENT_VERSION,
      siteOrigin: this.options.siteOrigin,
      fetchImpl: this.options.fetchImpl,
    })
      .then((manifest) => {
        cache.set(key, { manifest, at: Date.now() })
        return manifest
      })
      .finally(() => {
        this.inFlight = null
      })

    return this.inFlight
  }

  /** Everything this organization has, keyed and keyless alike. */
  async ready(): Promise<CnterClient> {
    const manifest = await this.manifest()

    const client = buildClient(
      {
        baseUrl: this.options.baseUrl,
        manifest,
        organizationId: this.options.organizationId,
        siteOrigin: this.options.siteOrigin,
        fetchImpl: this.options.fetchImpl,
        headers: {
          'X-API-Key': this.options.apiKey,
          'x-organization-id': this.options.organizationId,
        },
      },
      true,
    )

    // `buildClient` already answers a name that is not there with what is,
    // rather than with `undefined` and a TypeError in the customer's code.
    return client
  }

  /** One capability, or a typed error naming what this organization does have. */
  async capability(name: string): Promise<BoundCapability> {
    const manifest = await this.manifest()
    const client = await this.ready()
    const bound = (client as Record<string, unknown>)[name]

    if (!bound || typeof bound !== 'object') throw missingCapability(name, manifest, true)
    return bound as BoundCapability
  }
}

export type { CnterClient, BoundCapability } from './core/client'
export type { Manifest } from './core/manifest'
export { CnterError as CnterClientError }
