/**
 * Turning a manifest into functions.
 *
 * `capabilities.restaurant.endpoints.settings` becomes `cnter.restaurant
 * .settings()`. Nothing is named here that the manifest does not name, which is
 * the property the whole project rests on: an organization without Reservations
 * has no `cnter.reservations`, and an endpoint that moves moves by itself.
 *
 * Two rules for arguments, and they are the only convention in this file:
 *
 *   - a value whose name matches a `{placeholder}` in the path fills it;
 *   - everything else becomes a query parameter, or a JSON body on a POST.
 *
 * `/api/content/items/{id}` called with `{ id: 'abc', include: 'fields' }` is
 * therefore `/api/content/items/abc?include=fields`. Both halves are visible in
 * the manifest, so a builder can read what will happen rather than learn it.
 */

import { CnterError, reasonForStatus, worthRetrying } from './errors'
import type { Manifest, ManifestEndpoints } from './manifest'

const REQUEST_TIMEOUT_MS = 8_000

/**
 * Bounded, and never on a write.
 *
 * A POST whose answer was lost may still have been carried out — retrying it
 * books a second appointment or sends a second message. Ciao's hand-written
 * client made that call and it is the right one.
 */
const MAX_GET_ATTEMPTS = 3
const BACKOFF_MS = [400, 1_200]

export type CallParams = Record<string, string | number | boolean | null | undefined>

export type Callable = (params?: CallParams, body?: unknown) => Promise<unknown>

export type BoundCapability = Record<string, Callable>

export type ClientOptions = {
  baseUrl: string
  manifest: Manifest
  /**
   * Headers the entry point adds to every call.
   *
   * The key lives here rather than as an `apiKey` option so that this core
   * carries no idea of a key at all. That is not tidiness: the browser build
   * bundles this file, and a bundle that contains the code for sending a key is
   * one edit away from sending one. `browser-has-no-keys.test.ts` greps the
   * built output for `X-API-Key` and fails if it appears.
   */
  headers?: Record<string, string>
  organizationId: string
  siteOrigin?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Seconds a GET may be reused. Ciao holds 60 by hand; this is the same. */
  revalidateSeconds?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Fill `{placeholders}` from params, and return what is left over for the query. */
function fillPath(template: string, params: CallParams): { path: string; rest: CallParams } {
  const rest: CallParams = { ...params }
  const path = template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = rest[name]
    if (value === undefined || value === null) {
      throw new CnterError('invalid_request', `This endpoint needs a ${name}`, {
        fix: `Pass it as \`{ ${name}: … }\`. The path is ${template}, and ${name} is part of it.`,
      })
    }
    delete rest[name]
    return encodeURIComponent(String(value))
  })
  return { path, rest }
}

/**
 * One call, with a timeout and — only for GET — a bounded retry.
 *
 * Failures carry the fix text where there is one, because the moment an
 * integration throws is the moment that sentence is worth most.
 */
