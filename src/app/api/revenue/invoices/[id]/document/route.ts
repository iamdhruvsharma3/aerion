import { z, ZodError } from "zod";
import { requireScope } from "@/server/auth";
import { HttpError } from "@/server/http";
import { readRevenueInvoice } from "@/server/revenue/repository";
import { invoiceHtml } from "@/server/revenue/invoice";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const invoice = await readRevenueInvoice(
      await requireScope(request),
      z.uuid().parse((await context.params).id),
    );
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(invoiceHtml(invoice), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        ...(download
          ? { "Content-Disposition": `attachment; filename="${invoice.number}.html"` }
          : {}),
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : error instanceof ZodError
              ? "Invalid invoice ID."
              : "The invoice could not be loaded.",
      },
      {
        status: error instanceof HttpError ? error.status : error instanceof ZodError ? 422 : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
