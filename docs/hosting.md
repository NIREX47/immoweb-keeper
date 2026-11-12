# Hosting and protected automatic backups

## Status

This repository contains a Docker production setup, but **no permanent server has been provisioned**, no domain has been configured, and no host backup timer has been enabled. Both the production app and the MongoDB container are designed to run on an always-on Linux server with Docker Engine + the Compose plugin. Production currently listens only on `127.0.0.1:8080`. Access it through a secure SSH tunnel or a separately configured authenticated HTTPS reverse proxy; do not expose MongoDB to the public Internet.

**The production scraper is disabled by default**, even when an old database schedule contains `enabled: true`. To allow production scraping later requires the deliberate environment setting `ROUTINE_EXECUTION_ENABLED=true` and a reviewed application schedule. Keep this false until rate-limit handling, terms of use and full-run coverage are reviewed.

## Before deployment

1. Choose an always-on server and secure storage. An encrypted off-server copy is strongly recommended: keeping back-ups on the same server/disk does not protect against disk failure, theft or account compromise.
2. Install Docker Engine, Docker Compose plugin and Node.js 22; restrict Docker access to administrators. Membership in the Docker group is effectively root-level access.
3. Check out the reviewed release code to a **separate production directory**, e.g. `/opt/immoweb-keeper`. Do not run the install commands in an existing Codespace used for storing data.
4. Create existing, writable, restricted directories for production images, logs, and backups **outside the repository**. Prefer a separate mounted disk for backup storage.
5. Copy `deploy/config.prod.env.example` to ignored `deploy/config.prod.env`, set a long random `JWT_SECRET`, absolute `PROD_IMAGES_PATH`, `PROD_LOGS_PATH`, `PROD_BACKUPS_PATH`, and **`ROUTINE_EXECUTION_ENABLED=false`**. Never commit this file.
6. Run `npm run prod:check` and `npm run prod:deploy` only after inspecting the server, volumes, paths and backup destination. Ensure the app remains loopback-only or HTTPS-protected.

The server must run continuously for unattended tasks. GitHub Codespaces may stop when idle and cannot substitute for a permanent server.

## Automatic backups, prepared but not enabled

`npm run prod:backup:all` runs two jobs in sequence:

- **MongoDB:** a compressed archive with a SHA-256 manifest; the existing `scripts/mongo-backup.cjs` validates each dump before retention
- **Images:** a compressed tar archive with a separate SHA-256 manifest and archive integrity test; `scripts/image-backup.cjs` validates and retains the latest 14 completed copies

Both use the private `PROD_BACKUPS_PATH` destination and refuse missing or unsuitable paths. The image backup rejects storing archives inside the image directory or source repository. If either job fails, the combined job returns a nonzero exit code, suitable for monitoring.

The jobs are **separate snapshots**, not a synchronized point-in-time database/image transaction. Run during a quiet period with no image downloads or database writes. Consider maintenance windows or snapshot-capable storage if the app becomes busy. Always monitor for disk space and failed scheduled runs. A retention period of 14 days alone is not sufficient disaster recovery: maintain encrypted offsite copies and test restoration periodically.

### Optional systemd timer (Linux)

Example templates live in `deploy/systemd/`. **They are not installed or enabled automatically.** For a real server, adapt the `User`, `Group`, `WorkingDirectory`, `ExecStart` paths and file permissions to your deployment. The service account must have Docker access and read/write access to the selected image/backup directories. Review the privilege implications before assigning Docker group membership.

When the host is ready and the first manual combined backup and restoration test have passed, an administrator can install these two files under `/etc/systemd/system/` and run:

    sudo systemctl daemon-reload
    sudo systemctl enable --now immoweb-backup.timer
    systemctl list-timers immoweb-backup.timer
    sudo journalctl -u immoweb-backup.service -n 100 --no-pager

The timer is set to **daily at 03:00 Europe/Brussels** with missed occurrences scheduled when the host resumes. This runs **backups only**, not scraping. Configure alerting for failures; a successful timer installation alone does not guarantee durable backups.

## Images and database migration

Your existing saved listings and downloaded photos may currently exist in the development MongoDB volume and the Codespace filesystem. Deploying the app does **not** migrate them. Before any migration:

- Inventory and back up the original development MongoDB volume and image folder
- Verify both backups and check actual listing counts/versions
- Restore a copy into the chosen production environment only after selecting the target and validating the mapping (development database name differs from production)
- Copy images to the configured production image directory and verify file counts and checksums
- Confirm that the production app can display historical listings and price evolution

The existing `mongo-backup.cjs restore` only restores to its own selected database name, deliberately preventing accidental cross-environment imports. A development-to-production migration requires a separate, reviewed procedure; do not work around that safety check blindly.

## Security boundaries and validation

- The existing integration tests run only on disposable GitHub-hosted runners; they do not touch your Codespace data.
- No real Immoweb requests are made by those tests, and the production scraper remains off.
- MongoDB is not publicly exposed by the production Compose file.
- The app itself does not include a configured HTTPS reverse proxy, server monitoring or offsite replication yet.
- Photo archives contain downloaded data and may include sensitive material; store them encrypted and limit access.
- See [backup and recovery](backups.md) for database restoration, which requires explicit confirmation and overwrites matching collections.

**Remaining decisions before live deployment:** server/provider, domain or private VPN access, storage capacity and offsite backup destination. Without those, this repository is ready for configuration and testing, not deployed.
