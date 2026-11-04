"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Database,
  Download,
  FileSearch,
  FileText,
  Plus,
  ScanText,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { agentProviderLabels, modelProviderIds } from "@/lib/agents/providers";
import type { ModelProvider } from "@/lib/agents/schema";
import { api } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import {
  fieldLabels,
  fieldNames,
  sampleSource,
  type FieldName,
  type Pipeline,
  type ReviewRecord,
  type SourceRecord,
} from "@/lib/intelligence/schema";
import type { Aircraft } from "@/lib/schema";
import { useWorkspace } from "./workspace-provider";
import { Badge, EmptyState, Field, Modal } from "./ui";

export function SourcesView({
  onImport,
  onAircraft,
}: {
  onImport: () => void;
  onAircraft: (item: Aircraft) => void;
}) {
  const { data, refresh } = useWorkspace();
  const [pipeline, setPipeline] = useState<Pipeline>({
    sources: [],
    reviews: [],
    modelReady: false,
    pendingReviews: 0,
    approvedReviews: 0,
    totalReviews: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"reviews" | "sources">("reviews");
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const [busy, setBusy] = useState("");
  const [chosenModel, setChosenModel] = useState<ModelProvider | null>(null);
  const modelProviders =
    pipeline.modelProviders ??
    modelProviderIds.map((id) => ({
      id,
      ready: id === "openai" && pipeline.modelReady,
      model: null,
    }));
  const aiProvider = chosenModel ?? modelProviders.find((item) => item.ready)?.id ?? "nvidia";
  const aiReady = modelProviders.some((item) => item.id === aiProvider && item.ready);

  const load = useCallback(async () => {
    try {
      setPipeline(await api<Pipeline>("/api/sources"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sources could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const openedReview = useRef(false);
  useEffect(() => {
    if (openedReview.current || loading) return;
    const id = new URLSearchParams(window.location.search).get("review");
    if (!id) return;
    openedReview.current = true;
    const requested = pipeline.reviews.find((item) => item.id === id);
    if (requested) setReview(requested);
    else {
      let cancelled = false;
      api<ReviewRecord>(`/api/reviews/${encodeURIComponent(id)}`)
        .then((item) => {
          if (!cancelled) setReview(item);
        })
        .catch((error) => {
          if (!cancelled) setError(error.message);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [pipeline.reviews, loading]);
  const active = pipeline.sources.some((s) => s.status === "queued" || s.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [active, load]);
  async function inspect(id: string) {
    setBusy(id);
    try {
      setSource(await api<SourceRecord>(`/api/sources/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Source could not be opened.");
    } finally {
      setBusy("");
    }
  }
  async function extract(item: SourceRecord, provider: "local" | ModelProvider) {
    setBusy(item.id);
    setError("");
    try {
      await api(`/api/sources/${item.id}/extract`, {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      setSource(null);
      await load();
      setTab("sources");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction could not be queued.");
    } finally {
      setBusy("");
    }
  }
  const pending = pipeline.pendingReviews;
  const approved = pipeline.approvedReviews;
  const legacy = data.aircraft.filter((a) => !a.evidence);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow muted">SOURCE INTELLIGENCE</div>
          <h1>From information to opportunity.</h1>
          <p>Every aircraft starts with a source. Every important fact keeps its evidence.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => setAdding(true)}>
          <Plus size={16} />
          Add a source
        </button>
      </div>
      <div className="intelligence-flow">
        <div>
          <span className="flow-mark">
            <FileText size={21} />
          </span>
          <strong>Collect</strong>
          <small>Keep the original</small>
        </div>
        <ChevronRight size={17} />
        <div>
          <span className="flow-mark">
            <ScanText size={21} />
          </span>
          <strong>Extract</strong>
          <small>Find supported facts</small>
        </div>
        <ChevronRight size={17} />
        <div>
          <span className="flow-mark accent">
            <ShieldCheck size={21} />
          </span>
          <strong>Review</strong>
          <small>You make the call</small>
        </div>
        <ChevronRight size={17} />
        <div>
          <span className="flow-mark">
            <CheckCheck size={21} />
          </span>
          <strong>Connect</strong>
          <small>Inventory → matches</small>
        </div>
      </div>
      <div className="source-summary-grid">
        <div className="source-summary">
          <Database size={22} />
          <strong>{pipeline.sources.length}</strong>
          <span>Original sources retained</span>
        </div>
        <div className="source-summary">
          <FileSearch size={22} />
          <strong>{pending}</strong>
          <span>Candidates awaiting review</span>
        </div>
        <div className="source-summary">
          <ShieldCheck size={22} />
          <strong>{approved}</strong>
          <span>Reviewed into inventory</span>
        </div>
      </div>
      {error ? (
        <div className="form-error" role="alert">
          {error}
          <button type="button" className="text-link" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      ) : null}
      <div className="source-tabs" role="tablist" aria-label="Source intelligence views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "reviews"}
          onClick={() => setTab("reviews")}
        >
          Review queue <span>{pending}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sources"}
          onClick={() => setTab("sources")}
        >
          Source library <span>{pipeline.sources.length}</span>
        </button>
        <span className="pipeline-connection">
          <span className="tiny-dot green" />
          Workspace connected
        </span>
      </div>
      <section
        className="panel intelligence-panel"
        aria-label={tab === "reviews" ? "Candidate reviews" : "Original sources"}
      >
        <div className="section-heading">
          <div>
            <h2>
              {tab === "reviews" ? "Good evidence. Clear decisions." : "Your source of context."}
            </h2>
            <p>
              {tab === "reviews"
                ? "Only approved candidates enter your aircraft inventory."
                : "Original files, extracted text, and processing history stay together."}
            </p>
          </div>
          {tab === "sources" ? (
            <button type="button" className="button button-secondary" onClick={onImport}>
              Import CSV
            </button>
          ) : (
            <Badge tone="orange">Human review</Badge>
          )}
        </div>
        {loading ? (
          <p className="no-results">Loading your sources…</p>
        ) : tab === "reviews" ? (
          pipeline.reviews.length ? (
            <div className="review-list">
              {pipeline.reviews.map((item) => {
                const origin = pipeline.sources.find((s) => s.id === item.sourceId);
                return (
                  <button
                    type="button"
                    className="review-list-item"
                    key={item.id}
                    onClick={() => setReview(item)}
                  >
                    <span
                      className={`review-item-icon ${item.status === "approved" ? "approved" : ""}`}
                    >
                      {item.status === "approved" ? <Check size={21} /> : <FileSearch size={21} />}
                    </span>
                    <span className="review-item-copy">
                      <strong>
                        {[item.values.manufacturer, item.values.model].filter(Boolean).join(" ") ||
                          "Aircraft candidate"}
                      </strong>
                      <small>
                        {item.values.serial || "Serial not supplied"} ·{" "}
                        {origin?.title || "Retained source"}
                      </small>
                    </span>
                    <span className="review-list-meta">
                      <Badge
                        tone={
                          item.status === "approved"
                            ? "green"
                            : item.status === "pending"
                              ? "orange"
                              : "neutral"
                        }
                      >
                        {item.status === "pending"
                          ? "Needs review"
                          : item.status === "approved"
                            ? "Approved"
                            : "Rejected"}
                      </Badge>
                      <small>
                        {item.facts.length} supported observations
                        {item.warnings.length ? ` · ${item.warnings.length} flags` : ""}
                      </small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="Your next aircraft starts here."
              detail="Add a specification sheet, CSV, or pasted source. Extract its facts, then review what belongs in your inventory."
              action={
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setAdding(true)}
                >
                  <Plus size={16} />
                  Add your first source
                </button>
              }
            />
          )
        ) : pipeline.sources.length ? (
          <div className="source-document-list">
            {pipeline.sources.map((item) => (
              <button
                type="button"
                className="source-document-row"
                key={item.id}
                disabled={busy === item.id}
                onClick={() => void inspect(item.id)}
              >
                <span className="document-type">{item.kind.toUpperCase()}</span>
                <span className="review-item-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {item.filename} · {dateLabel(item.createdAt.slice(0, 10))}
                  </small>
                  {item.error ? <span className="source-job-error">{item.error}</span> : null}
                </span>
                <Badge
                  tone={
                    item.status === "completed"
                      ? "green"
                      : item.status === "failed"
                        ? "red"
                        : item.status === "ready"
                          ? "neutral"
                          : "blue"
                  }
                >
                  {item.status === "ready"
                    ? "Ready to extract"
                    : item.status === "completed"
                      ? "Extracted"
                      : item.status === "failed"
                        ? "Needs attention"
                        : item.status === "queued"
                          ? "Queued"
                          : "Extracting"}
                </Badge>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Keep the source. Build the picture."
            detail="PDF, CSV, text, and email sources are preserved with a content fingerprint and original download."
            action={
              <button
                type="button"
                className="button button-primary"
                onClick={() => setAdding(true)}
              >
                Add a source
              </button>
            }
          />
        )}
      </section>
      {pipeline.totalReviews > pipeline.reviews.length ? (
        <p className="review-requirements">
          Showing {pipeline.reviews.length} of {pipeline.totalReviews} reviews, with pending
          candidates first. Older reviewed records remain accessible through aircraft and
          opportunity evidence links.
        </p>
      ) : null}
      <div className="info-strip">
        <ShieldCheck size={17} />
        <span>
          Review records source claims. Seller authority, current availability, and technical
          condition still need their own evidence.
        </span>
      </div>
      {legacy.length ? (
        <section className="panel legacy-sources">
          <div className="section-heading">
            <div>
              <h2>Earlier inventory records</h2>
              <p>
                {legacy.length} records have source labels. Attach their original documents through
                this workflow.
              </p>
            </div>
          </div>
          {legacy.slice(0, 5).map((item) => (
            <button
              type="button"
              className="text-link"
              key={item.id}
              onClick={() => onAircraft(item)}
            >
              {item.manufacturer} {item.model} · {item.serial}
              <ArrowRight size={14} />
            </button>
          ))}
        </section>
      ) : null}
      {adding ? (
        <AddSourceModal
          onClose={() => setAdding(false)}
          onSaved={async (id) => {
            setAdding(false);
            setTab("sources");
            await load();
            await inspect(id);
          }}
        />
      ) : null}
      {source ? (
        <Modal
          title={source.title}
          description="Inspect the original evidence before starting an extraction."
          onClose={() => setSource(null)}
          wide
        >
          <div className="document-inspector">
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="document-toolbar">
              <Badge>
                {source.kind.toUpperCase()} · {source.pages.length}{" "}
                {source.pages.length === 1 ? "page" : "pages"}
              </Badge>
              <a className="button button-secondary" href={`/api/sources/${source.id}/document`}>
                <Download size={15} />
                Original document
              </a>
            </div>
            {source.sourceUrl ? (
              <a
                href={source.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="source-origin-link"
              >
                {source.sourceUrl}
              </a>
            ) : null}
            {source.pages.some((page) => page.text.startsWith("[Local English OCR")) ? (
              <p className="review-warnings">
                This PDF includes local English OCR. Compare numbers, identifiers and units against
                the original PDF before approving extracted facts.
              </p>
            ) : null}
            <div className="source-pages">
              {source.pages.map((page) => (
                <div key={page.page}>
                  <span className="eyebrow muted">PAGE {page.page}</span>
                  <pre>{page.text}</pre>
                </div>
              ))}
            </div>
            <p className="document-fingerprint">
              SHA-256 <code>{source.sha256}</code>
            </p>
            {source.status === "ready" || source.status === "failed" ? (
              <div className="extraction-options">
                <div>
                  <strong>Choose how to extract</strong>
                  <p>
                    Local parsing reads exact field labels and CSV columns. AI extraction handles
                    free-form text when connected.
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy === source.id}
                  onClick={() => void extract(source, "local")}
                >
                  <ScanText size={15} />
                  Extract labelled fields
                </button>
                <Field
                  label="AI extraction provider"
                  hint="AI extraction sends retained document passages to the selected provider. Results require source review."
                >
                  <select
                    value={aiProvider}
                    onChange={(event) => setChosenModel(event.target.value as ModelProvider)}
                  >
                    {modelProviders.map((item) => (
                      <option key={item.id} value={item.id}>
                        {agentProviderLabels[item.id]} ·{" "}
                        {item.ready ? "configured" : "setup needed"}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!aiReady || busy === source.id}
                  onClick={() => void extract(source, aiProvider)}
                >
                  AI extract
                </button>
                {!aiReady ? (
                  <small>AI provider not connected · local parsing is available now</small>
                ) : null}
              </div>
            ) : (
              <div className="info-strip">
                <Clock3 size={17} />
                <span>
                  {source.status === "completed"
                    ? "Extraction complete. Open the review queue to inspect its candidates."
                    : "This extraction is in the processing queue. Keep the local worker running."}
                </span>
              </div>
            )}
          </div>
        </Modal>
      ) : null}
      {review ? (
        <ReviewModal
          key={review.id}
          review={review}
          onClose={() => setReview(null)}
          onDone={async () => {
            setReview(null);
            await Promise.all([load(), refresh()]);
          }}
          onAircraft={(id) => {
            const item = data.aircraft.find((a) => a.id === id);
            if (item) {
              setReview(null);
              onAircraft(item);
            }
          }}
        />
      ) : null}
    </>
  );
}

function AddSourceModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"text" | "file">("text");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    if (mode === "text") {
      form.delete("file");
      form.set("text", text);
    } else form.delete("text");
    try {
      const result = await api<{ id: string }>("/api/sources", { method: "POST", body: form });
      await onSaved(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Source could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Keep the original. Find the facts."
      description="Save source material before extracting aircraft observations."
      onClose={onClose}
      wide
    >
      <form className="modal-form" onSubmit={submit}>
        <Field label="Source title">
          <input
            name="title"
            required
            maxLength={300}
            placeholder="e.g. A319 specification sheet · October 2026"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <div className="source-mode-switch">
          <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
            <FileText size={16} />
            Paste text
          </button>
          <button type="button" aria-pressed={mode === "file"} onClick={() => setMode("file")}>
            <UploadCloud size={16} />
            Upload document
          </button>
        </div>
        {mode === "text" ? (
          <>
            <Field
              label="Original source text"
              hint="Local parsing recognizes field labels such as Manufacturer:, Model:, Serial:, Category:, Year:, Price USD:. Separate aircraft with ---. No values are inferred."
            >
              <textarea
                name="text"
                rows={12}
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={200000}
                placeholder="Paste the source text here…"
              />
            </Field>
            <button
              type="button"
              className="text-link"
              onClick={() => {
                setText(sampleSource);
                setTitle("Fictional A319 · workflow example");
              }}
            >
              Use a fictional example
              <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <Field
            label="Original document"
            hint="PDF, CSV, TXT or EML · up to 10 MB and 40 PDF pages. Local English OCR supports up to eight image-only pages; check the transcription against the original."
          >
            <input name="file" type="file" accept=".pdf,.csv,.txt,.eml" required />
          </Field>
        )}
        <Field
          label="Source URL · optional"
          hint="Stored as a reference. Aerion will not fetch this URL."
        >
          <input name="sourceUrl" type="url" maxLength={2000} placeholder="https://…" />
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Preserving source…" : "Save source"}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReviewModal({
  review,
  onClose,
  onDone,
  onAircraft,
}: {
  review: ReviewRecord;
  onClose: () => void;
  onDone: () => Promise<void>;
  onAircraft: (id: string) => void;
}) {
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [values, setValues] = useState<Partial<Record<FieldName, string>>>(() => ({
    ...Object.fromEntries(
      Object.entries(review.values).map(([key, value]) => [key, String(value)]),
    ),
    offering: String(
      review.values.offering ?? (review.values.price != null ? "Sale" : "Not supplied"),
    ),
  }));
  const [note, setNote] = useState(review.note);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<SourceRecord>(`/api/sources/${review.sourceId}`)
      .then((s) => {
        if (active) setSource(s);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [review.sourceId]);
  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError("");
    const parsed = Object.fromEntries(
      fieldNames
        .filter(
          (field) =>
            field !== "offering" ||
            review.values.offering !== undefined ||
            values.offering !== (review.values.price != null ? "Sale" : "Not supplied"),
        )
        .map((field) => [
          field,
          values[field]?.trim()
            ? ["year", "hours", "cycles", "price", "leaseRate"].includes(field)
              ? Number(values[field])
              : values[field]?.trim()
            : null,
        ]),
    );
    try {
      await api(`/api/reviews/${review.id}`, {
        method: "POST",
        body: JSON.stringify({ decision, values: parsed, note, attested }),
      });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const pending = review.status === "pending";
  return (
    <Modal
      title={pending ? "A closer look, before it connects." : "The evidence behind this aircraft."}
      description={
        pending
          ? "Check each proposed value against its source. Missing facts stay missing."
          : `Review ${review.status}${review.reviewedAt ? ` · ${dateLabel(review.reviewedAt.slice(0, 10))}` : ""}`
      }
      onClose={onClose}
      wide
    >
      <div className="review-workbench">
        <div className="review-evidence-heading">
          <span>
            <FileText size={18} />
            <strong>{source?.title || "Loading source…"}</strong>
          </span>
          <a className="text-link" href={`/api/sources/${review.sourceId}/document`}>
            <Download size={15} />
            Original
          </a>
        </div>
        {source?.pages.some((page) => page.text.startsWith("[Local English OCR")) ? (
          <div className="review-warnings">
            <p>
              OCR transcription: check every proposed value against the original PDF image. Matching
              a transcription is not proof of recognition accuracy.
            </p>
          </div>
        ) : null}
        {review.warnings.length ? (
          <div className="review-warnings">
            {[...new Set(review.warnings)].map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
        <div className="review-field-grid">
          {fieldNames.map((field) => {
            const facts = review.facts.filter((f) => f.field === field);
            return (
              <div className={`review-field ${facts.length ? "" : "missing-fact"}`} key={field}>
                <Field label={fieldLabels[field]}>
                  {["category", "offering", "leaseBasis"].includes(field) ? (
                    <select
                      disabled={!pending}
                      value={values[field] || ""}
                      onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                    >
                      <option value={field === "offering" ? "Not supplied" : ""}>
                        Not supplied
                      </option>
                      {(field === "category"
                        ? ["Commercial", "Business"]
                        : field === "offering"
                          ? ["Sale", "Lease", "Sale or lease"]
                          : ["Monthly rent", "Hourly rate"]
                      ).map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      disabled={!pending}
                      type={
                        field === "availableDate"
                          ? "date"
                          : ["year", "hours", "cycles", "price", "leaseRate"].includes(field)
                            ? "number"
                            : "text"
                      }
                      step={["price", "hours", "leaseRate"].includes(field) ? "any" : "1"}
                      value={values[field] || ""}
                      maxLength={field === "leaseCurrency" ? 3 : 300}
                      placeholder="Not supplied"
                      onChange={(e) =>
                        setValues((v) => ({
                          ...v,
                          [field]:
                            field === "leaseCurrency"
                              ? e.target.value.toUpperCase()
                              : e.target.value,
                        }))
                      }
                    />
                  )}
                </Field>
                {facts.length ? (
                  facts.map((fact) => (
                    <blockquote key={`${field}-${fact.page}-${fact.value}-${fact.quote}`}>
                      <span>PAGE {fact.page} · SOURCE OBSERVATION</span>
                      {fact.quote}
                    </blockquote>
                  ))
                ) : (
                  <small className="missing-fact-hint">No supporting value extracted</small>
                )}
              </div>
            );
          })}
        </div>
        {source ? (
          <details className="full-source">
            <summary>Read the complete source text</summary>
            {source.pages.map((p) => (
              <div key={p.page}>
                <span className="eyebrow muted">PAGE {p.page}</span>
                <pre>{p.text}</pre>
              </div>
            ))}
          </details>
        ) : null}
        {pending ? (
          <>
            <Field
              label="Review note"
              hint="Required when you correct a value or add a missing fact. Explain the supporting evidence."
            >
              <textarea
                rows={3}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Corrections, clarifications, and evidence checked…"
              />
            </Field>
            <label className="review-attestation">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />
              <span>I checked these values against the source.</span>
            </label>
            <p className="review-requirements">
              Manufacturer, model, serial number, market, and year are required for inventory. Leave
              the candidate pending when those facts are unavailable. Approval retains the aircraft
              as reported. Purchase price is a total USD asking amount. Lease rate needs its
              separate currency and monthly or hourly basis; leave unclear commercial terms not
              supplied.
            </p>
          </>
        ) : (
          <p className="review-audit-note">
            {review.note || "No additional review note."}
            <br />
            Reviewer reference: <code>{review.reviewer}</code>
          </p>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          {pending ? (
            <>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void decide("reject")}
              >
                Reject candidate
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={busy || !attested || !source}
                onClick={() => void decide("approve")}
              >
                <Check size={16} />
                {busy ? "Saving review…" : "Approve to inventory"}
              </button>
            </>
          ) : review.aircraftId ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => onAircraft(review.aircraftId as string)}
            >
              Open aircraft
              <ArrowRight size={15} />
            </button>
          ) : (
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        <Link href="/matches" className="review-matches-link" onClick={onClose}>
          Explore aircraft matches
          <ArrowRight size={14} />
        </Link>
      </div>
    </Modal>
  );
}
