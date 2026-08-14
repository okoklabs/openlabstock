<div align="center">
  <img src="./public/icons/labstock-192-v1.png" alt="OpenLabStock logo" width="88" />
  <h1>OpenLabStock</h1>
  <p><strong>Self-hosted inventory for labs, from disposable supplies to reusable probes.</strong></p>
  <p>Replace linked spreadsheets and forms with one responsive, auditable workspace for stock, usage, stocktake, and unit-level traceability.</p>
  <p><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://github.com/okoklabs/openlabstock/actions/workflows/quality.yml"><img src="https://github.com/okoklabs/openlabstock/actions/workflows/quality.yml/badge.svg" alt="Quality workflow" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-0b7a63" alt="AGPL-3.0-only license" /></a>
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22.12 or newer" />
    <img src="https://img.shields.io/badge/status-public_preview-e6a23c" alt="Public preview status" />
  </p>
</div>

![OpenLabStock desktop dashboard with synthetic laboratory inventory data](./docs/assets/openlabstock-dashboard-desktop.png)

## Why laboratory inventory breaks down

Spreadsheets are excellent at listing quantities. They become fragile when a laboratory needs to know **what happened to a specific item**.

| What happens in the lab | Why a spreadsheet or generic checkout list struggles |
| --- | --- |
| One 50-probe box contains new, used, unavailable, shared, and member-reserved probes | A single quantity cannot represent mixed state and access scope |
| Probe `2-3` is reused by another member but remains “in use” | The lifecycle state did not change, but a new usage event still matters |
| A member records the wrong quantity or position | Deleting a row destroys history; the correction itself should be traceable |
| Stock on the shelf differs from the ledger | A count is not enough without a stocktake batch, reason, and adjustment trail |
| Recording takes too many steps on a phone | People postpone it, and “current stock” quietly stops being current |

OpenLabStock models those cases directly, while keeping ordinary gloves, tips, bottles, and reagents simple.

## What makes OpenLabStock different

### One system, three inventory models

| Model | Use it for | What is tracked |
| --- | --- | --- |
| **Quantity** | Gloves, pipette tips, bottles, tubes | Current quantity, safety stock, inbound and outbound records |
| **Stateful pool** | Reusable items that do not need a box identity | Quantity by configurable state and access scope |
| **Tracked units** | Probes, kits, lots, boxes, positions, and serialized items | Box or unit identity, exact position, state, owner, and each use event |

The important distinction is deliberate: **using an item is an event; changing its state is a lifecycle transition**. A reusable probe can be used many times without inventing a fake state change for every use.

### A 50-probe box that behaves like a real 50-probe box

- Search by material, box number, complete probe code, position, state, or member.
- Mix open and member-reserved probes inside the same physical box.
- Keep “new”, “in use”, and “unavailable” separate, with administrator-defined state labels.
- Collapse boxes by default, pin usable stock first, and fold unavailable items away from daily work.
- Bind QR codes to immutable material and inventory-unit UUIDs, not editable names.

### Scan at the bench, confirm before the write

Print a QR label for a material or box. Scan it with WeChat or the system camera to open the exact checkout/use form, then confirm quantity, destination, position, and note. Only that confirmation creates the audited inventory write.

```text
QR label → WeChat / browser scan → exact material or box → confirm details → transaction + audit trail
```

This keeps the workflow fast without making “scan once” an irreversible stock change.

## Real product views

All screenshots below come from the running application with isolated synthetic data. No production database or real member record is used.

<table>
  <tr>
    <td width="60%">
      <img src="./docs/assets/openlabstock-probe-tablet.png" alt="OpenLabStock probe inventory on a tablet" />
      <br /><sub><strong>Tablet landscape:</strong> two boxes, summary totals, mixed state, shared and reserved probes.</sub>
    </td>
    <td width="20%">
      <img src="./docs/assets/openlabstock-probe-mobile.png" alt="OpenLabStock probe inventory on a mobile phone" />
      <br /><sub><strong>Mobile:</strong> the same 50-probe workflow in a compact Material 3 dialog.</sub>
    </td>
    <td width="20%">
      <img src="./docs/assets/openlabstock-qr-mobile.png" alt="OpenLabStock QR label on a mobile phone" />
      <br /><sub><strong>QR labels:</strong> download or print a stable link to the exact inventory unit.</sub>
    </td>
  </tr>
</table>

The interface is designed for desktop, tablet, and phone use. It includes a restricted-network PWA mode, while intentionally refusing to cache, queue, or replay inventory writes offline.

## Feature highlights

