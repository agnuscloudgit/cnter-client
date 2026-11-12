# @cnter/client

Server-side client for CNTER. It knows one address — the manifest — and reads
every other path out of the answer, so an endpoint that moves in CNTER moves
without your code changing.

```bash
npm install @cnter/client@github:agnuscloudgit/cnter-client#v1.0.6
```

```ts
import { createCnterClient } from '@cnter/client/server'

const cnter = await createCnterClient({
  baseUrl: process.env.CNTER_BASE_URL!,
  organizationId: process.env.CNTER_ORG_ID!,
  apiKey: process.env.CNTER_API_KEY, // only for the keyed apps
  siteOrigin: 'your-site.nl',
}).ready()

const { data } = await cnter.content.items({ content_type: 'menu' })
```

## Widgets

The booking button the owner switches on in CNTER (Zenchef, Formitable,
Salonized, Treatwell, …) floats in the bottom-right corner of every page.
Put this in your root layout once; what appears is managed in the dashboard
under Settings → Integrations → Widgets.

```tsx
import { CnterFloatingWidget } from '@cnter/client/next'

<body>
  {children}
  <CnterFloatingWidget client={cnter} />
</body>
```

## Next.js

This package ships TypeScript source rather than a build, so Next has to be
told to compile it. Without this the first import fails with a syntax error
in `node_modules`, which reads like a broken package and is not one:

```js
// next.config.js
module.exports = { transpilePackages: ['@cnter/client'] }
```

Source rather than a build on purpose: the whole package is a few small files,
and shipping the source means the code you install is the code you can read.

A page that needs only keyless data loads the hosted script instead, which
updates itself and needs no install at all:

```html
<script src="https://client.cnter.co/client/v1/cnter.js?org=YOUR-ORG" defer></script>
```

## Generated

Every file here is generated from the CNTER repository by
`scripts/pack-client.ts`. Edits made here are lost on the next publish;
the source of truth is `src/lib/client-script/` in that repository.
