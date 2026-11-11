/**
 * A widget as `cnter.embeds.list` answers it, read once more on the site's side.
 *
 * The server only hands out widgets that are switched on and trusted, built
 * from fixed fields. This is the second lock, and it belongs here because this
 * code runs on somebody else's website: whatever the answer says, nothing is
 * placed that is not an https address, and no attribute is set that is not
 * `data-*`. A widget that fails a check is left out, quietly — a page with one
 * button less is better than a page with somebody else's code on it.
 *
 * No imports from the dashboard: this file ships in the browser script and in
 * the npm package.
 */

export type EmbedContainer = {
  tag: 'div' | 'button'
  classes: string[]
  attributes: Record<string, string>
  label?: string
  height?: number
}

type Head = { id: string; provider: string; placement: string }

export type Embed =
  | (Head & { kind: 'link'; url: string; label: string; new_tab: boolean })
  | (Head & { kind: 'iframe'; url: string; title: string; width: '100%' | number; height: number })
  | (Head & {
      kind: 'script'
      src: string
      async: boolean
      defer: boolean
      attributes: Record<string, string>
      container: EmbedContainer | null
    })

/**
 * What a provider's window may do. Scripts, forms and its own origin for the
 * booking flow; popups for a payment page; leaving the frame only after a
 * click. Never navigating the site itself unasked.
 */
export const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation'

const DATA_NAME = /^data-(?!cnter)[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A value that names a script, not data. */
const SCRIPT_URL = /^[\s\u0000-\u001f]*(javascript|data|vbscript)\s*:/i
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null
}

function pixels(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

function dataAttributes(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const kept: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (DATA_NAME.test(name) && typeof entry === 'string' && entry.length <= 500 && !SCRIPT_URL.test(entry)) {
      kept[name] = entry
    }
  }
  return kept
}

function container(value: unknown): EmbedContainer | null {
  if (!isRecord(value) || (value.tag !== 'div' && value.tag !== 'button')) return null
  const label = value.tag === 'button' ? text(value.label, 60) : null
  const height = pixels(value.height, 100, 4000)
  return {
    tag: value.tag,
    classes: Array.isArray(value.classes)
      ? value.classes.filter((name): name is string => typeof name === 'string' && CLASS_NAME.test(name)).slice(0, 5)
      : [],
    attributes: dataAttributes(value.attributes),
    ...(label ? { label } : {}),
    ...(height ? { height } : {}),
  }
}

function embed(value: unknown): Embed | null {
  if (!isRecord(value)) return null
  const id = text(value.id, 100)
  const placement = text(value.placement, 60)
  if (!id || !placement) return null
  const head = { id, provider: text(value.provider, 40) ?? 'other', placement }

  switch (value.kind) {
    case 'link': {
      const label = text(value.label, 60)
      if (!isHttpsUrl(value.url) || !label) return null
      return { ...head, kind: 'link', url: value.url, label, new_tab: value.new_tab !== false }
    }
    case 'iframe': {
      const height = pixels(value.height, 100, 4000)
      const width = value.width === '100%' ? '100%' : pixels(value.width, 100, 2000)
      if (!isHttpsUrl(value.url) || !height || !width) return null
      return { ...head, kind: 'iframe', url: value.url, title: text(value.title, 120) ?? 'Widget', width, height }
    }
    case 'script':
      if (!isHttpsUrl(value.src)) return null
      return {
        ...head,
        kind: 'script',
        src: value.src,
        async: value.async !== false,
        defer: value.defer === true,
        attributes: dataAttributes(value.attributes),
        container: container(value.container),
      }
    default:
      return null
  }
}

/** The widgets in an answer of `embeds.list`, each checked; anything else is dropped. */
export function readEmbeds(answer: unknown): Embed[] {
  const data = isRecord(answer) && isRecord(answer.data) ? answer.data : null
  const list = data && Array.isArray(data.embeds) ? data.embeds : []
  return list.map(embed).filter((entry): entry is Embed => entry !== null)
}

/** `head` and `body_end` load a script and show nothing; everything else renders in its place. */
export function isPageWide(placement: string): boolean {
  return placement === 'head' || placement === 'body_end'
}