- **Fast daily operations:** inbound, checkout/use, recent personal records, global search, and safety-stock alerts.
- **Reusable-item traceability:** configurable states, boxes and lots, exact positions, open/member-reserved scope, repeated usage events, and controlled disposal.
- **Inventory integrity:** immutable historical transactions, explicit corrections, stocktake batches, difference review, and linked adjustments.
- **System audit:** searchable administrator audit records for settings, members, materials, stocktake, recovery, and other privileged actions.
- **Roles and organization:** system owner, system administrator, inventory administrator, and member roles with backend authorization; groups are snapshotted into history.
- **QR without lock-in:** browser-local QR generation and recognition, downloadable labels, HTTPS camera support, plus image recognition fallback.
- **Import and reporting:** guarded Excel import, Excel/CSV exports, complete server-side record pagination, and organization consumption summaries.
- **Self-hosted operations:** SQLite consistency backups, integrity checks, controlled restore, systemd and Docker deployment paths, health checks, and rollback guidance.

## Where it fits among mature products

OpenLabStock is deliberately narrower than an ERP or ELN. It focuses on the moment a laboratory member stands in front of a cabinet and needs the record to match the physical item.

| Product | Primary center of gravity in its public documentation | OpenLabStock's focus for this use case |
| --- | --- | --- |
| [Snipe-IT](https://github.com/grokability/snipe-it) | IT assets, licenses, assignment, and custody | Laboratory consumables plus stateful probe/box/position workflows |
| [InvenTree](https://github.com/inventree/InvenTree) | Parts and stock control with manufacturing, API, and plugin depth | A smaller lab-oriented Node/SQLite footprint with usage and access scope built into unit tracking |
| [eLabFTW](https://github.com/elabftw/elabftw) | Electronic lab notebook and general research resource database | Inventory-first checkout/use, physical stocktake, and reusable-item identity |
| [Labguru](https://www.labguru.com/inventory) | Commercial ELN and laboratory inventory platform | AGPL self-hosting, local data ownership, and a focused operational workflow without a required vendor account |

This is a positioning comparison, not a universal feature benchmark. Each product serves a broader or different problem well. The linked official material was reviewed on **2026-08-14**; evaluate current documentation and your own regulatory requirements before choosing a system.

## Quick start

Requirements: Node.js `>=22.12.0` and the repository-declared pnpm version.

```bash
git clone https://github.com/okoklabs/openlabstock.git
cd openlabstock
corepack enable
pnpm install --frozen-lockfile
pnpm run verify:quick
pnpm run build
pnpm run start
```

Open <http://127.0.0.1:4388/>. A local non-production database includes two demonstration accounts:

- System owner: `admin` / `admin123`
- Member: `student` / `demo123`

Production mode never creates these demo credentials. A first production start requires an independent owner password through the documented environment variable. Runtime data stays in the Git-ignored `data/` directory by default.

## Deployment

- [Deployment overview](./DEPLOYMENT.md): Node/systemd, HTTPS, persistent data, backup, update, and rollback boundaries.
- [Docker deployment](./deploy/docker/README.md): loopback-only binding, persistent data and backup volumes, health checks, and isolated smoke tests.
- [Production package contract](./deploy/PRODUCTION.md): release contents, versioning, integrity manifest, and clean unpacked startup.

OpenLabStock defaults to `127.0.0.1:4388`; expose it through a controlled HTTPS reverse proxy. Never place production databases, backups, `.env` files, credentials, or server inventories in source control or Issues.

## Architecture and verification

| Layer | Implementation |
| --- | --- |
| Web application | Astro, React, TypeScript, responsive Material 3 interface, restricted-network PWA |
| API | Node.js HTTP API with backend role checks and guarded input validation |
| Data | SQLite, transactional writes, migrations, immutable history snapshots |
| Operations | Native systemd or single-instance Docker deployment, health checks, backup and controlled restore |

```bash
pnpm run verify:quick   # Daily checks: docs, licenses, types, and regression tests
pnpm run verify         # Full build, tests, audit, and release verification
pnpm run check:docs     # Markdown local-link validation
```

Read the [system architecture](./docs/BUILD_ARCHITECTURE.md), [inventory tracking model](./docs/INVENTORY_TRACKING.md), [QR workflow](./docs/QR_CODE_WORKFLOW.md), and [engineering workflow](./docs/ENGINEERING_WORKFLOW.md) before changing shared behavior.

## Project status and roadmap

OpenLabStock is preparing its first public release. The application is functional and regression-tested, but the external contribution gate, CLA activation, and final public-release review are still in progress. Use synthetic data for evaluation and review [the roadmap](./ROADMAP.md) and [current public tasks](./TODO.md) before planning production adoption.

## License and community

OpenLabStock source code is licensed under [GNU AGPL v3.0 only](./LICENSE), SPDX `AGPL-3.0-only`. Third-party components retain their own licenses; see [NOTICE](./NOTICE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

AGPL permits commercial use, but network deployment, modification, and redistribution carry source-availability obligations. A separate commercial license is planned but is **not currently available**. The draft [CLA](./CLA.md) is also **not active** and must not be treated as a signed agreement.

- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Governance](./GOVERNANCE.md)
- [Support boundaries](./SUPPORT.md)
- [Trademark policy](./TRADEMARKS.md)

<p align="center"><strong>OpenLabStock</strong> · Build records people will actually make at the bench.</p>
