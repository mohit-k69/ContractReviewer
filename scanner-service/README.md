# Contract scanner service (ClamAV on Google Cloud Run)

A small HTTPS API in front of a **real ClamAV daemon**. The ContractReviewer backend (on Vercel) sends each uploaded
document here; the document is scanned **in memory** and the verdict returned. Nothing is stored, and file contents and
file names are never logged.

```
Vercel backend --HTTPS + bearer token--> scanner-api (Cloud Run, :8080) --localhost:3310--> clamav (sidecar)
```

| File | Purpose |
| --- | --- |
| `service.yaml` | **Production**: always-ready (1 warm instance, CPU always allocated). |
| `service.preview.yaml` | **Preview / testing**: scales to zero, request-based billing. Separate service and secret. |
| `Dockerfile`, `src/` | The scanning API (no dependencies). |
| `clamav/Dockerfile` | Mirrors the official ClamAV image into *your* Artifact Registry. |
| `scripts/smoke.sh` | Post-deployment check, including a real EICAR antivirus test. |

## 1. How access is protected

Three independent layers. Read this before deploying.

| Layer | Setting | Effect |
| --- | --- | --- |
| **Cloud Run IAM (Invoker)** | `allUsers` has `roles/run.invoker` (step 7) | Anyone on the internet can *reach* the HTTPS endpoint. This is required because Vercel cannot present a Google identity token. It is **not** what protects `/scan`. |
| **Application token** | `SCAN_TOKEN` (Secret Manager) | `POST /scan` returns **401** unless it carries `Authorization: Bearer <token>`. Checked in constant time **before the request body is read**. The API refuses to start without a token of at least 24 characters. |
| **Network** | ClamAV sidecar declares **no `ports`** | Cloud Run routes only the `scanner-api` port (8080). ClamAV's TCP port 3310 is never published; the two containers talk over localhost inside the instance. |

`GET /health` and `GET /ready` are unauthenticated by design; they reveal only whether the process and ClamAV are up.
Unauthenticated callers can therefore send requests, but without the token they receive 401 and nothing is scanned.
`maxScale` caps how many instances abuse could ever cost you.

Stronger option for later (not implemented): have Vercel present a Google-signed identity token (Vercel OIDC + Workload
Identity Federation) and remove `allUsers`. That needs application changes, so it is not part of this setup.

## 2. API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness of the API process. |
| `GET /ready` | none | `200` only when ClamAV answers `PING` (signatures loaded); otherwise `503`. |
| `POST /scan` | `Bearer <SCAN_TOKEN>` | Body = raw file bytes (max 20 MB). Optional `X-Content-SHA256`. |

`POST /scan` answers:

| HTTP | `status` | Meaning |
| --- | --- | --- |
| 200 | `clean` | ClamAV scanned the bytes and found nothing (`engine`, `engineVersion`, `sha256`, `scannedBytes`). |
| 200 | `blocked` | ClamAV matched a signature (`signature`). |
| 502 / 400 / 500 | `error` | The scan did not complete. **Never clean.** |
| 503 | `unavailable` | ClamAV not ready or unreachable, or the service is busy. **Never clean.** |
| 401 / 413 | `error` | Wrong or missing token / larger than 20 MB. |

## 3. Prerequisites

* A Google Cloud project with **billing enabled**, and the `gcloud` CLI (or **Cloud Shell**, which has it).
* Either you are the project **Owner**, or you hold: Cloud Run Admin, Service Usage Admin, Service Account Admin,
  Secret Manager Admin, Artifact Registry Admin and Cloud Build Editor (Console: *IAM & Admin → IAM*).
* Docker is **not** needed: images are built by Cloud Build.
* Choose a **Tier 1** region (cheapest tier), ideally close to your Vercel function region (Vercel's default is US
  East): for example `us-east1` or `us-central1`.

## 4. Setup, step by step

Run the commands from the **repository root**. Console equivalents are given where they exist.

