import { Body, Query } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';

/**
 * Shortcut: `@ZodBody(createCompanyInputSchema) body: CreateCompanyInput`.
 * Validates the raw JSON body against the Zod schema before the handler
 * runs. Type-inferred from the schema — no manual `CreateX` duplication.
 */
export const ZodBody = <T>(schema: ZodType<T>): ParameterDecorator =>
  Body(new ZodValidationPipe<T>(schema));

/** Like `ZodBody` but for query string. */
export const ZodQuery = <T>(schema: ZodType<T>): ParameterDecorator =>
  Query(new ZodValidationPipe<T>(schema));
