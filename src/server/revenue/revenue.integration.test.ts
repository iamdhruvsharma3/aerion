import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import { createSource, mutateWorkspace, readWorkspace } from "../repository";
import { calendarDate } from "../../lib/format";
import { fingerprint } from "../agents/evidence";
import {
  createEngagement,
  mutateRevenue,
  readRevenueCenter,
  readRevenueDetail,
  readRevenueInvoice,
} from "./repository";
import { invoiceHtml } from "./invoice";
import type { EngagementTerms, RevenueAction, RevenueDetail } from "../../lib/revenue/schema";

const url = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!url)(
  "Client engagement through earned fee, immutable invoice and actual receipt records",
  () => {
    const actors = [randomUUID(), randomUUID()],
      clientId = randomUUID(),
      payerId = randomUUID();
    let a: Scope, b: Scope, sourceId: string, foreignSource: string, primary: RevenueDetail;
    const today = calendarDate(),
      note =
        "Fictional engineering evidence reviewed. No real engagement, client, invoice, commission or payment is represented.";
    function terms(overrides: Partial<EngagementTerms> = {}): EngagementTerms {
      return {
        title: "Fictional sourcing engagement",
        clientContactId: clientId,
        payerContactId: payerId,
        representation: "Introduction",
        requirementId: null,
        dealId: null,
        scope: "Fictional engineering service scope only; no real representation is recorded.",
        startsOn: "2026-01-01",
        endsOn: null,
        currency: "USD",
        feeType: "Fixed",
        fixedAmount: "1000.00",
        percentage: null,
        estimateBasis: null,
        basisDescription: "Fixed fictional service fee; no assumed aircraft percentage.",
        earningTrigger: "Introduction",
        earningTerms:
          "Fictional written acknowledgement of the agreed introduction is the test earning event.",
        paymentTerms: "Fictional invoice payable within the recorded due date.",
        signedSourceId: sourceId,
        signatory: "Fictional Authorized Client",
        signedOn: today,
        ...overrides,
      };
    }
    async function create(value: EngagementTerms = terms()) {
      return createEngagement(a, { terms: value, idempotencyKey: randomUUID() });
    }
    async function change(detail: RevenueDetail, action: RevenueAction, key = randomUUID()) {
      const latest = await readRevenueDetail(a, detail.engagement.id);
      return mutateRevenue(a, detail.engagement.id, {
        revision: latest.engagement.revision,
        idempotencyKey: key,
        action,
      });
    }
    const activate = { kind: "activate", note, attested: true } as const;
    const earning = {
      kind: "earn",
      earnedOn: today,
      basisAmount: null,
      sourceId: "",
      note,
      attested: true,
    } as const;
    function invoice(earningId: string, amount = "1000.00", taxAmount = "0"): RevenueAction {
      return {
        kind: "invoice",
        earningId,
        amount,
        taxAmount,
        taxLabel: taxAmount === "0" ? "" : "Fictional explicit tax",
        issuedOn: today,
        dueOn: today,
        issuerName: "Fictional Founder Services",
        issuerEmail: "founder-fixture@example.com",
        issuerAddress: "Fictional billing address only",
        issuerRegistration: "FICTIONAL-ONLY",
        billToAddress: "Fictional payer billing address only",
        description: "Fictional agreed introduction fee for engineering validation",
        paymentInstructions: "Fictional engineering fixture only. Do not pay or transfer funds.",
        note,
        attested: true,
      };
    }
    beforeAll(async () => {
      if (!url || !new URL(url).pathname.endsWith("_test"))
        throw new Error("Dedicated _test database required.");
      process.env.DATABASE_URL = url;
      const migration = await pool().query(
        "select name from public.aerion_migrations where name='014_revenue_receipt_integrity.sql'",
      );
      if (!migration.rows.length)
        throw new Error("Coordinate and apply revenue migration before acceptance testing.");
      a = await workspaceFor(actors[0]);
      b = await workspaceFor(actors[1]);
      let workspace = await readWorkspace(a);
      await mutateWorkspace(
        a,
        {
          type: "contact",
          item: {
            id: clientId,
            name: "Fictional Client Signatory",
            company: "Fictional Buyer Company",
            role: "Fictional authorized buyer",
            email: "client-fixture@example.com",
            location: "Fictional India address",
            type: "Buyer",
            notes: note,
          },
        },
        workspace.revision,
      );
      workspace = await readWorkspace(a);
      await mutateWorkspace(
        a,
        {
          type: "contact",
          item: {
            id: payerId,
            name: "Fictional Fee Payer",
            company: "Fictional Paying Company",
            role: "Fictional accounts desk",
            email: "payer-fixture@example.com",
            location: "Fictional India address",
            type: "Buyer",
            notes: note,
          },
        },
        workspace.revision,
      );
      sourceId = (
        await createSource(a, {
          title: "Fictional signed engagement and event evidence",
          kind: "text",
          sourceUrl: null,
          filename: "fictional-revenue.txt",
          contentType: "text/plain",
          original: Buffer.from(note),
          pages: [{ page: 1, text: note }],
        })
      ).id;
      foreignSource = (
        await createSource(b, {
          title: "Other workspace fictional evidence",
          kind: "text",
          sourceUrl: null,
          filename: "foreign.txt",
          contentType: "text/plain",
          original: Buffer.from(`${note} Another owner.`),
          pages: [{ page: 1, text: `${note} Another owner.` }],
        })
      ).id;
    });
    afterAll(async () => {
      if (!a) return;
      const db = await pool().connect();
      try {
        await db.query("begin");
        for (const table of [
          "activity",
          "revenue_operations",
          "revenue_receipts",
          "revenue_payments",
          "revenue_expenses",
          "revenue_invoices",
          "revenue_earnings",
          "revenue_engagements",
          "transaction_events",
          "transaction_findings",
          "transaction_evidence",
          "transaction_offers",
          "transaction_cases",
          "sources",
        ]) {
          if ((await db.query("select to_regclass($1) name", [`aerion.${table}`])).rows[0].name)
            await db.query(`delete from aerion.${table} where workspace_id=any($1::uuid[])`, [
              [a.workspaceId, b.workspaceId],
            ]);
        }
        await db.query("delete from aerion.workspaces where owner_id=any($1::uuid[])", [actors]);
        await db.query("commit");
      } finally {
        db.release();
        await pool().end();
      }
    });
    it("creates only a Draft, deduplicates retries, rejects cross-owner records and requires signed activation evidence", async () => {
      const key = randomUUID(),
        draftTerms = terms({ signedSourceId: null, signatory: "", signedOn: null });
      const initial = await createEngagement(a, { terms: draftTerms, idempotencyKey: key });
      expect(initial.engagement.status).toBe("Draft");
      expect(initial.engagement.totals.earnedMinor).toBe("0");
      expect(
        (await createEngagement(a, { terms: draftTerms, idempotencyKey: key })).engagement.id,
      ).toBe(initial.engagement.id);
      await expect(
        createEngagement(a, {
          terms: { ...draftTerms, title: "Different request" },
          idempotencyKey: key,
        }),
      ).rejects.toThrow(/different/);
      await expect(readRevenueDetail(b, initial.engagement.id)).rejects.toThrow(/not found/);
      await expect(create(terms({ signedSourceId: foreignSource }))).rejects.toThrow(/not found/);
      await expect(change(initial, activate)).rejects.toThrow(/signed engagement/);
      await expect(change(initial, { ...earning, sourceId })).rejects.toThrow(/Activate/);
      primary = await change(initial, { kind: "edit", terms: terms() });
      primary = await change(primary, activate);
      expect(primary.engagement.status).toBe("Active");
      expect(primary.engagement.totals.contractedMinor).toBe("100000");
      await expect(
        change(primary, { kind: "edit", terms: terms({ fixedAmount: "2000" }) }),
      ).rejects.toThrow(/immutable/);
      await expect(
        mutateRevenue(a, primary.engagement.id, {
          revision: 0,
          idempotencyKey: randomUUID(),
          action: activate,
        }),
      ).rejects.toThrow(/changed/);
    });
    it("records an earning once and issues immutable partial invoices only within that earned amount", async () => {
      primary = await change(primary, { ...earning, sourceId });
      const earned = primary.earnings[0];
      expect(earned.amountMinor).toBe("100000");
      expect(primary.engagement.totals.receivedMinor).toBe("0");
      await expect(change(primary, { ...earning, sourceId })).rejects.toThrow(/already has/);
      const key = randomUUID(),
        revision = primary.engagement.revision,
        action = invoice(earned.id, "600.00", "30.00");
      primary = await mutateRevenue(a, primary.engagement.id, {
        revision,
        idempotencyKey: key,
        action,
      });
      const retry = await mutateRevenue(a, primary.engagement.id, {
        revision,
        idempotencyKey: key,
        action,
      });
      expect(retry.invoices).toHaveLength(1);
      expect(retry.invoices[0].totalMinor).toBe("63000");
      await expect(change(primary, invoice(earned.id, "400.01"))).rejects.toThrow(
        /remaining unbilled/,
      );
      primary = await change(primary, invoice(earned.id, "400.00", "20.00"));
      expect(primary.invoices).toHaveLength(2);
      expect(primary.engagement.totals.invoicedMinor).toBe("100000");
      expect(primary.engagement.totals.outstandingMinor).toBe("105000");
      const v = await readRevenueInvoice(a, primary.invoices[0].id),
        html = invoiceHtml(v);
      const workspace = await readWorkspace(a);
      await transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
          {
            ...workspace.data,
            contacts: workspace.data.contacts.map((c) =>
              c.id === payerId ? { ...c, email: "changed-fixture@example.com" } : c,
            ),
          },
          a.workspaceId,
        ]),
      );
      expect(invoiceHtml(await readRevenueInvoice(a, v.id))).toBe(html);
      expect(v.snapshot.billTo.email).toBe("payer-fixture@example.com");
      await expect(readRevenueInvoice(b, v.id)).rejects.toThrow(/not found/);
    });
    it("supports partial payments, prevents duplicate and excess receipts, and separates cash from earned revenue", async () => {
      const first = primary.invoices.find((i) => i.totalMinor === "63000"),
        second = primary.invoices.find((i) => i.totalMinor === "42000");
      if (!first || !second) throw new Error("Expected both retained invoices.");
      const receipt = {
        kind: "receipt",
        invoiceId: first.id,
        amount: "200.00",
        paymentTotal: "200.00",
        receivedOn: today,
        reference: "BANK-FIXTURE-001",
        sourceId,
        note,
        attested: true,
      } as const;
      primary = await change(primary, receipt);
      expect(primary.invoices.find((i) => i.id === first.id)?.outstandingMinor).toBe("43000");
      await expect(change(primary, { ...receipt, reference: "bank-fixture-001" })).rejects.toThrow(
        /already recorded/,
      );
      await expect(
        change(primary, {
          ...receipt,
          reference: "BANK-FIXTURE-TOO-MUCH",
          amount: "430.01",
          paymentTotal: "430.01",
        }),
      ).rejects.toThrow(/exceeds/);
      await expect(
        change(primary, {
          kind: "void-invoice",
          invoiceId: first.id,
          sourceId,
          note,
          attested: true,
        }),
      ).rejects.toThrow(/recorded receipts/);
      primary = await change(primary, {
        ...receipt,
        amount: "430.00",
        paymentTotal: "430.00",
        reference: "BANK-FIXTURE-002",
      });
      primary = await change(primary, {
        ...receipt,
        invoiceId: second.id,
        amount: "420.00",
        paymentTotal: "420.00",
        reference: "BANK-FIXTURE-003",
      });
      expect(primary.invoices.every((i) => i.outstandingMinor === "0")).toBe(true);
      expect(primary.engagement.totals.receivedMinor).toBe("105000");
      expect(primary.engagement.totals.earnedMinor).toBe("100000");
      primary = await change(primary, {
        kind: "expense",
        amount: "100.00",
        incurredOn: today,
        category: "Research",
        description: "Fictional paid sourcing research expense",
        reference: "EXPENSE-FIXTURE-001",
        sourceId,
        note,
        attested: true,
      });
      expect(primary.engagement.totals.expensesMinor).toBe("10000");
      expect(primary.engagement.totals.netCashMinor).toBe("95000");
    });
    it("corrects via retained reversal and void histories instead of mutating financial facts", async () => {
      const receipt = primary.receipts[0],
        invoice = primary.invoices.find((i) => i.id === receipt.invoiceId);
      if (!invoice) throw new Error("Expected the receipt's retained invoice.");
      const before = invoiceHtml(invoice);
      primary = await change(primary, {
        kind: "reverse-receipt",
        receiptId: receipt.id,
        sourceId,
        note,
        attested: true,
      });
      expect(primary.receipts.find((r) => r.id === receipt.id)?.status).toBe("Reversed");
      expect(invoiceHtml(await readRevenueInvoice(a, invoice.id))).toBe(before);
      primary = await change(primary, {
        kind: "void-invoice",
        invoiceId: invoice.id,
        sourceId,
        note,
        attested: true,
      });
      expect(primary.invoices.find((i) => i.id === invoice.id)?.status).toBe("Voided");
      expect(primary.invoices.find((i) => i.id === invoice.id)?.outstandingMinor).toBe("0");
      await expect(
        change(primary, {
          kind: "void-earning",
          earningId: primary.earnings[0].id,
          sourceId,
          note,
          attested: true,
        }),
      ).rejects.toThrow(/issued invoices/);
      primary = await change(primary, {
        kind: "reverse-expense",
        expenseId: primary.expenses[0].id,
        sourceId,
        note,
        attested: true,
      });
      expect(primary.engagement.totals.expensesMinor).toBe("0");
      expect(primary.activity.some((a) => a.action === "revenue.reverse-receipt")).toBe(true);
      expect(primary.receipts.find((r) => r.id === receipt.id)?.amountMinor).toBe(
        receipt.amountMinor,
      );
      await expect(
        transaction(a.actorId, a.workspaceId, (db) =>
          db.query("update aerion.revenue_invoices set subtotal_minor=1 where id=$1", [invoice.id]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        transaction(a.actorId, a.workspaceId, (db) =>
          db.query("update aerion.revenue_engagements set terms=$1 where id=$2", [
            { ...primary.engagement.terms, fixedAmount: "2" },
            primary.engagement.id,
          ]),
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        transaction(a.actorId, a.workspaceId, (db) =>
          db.query("update aerion.revenue_receipts set status='Recorded' where id=$1", [
            receipt.id,
          ]),
        ),
      ).rejects.toThrow(/immutable|issued invoice/);
    });
    it("uses the actual percentage basis at earning and keeps currency reporting separate", async () => {
      let percentage = await create(
        terms({
          title: "Fictional percentage engagement",
          feeType: "Percentage",
          fixedAmount: null,
          percentage: "1.2345",
          estimateBasis: "100000.00",
        }),
      );
      percentage = await change(percentage, activate);
      await expect(change(percentage, { ...earning, sourceId })).rejects.toThrow(
        /actual agreed calculation basis/,
      );
      percentage = await change(percentage, { ...earning, sourceId, basisAmount: "1000.01" });
      expect(percentage.earnings[0].amountMinor).toBe("1235");
      expect(percentage.earnings[0].basisMinor).toBe("100001");
      let yen = await create(
        terms({ title: "Fictional JPY engagement", currency: "JPY", fixedAmount: "1000" }),
      );
      yen = await change(yen, activate);
      yen = await change(yen, { ...earning, sourceId });
      expect(yen.earnings[0].amountMinor).toBe("1000");
      await expect(change(yen, invoice(yen.earnings[0].id, "1.01"))).rejects.toThrow(
        /decimal places/,
      );
      const center = await readRevenueCenter(a);
      expect(center.totals.map((t) => t.currency)).toContain("USD");
      expect(center.totals.map((t) => t.currency)).toContain("JPY");
      expect((await readRevenueCenter(b)).engagements).toHaveLength(0);
    });
    it("keeps earning eligibility consistent regardless of whether the end or earning is recorded first", async () => {
      const day = (offset: number) => {
        const date = new Date(`${today}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + offset);
        return date.toISOString().slice(0, 10);
      };
      const end = {
        kind: "end",
        endedOn: day(-2),
        sourceId,
        note,
        attested: true,
      } as const;
      let earnedFirst = await change(
        await create(terms({ title: "Fictional earned-first term", startsOn: day(-4) })),
        activate,
      );
      earnedFirst = await change(earnedFirst, {
        ...earning,
        earnedOn: day(-1),
        sourceId,
      });
      await expect(change(earnedFirst, end)).rejects.toThrow(
        /end date cannot precede a recorded earning/,
      );
      const unchanged = await readRevenueDetail(a, earnedFirst.engagement.id);
      expect(unchanged.engagement.status).toBe("Active");
      expect(unchanged.engagement.revision).toBe(earnedFirst.engagement.revision);
      expect(unchanged.earnings[0].status).toBe("Recorded");
      earnedFirst = await change(unchanged, { ...end, endedOn: today });
      earnedFirst = await change(earnedFirst, invoice(earnedFirst.earnings[0].id));
      expect(earnedFirst.engagement.status).toBe("Ended");
      expect(earnedFirst.invoices[0].status).toBe("Issued");

      let endedFirst = await change(
        await create(terms({ title: "Fictional ended-first term", startsOn: day(-4) })),
        activate,
      );
      endedFirst = await change(endedFirst, end);
      await expect(change(endedFirst, { ...earning, earnedOn: day(-1), sourceId })).rejects.toThrow(
        /earning date must fall within/,
      );
      endedFirst = await change(endedFirst, { ...earning, earnedOn: end.endedOn, sourceId });
      expect(endedFirst.earnings[0].earnedOn).toBe(end.endedOn);

      let corrected = await change(
        await create(terms({ title: "Fictional corrected earning term", startsOn: day(-4) })),
        activate,
      );
      corrected = await change(corrected, { ...earning, earnedOn: day(-1), sourceId });
      corrected = await change(corrected, {
        kind: "void-earning",
        earningId: corrected.earnings[0].id,
        sourceId,
        note,
        attested: true,
      });
      corrected = await change(corrected, end);
      expect(corrected.engagement.status).toBe("Ended");
      expect(corrected.earnings[0].status).toBe("Voided");
    });
    it("blocks invoices for legacy earnings outside original start/end dates", async () => {
      const day = (offset: number) => {
        const date = new Date(`${today}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + offset);
        return date.toISOString().slice(0, 10);
      };
      for (const outside of [
        {
          title: "Fictional legacy earning before start",
          startsOn: day(-2),
          endsOn: null,
          earnedOn: day(-3),
        },
        {
          title: "Fictional legacy earning after end",
          startsOn: day(-4),
          endsOn: day(-2),
          earnedOn: day(-1),
        },
      ]) {
        const detail = await change(await create(terms(outside)), activate),
          earningId = randomUUID();
        // Owner-only fixture simulates a legacy record without bypassing the public action under test.
        await pool().query(
          "insert into aerion.revenue_earnings(id,workspace_id,engagement_id,earned_on,amount_minor,source_id,note,actor_id) values($1,$2,$3,$4,100000,$5,$6,$7)",
          [
            earningId,
            a.workspaceId,
            detail.engagement.id,
            outside.earnedOn,
            sourceId,
            note,
            a.actorId,
          ],
        );
        await expect(change(detail, invoice(earningId))).rejects.toThrow(
          /outside the engagement term/,
        );
        expect((await readRevenueDetail(a, detail.engagement.id)).invoices).toHaveLength(0);
      }
    });
    it("blocks new invoices after a legacy inconsistent end while retaining issued invoices and receipts", async () => {
      const day = (offset: number) => {
        const date = new Date(`${today}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + offset);
        return date.toISOString().slice(0, 10);
      };
      let detail = await change(
        await create(
          terms({ title: "Fictional legacy end with retained cash", startsOn: day(-4) }),
        ),
        activate,
      );
      detail = await change(detail, { ...earning, earnedOn: day(-1), sourceId });
      const earned = detail.earnings[0];
      detail = await change(detail, invoice(earned.id, "500.00"));
      const issued = detail.invoices[0],
        originalHtml = invoiceHtml(issued);
      detail = await change(detail, {
        kind: "receipt",
        invoiceId: issued.id,
        amount: "100.00",
        paymentTotal: "100.00",
        receivedOn: today,
        reference: `FICTIONAL-LEGACY-TERM-${randomUUID()}`,
        sourceId,
        note,
        attested: true,
      });
      // Simulate a termination recorded before the new consistency guard was introduced.
      await pool().query(
        "update aerion.revenue_engagements set status='Ended',ended_on=$1,ended_source_id=$2,ended_note=$3 where workspace_id=$4 and id=$5",
        [day(-2), sourceId, note, a.workspaceId, detail.engagement.id],
      );
      await expect(change(detail, invoice(earned.id, "500.00"))).rejects.toThrow(
        /outside the engagement term/,
      );
      const retained = await readRevenueDetail(a, detail.engagement.id);
      expect(retained.invoices).toHaveLength(1);
      expect(retained.invoices[0].status).toBe("Issued");
      expect(invoiceHtml(retained.invoices[0])).toBe(originalHtml);
      expect(retained.receipts[0].status).toBe("Recorded");
      expect(retained.engagement.totals.receivedMinor).toBe("10000");
    });
    it("bounds one source-backed transfer across invoices and engagements, releases allocations on reversal, and prevents duplicate expenses", async () => {
      async function billed(title: string) {
        let detail = await create(terms({ title }));
        detail = await change(detail, activate);
        detail = await change(detail, { ...earning, sourceId });
        return change(detail, invoice(detail.earnings[0].id));
      }
      let first = await billed("Fictional split-transfer engagement A"),
        second = await billed("Fictional split-transfer engagement B");
      const payment = {
        kind: "receipt",
        invoiceId: first.invoices[0].id,
        amount: "1000.00",
        paymentTotal: "1000.00",
        reference: "BANK-GLOBAL-SHARED-001",
        receivedOn: today,
        sourceId,
        note,
        attested: true,
      } as const;
      first = await change(first, payment);
      const observed = first.payments.find((p) => p.reference === payment.reference);
      if (!observed) throw new Error("Expected the retained shared payment.");
      expect(observed.amountMinor).toBe("100000");
      expect(observed.unallocatedMinor).toBe("0");
      await expect(
        change(second, { ...payment, invoiceId: second.invoices[0].id }),
      ).rejects.toThrow(/unallocated amount across all invoices/);
      await expect(
        change(second, { ...payment, invoiceId: second.invoices[0].id, paymentTotal: "2000.00" }),
      ).rejects.toThrow(/different retained/);
      await expect(
        change(first, {
          kind: "void-payment",
          paymentId: observed.id,
          sourceId,
          note,
          attested: true,
        }),
      ).rejects.toThrow(/Reverse all active/);
      await expect(
        transaction(a.actorId, a.workspaceId, (db) =>
          db.query(
            "insert into aerion.revenue_receipts(id,workspace_id,engagement_id,invoice_id,payment_id,amount_minor,received_on,reference,reference_key,source_id,note,actor_id) values($1,$2,$3,$4,$5,100,$6,$7,$8,$9,$10,$11)",
            [
              randomUUID(),
              a.workspaceId,
              second.engagement.id,
              second.invoices[0].id,
              observed.id,
              today,
              payment.reference,
              payment.reference.toLowerCase(),
              sourceId,
              note,
              a.actorId,
            ],
          ),
        ),
      ).rejects.toThrow(/exceed the retained transfer total/);
      first = await change(first, {
        kind: "reverse-receipt",
        receiptId: first.receipts[0].id,
        sourceId,
        note,
        attested: true,
      });
      expect(first.payments.find((p) => p.id === observed.id)?.unallocatedMinor).toBe("100000");
      first = await change(first, { ...payment, amount: "400.00" });
      second = await change(second, {
        ...payment,
        invoiceId: second.invoices[0].id,
        amount: "600.00",
      });
      expect(first.engagement.totals.receivedMinor).toBe("40000");
      expect(second.engagement.totals.receivedMinor).toBe("60000");
      expect(second.payments.find((p) => p.id === observed.id)?.allocatedMinor).toBe("100000");
      expect(second.payments.find((p) => p.id === observed.id)?.unallocatedMinor).toBe("0");
      expect(second.receipts[0].paymentId).toBe(observed.id);
      await expect(
        transaction(a.actorId, a.workspaceId, (db) =>
          db.query("update aerion.revenue_payments set amount_minor=200000 where id=$1", [
            observed.id,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      second = await change(second, {
        kind: "reverse-receipt",
        receiptId: second.receipts[0].id,
        sourceId,
        note,
        attested: true,
      });
      first = await change(first, {
        kind: "reverse-receipt",
        receiptId: first.receipts[0].id,
        sourceId,
        note,
        attested: true,
      });
      first = await change(first, {
        kind: "void-payment",
        paymentId: observed.id,
        sourceId,
        note,
        attested: true,
      });
      expect(first.payments.find((p) => p.id === observed.id)?.status).toBe("Voided");
      first = await change(first, { ...payment, amount: "500.00", paymentTotal: "1500.00" });
      const corrected = first.payments.find(
        (p) => p.reference === payment.reference && p.status === "Recorded",
      );
      expect(corrected?.id).not.toBe(observed.id);
      expect(corrected?.amountMinor).toBe("150000");
      const expense = {
        kind: "expense",
        amount: "50.00",
        incurredOn: today,
        category: "Research",
        description: "Fictional original paid expense across engagements",
        reference: "EXPENSE-WORKSPACE-UNIQUE",
        sourceId,
        note,
        attested: true,
      } as const;
      first = await change(first, expense);
      await expect(
        change(second, { ...expense, reference: "expense-workspace-unique" }),
      ).rejects.toThrow(/already recorded in this workspace/);
      expect((await readRevenueCenter(b)).engagements).toHaveLength(0);
    });
    it("requires current closing evidence, snapshots the completed cycle, and warns after reopening", async () => {
      const dealId = randomUUID(),
        aircraftId = randomUUID(),
        requirementId = randomUUID();
      await transaction(a.actorId, a.workspaceId, async (db) => {
        const w = await readWorkspace(a);
        const data = {
          ...w.data,
          deals: [
            ...w.data.deals,
            {
              id: dealId,
              title: "Fictional closing integration opportunity",
              aircraftId,
              requirementId,
              stage: "Closing",
              nextAction: "Fictional closing evidence review",
              dueDate: today,
            },
          ],
        };
        await db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
          data,
          a.workspaceId,
        ]);
      });
      let closing = await create(
        terms({ title: "Fictional closing fee", dealId, earningTrigger: "Closing" }),
      );
      closing = await change(closing, activate);
      await expect(change(closing, { ...earning, sourceId })).rejects.toThrow(/current, completed/);
      await pool().query(
        "insert into aerion.transaction_cases(workspace_id,deal_id,context_hash,status,completed_on,completion_source_id) values($1,$2,$3,'Completed',$4,$5)",
        [
          a.workspaceId,
          dealId,
          fingerprint({ dealId, aircraftId, requirementId }),
          today,
          sourceId,
        ],
      );
      closing = await change(closing, { ...earning, sourceId });
      expect(closing.earnings[0].transactionSnapshot?.cycle).toBe(1);
      await pool().query(
        "update aerion.transaction_cases set status='Sourcing',cycle=cycle+1,completed_on=null,completion_source_id=null where workspace_id=$1 and deal_id=$2",
        [a.workspaceId, dealId],
      );
      const reopened = await readRevenueDetail(a, closing.engagement.id);
      expect(reopened.completionWarning).toContain("completion changed");
      expect(reopened.earnings[0].amountMinor).toBe("100000");
      await expect(change(reopened, invoice(reopened.earnings[0].id))).rejects.toThrow(
        /current, completed/,
      );
    });
  },
);
