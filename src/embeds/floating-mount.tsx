'use client'

/**
 * The browser half of `<CnterFloatingWidget>`: adds the widget the server
 * picked, after hydration. `placeFloating` keeps it to one per page, so React
 * running this twice in development, a remount, or cnter.js on the same page
 * adds nothing twice.
 *
 * Left in place on unmount: a provider's script cannot be taken back out of a
 * page, and the root layout this lives in does not unmount between pages.
 */

import { useEffect } from 'react'

import { placeFloating } from './floating'
import type { Embed } from './shape'

export function CnterFloatingMount({ embed }: { embed: Embed }): null {
  useEffect(() => {
    placeFloating(embed, document)
  }, [embed])
  return null
}
