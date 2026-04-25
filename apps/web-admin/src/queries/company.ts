import {
  type UpdatePromptPaySettingsInput,
  companySchema,
  promptPayIdSchema,
  promptPayNameSchema,
  updatePromptPaySettingsInputSchema,
} from '@dorm/shared/zod';
import { z } from 'zod';

/**
 * Wire-side schemas for the Company API.
 *
 * Same `z.coerce.date()` pattern as other queries — shared `companySchema`
 * uses `z.date()`, JSON-over-wire delivers ISO strings.
 */
export const companyWireSchema = companySchema.extend({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type CompanyWire = z.infer<typeof companyWireSchema>;

// Re-export shared input schemas/types so consumers don't dual-import.
export { updatePromptPaySettingsInputSchema, promptPayIdSchema, promptPayNameSchema };
export type { UpdatePromptPaySettingsInput };
