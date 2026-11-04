# Aerion — current implementation and operating plan

Updated 4 November 2026. This replaces the initial brainstorming plan with the founder’s chosen direction and the implemented product.

## Founder decisions

- Operate independently. A partnership or co-broker arrangement is not a prerequisite for this product.
- Build an internal aircraft sourcing and brokerage workspace, with AI agents handling research and preparation.
- Keep commercial aircraft and business aviation available until actual demand supports a focus.
- Develop locally first. Use PostgreSQL, NVIDIA Nemotron 3 Ultra and Brave Search with credentials kept server-side.
- Run on this computer initially. Finish and test the mailbox adapters now; configure the actual business mailbox later.
- Do not initialize a Git repository or create commits; the founder will do that.

## Product outcome

Sale and lease sourcing now retain distinct purchase and rent fields, with explicit lease currency and monthly/hourly basis. Unknown or incompatible terms remain in review. Source intake, matching, draft claims and transaction scope preserve those units; fees continue to use the actual signed engagement terms. This closes the earlier purchase-only sourcing gap while preserving existing workspace records.

A retained public signal can become a saved research lead, a reviewed business contact, a qualification enquiry, a source-backed Draft buyer brief, a founder-confirmed requirement, an eligible aircraft match and a connected opportunity with a reviewed offer draft. Replies support reviewed association, clarification and corrected assignments. The transaction workspace coordinates offers, milestone evidence, findings, closing and completion. Revenue records actual signed engagements, evidence-backed earning events, immutable invoices, incoming transfer allocations, paid expenses and reversals.

Seller discovery shares the contact and enquiry tools. Retained seller listings can enter the existing extraction/review pipeline and become approved inventory before matching.

## Implemented operating loop

1. Search buyer or seller sources through Brave, or inspect selected public URLs. Buyer modes distinguish explicit demand, fleet activity and company profiles.
2. Retain original publisher bytes and exact extracted passages. Search snippets stay separate from evidence.
3. Review proposed leads. Acceptance creates an immutable research lead and a working qualification record.
4. Research published contact details scoped to that lead. Review the evidence, then record or connect the CRM contact.
5. Prepare an initial qualification enquiry, review the recipient/content, then download it or explicitly approve its delivery through configured SMTP.
6. Import the response or use authorized read-only IMAP intake. Review the reply association, select the retained evidence and analyze it. Extracted requirements remain Draft and need founder review. Revised replies create a new Draft; wrong assignments have an audited correction path.
7. Record the contact, date and basis of a current requirement confirmation. Unknown constraints require more information.
8. Evaluate approved aircraft against the confirmed brief. The shortlist, recipient link, evidence-backed offer and Sourcing opportunity can be prepared atomically from an eligible match.
9. Review the exact offer and its source claims. Download it or separately approve its delivery. A context change blocks stale drafts.
10. Activate an engagement only with the actual signed source, client, fee payer, scope and fee/earning/payment terms. A Draft engagement can be prepared earlier.
11. Maintain follow-ups and progress through Sourcing, Offer, LOI, Agreement, Inspection and Closing using the required offer decisions, reviewed milestone evidence and named verifications. Resolve blocking findings before progressing.
12. Record completion with its retained closing source. A reopened cycle or obsolete buyer context cannot establish a new closing fee.
13. Record the agreed earning event, issue the invoice with actual issuer/payer details, and allocate only payments actually received. Partial receipts, shared transfers, expenses and reversals remain auditable.
14. Use Operations to monitor worker health, usage limits, failed jobs, ambiguous mail, acceptance history and restore-tested backups.

## Agent architecture

All twelve roles run through a durable scoped tool runtime: aircraft discovery, aircraft intelligence, buyer discovery, buyer requirements, matching, outreach, communication, CRM, negotiation, document intelligence, due diligence and deal coordination. Logical roles share a bounded worker; they do not require twelve separate model processes.

