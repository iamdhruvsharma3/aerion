"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { UploadCloud, FileSpreadsheet, ArrowDownToLine, Plus } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { Field, Modal } from "./ui";
import { contactSchema, requirementSchema } from "@/lib/schema";
import { sampleCsv } from "@/lib/import";
import { downloadText } from "@/lib/format";
import { readRequirementTerms } from "@/lib/sourcing";
import { RequirementTermsFields } from "./requirement-terms-fields";

type Props = { onClose: () => void; onSuccess: (message: string) => void };

export function ImportModal({ onClose, onSuccess }: Props) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 200_000) {
      setError("Choose a CSV smaller than 200 KB.");
      return;
    }
    try {
      setCsv(await file.text());
      setFileName(file.name);
      setError("");
    } catch {
      setError("This file could not be read. Try pasting its CSV content below.");
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (!csv.trim()) throw new Error("Paste CSV content or choose a file first.");
      const form = new FormData();
      form.set("title", fileName || "Aircraft CSV import");
      form.set("sourceUrl", "");
      form.set("file", new File([csv], fileName || "inventory.csv", { type: "text/csv" }));
      const source = await api<{ id: string }>("/api/sources", { method: "POST", body: form });
      await api(`/api/sources/${source.id}/extract`, {
        method: "POST",
        body: JSON.stringify({ provider: "local" }),
      });
      onSuccess("CSV retained. Review the extracted candidates in your source library.");
      onClose();
      router.push("/sources");
    } catch (error) {
      setError(error instanceof Error ? error.message : "The import could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Bring your inventory together"
      description="Preserve your CSV and extract candidates for review before adding them to inventory."
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="modal-form">
        <label className="upload-zone">
          <span className="upload-icon">
            <UploadCloud size={25} />
          </span>
          <strong>{fileName || "Choose an aircraft CSV"}</strong>
          <span>Up to 100 records · 200 KB maximum</span>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Aircraft CSV file"
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
        </label>
        <div className="import-help">
          <FileSpreadsheet size={17} />
          <span>Start with the right columns.</span>
          <button
            type="button"
            className="text-link"
            onClick={() => downloadText("aerion-aircraft-template.csv", sampleCsv, "text/csv")}
          >
            Download template <ArrowDownToLine size={14} />
          </button>
        </div>
        <Field label="Or paste CSV content">
          <textarea
            rows={5}
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            placeholder="manufacturer,model,serial,category,year,engine,location,country…"
            required
            spellCheck={false}
          />
        </Field>
        <div className="form-inline-note">
          Blank price and availability fields stay unknown. Duplicate aircraft are flagged before
          import.
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              setCsv(sampleCsv);
              setFileName("");
              setError("");
            }}
          >
            Use sample CSV
          </button>
          <div>
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" disabled={busy}>
              <Plus size={16} />
              Save CSV for review
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export function RequirementModal({ onClose, onSuccess }: Props) {
  const { dispatch, saving } = useWorkspace();
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = Object.fromEntries(form);
    const result = requirementSchema.safeParse({
      ...fields,
      id: crypto.randomUUID(),
      quantity: Number(fields.quantity),
      minYear: Number(fields.minYear),
      ...readRequirementTerms(form),
      deadline: fields.deadline || null,
    });
    if (!result.success) {
      setError(
        result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(". "),
      );
      return;
    }
    if (!(await dispatch({ type: "requirement", item: result.data }))) {
      setError("The requirement was not saved. Check the workspace message and retry.");
      return;
    }
    onSuccess("Buyer requirement created");
    onClose();
  }
  return (
    <Modal
      title="A clear brief starts here"
      description="Capture what your buyer needs. Matching will explain the fit and flag what is missing."
      onClose={onClose}
      wide
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Buyer / organization">
            <input name="client" placeholder="e.g. Meridian Air" required maxLength={100} />
          </Field>
          <Field label="Aircraft family" hint="Use manufacturer + family, e.g. Airbus A320.">
            <input name="aircraftModel" placeholder="e.g. Airbus A320" required maxLength={100} />
          </Field>
          <Field label="Market">
            <select name="category">
              <option>Commercial</option>
              <option>Business</option>
            </select>
          </Field>
          <Field label="Quantity">
            <input type="number" name="quantity" min="1" max="50" defaultValue="1" required />
          </Field>
          <Field label="Minimum manufacture year">
            <input
              type="number"
              name="minYear"
              min="1950"
              max="2100"
              defaultValue="2010"
              required
            />
          </Field>
          <Field label="Engine requirement" hint="Leave blank if there is no engine constraint.">
            <input name="engine" placeholder="e.g. CFM56-5B" maxLength={100} />
          </Field>
          <RequirementTermsFields />
          <Field label="Delivery deadline">
            <input name="deadline" type="date" />
          </Field>
          <Field label="Delivery location">
            <input name="destination" placeholder="City, country" required maxLength={100} />
          </Field>
          <Field label="Requirement status">
            <select name="status">
              <option>Draft</option>
              <option value="Confirmed">Founder-recorded confirmation</option>
              <option>Sourcing</option>
            </select>
          </Field>
        </div>
        <Field label="Additional requirements">
          <textarea
            name="description"
            rows={3}
            placeholder="Configuration, records, preferences, and questions to resolve…"
            maxLength={5000}
          />
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <span className="form-inline-note">
            This brief does not establish a representation mandate.
          </span>
          <button className="button button-primary" type="submit" disabled={saving}>
            Create requirement <Plus size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ContactModal({ onClose, onSuccess }: Props) {
  const { dispatch, saving } = useWorkspace();
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const result = contactSchema.safeParse({ ...fields, id: crypto.randomUUID() });
    if (!result.success) {
      setError("Complete all fields and use a valid email address.");
      return;
    }
    if (!(await dispatch({ type: "contact", item: result.data }))) {
      setError("The contact was not saved. Check the workspace message and retry.");
      return;
    }
    onSuccess("Contact added to your network");
    onClose();
  }
  return (
    <Modal
      title="Grow your network"
      description="Keep the people, context, and next conversation in one place."
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Full name">
            <input name="name" required maxLength={100} />
          </Field>
          <Field label="Organization">
            <input name="company" required maxLength={100} />
          </Field>
          <Field label="Role">
            <input name="role" required maxLength={100} />
          </Field>
          <Field label="Relationship">
            <select name="type">
              <option>Buyer</option>
              <option>Seller</option>
              <option>Broker</option>
              <option>Specialist</option>
            </select>
          </Field>
          <Field label="Email">
            <input name="email" type="email" required maxLength={200} />
          </Field>
          <Field label="Location">
            <input name="location" required maxLength={100} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            name="notes"
            rows={3}
            maxLength={5000}
            placeholder="What should you remember for your next conversation?"
          />
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <span />
          <button type="submit" className="button button-primary" disabled={saving}>
            Add contact <Plus size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
