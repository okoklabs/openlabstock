# Production Runtime Contract

OpenLabStock production artifacts contain application code only. Runtime data, environment files, credentials, logs and backups must remain outside the release directory.

## Required files

A production archive must include at least:

- `dist/`
- `server.mjs`, `storage.mjs`, `password.mjs`
- `scripts/backup.mjs`, `scripts/reset-owner-password.mjs`
- `deploy/`
- `package.json`
- `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md`
- `README.md`, `DEPLOYMENT.md`, `AGENTS.md`

It must not include `.env`, SQLite databases, backups, logs, verification receipts, Git metadata or local absolute paths.

## Runtime separation

The generic systemd example uses:

```text
/opt/openlabstock                  application
/var/lib/openlabstock              database and backups
/etc/openlabstock/openlabstock.env environment
```

Never extract an application archive into `/var/lib/openlabstock`. Updating `/opt/openlabstock` must not move, delete or overwrite the data directory.

## Release verification

Before building a release, increment `package.json` version and run one complete verification:

```bash
pnpm run verify
pnpm run release -- --manifest OpenLabStock-production-<release>.manifest.txt
```

Then unpack the archive into an isolated temporary directory, start it with an empty temporary database, and check `/api/health`. This smoke test validates the artifact; it does not repeat the full test suite unless runtime code or the lockfile changed after verification.

## Post-deployment checks

After switching the application directory, wait two seconds and verify:

```bash
curl --fail --show-error http://127.0.0.1:4388/api/health
curl --fail --show-error https://inventory.example.org/api/health
node -p "JSON.parse(require('fs').readFileSync('/opt/openlabstock/package.json','utf8')).version"
```

The authenticated sidebar, local health response, public health response and installed `package.json` must report the same version. Replace `inventory.example.org` with the operator's actual domain.

## Failure handling

- Preserve the pre-update database backup and previous application directory.
- If startup or health checks fail, stop the failed process and restore only the previous application directory.
- Do not delete SQLite volumes or run `docker compose down -v` during rollback.
- Record the failed version and relevant redacted logs outside the public repository.
