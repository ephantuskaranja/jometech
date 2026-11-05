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
APP_USER="${APP_USER:-jometech}"
cd "$APP_DIR"
BRANCH="${DEPLOY_BRANCH:-master}"

# Run as root by mistake: give every file back to the app user, then carry on as that user.
if [ "$(id -u)" -eq 0 ]; then
  echo "==> Running as root: giving $APP_DIR back to $APP_USER and continuing as $APP_USER"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  exec sudo -u "$APP_USER" -H DEPLOY_BRANCH="$BRANCH" "$APP_DIR/scripts/deploy.sh"
fi

# Files left owned by root (e.g. "npm install" run as root) make npm ci fail: fix them first.
# Needs the chown line in /etc/sudoers.d/jometech (docs/DEPLOY.md, step 8).
if [ -n "$(find "$APP_DIR" ! -user "$APP_USER" -print -quit)" ]; then
  echo "==> Some files aren't owned by $APP_USER: fixing"
  sudo -n /usr/bin/chown -R "$APP_USER:$APP_USER" "$APP_DIR" || {
    echo "!! Can't fix them. On the server run: sudo chown -R $APP_USER:$APP_USER $APP_DIR" >&2
    exit 1
  }
fi

# Settings from .env, read by Node exactly as the app reads them
# (bash can't load .env itself: values with spaces needn't be quoted there).
env_get() { node --env-file=.env -p "process.env['$1'] ?? ''"; }
DB_HOST="$(env_get DB_HOST)"; DB_PORT="$(env_get DB_PORT)"
DB_DATABASE="$(env_get DB_DATABASE)"; DB_USERNAME="$(env_get DB_USERNAME)"; DB_PASSWORD="$(env_get DB_PASSWORD)"
PORT="$(env_get PORT)"

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
