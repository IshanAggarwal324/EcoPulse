# Run EcoPulse on an Oracle Cloud Always Free server

One free Arm server runs the **backend, AI service, GenAI service and Redis**, with
**Caddy** in front giving it HTTPS. The website stays on **Vercel** and the database
stays on **MongoDB Atlas**. Nothing sleeps.

```
Browser (Vercel site) --HTTPS--> Caddy --> backend --> ai-service
                                                  \--> genai-service
                                                  \--> redis        (all private)
```

Files here: `docker-compose.yml`, `Caddyfile`, `*.env.example`, `update.sh`.

---

## Part 1: Create the server (Oracle console, in your browser)

1. Sign in to Oracle Cloud. Open the menu: **Compute > Instances > Create instance**.
2. **Name:** `ecopulse`.
3. **Image:** *Change image* > **Canonical Ubuntu 24.04** (the **aarch64 / ARM** build).
4. **Shape:** *Change shape* > **Ampere** > **VM.Standard.A1.Flex**.
   Set **2 OCPUs** and **12 GB memory**. This is the free maximum. Do not go higher.
5. **Networking:** keep the default network and make sure **Assign a public IPv4 address** is on.
6. **SSH keys:** choose **Generate a key pair for me** and **download the private key**
   (a `.key` file). Keep it safe; you cannot download it again.
7. **Boot volume:** the default is fine.
8. Click **Create**. When the status is **Running**, copy the **Public IP address**.

> If you see **"Out of capacity for shape VM.Standard.A1.Flex"**, free Arm servers are
> in short supply. Try again later (mornings work well) or pick another
> *Availability domain* in the same screen.

## Part 2: Open the web ports (Oracle console)

1. Open your instance > click the **Subnet** link > click the **Default Security List**.
2. **Add Ingress Rules** (two rules):
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **80**
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **443**

## Part 3: Get a free domain name

HTTPS needs a hostname. Free option: **DuckDNS**.

1. Go to https://www.duckdns.org and sign in.
2. Create a subdomain, e.g. `myecopulse` (you get `myecopulse.duckdns.org`).
3. Put your server's **Public IP** in the *current ip* box and click **update ip**.

That hostname is your `API_DOMAIN`.

## Part 4: Connect to the server (Windows PowerShell)

```powershell
# One-time: make the key file readable only by you (ssh refuses otherwise)
icacls "C:\path\to\your.key" /inheritance:r
icacls "C:\path\to\your.key" /grant:r "$($env:USERNAME):(R)"

ssh -i "C:\path\to\your.key" ubuntu@YOUR_PUBLIC_IP
```

## Part 5: Prepare the server (run these on the server)

```bash
# Open ports 80 and 443 in the server's own firewall
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save

# Install Docker (includes "docker compose")
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit            # log out, then ssh in again so the group change applies
```

After logging in again:

```bash
sudo apt-get install -y git
git clone https://github.com/IshanAggarwal324/EcoPulse.git
cd EcoPulse/deploy/oracle
```

## Part 6: Fill in the settings

```bash
cp .env.example .env
cp backend.env.example .env.backend
cp ai.env.example .env.ai
cp genai.env.example .env.genai
nano .env            # API_DOMAIN and INTERNAL_SERVICE_API_KEY
nano .env.backend    # copy the values from Render > backend > Environment
nano .env.ai         # from Render > AI service > Environment
nano .env.genai      # from Render > GenAI service > Environment
```

(`nano`: edit, then **Ctrl+O**, Enter to save, **Ctrl+X** to exit.)

Important:
- Use the **same** `INTERNAL_SERVICE_API_KEY`, JWT secrets and `MONGO_URI` as on Render.
- Use the **new** (sepolia-v2) contract addresses.
- Never commit these files. They are git-ignored.

## Part 7: Start everything

```bash
docker compose up -d --build
```

The first build takes roughly 10-20 minutes (TensorFlow is a large download). Then:

```bash
docker compose ps                  # every service should say "running" / "healthy"
docker compose logs -f backend     # Ctrl+C to stop watching
curl https://YOUR_API_DOMAIN/api/health
```

You should see `{"status":"OK", ...}`. If HTTPS fails, check the DuckDNS IP and that
ports 80/443 are open (Parts 2 and 5), then `docker compose logs caddy`.

## Part 8: Point the website at the new server (Vercel)

1. Vercel > project > **Settings > Environment Variables**: change
   `VITE_API_URL` and `VITE_SOCKET_URL` so they use `YOUR_API_DOMAIN` instead of
   `ecopulse-83lb.onrender.com` (keep the same path suffix as today, e.g. `/api/v1`).
2. Update `ecopulse/vercel.json`: in the Content-Security-Policy `connect-src`,
   replace both Render entries (`https://` and `wss://`) with your domain.
   Commit and push.
3. **Redeploy** on Vercel.

Rollback is easy: set the two variables back to the Render URL and redeploy.

## Part 9: Retire Render (only after everything works)

While both stacks run, both backends do background jobs against the same database.
Once the site works through the new server, **suspend** the three Render services.

## Day-to-day

```bash
cd ~/EcoPulse/deploy/oracle
bash update.sh                     # pull the latest code and restart what changed
docker compose logs -f --tail=100 backend
docker compose restart ai-service
```

## Good to know

- Keep the server inside **2 OCPU / 12 GB** so it stays free.
- Oracle may reclaim Always Free servers that sit idle for a long time. Upgrading the
  account to *Pay As You Go* (you stay free inside the limits) avoids that.
- Keep your `.env*` files backed up somewhere safe; they are not in git.
