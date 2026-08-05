---
description: Compare the OAuth scopes your credentials hold against what the MCP catalogue needs.
allowed-tools: Bash(node:*), Bash(gcloud:*)
---

Diagnose "403 insufficient scope" before it happens.

Run the doctor and read its ADC lines — they already diff the granted scopes against every scope
in the catalogue:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/google-doctor.mjs" --offline
```

If the `ADC scopes` line reports missing scopes, the fix is always a fresh
`gcloud auth application-default login` with the **full** scope list — scopes are not additive
across logins, so re-running with only the missing ones would drop the others:

```bash
gcloud auth application-default login \
  --scopes=openid,\
https://www.googleapis.com/auth/cloud-platform,\
https://www.googleapis.com/auth/analytics.readonly,\
https://www.googleapis.com/auth/adwords,\
https://www.googleapis.com/auth/webmasters.readonly,\
https://www.googleapis.com/auth/bigquery
```

Confirm with the user before running it — it opens a browser login and replaces the existing
credential. Add `--no-launch-browser` inside a container.

Which scope belongs to what:

| Scope | Needed by |
|---|---|
| `cloud-platform` | gcloud, Cloud Run, GKE, Spanner, AlloyDB, Bigtable, resource-manager |
| `bigquery` | BigQuery, MCP Toolbox |
| `analytics.readonly` | Google Analytics |
| `adwords` | Google Ads |
| `webmasters.readonly` | Search Console |
| `sqlservice.admin` | Cloud SQL |
| `compute` | Compute Engine |

`gws` keeps its own separate OAuth token in the system keyring — it is unaffected by ADC. Check it
with `gws auth status`.
