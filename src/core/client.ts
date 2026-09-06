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
  /** This endpoint's budget, already resolved by `bind`. */
  timeoutMs: number,
): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
  // Never `Origin`. That header means "a browser sent this", and a server
  // saying it is a lie the domain check in the proxy believes — it refused
  // every keyed call this package made until the site stopped declaring itself
  // at all. `X-Cnter-Site` is our own, decides nothing, and labels a row.
  if (options.siteOrigin) headers['X-Cnter-Site'] = options.siteOrigin
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
        signal: AbortSignal.timeout(timeoutMs),
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

/** One block of the manifest: the paths, and what the client should know about them. */
type ManifestBlock = {
  endpoints: ManifestEndpoints
  methods?: Record<string, 'POST'>
  timeouts?: Record<string, number>
}

/**
 * Bind one block of endpoints to callable functions.
 *
 * Takes the block whole rather than its fields one by one. It carried two maps
 * and now carries three, and a fourth positional argument of the same shape as
 * the second and third is how the wrong one gets passed.
 */
function bind(block: ManifestBlock, options: ClientOptions): BoundCapability {
  const bound: BoundCapability = {}

  for (const [name, template] of Object.entries(block.endpoints)) {
    const method = block.methods?.[name] ?? 'GET'

    /**
     * What this endpoint may take, said by the manifest.
     *
     * Absent means the default, which is right for everything that answers in
     * under two seconds — which is everything except a call that waits on
     * somebody else. Checkout opens a Stripe session, and the first site to
     * build one met a tail this client cut off at eight seconds, in front of a
     * customer who was paying.
     *
     * The site sets nothing. That is the point: it arrives with the manifest,
     * and the number changes for everyone at once when it needs to.
     */
    const timeoutMs = block.timeouts?.[name] ?? options.timeoutMs ?? REQUEST_TIMEOUT_MS

    bound[name] = async (params = {}, body?: unknown) => {
      const { path, rest } = fillPath(template, params)
      const url = new URL(`${options.baseUrl.replace(/\/$/, '')}${path}`)

      if (method === 'GET') {
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
        }
        return request(url, 'GET', undefined, options, timeoutMs)
      }

      // On a write the leftovers are the body, unless one was passed outright.
      return request(url, 'POST', body ?? rest, options, timeoutMs)
    }
  }

  return bound
}

/**
 * One name's endpoints, from both blocks at once.
 *
 * The keyless half wins a clash, and `manifest.test.ts` forbids the clash
 * outright — so this order only decides what happens if that guard is ever
 * removed. Keyless is the safer of the two to keep: it is a contract route,
 * whose shape is promised for the life of the version, where a keyed one is
 * legacy and promises nothing.
 */
function mergeBlocks(keyless: ManifestBlock | undefined, keyed: ManifestBlock): ManifestBlock {
  if (!keyless) return keyed

  return {
    endpoints: { ...keyed.endpoints, ...keyless.endpoints },
    methods: { ...keyed.methods, ...keyless.methods },
    timeouts: { ...keyed.timeouts, ...keyless.timeouts },
  }
}

/**
 * The keyless half of a shared name, with the keyed half answering out loud.
 *
 * `cnter.content` in a browser already throws a sentence naming the fix, and it
 * would be strange for `cnter.reservations.settings` to be a bare TypeError
 * only because the same name happens to carry something keyless too. The
 * browser has the whole manifest — it is one document, fetched without a key —
 * so it knows exactly which endpoint keys it is not binding, and can say so.
 */
function refusingKeyed(
  keyless: BoundCapability,
  name: string,
  keyed: ManifestBlock,
): BoundCapability {
  const withheld = new Set(Object.keys(keyed.endpoints).filter((key) => !(key in keyless)))
  if (withheld.size === 0) return keyless

  return new Proxy(keyless, {
    get(target, property) {
      if (typeof property !== 'string') return undefined
      if (property in target) return target[property]
      if (withheld.has(property)) throw serverOnly(`${name}.${property}`)
      return undefined
    },
  })
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
    // `undefined` used to be passed here, which made every keyless endpoint a
    // GET. That held until `promotions/preview` arrived — a POST, advertised
    // here, called with a GET, answered `405`. The block carries its verbs now,
    // the same way the server block always has.
    client[capability] = bind(entry, options)
  }

  for (const [app, entry] of Object.entries(options.manifest.server)) {
    if (includeServer) {
      // Merged, not assigned. This was `client[app] = bind(entry, options)`,
      // which is the same thing right up until one name appears in both blocks
      // — and then the second loop silently replaced the first. An app with a
      // keyless surface and a keyed one shares a name by construction, because
      // both blocks are keyed by capability, so `reservations` would have kept
      // `settings` and lost `availability` on every server-rendered site. Not a
      // clean failure either: the Proxy below sees the name and lets it
      // through, so the site gets `not a function` in its own code.
      client[app] = bind(mergeBlocks(options.manifest.capabilities[app], entry), options)
      continue
    }

    // A browser binds nothing keyed. Where the name is keyless too, the keyless
    // half stays callable and the keyed half answers with the sentence rather
    // than with `undefined`; where the name is keyed only, it is absent and the
    // Proxy below says the same thing about the whole name.
    if (client[app]) client[app] = refusingKeyed(client[app], app, entry)
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
/**
 * The one sentence for "this needs a key", wherever it is met.
 *
 * Said about a whole capability when the name is keyed-only, and about a single
 * endpoint when the name carries both kinds. One text, because a builder who
 * meets the second should not have to work out that it means the first.
 */
function serverOnly(what: string): CnterError {
  return new CnterError('server_only', `“${what}” needs an API key, so it cannot run in a browser`, {
    fix:
      `Call it from your server with the server entry point: ` +
      `createCnterClient({ apiKey }). A key in page code is a published key, and a browser ` +
      `cannot send one to CNTER anyway — the request is refused before it arrives.`,
  })
}

export function missingCapability(
  name: string,
  manifest: Manifest,
  includeServer: boolean,
): CnterError {
  const keyed = Object.keys(manifest.server)
  if (!includeServer && keyed.includes(name)) return serverOnly(name)

  // Every name this client could have answered to. A name in both blocks is one
  // name to a reader, so it is listed once rather than twice.
  const available = [
    ...Object.keys(manifest.capabilities),
    ...(includeServer ? keyed.filter((app) => !(app in manifest.capabilities)) : []),
  ]

  return new CnterError('capability_absent', `“${name}” is not switched on for this organization`, {
    fix:
      available.length > 0
        ? `This organization has: ${available.join(', ')}. ` +
          'If you expected more, the merchant enables apps under Settings → Organization → Modules.'
        : 'This organization has no apps switched on yet.',
  })
}