### Step 1 — Project and variables

```bash
gcloud auth login
export PROJECT_ID="your-project-id"
export REGION="us-east1"
gcloud config set project "$PROJECT_ID"
export SA="contract-scanner-sa@${PROJECT_ID}.iam.gserviceaccount.com"
```

### Step 2 — Enable the APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com
```

*Console: **APIs & Services → Library**, search each name (Cloud Run Admin API, Artifact Registry API, Cloud Build API,
Secret Manager API, Identity and Access Management API) and click **Enable**.*

### Step 3 — Dedicated service account and secrets (least privilege)

The service runs as its own service account. Its **only** permission is *Secret Manager Secret Accessor* on the
secrets it needs. It gets no project-level role, and it does not use the default Compute Engine account (which has
broad rights).

```bash
# 3a. The runtime identity
gcloud iam service-accounts create contract-scanner-sa \
  --display-name="Contract scanner (Cloud Run runtime)" \
  --description="Runtime identity of the ClamAV scanning service. Secret Accessor on its own secrets only."

# 3b. The shared tokens. The values are generated and stored without being printed.
#     Use a different token for preview and production. Create only the one(s) you are deploying now.
openssl rand -hex 32 | gcloud secrets create contract-scanner-token-preview \
  --replication-policy=automatic --data-file=-
openssl rand -hex 32 | gcloud secrets create contract-scanner-token \
  --replication-policy=automatic --data-file=-

# 3c. Grant Secret Accessor on each secret (the secret, not the project) to the runtime service account
gcloud secrets add-iam-policy-binding contract-scanner-token-preview \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding contract-scanner-token \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
```

Let your own user deploy services that run as this account (skip if you are Owner):

```bash
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="user:YOU@example.com" --role="roles/iam.serviceAccountUser"
```

Verify that the account holds **no project-level roles**. The next command must print nothing:

```bash
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" --filter="bindings.members:serviceAccount:${SA}" --format="value(bindings.role)"
```

*Console: **IAM & Admin → Service Accounts → Create service account** (name `contract-scanner-sa`, skip the optional
"grant access" step). **Security → Secret Manager → Create secret**, then open the secret → **Permissions → Grant
access**, principal = the service account, role = **Secret Manager Secret Accessor**.*

### Step 4 — Artifact Registry

```bash
gcloud artifacts repositories create contract-scanner \
  --repository-format=docker --location="$REGION" --description="Contract scanner images"
```

*Console: **Artifact Registry → Create repository**, name `contract-scanner`, format Docker, region = your region.*

### Step 5 — Build the two images with Cloud Build

```bash
export REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/contract-scanner"
gcloud builds submit scanner-service        --tag "${REPO}/scanner-api:v1"
gcloud builds submit scanner-service/clamav --tag "${REPO}/clamav:1.4"
```

Cloud Run pulls both images from your Artifact Registry (the ClamAV image is mirrored there on purpose, so the version
you run is the one you built).

If a build fails with *permission denied*, your project uses the Compute Engine default account for builds. Grant it
the build role (this is the **build** account, not the runtime service account):

```bash
gcloud builds get-default-service-account      # prints projects/.../serviceAccounts/<ACCOUNT>
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:<ACCOUNT from the line above>" --role="roles/cloudbuild.builds.builder"
```

### Step 6 — Deploy

The YAML files contain placeholders and **no secrets** (the token is a Secret Manager reference). Render and deploy.

**Preview / testing** (scales to zero):

```bash
sed -e "s/__PROJECT_ID__/${PROJECT_ID}/g" -e "s/__REGION__/${REGION}/g" \
    -e "s/__API_TAG__/v1/g" -e "s/__CLAMAV_TAG__/1.4/g" \
    scanner-service/service.preview.yaml > /tmp/scanner.preview.rendered.yaml