NVIDIA runs have at most six model requests, thirty tool calls and a three-minute execution budget. The sixth NVIDIA request is reserved for a final report. Invalid final citations can receive correction feedback within that budget. Proposals are persisted only after successful report validation and current-context checks.

Research, contact enrichment, Draft requirements and task preparation can be proposed by agents. Founder review controls business-record changes, current-requirement confirmation, aircraft publication, recipient/content review and external sending. The model does not establish source truth, transaction authority or completed communication by itself.

Diligence, coordination and negotiation now receive authoritative transaction and linked revenue context, with actual current-cycle offers, milestone states, findings, invoice dates and balances. They distinguish terminal outcomes from the legacy opportunity summary. Related source access is bounded to the selected requirement/aircraft; all related revisions, including records beyond visible limits, protect pending follow-ups against changed context. Coordination separates completion from fee earning, invoicing and receipts.

The expanded NVIDIA diligence and coordination checks each passed in four requests on fictional completed/active transactions with a partially paid invoice. Earlier failed reports and schema/citation diagnostics remain retained. The latest tests exercise actual tool runs, cross-case source denial, stale follow-up rejection, ended-agreement date consistency and one-serial offer scope. Matching supports literal bare or manufacturer-prefixed families at explicit token/variant boundaries; it does not infer ceo/neo aliases.

All twelve roles now have role-specific live-model capability acceptance records. Nine use isolated fictional retained-document workflows; discovery and document intelligence use the saved operational runs. Stored provider/model, report/trace hashes, citations, bounded usage and required proposed/applied actions are independently checked before a pass is recorded. Successful observed runs remain separate from explicit acceptance. The failed negotiation acceptance is preserved alongside the successful retry. This validates the bounded execution paths, not general aviation judgment or revenue outcomes.

## Local product components

| Area | Current capability |
| --- | --- |
| Source library | Original bytes, hashes, PDFs/text/CSV/EML, local English OCR, extraction queue and source review |
| Lead discovery | Bounded Brave queries, public URL inspection, buyer intent modes, retained evidence and cross-run deduplication |
| Qualification workspace | Contact research, CRM connection, immutable enquiry versions, reply attachments, scoped brief analysis and readiness tracking |
| Requirements and matches | Draft briefs, founder confirmation, deterministic eligibility checks and reviewed shortlist decisions |
| Execution and opportunities | Atomic opportunity/offer preparation, evidence claims, tasks, readiness records and Deal room links |
| Email | Read-only IMAP intake and explicitly approved SMTP delivery, with immutable snapshots and ambiguous-outcome reconciliation |
| Reply workflow | Exact EML retention, reviewed thread association, source-backed Draft analysis, separate revised briefs, corrected assignments and suppression guards |
| Transactions | Immutable offers/counteroffers and decisions, nine milestone groups, named verification records, blocking findings/resolutions, guarded progression and new cycles on reopen |
| Engagements and revenue | Signed fee snapshots, evidence-backed earning, immutable printable invoices, original incoming payments with bounded allocations, partial receipts, paid expenses and reversals |
| Agent Center | Saved runs, exact citations, proposal review, usage and tool history, optional schedules |
| Operations | Real worker heartbeat, queue/failure alerts, local daily caps, pause/resume, provenance-checked twelve-role acceptance and backup verification |
| Persistence | PostgreSQL migrations, owner-scoped forced RLS, immutable evidence, case revisions and append-only audit history |

## Validation and live evidence

The integrated release passes **361 tests across 39 files**, lint, TypeScript and a production build. All **15 migrations** match their saved checksums. Engineering acceptance uses a dedicated `_test` PostgreSQL database and clearly fictional records. It covers the buyer workflow through reviewed enquiry and matched-offer delivery with SMTP mocks, replies and corrected assignments, sale and lease sourcing, transaction completion, earned fees, invoices, receipts and expenses. It checks frozen source selection, context staleness, duplicate prevention, shared-payment allocation capacity, owner isolation, immutable evidence and concurrent revisions.

