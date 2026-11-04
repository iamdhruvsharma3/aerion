"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone-state">
      <span className="eyebrow">AERION</span>
      <h1>Let’s try that again.</h1>
      <p>The workspace could not load this view. Your saved records remain on this device.</p>
      <button type="button" className="button button-primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
