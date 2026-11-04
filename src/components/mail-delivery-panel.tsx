"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Mail, Send } from "lucide-react";
import { api } from "@/lib/api";
import { dateTimeLabel } from "@/lib/format";
import type { OutreachDraft } from "@/lib/execution/schema";
import type { MailDelivery, MailStatus } from "@/lib/agents/mail-schema";
import { Badge, Field } from "./ui";
export function MailDeliveryPanel({
  draft,
  kind = "execution",
}: {
  draft: Pick<OutreachDraft, "id" | "status" | "stale">;
  kind?: "execution" | "lead";
}) {
  const [mail, setMail] = useState<MailStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [operation, setOperation] = useState<
      "queue" | "retry" | "confirm-accepted" | "confirm-not-sent" | null
    >(null);
  const key = useRef(crypto.randomUUID()),
    formRef = useRef<HTMLFormElement>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<MailStatus>(`/api/mail?draft=${draft.id}`, { signal });
      if (!signal?.aborted) setMail(result);
      return result;
    },
    [draft.id],
  );
  const delivery = mail?.deliveries[0],
    active = delivery?.status === "queued" || delivery?.status === "sending";
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(),
      timer = setInterval(() => {
        if (document.visibilityState === "visible")
          load(controller.signal).catch((e) => {
            if (!controller.signal.aborted) setError(e.message);
          });
      }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, load]);
  useEffect(() => {
    if (operation) formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [operation]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operation || busy) return;
    const form = new FormData(event.currentTarget),
      note = String(form.get("note") ?? ""),
      attested = form.get("attested") === "on";
    setBusy(true);
    setError("");
    try {
      if (operation === "queue")
        await api("/api/mail", {
          method: "POST",
          body: JSON.stringify({
            draftId: draft.id,
            kind,
            idempotencyKey: key.current,
            note,
            attested,
          }),
        });
      else if (delivery)
        await api(`/api/mail/${delivery.id}`, {
          method: "POST",
          body: JSON.stringify({ operation, revision: delivery.revision, note, attested }),
        });
      await load();
      setOperation(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The delivery action was not saved.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel(item: MailDelivery) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/mail/${item.id}`, {
        method: "POST",
        body: JSON.stringify({
          operation: "cancel",
          revision: item.revision,
          attested: true,
          note: "Founder cancelled the queued message before SMTP submission.",
        }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The message could not be cancelled.");
    } finally {
      setBusy(false);
    }
  }
  const canSend = draft.status === "Reviewed" && !draft.stale && mail?.configuration.smtp.ready;
  return (
    <section className="mail-delivery-panel">
      <div className="mail-delivery-heading">
        <Mail size={17} />
        <h3>Email delivery</h3>
        {delivery ? (
          <Badge
            tone={
              delivery.status === "accepted"
                ? "green"
                : delivery.status === "unknown"
                  ? "orange"
                  : delivery.status === "failed"
                    ? "red"
                    : "neutral"
            }
          >
            {delivery.status === "accepted" ? "Accepted by mail server" : delivery.status}
          </Badge>
        ) : null}
      </div>
      {!mail && !error ? <p role="status">Checking configured delivery options…</p> : null}
      {mail && !mail.configuration.smtp.ready ? (
        <p className="mail-configuration-note">
          Email delivery is available after SMTP credentials and the sender account are configured.
          This draft can be downloaded and reviewed locally.
        </p>
      ) : null}
      {mail?.configuration.smtp.ready && !delivery ? (
        <p>
          Sender: <strong>{mail.configuration.smtp.sender}</strong>. Review the current recipient,
          message and sharing authority before queuing an external email.
        </p>
      ) : null}
      {draft.stale ? (
        <p>
          The draft context changed. Prepare a current version and review it before queuing
          delivery.
        </p>
      ) : draft.status !== "Reviewed" ? (
        <p>Record a review of the current draft before it can be queued for sending.</p>
      ) : null}
      {delivery ? (
        <div className="mail-receipt">
          <p>
            <strong>To:</strong> {delivery.recipient}
            <br />
            <strong>From:</strong> {delivery.sender}
          </p>
          <small>
            {delivery.attempts} submission attempt(s) · {dateTimeLabel(delivery.createdAt)}
          </small>
          {delivery.error ? <p role="status">{delivery.error}</p> : null}
          {delivery.status === "accepted" ? (
            <p>
              The server accepted the message for delivery. Recipient delivery or a reply has not
              been confirmed.
            </p>
          ) : null}
          {delivery.status === "queued" ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void cancel(delivery)}
            >
              Cancel queued email
            </button>
          ) : null}
          {["failed", "cancelled"].includes(delivery.status) && canSend ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => setOperation("retry")}
            >
              Review before retrying
            </button>
          ) : null}
          {delivery.status === "unknown" ? (
            <div>
              <p>
                Check the sender’s Sent folder or SMTP logs before recording the outcome. Aerion
                will not resend automatically.
              </p>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setOperation("confirm-accepted")}
              >
                Record server acceptance
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setOperation("confirm-not-sent")}
              >
                Record confirmed unsent
              </button>
            </div>
          ) : null}
        </div>
      ) : canSend && !operation ? (
        <button
          type="button"
          className="button button-primary"
          onClick={() => setOperation("queue")}
        >
          <Send size={13} />
          Review email submission
        </button>
      ) : null}
      {operation ? (
        <form ref={formRef} className="mail-approval-form" onSubmit={submit}>
          <h4>
            {operation === "queue"
              ? "Approve this email submission"
              : operation === "retry"
                ? "Approve another submission attempt"
                : "Reconcile the recorded outcome"}
          </h4>
          <p>
            {operation === "queue" || operation === "retry"
              ? "The retained subject, body and recipient above will be sent through your configured account. This action queues the external email."
              : "Record the evidence from your Sent folder or mail server logs. This changes Aerion’s record and does not send an email."}
          </p>
          <Field label="Email approval or reconciliation note">
            <textarea
              name="note"
              required
              minLength={20}
              maxLength={2000}
              placeholder="Record your review or the server evidence supporting this outcome."
            />
          </Field>
          <label className="agent-consent">
            <input type="checkbox" name="attested" required />
            {operation === "queue" || operation === "retry"
              ? "I reviewed the recipient, message, evidence and authority to share this information, and authorize this email submission."
              : "I checked the mail account/server records and am recording the observed outcome."}
          </label>
          <div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setOperation(null)}
            >
              Back
            </button>
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy
                ? "Saving…"
                : operation === "queue" || operation === "retry"
                  ? "Approve & queue email"
                  : "Save outcome"}
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
