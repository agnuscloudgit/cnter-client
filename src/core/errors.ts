/**
 * What went wrong, and what the person reading it should do.
 *
 * Modelled on the client Ciao Enkhuizen wrote by hand, because that one has
 * been in production against these endpoints for months and it gets three
 * things right that a first attempt usually does not. It separates the reason
 * from the status, so a caller can branch on "forbidden" without parsing
 * English. It keeps CNTER's own error code, which is the only thing precise
 * enough to look up. And it keeps the raw message in a field named so that
 * nobody shows it to a visitor by accident — those messages name scopes,
 * fields and internal rules.
 *
 * What is added here is the last line: what to do about it. `failures.ts` was
 * written for the playground and says, per failure, the thing a builder
 * actually needs — "this key is missing read_content, ask your client to add
 * it" rather than "403 PERMISSION_DENIED". A thrown error is the moment that
 * sentence is worth most, and it costs nothing to carry it.
 */

export type CnterFailureReason =
  /** No manifest yet: the client is still starting, or it never could. */
  | 'not_ready'
  /** The organization does not have this app switched on. */
  | 'capability_absent'
  /** Asked for a keyed capability from the browser. */
  | 'server_only'
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  /** The contract version this client speaks is retired. */
  | 'contract_gone'
  | 'timeout'
  | 'unavailable'

export class CnterError extends Error {
  readonly reason: CnterFailureReason
  readonly status?: number
  /** CNTER's own code, e.g. `PERMISSION_DENIED`. Precise enough to look up. */
  readonly code?: string
  /**
   * CNTER's own message. Never show this to a visitor: these name scopes,
   * fields and rules that mean nothing to someone booking a table.
   */
  readonly apiMessage?: string
  /** What the builder should do about it, when we know. */
  readonly fix?: string

  constructor(
    reason: CnterFailureReason,
    message: string,
    options: { status?: number; code?: string; apiMessage?: string; fix?: string } = {},
  ) {
    super(options.fix ? `${message}\n\n${options.fix}` : message)
    this.name = 'CnterError'
    this.reason = reason
    this.status = options.status
    this.code = options.code
    this.apiMessage = options.apiMessage
    this.fix = options.fix
  }
}

export function reasonForStatus(status: number): CnterFailureReason {
  if (status === 400) return 'invalid_request'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 410) return 'contract_gone'
  if (status === 429) return 'rate_limited'
  return 'unavailable'
}

/**
 * Whether trying again could plausibly help.
 *
 * A wrong key, a missing scope and a validation error do not improve with
 * waiting; retrying them only delays the error the caller has to handle. Rate
 * limits and genuine server faults do.
 */
export function worthRetrying(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 503)
}
