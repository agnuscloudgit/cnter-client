/**
 * Widgets in a Next.js site: `<CnterEmbeds client={cnter} placement="header_button" />`.
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

async function resolveClient(client: ClientLike): Promise<CnterClient> {
  const value = await client
  return typeof (value as { ready?: unknown }).ready === 'function'
    ? (value as { ready(): Promise<CnterClient> }).ready()
    : (value as CnterClient)
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
