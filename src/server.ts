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
  /**
   * The organization's API key, for the keyed apps (content, contact form, the
   * keyed half of bookings and reservations).
   *
   * Optional since 1.0.5. A site that reads only keyless apps on its server —
   * Tickets' events, its widgets — has no key to give, and was made to invent
   * one. Without it a keyed endpoint answers `unauthorized`, with the fix.
   */
  apiKey?: string
  /**
   * Which site this is: a bare hostname, `ciao-enkhuizen.nl`.
   *
   * Sent as `X-Cnter-Site`, and never as `Origin`. It was `Origin` once, and
   * that broke every keyed call this package made: `Origin` means "a browser
   * sent this", and the domain check in front of the keyed surface refuses a
   * browser on a domain that is not ours — which is the gate that makes a
   * leaked key useless from page code. A server claiming to be a browser walked
   * straight into it.
   *
   * A hostname, not a URL. It always read that way in this comment, and a site
   * that wrote exactly this into `Origin` was recorded as `unknown`, because
   * `new URL('ciao-enkhuizen.nl')` throws. The new header takes it as it is.
   *
   * Optional, and the answer to "which site runs which version" is only ever as
   * good as this.
   */
  siteOrigin?: string
  /** Reported as `?sv=`. Defaults to the version of this package. */
  scriptVersion?: string
  /** How long a manifest may be reused. Ciao holds 60 seconds by hand. */
  manifestTtlSeconds?: number
  /**
   * Seconds a GET may be served from Next.js's cache (`next: { revalidate }`).
   *
   * Unset, every GET goes out — right for prices, fees and availability. A
   * second client with this set is the way to cache what may be a minute old,
   * like content. Writes are never cached.
   */
  revalidateSeconds?: number
  fetchImpl?: typeof fetch
}

/**
 * Bumped when this package changes, and reported on every manifest call.
 *
 * 1.0.1 sends the verbs the manifest now carries, so a POST is no longer called
 * with a GET. 1.0.2 does two things: it stops sending `Origin` in favour of
 * `X-Cnter-Site`, and it reads the per-endpoint budget, which is what lets a
 * checkout take longer than a read without the site setting anything. 1.0.3
 * merges the two manifest blocks: an
 * app named in both kept only its keyed half, so a server-rendered site lost
 * `restaurant.modifiers`, `ordering.checkout` and `reservations.availability`
 * the moment the manifest started naming all three in both places.
 * 1.0.4 sends the key only to keyed endpoints, answers an endpoint name that is
 * not there with the names that are, keeps `error.details`, and makes
 * `revalidateSeconds` do what it says.
 * 1.0.5 makes `apiKey` optional, and places widgets: `<CnterEmbeds>` from
 * `@cnter/client/next`, and in cnter.js every `data-cnter-embed` on the page.
 * 1.0.6 floats the widget bottom right: `<CnterFloatingWidget>` once in the
 * layout, and cnter.js with nothing on the page; `listEmbeds` works with a
 * client that is already `ready()`.
 * `client_script_installs.script_version` is how you tell which of those a
 * site is running.
 */
export const CLIENT_VERSION = '1.0.6'

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
        revalidateSeconds: this.options.revalidateSeconds,
        // Keyed endpoints only. A keyless route has the organization in its
        // path and asks for no key, so it is sent none.
        keyedHeaders: this.options.apiKey
          ? { 'X-API-Key': this.options.apiKey, 'x-organization-id': this.options.organizationId }
          : undefined,
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
