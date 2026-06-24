# PTG+ Relay — Render Quick Start

5-minute deploy to Render.com free tier.

## What You Get

After this deploy, you'll have a public URL like:
- `wss://ptgplus-relay-xxxx.onrender.com` (WebSocket signaling)
- ❌ No TCP tunnel port (Render free only exposes one port)

PTG+ will use this relay for:
- ✅ Friend list + presence (Phase 1: UPnP works without relay)
- ✅ World invites + chat
- ✅ Hole-punch coordination (Phase 2)
- ❌ Relay tunnel fallback (Phase 3 — needs port 8081, not available on Render)

**Success rate without tunnel: ~85-90%** (works for most home internet users).
If you need 100% success rate, deploy on Oracle Cloud Always Free instead.

## Steps

### 1. Create a GitHub repo

1. Go to https://github.com/new
2. Repository name: `ptg-relay`
3. Set to **Public** (Render free tier requires public repo)
4. Click **Create repository**
5. Upload all files from this folder:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - `Dockerfile`
   - `README.md`
   - `.gitignore`
6. Click **Commit changes**

### 2. Sign up for Render

1. Go to https://render.com
2. Click **Get Started** → sign up with GitHub (no credit card needed)

### 3. Deploy

1. Click **New +** → **Blueprint**
2. Select your `ptg-relay` repo
3. Render detects `render.yaml` automatically
4. Click **Apply**
5. Wait ~2-3 minutes for build + deploy
6. Once deployed, click on the service → copy the URL
   (e.g. `https://ptgplus-relay-abcd.onrender.com`)

### 4. Verify

Visit your URL + `/health` in a browser:
```
https://ptgplus-relay-abcd.onrender.com/health
```
You should see:
```json
{"status":"ok","connected":0,"activeTunnels":0,"uptime":0.5}
```

### 5. Update PTG+ config

In Minecraft, with PTG+ installed:

1. Open PTG+ Friends screen (F7)
2. Click the gear icon (or use the config screen via ModMenu)
3. Set **Relay URL** to: `wss://ptgplus-relay-abcd.onrender.com`
   (Replace with your actual URL)
4. Make sure **Tunnel Enabled** is OFF (default — Render doesn't expose port 8081)
5. Save config

Or edit `config/ptgplus.json` directly:
```json
{
  "relayUrl": "wss://ptgplus-relay-abcd.onrender.com",
  "tunnelEnabled": false
}
```

### 6. Distribute the mod

Share `ptgplus-0.8.1.jar` with your friends. They also need to set the same
relay URL in their PTG+ config (or you can rebuild the jar with the default
URL baked in — just ask me).

## Free Tier Limitations

- **Sleeps after 15 min idle** — PTG+'s 30-second auto-reconnect handles this gracefully
- **750 hours/month** of runtime (plenty for casual use)
- **One public port only** — no TCP tunnel (Phase 3 fallback)
- **Single region (Oregon)** — slightly higher latency for non-US players

## Troubleshooting

**Build fails on Render:**
- Check that `package.json` was uploaded with `"type": "module"`
- Verify Node.js version — Render defaults to a recent LTS, which is fine

**Health check returns 502:**
- Wait another 1-2 minutes — Render can be slow to route traffic initially
- Check Render logs for the service

**PTG+ can't connect:**
- Make sure URL starts with `wss://` (not `https://` or `ws://`)
- Try visiting the URL in a browser — you should see "PTG+ Relay Server" text

**Connection drops after 15 min:**
- That's Render's idle sleep — PTG+ auto-reconnects in 30 seconds
- To keep it awake: set up a free ping on https://uptimerobot.com
  pointing at `https://your-url.onrender.com/health` every 10 minutes
