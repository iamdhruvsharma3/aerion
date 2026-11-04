import { z } from "zod";
import { evaluateMatch } from "./matching";
import {
  aircraftSchema,
  contactSchema,
  dealSchema,
  requirementSchema,
  workspaceSchema,
  type Workspace,
} from "./schema";

export const emptyWorkspace: Workspace = {
  version: 1,
  aircraft: [],
  requirements: [],
  contacts: [],
  deals: [],
  tasks: [],
  saved: [],
};
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("aircraft"), items: z.array(aircraftSchema).min(1).max(100) }),
  z.object({ type: z.literal("requirement"), item: requirementSchema }),
  z.object({ type: z.literal("contact"), item: contactSchema }),
  z.object({ type: z.literal("deal"), item: dealSchema }),
  z.object({ type: z.literal("toggle-task"), id: z.string().min(1) }),
  z.object({ type: z.literal("save-aircraft"), id: z.string().min(1) }),
  z.object({ type: z.literal("migrate"), workspace: workspaceSchema }),
]);
export type WorkspaceAction = z.infer<typeof actionSchema>;

export function applyAction(data: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case "aircraft": {
      const identities = new Set(data.aircraft.map(identity));
      for (const item of action.items) {
        if (identities.has(identity(item)) || data.aircraft.some((a) => a.id === item.id))
          throw new Error("This aircraft already exists. Review the existing record instead.");
        identities.add(identity(item));
      }
      return workspaceSchema.parse({ ...data, aircraft: [...action.items, ...data.aircraft] });
    }
    case "requirement":
      if (data.requirements.some((r) => r.id === action.item.id))
        throw new Error("Requirement already exists.");
      return workspaceSchema.parse({ ...data, requirements: [action.item, ...data.requirements] });
    case "contact":
      if (data.contacts.some((c) => c.id === action.item.id))
        throw new Error("Contact already exists.");
      return workspaceSchema.parse({ ...data, contacts: [action.item, ...data.contacts] });
    case "deal": {
      const aircraft = data.aircraft.find((a) => a.id === action.item.aircraftId);
      if (!aircraft || !data.requirements.some((r) => r.id === action.item.requirementId))
        throw new Error("Select an aircraft and requirement in this workspace.");
      const existing = data.deals.find((deal) => deal.id === action.item.id);
      if (
        existing &&
        (existing.aircraftId !== action.item.aircraftId ||
          existing.requirementId !== action.item.requirementId)
      )
        throw new Error("An opportunity's aircraft and buyer references cannot be changed.");
      if (!existing) {
        const requirement = data.requirements.find((item) => item.id === action.item.requirementId);
        if (!requirement || evaluateMatch(aircraft, requirement).state !== "eligible")
          throw new Error("Only eligible matches can create an opportunity.");
        if (
          data.deals.some(
            (deal) => deal.aircraftId === aircraft.id && deal.requirementId === requirement.id,
          )
        )
          throw new Error("This match already has an opportunity.");
      }
      const requirement = data.requirements.find((item) => item.id === action.item.requirementId);
      const item = {
        ...action.item,
        evidence: aircraft.evidence,
        requirementEvidence: requirement?.intelligence,
      };
      return workspaceSchema.parse({
        ...data,
        deals: data.deals.some((d) => d.id === item.id)
          ? data.deals.map((d) => (d.id === item.id ? item : d))
          : [item, ...data.deals],
      });
    }
    case "toggle-task":
      return {
        ...data,
        tasks: data.tasks.map((t) => (t.id === action.id ? { ...t, done: !t.done } : t)),
      };
    case "save-aircraft":
      if (!data.aircraft.some((a) => a.id === action.id)) throw new Error("Aircraft not found.");
      return {
        ...data,
        saved: data.saved.includes(action.id)
          ? data.saved.filter((id) => id !== action.id)
          : [...data.saved, action.id],
      };
    case "migrate":
      if (
        data.aircraft.length ||
        data.requirements.length ||
        data.contacts.length ||
        data.deals.length
      )
        throw new Error("Browser migration is only available in an empty server workspace.");
      return action.workspace;
  }
}
export function identity(a: { manufacturer: string; serial: string }) {
  return `${a.manufacturer.trim().toLowerCase()}:${a.serial.trim().toLowerCase()}`;
}
