import { readExecution } from "../execution";
import type { AgentReport, AgentProposal, Citation } from "../../lib/agents/schema";
import { proposalActionSchema } from "../../lib/agents/schema";
import { dueState, readinessDefinitions } from "../../lib/execution/schema";
import { calendarDate } from "../../lib/format";
import { extractLocally } from "../../lib/intelligence/extract";
import { validateEvidence } from "../../lib/intelligence/schema";
import {
  extractMarketLocally,
  validateMarketEvidence,
} from "../../lib/intelligence/market-extract";
import { type AgentTools, sourceCitations } from "./tools";
import { passagesForLabel } from "./evidence";
import { isRevisedReplyAnalysis } from "../communication/context";
import type { CommercialContext } from "./commercial-context";
import { commercialInsights } from "./commercial-rules";
import {
  hasLeaseLanguage,
  hasSaleLanguage,
  leaseBasisSupported,
  purchaseAmountSupported,
} from "../../lib/intelligence/commercial-evidence";

/** Explicit deterministic mode: real tools and persisted work, with no claim of language-model reasoning. */
export async function runRules(tools: AgentTools): Promise<AgentReport> {
  const { run } = tools,
    data = await tools.data(),
    today = calendarDate();
  await tools.invoke("workspace_context", {});
  const findings: AgentReport["findings"] = [],
    limitations = [
      "This run used deterministic rules, not a language model. Unlabelled prose may require the configured AI provider.",
      "Original-source claims, buyer intent, seller authority and technical/legal conclusions still need review.",
    ];
  const add = (
    title: string,
    detail: string,
    severity: "info" | "review" | "missing" = "review",
    citations: Citation[] = [],
  ) => findings.push({ title, detail, severity, citations });
  const propose = async (p: AgentProposal) => {
    try {
      await tools.invoke("propose_action", p);
    } catch (e) {
      add(
        "Proposal needs more evidence",
        e instanceof Error ? e.message : "The proposal could not be supported.",
        "missing",
        p.citations,
      );
    }
  };
  const task = async (
    title: string,
    detail: string,
    dueDate: string | null = today,
    kind: "Follow-up" | "Question" = "Follow-up",
  ) => {
    if (!run.input.requirementId) return;
    const desk = await readDesk();
    if (desk?.actions.some((a) => a.status === "Open" && a.title === title)) return;
    await propose({
      title,
      reason: "Prepared from the current case's recorded gaps and next actions.",
      action: {
        type: "execution",
        requirementId: run.input.requirementId,
        action: { type: "add-action", kind, title, detail, dueDate },
      },
      citations: [],
    });
  };
  const readDesk = async () => {
    const id = run.input.requirementId;
    return id ? readExecution(tools.scope, id) : null;
  };

  if (run.input.discovery) {
    const manifest = (await tools.invoke("discover_sources", {})) as {
      results: { id: string; title: string }[];
    };
    for (const result of manifest.results.slice(0, 3)) {
      try {
        const page = (await tools.invoke("inspect_discovery_source", { resultId: result.id })) as {
          sourceId: string;
          text: string;
        };
        add(
          `Retained public page: ${result.title}`,
          "Original bytes and readable text are available in the source library. Use a configured AI provider to propose structured leads, or review the page yourself.",
          "info",
          [{ sourceId: page.sourceId, page: 1, quote: page.text.slice(0, 1000) }],
        );
      } catch (error) {
        add(
          `Could not inspect: ${result.title}`,
          error instanceof Error ? error.message : "Public collection failed.",
          "missing",
        );
      }
    }
    if (!manifest.results.length)
      add("No public results", "Try a more specific query or supply a public URL.", "missing");
    return {
      summary:
        "Public-source intake completed. Deterministic collection does not infer structured buyer or seller leads.",
      findings,
      limitations,
    };
  }

  if (["aircraft-discovery", "buyer-discovery"].includes(run.agentId)) {
    const purpose = run.agentId === "aircraft-discovery" ? "aircraft" : "market";
    await tools.invoke("approved_sources", {});
    for (const connector of (await tools.connectors())
      .filter((c) => c.purpose === purpose)
      .slice(0, 2)) {
      try {
        await tools.invoke("collect_source", { connectorId: connector.id });
        add(
          `Collected ${connector.name}`,
          `The configured ${connector.format} source was retained with its original bytes.`,
          "info",
        );
      } catch (e) {
        add(
          `Collection stopped: ${connector.name}`,
          e instanceof Error ? e.message : "Collection failed.",
          "missing",
        );
      }
    }
    const sources = await tools.sources();
    if (!sources.length)
      add(
        "Choose sources to inspect",
        "Select retained documents or configured public connectors. No source was invented or searched without a configured URL.",
        "missing",
      );
    for (const source of sources.slice(0, 12)) {
      try {
        const observations =
          purpose === "aircraft"
            ? validateEvidence(extractLocally(source.pages, source.kind), source.pages, source.kind)
            : validateMarketEvidence(extractMarketLocally(source.pages, source.kind), source.pages);
        if (!observations.some((o) => o.facts.length)) continue;
        await tools.invoke("queue_extraction", { sourceId: source.id, purpose });
        add(
          `Queued ${purpose} review: ${source.title}`,
          `${observations.length} observation group(s) recognized. Extraction creates pending review records; it does not approve aircraft or establish buyer demand.`,
          "info",
          sourceCitations(source, 2),
        );
      } catch {
        add(
          `AI or clearer labels needed: ${source.title}`,
          "The local parser could not identify supported labelled observations. The original remains retained.",
          "missing",
          sourceCitations(source, 1),
        );
      }
    }
    if (purpose === "market") await tools.invoke("market_signals", {});
  }
  if (run.agentId === "aircraft-intelligence") {
    const aircraft = data.aircraft.find((a) => a.id === run.input.aircraftId);
    if (!aircraft)
      add(
        "Select an aircraft",
        "An aircraft is needed for an aircraft-specific sourcing summary.",
        "missing",
      );
    else {
      const evidence = (await tools.invoke("aircraft_evidence", {})) as {
        sourceId?: string;
        facts?: import("../../lib/intelligence/schema").Fact[];
      };
      const relevant = new Set([
        "manufacturer",
        "model",
        "serial",
        "year",
        "hours",
        "cycles",
        "price",
        "offering",
        "leaseRate",
        "leaseCurrency",
        "leaseBasis",
        "availableDate",
      ]);
      const evidenceSourceId = evidence.sourceId;
      const citations: Citation[] = evidenceSourceId
        ? (evidence.facts ?? [])
            .filter((f) => relevant.has(f.field) && aircraft[f.field] === f.value)
            .map((f) => ({ sourceId: evidenceSourceId, page: f.page, quote: f.quote }))
            .slice(0, 12)
        : [];
      add(
        `${aircraft.manufacturer} ${aircraft.model} · ${aircraft.serial}`,
        `Recorded build year ${aircraft.year}; calendar age ${Number(today.slice(0, 4)) - aircraft.year} years. Reported hours: ${aircraft.hours ?? "unknown"}; cycles: ${aircraft.cycles ?? "unknown"}; offering: ${aircraft.offering ?? "Sale (legacy record)"}; purchase asking USD: ${aircraft.price ?? "unknown"}; lease rate: ${aircraft.leaseRate ?? "unknown"} ${aircraft.leaseCurrency ?? "currency unknown"} (${aircraft.leaseBasis ?? "basis unknown"}). Reported availability: ${aircraft.availableDate ?? "unknown"}.`,
        "review",
        citations,
      );
      const missing = [
        aircraft.engine === "Not supplied" ? "engine identity" : null,
        aircraft.hours === null ? "flight hours" : null,
        aircraft.cycles === null ? "cycles" : null,
        ["Sale", "Sale or lease"].includes(aircraft.offering ?? "Sale") && aircraft.price === null
          ? "current purchase asking terms"
          : null,
        ["Lease", "Sale or lease"].includes(aircraft.offering ?? "Sale") &&
        (aircraft.leaseRate == null || !aircraft.leaseCurrency || !aircraft.leaseBasis)
          ? "current lease rate, currency and basis"
          : null,
        aircraft.offering === "Not supplied" ? "offered sale/lease transaction" : null,
        !aircraft.availableDate ? "availability date" : null,
      ].filter(Boolean);
      if (missing.length) add("Missing aircraft information", missing.join(", "), "missing");
      add(
        "Technical records require review",
        "Current engine status, life-limited parts, maintenance events, configuration and airworthiness are not established by the inventory summary.",
        "missing",
      );
      await tools.invoke("market_comparables", {});
    }
  }
  if (run.agentId === "buyer-requirements") {
    const sources = await tools.sources();
    if (!sources.length)
      add(
        "Choose the retained buyer brief",
        "The requirement agent needs the original communication or buyer brief. Existing requirement context can be matched, but it does not establish new source statements.",
        "missing",
      );
    for (const source of sources.slice(0, 5)) {
      const get = (labels: string[]) =>
        labels.flatMap((label) => passagesForLabel(source.pages, label))[0];
      const commercialLabel = (pattern: RegExp) =>
        source.pages.flatMap((page) =>
          page.text.split(/\r?\n/).flatMap((line) => {
            const match = /^\s*([^:]+):\s*(.+)$/.exec(line);
            return match && pattern.test(match[1].trim())
              ? [{ value: match[2].trim(), page: page.page, quote: line.trim() }]
              : [];
          }),
        )[0];
      const fields = {
        client: get(["Client", "Buyer", "Organization"]),
        aircraftModel: get(["Aircraft family", "Aircraft model"]),
        category: get(["Category", "Market"]),
        quantity: get(["Quantity"]),
        minYear: get(["Minimum year", "MinYear"]),
        engine: get(["Engine"]),
        budget: get(["Purchase budget USD", "Sale budget USD", "Budget USD"]),
        transactionKind: get([
          "Transaction kind",
          "Transaction type",
          "Transaction",
          "Requirement type",
        ]),
        leaseBudget: commercialLabel(/^(?:lease|monthly|hourly)\s+budget\b/i),
        leaseCurrency: get(["Lease currency", "Currency"]),
        leaseBasis: get(["Lease basis", "Lease budget basis", "Lease rate basis"]),
        modeEvidence: source.pages.flatMap((page) =>
          page.text
            .split(/\r?\n/)
            .filter((line) => hasLeaseLanguage(line) || hasSaleLanguage(line))
            .map((line) => ({ value: line.trim(), page: page.page, quote: line.trim() })),
        )[0],
        deadline: get(["Delivery deadline", "Deadline"]),
        destination: get(["Destination"]),
      };
      const commercialText = Object.values(fields)
        .filter(Boolean)
        .map((field) => field?.quote)
        .join("\n");
      const kindText =
        fields.transactionKind?.value ?? source.pages.map((page) => page.text).join("\n");
      const transactionKind = hasLeaseLanguage(kindText)
        ? hasSaleLanguage(kindText)
          ? "Not supplied"
          : "Lease"
        : hasSaleLanguage(kindText) || fields.budget
          ? "Sale"
          : "Not supplied";
      const rental =
        fields.leaseBudget ?? (transactionKind === "Lease" ? fields.budget : undefined);
      const rentalText = [rental?.quote, fields.leaseCurrency?.quote, fields.leaseBasis?.quote]
        .filter(Boolean)
        .join("\n");
      const leaseCurrency =
        fields.leaseCurrency?.value.toUpperCase() ??
        rental?.quote
          .match(/\b(?:USD|EUR|GBP|INR|AED|CHF|CAD|AUD|SGD|JPY|KWD)\b/i)?.[0]
          .toUpperCase() ??
        null;
      const leaseBasis = leaseBasisSupported(rentalText, "Monthly rent")
        ? "Monthly rent"
        : leaseBasisSupported(rentalText, "Hourly rate")
          ? "Hourly rate"
          : null;
      const rentalAmount = rental?.value.match(
        /^(?:[A-Z]{3}\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(?:[A-Z]{3})?\s*(?:(?:per|\/)\s*(?:month|mo|mth|hour|hr))?)?$/i,
      )?.[1];
      const purchaseBudget =
        transactionKind === "Sale" &&
        fields.budget &&
        purchaseAmountSupported(
          fields.budget.quote,
          Number(fields.budget.value.replace(/,/g, "")),
          { candidateText: commercialText },
        )
          ? Number(fields.budget.value.replace(/,/g, ""))
          : null;
      const required = [
        "client",
        "aircraftModel",
        "category",
        "quantity",
        "minYear",
        "destination",
      ] as const;
      const missing = required.filter((key) => !fields[key]);
      if (missing.length) {
        add(
          `Clarify ${source.title}`,
          `Required matching fields not explicitly labelled: ${missing.join(", ")}. No defaults were supplied.`,
          "missing",
          sourceCitations(source, 2),
        );
        for (const key of missing.slice(0, 4))
          await task(
            `Clarify buyer brief: ${key}`,
            `Obtain an explicit ${key} value from the buyer and retain the communication.`,
            null,
            "Question",
          );
        continue;
      }
      const parsed = proposalActionSchema.safeParse({
        type: "requirement",
        leadId: run.input.leadId,
        values: {
          client: fields.client?.value,
          aircraftModel: fields.aircraftModel?.value,
          category: fields.category?.value,
          quantity: Number(fields.quantity?.value),
          minYear: Number(fields.minYear?.value),
          engine: fields.engine?.value ?? "",
          transactionKind,
          budget: purchaseBudget,
          leaseBudget:
            transactionKind === "Lease" && rentalAmount && leaseCurrency && leaseBasis
              ? Number(rentalAmount.replace(/,/g, ""))
              : null,
          leaseCurrency: transactionKind === "Lease" ? leaseCurrency : null,
          leaseBasis: transactionKind === "Lease" ? leaseBasis : null,
          deadline: fields.deadline?.value ?? null,
          destination: fields.destination?.value,
          description:
            "Draft prepared from the retained buyer brief; founder confirmation still required.",
        },
      });
      if (!parsed.success) {
        add(
          "Brief values need clarification",
          parsed.error.issues.map((i) => i.path.join(".")).join(", "),
          "missing",
          sourceCitations(source, 2),
        );
        continue;
      }
      if (
        data.requirements.some(
          (r) =>
            r.client === fields.client?.value && r.aircraftModel === fields.aircraftModel?.value,
        ) &&
        !(await isRevisedReplyAnalysis(tools.scope, run.id))
      ) {
        add(
          "An existing brief matches this client and family",
          "Review the saved requirement before adding another brief.",
          "review",
          sourceCitations(source, 2),
        );
        continue;
      }
      let citations = Object.values(fields)
        .filter((v): v is NonNullable<typeof v> => Boolean(v))
        .map((v) => ({ sourceId: source.id, page: v.page, quote: v.quote }));
      citations = [
        ...new Map(
          citations.map((citation) => [`${citation.page}:${citation.quote}`, citation]),
        ).values(),
      ];
      // Group short labelled briefs into their original contiguous passage, retaining every required field.
      citations = source.pages.flatMap((page) => {
        const selected = citations.filter((citation) => citation.page === page.page);
        if (!selected.length) return [];
        const starts = selected.map((citation) => page.text.indexOf(citation.quote));
        const begin = Math.min(...starts),
          end = Math.max(
            ...selected.map((citation, index) => starts[index] + citation.quote.length),
          );
        return begin >= 0 && end - begin <= 1500
          ? [{ sourceId: source.id, page: page.page, quote: page.text.slice(begin, end) }]
          : selected;
      });
      await propose({
        title: `Draft buyer requirement: ${fields.client?.value}`,
        reason:
          "Required fields are explicitly stated in the retained buyer brief. Confirmation remains pending.",
        action: parsed.data,
        citations,
      });
    }
    if (run.input.requirementId) await tools.invoke("match_aircraft", {});
  }
  if (run.agentId === "matching") {
    await tools.invoke("match_aircraft", {});
    await tools.invoke("case_context", {});
    const desk = await readDesk();
    if (!desk)
      add(
        "Select a requirement",
        "Choose the buyer requirement whose hard constraints should be evaluated.",
        "missing",
      );
    else {
      const eligible = desk.matches.filter((m) => m.state === "eligible"),
        unknown = desk.matches.filter((m) => m.state === "needs-review");
      add(
        "Sourcing evaluation",
        `${eligible.length} eligible, ${unknown.length} needing more information, ${desk.matches.filter((m) => m.state === "excluded").length} excluded. Scores rank preferences and do not establish technical suitability.`,
        "info",
      );
      if (!desk.confirmation)
        add(
          "Founder confirmation is missing",
          "Record the confirming contact, date and basis in the execution desk before shortlisting.",
          "missing",
        );
      else
        for (const match of eligible.slice(0, 5)) {
          const prior = desk.decisions.find((d) => d.aircraftId === match.aircraft.id);
          if (prior) continue;
          await propose({
            title: `Shortlist ${match.aircraft.manufacturer} ${match.aircraft.model} · ${match.aircraft.serial}`,
            reason: match.checks
              .map((c) => `${c.label}: ${c.detail}`)
              .join("; ")
              .slice(0, 2000),
            action: {
              type: "execution",
              requirementId: desk.requirement.id,
              action: {
                type: "shortlist",
                aircraftId: match.aircraft.id,
                decision: "Shortlisted",
                reason:
                  "Known sourcing constraints pass. Current availability, representation and transaction suitability still require confirmation.",
              },
            },
            citations: [],
          });
        }
      for (const match of unknown.slice(0, 3))
        for (const check of match.checks.filter((c) => c.result === "unknown").slice(0, 2))
          await task(
            `Resolve ${check.label}: ${match.aircraft.serial}`,
            check.detail,
            null,
            "Question",
          );
    }
  }
  if (run.agentId === "outreach") {
    await tools.invoke("case_context", {});
    const desk = await readDesk();
    if (!desk)
      add(
        "Select a requirement",
        "Outreach needs a saved requirement and its execution context.",
        "missing",
      );
    else if (!desk.confirmation)
      add(
        "Record brief confirmation first",
        "A saved Confirmed status alone is insufficient for attributed outreach.",
        "missing",
      );
    else {
      const candidates = desk.matches.filter(
        (m) =>
          m.state === "eligible" &&
          desk.decisions.some(
            (d) => d.aircraftId === m.aircraft.id && d.decision === "Shortlisted",
          ) &&
          (!run.input.aircraftId || m.aircraft.id === run.input.aircraftId),
      );
      const recipients = desk.contacts.filter(
        (c) =>
          ["Buyer", "Seller", "Broker"].includes(c.type) &&
          (!run.input.contactId || c.id === run.input.contactId),
      );
      if (!candidates.length)
        add(
          "Shortlist an eligible aircraft",
          "No selected candidate meets both the match and shortlist prerequisites.",
          "missing",
        );
      if (!recipients.length)
        add(
          "Link a recipient",
          "A linked buyer, seller or broker contact is required. Contact authority is not inferred.",
          "missing",
        );
      for (const { aircraft } of candidates.slice(0, 2))
        for (const contact of recipients.slice(0, 2)) {
          const audience = contact.type === "Seller" ? "Seller" : "Buyer";
          if (
            desk.drafts.some(
              (d) =>
                d.aircraftId === aircraft.id &&
                d.contactId === contact.id &&
                d.audience === audience &&
                !d.stale &&
                d.status !== "Archived",
            )
          )
            continue;
          await propose({
            title: `Prepare ${audience.toLowerCase()} draft for ${contact.name}`,
            reason:
              "Use the eligible shortlisted aircraft, linked recipient and recorded brief with the retained claim register.",
            action: {
              type: "execution",
              requirementId: desk.requirement.id,
              action: {
                type: "prepare-draft",
                aircraftId: aircraft.id,
                contactId: contact.id,
                audience,
              },
            },
            citations: [],
          });
        }
      add(
        "Draft preparation remains reviewable",
        "Accepted proposals create local drafts with immutable text and claim evidence. They do not send messages or record a draft review.",
        "info",
      );
    }
  }
  if (run.agentId === "communication" && run.input.allowMailbox) {
    const intake = (await tools.invoke("collect_mailbox", {})) as {
      messages: unknown[];
      issues: string[];
    };
    add(
      "Mailbox originals retained",
      `${intake.messages.length} message(s) collected without changing mailbox flags or messages.`,
      "info",
    );
    for (const issue of intake.issues) add("Mailbox intake needs review", issue, "review");
  }
  if (["documents", "communication", "due-diligence"].includes(run.agentId)) {
    const sources = await tools.sources();
    if (!sources.length)
      add(
        "Choose supporting documents",
        "Select retained documents or link sources through the requirement/aircraft context.",
        "missing",
      );
    const technical = new Map<string, { value: string; citation: Citation }[]>();
    const selectedSerial = data.aircraft.find((a) => a.id === run.input.aircraftId)?.serial;
    for (const source of sources.slice(0, 6)) {
      const identities = [
        ...new Set(
          ["Aircraft serial", "Serial", "MSN"].flatMap((label) =>
            passagesForLabel(source.pages, label).map((v) => v.value),
          ),
        ),
      ];
      const documentSubject =
        identities.length === 1 ? identities[0] : identities.length === 0 ? selectedSerial : null;
      if (
        documentSubject &&
        selectedSerial &&
        documentSubject.toLowerCase() !== selectedSerial.toLowerCase()
      )
        add(
          "Document identity differs from selected aircraft",
          `${source.title} identifies ${documentSubject}; the selected aircraft serial is ${selectedSerial}. Resolve the association before using this document for the selected aircraft.`,
          "review",
          sourceCitations(source, 1),
        );
      let currentSubject = documentSubject ?? source.id;
      for (const page of source.pages.slice(0, 4)) {
        await tools.invoke("source_passages", { sourceId: source.id, page: page.page, offset: 0 });
        for (const line of page.text.split(/\r?\n/)) {
          if (/^\s*---+\s*$/.test(line)) {
            currentSubject = documentSubject ?? source.id;
            continue;
          }
          const match = line.match(/^\s*([^:]{2,120}):\s*(.{1,300})$/);
          if (match && /^(aircraft serial|serial|msn)$/i.test(match[1].trim()))
            currentSubject = match[2].trim();
          if (
            !match ||
            !/engine|llp|life|maintenance|inspection|cycles|hours|title|authority|serial|availability/i.test(
              match[1],
            )
          )
            continue;
          const key = `${currentSubject} · ${match[1].trim().toLowerCase()}`,
            observations = technical.get(key) ?? [];
          observations.push({
            value: match[2].trim(),
            citation: { sourceId: source.id, page: page.page, quote: line.trim().slice(0, 1500) },
          });
          technical.set(key, observations);
        }
      }
      if (["documents", "communication"].includes(run.agentId)) {
        try {
          if (
            validateEvidence(
              extractLocally(source.pages, source.kind),
              source.pages,
              source.kind,
            ).some((c) => c.facts.length)
          )
            await tools.invoke("queue_extraction", { sourceId: source.id, purpose: "aircraft" });
        } catch {
          add(
            `Document observations: ${source.title}`,
            "The retained text is available for review. The local aircraft parser could not establish labelled aircraft fields.",
            "review",
            sourceCitations(source, 2),
          );
        }
      }
    }
    for (const [field, observations] of technical) {
      const values = [...new Set(observations.map((o) => o.value))];
      if (values.length > 1) {
        add(
          `Potential discrepancy: ${field}`,
          `${values.join(" versus ")}. Compare reporting dates, units and scope before treating these observations as inconsistent.`,
          "review",
          observations.map((o) => o.citation).slice(0, 12),
        );
        await task(
          `Resolve document discrepancy: ${field}`,
          "Compare the cited source passages and obtain a dated clarification. Do not overwrite approved records automatically.",
          null,
          "Question",
        );
      } else if (findings.length < 35)
        add(
          `Source observation: ${field}`,
          values[0],
          "review",
          observations.map((o) => o.citation).slice(0, 4),
        );
    }
  }
  if (["communication", "crm"].includes(run.agentId)) {
    const history = (await tools.invoke("contact_history", {})) as {
      submissions: {
        contactId: string;
        status: string;
        occurredOn: string | null;
        subject: string;
      }[];
      interactions: {
        contactId: string;
        occurredOn: string;
        summary: string;
        sourceId: string;
        direction: string;
      }[];
    };
    const contacts = run.input.contactId
      ? data.contacts.filter((c) => c.id === run.input.contactId)
      : data.contacts.slice(0, 20);
    for (const contact of contacts) {
      const interaction = history.interactions.find((i) => i.contactId === contact.id);
      const submission = history.submissions.find(
        (item) => item.contactId === contact.id && item.status === "accepted" && item.occurredOn,
      );
      const latest =
        submission?.occurredOn && (!interaction || submission.occurredOn > interaction.occurredOn)
          ? {
              occurredOn: submission.occurredOn,
              summary: `SMTP server accepted: ${submission.subject}. Recipient delivery and reply are unknown.`,
            }
          : interaction;
      if (!latest)
        add(
          `Interaction date unknown: ${contact.name}`,
          "No retained interaction has been recorded for this contact. A relationship or last-contact date was not invented.",
          "missing",
        );
      else {
        const days = Math.floor((Date.parse(today) - Date.parse(latest.occurredOn)) / 86400000);
        add(
          `Last recorded contact activity: ${contact.name}`,
          `${latest.occurredOn} · ${days} calendar days ago. ${latest.summary}`,
          "info",
        );
        if (days >= 30)
          await task(
            `Review follow-up with ${contact.name}`,
            `The last recorded interaction was ${latest.occurredOn}. Check current relevance before outreach.`,
          );
      }
      if (run.input.requirementId) {
        const desk = await readDesk();
        if (desk && !desk.contacts.some((c) => c.id === contact.id))
          await propose({
            title: `Link ${contact.name} to this requirement`,
            reason:
              "Founder review is needed to confirm this saved contact is relevant to the selected case.",
            action: {
              type: "execution",
              requirementId: run.input.requirementId,
              action: { type: "link-contact", contactId: contact.id },
            },
            citations: [],
          });
      }
    }
    for (const source of (await tools.sources()).slice(0, 5)) {
      const labels = (key: string) => passagesForLabel(source.pages, key)[0];
      const email = labels("Contact email"),
        date = labels("OccurredOn"),
        direction = labels("Direction"),
        summary = labels("Summary");
      const contact = contacts.find((c) => c.email.toLowerCase() === email?.value.toLowerCase());
      if (contact && email && date && direction && summary) {
        const parsed = proposalActionSchema.safeParse({
          type: "interaction",
          contactId: contact.id,
          requirementId: run.input.requirementId,
          sourceId: source.id,
          occurredOn: date.value,
          direction: direction.value,
          summary: summary.value,
        });
        if (
          parsed.success &&
          !history.interactions.some(
            (i) =>
              i.contactId === contact.id &&
              i.sourceId === source.id &&
              i.direction === direction.value,
          )
        )
          await propose({
            title: `Record interaction with ${contact.name}`,
            reason:
              "The retained communication explicitly supplies the contact, date, direction and summary.",
            action: parsed.data,
            citations: [email, date, direction, summary].map((v) => ({
              sourceId: source.id,
              page: v.page,
              quote: v.quote,
            })),
          });
      }
      if (run.agentId === "crm") {
        const keys = {
          name: "Name",
          role: "Role",
          company: "Company",
          email: "Email",
          location: "Location",
          type: "Contact type",
        } as const;
        const fields = Object.fromEntries(
          Object.entries(keys).map(([key, label]) => [key, labels(label)]),
        );
        if (Object.values(fields).every(Boolean)) {
          const parsed = proposalActionSchema.safeParse({
            type: "contact",
            values: {
              ...Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, v?.value])),
              notes:
                "Prepared from a retained source; relationship and authority require founder review.",
            },
          });
          if (
            parsed.success &&
            !data.contacts.some((c) => c.email.toLowerCase() === fields.email?.value.toLowerCase())
          )
            await propose({
              title: `Create sourced contact: ${fields.name?.value}`,
              reason:
                "Identity, role, organization, address, location and contact type are explicitly stated.",
              action: parsed.data,
              citations: observed(Object.values(fields)).map((v) => ({
                sourceId: source.id,
                page: v.page,
                quote: v.quote,
              })),
            });
        }
      }
    }
  }
  if (["due-diligence", "deal-coordination"].includes(run.agentId)) {
    const caseContext = (await tools.invoke("case_context", {})) as {
      commercial?: CommercialContext;
    };
    const commercial = caseContext.commercial;
    const desk = await readDesk();
    if (!desk)
      add(
        "Select a requirement",
        "Choose a saved requirement to inspect connected opportunities and readiness evidence.",
        "missing",
      );
    else {
      if (commercial) {
        const insights = commercialInsights(
          commercial,
          today,
          run.agentId === "due-diligence" ? "due-diligence" : "deal-coordination",
        );
        findings.unshift(...insights.findings);
        for (const action of insights.tasks)
          await task(action.title, action.detail, action.dueDate);
      }
      for (const definition of commercial?.transactions.some((item) => item.managed)
        ? []
        : readinessDefinitions) {
        const item = desk.readiness.find((i) => i.key === definition.key);
        if (!item || item.status === "Missing") {
          add(
            `Missing: ${definition.title}`,
            "No current received evidence is recorded for this readiness group.",
            "missing",
          );
          if (run.agentId === "due-diligence")
            await task(
              `Obtain evidence: ${definition.title}`,
              "Request the specific record, retain its original and record receipt before review.",
            );
        } else add(`${definition.title}: ${item.status}`, item.note, "review", []);
      }
      for (const action of desk.actions.filter((a) => a.status === "Open")) {
        const due = dueState(action, today);
        if (due === "Overdue" || due === "Due today")
          add(`${due}: ${action.title}`, `${action.dueDate} · ${action.detail}`, "review");
      }
      for (const deal of desk.deals
        .filter(
          (deal) =>
            (!run.input.aircraftId || deal.aircraftId === run.input.aircraftId) &&
            !commercial?.transactions.some((item) => item.dealId === deal.id && item.managed),
        )
        .slice(0, 5)) {
        add(
          `Opportunity: ${deal.title}`,
          `Legacy summary ${deal.stage}; next action ${deal.nextAction}; due ${deal.dueDate}. No managed transaction is shown for this opportunity. Open its transaction workspace before inferring commercial progress or completion.`,
          "info",
        );
        if (run.agentId === "deal-coordination")
          await task(deal.nextAction, `Connected opportunity: ${deal.title}`, deal.dueDate);
      }
      if (
        run.agentId === "deal-coordination" &&
        !commercial?.coverage.transactions.truncated &&
        (commercial?.transactions.filter(
          (item) => item.status === "Completed" && !item.contextChanged,
        ).length ?? 0) < desk.requirement.quantity
      )
        for (const match of desk.matches
          .filter(
            (m) =>
              m.state === "eligible" &&
              (!run.input.aircraftId || m.aircraft.id === run.input.aircraftId) &&
              desk.decisions.some(
                (d) => d.aircraftId === m.aircraft.id && d.decision === "Shortlisted",
              ) &&
              !desk.deals.some((d) => d.aircraftId === m.aircraft.id),
          )
          .slice(0, 3))
          await propose({
            title: `Create opportunity: ${match.aircraft.serial}`,
            reason:
              "The candidate is eligible and founder-shortlisted; no opportunity exists for this requirement/aircraft pair.",
            action: {
              type: "deal",
              requirementId: desk.requirement.id,
              aircraftId: match.aircraft.id,
              nextAction:
                "Reconfirm current availability and representation with retained evidence",
              dueDate: today,
            },
            citations: [],
          });
    }
  }
  if (run.agentId === "negotiation") {
    if (run.input.requirementId) await tools.invoke("case_context", {});
    const result = (await tools.invoke("market_comparables", {})) as {
      comparables: {
        sourceId: string;
        manufacturer: string;
        model: string;
        year: number;
        amountUsd: number;
        basis: string;
        reportedOn: string;
        citations: Citation[];
      }[];
    };
    const aircraft = data.aircraft.find((a) => a.id === run.input.aircraftId);
    if (!aircraft)
      add(
        "Select an aircraft",
        "Choose the aircraft whose recorded asking terms should be compared.",
        "missing",
      );
    else {
      const relevant = result.comparables.filter(
        (c) => c.manufacturer === aircraft.manufacturer && c.model === aircraft.model,
      );
      if (!relevant.length)
        add(
          "No reviewed same-model comparables",
          "Retain dated comparable documents and review the observations. A negotiation range was not invented.",
          "missing",
        );
      for (const c of relevant.slice(0, 10))
        add(
          `Comparable: ${c.basis}`,
          `Reported ${c.reportedOn}: USD ${c.amountUsd}. ${aircraft.price !== null && c.basis === "Asking price" ? `The recorded aircraft asking price is USD ${aircraft.price - c.amountUsd} above this asking observation.` : "This observation is not directly comparable to an asking price without reviewing its basis."} Year, utilization, condition and terms remain material.`,
          "review",
          c.citations,
        );
    }
    for (const source of (await tools.sources()).slice(0, 5)) {
      const label = (s: string) => passagesForLabel(source.pages, s)[0];
      const fields = {
        manufacturer: label("Manufacturer"),
        model: label("Model"),
        year: label("Year"),
        amountUsd: label("Amount USD"),
        basis: label("Basis"),
        reportedOn: label("ReportedOn"),
      };
      if (!Object.values(fields).every(Boolean)) continue;
      const parsed = proposalActionSchema.safeParse({
        type: "comparable",
        sourceId: source.id,
        ...Object.fromEntries(
          Object.entries(fields).map(([key, v]) => [
            key,
            ["year", "amountUsd"].includes(key) ? Number(v?.value.replace(/,/g, "")) : v?.value,
          ]),
        ),
        notes: "Source observation; review comparability before commercial use.",
      });
      if (
        parsed.success &&
        !result.comparables.some(
          (c) =>
            c.sourceId === source.id &&
            c.model === fields.model?.value &&
            c.year === Number(fields.year?.value) &&
            c.amountUsd === Number(fields.amountUsd?.value.replace(/,/g, "")) &&
            c.basis === fields.basis?.value &&
            c.reportedOn === fields.reportedOn?.value,
        )
      )
        await propose({
          title: `Record comparable: ${fields.model?.value}`,
          reason:
            "Model, build year, USD amount, price basis and reporting date are explicitly stated.",
          action: parsed.data,
          citations: observed(Object.values(fields)).map((v) => ({
            sourceId: source.id,
            page: v.page,
            quote: v.quote,
          })),
        });
    }
    await task(
      "Clarify commercial and maintenance assumptions",
      "Confirm asking terms, current maintenance status, configuration, utilization, representation and compensation terms before considering a commercial response.",
      null,
      "Question",
    );
  }
  if (!findings.length)
    add(
      "Review proposed actions",
      `${tools.staged.length} evidence-linked action proposal(s) were prepared for founder review.`,
      "info",
    );
  return {
    summary: `${agentLabel(run.agentId)} completed its deterministic tool workflow. ${tools.staged.length} action proposal(s) await review; no external message or transaction was executed.`,
    findings: findings.slice(0, 60),
    limitations,
  };
}
import { agentById, type AgentId } from "../../lib/agents/catalog";
const agentLabel = (id: AgentId) => agentById(id).name;

type LabelObservation = ReturnType<typeof passagesForLabel>[number];
function observed(items: (LabelObservation | undefined)[]) {
  return items.filter((item): item is LabelObservation => Boolean(item));
}
