import Link from "next/link";

export default function NotFound() {
  return (
    <main className="standalone-state">
      <span className="eyebrow">AERION · 404</span>
      <h1>A little off course.</h1>
      <p>This page isn’t in your workspace.</p>
      <Link className="button button-primary" href="/">
        Back to overview
      </Link>
    </main>
  );
}
