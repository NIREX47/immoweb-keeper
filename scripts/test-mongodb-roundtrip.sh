#!/usr/bin/env bash
# Integration test restricted to fresh, disposable GitHub Actions runners.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "${RUNNER_TEMP:-}" ]]; then
    echo "REFUSED: this destructive integration test runs only in GitHub Actions." >&2
    exit 2
fi

cd "$(dirname "$0")/.."
work="$(mktemp -d "$RUNNER_TEMP/immoweb-isolated-test.XXXXXX")"
cleanup() {
    docker compose -f compose.dev.yaml down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [[ -f deploy/config.prod.env ]]; then
        docker compose --env-file deploy/config.prod.env -f compose.prod.yaml down --volumes --remove-orphans >/dev/null 2>&1 || true
        rm -f deploy/config.prod.env
    fi
    rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$work/dev-backups" "$work/prod-backups" "$work/images" "$work/logs"

echo "=== Disposable development MongoDB ==="
docker compose -f compose.dev.yaml up -d --wait mongodb
docker compose -f compose.dev.yaml exec -T mongodb mongosh immoweb_dev --quiet --eval '
  db.estates.insertOne({
    immowebCode: 940001,
    rawMetadata: {price: {mainValue: 320000}, property: {location: {postalCode: "8670"}, type: "HOUSE"}},
    priceHistory: [{price: 340000}, {price: 320000}],
    images: ["sample.jpg"]
  });
  db.routineRuns.insertOne({
    trigger: "manual", status: "partial",
    coverage: [{postalCode: 8670, propertyType: "HOUSE", listingsSeen: 2, totalFound: 3, status: "partial"}]
  });
  if(db.estates.countDocuments({immowebCode: 940001}) !== 1) throw new Error("Dev seed failed");
'

node scripts/mongo-backup.cjs backup --env dev --dir "$work/dev-backups"
dev_archive="$(find "$work/dev-backups" -maxdepth 1 -name '*.archive.gz' -type f -print -quit)"
test -n "$dev_archive"
node scripts/mongo-backup.cjs verify --env dev --file "$dev_archive"

docker compose -f compose.dev.yaml exec -T mongodb mongosh immoweb_dev --quiet --eval '
  db.dropDatabase();
  if(db.estates.countDocuments({}) !== 0) throw new Error("Dev wipe failed");
'
node scripts/mongo-backup.cjs restore --env dev --file "$dev_archive" --confirm RESTORE_immoweb_dev
docker compose -f compose.dev.yaml exec -T mongodb mongosh immoweb_dev --quiet --eval '
  const listing = db.estates.findOne({immowebCode: 940001});
  if(!listing || listing.rawMetadata.price.mainValue !== 320000) throw new Error("Dev price not restored");
  if(listing.priceHistory.length !== 2) throw new Error("Dev price history not restored");
  if(listing.images[0] !== "sample.jpg") throw new Error("Dev image reference not restored");
  if(db.routineRuns.findOne({status: "partial"}).coverage[0].listingsSeen !== 2) throw new Error("Dev coverage not restored");
  print("PASS: development database restored with price history and scan coverage");
'

# A tampered backup must be refused before database restore starts.
printf 'TAMPER' >> "$dev_archive"
if node scripts/mongo-backup.cjs verify --env dev --file "$dev_archive" >/dev/null 2>&1; then
    echo "FAIL: corrupted backup was accepted" >&2
    exit 1
fi
echo "PASS: corrupted backup refused"

echo "=== Separate disposable production MongoDB ==="
cat > deploy/config.prod.env <<EOF
JWT_SECRET=ci-throwaway-not-for-production
PROD_APP_PORT=18080
PROD_IMAGES_PATH=$work/images
PROD_LOGS_PATH=$work/logs
PROD_BACKUPS_PATH=$work/prod-backups
EOF

docker compose --env-file deploy/config.prod.env -f compose.prod.yaml up -d --wait mongodb
docker compose --env-file deploy/config.prod.env -f compose.prod.yaml exec -T mongodb mongosh immoweb_prod --quiet --eval '
  db.estates.insertOne({immowebCode: 950001, rawMetadata: {price: {mainValue: 610000}}});
  if(db.estates.countDocuments({}) !== 1) throw new Error("Prod seed failed");
'

node scripts/mongo-backup.cjs backup --env prod
prod_archive="$(find "$work/prod-backups" -maxdepth 1 -name '*.archive.gz' -type f -print -quit)"
test -n "$prod_archive"
node scripts/mongo-backup.cjs verify --env prod --file "$prod_archive"
docker compose --env-file deploy/config.prod.env -f compose.prod.yaml exec -T mongodb mongosh immoweb_prod --quiet --eval 'db.dropDatabase()'
node scripts/mongo-backup.cjs restore --env prod --file "$prod_archive" --confirm RESTORE_immoweb_prod
docker compose --env-file deploy/config.prod.env -f compose.prod.yaml exec -T mongodb mongosh immoweb_prod --quiet --eval '
  if(db.estates.countDocuments({immowebCode: 950001}) !== 1) throw new Error("Prod restore failed");
  if(db.estates.countDocuments({immowebCode: 940001}) !== 0) throw new Error("Database isolation failed");
  print("PASS: production-mode database restored in an isolated CI container");
'
docker compose -f compose.dev.yaml exec -T mongodb mongosh immoweb_dev --quiet --eval '
  if(db.estates.countDocuments({immowebCode: 940001}) !== 1) throw new Error("Production-mode test modified dev data");
  print("PASS: development and production MongoDB instances are isolated");
'

echo "=== Backend live HTTP and GraphQL ==="
node scripts/test-server-smoke.cjs
echo "PASS: full MongoDB backup/verify/delete/restore integration tests"