gcloud run services replace /tmp/scanner.preview.rendered.yaml --region="$REGION"
export SERVICE="contract-scanner-preview"
```

**Production** (always ready):

```bash
sed -e "s/__PROJECT_ID__/${PROJECT_ID}/g" -e "s/__REGION__/${REGION}/g" \
    -e "s/__API_TAG__/v1/g" -e "s/__CLAMAV_TAG__/1.4/g" \
    scanner-service/service.yaml > /tmp/scanner.rendered.yaml
gcloud run services replace /tmp/scanner.rendered.yaml --region="$REGION"
export SERVICE="contract-scanner"
```

The deployment waits for ClamAV to pass its startup probe (up to 10 minutes) before the revision becomes ready.
`replace` rejects an invalid file before changing anything.

### Step 7 — Let Vercel reach the service (Cloud Run Invoker IAM)

```bash
gcloud run services add-iam-policy-binding "$SERVICE" --region="$REGION" \
  --member="allUsers" --role="roles/run.invoker"
```

*Console: **Cloud Run → your service → Security** tab → Authentication → **Allow public access** → Save.*

This only lets requests *arrive*; `POST /scan` is still refused without `SCAN_TOKEN` (section 1).

**If it fails with "IAM policy update failed"**: your organisation enforces *Domain Restricted Sharing*, which forbids
`allUsers`. Instead, uncomment `run.googleapis.com/invoker-iam-disabled: "true"` in the service's YAML, redeploy, and do
not grant `allUsers`. The bearer token still protects `/scan`.

### Step 8 — Verify

```bash
export SCAN_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo "$SCAN_URL"

# ClamAV's port must not be published: exactly ONE containerPort (8080, scanner-api) may appear
gcloud run services describe "$SERVICE" --region="$REGION" --format=export | grep -n "containerPort"
```

Then run the **EICAR smoke test** (section 7).

### Step 9 — Vercel environment variables (server-side only)

In **Vercel → Project → Settings → Environment Variables**:

| Name | Environment | Value |
| --- | --- | --- |
| `CLAMAV_SCAN_URL` | Preview | `https://<preview service URL>/scan` (the URL from step 8, plus `/scan`) |
| `CLAMAV_SCAN_TOKEN` | Preview | the **preview** token (mark as *Sensitive*) |
| `CLAMAV_SCAN_URL` | Production | `https://<production service URL>/scan` |
| `CLAMAV_SCAN_TOKEN` | Production | the **production** token (mark as *Sensitive*) |

`SESSION_SECRET` stays as it is. Do **not** prefix these names with `VITE_` or `NEXT_PUBLIC_` (that would publish
them to the browser). Do not set `CLAMAV_HOST`, and do not set `ALLOW_DEMO_SCANNER` (it is ignored on Vercel).

To copy a token into Vercel without printing it, open **Secret Manager → the secret → Versions → ⋮ → View secret
value**, or, on macOS: `gcloud secrets versions access latest --secret=contract-scanner-token-preview | pbcopy`.
Clear your clipboard afterwards.

Vercel only applies new variables to **new deployments**, so push a commit (or Redeploy with the build cache off).
Then open `https://<your-vercel-app>/api/health?probe=1`. Expected:

```json
{ "antivirus": { "mode": "clamav-service", "configured": true, "genuine": true, "ready": true } }
```

`ready: false` on Preview usually means the scale-to-zero service is cold; see section 6.

## 5. Costs

> **Treat these as estimates.** I could not open Google's pricing page from the build environment; the unit prices
> below come from secondary summaries of Google's Tier 1 (for example `us-central1`) list prices. Confirm them in the
> [Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator) before relying on them. Tier 2
> regions cost more. One month = 30 days = 2,592,000 seconds.

Each instance runs two containers: scanner-api (1 vCPU, 1 GiB) + ClamAV (2 vCPU, 4 GiB) = **3 vCPU and 5 GiB**.

