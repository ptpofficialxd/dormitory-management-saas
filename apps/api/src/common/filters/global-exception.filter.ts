import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Unifies every thrown error into a consistent JSON envelope. Prisma errors
 * and plain `Error`s get mapped to stable HTTP statuses so clients never see
 * Prisma-internal identifiers or stack traces.
 *
 * Shape:
 *   { statusCode, error, message, path, timestamp, requestId? }
 *
 * Validation errors thrown by `ZodValidationPipe` carry an `issues[]` array
 * that passes through untouched — see that pipe for field-level detail.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'InternalServerError';
    let message: unknown = 'Unexpected error';
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const raw = exception.getResponse();
      if (typeof raw === 'string') {
        message = raw;
        error = exception.name;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        error = (obj.error as string) ?? exception.name;
        message = obj.message ?? exception.message;
        // Preserve Zod-pipe "issues" + anything else the handler attached.
        const { statusCode: _sc, error: _e, message: _m, ...rest } = obj;
        extra = rest;
      }
    } else if (exception instanceof Error) {
      // Log the real reason server-side; never leak it to the client.
      this.logger.error(`Unhandled ${exception.name}: ${exception.message}`, exception.stack);
      message = 'Unexpected error';
    }

    void res.status(status).send({
      statusCode: status,
      error,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }
}
