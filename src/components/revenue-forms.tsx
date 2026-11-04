"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { calendarDate } from "@/lib/format";
import { currencies, minorDecimal } from "@/lib/revenue/money";
import {
  engagementTermsSchema,
  revenueActionSchema,
  type EngagementTerms,
  type RevenueAction,
  type RevenueCenter,
  type RevenueDetail,
} from "@/lib/revenue/schema";
import { useWorkspace } from "./workspace-provider";
import { Field } from "./ui";

const text = (f: FormData, key: string) => String(f.get(key) ?? "").trim();
export type RevenueEditor = { kind: RevenueAction["kind"]; targetId?: string };
function SourceField({
  sources,
  label = "Retained supporting document",
  name = "sourceId",
  required = true,
  value = "",
}: {
  sources: RevenueCenter["sources"];
  label?: string;
  name?: string;
  required?: boolean;
  value?: string;
}) {
  return (
    <Field label={label}>
      <select name={name} required={required} defaultValue={value}>
        <option value="">{required ? "Choose retained evidence" : "Not attached yet"}</option>
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
    </Field>
  );
}
function NoteField({ label = "Record basis / review note" }: { label?: string }) {
  return (
    <Field label={label}>
      <textarea
        name="note"
        minLength={20}
        maxLength={3000}
        required
        rows={3}
        placeholder="Explain the event, document reviewed and basis for this record."
      />
    </Field>
  );
}
function Attestation({ children }: { children: string }) {
  return (
    <label className="revenue-attestation">
      <input type="checkbox" name="attested" required />
      {children}
    </label>
  );
}
function Actions({
  busy,
  onCancel,
  label,
}: {
  busy: boolean;
  onCancel: () => void;
  label: string;
}) {
  return (
    <div className="revenue-form-actions">
      <button type="button" className="button button-secondary" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="button button-primary" disabled={busy}>
        {busy ? "Saving…" : label}
      </button>
    </div>
  );
}

