# Treasury mint timer (SABTC + SAETH)

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
