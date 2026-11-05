# ContractReviewer

Upload or paste a **Freelance / Independent Contractor Agreement** and get an evidence-backed review report:
what the contract says, what is risky for the contractor, what is missing, what is ambiguous or contradictory,
and what to clarify before signing.

## How it works

```
paste / upload ─► security inspection ─► extraction ─► normalization ─► contract understanding ─► risk analysis ─► Decision Report
                  (basic checks)          (Phase 2A)    (Phase 2B)        (Phase 2C: Gemini or       (Phase 3: rules)  (five sections)
                                                                           built-in fallback,
                                                                           word-for-word evidence)
```

**What the user sees.** One upload request runs everything in the background (the security checks are not shown) while
the screen says "Reviewing your contract". The result is a short, three-page review built from the **Contract Decision
Report** (`analysis.decisionReport`, presented by `src/components/review/` using the selection rules in
`src/utils/reviewPresentation.ts`): **Contract Overview** (the agreement name, the 3-5 findings that matter most, key
terms), **Understand Your Agreement** (seven topics, with the exact wording one click away) and **Before You Sign**
(what to negotiate, questions, a checklist, things to monitor). One page is shown at a time; pages turn with the arrow
buttons, the arrow keys or a swipe. The complete report stays in application state; the pages only choose what to show,
and an extracted value that is cut off or about something else is left out rather than shown. There is no numerical
score. A rejected file gets one short message.

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
| `ANTIVIRUS_POLICY` | optional | `optional` (default): a configured ClamAV is used and enforced, otherwise the built-in checks decide. `required`: a genuine antivirus scan is mandatory (uploads are `UNAVAILABLE` without one). Any other value is treated as `required`. Same behaviour on Vercel Preview and Production. |
| `CLAMAV_SCAN_URL` / `CLAMAV_SCAN_TOKEN` | optional | HTTPS ClamAV scanning service ([`scanner-service/`](scanner-service/README.md)). **Not needed for the MVP.** If set, it is enforced and fails closed. Server-side only. |
| `CLAMAV_HOST` / `CLAMAV_PORT` | optional | A real ClamAV daemon over TCP (self-hosted alternative). Also enforced and fail-closed when set. |

### Security checks and what they mean

This is a deliberately simple protective layer for a contract-review app, **not an antivirus**. Every upload goes through
these built-in checks, with or without an antivirus:

* **Only PDF, DOCX and TXT** are accepted, and the real file signature must match the extension (executables such as
  PE/ELF/Mach-O disguised as documents are rejected). The existing 20 MB size limit applies.
* **Corrupted or malformed** documents are rejected (broken PDF structure, broken or incomplete DOCX package, binary "text").
* **Dangerous content** is rejected. In a PDF: JavaScript, `/Launch` actions, embedded file attachments, encryption (cannot
  be inspected). In a DOCX: macros, ActiveX/OLE objects, embedded executables or scripts, and exploit-style external
  relationships. These are recognised from the PDF/OOXML structure, not from arbitrary text, so font names, ordinary URLs and
  normal legal wording never trigger them.
* **Malicious archive structure** in a DOCX: path traversal, excessive decompression, too many entries.
* A small list of **known malicious signatures** (for example the EICAR test string).
* **Prompt-injection wording is advisory**: it is recorded in the report but never blocks a contract. The contract text is
  always passed to the AI as untrusted data.
* Uploaded files are only ever read as bytes. Nothing in an upload is executed, and nothing is written outside the
  temporary quarantine, which is deleted at the end of every request.

Plus session authentication, CSRF protection, SHA-256 integrity and upload size / concurrency / timeout limits.

| Result (`status`) | Meaning |
| --- | --- |
| `CLEAN_NO_KNOWN_THREATS` | A **genuine** ClamAV scan completed and found nothing (`malware.genuine: true`). |
| `BASIC_CHECKS_PASSED_NO_ANTIVIRUS` | All built-in checks passed. **Full antivirus scanning was not performed** (`malware.genuine: false`). This is *not* a malware-free result. |
| `THREAT_DETECTED` / `REJECTED` | Blocked by a built-in check (or ClamAV). Nothing is analysed. |
| `SCAN_FAILED` / `UNAVAILABLE` | A configured antivirus failed, or one is required and missing. Nothing is analysed (fail-closed). |

Basic checks do not detect real malware that has no known signature and no active-content markers. For sensitive
use, deploy the optional scanning service and/or set `ANTIVIRUS_POLICY=required`.

### Documents are not retained

`POST /api/contracts/upload?analyze=1` is the supported workflow. The uploaded file, its quarantine metadata, every
intermediate result (extraction, normalization, understanding) and all server-side caches are deleted in a `finally`
block when the request ends, whether it succeeded or failed (`documentDeleted` in the response says so). Nothing is
restored at startup, and a safety-net sweep removes any debris from a crashed request after 10 minutes.

## API

All `/api/contracts/*` routes require the HttpOnly session cookie issued by `GET /api/auth/session` and enforce
session ownership. `GET /api/health` is unauthenticated and reports runtime and configuration (never secrets).

| Route | Purpose |
| --- | --- |
| `GET /api/auth/session` | Issue the session cookie |
| `POST /api/contracts/upload[?analyze=1]` | Security inspection; with `analyze=1` also runs extraction → normalization → understanding → report in the same request |
| `GET/POST ... /api/contracts/:id/{security-status,extract,normalize,understand,risk-report}` | **Disabled** (`410 Gone`): documents are not retained, so there is nothing to fetch or continue. |
| `DELETE /api/contracts/:id` | Idempotent no-op (nothing is retained) |

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
2. Set **`SESSION_SECRET`** (required) and, optionally, **`GEMINI_API_KEY`** in the project's environment variables.
   No antivirus service is needed: the built-in checks run and uploads are labelled *basic checks only*. A genuine
   antivirus is an optional later addition (`CLAMAV_SCAN_URL` / `CLAMAV_SCAN_TOKEN`, see `scanner-service/`).
3. Deploy, then open `https://<your-deployment>/api/health`. It must return `{"ok":true,"runtime":"vercel-serverless",...}`.
   If `SESSION_SECRET` is missing it returns a JSON `503` that says so, instead of an opaque crash.

Serverless limits to know about:

* **Request bodies are limited to ~4.5 MB on Vercel** (the app allows 20 MB elsewhere). Larger files get a clear
  "too large for this deployment" message; pasted text is unaffected.
* **Nothing is stored between requests**: the whole workflow runs inside the single `upload?analyze=1` request, and the
  document and all intermediate results are deleted before the function returns.
* Check `GET /api/health`: `securityPolicy.scanLevel` shows `basic-checks-only`, `antivirus` or `unavailable`.

Alternatively run `npm start` on any Node host (`NODE_ENV=production`, `SESSION_SECRET` set) after `npm run build`; it
serves the API and the built frontend from one process.
