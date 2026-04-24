import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

/**
 * URL prefix for any route that needs the raw request body buffer
 * (signature verification). Currently only the LINE webhook controller —
 * extend this list (or refactor to per-route metadata) when adding more.
 */
const RAW_BODY_PATH_PREFIXES = ['/line/webhook/'] as const;

function shouldCaptureRawBody(url: string | undefined): boolean {
  if (!url) return false;
  return RAW_BODY_PATH_PREFIXES.some((p) => url.startsWith(p));
}

/**
 * Bootstrap entrypoint. Fastify is the adapter (ADR — performance, no body-
 * parser quirks vs Express). Order of plugin registration matters:
 *
 *   helmet  — must go first so security headers land on every response.
 *   cookie  — needed for LIFF session cookies + CSRF double-submit later.
 *
 * `bodyLimit: 1 MiB` covers the JSON POST bodies we issue today (login,
 * profile updates). Slip uploads bypass this — they hit R2 directly via a
 * pre-signed URL so the API never buffers binary payloads.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const adapter = new FastifyAdapter({
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: env.NODE_ENV === 'production',
    // Use request `id` set by Fastify as correlation id — the audit-log
    // interceptor picks it up via `req.id`.
    genReqId: () => crypto.randomUUID(),
  });

  // ---------------------------------------------------------------------
  // Raw-body capture for HMAC-protected webhooks.
  //
  // The default Fastify JSON parser eagerly stringifies+parses, which
  // destroys byte fidelity (key order, whitespace) — fatal for HMAC
  // signature verification. We register a custom JSON content-type parser
  // that:
  //   - reads the body into a Buffer (`parseAs: 'buffer'`)
  //   - stamps `req.rawBody = buf` ONLY for whitelisted prefixes (avoids
  //     wasting memory on every single JSON request)
  //   - parses + returns the JSON object so downstream handlers / Zod
  //     pipes still receive the parsed value
  //
  // Pre-registered on the raw Fastify adapter (before `NestFactory.create`)
  // so it's the parser in place when Nest initialises. The `bodyParser:
  // false` Nest option (below) prevents Nest from registering ITS default
  // afterwards — Fastify 4.x throws FST_ERR_CTP_ALREADY_PRESENT on a
  // duplicate `application/json` registration (old Fastify silently
  // overrode; strict-by-default in 4.x).
  // ---------------------------------------------------------------------
  adapter
    .getInstance()
    .addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req: FastifyRequest, body: Buffer, done) => {
        if (shouldCaptureRawBody(req.url)) {
          (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
        }
        try {
          const json = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
          done(null, json);
        } catch (err) {
          done(err as Error);
        }
      },
    );

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // We registered our own JSON parser above; tell Nest to skip its
    // default registration to avoid the duplicate-parser error.
    // We don't accept urlencoded anywhere either, so disabling all
    // built-in parsers is fine. Revisit if a form-post endpoint lands.
    bodyParser: false,
    // Pino via Fastify would be ideal; use built-in Nest logger for now to
    // keep ADR-0006 portability (no runtime-specific transports).
    logger:
      env.NODE_ENV === 'production' ? ['log', 'warn', 'error'] : ['debug', 'log', 'warn', 'error'],
  });

  // `contentSecurityPolicy: false` — the API returns JSON only; CSP belongs
  // on the web-admin Next.js app, not here. Re-enable if we ever serve HTML.
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });
  await app.register(fastifyCookie);

  // CORS — required for cross-origin LIFF/web-admin calls.
  //
  // Permissive for MVP — `origin: true` reflects the request's `Origin` header
  // so localhost / Pinggy / ngrok tunnels all work without an env bake step.
  // `Access-Control-Allow-Credentials: true` lets LIFF send `Authorization`
  // (Bearer tenant JWT) and lets web-admin forward cookies.
  //
  // Phase-2 hardening: add APP_URL / LIFF_URL to env schema and lock origin
  // to that allow-list in production (a trusted tenant could otherwise call
  // the API from a phishing page).
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'accept'],
    maxAge: 86_400, // cache preflight 1 day
  });

  app.enableShutdownHooks();

  // Listen on 0.0.0.0 so it's reachable from Docker's host-mapped port.
  await app.listen(env.PORT, '0.0.0.0');

  logger.log(`Dorm API listening on :${env.PORT} (NODE_ENV=${env.NODE_ENV})`);
}

bootstrap().catch((err) => {
  // Top-level bootstrap failures (env parse, port in use, DB unreachable)
  // — log cleanly and exit with non-zero so Docker / PM2 restart us.
  // eslint-disable-next-line no-console
  console.error('Fatal: bootstrap failed\n', err);
  process.exit(1);
});
