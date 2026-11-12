/**
 * Widgets in places a page marked, without React: `<div data-cnter-embed="header_button">`.
 *
 * The way widgets were placed up to 1.0.5, kept for a page that has such a
 * place. Since 1.0.6 a widget floats in the bottom-right corner on its own
 * (`floating.ts`) and a site marks nothing.
 *
 * The site marks its places once; whatever the owner switches on in CNTER
 * appears there on the next page view. One call for the whole page, and none
 * at all on a page without a place.
 *
 * Every element is made with `createElement` and every value set as a property
 * or a named attribute. Nothing from the answer is ever parsed as HTML: there is
 * no `innerHTML` in this file, and `dom.test.ts` keeps it that way.
 *
 * Like the rest of cnter.js this may fail to add anything and may never break
 * the page: every failure ends here, silently, with the places left as the site
 * wrote them.
 */

import { IFRAME_SANDBOX, isPageWide, readEmbeds, type Embed, type EmbedContainer } from './shape'

/** Marks a place that was filled, so a second run adds nothing twice. */
const PLACED = 'data-cnter-embed-placed'
export const EMBED_ID = 'data-cnter-embed-id'

type ListCapable = { embeds: { list: (params?: Record<string, string>) => Promise<unknown> } }

function setData(element: Element, attributes: Record<string, string>): void {
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
}

/**
 * The script tags of a widget, built with `createElement` so the browser runs
 * them (a script that arrives as HTML never runs). Every attribute the answer
 * carries is set by name — the `id` too: Zenchef's SDK finds itself by
 * `#zenchef-sdk`. Approved inline code becomes the text of its own script
 * element, which runs after `src` has loaded when there is one, as it did in
 * the provider's snippet.
 */
export function scriptsFor(doc: Document, embed: Extract<Embed, { kind: 'script' }>): HTMLScriptElement[] {
  const inline = () => {
    const code = doc.createElement('script')
    code.text = embed.inline ?? ''
    code.setAttribute(EMBED_ID, embed.id)
    return code
  }
  if (!embed.src) return embed.inline ? [inline()] : []

  const script = doc.createElement('script')
  for (const [name, value] of Object.entries(embed.scriptAttributes)) {
    if (value !== undefined) script.setAttribute(name, value)
  }
  script.src = embed.src
  script.async = embed.async
  script.defer = embed.defer
  setData(script, embed.attributes)
  script.setAttribute(EMBED_ID, embed.id)
  if (embed.inline) {
    script.addEventListener('load', () => script.parentNode?.insertBefore(inline(), script.nextSibling), { once: true })
  }
  return [script]
}

/** The element a provider's script reads, before the script itself. */
export function containerFor(doc: Document, box: EmbedContainer): Element {
  const element = doc.createElement(box.tag)
  if (box.id) element.id = box.id
  for (const name of box.classes) element.classList.add(name)
  setData(element, box.attributes)
  if (box.tag === 'button') {
    ;(element as HTMLButtonElement).type = 'button'
    element.textContent = box.label ?? ''
  }
  if (box.height) (element as HTMLElement).style.height = `${box.height}px`
  return element
}

/** The visible part of a widget: a link, a frame, or the element a script fills. */
function elementsFor(doc: Document, embed: Embed): Element[] {
  switch (embed.kind) {
    case 'link': {
      const link = doc.createElement('a')
      link.href = embed.url
      link.textContent = embed.label
      link.className = `cnter-embed cnter-embed-link cnter-embed-${embed.provider}`
      if (embed.new_tab) {
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
      }
      link.setAttribute(EMBED_ID, embed.id)
      return [link]
    }
    case 'iframe': {
      const frame = doc.createElement('iframe')
      frame.src = embed.url
      frame.title = embed.title
      frame.width = String(embed.width)
      frame.height = String(embed.height)
      frame.loading = 'lazy'
      frame.referrerPolicy = 'strict-origin-when-cross-origin'
      frame.setAttribute('sandbox', IFRAME_SANDBOX)
      frame.style.border = '0'
      frame.style.maxWidth = '100%'
      frame.className = `cnter-embed cnter-embed-iframe cnter-embed-${embed.provider}`
      frame.setAttribute(EMBED_ID, embed.id)
      return [frame]
    }
    case 'script': {
      return [...(embed.container ? [containerFor(doc, embed.container)] : []), ...scriptsFor(doc, embed)]
    }
  }
}

/**
 * Fill every `[data-cnter-embed]` on the page.
 *
 * A script placed in `head` goes to `document.head`, one placed in `body_end`
 * (with its element) to the end of `document.body`, once per page, wherever
 * its marker stands; everything else goes inside the marker, oldest first.
 */
export async function placeEmbeds(client: unknown, doc: Document = document): Promise<void> {
  try {
    const places = Array.from(doc.querySelectorAll(`[data-cnter-embed]:not([${PLACED}])`))
    if (places.length === 0) return

    // The capability is absent while the module is off; the client then throws
    // a typed error, which is exactly "nothing to place".
    const answer = await (client as ListCapable).embeds.list()
    const embeds = readEmbeds(answer)

    for (const place of places) {
      const placement = place.getAttribute('data-cnter-embed') ?? ''
      place.setAttribute(PLACED, '')

      for (const embed of embeds) {
        if (embed.placement !== placement) continue

        if (isPageWide(placement)) {
          if (embed.kind !== 'script') continue
          const loaded = Array.from(doc.querySelectorAll(`[${EMBED_ID}]`))
          if (loaded.some((element) => element.getAttribute(EMBED_ID) === embed.id)) continue
          // `head` takes the script alone; `body_end` also the element it fills,
          // a floating booking button for instance.
          const target = placement === 'head' ? doc.head : doc.body
          const elements = placement === 'head' ? scriptsFor(doc, embed) : elementsFor(doc, embed)
          for (const element of elements) target.appendChild(element)
          continue
        }

        // A provider script loads once per page, as next/script does by its id:
        // a second marker for the same section gets the element, not the script.
        const loaded = Array.from(doc.querySelectorAll(`[${EMBED_ID}]`)).some(
          (element) => element.tagName.toLowerCase() === 'script' && element.getAttribute(EMBED_ID) === embed.id,
        )
        for (const element of elementsFor(doc, embed)) {
          if (loaded && element.tagName.toLowerCase() === 'script') continue
          place.appendChild(element)
        }
      }
    }
  } catch {
    // Nothing placed, nothing broken.
  }
}
