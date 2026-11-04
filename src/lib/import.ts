import { aircraftSchema, type Aircraft } from "./schema";

export const sampleCsv = `manufacturer,model,serial,registration,category,year,engine,hours,cycles,price,location,country,availableDate
Airbus,A319-112,DEMO-IMPORT-01,DEMO-I01,Commercial,2015,CFM56-5B,22000,10500,21500000,Toulouse,France,2027-03-01`;

/** Handles quoted fields, escaped quotes, CRLF and quoted newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && field.trim() !== "") throw new Error("Unexpected quote in CSV field.");
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("A quoted CSV field was not closed.");
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function importAircraft(text: string, existing: Aircraft[], today: string): Aircraft[] {
  if (text.length > 200_000) throw new Error("Please import a file smaller than 200 KB.");
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("Add a header and at least one aircraft row.");
  if (rows.length > 101) throw new Error("Import up to 100 aircraft at a time.");
  const headers = rows[0];
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique.");
  for (const required of [
    "manufacturer",
    "model",
    "serial",
    "category",
    "year",
    "engine",
    "location",
    "country",
  ]) {
    if (!headers.includes(required)) throw new Error(`Missing required column: ${required}`);
  }
  const identities = new Set(
    existing.map((a) => `${a.manufacturer.trim().toLowerCase()}:${a.serial.trim().toLowerCase()}`),
  );
  return rows.slice(1).map((row, index) => {
    if (row.length !== headers.length)
      throw new Error(`Row ${index + 2} has ${row.length} fields; expected ${headers.length}.`);
    const fields = Object.fromEntries(headers.map((header, i) => [header, row[i]]));
    const numeric = (value: string | undefined) => (value?.trim() ? Number(value) : null);
    const candidate = {
      ...fields,
      id: crypto.randomUUID(),
      registration: fields.registration || "Not supplied",
      year: Number(fields.year),
      hours: numeric(fields.hours),
      cycles: numeric(fields.cycles),
      price: numeric(fields.price),
      availableDate: fields.availableDate || null,
      availability: "Reported",
      source: "CSV import",
      sourceDate: today,
      notes: fields.notes ?? "",
    };
    const result = aircraftSchema.safeParse(candidate);
    if (!result.success)
      throw new Error(
        `Row ${index + 2}: ${result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
      );
    const identity = `${result.data.manufacturer.toLowerCase()}:${result.data.serial.toLowerCase()}`;
    if (identities.has(identity))
      throw new Error(
        `Row ${index + 2}: ${result.data.serial} already exists for ${result.data.manufacturer}. No records were imported.`,
      );
    identities.add(identity);
    return result.data;
  });
}
