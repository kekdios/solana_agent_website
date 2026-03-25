# Systemd units for the droplet

## Website HTTP API (`solana-agent-website-api`)

Deploy copies `solana-agent-website-api.service` to `/var/www/solana_agent/systemd/` and the deploy script installs it to `/etc/systemd/system/`, runs `daemon-reload`, `enable`, and restarts the service.

Manual install / fix:

```bash
sudo cp /var/www/solana_agent/systemd/solana-agent-website-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solana-agent-website-api
systemctl is-active solana-agent-website-api
curl -sf http://127.0.0.1:3001/api/reserves | head -c 200
```

- **Listen:** `127.0.0.1:3001` (nginx should `proxy_pass` `/api/` here). Override with `API_PORT` in the unit or `EnvironmentFile`.
- **Logs:** `journalctl -u solana-agent-website-api -n 80 --no-pager`
- **Secrets:** optional `/etc/solana-agent-website/secrets` (same as treasury mint).

---

## Treasury mint timer (SABTC + SAETH)

Install once on the droplet (after deploy has copied files to `/var/www/solana_agent/systemd/`):

```bash
sudo cp /var/www/solana_agent/systemd/solana-agent-treasury-mint.service \
        /var/www/solana_agent/systemd/solana-agent-treasury-mint.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now solana-agent-treasury-mint.timer
systemctl list-timers solana-agent-treasury-mint.timer
```

- **Secrets:** the service uses `EnvironmentFile=-/etc/solana-agent-website/secrets` (same pattern as the website API). It must include `SOLANA_PRIVATE_KEY`, `TREASURY_SOLANA_ADDRESS`, and optionally `SOLANA_RPC_URL`, `SABTC_MINT_ADDRESS`, `SAETH_MINT_ADDRESS`.
- **Amounts:** edit `treasury-mint-schedule.json` in `/var/www/solana_agent/` (and redeploy or edit in place). The script reads that file each run.
- **Logs:** `journalctl -u solana-agent-treasury-mint.service -f`
- **Manual run:** `sudo systemctl start solana-agent-treasury-mint.service`

The **HTTP API** and the **treasury mint timer** are independent services; both can use `/etc/solana-agent-website/secrets` when present.
