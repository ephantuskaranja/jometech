# Deploying Jome-Tech to the Ubuntu server

Once this is set up, **every push to `master` deploys itself**:

```
git push  →  GitHub Actions: tests on MySQL 8.0  →  (pass)  →  SSH to the server  →  scripts/deploy.sh
                                                                                     backup DB · git pull · npm ci
                                                                                     migrate · seed · restart · health check
```

If the tests fail, nothing is deployed. Watch progress in the repository's **Actions** tab.

| Piece | Where |
|---|---|
| App code | `/opt/jometech` (a git clone, owned by user `jometech`) |
| Settings | `/opt/jometech/.env` (never committed) |
| Runs as | systemd service `jometech` → `node src/server.js` on port 3000 (local only) |
| HTTPS | Caddy, `/etc/caddy/Caddyfile` → `127.0.0.1:3000` |
| Backups before each deploy | `/opt/jometech/storage/backups/` (last 10) |

Commands below are for Ubuntu 24.04, run as a user with `sudo` (or root). Lines starting with `#` are notes.

---

## One-time setup

### 1. Point the domain at the server

At your DNS provider, add an **A record**: e.g. `app.jometech.co.ke` → the server's IP. Caddy needs this to get the HTTPS certificate.

### 2. Install Node 24, git, Caddy and the firewall

```bash
sudo apt update && sudo apt install -y git curl ufw debian-keyring debian-archive-keyring apt-transport-https
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v                      # v24.x
# Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

If nginx already serves other sites on ports 80/443 (as on the Switch Reality server), don't install Caddy: use [deploy/nginx.conf](../deploy/nginx.conf) in step 9 instead. It only forwards requests to the app; a PHP-style config (`root …/public`, `index.php`, `fastcgi_pass`) returns **403** because there is no `index.php`.

### 3. Create the app user and folder

```bash
sudo adduser --disabled-password --gecos "Jome-Tech app" jometech
sudo mkdir -p /opt/jometech && sudo chown jometech:jometech /opt/jometech
```

### 4. Let the server pull from GitHub (read-only deploy key)

```bash
sudo -iu jometech
ssh-keygen -t ed25519 -f ~/.ssh/github -N "" -C "jometech-server"
printf 'Host github.com\n  IdentityFile ~/.ssh/github\n  IdentitiesOnly yes\n' >> ~/.ssh/config
cat ~/.ssh/github.pub
```

On GitHub: **repository → Settings → Deploy keys → Add deploy key**, paste the key, leave "Allow write access" **off**. Then, still as `jometech`:

```bash
git clone git@github.com:ephantuskaranja/jometech.git /opt/jometech     # answer "yes" to the fingerprint
exit
```

### 5. Database and user

```bash
sudo mysql
```
```sql
CREATE DATABASE jometech CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'jometech'@'localhost' IDENTIFIED BY 'a-long-random-password';
GRANT ALL PRIVILEGES ON jometech.* TO 'jometech'@'localhost';
EXIT;
```

The server runs MySQL 8.0, which reached end of life in April 2026. Upgrade to 8.4 LTS before go-live (plan §1).

### 6. Settings (.env)

```bash
sudo -iu jometech
cd /opt/jometech
cp .env.example .env
node -e "console.log(crypto.randomBytes(32).toString('hex'))"    # copy this for SESSION_SECRET
nano .env
```

Set:
```
NODE_ENV=production
PORT=3000
DB_USERNAME=jometech
DB_PASSWORD=the password from step 5
SESSION_SECRET=the long random value
ADMIN_NAME=Your Name
ADMIN_PHONE=07xx xxx xxx          # the first admin's login
ADMIN_PASSWORD=a temporary password   # you must change it at first login
```
```bash
chmod 600 .env
```

### 7. First install, database tables, first admin

Still as `jometech` in `/opt/jometech`:

```bash
npm ci --omit=dev
npm run db:migrate
npm run db:seed              # also creates the first admin from ADMIN_* in .env
exit
```

### 8. Run it as a service

```bash
sudo cp /opt/jometech/deploy/jometech.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jometech
curl http://127.0.0.1:3000/health        # {"ok":true,"db":"up"}
# Let the deploy script restart the app, and nothing else:
echo 'jometech ALL=(root) NOPASSWD: /usr/bin/systemctl restart jometech' | sudo tee /etc/sudoers.d/jometech
sudo chmod 440 /etc/sudoers.d/jometech
```

### 9. HTTPS

**Server already uses nginx:** follow the commands at the top of [deploy/nginx.conf](../deploy/nginx.conf) (copy, enable, `nginx -t`, reload, `certbot --nginx`), then skip to step 10.

**Otherwise, Caddy:**

```bash
sudo nano /opt/jometech/deploy/Caddyfile        # replace app.example.co.ke with your domain
sudo cp /opt/jometech/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Open `https://your-domain` and log in with `ADMIN_PHONE` and `ADMIN_PASSWORD`; you'll be asked to choose a new password. Then add everyone else under **Users**, and remove `ADMIN_PASSWORD` from `.env` (the seed only uses it while no admin exists). The login cookie only works over **https**, so logging in at `http://<ip>:3000` will not work in production. That is deliberate.

### 10. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

Port 3000 stays closed to the outside; only Caddy reaches it.

### 11. Automatic deploys from GitHub Actions

Make a key that GitHub Actions uses to log in as `jometech`:

```bash
sudo -iu jometech
ssh-keygen -t ed25519 -f ~/actions-key -N "" -C "github-actions"
cat ~/actions-key.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
cat ~/actions-key                       # the PRIVATE key: copy it into the secret below
rm ~/actions-key ~/actions-key.pub
exit
```

On GitHub: **repository → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the server's IP (or domain) |
| `DEPLOY_USER` | `jometech` |
| `DEPLOY_SSH_KEY` | the private key printed above (all lines, including `-----BEGIN…` and `-----END…`) |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan -t ed25519 <server IP>` run **from your PC** (one line starting with the IP) |

If SSH on the server doesn't use port 22, tell Claude and the workflow will be adjusted.

### 12. First automatic deploy

Push to `master` (or GitHub → Actions → **Test and deploy** → Run workflow). Both jobs should turn green, and the site shows the new version.

---

## Day to day

- **Deploy:** `git push`. Watch the **Actions** tab; the deploy step prints each stage.
- **Logs:** `journalctl -u jometech -f`
- **Restart by hand:** `sudo systemctl restart jometech`
- **Deploy by hand** (e.g. GitHub is down): `sudo -iu jometech /opt/jometech/scripts/deploy.sh`
- **Never edit files in `/opt/jometech` on the server.** The deploy pulls with `--ff-only` and stops if the server copy differs. Change code on your PC and push.

## When something goes wrong

- **Tests failed in Actions:** nothing was deployed. Fix on your PC, push again.
- **Deploy failed at "Updating the database":** the app may still be running the old code. Read the error in Actions, fix with a new migration, push.
- **Undo a bad release:** `git revert <commit>` on your PC and push. The code goes back; migrations that already ran stay, so undo a table change with a new migration.
- **Restore the database from before a deploy:**
  ```bash
  sudo systemctl stop jometech
  gunzip < /opt/jometech/storage/backups/pre-deploy-YYYYMMDD-HHMMSS.sql.gz | mysql -u jometech -p jometech
  sudo systemctl start jometech
  ```
