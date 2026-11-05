# Contract scanner service (ClamAV on Cloud Run)

A small HTTPS API in front of a **real ClamAV daemon**. The ContractReviewer backend (on Vercel) sends each uploaded
document here; the document is scanned in memory and the verdict returned. Nothing is stored and file contents and
names are never logged.

```
Vercel backend --HTTPS + bearer token--> scanner-api (Cloud Run) --localhost:3310--> clamav sidecar
```

ClamAV's port is **never exposed**: the sidecar container declares no `ports` and the two containers talk over
localhost inside the instance. Only the API container's HTTPS port is reachable.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness of the API process. |
| `GET /ready` | none | `200` only when ClamAV answers `PING` (signatures loaded); otherwise `503`. Used as the startup probe. |
| `POST /scan` | `Authorization: Bearer <SCAN_TOKEN>` | Body = raw file bytes (max 20 MB). Optional `X-Content-SHA256`. |

`POST /scan` responses (JSON):

| HTTP | `status` | Meaning |
| --- | --- | --- |
| 200 | `clean` | ClamAV scanned the bytes and found nothing. Includes `engine`, `engineVersion`, `sha256`, `scannedBytes`. |
| 200 | `blocked` | ClamAV matched a signature (`signature`). |
| 502 / 400 / 500 | `error` | The scan did not complete (`scan_failed`, `scan_timeout`, `hash_mismatch`, `empty_body`, …). **Never clean.** |
| 503 | `unavailable` | ClamAV not ready, unreachable, or the service is busy. **Never clean.** |
| 401 | `error` | Missing or wrong token. |
| 413 | `error` | Larger than 20 MB. |

The API refuses to start unless `SCAN_TOKEN` is set to a secret of at least 24 characters.

## Deploy

```bash
# 1. Shared secret (also given to Vercel as CLAMAV_SCAN_TOKEN)
openssl rand -hex 32 | gcloud secrets create contract-scanner-token --data-file=-

# 2. Build and push the API image
gcloud artifacts repositories create contract-scanner --repository-format=docker --location=REGION   # once
gcloud builds submit scanner-service --tag REGION-docker.pkg.dev/PROJECT_ID/contract-scanner/contract-scanner:v1

# 3. Edit the placeholders in service.yaml, grant the service account access to the secret, deploy
gcloud run services replace scanner-service/service.yaml --region REGION

# 4. Verify with a real EICAR test (needs the token)
SCAN_URL=https://<service-url> SCAN_TOKEN=<token> scanner-service/scripts/smoke.sh
```

Then, in the Vercel project (Preview and Production), set **server-side** variables (never `VITE_*`):

| Variable | Value |
| --- | --- |
| `CLAMAV_SCAN_URL` | `https://<service-url>/scan` |
| `CLAMAV_SCAN_TOKEN` | the same secret |

Check `GET /api/health?probe=1` on the Vercel deployment: `antivirus` should show `mode: "clamav-service"`,
`genuine: true`, `ready: true`.

## Notes

* Run `npm test` in this folder (or the repository root) for the protocol/auth/limit tests. They use a ClamAV protocol
  test double; the EICAR check in `scripts/smoke.sh` is the end-to-end proof against real ClamAV after deployment.
* Cost/availability: `minScale: 1` and 4 GiB for the sidecar keep ClamAV warm; signatures update in the background.
