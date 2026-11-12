/**
 * The widget of an organization, floating in the bottom-right corner of the site.
 *
 * Since 1.0.6 a widget is exactly that: one button bottom right. The site marks
 * no place for it — cnter.js shows it on every page by itself, and a Next.js
 * site puts `<CnterFloatingWidget>` in its layout once. What appears is whatever
 * the owner switched on in CNTER:
 *
 *   - A provider's script (Zenchef, Formitable, Salonized) draws its own button
 *     and window. CNTER only adds it the way the provider's snippet did: the
 *     element it reads first, then the script with all its attributes, at the
 *     end of the body.
 *   - A link (or an iframe from before 1.0.6) gets CNTER's own small button,
 *     which opens the address in a window over the page — or in a new tab, when
 *     the owner chose that.
 *
 * One widget per page, however often this runs: cnter.js and the React
 * component both end here, a client-side navigation runs it again, and React
 * runs effects twice in development. The page is marked with
 * `data-cnter-floating="1"` on `<html>` once a widget is there, so a site can
 * move its own corner items out of the way.
 *
 * CNTER's button lives in a shadow root: the site's CSS cannot reach into it and
 * its CSS cannot leak out. Colours can be set from the site with
 * `--cnter-floating-bg` and `--cnter-floating-fg`.
 *
 * Every element is made with `createElement`; nothing from the answer is ever
 * parsed as HTML (`dom.test.ts` checks this file too). Nothing here throws: a
 * page without its widget is better than a page with an error.
 */

import { EMBED_ID, containerFor, scriptsFor } from './dom'
import { IFRAME_SANDBOX, readEmbeds, type Embed } from './shape'

/** On `<html>` while a widget is on the page. */
export const FLOATING_MARK = 'data-cnter-floating'
/** On CNTER's own button host. */
const BUTTON_HOST = 'data-cnter-floating-button'

type ListCapable = { embeds: { list: (params?: Record<string, string>) => Promise<unknown> } }

/** The widget to show: the first in the answer (one is on at a time). */
export function floatingEmbed(embeds: readonly Embed[]): Embed | null {
  return embeds[0] ?? null
}

/** Ask CNTER for the widget and show it. One call; any failure shows nothing. */
export async function showFloatingWidget(client: unknown, doc: Document = document): Promise<void> {
  try {
    const answer = await (client as ListCapable).embeds.list()
    const embed = floatingEmbed(readEmbeds(answer))
    if (embed) placeFloating(embed, doc)
  } catch {
    // Module off, CNTER unreachable, a client without the capability: no widget.
  }
}

/** Show one widget, unless the page already has one. True when it was added now. */
export function placeFloating(embed: Embed, doc: Document = document): boolean {
  try {
    const root = doc.documentElement
    if (root.getAttribute(FLOATING_MARK) === '1') return false
    if (doc.querySelector(`[${EMBED_ID}="${cssId(embed.id)}"]`)) return false

    if (embed.kind === 'script') {
      // The site already carries this provider's code by hand: a second copy
      // would draw a second button.
      const scriptId = embed.scriptAttributes.id
      if (scriptId && doc.getElementById(scriptId)) return false
      const elements = [...(embed.container ? [containerFor(doc, embed.container)] : []), ...scriptsFor(doc, embed)]
      if (elements.length === 0) return false
      root.setAttribute(FLOATING_MARK, '1')
      for (const element of elements) doc.body.appendChild(element)
      return true
    }

    const button = cnterButton(doc, embed)
    if (!button) return false
    root.setAttribute(FLOATING_MARK, '1')
    doc.body.appendChild(button)
    return true
  } catch {
    return false
  }
}

/** An id as it may stand in an attribute selector. Ids are UUIDs; anything else matches nothing. */
function cssId(id: string): string {
  return /^[A-Za-z0-9-]+$/.test(id) ? id : '-'
}

/** The text of the button for an iframe from before 1.0.6, which had none: in the page's language. */
function defaultLabel(doc: Document): string {
  return (doc.documentElement.lang || '').toLowerCase().startsWith('nl') ? 'Afspraak maken' : 'Book now'
}

