"use client";

import { useState } from "react";
import { Check, Copy, Download, FileText, UploadCloud, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { downloadText } from "@/lib/format";
import { sampleMarketSource } from "@/lib/intelligence/market-schema";
import { Field, Modal } from "./ui";

type UploadResult = { name: string; status: "retained" | "duplicate" | "failed"; detail: string };
export function BatchSourceModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"files" | "text">("files");
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [queue, setQueue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<(UploadResult & { id: string })[]>([]);
  const [finished, setFinished] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const documents =
      mode === "files" ? files : [new File([text], "market-brief.txt", { type: "text/plain" })];
    if (!documents.length || (mode === "text" && !text.trim())) {
      setError("Choose documents or paste a brief first.");
      return;
    }
    if (documents.length > 100 || documents.reduce((n, f) => n + f.size, 0) > 100_000_000) {
      setError("Choose up to 100 documents totalling at most 100 MB per batch.");
      return;
    }
    setBusy(true);
    setError("");
    setResults([]);
    setFinished(false);
    async function upload(file: File) {
      let result: UploadResult;
      try {
        if (file.size > 10_000_000) throw new Error("File exceeds the 10 MB limit.");
        const form = new FormData();
        form.set("file", file);
        form.set("title", mode === "text" ? title : file.name.slice(0, 300));
        form.set("sourceUrl", url);
        const retained = await api<{ id: string }>("/api/sources", { method: "POST", body: form });
        let detail = "Original retained. Ready for extraction.";
        if (queue) {
          try {
            const queued = await api<{ results: { status: string; error?: string }[] }>(
              "/api/intelligence/extract",
              {
                method: "POST",
                body: JSON.stringify({ ids: [retained.id] }),
              },
            );
            detail =
              queued.results[0]?.status === "queued"
                ? "Original retained · market extraction queued."
                : `Original retained. ${queued.results[0]?.error ?? "Queue extraction from Source inbox."}`;
          } catch {
            detail = "Original retained. Queue extraction from Source inbox.";
          }
        }
        result = { name: file.name, status: "retained", detail };
      } catch (e) {
        result = {
          name: file.name,
          status: e instanceof ApiError && e.status === 409 ? "duplicate" : "failed",
          detail: e instanceof Error ? e.message : "Upload failed.",
        };
      }
      setResults((previous) => [...previous, { ...result, id: crypto.randomUUID() }]);
    }
    // Two bounded requests at a time; failures do not roll back other originals.
    try {
      for (let offset = 0; offset < documents.length; offset += 2)
        await Promise.all(documents.slice(offset, offset + 2).map(upload));
      setFinished(true);
      await onDone();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The workspace could not refresh. Retained files are safe.",
      );
    } finally {
      setBusy(false);
    }
  }
  const target = mode === "files" ? files.length : 1;
  return (
    <Modal
      title="Bring the market into view."
      description="Retain source documents, then extract signals for your review."
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="modal-form" onSubmit={submit}>
        {!busy && !finished ? (
          <>
            <div className="source-mode-switch">
              <button
                type="button"
                aria-pressed={mode === "files"}
                onClick={() => setMode("files")}
              >
                Upload a batch
              </button>
              <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>
                Paste a brief
              </button>
            </div>
            {mode === "files" ? (
              <label className="upload-zone">
                <UploadCloud size={29} />
                <strong>
                  {files.length
                    ? `${files.length} documents selected`
                    : "Choose your source documents"}
                </strong>
                <span>PDF, CSV, TXT, EML · 100 files / batch · 10 MB / file · 100 MB total</span>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.csv,.txt,.eml"
                  aria-label="Market source documents"
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files ?? []));
                    setResults([]);
                  }}
                />
              </label>
            ) : (
              <>
                <Field label="Brief title">
                  <input
                    required
                    maxLength={300}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Organization or source headline"
                  />
                </Field>
                <Field
                  label="Original brief text"
                  hint="Local parsing reads explicit market labels and simple order headlines. Unknown fields remain empty."
                >
                  <textarea
                    required
                    rows={9}
                    maxLength={200000}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Organization: …&#10;Aircraft family: …&#10;Signal type: Demand / Supply / Fleet activity"
                  />
                </Field>
                <button
                  className="text-link"
                  type="button"
                  onClick={() => {
                    setText(sampleMarketSource);
                    setTitle("Fictional market workflow examples");
                  }}
                >
                  Use fictional examples <FileText size={14} />
                </button>
              </>
            )}
            <Field
              label="Source URL · optional"
              hint="Stored as a reference; Aerion does not fetch it. Applied to every document in this batch."
            >
              <input
                type="url"
                maxLength={2000}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
              />
            </Field>
            <label className="review-attestation">
              <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
              <span>Queue local market extraction after each upload.</span>
            </label>
            <div className="market-format-note">
              <strong>A simple, explicit format.</strong>
              <p>
                organization, aircraftFamily, intent, market, geography, eventDate, quantity. Use
                ISO dates and separate text signals with ---.
              </p>
              <button
                className="text-link"
                type="button"
                onClick={() =>
                  downloadText(
                    "aerion-market-template.csv",
                    "organization,aircraftFamily,intent,market,geography,eventDate,quantity\nExample Meridian Aviation,Airbus A319,Demand,Commercial,India,2026-10-20,1\n",
                    "text/csv",
                  )
                }
              >
                Download fictional CSV template <Download size={14} />
              </button>
            </div>
          </>
        ) : null}
        {busy || results.length ? (
          <div className="batch-progress" aria-live="polite">
            <strong>{finished ? "Batch complete" : "Preserving originals…"}</strong>
            <span>
              {results.length} / {target} processed ·{" "}
              {results.filter((r) => r.status === "retained").length} retained ·{" "}
              {results.filter((r) => r.status === "duplicate").length} duplicates
            </span>
            <progress max={target} value={results.length} />
            <div className="batch-results">
              {results.map((r) => (
                <div key={r.id}>
                  <span className={`batch-result-icon ${r.status}`}>
                    {r.status === "retained" ? (
                      <Check size={15} />
                    ) : r.status === "duplicate" ? (
                      <Copy size={15} />
                    ) : (
                      <X size={15} />
                    )}
                  </span>
                  <div>
                    <strong>{r.name}</strong>
                    <small>{r.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <span className="subtle-label">Originals and evidence stay linked</span>
          <div>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={onClose}
            >
              {finished ? "Done" : "Cancel"}
            </button>
            {!finished ? (
              <button type="submit" className="button button-primary" disabled={busy}>
                {busy ? "Processing batch…" : "Retain and continue"}
              </button>
            ) : (
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  setFinished(false);
                  setResults([]);
                  setFiles([]);
                }}
              >
                Add another batch
              </button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