| Configuration | How it is billed | Estimated cost |
| --- | --- | --- |
| **Production** `service.yaml`: 1 warm instance, CPU always allocated | Instance-based: US$0.000018 per vCPU-s, US$0.000002 per GiB-s, around the clock. 3 × 2,592,000 × 0.000018 = $139.97, plus 5 × 2,592,000 × 0.000002 = $25.92 | **about US$166 / month**, about US$161 after the monthly instance-based free tier (240,000 vCPU-s, 450,000 GiB-s; one per billing account) |
| Extra instances under load (`maxScale: 3`) | US$0.23 per instance-hour (3 × 0.000018 + 5 × 0.000002 = $0.000064/s) | Worst case if all 3 run all month: about US$500. Normally far less. |
| **Preview** `service.preview.yaml`: scales to zero | Request-based: US$0.000024 per vCPU-s, US$0.0000025 per GiB-s, only while an instance starts or serves requests: about US$0.30 per billed instance-hour | **US$0 to a few dollars / month** for light testing. The free tier (180,000 vCPU-s, 360,000 GiB-s) covers about 16 billed instance-hours a month. |
| Everything else | Artifact Registry storage (about 0.5 GB), Secret Manager (a few versions), Cloud Build (free tier), ingress traffic | Under US$1 |

A middle option, **one warm instance but CPU throttled** (`minScale: 1`, `cpu-throttling: "true"`), would idle at about
US$52 / month plus active time. I deliberately did **not** make it a configuration, because throttled CPU stops the
signature updater from running in the background (see below).

## 6. Trade-offs: cold start, ClamAV readiness, cost

ClamAV must load its whole signature database before it can scan anything, and that takes a while: this is the cold
start. I have not measured it. Plan for **minutes, not seconds**, and measure it on your first deployment (the smoke
test prints how long it waited).

| | Production (always ready) | Preview (scale to zero) |
| --- | --- | --- |
| First upload after a quiet period | Fast: ClamAV is already loaded | **Slow**: a new instance must start and load signatures |
| What the user sees during a cold start | n/a | The service answers `503` until ready, or the request outlives the 25 s client timeout. The app shows **"Security scanning is unavailable"** or **"Security scan failed"**. Nothing is analysed, and **nothing is ever called clean** |
| Signature freshness | The updater (`freshclam`) runs continuously: current | Refreshed when an instance starts. A long-lived warm instance can run on older signatures between starts |
| Cost | About US$166 / month, always | About US$0 to a few dollars |

What this means in practice:

* **Antivirus protection is not reduced to save money.** Both configurations run the same ClamAV image, the same 4 GiB,
  the same size limit, and the same fail-closed service code (which cannot return `clean` unless ClamAV said so). The
  cost saving is only in availability and in how fresh the signatures of a long-lived instance can be.
* **Preview**: wake the service before testing, because the first request after idle fails closed by design:

  ```bash
  until curl -fsS -m 15 "$SCAN_URL/ready" >/dev/null; do echo "waiting for ClamAV..."; sleep 5; done
  ```

  then check `https://<vercel-app>/api/health?probe=1` shows `ready: true`.
  I did not raise the Vercel client timeout, because the application's 30 s upload guard would cut it off anyway;
  changing that is a code change I have not made.
* **Production**: the always-on instance is what makes the first upload fast *and* keeps signatures current. It is
  the only configuration I recommend for real users.
* **Do not lower ClamAV's memory below 4 GiB** to save money. ClamAV needs over 1 GiB for its signatures, roughly twice
  that while it reloads an updated database, and Cloud Run's in-memory file system counts the signature files too.
  An undersized container is killed by the platform, which would show up as intermittent "unavailable" errors.
* **Optional hardening, not implemented (needs your approval)**: make the API refuse to scan, and report
  `unavailable`, when the signature database in `VERSION` is older than a threshold (for example 7 days). It would
  turn "a stale preview instance" from a silent weakness into a visible failure.

## 7. EICAR smoke test (real ClamAV)

