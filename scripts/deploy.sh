#!/usr/bin/env bash
# Updates the app on the server. Run as the app user from the app folder:
#   /var/www/apps/jometech/scripts/deploy.sh
# GitHub Actions runs it after every push to master (.github/workflows/deploy.yml).
#
# 1. backs up the database (kept in storage/backups/, last 10)
# 2. pulls the new code (fast-forward only: stops if the server copy was edited by hand)
# 3. installs packages, runs migrations and seeds
# 4. restarts the app and checks it answers
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
BRANCH="${DEPLOY_BRANCH:-master}"

# DB_* settings from .env
set -a; . ./.env; set +a

echo "==> Backing up database $DB_DATABASE"
mkdir -p storage/backups
BACKUP="storage/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz"
MYSQL_PWD="$DB_PASSWORD" mysqldump --single-transaction --routines --no-tablespaces \
  -h "${DB_HOST:-127.0.0.1}" -P "${DB_PORT:-3306}" -u "$DB_USERNAME" "$DB_DATABASE" | gzip > "$BACKUP"
ls -1t storage/backups/pre-deploy-*.sql.gz | tail -n +11 | xargs -r rm --
echo "    saved $BACKUP"

echo "==> Pulling $BRANCH"
git fetch --quiet origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"
git log --oneline -1

echo "==> Installing packages"
npm ci --omit=dev --no-audit --no-fund

echo "==> Updating the database"
npm run --silent db:migrate
npm run --silent db:seed

echo "==> Restarting"
sudo /usr/bin/systemctl restart jometech
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/health" > /dev/null; then
    echo "==> Deployed and healthy"
    exit 0
  fi
  sleep 1
done
echo "!! The app did not answer /health after restarting. See: journalctl -u jometech -n 50" >&2
exit 1
