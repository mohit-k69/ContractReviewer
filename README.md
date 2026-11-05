# ContractReviewer

Upload or paste a **Freelance / Independent Contractor Agreement** and get an evidence-backed review report:
what the contract says, what is risky for the contractor, what is missing, what is ambiguous or contradictory,
and what to clarify before signing.

## How it works

```
paste / upload ─► security inspection ─► extraction ─► normalization ─► contract understanding ─► review report
                  (Phase 1: AV, format,   (Phase 2A)    (Phase 2B)        (Phase 2C: Gemini or       (Phase 3: rules)
                   injection checks)                                       built-in fallback,
                                                                           word-for-word evidence)
```

* **Phase 3 – review report** (`src/server/risk/`): a deterministic, explainable rule engine turns the verified
  understanding into findings across payment, scope, termination, IP, liability & indemnification, confidentiality,
  non-compete / exclusivity / non-solicitation, and dispute resolution / governing law.
  * Every finding has a severity (High / Medium / Low), a plain-language explanation, why it matters to the
    contractor, verified clause quotes, a practical question or negotiation suggestion, and confidence + uncertainty.
  * Four kinds are kept distinct: **contract risk**, **missing provision** (never has evidence), **ambiguous term**
    and **contradictory provisions** (carried over from Phase 2C).
  * Overall *review priority* = the highest severity among findings. There is no numeric score and no claim about
    legal enforceability. Only evidence that passed word-for-word verification is ever shown.
  * "Missing" claims are only made when the whole document was analyzed, and are cross-checked against the actual text.
* **Contractor intelligence** (understanding schema + risk rules) covers the areas below. Each is extracted as facts
  (status, summary, verbatim evidence) and then checked by deterministic rules:
  worker-classification indicators (assessed together, never conclusive alone, jurisdiction-aware), data protection &
  security (missing terms are only flagged when the contract involves data), insurance (no assumption that every
  contractor needs every cover), subcontracting & delegation, tax (no assumption about any country's rules),
  renewal, and warranties.
* **Cross-clause analysis** compares related terms across clauses (payment deadline vs acceptance, scope vs change
  orders, termination vs payment for completed work, IP transfer vs full payment, liability cap vs indemnity,
  insurance vs cap/indemnity, confidentiality duration vs survival, renewal vs termination and term dates, rates,
  payment deadlines, effective dates and governing law). A contradiction is only reported when both sides are
  genuinely incompatible and each has a verified quote; clauses that qualify or complement each other are not
  flagged, and undecidable cases are reported as *ambiguous*.
* No AI call is made by Phase 3. Without `GEMINI_API_KEY` the understanding stage uses the built-in deterministic
  engine, so the whole demo works offline.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000  (Vite + Express in one process)
npm test               # unit + integration tests (no network, no live Gemini calls)
npx tsc --noEmit
npm run build
```

A realistic sample with deliberately risky terms is in `samples/risky-freelance-agreement.txt`:
paste it, or upload it.

### Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | **production** | Signs the HttpOnly session cookie. Any long random string; must be identical across instances. |
| `GEMINI_API_KEY` | optional | Enables Gemini for the understanding stage. Without it the deterministic engine is used. |
| `GEMINI_CONTRACT_MODEL` | optional | Overrides the default Gemini model. |
| `CLAMAV_SCAN_URL` / `CLAMAV_SCAN_TOKEN` | **for any real deployment** | HTTPS ClamAV scanning service ([`scanner-service/`](scanner-service/README.md), Google Cloud Run). Server-side only. Without a real scanner, uploads return `UNAVAILABLE` and are **not analysed**. |
| `CLAMAV_HOST` / `CLAMAV_PORT` | optional | A real ClamAV daemon over TCP (self-hosted alternative). |
| `ALLOW_DEMO_SCANNER` | local only | Enables the embedded demo scanner (**not antivirus**). Refused on Vercel and in production. `npm run dev` sets it for you. |

## API

All `/api/contracts/*` routes require the HttpOnly session cookie issued by `GET /api/auth/session` and enforce
session ownership. `GET /api/health` is unauthenticated and reports runtime and configuration (never secrets).

| Route | Purpose |
| --- | --- |
| `GET /api/auth/session` | Issue the session cookie |
| `POST /api/contracts/upload[?analyze=1]` | Security inspection; with `analyze=1` also runs extraction → normalization → understanding → report in the same request |
| `GET /api/contracts/:id/security-status` | Security report |
| `POST` / `GET /api/contracts/:id/extract` | Phase 2A extraction (run / cached) |
| `POST` / `GET /api/contracts/:id/normalize` | Phase 2B normalization (run / cached) |
| `POST` / `GET /api/contracts/:id/understand` | Phase 2C understanding (run / cached) |
| `POST` / `GET /api/contracts/:id/risk-report` | Phase 3 review report (build from understanding / cached only) |
| `DELETE /api/contracts/:id` | Remove the document |

## Deploying to Vercel

The backend is an Express app (`src/server/app.ts`). A plain Vite deployment serves only static files, which makes
every `/api/*` request return **404**. `npm run build:vercel` (set as the build command in `vercel.json`) fixes this by
writing a Vercel [Build Output](https://vercel.com/docs/build-output-api/v3):

* `.vercel/output/static` – the Vite frontend
* `.vercel/output/functions/api.func` – the Express app bundled into one serverless function, plus the packages the
  PDF/DOCX extraction worker threads load at runtime (`pdf-parse`, `adm-zip`, `fast-xml-parser`)
* `.vercel/output/config.json` – routes `/api/*` to the function

Steps:

1. Import the repo in Vercel. Leave the detected settings as they are: `vercel.json` only overrides the build command
   (`npm run build:vercel`). Do not add `framework`/`installCommand` overrides to `vercel.json`; a project with the Vite
   preset rejected them.
2. Set **`SESSION_SECRET`** (required), **`CLAMAV_SCAN_URL`** and **`CLAMAV_SCAN_TOKEN`** (required for uploads to be scanned and
   analysed; see [`scanner-service/`](scanner-service/README.md)) and, optionally, **`GEMINI_API_KEY`** in the project's environment variables.
3. Deploy, then open `https://<your-deployment>/api/health`. It must return `{"ok":true,"runtime":"vercel-serverless",...}`.
   If `SESSION_SECRET` is missing it returns a JSON `503` that says so, instead of an opaque crash.

Serverless limits to know about:

* **Request bodies are limited to ~4.5 MB on Vercel** (the app allows 20 MB elsewhere). Larger files get a clear
  "too large for this deployment" message; pasted text is unaffected.
* **State is per function instance** (in-memory caches and `/tmp` quarantine). The UI therefore uses
  `upload?analyze=1`, which runs the whole workflow inside a single request. The step-by-step endpoints work on
  any single long-lived server but may return 403/404 on serverless if consecutive requests hit different instances.
* There is no antivirus unless you deploy the scanning service (`scanner-service/`) and set `CLAMAV_SCAN_URL` / `CLAMAV_SCAN_TOKEN`. Until then every upload reports **Security scanning is unavailable** and nothing is analysed. Check `GET /api/health?probe=1`.
* Quarantined files are kept in the instance's `/tmp` for at most 2 hours.

Alternatively run `npm start` on any Node host (`NODE_ENV=production`, `SESSION_SECRET` set) after `npm run build`; it
serves the API and the built frontend from one process.
