/**
 * The one path this script knows, and everything it learns from it.
 *
 * A customer site used to carry its own copy of every path it called, frozen at
 * the moment the code was generated. When opening hours moved off the
 * reservation endpoint in August, that copy kept reading the old one and a live
 * site broke. This is the inversion: one address is written down, the rest is
 * read at runtime, and a move is absorbed before anybody notices.
 *
 * So the rule is absolute and worth stating plainly: **`MANIFEST_PATH` is the
 * only path in this package.** `no-hardcoded-paths.test.ts` fails if a second
 * one appears.
 */

import { CnterError, reasonForStatus } from './errors'

/** The one hardcoded path. Everything else comes out of what it returns. */
export const MANIFEST_PATH = '/api/client/v1/{organizationId}/manifest'

/** The contract this client speaks. A retired one answers 410 and says so. */
export const CONTRACT = 1

export type ManifestEndpoints = Record<string, string>

export type Manifest = {
  ok: true
  contract: number
  organization: { id: string; name: string; timezone: string | null }
  capabilities: Record<
    string,
    {
      endpoints: ManifestEndpoints
      /**
       * Verbs that are not GET, keyed like `endpoints`. Absent means all reads.
       *
       * Optional because an older deployment does not send it, and a script
       * that demanded it would refuse a manifest it can otherwise use
       * perfectly. A missing map means every endpoint here is a GET, which is
       * what it meant before the field existed.
       */
      methods?: Record<string, 'POST'>
      /**
       * How long this client may wait, keyed like `endpoints`. Absent means the
       * default, which is what nearly everything wants.
       *
       * Optional twice over. An older deployment does not send the field, and a
       * client that demanded it would refuse a manifest it can use perfectly.
       * And an endpoint without an entry is not missing anything — eight
       * seconds is the right answer for a read that takes under two.
       */
      timeouts?: Record<string, number>
    }
  >
  server: Record<
    string,
    {
      auth: { scheme: string; header: string; scopes: string[] }
      browserSafe: false
      endpoints: ManifestEndpoints
      /** Verbs that are not GET, keyed like `endpoints`. Absent means all reads. */
      methods?: Record<string, 'POST'>
      /** How long this client may wait, keyed like `endpoints`. See capabilities. */
      timeouts?: Record<string, number>
      docs: string
    }
  >
  deprecations: string[]
  sunset: string | null
}

export type ManifestRequest = {
  baseUrl: string
  organizationId: string
  /** Reported as `?sv=`, so the dashboard can see which site runs which build. */
  scriptVersion: string
  /**
   * Which site is asking, for a server-side render.
   *
   * A browser sends `Origin` on its own. A server render sends neither Origin
   * nor Referer, which is why both existing install rows say `unknown` — and
   * why a site that renders on the server could not be told apart from any
   * other. Sending it explicitly is the only way that column ever fills in for
   * the customers who render on a server, which is most of them.
   */
  siteOrigin?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function manifestUrl(baseUrl: string, organizationId: string, scriptVersion: string): string {
  const path = MANIFEST_PATH.replace('{organizationId}', encodeURIComponent(organizationId))
  return `${baseUrl.replace(/\/$/, '')}${path}?sv=${encodeURIComponent(scriptVersion)}`
}

/**
 * Fetch the manifest once. Throws a typed error; the callers decide what a
 * failure means for them, and for the browser entry it means "carry on quietly".
 */
export async function fetchManifest(request: ManifestRequest): Promise<Manifest> {
  const url = manifestUrl(request.baseUrl, request.organizationId, request.scriptVersion)
  const doFetch = request.fetchImpl ?? fetch

  const headers: Record<string, string> = { Accept: 'application/json' }
  // See `request` in core/client.ts: never `Origin` from a server.
  if (request.siteOrigin) headers['X-Cnter-Site'] = request.siteOrigin

  let response: Response
  try {
    response = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(request.timeoutMs ?? 8_000),
    })
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
    throw new CnterError(
      timedOut ? 'timeout' : 'unavailable',
      timedOut ? 'CNTER did not answer in time' : 'CNTER could not be reached',
      { fix: 'Nothing to change on your side. The client keeps retrying in the background.' },
    )
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; latest?: number }
    } | null

    if (response.status === 410) {
      const latest = body?.error?.latest
      throw new CnterError('contract_gone', `Client contract v${CONTRACT} is no longer served`, {
        status: 410,
        code: body?.error?.code,
        apiMessage: body?.error?.message,
        fix: latest
          ? `Update this client: the current contract is v${latest}.`
          : 'Update this client to the current contract version.',
      })
    }

    const reason = reasonForStatus(response.status)
    throw new CnterError(reason, `The manifest answered ${response.status}`, {
      status: response.status,
      code: body?.error?.code,
      apiMessage: body?.error?.message,
      fix:
        reason === 'not_found'
          ? 'Check the organization id. It is the one in your CNTER dashboard, and it belongs in the URL.'
          : undefined,
    })
  }

  const manifest = (await response.json()) as Manifest
  if (!manifest || manifest.ok !== true || typeof manifest.capabilities !== 'object') {
    throw new CnterError('unavailable', 'The manifest came back in a shape this client cannot read')
  }

  return manifest
}
