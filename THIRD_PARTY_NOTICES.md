# Third-Party Notices

OpenLabStock includes or is built with third-party software. Each component remains under its own license; the OpenLabStock `AGPL-3.0-only` license does not replace those terms.

## Direct Dependencies

Versions are pinned by [`pnpm-lock.yaml`](./pnpm-lock.yaml). This table is an index, not a substitute for the license text distributed by each package.

| Package | Role | Declared license | Upstream |
| --- | --- | --- | --- |
| `@astrojs/react` | Astro integration | MIT | <https://github.com/withastro/astro> |
| `@zxing/browser` | Browser QR scanning | MIT | <https://github.com/zxing-js/browser> |
| `astro` | Frontend build | MIT | <https://github.com/withastro/astro> |
| `lucide-react` | Interface icons | ISC | <https://github.com/lucide-icons/lucide> |
| `qrcode` | Browser QR generation | MIT | <https://github.com/soldair/node-qrcode> |
| `react` | Component runtime/build input | MIT | <https://github.com/facebook/react> |
| `react-dom` | Component rendering/build input | MIT | <https://github.com/facebook/react> |
| `xlsx` | Spreadsheet import/export | Apache-2.0 | <https://git.sheetjs.com/sheetjs/sheetjs> |
| `@astrojs/check` | Type and Astro validation | MIT | <https://github.com/withastro/language-tools> |
| `@types/qrcode` | Type declarations | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| `typescript` | Type checking | Apache-2.0 | <https://github.com/microsoft/TypeScript> |

Important transitive components used by browser or build workflows include `@zxing/library` (`Apache-2.0`), `@zxing/text-encoding` (`Unlicense OR Apache-2.0`), and platform Sharp/libvips packages whose installed metadata can include `Apache-2.0 AND LGPL-3.0-or-later` or `LGPL-3.0-or-later`.

## Audited License Expressions

For the `2026.8.14-r42` lockfile, `pnpm licenses list --prod --json` reported only these expressions on the Windows development graph:

- `(Unlicense OR Apache-2.0)`
- `Apache-2.0`
- `Apache-2.0 AND LGPL-3.0-or-later`
- `BlueOak-1.0.0`
- `BSD-2-Clause`
- `BSD-3-Clause`
- `CC0-1.0`
- `CC-BY-4.0`
- `ISC`
- `LGPL-3.0-or-later`
- `MIT`
- `MPL-2.0`
- `Python-2.0`

Run `pnpm run check:licenses` after every dependency change. The check intentionally fails on a new expression so that a maintainer must review compatibility, attribution, source and notice obligations before updating the allowlist.

## Distribution Requirement

Before the first public Release, generate and review a bundle-level notice inventory for the actual Linux and browser artifacts. Preserve package copyright notices and license texts required by MIT, ISC, Apache-2.0, LGPL, MPL, Creative Commons and any other applicable terms. In particular:

- verify whether Apache-licensed packages ship an upstream `NOTICE` file that must be reproduced;
- verify which dependencies are actually incorporated into minified browser chunks, because the current chunks do not retain readable license comments;
- retain the corresponding source and relinking/notice obligations for any LGPL component that is actually distributed;
- do not treat an automated SPDX field as proof that every asset, font, icon or bundled binary has been cleared.

The exact installed package license files are available under each package in `node_modules` after `pnpm install --frozen-lockfile`. The lockfile integrity hashes and upstream package archives provide the reproducible evidence; legal conclusions still require human review.
