# MongoDB backups and recovery

These commands operate on the Docker MongoDB container for the selected environment. They do **not** start the scraper or change its schedule.

## What is backed up?

The complete selected MongoDB database, including property metadata, price history, users, schedule and run history. **Images are not in MongoDB**; copy the directories separately (dev/images for development or the PROD_IMAGES_PATH directory for production).

Archives can contain account data and private information. Keep them on encrypted, access-controlled storage **outside Git**. Don't publish them or attach them to issues.

## Development

Start MongoDB once, then back up:

    npm run dev:db:start
    npm run dev:backup

Development backups are saved to ignored backups/dev/ (you can override with --dir). The latest 14 complete archives are retained by default.

Verify and restore a known archive:

    node scripts/mongo-backup.cjs verify --env dev --file /absolute/path/to/immoweb_dev-example.archive.gz
    node scripts/mongo-backup.cjs restore --env dev --file /absolute/path/to/immoweb_dev-example.archive.gz --confirm RESTORE_immoweb_dev

Restoring drops and replaces matching collections. Stop the app, routines and any other database writers first. Verify the archive and save a fresh backup of the current database before restoring.

## Production

Configure an existing writable directory outside the repository in the ignored deploy/config.prod.env:

    PROD_BACKUPS_PATH=/mnt/separate-disk/immoweb-backups

Use persistent storage on a different disk or offsite; the MongoDB volume itself is **not** a safe backup destination. Create the directory separately with restricted permissions before running a backup.

Make sure the production MongoDB service is running, then:

    npm run prod:backup

Verify the archive:

    node scripts/mongo-backup.cjs verify --env prod --file /absolute/path/to/immoweb_prod-example.archive.gz

For recovery, stop the application/routines and prevent database writes, verify the archive, then run:

    node scripts/mongo-backup.cjs restore --env prod --file /absolute/path/to/immoweb_prod-example.archive.gz --confirm RESTORE_immoweb_prod

A restore uses mongorestore --drop: it overwrites collections in the selected database. It does not start or stop any application services. After restoring, check record counts, application login and listing history.

Backups use mongodump --archive --gzip, stream from Docker directly to a temporary file on the host, and are published only after a successful dump. A manifest with file size and SHA-256 accompanies each archive. A lock file prevents overlapping backups and checksum verification runs before retention. An interrupted dump leaves no completed archive; stale locks require manual inspection. Historical archive retention defaults to 14 backups and can be configured with --keep N.

**Consistency note:** MongoDB writes can continue during mongodump. For a consistent recovery point, temporarily stop app/routine writers during backup; this tool is not a point-in-time continuous-backup system. A database dump and an image-directory copy are not automatically synchronized.

## Scheduling

The backup script can be run unattended by a **host** scheduler on an always-on machine. GitHub Codespaces is not suitable for reliable scheduled backups, because it can stop when idle. The project deliberately does not activate an OS schedule or the scraper.

For an always-on Linux host, an example weekly *database-only* crontab entry is:

    0 2 * * 0 cd /absolute/path/to/immoweb-keeper && /usr/bin/node scripts/mongo-backup.cjs backup --env prod --keep 14 >> /absolute/path/to/backup-job.log 2>&1

Adjust paths and timezone; configure a disk-space monitor and failure alert before relying on this unattended. The command requires working Docker access and an existing PROD_BACKUPS_PATH. The backup log should not be published.

For full disaster recovery, back up production images using `npm run prod:backup:images` or both the database and images using `npm run prod:backup:all`. A daily, opt-in systemd timer template is explained in [hosting](hosting.md); it does not activate automatically. Back up deploy/config.prod.env (including the JWT secret) separately and securely, with access limited to administrators. Test a restore periodically in a separate environment.