[EICAR](https://www.eicar.org/) is a harmless test string that every antivirus recognises. A correct deployment
**blocks** it. `scripts/smoke.sh` runs everything below and exits non-zero on the first failure. The token is read from
your environment and never printed; the EICAR string is piped, never written to a file (so your laptop's antivirus
does not quarantine it).

```bash
export SCAN_TOKEN="$(gcloud secrets versions access latest --secret=contract-scanner-token-preview)"   # or contract-scanner-token
WAIT_SECONDS=600 ./scanner-service/scripts/smoke.sh        # uses $SCAN_URL from step 8
unset SCAN_TOKEN
```

It checks, in order:

1. `/ready` becomes `ready` and names a **ClamAV** engine (it waits for a cold start).
2. An ordinary sentence is `clean`, scanned by ClamAV.
3. The **EICAR** string is `blocked` with a signature name.
4. A wrong token and a missing token both return **401**.
5. Port **3310** is not reachable from the internet.

Manual equivalent for the key check:

```bash
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' | \
  curl -sS -X POST "$SCAN_URL/scan" -H "Authorization: Bearer $SCAN_TOKEN" \
       -H 'Content-Type: application/octet-stream' --data-binary @-
# expected: {"status":"blocked","signature":"Win.Test.EICAR_HDB-1" (the name varies by signature version),"engine":"ClamAV",...}
```

Finally test through the application: upload a harmless contract in the deployed app (it must be analysed), then a
text file containing the EICAR string (it must show **Threat detected — document blocked**).

## 8. Operations

* **Logs** (outcome, size, duration only; never contents, names or tokens):
  `gcloud run services logs read "$SERVICE" --region="$REGION" --limit=50`
* **Rotate the token**: add a version (`openssl rand -hex 32 | gcloud secrets versions add contract-scanner-token --data-file=-`),
  deploy a new revision so instances re-read `latest` (re-run step 6), then update `CLAMAV_SCAN_TOKEN` in Vercel and
  redeploy it. Until both sides match, uploads fail closed with "rejected this application’s credentials".
* **Update ClamAV**: rebuild the `clamav` image (step 5 with a new tag, for example `1.4-2`), change `__CLAMAV_TAG__`,
  and re-run step 6. Do this regularly: engine releases include security fixes.
* **Remove everything**: `gcloud run services delete "$SERVICE" --region="$REGION"`, delete the secrets, the
  Artifact Registry repository and the service account.

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Revision never becomes ready | ClamAV did not start: read the `clamav` container logs. Usually memory (do not go below 4 GiB) or no outbound access for `freshclam`. |
| `/ready` is 503 for a long time | Signatures are still loading (cold start) or ClamAV crashed. |
| App says "rejected this application’s credentials" | `CLAMAV_SCAN_TOKEN` in Vercel differs from the secret. |
| App says "could not be reached" | Wrong `CLAMAV_SCAN_URL`, or step 7 not done (Cloud Run answers 403). |
| `IAM policy update failed` in step 7 | Domain Restricted Sharing: use `invoker-iam-disabled` (step 7). |
| `Permission denied on secret` at deploy | Step 3c missing, or the service account in the YAML is not the one that was granted access. |

## 10. What has and has not been verified

* **Verified by automated tests** (`npm test`): the API's authentication, size limit, readiness gating, timeout and error
  handling, that it never answers `clean` when ClamAV is down, slow or confused, that nothing is written to disk or
  logged, and the Vercel-side client's handling of every outcome. They use a ClamAV *protocol test double*, not real
  ClamAV.
* **Not verified**: nothing here has been deployed. The YAML follows Cloud Run's multi-container format but has not been
  run against Google Cloud; `gcloud run services replace` validates it before applying. Real ClamAV behaviour (start
  time, memory) is confirmed only by deploying and running `scripts/smoke.sh`. I could not open Google's documentation
  or pricing pages from the build environment, so prices and a few platform details come from search summaries.
