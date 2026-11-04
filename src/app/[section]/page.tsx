import { notFound } from "next/navigation";
import { AerionApp, type View } from "@/components/aerion-app";

const sections = [
  "aircraft",
  "requirements",
  "matches",
  "deals",
  "execution",
  "contacts",
  "agents",
  "sources",
  "intelligence",
  "discovery",
  "communication",
  "revenue",
  "operations",
];
export function generateStaticParams() {
  return sections.map((section) => ({ section }));
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!sections.includes(section)) notFound();
  return <AerionApp view={section as View} />;
}
