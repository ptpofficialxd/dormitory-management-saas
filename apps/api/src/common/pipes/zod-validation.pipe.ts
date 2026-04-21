import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Pipe that validates a payload against a Zod schema. Instantiated per
 * parameter via the `@ZodBody(schema)` / `@ZodQuery(schema)` decorators —
 * NOT registered globally, because stock NestJS validation (class-validator)
 * is intentionally avoided here (CLAUDE.md §5 — Zod is the single source).
 *
 * On parse failure, raises `BadRequestException` with a flat error list so
 * the client gets a consistent JSON shape.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'ValidationFailed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }
    return result.data;
  }
}
