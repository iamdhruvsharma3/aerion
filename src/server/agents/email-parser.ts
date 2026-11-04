import PostalMime from "postal-mime";
import { load } from "cheerio";
import { HttpError } from "../http";
import { calendarDate } from "../../lib/format";
export function boundedMessageIds(value: string) {
  return [...new Set(value.slice(0, 30000).match(/<[^<>\s]{1,250}>/g) ?? [])].slice(0, 80);
}
export async function parseEmail(bytes: Buffer, account?: string) {
  if (bytes.length > 2_000_000)
    throw new HttpError(413, "Email intake supports messages up to 2 MB, including attachments.");
  const email = await PostalMime.parse(bytes, {
    maxNestingDepth: 20,
    maxRfc822NestingDepth: 3,
    maxHeadersSize: 100000,
  });
  const from = email.from && "address" in email.from ? (email.from.address ?? "") : "";
  const recipients = (email.to ?? []).flatMap((a) =>
    "address" in a && a.address ? [a.address] : [],
  );
  const parsedDate = email.date ? new Date(email.date) : null,
    occurredOn =
      parsedDate && !Number.isNaN(parsedDate.getTime()) ? calendarDate(parsedDate) : null;
  const html = load(email.html ?? "");
  html("script,style,iframe,form,noscript").remove();
  html("br").replaceWith("\n");
  html("p,div,li").append("\n");
  const body = (email.text ?? html.text()).trim();
  const direction =
    account && from.toLowerCase() === account.toLowerCase()
      ? "Outbound"
      : account && recipients.some((r) => r.toLowerCase() === account.toLowerCase())
        ? "Inbound"
        : null;
  const contactEmail =
    direction === "Inbound"
      ? from
      : direction === "Outbound" && recipients.length === 1
        ? recipients[0]
        : null;
  const header = (key: string) =>
    email.headers
      .filter((item) => item.key.toLowerCase() === key)
      .map((item) => item.value)
      .join(" ");
  const messageIds = boundedMessageIds(header("message-id"));
  const inReplyTo = boundedMessageIds(header("in-reply-to"));
  const references = boundedMessageIds(header("references"));
  const classification = /multipart\/report/i.test(header("content-type"))
    ? ("Delivery report" as const)
    : header("auto-submitted") && !/^no$/i.test(header("auto-submitted").trim())
      ? ("Auto reply" as const)
      : ("Message" as const);
  const text = [
    `Subject: ${email.subject ?? "Not supplied"}`,
    `Summary: Email subject: ${email.subject ?? "Not supplied"}`,
    `From: ${from || "Not supplied"}`,
    `To: ${recipients.join(", ") || "Not supplied"}`,
    `Message-ID: ${email.messageId ?? "Not supplied"}`,
    `In-Reply-To: ${inReplyTo.join(" ") || "Not supplied"}`,
    `References: ${references.join(" ") || "Not supplied"}`,
    `Source date header: ${email.headers.find((h) => h.key === "date")?.value ?? "Not supplied"}`,
    occurredOn ? `Header date in workspace timezone: ${occurredOn}` : "Header date: Not supplied",
    direction ? `Direction: ${direction}` : "Direction: Not established",
    contactEmail ? `Contact email: ${contactEmail}` : "Contact email: Not established",
    occurredOn ? `OccurredOn: ${occurredOn}` : "",
    `Attachments: ${email.attachments.map((a) => a.filename ?? a.mimeType).join(", ") || "None"}`,
    "",
    "Message body (untrusted source statements):",
    body,
    "",
    "Mailbox headers and sender addresses are source statements; parsing does not authenticate identity, authority or the claims in the body.",
  ]
    .filter(Boolean)
    .join("\n");
  if (!body && !email.subject)
    throw new HttpError(422, "The email contains no readable subject or message body.");
  if (text.length > 200000)
    throw new HttpError(413, "Parsed email text exceeds 200,000 characters.");
  return {
    email,
    text,
    from,
    recipients,
    occurredOn,
    direction,
    contactEmail,
    subject: (email.subject ?? "Retained email").slice(0, 250),
    messageId: messageIds.length === 1 ? messageIds[0] : null,
    inReplyTo,
    references,
    classification,
  };
}
