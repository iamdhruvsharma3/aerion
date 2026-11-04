import type { PoolClient } from "pg";
import type { SourcePage, SourceRecord } from "../lib/intelligence/schema";
import { HttpError } from "./http";

export type RetainedDocument = {
  id: string;
  workspaceId: string;
  title: string;
  kind: SourceRecord["kind"];
  sourceUrl: string | null;
  filename: string;
  contentType: string;
  sha256: string;
  original: Buffer;
  pages: SourcePage[];
};
export type OriginalDocument = { original: Buffer; contentType: string; filename: string };
/** Stores use the caller's scoped transaction. Object storage can replace this adapter later. */
export interface DocumentStore {
  retain(db: PoolClient, document: RetainedDocument): Promise<void>;
  read(db: PoolClient, workspaceId: string, sourceId: string): Promise<OriginalDocument>;
}
export const documentStore: DocumentStore = {
  async retain(db, d) {
    await db.query(
      "insert into aerion.sources(id,workspace_id,title,kind,source_url,filename,content_type,sha256,original,pages) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        d.id,
        d.workspaceId,
        d.title,
        d.kind,
        d.sourceUrl,
        d.filename,
        d.contentType,
        d.sha256,
        d.original,
        JSON.stringify(d.pages),
      ],
    );
  },
  async read(db, workspaceId, sourceId) {
    const { rows } = await db.query(
      'select original,content_type as "contentType",filename from aerion.sources where id=$1 and workspace_id=$2',
      [sourceId, workspaceId],
    );
    if (!rows[0]) throw new HttpError(404, "Source not found in this workspace.");
    return rows[0];
  },
};