Browser validation uses an isolated test database and actual forms. Alongside qualification, it verified reply assignment/analysis/confirmation and corrected assignments; a full fictional transaction through all stages with nine verified milestone records and a resolved blocking finding; and an activated engagement, earning, issued invoice, partial/full receipts and expense. The fictional USD1,000 invoice with USD100 paid expense produced USD900 net recorded cash. No actual funds or authority were represented. Desktop and mobile checks cover document/dialog fit. Real business records are not replaced by fixtures.

A private database archive was restored into a newly created temporary local database on 3 November 2026. All 52 table row counts matched the consistent source snapshot, and all 51 forced-RLS table settings matched. The temporary database was removed; the private archive remains under `.aerion/backups/`. Repeat `npm run db:backup -- --verify-local` after important business changes. Credentials require a separate secure backup.

Live Brave and NVIDIA checks have retained seller pages and public buyer wanted notices. Their proposals remain pending founder review. A public acquisition notice is a sourcing lead; a current buyer requirement still needs direct confirmation. Failed and empty-result searches remain visible in history.

## Remaining operating setup

- Choose a business sender account and configure SMTP before approving any real email delivery. IMAP intake is optional; manual EML/text/PDF imports already work.
- Review and qualify the pending real buyer/seller candidates, obtain actual current constraints and resolve missing contact information.
- Review source-backed seller specifications before publishing operational inventory.
- Retain an actual signed client engagement and agreed fee terms before recording entitlement. Record only events that occurred and funds actually received.
- Keep PostgreSQL and `npm run dev` running for this computer's local web/worker operation. Inspect Operations and create restore-tested backups. No automatic login-time service is installed.
- If hosting is requested later, configure authenticated access, a supervised worker and deployment settings. Local development authentication is refused in production. The current local release does not require cloud accounts.

## Optional product work after a real sourcing cycle

Use actual workflow evidence to prioritize licensed inventory feeds, contact-research quality, source refresh, calendar delivery, payment-provider reconciliation or cloud operation. These are optional integrations rather than substitutes for qualifying counterparties. Measure retained pages, review corrections, qualified requirements, eligible matches, accepted engagements, completed services, issued invoices and received cash. Actual commission still depends on counterparties agreeing the fee and completing/payment for the agreed work; software cannot guarantee it.

## Current real research evidence

The 4 November review of the operational workspace found four pending public proposals, zero saved real leads and zero client engagements. The existing approved aircraft, requirements, contact and deals are explicitly fictional engineering examples. None establishes a real mandate or fee.

The strongest retained model/year research overlap is [IntelliJet's G280 wanted notice](https://intellijet.com/jets-wanted/) against [Avpro's advertised 2014 G280, serial 2028](https://www.avbuyer.com/aircraft/private-jets/gulfstream/g280/374905). The wanted notice reports 2013–2016, low hours, programs and EASA preferences; the retained listing reports 3,524 hours and engines/APU on MSP. The published sources do not establish current availability, acceptable hours, EASA status, budget, delivery timing or engagement/fee authority. IntelliJet is an intermediary describing represented demand; no end buyer has been identified to Aerion. No partnership or commission split is assumed. All real candidates remain pending founder review.

Public procurement pages also need deadline checks. [Air Astra's invitation](https://airastra.com/business-proposal) closed 31 May 2025, and [Maldivian's A220 invitation](https://maldivian.aero/media/2026/10/11/invitation-for-the-submission-of-proposals-for-operating-lease-of-two-airbus-a220-300-aircraft.html) closed 28 October 2026. Both remain readable online but were excluded from current opportunities on 3 November 2026. Recently indexed text is not proof of an open requirement. Buyer discovery instructions now require checking explicit deadlines against the workspace date; direct current confirmation remains necessary.