const STYLE = `
:host { all: initial; }
.fab {
  position: fixed;
  right: max(16px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  z-index: 2147483000;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 48px;
  min-height: 48px;
  max-width: calc(100vw - 32px);
  margin: 0;
  padding: 0 20px 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--cnter-floating-bg, #1d1d1f);
  color: var(--cnter-floating-fg, #ffffff);
  font: 600 15px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.22);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.fab:hover { filter: brightness(1.12); }
.fab:focus-visible, .close:focus-visible { outline: 3px solid var(--cnter-floating-focus, #2f6fed); outline-offset: 3px; }
.fab svg { flex: none; width: 20px; height: 20px; }
.fab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel {
  position: fixed;
  right: max(16px, env(safe-area-inset-right));
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 64px);
  z-index: 2147483001;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  height: min(680px, calc(100vh - 112px));
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  transform-origin: 100% 100%;
  animation: cnter-open 160ms ease-out;
}
.panel[hidden] { display: none; }
.bar { display: flex; justify-content: flex-end; flex: none; padding: 4px; border-bottom: 1px solid #ececec; }
.close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; margin: 0; padding: 0;
  border: 0; border-radius: 10px; background: transparent; color: #1d1d1f; cursor: pointer;
}
.close:hover { background: #f2f2f2; }
.close svg { width: 20px; height: 20px; }
iframe { flex: 1; width: 100%; min-height: 0; border: 0; background: #ffffff; }
@media (max-width: 640px) {
  .panel {
    right: 0; bottom: 0; left: 0; top: 0;
    width: 100%; height: 100%; height: 100dvh;
    border-radius: 0;
    padding-top: env(safe-area-inset-top);
  }
}
@keyframes cnter-open { from { opacity: 0; transform: scale(0.96) translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
`

const SVG = 'http://www.w3.org/2000/svg'

/** A line icon from fixed path data: a calendar, or a cross. */
function icon(doc: Document, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = doc.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

const CALENDAR = ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z']
const CROSS = ['M18 6 6 18', 'M6 6l12 12']

/**
 * CNTER's button for a link: bottom right, at least 48 px, inside the safe area.
 * A click opens the address in a window over the page (full screen on a phone),
 * or in a new tab. The window's frame is made on the first click, so a visitor
 * who never clicks never loads the provider's page.
 */
function cnterButton(doc: Document, embed: Exclude<Embed, { kind: 'script' }>): HTMLElement | null {
  const host = doc.createElement('div')
  if (typeof host.attachShadow !== 'function') return null
  host.setAttribute(EMBED_ID, embed.id)
  host.setAttribute(BUTTON_HOST, '')
  const shadow = host.attachShadow({ mode: 'open' })

  const style = doc.createElement('style')
  style.textContent = STYLE
  shadow.appendChild(style)

  const label = embed.kind === 'link' ? embed.label : defaultLabel(doc)
  const newTab = embed.kind === 'link' && embed.new_tab

  const fab = doc.createElement('button')
  fab.type = 'button'
  fab.className = 'fab'
  fab.setAttribute('part', 'button')
  fab.appendChild(icon(doc, CALENDAR))
  const text = doc.createElement('span')
  text.textContent = label
  fab.appendChild(text)
  shadow.appendChild(fab)

  if (newTab) {
    fab.addEventListener('click', () => {
      doc.defaultView?.open(embed.url, '_blank', 'noopener,noreferrer')
    })
    return host
  }

  const panelId = `cnter-floating-${cssId(embed.id)}`
  const panel = doc.createElement('div')
  panel.className = 'panel'
  panel.id = panelId
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', label)
  panel.setAttribute('part', 'window')

  const bar = doc.createElement('div')
  bar.className = 'bar'
  const close = doc.createElement('button')
  close.type = 'button'
  close.className = 'close'
  close.setAttribute('aria-label', (doc.documentElement.lang || '').toLowerCase().startsWith('nl') ? 'Sluiten' : 'Close')
  close.appendChild(icon(doc, CROSS))
  bar.appendChild(close)
  panel.appendChild(bar)
  shadow.appendChild(panel)

  fab.setAttribute('aria-haspopup', 'dialog')
  fab.setAttribute('aria-expanded', 'false')
  fab.setAttribute('aria-controls', panelId)

  let frame: HTMLIFrameElement | null = null

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setOpen(false)
  }

  function setOpen(open: boolean): void {
    if (open && !frame) {
      frame = doc.createElement('iframe')
      frame.src = embed.url
      frame.title = label
      frame.referrerPolicy = 'strict-origin-when-cross-origin'
      frame.setAttribute('sandbox', IFRAME_SANDBOX)
      frame.setAttribute('allow', 'payment')
      panel.appendChild(frame)
    }
    panel.hidden = !open
    fab.setAttribute('aria-expanded', String(open))
    if (open) {
      doc.addEventListener('keydown', onKey)
      close.focus()
    } else {
      doc.removeEventListener('keydown', onKey)
      fab.focus()
    }
  }

  fab.addEventListener('click', () => setOpen(panel.hidden))
  close.addEventListener('click', () => setOpen(false))
  return host
}
