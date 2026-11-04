import type { RevenueInvoice } from "../../lib/revenue/schema";
import { revenueMoney } from "../../lib/revenue/money";

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
export function invoiceHtml(invoice: RevenueInvoice) {
  const s = invoice.snapshot,
    money = (value: string) => html(revenueMoney(value, invoice.currency));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(invoice.number)} · Invoice</title><style>
  *{box-sizing:border-box}body{font:14px/1.65 system-ui,sans-serif;color:#20352a;background:#eff3ed;margin:0;padding:32px}main{max-width:850px;margin:auto;background:white;border:1px solid #dce5d7;padding:54px}header{display:flex;justify-content:space-between;gap:25px;border-bottom:3px solid #47613c;padding-bottom:26px}h1{margin:0;font-size:38px;letter-spacing:-1.5px}h2{font-size:18px;margin:0 0 10px}p{margin:6px 0}.eyebrow{letter-spacing:2px;color:#718466;font-size:11px;text-transform:uppercase}.number{font-size:21px;margin-top:6px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:44px;margin:35px 0}.address{white-space:pre-wrap}.label{color:#6c7d61;font-size:12px}.dates{display:flex;gap:45px}table{width:100%;border-collapse:collapse;margin:30px 0 15px}th{text-align:left;color:#6c7d61;font-size:11px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #dce5d7}td,th{padding:15px 0}td{vertical-align:top}td:last-child,th:last-child{text-align:right;padding-left:24px;white-space:nowrap}.total{margin-left:auto;width:min(100%,350px)}.total p{display:flex;justify-content:space-between;gap:24px}.grand{border-top:1px solid #dce5d7;padding-top:15px;font-size:19px;font-weight:650}.section{padding-top:24px;margin-top:25px;border-top:1px solid #e3e9df}.status{font-weight:600;color:#7c5634}.footer{font-size:11px;color:#6e7b67;margin-top:30px} @media(max-width:600px){body{padding:10px}main{padding:24px}.parties{grid-template-columns:1fr;gap:24px}header{flex-wrap:wrap}} @media print{@page{size:A4;margin:14mm}body{background:white;padding:0}main{padding:0;border:0;max-width:none}.section{break-inside:avoid}table{break-inside:avoid}a{color:inherit;text-decoration:none}}
  </style></head><body><main><header><div><div class="eyebrow">${html(s.issuerName)}</div><h1>Invoice</h1><div class="number">${html(invoice.number)}</div></div><div><p class="status">${html(invoice.status)}</p><p class="label">Currency ${html(invoice.currency)}</p></div></header>
  <div class="parties"><section><div class="eyebrow">Issued by</div><h2>${html(s.issuerName)}</h2><p class="address">${html(s.issuerAddress)}</p><p>${html(s.issuerEmail)}</p>${s.issuerRegistration ? `<p>${html(s.issuerRegistration)}</p>` : ""}</section><section><div class="eyebrow">Bill to</div><h2>${html(s.billTo.company)}</h2><p>${html(s.billTo.name)}</p><p class="address">${html(s.billTo.address)}</p><p>${html(s.billTo.email)}</p></section></div>
  <div class="dates"><p><span class="label">Issue date</span><br>${html(invoice.issuedOn)}</p><p><span class="label">Due date</span><br>${html(invoice.dueOn)}</p></div>
  <table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody><tr><td><strong>${html(s.engagementTitle)}</strong><p class="address">${html(s.description)}</p></td><td>${money(invoice.subtotalMinor)}</td></tr></tbody></table>
  <div class="total"><p><span>Fee subtotal</span><span>${money(invoice.subtotalMinor)}</span></p><p><span>${html(s.taxLabel || "Recorded tax / charge")}</span><span>${money(invoice.taxMinor)}</span></p><p class="grand"><span>Invoice total</span><span>${money(invoice.totalMinor)}</span></p></div>
  ${invoice.status === "Voided" ? `<section class="section"><h2>Invoice voided</h2><p>${html(invoice.voidNote)}</p></section>` : ""}
  <section class="section"><h2>Payment instructions</h2><p class="address">${html(s.paymentInstructions)}</p><p class="address">${html(s.feeTerms.paymentTerms)}</p></section>
  <section class="section"><h2>Agreed fee basis</h2><p>${html(s.feeTerms.type)}${s.feeTerms.percentage ? ` · ${html(s.feeTerms.percentage)}%` : ""}</p><p>${html(s.feeTerms.basisDescription)}</p><p>${html(s.feeTerms.earningTerms)}</p></section>
  <p class="footer">Issued document snapshot retained by Aerion. Payment records and current balance are maintained separately. Tax amounts and registration details are supplied by the issuer; no tax calculation or jurisdictional certification is performed by Aerion. Print this document or save as PDF using your browser.</p>
  </main></body></html>`;
}
