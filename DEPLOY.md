# Deploying to your VPS (with PostgreSQL)

This guide assumes a Linux VPS (Ubuntu/Debian) with PostgreSQL already installed. Commands are run over SSH on the VPS unless stated otherwise.

## 1. Install Node.js 22+ on the VPS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v22.x or newer
```

## 2. Create the PostgreSQL database and user

```bash
sudo -u postgres psql
```

Inside psql (pick your own strong password):

```sql
CREATE USER videoreview WITH PASSWORD 'CHANGE-ME-strong-password';
CREATE DATABASE videoreview OWNER videoreview;
\q
```

Your connection string is then:

```
postgres://videoreview:CHANGE-ME-strong-password@localhost:5432/videoreview
```

## 3. Copy the project to the VPS

From your Windows PC (PowerShell), copy the project folder **except** `node_modules` and `data.sqlite`:

```powershell
scp -r "f:\video reviewer platform\*" youruser@YOUR_VPS_IP:/home/youruser/videoreview/
```

(Or push the folder to a private GitHub repo and `git clone` it on the VPS.)

Then on the VPS:

```bash
cd ~/videoreview
rm -rf node_modules data.sqlite*   # fresh install; DB lives in Postgres there
npm install
```

## 4. Create the .env file and test-run it once

The app reads its settings from a `.env` file (same pattern as your other project).
On the VPS, in the project folder:

```bash
cd ~/videoreview
cp .env.example .env
nano .env    # fill in the real DATABASE_URL password and a strong ADMIN_PASSWORD
```

`.env` contents look like:

```
DATABASE_URL=postgres://gagan:YOUR_DB_PASSWORD@localhost:5432/videoreview
ADMIN_PASSWORD=pick-a-strong-admin-password
PORT=4400
```

Then test:

```bash
npm start
```

You should see `Storage: PostgreSQL` and the tables are created automatically.
Visit `http://YOUR_VPS_IP:4400/admin` to check, then stop it with Ctrl+C.

(`.env` is listed in `.gitignore`, so it never ends up in Git — each machine keeps its own.)

## 5. (Optional) Copy your existing local data into the VPS database

If you created tasks/submissions on your PC that you want to keep, run **on your PC**
(replace the IP; this needs Postgres to accept remote connections, or run the script on
the VPS after copying `data.sqlite` there too):

```powershell
node scripts/migrate-to-postgres.js "postgres://videoreview:PASSWORD@YOUR_VPS_IP:5432/videoreview"
```

Easiest alternative: copy `data.sqlite` to the VPS alongside the project and run the
same command there with `localhost` in the URL. The script preserves all IDs, so
existing task links keep working, and it skips rows that already exist.

## 6. Run it permanently with systemd

```bash
sudo tee /etc/systemd/system/videoreview.service > /dev/null <<'EOF'
[Unit]
Description=Video Reviewer Platform
After=network.target postgresql.service

[Service]
User=youruser
WorkingDirectory=/home/youruser/videoreview
ExecStart=/usr/bin/node --env-file-if-exists=.env server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now videoreview
sudo systemctl status videoreview
```

## 7. Put nginx + HTTPS in front (recommended)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/videoreview > /dev/null <<'EOF'
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/videoreview /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com   # free HTTPS certificate
```

Point your domain's DNS A record at the VPS IP first. After this, your task links look like
`https://yourdomain.com/t/TASK_ID` and the admin is at `https://yourdomain.com/admin`.

If you have no domain, users can use `http://YOUR_VPS_IP` (set `server_name _;`), but a
domain + HTTPS looks far more trustworthy to participants.

## 8. Ongoing

- **Backups:** `pg_dump videoreview > backup.sql` (schedule it with cron).
- **Update the app:** copy changed files to the VPS, then `sudo systemctl restart videoreview`.
- **Logs:** `journalctl -u videoreview -f`.

## How storage switching works

`server.js` picks the database automatically:

- `DATABASE_URL` set → PostgreSQL (the VPS setup above)
- `DATABASE_URL` not set → local `data.sqlite` file (your PC, for testing)

So you can keep developing/testing locally exactly as before, while production data
lives safely in PostgreSQL on the VPS.
