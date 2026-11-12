/**
 * Widgets in a Next.js site.
 *
 * Since 1.0.6 a widget floats in the bottom-right corner, and a site needs one
 * line in its root layout for it:
 *
 *   <CnterFloatingWidget client={cnter} />
 *
 * Whatever the owner switches on in CNTER appears there; switched off, it is
 * gone on the next page load. The rest of this file is the way widgets were
 * placed up to 1.0.5, `<CnterEmbeds placement="…">` per place, kept for a site
 * that already has it:
 *
 * The site puts a place in its layout once; whatever the owner switches on in
 * CNTER renders there, with no change to the code. A server component: the
 * list is read during the render, so a link or a frame is in the HTML the
 * visitor receives, and only a provider's script loads in the browser — through
 * `next/script`, after the page is interactive (`head`) or when the browser is
 * idle (everything else), so a widget never holds up the page.
 *
 * Every element is built from fixed fields (`embeds/shape.ts` checks each one
 * again), so nothing from CNTER is ever rendered as HTML.
 *
 * It renders nothing when the module is off, when CNTER cannot be reached and
 * when the place has no widgets: a header with one button less, never an error
 * page.
 */

import Script from 'next/script'
import type { ReactElement } from 'react'

import type { CnterClient } from './core/client'
import { CnterFloatingMount } from './embeds/floating-mount'
import { floatingEmbed } from './embeds/floating'
import { IFRAME_SANDBOX, readEmbeds, type Embed } from './embeds/shape'

export type { Embed } from './embeds/shape'

/** A provider's page in its own tab, without a handle back to the site. */
const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const

/** `createCnterClient(…)`, or what its `ready()` resolved to. */
type ClientLike = { ready(): Promise<CnterClient> } | CnterClient | Promise<CnterClient>

export type CnterEmbedsProps = {
  client: ClientLike
  /** `header_button`, `head`, `body_end` or `section:<name>`. */
  placement: string
  /** Added to every link, so a widget button looks like the site's own buttons. */
  linkClassName?: string
}

/**
 * The client, ready.
 *
 * `in`, not a property read: a ready client answers any name it does not have
 * by throwing (so a site learns which capability is missing), and up to 1.0.5
 * reading `.ready` on one threw here — every widget list from a client that was
 * already `ready()` came back empty, silently.
 */
async function resolveClient(client: ClientLike): Promise<CnterClient> {
  const value = await client
  return typeof value === 'object' && value !== null && 'ready' in value && typeof value.ready === 'function'
    ? (value as { ready(): Promise<CnterClient> }).ready()
    : (value as CnterClient)
}

/**
 * The widget the owner switched on, bottom right, on every page.
 *
 * Put it in the root layout once. The list is read on the server (cached as
 * the client's other reads are) and only the widget goes to the browser, where
 * it is added after hydration, once per page — a client-side navigation adds
 * nothing twice. Renders nothing when the module is off, CNTER cannot be
 * reached, or no widget is on.
 */
export async function CnterFloatingWidget({ client }: { client: ClientLike }): Promise<ReactElement | null> {
  try {
    const cnter = await resolveClient(client)
    const embed = floatingEmbed(readEmbeds(await cnter.embeds.list()))
    return embed ? <CnterFloatingMount embed={embed} /> : null
  } catch {
    return null
  }
}

/**
 * The widgets for one place, checked, or none.
 *
 * Exported for a site that renders them itself. Never throws: a failure here is
 * a place without widgets.
 */
export async function listEmbeds(client: ClientLike, placement: string): Promise<Embed[]> {
  try {
    const cnter = await resolveClient(client)
    const answer = await cnter.embeds.list({ placement })
    return readEmbeds(answer).filter((embed) => embed.placement === placement)
  } catch {
    return []
  }
}

export async function CnterEmbeds({ client, placement, linkClassName }: CnterEmbedsProps): Promise<ReactElement | null> {
  const embeds = await listEmbeds(client, placement)
  if (embeds.length === 0) return null

  return (
    <>
      {embeds.map((embed) => (
        <CnterEmbed key={embed.id} embed={embed} linkClassName={linkClassName} />
      ))}
    </>
  )
}

/** One widget. A script placed in `head` renders only its script; anywhere else its element too. */
export function CnterEmbed({ embed, linkClassName }: { embed: Embed; linkClassName?: string }): ReactElement | null {
  const base = `cnter-embed cnter-embed-${embed.kind} cnter-embed-${embed.provider}`

  switch (embed.kind) {
    case 'link':
      return (
        <a
          href={embed.url}
          className={linkClassName ? `${base} ${linkClassName}` : base}
          data-cnter-embed-id={embed.id}
          target={embed.new_tab ? NEW_TAB.target : undefined}
          rel={embed.new_tab ? NEW_TAB.rel : undefined}
        >
          {embed.label}
        </a>
      )
    case 'iframe':
      return (
        <iframe
          src={embed.url}
          title={embed.title}
          width={embed.width}
          height={embed.height}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox={IFRAME_SANDBOX}
          className={base}
          style={{ border: 0, maxWidth: '100%' }}
          data-cnter-embed-id={embed.id}
        />
      )
    case 'script': {
      const box = embed.container
      const script = (
        <Script
          id={`cnter-embed-${embed.id}`}
          src={embed.src}
          strategy={embed.placement === 'head' ? 'afterInteractive' : 'lazyOnload'}
          data-cnter-embed-id={embed.id}
          {...embed.attributes}
        />
      )
      if (embed.placement === 'head' || !box) return script

      const props = {
        className: box.classes.join(' ') || undefined,
        style: box.height ? { height: box.height } : undefined,
        ...box.attributes,
      }
      return (
        <>
          {box.tag === 'button' ? (
            <button type="button" {...props}>
              {box.label}
            </button>
          ) : (
            <div {...props} />
          )}
          {script}
        </>
      )
    }
  }
}
