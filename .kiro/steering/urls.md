# Site URLs

Server IP: `160.153.187.39` (Port 80)

| Site | URL |
|------|-----|
| External / Public Site | http://160.153.187.39/public/index.html |
| Root Portal | http://160.153.187.39/ |
| Internal Staff Portal | http://160.153.187.39/staff/ |

## Backlog

- **Install SSMS locally** — Connect SQL Server Management Studio on the local dev machine to `160.153.187.39\SQLEXPRESS` so live database can be queried without RDP. Gives a full GUI for running SELECT statements, viewing pre-enrollment submissions, and managing live data. ✅ Done
- **SSL Certificate** — Once domain name is pointed to `160.153.187.39`, set up Let's Encrypt or Cloudflare for HTTPS. Removes "Not secure" browser warning.
