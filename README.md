# Aerion

A founder workspace for aircraft sourcing, evidence review, buyer requirements, explainable matches, reviewed communications, transaction coordination, client engagements, invoicing and recorded cash.

The local release was checked on **4 November 2026**: **361 tests across 39 files** pass against the dedicated PostgreSQL test database, along with lint, TypeScript and the production build. All twelve agent roles have evidence-checked live-model capability acceptance records in Operations. Nine use isolated fictional workflows; aircraft discovery, buyer discovery and document intelligence use retained operational runs. These are bounded capability checks, not evidence of a completed business transaction or earned commission.

Start at [Operations](http://127.0.0.1:3000/operations) to inspect worker health, acceptance evidence and usage limits. Use [Lead discovery](http://127.0.0.1:3000/discovery) for real pending research candidates. Business email remains deliberately unconfigured; manual reply imports, draft downloads and the complete local workflow are available.

## Run locally

Requirements: Node.js 22.19+ (22 LTS) or 24.6+, and PostgreSQL 16+. The project pins Node 24.22.1 in `.nvmrc`. No cloud account or model API key is needed for local parsing and review.

```sh
nvm install # if using nvm
npm install
createdb aerion_local
cp .env.example .env.local
# Adjust DATABASE_URL for your PostgreSQL installation.
npm run db:migrate
npm run dev
```

Open [http://127.0.0.1:3000/sources](http://127.0.0.1:3000/sources).

The market intelligence desk is at [http://127.0.0.1:3000/intelligence](http://127.0.0.1:3000/intelligence). After updating an existing installation, run `npm run db:migrate` and restart **both** the web server and worker so they share the new job contracts.

Network-enabled commands use `scripts/run-node.mjs` to launch a compatible Node runtime with the existing OS certificate store. The launcher uses the current compatible runtime or the pinned runtime already installed by nvm; it does not change your global nvm default. Certificate/host-name validation stays enabled. This resolves TLS interception on this machine using its already trusted macOS certificates. Run `nvm install` in the project if the launcher reports a missing compatible runtime.

The development command starts Next.js on loopback and a worker for extraction, agent runs, enabled schedules and explicitly approved email deliveries. It uses Webpack for a stable local preview; the production build uses Next.js's default bundler. The local database and `.env.local` have already been set up on the current machine.

`AERION_LOCAL_AUTH=true` enables one development founder identity. It is explicitly refused by a production server and by non-loopback request hosts. It is for a personal development machine, not a shared deployment.

## Working workflow

1. **Collect:** add a PDF, CSV, TXT, EML, or pasted text. English image-only PDF pages receive local OCR. Aerion retains exact original bytes in PostgreSQL, SHA-256, capture time, source URL, extracted page text, and filename. Upload URLs are references. Public fetching uses selected connectors or an explicit Lead discovery search/URL request.
2. **Extract:** choose local parsing, or choose AI extraction after configuring a provider. A persistent job moves through queued, running, completed, or failed states.
3. **Inspect:** each candidate contains field observations, original passages, page references, validation warnings, and explicit conflicts. Missing values are never filled by guessing.
4. **Review:** edit, approve, or reject. Corrections and conflict resolutions need a note. Approval requires an explicit source-review acknowledgement. Required identity/classification/year fields must be supplied before publication; incomplete candidates can stay pending.
5. **Connect:** approval publishes inventory and its review decision in one transaction. Approved aircraft feed the existing deterministic matcher. New opportunities require eligible matches and retain source/extraction/review references. Follow evidence links from the aircraft or deal room back to the review and original file.

The source page offers a clearly fictional example for testing. Any `LOCAL-EXAMPLE`, `DEMO`, or explicitly fictional organization is test data, not aircraft availability or buyer demand. New server workspaces start empty; the old demo workspace is not silently imported.

### Local extraction

Local parsing is deterministic, not an AI agent. Text/PDF extraction recognizes explicit labels such as `Manufacturer:`, `Model:`, `Serial:`, `Category:`, `Year:`, `Engine:`, `Hours:`, `Cycles:`, `Price USD:`, `Location:`, `Country:`, and `AvailableDate:`. Separate aircraft with `---`. Numeric values use plain units, dates use `YYYY-MM-DD`, and unqualified text prices do not establish USD currency. Conflicting repeated fields remain visible.

CSV columns use the existing import template; `price` is explicitly USD under that schema. Partial CSV rows become candidates that need review. Imports no longer insert directly into inventory. Duplicate documents are rejected on content hash, and duplicate manufacturer/serial identities are rejected when approving.

Sale and lease sourcing use separate fields. An aircraft's `offering` is `Sale`, `Lease`, `Sale or lease` or `Not supplied`. `price` and a buyer's `budget` retain their original USD purchase meaning. Lease records use `leaseRate` / `leaseBudget`, `leaseCurrency` and `leaseBasis` (`Monthly rent` or `Hourly rate`). For example, a labelled source can include:

```text
Offering: Lease
LeaseRate: 200000
LeaseCurrency: EUR
LeaseBasis: Monthly rent
```

Manual brief forms ask for transaction kind explicitly. Lease matching compares only the same stated currency and rate basis; missing terms require review. It performs no currency or hourly/monthly conversion. Source validation checks monetary context, including the retained line around a shorter quote, to reject rental amounts proposed as purchase prices. Original records with omitted commercial fields keep their earlier sale semantics. New ambiguous intake stays explicitly unknown. Transaction defaults follow the brief; conflicting offers or changed commercial terms need requalification before progression. Indicative source rates retain their recorded precision; recorded offers and the revenue ledger currently accept positive plain decimal amounts with at most two decimal places and reject additional precision instead of rounding it. A fee basis remains an explicit term of the retained engagement agreement.

Limits: 10 MB per original file, 40 PDF pages, 200,000 extracted text characters, 100 candidates per extraction, and 500 sources per workspace. English image-only PDF pages are transcribed locally using packaged Tesseract WASM and English language data; no document or language download is sent to a service. Up to eight image-only pages per upload, 90 seconds per transcription and one OCR document per process are supported. Other languages, handwriting, tables and difficult scans need manual transcription or correction. Every OCR page is labelled and retains its original PDF page number. Compare characters, serials, dates, units and numbers against the original PDF before review; a matching transcription does not establish recognition accuracy. Documents remain private database records and are downloaded through an authorized route.

### Optional model extraction

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env.local`, then restart the app and worker. Choose a model that supports Responses API structured outputs. No OpenAI model is selected automatically. The current live acceptance evidence uses the separately configured NVIDIA provider.

The OpenAI adapter uses structured output, bounded input/output, a 45-second timeout, no automatic SDK retries, no tools, and `store:false`. The application checks returned types and verifies that cited passages and proposed values occur in the retained page text. Those checks establish traceability, not truth; the review queue remains mandatory. The queued model name and prompt version are recorded. API documents are sent only when the founder explicitly chooses AI extraction.

## Agent Center

Open [http://127.0.0.1:3000/agents](http://127.0.0.1:3000/agents). All twelve roles have executable scoped tools, saved runs, reports, citations, proposals and a review boundary:

| Role | Working scope |
| --- | --- |
| Aircraft discovery | Search public aircraft listings or inspect selected URLs, retain publisher evidence and propose seller-side leads; configured connectors can also queue aircraft extraction |
| Aircraft intelligence | Inspect approved aircraft facts, utilization and missing information with source evidence |
| Buyer discovery | Search buyer signals or inspect selected URLs, distinguish stated demand from fleet/profile research targets; configured sources can also queue market signals |
| Buyer requirements | Extract explicit constraints into a Draft brief or identify missing clarification questions |
| Aircraft matching | Run deterministic eligibility checks and propose shortlist decisions for confirmed briefs |
| Outreach | Propose preparation of an immutable evidence-backed draft for an eligible shortlist and linked recipient |
| Communication | Import an authorized read-only mailbox folder, retain messages/attachments, propose sourced updates and interactions |
| Document intelligence | Read PDF/OCR/text passages, queue structured extraction, group potential discrepancies by aircraft identity |
| Due diligence | Inspect six readiness groups and propose dated requests for missing evidence |
| Deal coordination | Inspect deadlines, connected opportunities and open actions; propose follow-through |
| Negotiation copilot | Compare reviewed same-model observations by currency and price basis, and identify missing commercial context |
| Relationship CRM | Read actual interactions and separately attributed SMTP submissions, propose sourced contacts and follow-ups |

**Rules** mode works immediately without an account. It executes deterministic parsers and tools; it is not live AI reasoning. **OpenAI**, **NVIDIA Nemotron 3 Ultra** and **Ollama** use model-driven function calling against the same role-specific tool grants. Set the chosen provider variables in `.env.local`, restart both web and worker, then explicitly acknowledge model data use in the run form. OpenAI uses Responses with `store:false`; Ollama uses an OpenAI-compatible endpoint restricted to loopback HTTP(S). OpenAI and Ollama have no default model; the NVIDIA provider defaults to the explicitly selected Nemotron 3 Ultra model. Configuration status is not proof of model availability.

Select the actual requirement, aircraft, contact and source context, then run a role. Inspect the saved findings, exact passages and tool trace. Proposals do not change business records until accepted with a founder note and attestation. Context fingerprints reject proposals whose relevant records changed. Agent-created buyer briefs remain Draft; confirmation, original-source reviews, technical/legal verification, deal stages and sending approval remain founder-controlled. Negotiation compares attributed observations and does not produce unsupported fair values or external offers.

Diligence, deal coordination and negotiation read the selected case's actual transaction cycles, current offers and expiry, milestone reviews, open findings and linked engagement/invoice balances. The earlier four-stage opportunity summary does not distinguish Completed, Lost and Cancelled; agents use the transaction record for those outcomes. Coordination keeps terminal sourcing work closed and separates signed terms, recorded earning, issued invoices and received cash. Linked transaction or engagement changes make pending follow-ups obsolete. Context arrays are bounded with explicit coverage counts, and private invoice payment instructions and unrelated case finance are excluded. The model-data acknowledgement includes these related commercial records.

Runs are durable PostgreSQL jobs with five-minute leases, bounded attempts, cancel/retry controls and immutable tool traces. Each model loop has at most six requests, thirty tools and three minutes of execution; no SDK automatic retry or rules fallback disguises a model failure. Token usage on the report covers the agent loop only; separately queued extraction jobs are separate model work. Schedules are explicitly enabled per role at intervals from one to 168 hours. They use saved context and the same acknowledgements/review workflow; no schedules are silently enabled.

### NVIDIA Nemotron 3 Ultra

The dedicated NVIDIA provider targets the [official hosted model](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b) at `https://integrate.api.nvidia.com/v1`, using the [Chat Completions API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer). It uses a separate API key and provider identity; OpenAI credentials are not required. No model weights or GPU runtime are installed locally.

Add to `.env.local`:

```dotenv
NVIDIA_API_KEY=your-nvidia-build-key
NVIDIA_MODEL=nvidia/nemotron-3-ultra-550b-a55b
```

The model variable is optional and defaults to this exact model. Keep the key out of chat and source control. Restart **both** web and worker. Choose **NVIDIA Nemotron 3 Ultra** in an agent run or the source inspector's **AI extraction provider**, review the data-use acknowledgement and supply the relevant retained context. All twelve roles and their queued aircraft/market extraction jobs support this provider. Run and extraction model names are snapshotted when queued; existing runs are unchanged.

The initial constrained-output profile sends documented `max_tokens` and `reasoning_effort: none`, with temperature 0.2, a 90-second request timeout and zero SDK retries. Disabling thinking is an explicit compatibility choice for structured reports/tool calls; reasoning-mode comparisons are not implemented in the UI. NVIDIA agent requests expose a separate `finish_report` function and omit `response_format` during tool use. Final report arguments are validated against the report schema; a report call mixed with business tools is rejected before executing the batch. Standalone extraction and the probe's final request use JSON-schema response formatting without tools, because combining response formatting with tool choice prevented the required tool call in the live endpoint test. Reports and extraction JSON remain schema-validated and source-checked, with the same proposal/review controls. Provider-specific hidden reasoning/debug fields are excluded from conversation replay and saved tool traces. No fallback switches to another provider after a failure.

To verify the live endpoint after adding the key:

```sh
npm run agents:doctor
npm run nvidia:probe
```

The probe makes **two bounded live model requests** using a fictional fixture. It checks a tool call, tool-result continuation, structured report and exact evidence. It writes no business records and invokes no mail, collection or business-action tools. A pass is a capability smoke test, not a domain-quality or business benchmark. Account access, quotas, latency and service availability depend on NVIDIA. The initial integration used mocks and PostgreSQL while credentials were deferred. On 2026-11-02 the live Nemotron 3 Ultra probe passed tool calling, structured output and exact fixture evidence in two requests (473 input tokens and 59 output tokens reported by the endpoint). The live Document Intelligence workflow also completed with cited findings and no business-change proposals. A subsequent fresh numeric fixture produced 12 supported aircraft fields, including numeric year/hours/cycles/price, with no warnings; its candidate remains pending review. This is a bounded capability check; it does not establish domain quality across all twelve roles.

### Public sources

Register an exact public HTTPS URL, format and extraction purpose under **Sources & schedules**, then select it in a discovery run and allow collection. The collector retains original response bytes, canonical URL and extracted text. It accepts at most two collections per run, 2 MB each, and three same-origin redirects. DNS answers are checked and pinned; private/reserved addresses, credential URLs and cross-origin redirects are refused. It does not execute page scripts, traverse a site, log in, bypass access restrictions or connect a licensed inventory feed. Choose a feed or specific readable page; JavaScript-only listings need an approved feed/import.

TLS validation remains enabled. The earlier Node 22.14 runtime encountered an untrusted certificate chain on this managed network; network commands now use a compatible Node runtime with the existing system trust store. In a network requiring an organization CA, set `AERION_EXTRA_CA_FILE` to a PEM file supplied by the trusted network administrator, then restart the worker. That file adds trusted CAs without disabling validation. Successful public-source collection is separate from the live model check and has not been established by that check.

### Buyer and seller discovery

Open [Lead discovery](http://127.0.0.1:3000/discovery). Choose Buyer or Seller, enter the aircraft/fleet focus, keep both markets open or narrow the market, and optionally specify a region. Use **Specific URLs** immediately with one to three public HTTPS pages. A connected AI provider proposes structured leads; **Collect pages only** retains originals and reports collection outcomes without inferring leads.

For web search, add `BRAVE_SEARCH_API_KEY` to `.env.local` from the [Brave Search API dashboard](https://api-dashboard.search.brave.com/), then restart both web and worker. This API account is separate from the Brave browser and NVIDIA. The adapter follows the [official web search API](https://api-dashboard.search.brave.com/api-reference/web/search/get); the token stays server-side and is sent only to its pinned endpoint. No key is needed for specific public URL inspection.

Each run freezes its exact search scope, makes at most one Brave query, offers up to six HTTPS results and inspects up to three pages. Search window filters are index age estimates, not evidence of current buying intent. Search metadata and its exact response are retained separately from original publisher bytes. Snippets cannot support lead proposals. Interrupted or failed searches are not repeated automatically; a new run is an explicit new search. Page inspection reuses retained results and enforces its budget in PostgreSQL across worker interruptions. The existing public collector enforces private-address, credential, size, redirect and access controls. Restricted or script-only pages may fail; the failure stays visible in Search history.

AI runs use only discovery tools and the selected public page context, not unrelated workspace inventory or contact records. Identity, model, location and contact fields must occur literally in the submitted retained-source quotes. Published contacts also need attribution to the stated organization in the same quoted passage. Unsupported fields are rejected rather than silently rewritten. Classification and summaries are agent assessments for review, not verified facts. Repeated page/organization/model subjects deduplicate across runs and tracking parameters.

**To review** shows proposed candidates. Open a run, inspect its passages/original and accept or reject with a review note. Acceptance saves an immutable research lead. It does not create approved aircraft, CRM contacts, confirmed requirements or opportunities. Fleet activity and business profiles remain research targets; even stated demand/listings require qualification of timing, representation and current needs/availability. Source review, buyer requirements and execution workflows handle those later steps. No discovery schedules are enabled automatically.

On 2026-11-02, live Nemotron URL discovery produced a buyer-side candidate from [IntelliJet's published acquisition requirements](https://intellijet.com/jets-wanted/) and a seller-side Falcon 2000 candidate from its [public listings page](https://intellijet.com/jets-for-sale/). Both remain pending founder review. Initial rejected attempts remain in run history; unsupported organization annotations/geography and missing availability citations were blocked. Evidence diagnostics supply exact publisher passages without changing proposed values or accepting an action. Current workspace calendar date is included in model instructions. This is a bounded integration check, not confirmation of the broker's mandate, aircraft availability or lead quality. Brave Search was initially tested with HTTP mocks and PostgreSQL. After the API key was added, live buyer and seller queries both returned six web results and retained readable publisher pages. The A319 seller run produced one Air India business-profile research candidate; the Challenger 350 buyer run found only seller listings and correctly produced no buyer lead. A rejected first attempt exposed an overly narrow availability phrase check; quoted immediate/outright sale and immediate dry/wet lease wording now receives the same citation checks, with regression coverage. This earlier discovery validation passed the then-current suite, lint, typecheck and production build; desktop and 390px mobile inbox/evidence interactions were checked in the browser.

### Working a saved buyer or seller lead

Apply `009_lead_qualification.sql` with `npm run db:migrate`, restart web and worker, then open **Lead discovery → Saved leads → Work this lead**. A deep link such as `/discovery?lead=<lead UUID>` opens the same persisted workspace.

1. **Find demand:** buyer searches default to explicit wanted/acquisition mandates. Choose Fleet activity or Company research deliberately for broader targets; these modes cannot propose stated demand. Any-time search is the default because acquisition pages may have older index dates. Timing still requires confirmation.
2. **Establish a contact:** run contact research through Brave or selected public URLs. Only the selected lead and its source context go to the model. Published organization/contact/email/phone values need literal, attributed evidence on a page inspected during that run. Contact-mode capture retains header/footer details and published `mailto:`/`tel:` values, without guessing addresses. Accepting research retains immutable evidence; recording or linking the CRM contact is a separate founder decision. Unknown required CRM fields remain blank.
3. **Prepare an initial enquiry:** the connected recipient enables an immutable qualification message asking for current requirements or availability. Edit as a new version, review the exact recipient/content, and download the draft or separately approve email delivery. Nothing sends merely because a lead or draft was accepted.
4. **Capture the buyer response:** import an EML, PDF or text reply in the Source library, then attach it as Buyer brief evidence. Select up to twenty attached documents for analysis. The queued selection stays fixed even if later documents are attached. Rules handle explicit labels; a connected model handles supported prose. Every extracted required constraint must be present, and the proposal remains a Draft brief bound to this lead until accepted. Missing constraints need a buyer response or founder-recorded draft; they are not invented.
5. **Confirm and match:** record the confirming contact, date and basis. Only then can an eligible aircraft advance to a shortlisted opportunity. **Create opportunity & offer draft** links the recipient, saves the shortlist, prepares the evidence-backed offer and creates a Sourcing deal in one transaction. Review the offer in Outreach, inspect its source claims, download it, or explicitly queue its reviewed current version through configured SMTP. Deal room and the full execution desk retain the coordination and diligence history.

The five-step readiness strip reflects saved contact, brief, confirmation, eligible inventory and opportunity records. Seller leads use the same contact/enquiry workflow and can queue their retained listing for aircraft extraction and review. Source evidence, contact enrichment and draft text are immutable. Case revisions, owner-scoped RLS, context hashes, audit history and idempotency protect concurrent work; changed or dismissed context blocks sending. Repeated pending lead subjects and approved contact enrichments deduplicate across runs. Initial-enquiry delivery and aircraft-offer delivery share the same TLS, review, receipt and ambiguous-outcome handling.

The qualification path has been exercised through the browser against an isolated PostgreSQL test database with clearly fictional contacts, a retained buyer reply and approved sample aircraft. SMTP submission is tested with protocol mocks. Actual external sending still requires a configured business mailbox and explicit per-draft approval. No real buyer confirmation, message or transaction was created during engineering validation.

The earlier qualification release passed **148 tests across 22 files**, including PostgreSQL acceptance tests, lint, TypeScript and a production build. The desktop (1280px) and mobile (390px) qualification workflow had no horizontal document/dialog overflow; the reviewed offer download preserved the recipient, subject and exact body. The current integrated release adds communication corrections, transaction progression, revenue and Operations checks to that foundation. Isolated browser fixtures remain in `aerion_test`, separate from operational `aerion_local` data.

Live buyer validation on 2026-11-02 used Brave to locate a G280 page with wanted notices, then a focused Nemotron run proposed a SPARFELL G280 demand candidate from the [retained AvBuyer publisher page](https://www.avbuyer.com/aircraft/private-jets/gulfstream/g280). The candidate remains pending founder review. Published wording and a phone number do not establish current mandate or representation. Failed runs remain in history. The runtime now reserves NVIDIA's sixth request for a final report and lets an earlier invalid final citation be corrected within the existing budget; source validation is unchanged.

### Email integrations

Email is optional and was validated with protocol mocks, not a live account. Configure a dedicated business mailbox/folder using `IMAP_HOST`, `IMAP_USER`, `IMAP_FOLDER`, and either `IMAP_PASSWORD` (provider app password) or `IMAP_ACCESS_TOKEN`. IMAP uses TLS (default port 993). Hosted configuration must bind the account to `AERION_MAIL_OWNER_ID`; local auth binds to the development founder. Account credentials never enter client responses or tool output.

Enable mailbox collection explicitly in a Communication run. Intake reads at most five messages per run (initial lookback 30 days), preserving exact RFC822 bytes, supported PDF/CSV/TXT attachments and parent links. It never changes flags, deletes or moves mail. Cursor leases, UIDVALIDITY and content hashes prevent duplicate retention. A 2 MB message/attachment bound and at most four parsed attachments per message apply. Unparsed attachments remain in the original message. Email headers and OCR are untrusted observations, not sender authentication or technical evidence certification. EML uploads also work without a connected mailbox; direction is left unknown without an account context.

Configure `SMTP_HOST`, `SMTP_USER`, `SMTP_FROM`, and either `SMTP_PASSWORD` or `SMTP_ACCESS_TOKEN` to enable the separate **Email delivery** panel on a draft. TLS is required (465 implicit TLS by default; 587 STARTTLS supported). Only a current Reviewed draft can be explicitly approved for queuing. Recipient, sender, subject, body, message ID and context are retained as an immutable delivery snapshot. The worker rechecks the current draft before submission. A server acceptance receipt means accepted for sending; it does not establish recipient delivery or a reply. Ambiguous or interrupted submissions become **unknown** and are never retried automatically. Check Sent/server logs and record a reconciliation before a deliberate retry. OAuth access tokens must be supplied/refreshed outside Aerion; an OAuth consent/refresh flow is not implemented.

### Reply review and clarification cycles

Open [Communications](http://127.0.0.1:3000/communication). Manual EML uploads and authorized IMAP intake use the same exact-byte retention and deduplication path. Reply headers can suggest an enquiry association only when the referenced outbound message and participant addresses match. A suggestion is not sender authentication or a confirmed requirement; review it before linking.

Unmatched messages can be assigned to a saved lead with a review note. Analyze the linked retained reply using Rules or a configured model, inspect the proposal and accept a source-backed **Draft** brief. Confirmation still requires the actual contact, date and basis. A revised reply creates a separate Draft; the old confirmed brief, evidence and business history remain available. New offers, shortlists, commercial progression and commission earning against an obsolete brief require requalification.

If a reply was linked to the wrong lead, use the reviewed correction action. It records the previous and new assignment, retires the old reply inputs from prospective analysis, cancels the old analysis and invalidates affected pending proposals. It preserves the original message and historical records. The corrected lead needs its own analysis and confirmation. Contact restrictions and suppressions are rechecked when queuing and immediately before SMTP submission.

The browser acceptance exercised import, assignment, analysis, Draft acceptance, confirmation and wrong-lead correction against fictional test records. Protocol mocks cover read-only IMAP, approved SMTP, recipient/context changes, duplicate handling and ambiguous outcomes. A live mailbox connection test remains pending the founder's account configuration.

### Setup diagnostics

```sh
npm run agents:doctor
```

The read-only command checks the twelve role definitions, installed English OCR data, provider/mail configuration and all migration checksums. It prints no credentials and makes no paid requests or mail/source probes. It explicitly reports pending accounts and does not infer worker liveness from configuration. `npm run dev` starts the local worker; production hosting needs a separately supervised `npm run worker` process.

Local engineering validation includes every role through real PostgreSQL tools and reviewed proposal application, provider contract tests, read-only IMAP and approved SMTP mocks, ambiguous-send recovery, RLS/immutability, schedules, OCR of an image-only PDF, and extraction fixtures. NVIDIA was additionally exercised live on 2026-11-02 with fictional data: the Document Intelligence run completed in three model requests using retained source passages and a queued NVIDIA extraction; a fresh typed-numeric extraction retained all 12 stated fields with zero warnings, remaining pending for founder review. The first extraction's numeric-string warnings are retained as historical evidence; model-facing schemas now require JSON numbers for year, hours, cycles, USD price and market quantity without silent coercion. That earlier suite and production build passed under the project Node 24 runtime. Mailbox and SMTP remain validated with mocks only. All preview records remain fictional; business effectiveness and real sourcing access have not been validated.

## Transaction lifecycle

Open an opportunity in [Deal room](http://127.0.0.1:3000/deals) and open its transaction workspace. The lifecycle is **Sourcing → Offer → LOI → Agreement → Inspection → Closing → Completed**, with Lost and Cancelled outcomes. The transaction workspace owns commercial progression; the legacy summary stage cannot bypass its evidence gates.

Record immutable offer and counteroffer versions, the related previous offer and a source-backed acceptance decision. Attach the required representation, availability, offer, LOI, agreement, technical, inspection, title and closing evidence for the relevant stage. Documents move from Received to Reviewed to **Verification recorded**, with the reviewer/verifier, date, note and retained source. Aerion records that attribution; it does not perform the underlying technical, title or legal review.

Blocking findings prevent progression until their source-backed resolution is recorded. Only the supported LOI/inspection waivers can be recorded with a reason. Lost/Cancelled remain available when context changes. Completion requires the current evidence and a retained closing source. Reopening creates a new cycle and makes previous completion evidence ineligible for new closing commissions; historical offers, milestones, invoices and receipts remain intact. A corrected or superseded buyer brief also blocks new commercial progression until requalification.

Each transaction tracks **one saved aircraft serial and quantity one**. A multi-aircraft buyer brief uses separate serial-specific opportunities; completing one does not establish delivery of the whole order. Earlier inconsistent accepted offers with larger quantities remain historical but cannot support new progression, completion eligibility or closing fees. Record a new cycle with the actual serial-specific scope after review.

Browser acceptance took a fictional transaction through every stage, a version-linked counteroffer and acceptance, nine named milestone verifications, a blocking inspection issue and its resolution, and completion. It used actual UI forms in the isolated test database.

## Client engagements, commissions and cash

Open [Revenue](http://127.0.0.1:3000/revenue). Create an engagement with the actual client, fee payer, work scope, fixed or percentage fee, currency, term, earning condition and payment terms. Activation requires a retained signed agreement and a recorded review. It freezes the agreed party and fee snapshot. Aerion stores the supplied agreement; it does not obtain a signature or establish your entitlement.

Record an earned fee only when the agreed event occurs, with its dated evidence. Closing-based earning and new invoice issuance require the current completed transaction cycle and completion source. An estimate, listing price, match score or generated draft is not earned revenue. Reopened transactions and obsolete buyer context cannot establish a new closing fee.

The earning date must fall within the actual agreement term. An engagement cannot be retrospectively ended before a currently recorded earning. Correct an erroneous entry through the recorded invoice/receipt/earning reversal path first. Invoice issuance rechecks term dates even for legacy inconsistent records; previously issued documents and receipt history stay retained.

Issue an immutable invoice with your actual issuer identity/address, payer details, due date and supplied charges or tax. No jurisdiction's tax treatment is inferred. The invoice has an authorized printable/downloadable HTML document. After funds are actually received, record the original incoming transfer total, date, payer, unique reference and evidence, then allocate an amount to the invoice. The transfer record is shared across invoices, and total active allocations cannot exceed its original total. Partial receipts leave a balance; a reversal restores allocation capacity. Incorrect original transfer records can be voided only after their allocations are reversed. Recording or reversing an entry does not move or refund money.

Record actual paid expenses with their reference and evidence. The cash view shows allocated invoice receipts less recorded expenses, separately by currency. **Net recorded cash is not profit**: it includes any invoice taxes/charges and excludes unrecorded costs and liabilities. Original transfer totals, issued invoices, receipt allocations, reversals and audit history are retained. Monetary calculation uses integer minor units for the supported 0-, 2- and 3-decimal currencies.

The fictional browser acceptance activated an engagement, recorded a USD 1,000 earning, issued its invoice, allocated separate USD 400 and USD 600 payments, and recorded a USD100 expense. It verified Paid, zero outstanding and USD900 net recorded cash. No actual client authority, payment or commission was represented. PostgreSQL tests additionally cover shared-payment capacity across invoices, concurrent writes, reversals, workspace isolation and transaction/reply context changes.

## Operations, bounded usage and acceptance evidence

[Operations](http://127.0.0.1:3000/operations) shows a worker heartbeat rather than inferring liveness from configuration. A worker is current within 45 seconds. It displays saved queues, recent failed jobs, ambiguous mail outcomes, missing mailbox setup, availability review reminders and the latest backup verification. Failed attempts remain visible after a successful retry.

Daily defaults are 25 AI jobs, 1,000,000 observed agent-loop tokens, 50 Brave searches and 25 email queue entries, using Asia/Kolkata days. AI jobs include agent runs and model extractions. Extraction token usage and provider billing are outside the observed-agent-token total. Caps stop new work after the relevant bound is reached; in-flight requests can finish. These controls do not promise a currency spending limit. Edit limits or pause new automated work with a recorded note. Local parsing remains available while model/agent work is paused.

All twelve roles currently have a role-specific capability acceptance pass. Operations distinguishes verified fixture proof from retained workspace checks and from merely observed runs. Acceptance independently checks the stored role/provider/model, report and trace hashes, exact citations, bounded usage, granted tool calls and required proposed/applied actions. Imported fixture proof contains sanitized hashes/counts; its private documents and reports stay in the test workspace. Rejected-report correction diagnostics remain separate from business tool calls within the six-request budget. Failed acceptance history is immutable; a successful retry is a new record.

Repeat the explicit live fixture check only when you intend to use the provider API:

```sh
AERION_TEST_DATABASE_URL='postgresql:///aerion_test?host=/tmp' \
  npm run agents:acceptance -- --live

# One bounded fictional lease brief; validates the exact EUR monthly ceiling:
AERION_TEST_DATABASE_URL='postgresql:///aerion_test?host=/tmp' \
  npm run agents:acceptance -- --live --roles buyer-requirements --lease-brief

# Publish already saved proof; no model call, sending or business approval:
AERION_TEST_DATABASE_URL='postgresql:///aerion_test?host=/tmp' \
  node scripts/run-node.mjs scripts/publish-agent-acceptance.ts --report /absolute/path/to/report.json
```

The live acceptance command retains clearly fictional fixtures in a new test workspace. It does not run an SMTP worker or external source collector. A capability pass does not establish broad domain quality, current mandates, transaction authority, or income.

On 4 November 2026 the revised sourcing tool contract passed a live NVIDIA buyer-requirements check in four requests. It retained the exact EUR 225,000 monthly lease ceiling in a new Draft requirement with a null purchase budget. Saved original citations and commercial values were independently revalidated against the final guards. The generic and selected-lead tool schemas require an explicit transaction kind, following the SDK's [strict structured-output requirements](https://developers.openai.com/api/docs/guides/structured-outputs#all-fields-must-be-required); persisted legacy records remain compatible. This focused check supplements the earlier twelve-role capability records.

The separate commercial-context acceptance exercises diligence and coordination against one completed transaction, another active offer with a blocking title finding and expiry, and a partially paid fee invoice:

```sh
AERION_TEST_DATABASE_URL='postgresql:///aerion_test?host=/tmp' \
  npm run agents:commercial:acceptance -- --live
```

It requires all existing test-database migration checksums, creates a new clearly fictional workspace, runs each role once under the existing model budget, retains actual traces/reports/usage and approves no proposals. Use `--roles deal-coordination` or `--roles due-diligence` to run only one role after a deliberate change. Failed or inconclusive runs exit nonzero. It uses no collectors, schedules or mailbox, and performs no sending. Run only when you intend to make live provider calls. Source citation repair supplies the actual authorized pages that failed validation, rather than unrelated initial excerpts; bounded schema diagnostics name the field and validation issue. The original rejected report remains in the trace. Saved workflow/accounting values are attributed to founder records and are kept distinct from quotations of original documents.

On 3 November 2026 the expanded live checks passed for diligence and coordination in four requests each. Both read the actual Completed and active Offer states, open title finding, expiry and USD 600 outstanding on a USD 1,000 invoice with USD 400 received. Coordination explicitly rejected re-sourcing the completed serial and correctly identified title clearance as a Closing prerequisite. Earlier failed citation/schema attempts remain retained; validation was not weakened to make them pass. These are small fictional checks, and generated prose still needs founder review. The model can exceed a preferred summary length even when its report is schema-valid.

### Recovery and daily local operation

Keep PostgreSQL running and use `npm run dev` for the local web server and worker. Restart both after credentials or backend job contracts change. No login-time service or cloud hosting is installed. Use Operations to check the heartbeat and saved work after restarting; the browser is not the job store.

Create a private complete database archive and verify it before depending on recovery:

```sh
npm run db:backup -- --verify-local
```

The command reserves a new archive under `.aerion/backups/` with private permissions and never overwrites a file. It uses a consistent PostgreSQL snapshot, restores to a uniquely named new local `_test` database, compares all retained table row counts and forced-RLS table counts, then removes only that temporary database. The archive includes original bytes, business records, invoices and audit history. It does not include `.env.local`; retain credentials separately in your own secure backup. Backup verification metadata is shown in Operations. On 3 November 2026 the current 15-migration database restored successfully: 52 tables, 337 rows and 51 forced-RLS tables.

To recover after an actual failure, retain the failed database/archive, create a separate empty database, restore the selected archive with `pg_restore --exit-on-error --no-owner --no-acl --dbname <new_database> <archive>`, point `DATABASE_URL` at that database, run `npm run agents:doctor`, and restart web and worker. Verify the records before switching back to business operation. The automated verifier tests restore into a temporary database; it never replaces your active database.

## Requirement execution desk

Open [http://127.0.0.1:3000/execution](http://127.0.0.1:3000/execution), or choose **Open execution desk** from a requirement, match, or opportunity. Apply migration `003_execution_desk.sql` with `npm run db:migrate` when upgrading an existing local database.

1. **Establish the brief:** the desk consolidates matching constraints, the founder-recorded confirmation, linked contacts, connected opportunities and open questions. A signal-backed brief resolves its original confirmation. A manually entered or older brief requires a contact, date, basis and explicit attestation before shortlisting; a saved Confirmed status alone is insufficient.
2. **Decide the shortlist:** save Shortlisted, Rejected or Undecided with a reason. Match evaluations and founder decisions are separate. Only a currently eligible candidate can be shortlisted, and earlier decisions remain in the audit history.
3. **Prepare outreach:** choose a shortlisted aircraft, linked contact and Buyer/Seller audience. Buyer drafts require a Buyer or Broker contact; seller drafts require a Seller or Broker. Aircraft identity/year need an approved original-source review. Local templates include supported facts and omit unknown optional fields. Free-form source instructions and contact notes never enter the message.
4. **Review the evidence:** every factual field has a retained claim entry labelled Source-reported, Founder-reviewed correction, Founder-recorded brief or Founder-recorded contact, with its passage/page or recorded basis. Inspect the message, recipient, citations and original documents before recording your review. The original draft text and claims are immutable. Changed context or a withdrawn shortlist decision marks a draft stale and blocks another review. Repeating preparation with identical inputs returns the existing draft, including its retained status. Download includes the original recipient, message and claim register.
5. **Follow through:** add dated follow-ups or open questions, mark them complete/reopen them, or request deterministic next-action suggestions. Suggestions fill workflow gaps and are deduplicated; nothing is scheduled or sent externally. Due and overdue actions appear in the desk and attention bell across requirements. The bell shows up to the earliest 100 due items; each desk retains all its actions. Date-only workflow calculations and displayed operation timestamps use the explicit workspace timezone Asia/Kolkata.
6. **Build the readiness record:** six evidence groups cover representation, availability, technical records, inspection, title and commercial terms. Missing is the initial state. Attach a retained source to record Received, then Reviewed with attestation, then Verification recorded with named verifier, date and detailed basis. Steps cannot be skipped. Replacement evidence returns to Received before review; prior verification attribution is cleared and preserved in history. Verification is a founder-recorded attribution to the named reviewer, not certification by Aerion. Missing questions can remain open alongside a reviewed document.
7. **Connect the opportunity:** create a deal from a shortlisted eligible candidate or open an existing connected opportunity. Stages continue to organize work; the checklist does not automatically approve a transaction or advance its stage.

Execution records use dedicated scoped tables, case revisions, workspace-first row locks, and the append-only activity log. Runtime permissions allow status/review changes while preventing edits to retained draft text and claims. Each desk supports 100 retained drafts and 200 actions, and displays the latest 50 activity events. The requirement selector covers saved briefs; candidate search/filter results load 30 at a time. Readiness is maintained per requirement, so a multi-aircraft brief still needs aircraft-specific diligence outside this shared checklist before execution.

Draft text uses the existing evidence-backed templates. Agent proposals can prepare drafts; agents cannot record their own draft review or send them. The separate email delivery workflow requires a current Reviewed draft, configured SMTP sender, and a founder-recorded sending approval. Calendar delivery and autonomous verification are not implemented. Representative real documents and founder-confirmed briefs are still needed to judge practical usefulness.

Full PostgreSQL backups below include execution records, original documents and audit history. The legacy browser/workspace JSON export contains inventory/CRM only and is not a full server backup.

### Repeatable engineering evaluation

```sh
npm run evaluate
AERION_TEST_DATABASE_URL='postgresql:///aerion_test?host=/tmp' npm test
```

`npm run evaluate` measures expected-field precision/recall, retained-passage coverage, abstention and conflict handling on **18 synthetic cases** (ten commercial/business specification examples plus eight edge cases) and **four short attributed public headlines**. The current declared synthetic set has 106 expected fields: 106 correctly extracted, no extra fields, full retained-passage coverage, two full abstentions, and a flagged conflicting-year observation. The headline set has two supported fleet-activity parses and two deliberate abstentions. Conflict flags remain separate from the first proposed value; a flagged proposal requires review. These small, purpose-built fixtures are regression evidence, not general extraction accuracy or market-demand validation.

The PostgreSQL acceptance suite takes ten clearly fictional commercial/business opportunities through source extraction, approval, founder-recorded brief confirmation, persisted shortlist, evidence-backed draft, recorded draft review, dated follow-up and connected deal. Additional checks cover wrong recipients, missing confirmation, unknown optional facts, changed context, historical recipient retention, skipped or future verification, replacement sources, competing writes, immutable draft content, task deduplication, due-item attention and workspace isolation. Preview examples are explicitly fictional and remain local; randomly generated integration data is removed from the dedicated test database.

## Persistence and access

- Existing inventory/CRM state is schema-validated JSONB in `aerion.workspaces`, with a revision number and row locking to detect concurrent edits.
- Sources, extraction jobs, candidate observations, final review values, and the append-only activity log are separate relational records. Every record belongs to a workspace, with composite foreign keys preventing cross-workspace references.
- Every application transaction switches to the `aerion_runtime` role and sets transaction-local authenticated actor/workspace IDs. Row-level policies verify ownership and scope. The runtime has no DELETE permission and cannot change original sources or activity records. Context resets at transaction end.
- The migration/worker connection is privileged and must remain server-only. The worker uses privileged enumeration to discover jobs, then runs each job under the restricted role. SQL values are parameterized.
- Extraction jobs use leases and row locks. An interrupted job becomes claimable after five minutes; at most three interrupted attempts are allowed. External extraction occurs outside the transaction. Results commit only for the current lease token. Normal failures remain visible until an explicit retry. Multiple workers cannot publish the same job twice.
- `npm run worker` runs processing independently. A hosted deployment needs a supervised worker process. Trigger.dev can replace this runner later; it is not integrated in this phase.

The review list displays up to 500 candidates with pending records first; counts cover the whole workspace. Older review history remains accessible through aircraft and deal evidence links.

Original documents are stored in PostgreSQL for this local phase. Supabase Storage/object storage is a later storage migration, not a connected service. Inventory/CRM JSON export includes evidence references, but not binary documents or review history. Use the private archive and restore-verification command for a complete backup:

```sh
npm run db:backup -- --verify-local
```

## Market intelligence and reviewed leads

The intelligence desk extends the existing source/worker/review foundation:

1. **Retain a batch:** select up to 100 PDF/CSV/TXT documents, at most 100 MB total and 10 MB per file, or paste a market brief. The client sends two bounded uploads at a time. Each file reports retained, duplicate, or failed; one failure does not undo other originals. Progress is visible while the dialog stays open. Originals and jobs persist in PostgreSQL even if the browser closes. Re-uploading the same bytes detects duplicates; existing sources can be queued from the inbox.
2. **Extract market signals:** the durable worker reads explicit market fields or a narrow order-headline grammar. Aircraft and market jobs are separate purposes on the same source. Source inbox supports selecting up to 100 existing documents for extraction. Failed jobs require an explicit retry. Selected public connectors can be collected by discovery agents; discovery produces source records and review candidates, never a confirmed buyer.
3. **Review signals:** every proposed field retains a passage, page and extraction method. Invalid or unsupported values are removed; unknowns remain unknown and conflicting observations stay visible. “Stated”, “Incomplete” and “Conflicting” describe the extracted evidence, not a probability that a buyer or availability is genuine.
4. **Qualify a lead:** review the source, complete organization/family/type as needed, attest and explain the decision. The original observations are immutable. Reviewed values, actor, notes and transitions are recorded separately. Supply and fleet activity may remain leads. Only reviewed Demand can advance to Potential requirement.
5. **Confirm a buyer brief:** record the buyer contact/reference, confirmation date and basis, then supply all required matching constraints. Organization, aircraft family, market and quantity must agree with the reviewed signal. Year and destination require explicit input; optional budget, deadline and engine constraints remain unset unless supplied. Confirmation and requirement creation are atomic and protected against concurrent or repeated decisions.
6. **Match and coordinate:** confirmed requirements use the existing deterministic matcher. Requirement cards link back to the signal; opportunities retain both aircraft review evidence and buyer confirmation evidence. A signal or lead alone never creates a requirement or opportunity.

Stages are **Signal → Lead → Potential requirement → Confirmed requirement**, with Dismissed available before confirmation. Each transition needs a note; promotion needs source-review attestation. Confirmed and dismissed records are terminal. The activity log retains previous decisions even though the modal displays the latest note. This is a founder review workflow; entering a confirmation is the founder's assertion, not independent verification by Aerion.

### Supported local market formats

```text
Organization: Example Meridian Aviation
Aircraft family: Airbus A319
Signal type: Demand
Market: Commercial
Geography: India
Event date: 2026-10-20
Quantity: 1
```

Separate signals with `---`. CSV headers are `organization,aircraftFamily,intent,market,geography,eventDate,quantity`; quoted cells are supported. Dates must be `YYYY-MM-DD`, quantity must be a positive integer, and market/type must use the listed values. The UI provides a clearly fictional example and CSV template; examples are loaded only on request.

Simple standalone headlines of the form `Organization orders 12 Aircraft Family aircraft` are classified as **Fleet activity**. They never establish current buying demand. Market, geography and event date are not inferred from the aircraft name, publisher or capture date. Complex prose, options versus firm-order breakdowns, and unlabelled requirements are deliberately unsupported by the local parser. Model-driven discovery agents can queue free-form market or aircraft extraction through the selected OpenAI, NVIDIA or local Ollama adapter. Output still requires exact retained evidence and the existing review workflow. Completed orders are fleet activity; they do not establish an open mandate. Batch extraction buttons use deterministic local parsing. The source inspector offers aircraft AI extraction with an explicit OpenAI, NVIDIA or local Ollama provider selector.

Filters cover organization, family, geography, market, type, stage and event recency. Unknown event dates are excluded from a recency filter; capture date is displayed separately. Signal results are paginated at 40 records; counts cover the full workspace and facet selectors show up to 200 distinct values, with free-text search available for the rest. Exact documents are deduplicated per workspace, repeated identical observations per source are deduplicated, and multiple independent sources remain separate evidence records.

### Storage boundary and evaluation

`src/server/storage.ts` owns original-byte retention and reads through a `DocumentStore` interface inside the caller's authorized transaction. PostgreSQL is the sole implementation. Replacing it with object storage will require an implementation, explicit locator/data migration and access tests; no cloud storage is silently enabled.

The evaluation fixtures in `src/lib/intelligence/market-fixtures.ts` contain short attributed excerpts from Airbus, Boeing and a Bombardier-issued release. Tests check supported order headlines, expected abstention on unsupported commercial/business prose, unknown dates/geography, conflicts, malformed values, absent evidence and negations. These are a small regression set, not an accuracy benchmark or market validation. Larger, representative founder-provided documents and live-model evaluation remain necessary before relying on broad free-form extraction.

The database integration suite also exercises 52-document retention/extraction, pagination, workspace isolation, immutable observations, interrupted leases, ordered approvals, future-confirmation refusal, concurrent confirmation and requirement evidence carried through an eligible match into an opportunity. Integration fixtures are removed from the dedicated test database. Any examples retained in the local preview are explicitly fictional.

### Earlier browser data

Open **Workspace settings** to import the previous `aerion:workspace:v1` browser backup into an empty server workspace. The migration validates the backup and preserves the original browser copy. Earlier source labels do not manufacture missing original documents. The earlier backup may include fictional demo data. A non-empty server workspace is never overwritten by migration.

### Authenticated hosting later

A Supabase password sign-in adapter is implemented using server cookies and server-confirmed `getUser()` identity. It has not been tested against a live project because cloud accounts are being deferred. It supports one private workspace per authenticated founder; invitations and team membership are not implemented.

Before hosting, configure a dedicated Postgres connection, run migrations, set `AERION_LOCAL_AUTH=false`, configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, and set `AERION_APP_ORIGIN` to the exact HTTPS browser origin. Run the web server and extraction worker as separate supervised services. Account creation is handled in Supabase, not this app. Moving the local founder's records to a cloud identity requires a deliberate ownership/data migration; signing in does not automatically claim the local identity's data.

## Validation

```sh
npm run lint
npm run typecheck
npm test
npm run evaluate
npm run build

# Dedicated integration database, never your business database:
createdb aerion_test
AERION_TEST_DATABASE_URL='postgresql:///aerion_test?host=/tmp' npm test
```

Integration tests require a database name ending in `_test`, apply checksum-tracked migrations, and clean up only their randomly generated workspaces. They cover cross-workspace access denial, immutable originals, concurrent approvals/writes, evidence linkage through matching and deals, missing-fact approval refusal, lease recovery, and origin enforcement. Unit tests cover CSV parsing, matching, evidence checks, conflicts, unknowns, and real PDF text parsing.

## Project structure

```text
src/app/api/          Authenticated request handlers and original downloads
src/components/       Workspace UI, source ingestion, evidence review, forms
src/lib/              Shared contracts, matching, local extraction, validation
src/server/           Scoped transactions, repository, document/model adapters, jobs
db/migrations/        Ordered, checksum-tracked PostgreSQL migrations
scripts/              Migration runner, development supervisor, extraction worker
```

No Git repository or commits have been created. Licensed inventory/market feeds, calendar delivery, cloud deployment, and autonomous external negotiations remain future options. The founder has deferred mailbox credentials and chosen local operation. The remaining path to actual commission is operational: qualify real counterparties, retain current requirements and seller authority/availability, obtain an actual signed engagement, complete the agreed service or transaction, issue the appropriate invoice and record funds actually received. The software does not infer these events from aircraft values or generated match scores.