export function EngagementTermsForm({
  initial,
  sources,
  busy,
  onSave,
  onCancel,
}: {
  initial?: EngagementTerms;
  sources: RevenueCenter["sources"];
  busy: boolean;
  onSave: (terms: EngagementTerms) => Promise<void>;
  onCancel: () => void;
}) {
  const { data } = useWorkspace(),
    [feeType, setFeeType] = useState(initial?.feeType ?? "Fixed"),
    [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const terms = engagementTermsSchema.parse({
        title: text(f, "title"),
        clientContactId: text(f, "clientContactId"),
        payerContactId: text(f, "payerContactId"),
        representation: text(f, "representation"),
        requirementId: text(f, "requirementId") || null,
        dealId: text(f, "dealId") || null,
        scope: text(f, "scope"),
        startsOn: text(f, "startsOn"),
        endsOn: text(f, "endsOn") || null,
        currency: text(f, "currency"),
        feeType,
        fixedAmount: feeType === "Fixed" ? text(f, "fixedAmount") || null : null,
        percentage: feeType === "Percentage" ? text(f, "percentage") || null : null,
        estimateBasis: feeType === "Percentage" ? text(f, "estimateBasis") || null : null,
        basisDescription: text(f, "basisDescription"),
        earningTrigger: text(f, "earningTrigger"),
        earningTerms: text(f, "earningTerms"),
        paymentTerms: text(f, "paymentTerms"),
        signedSourceId: text(f, "signedSourceId") || null,
        signatory: text(f, "signatory"),
        signedOn: text(f, "signedOn") || null,
      });
      await onSave(terms);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The engagement could not be saved.");
    }
  }
  return (
    <form className="revenue-form" onSubmit={submit} ref={formRef}>
      <fieldset disabled={busy}>
        <p className="revenue-hint">
          Record the actual client relationship and agreed terms. Saving starts a Draft; activation
          separately requires the retained signed engagement and your review.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <h3>Client & scope</h3>
        <div className="revenue-fields">
          <Field label="Engagement title">
            <input
              name="title"
              required
              maxLength={300}
              defaultValue={initial?.title ?? ""}
              placeholder="Client · aircraft sourcing engagement"
            />
          </Field>
          <Field label="Your service">
            <select name="representation" required defaultValue={initial?.representation ?? ""}>
              <option value="" disabled>
                Select the recorded service
              </option>
              {["Buyer sourcing", "Seller representation", "Introduction", "Other service"].map(
                (v) => (
                  <option key={v}>{v}</option>
                ),
              )}
            </select>
          </Field>
          <Field label="Engaging client">
            <select name="clientContactId" required defaultValue={initial?.clientContactId ?? ""}>
              <option value="" disabled>
                Choose a saved contact
              </option>
              {data.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company} · {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agreed fee payer">
            <select name="payerContactId" required defaultValue={initial?.payerContactId ?? ""}>
              <option value="" disabled>
                Choose a saved contact
              </option>
              {data.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company} · {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Linked buyer requirement (optional)">
            <select name="requirementId" defaultValue={initial?.requirementId ?? ""}>
              <option value="">No linked requirement</option>
              {data.requirements.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.client} · {r.aircraftModel}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Linked opportunity (required for a closing trigger)">
            <select name="dealId" defaultValue={initial?.dealId ?? ""}>
              <option value="">No linked opportunity</option>
              {data.deals.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Agreed work and authority">
          <textarea
            name="scope"
            required
            minLength={20}
            maxLength={3000}
            rows={3}
            defaultValue={initial?.scope ?? ""}
            placeholder="Record the work authorized by the client and any limits stated in the engagement."
          />
        </Field>
        <div className="revenue-fields">
          <Field label="Term starts">
            <input
              type="date"
              name="startsOn"
              required
              defaultValue={initial?.startsOn ?? calendarDate()}
            />
          </Field>
          <Field label="Term ends (optional)">
            <input type="date" name="endsOn" defaultValue={initial?.endsOn ?? ""} />
          </Field>
        </div>
        <h3>Fee & earning conditions</h3>
        <div className="revenue-fields">
          <Field label="Agreement currency">
            <select name="currency" required defaultValue={initial?.currency ?? ""}>
              <option value="" disabled>
                Choose the agreed currency
              </option>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Fee method">
            <select
              name="feeType"
              value={feeType}
              onChange={(e) => setFeeType(e.target.value as "Fixed" | "Percentage")}
            >
              <option>Fixed</option>
              <option>Percentage</option>
            </select>
          </Field>
          {feeType === "Fixed" ? (
            <Field label="Agreed fixed fee">
              <input
                name="fixedAmount"
                required
                inputMode="decimal"
                maxLength={24}
                defaultValue={initial?.fixedAmount ?? ""}
                placeholder="Plain amount in agreement currency"
              />
            </Field>
          ) : (
            <>
              <Field label="Agreed fee percentage">
                <input
                  name="percentage"
                  required
                  inputMode="decimal"
                  maxLength={24}
                  defaultValue={initial?.percentage ?? ""}
                  placeholder="Use the actual agreed rate"
                />
              </Field>
              <Field label="Estimated calculation basis (optional)">
                <input
                  name="estimateBasis"
                  inputMode="decimal"
                  maxLength={24}
                  defaultValue={initial?.estimateBasis ?? ""}
                  placeholder="Leave unknown basis blank"
                />
              </Field>
            </>
          )}
          <Field label="Agreed earning trigger">
            <select name="earningTrigger" required defaultValue={initial?.earningTrigger ?? ""}>
              <option value="" disabled>
                Select the agreed trigger
              </option>
              {["Closing", "Introduction", "Milestone", "Other"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Fee calculation basis">
          <textarea
            name="basisDescription"
            required
            minLength={10}
            maxLength={1500}
            rows={2}
            defaultValue={initial?.basisDescription ?? ""}
            placeholder="Describe the fixed fee or what the percentage applies to, including credits, quantity and currency treatment."
          />
        </Field>
        <Field label="When the fee is earned">
          <textarea
            name="earningTerms"
            required
            minLength={20}
            maxLength={3000}
            rows={3}
            defaultValue={initial?.earningTerms ?? ""}
            placeholder="Record the contractual event and conditions. A deal stage alone does not establish an earned fee."
          />
        </Field>
        <Field label="When and how the fee must be paid">
          <textarea
            name="paymentTerms"
            required
            minLength={10}
            maxLength={2000}
            rows={2}
            defaultValue={initial?.paymentTerms ?? ""}
          />
        </Field>
        <h3>Signed agreement evidence</h3>
        <SourceField
          sources={sources}
          name="signedSourceId"
          label="Retained signed engagement"
          required={false}
          value={initial?.signedSourceId ?? ""}
        />
        <div className="revenue-fields">
          <Field label="Client signatory / authority reference">
            <input name="signatory" maxLength={300} defaultValue={initial?.signatory ?? ""} />
          </Field>
          <Field label="Agreement signed on">
            <input
              type="date"
              name="signedOn"
              max={calendarDate()}
              defaultValue={initial?.signedOn ?? ""}
            />
          </Field>
        </div>
        <p className="revenue-hint">
          Import the actual agreement in the Source library first. This record does not generate a
          contract or certify that a signer has authority.
        </p>
        <Actions
          busy={busy}
          onCancel={onCancel}
          label={initial ? "Save Draft terms" : "Create Draft engagement"}
        />
      </fieldset>
    </form>
  );
}

export function RevenueActionForm({
  editor,
  detail,
  busy,
  onSave,
  onCancel,
}: {
  editor: RevenueEditor;
  detail: RevenueDetail;
  busy: boolean;
  onSave: (action: RevenueAction) => Promise<void>;
  onCancel: () => void;
}) {
  const { engagement, earnings, invoices } = detail,
    terms = engagement.terms;
  const [error, setError] = useState(""),
    [paymentId, setPaymentId] = useState(""),
    formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input,select,textarea",
      )
      ?.focus();
  }, []);
  const titles: Record<Exclude<RevenueAction["kind"], "edit">, string> = {
    activate: "Review & activate engagement",
    end: "Record the engagement ending",
    earn: "Record the agreed earning event",
    "void-earning": "Void an incorrect earned-fee record",
    invoice: "Issue an immutable invoice",
    "void-invoice": "Void an issued invoice",
    receipt: "Record an allocated payment receipt",
    "void-payment": "Void an incorrect payment record",
    "reverse-receipt": "Reverse a recorded receipt",
    expense: "Record a paid engagement expense",
    "reverse-expense": "Reverse a recorded expense",
  };
  const targetInvoice = invoices.find((i) => i.id === editor.targetId),
    targetEarning = earnings.find((e) => e.id === editor.targetId);
  const selectedPayment = detail.payments.find((payment) => payment.id === paymentId);
  const allocationAvailable = targetInvoice
    ? selectedPayment &&
      BigInt(selectedPayment.unallocatedMinor) < BigInt(targetInvoice.outstandingMinor)
      ? selectedPayment.unallocatedMinor
      : targetInvoice.outstandingMinor
    : "0";
  const unbilled = targetEarning
    ? BigInt(targetEarning.amountMinor) -
      invoices
        .filter((i) => i.earningId === targetEarning.id && i.status === "Issued")
        .reduce((n, i) => n + BigInt(i.subtotalMinor), 0n)
    : 0n;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget),
      common = { note: text(f, "note"), attested: f.get("attested") === "on" };
    let raw: unknown;
    if (editor.kind === "activate") raw = { kind: "activate", ...common };
    else if (editor.kind === "end")
      raw = { kind: "end", endedOn: text(f, "endedOn"), sourceId: text(f, "sourceId"), ...common };
    else if (editor.kind === "earn")
      raw = {
        kind: "earn",
        earnedOn: text(f, "earnedOn"),
        basisAmount: text(f, "basisAmount") || null,
        sourceId: text(f, "sourceId"),
        ...common,
      };
    else if (editor.kind === "invoice")
      raw = {
        kind: "invoice",
        earningId: editor.targetId,
        amount: text(f, "amount"),
        taxAmount: text(f, "taxAmount"),
        taxLabel: text(f, "taxLabel"),
        issuedOn: text(f, "issuedOn"),
        dueOn: text(f, "dueOn"),
        issuerName: text(f, "issuerName"),
        issuerEmail: text(f, "issuerEmail"),
        issuerAddress: text(f, "issuerAddress"),
        issuerRegistration: text(f, "issuerRegistration"),
        billToAddress: text(f, "billToAddress"),
        description: text(f, "description"),
        paymentInstructions: text(f, "paymentInstructions"),
        ...common,
      };
    else if (editor.kind === "receipt")
      raw = {
        kind: "receipt",
        invoiceId: editor.targetId,
        amount: text(f, "amount"),
        paymentTotal: text(f, "paymentTotal"),
        receivedOn: text(f, "receivedOn"),
        reference: text(f, "reference"),
        sourceId: text(f, "sourceId"),
        ...common,
      };
    else if (editor.kind === "expense")
      raw = {
        kind: "expense",
        amount: text(f, "amount"),
        incurredOn: text(f, "incurredOn"),
        category: text(f, "category"),
        description: text(f, "description"),
        reference: text(f, "reference"),
        sourceId: text(f, "sourceId"),
        ...common,
      };
    else
      raw = {
        kind: editor.kind,
        ...common,
        sourceId: text(f, "sourceId"),
        [editor.kind === "void-earning"
          ? "earningId"
          : editor.kind === "void-invoice"
            ? "invoiceId"
            : editor.kind === "reverse-receipt"
              ? "receiptId"
              : editor.kind === "void-payment"
                ? "paymentId"
                : "expenseId"]: editor.targetId,
      };
    try {
      await onSave(revenueActionSchema.parse(raw));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The record could not be saved.");
    }
  }
  if (editor.kind === "edit") return null;
  return (
    <section className="revenue-editor">
      <h3>{titles[editor.kind]}</h3>
      <form className="revenue-form" ref={formRef} onSubmit={submit}>
        <fieldset disabled={busy}>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {editor.kind === "activate" ? (
            <p className="revenue-hint">
              Review the retained signed agreement, client, fee payer, scope, term and
              earning/payment conditions. Activation freezes those terms and party details. It does
              not record income.
            </p>
          ) : null}
          {editor.kind === "end" ? (
            <Field label="Engagement ended on">
              <input
                type="date"
                name="endedOn"
                required
                max={calendarDate()}
                defaultValue={calendarDate()}
              />
            </Field>
          ) : null}
          {editor.kind === "earn" ? (
            <>
              <p className="revenue-hint">
                Agreed trigger: <strong>{terms.earningTrigger}</strong>. {terms.earningTerms} A
                recorded earning is your evidence-backed assertion that the contractual event
                occurred; it does not record payment.
              </p>
              {terms.earningTrigger === "Closing" ? (
                <p className="revenue-hint">
                  The linked transaction must currently be Completed. Select its retained closing
                  completion document below.
                </p>
              ) : null}
              <div className="revenue-fields">
                <Field label="Fee earned on">
                  <input
                    type="date"
                    name="earnedOn"
                    required
                    max={calendarDate()}
                    defaultValue={calendarDate()}
                  />
                </Field>
                {terms.feeType === "Percentage" ? (
                  <Field label={`Actual calculation basis (${terms.currency})`}>
                    <input
                      name="basisAmount"
                      inputMode="decimal"
                      required
                      maxLength={24}
                      placeholder="Actual agreement basis from evidence"
                    />
                  </Field>
                ) : null}
              </div>
            </>
          ) : null}
          {editor.kind === "invoice" ? (
            <>
              <p className="revenue-hint">
                The issued document captures the payer, fee description, issuer and explicit charge
                amounts as an immutable snapshot. Record taxes or charges only from your reviewed
                billing basis; Aerion does not infer them.
              </p>
              <div className="revenue-fields">
                <Field label={`Commission subtotal (${terms.currency})`}>
                  <input
                    name="amount"
                    required
                    inputMode="decimal"
                    maxLength={24}
                    defaultValue={minorDecimal(unbilled, terms.currency)}
                  />
                </Field>
                <Field label={`Explicit tax / statutory charge (${terms.currency})`}>
                  <input
                    name="taxAmount"
                    required
                    inputMode="decimal"
                    maxLength={24}
                    defaultValue="0"
                  />
                </Field>
                <Field label="Tax / charge label">
                  <input
                    name="taxLabel"
                    maxLength={200}
                    placeholder="Required when a charge amount is recorded"
                  />
                </Field>
                <Field label="Invoice issued on">
                  <input
                    type="date"
                    name="issuedOn"
                    required
                    max={calendarDate()}
                    defaultValue={calendarDate()}
                  />
                </Field>
                <Field label="Invoice due on">
                  <input type="date" name="dueOn" required defaultValue={calendarDate()} />
                </Field>
                <Field label="Issuer legal / business name">
                  <input name="issuerName" required maxLength={300} />
                </Field>
                <Field label="Issuer business email">
                  <input name="issuerEmail" type="email" required />
                </Field>
                <Field label="Issuer registration / tax reference (if applicable)">
                  <input name="issuerRegistration" maxLength={300} />
                </Field>
              </div>
              <div className="revenue-fields">
                <Field label="Issuer billing address">
                  <textarea name="issuerAddress" required minLength={5} maxLength={1500} rows={3} />
                </Field>
                <Field label="Payer billing address">
                  <textarea
                    name="billToAddress"
                    required
                    minLength={5}
                    maxLength={1500}
                    rows={3}
                    defaultValue={engagement.parties.payer.location}
                  />
                </Field>
              </div>
              <Field label="Invoice fee description">
                <textarea
                  name="description"
                  required
                  minLength={10}
                  maxLength={2000}
                  rows={2}
                  defaultValue={terms.title}
                />
              </Field>
              <Field label="Payment instructions">
                <textarea
                  name="paymentInstructions"
                  required
                  minLength={10}
                  maxLength={2000}
                  rows={3}
                  placeholder="Record reviewed payment instructions and invoice-reference instructions."
                />
              </Field>
              <p className="revenue-hint">
                Payer: {engagement.parties.payer.company} · {engagement.parties.payer.name} ·{" "}
                {engagement.parties.payer.email}. Issuing saves the document locally; it does not
                send it.
              </p>
            </>
          ) : null}
          {editor.kind === "receipt" ? (
            <>
              <p className="revenue-hint">
                Record the full actual transfer total and the portion allocated to{" "}
                {targetInvoice?.number}. One transfer can pay several invoices, but combined
                allocations can never exceed its original retained total. Use the same recorded
                transfer for every split allocation.
              </p>
              <Field label="Reuse a recorded transfer (optional)">
                <select value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
                  <option value="">Record a new actual transfer</option>
                  {detail.payments
                    .filter((p) => p.status === "Recorded" && p.currency === terms.currency)
                    .map((p) => (
                      <option key={p.id} value={p.id} disabled={BigInt(p.unallocatedMinor) <= 0n}>
                        {p.reference} · {minorDecimal(p.unallocatedMinor, p.currency)} unallocated
                      </option>
                    ))}
                </select>
              </Field>
              {selectedPayment ? (
                <p className="revenue-hint">
                  The original transfer details stay fixed. Allocations already recorded across all
                  invoices: {minorDecimal(selectedPayment.allocatedMinor, selectedPayment.currency)}{" "}
                  {selectedPayment.currency}.
                </p>
              ) : null}
              <div className="revenue-fields" key={selectedPayment?.id ?? "new-transfer"}>
                <Field label={`Allocated amount received (${terms.currency})`}>
                  <input
                    name="amount"
                    inputMode="decimal"
                    maxLength={24}
                    required
                    defaultValue={
                      targetInvoice ? minorDecimal(allocationAvailable, terms.currency) : ""
                    }
                  />
                </Field>
                <Field label={`Full actual transfer total (${terms.currency})`}>
                  <input
                    name="paymentTotal"
                    required
                    inputMode="decimal"
                    maxLength={24}
                    readOnly={Boolean(selectedPayment)}
                    defaultValue={
                      selectedPayment
                        ? minorDecimal(selectedPayment.amountMinor, selectedPayment.currency)
                        : ""
                    }
                    placeholder="Total received in this one bank transfer"
                  />
                </Field>
                <Field label="Received on">
                  <input
                    name="receivedOn"
                    type="date"
                    required
                    max={calendarDate()}
                    defaultValue={selectedPayment?.receivedOn ?? calendarDate()}
                    readOnly={Boolean(selectedPayment)}
                  />
                </Field>
                <Field label="Unique payment / bank reference">
                  <input
                    name="reference"
                    required
                    minLength={2}
                    maxLength={200}
                    readOnly={Boolean(selectedPayment)}
                    defaultValue={selectedPayment?.reference ?? ""}
                    placeholder="Include account/provider prefix if needed"
                  />
                </Field>
              </div>
            </>
          ) : null}
          {editor.kind === "expense" ? (
            <>
              <p className="revenue-hint">
                Record an amount actually paid for this engagement, in its agreement currency.
                Other-currency costs need a documented conversion basis before allocation.
              </p>
              <div className="revenue-fields">
                <Field label={`Amount paid (${terms.currency})`}>
                  <input name="amount" required inputMode="decimal" maxLength={24} />
                </Field>
                <Field label="Paid / incurred on">
                  <input
                    name="incurredOn"
                    type="date"
                    required
                    max={calendarDate()}
                    defaultValue={calendarDate()}
                  />
                </Field>
                <Field label="Expense category">
                  <select name="category" required>
                    <option>Research</option>
                    <option>Travel</option>
                    <option>Professional services</option>
                    <option>Technology</option>
                    <option>Other</option>
                  </select>
                </Field>
                <Field label="Expense / payment reference">
                  <input name="reference" required minLength={2} maxLength={200} />
                </Field>
              </div>
              <Field label="Paid expense description">
                <textarea name="description" required minLength={10} maxLength={1500} rows={2} />
              </Field>
            </>
          ) : null}
          {[
            "void-earning",
            "void-invoice",
            "void-payment",
            "reverse-receipt",
            "reverse-expense",
          ].includes(editor.kind) ? (
            <p className="revenue-hint">
              The original record remains in history. Explain the correction and retain its
              supporting evidence. A receipt reversal records an accounting correction; it does not
              transfer or refund money.
            </p>
          ) : null}
          {editor.kind !== "activate" && editor.kind !== "invoice" ? (
            <SourceField
              key={selectedPayment?.id ?? "new-evidence"}
              sources={detail.sources}
              value={selectedPayment?.sourceId ?? ""}
            />
          ) : null}
          <NoteField
            label={
              editor.kind === "activate"
                ? "Agreement review and authority basis"
                : "Record basis / review note"
            }
          />
          <Attestation>
            {editor.kind === "receipt"
              ? "I reviewed the original transfer total, unique reference and evidence, and this invoice's allocated amount."
              : editor.kind === "expense"
                ? "I reviewed the evidence for this paid expense and its currency."
                : "I reviewed the agreement, current context and supporting evidence for this action."}
          </Attestation>
          <Actions
            busy={busy}
            onCancel={onCancel}
            label={
              editor.kind === "invoice"
                ? "Issue invoice locally"
                : editor.kind === "activate"
                  ? "Record activation review"
                  : "Save evidence-backed record"
            }
          />
        </fieldset>
      </form>
    </section>
  );
}