async function request(
  url: URL,
  method: 'GET' | 'POST',
  body: unknown,
  options: ClientOptions,
): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
  if (options.siteOrigin) headers['Origin'] = options.siteOrigin
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const attempts = method === 'GET' ? MAX_GET_ATTEMPTS : 1
  let last: CnterError = new CnterError('unavailable', 'CNTER could not be reached')

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 1_200)

    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      })
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
      last = new CnterError(
        timedOut ? 'timeout' : 'unavailable',
        timedOut ? 'CNTER did not answer in time' : 'CNTER could not be reached',
      )
      continue
    }

    if (response.ok) return response.json()

    const payload = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null

    const reason = reasonForStatus(response.status)
    last = new CnterError(reason, `CNTER answered ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      apiMessage: payload?.error?.message,
      fix: fixFor(reason),
    })

    if (!worthRetrying(response.status)) throw last
  }

  throw last
}

/**
 * The one line a builder needs, per failure.
 *
 * Deliberately short here rather than importing the playground's catalogue:
 * that module knows about app definitions and the route registry, and this one
 * ships to a browser. The wording is the same wording, and
 * `failures.alignment.test.ts` holds the two together so they cannot drift.
 */
function fixFor(reason: ReturnType<typeof reasonForStatus>): string | undefined {
  switch (reason) {
    case 'unauthorized':
      return 'The API key is missing or not recognised. It belongs on your server, in the X-API-Key header.'
    case 'forbidden':
      return 'The key is valid but lacks the scope this endpoint needs. Ask your client to add it under Settings → Organization → API Keys.'
    case 'rate_limited':
      return 'Cache the answer rather than fetching per page render. What these endpoints return changes when the merchant edits something.'
    case 'not_found':
      return 'Check the id against a list call first. A key never receives unpublished records.'
    default:
      return undefined
  }
}

/** Bind one block of endpoints to callable functions. */
function bind(
  endpoints: ManifestEndpoints,
  methods: Record<string, 'POST'> | undefined,
  options: ClientOptions,
): BoundCapability {
  const bound: BoundCapability = {}

  for (const [name, template] of Object.entries(endpoints)) {
    const method = methods?.[name] ?? 'GET'

    bound[name] = async (params = {}, body?: unknown) => {
      const { path, rest } = fillPath(template, params)
      const url = new URL(`${options.baseUrl.replace(/\/$/, '')}${path}`)

      if (method === 'GET') {
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
        }
        return request(url, 'GET', undefined, options)
      }

      // On a write the leftovers are the body, unless one was passed outright.
      return request(url, 'POST', body ?? rest, options)
    }
  }

  return bound
}

/**
 * Only capabilities. Nothing else lives on this object.
 *
 * It carried the organization's name and timezone for a moment, which was wrong
 * in a way only a real call could show: `organization` is itself a capability —
 * `/api/client/v1/{org}/organization` is the endpoint a site reads a business's
 * public details from — so the convenience field overwrote the function and
 * `client.organization.get()` stopped being callable for every organization
 * that has it. Anything added here can collide with a capability name, so
 * nothing is added here.
 */
export type CnterClient = Record<string, BoundCapability>

/**
 * Everything this organization has, as functions.
 *
 * `includeServer` is the difference between the two entry points and it is a
 * parameter rather than two code paths so that there is one place to be right.
 * The browser entry passes false and can therefore not reach a keyed endpoint
 * even by accident; `browser-has-no-keys.test.ts` holds that.
 */
export function buildClient(options: ClientOptions, includeServer: boolean): CnterClient {
  const client: Record<string, BoundCapability> = {}

  for (const [capability, entry] of Object.entries(options.manifest.capabilities)) {
    client[capability] = bind(entry.endpoints, undefined, options)
  }

  if (includeServer) {
    for (const [app, entry] of Object.entries(options.manifest.server)) {
      client[app] = bind(entry.endpoints, entry.methods, options)
    }
  }

  /**
   * The guard belongs here, not in the entry points.
   *
   * It was in both of them, which meant it was in neither for anyone holding a
   * client from `buildClient` — and the promise this makes ("ask for something
   * that is not there and you are told, not ignored") was kept only by the two
   * callers who remembered. Silence is the failure mode: without this a site
   * gets "cannot read properties of undefined", in its own stack, about its own
   * code, three lines after the real problem.
   */
  return new Proxy(client, {
    get(target, property) {
      if (typeof property !== 'string') return undefined
      if (property in target) return target[property]
      // Anything a runtime pokes at — `then`, `toJSON`, inspection symbols —
      // must answer undefined rather than throw, or awaiting a client would
      // look like a missing capability.
      if (property.startsWith('__') || property === 'then' || property === 'toJSON') return undefined
      throw missingCapability(property, options.manifest, includeServer)
    },
  }) as CnterClient
}

/**
 * What a name that is not there should say.
 *
 * Silence is the failure mode this replaces: a site asking for a capability the
 * organization does not have used to get `undefined` and a TypeError three
 * lines later, in the customer's code, about a property of undefined.
 */
export function missingCapability(
  name: string,
  manifest: Manifest,
  includeServer: boolean,
): CnterError {
  const available = Object.keys(manifest.capabilities)
  const keyed = Object.keys(manifest.server)

  if (!includeServer && keyed.includes(name)) {
    return new CnterError('server_only', `“${name}” needs an API key, so it cannot run in a browser`, {
      fix:
        `Call it from your server with the server entry point: ` +
        `createCnterClient({ apiKey }). A key in page code is a published key, and a browser ` +
        `cannot send one to CNTER anyway — the request is refused before it arrives.`,
    })
  }

  return new CnterError('capability_absent', `“${name}” is not switched on for this organization`, {
    fix:
      available.length > 0
        ? `This organization has: ${available.join(', ')}${keyed.length && includeServer ? `, ${keyed.join(', ')}` : ''}. ` +
          'If you expected more, the merchant enables apps under Settings → Organization → Modules.'
        : 'This organization has no apps switched on yet.',
  })
}
