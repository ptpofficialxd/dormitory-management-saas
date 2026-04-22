import { type PromptPayQrOptions, generatePromptPayPayload } from '@dorm/shared/promptpay';
import { Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';

/**
 * Why this lives in `apps/api/billing` and not in `packages/shared`:
 *   - `packages/shared` is runtime-agnostic (LIFF imports it; we don't want
 *     `qrcode` ending up in the mobile bundle since it pulls in `pngjs` +
 *     a few tens of KB).
 *   - QR rendering is an API-side concern: tenants get a pre-rendered PNG /
 *     SVG via the invoice detail endpoint; LIFF never builds the QR itself.
 *   - The pure EMVCo payload generator stays in `@dorm/shared/promptpay` so
 *     that future LIFF-side preview (e.g. "verify QR before download") can
 *     reuse it without rendering.
 *
 * NOT thread-unsafe — `qrcode` allocates a fresh canvas per call and we
 * don't share state, so a single Nest provider instance is fine.
 */

/**
 * QR rendering options.
 *
 * `errorCorrectionLevel`:
 *   PromptPay payloads are short (~80 bytes for amount QR) — we use 'M'
 *   (medium, ~15% recoverability) which is the EMVCo recommendation.
 *   Bumping to 'H' (~30%) makes the QR ~30% denser without measurable scan
 *   reliability gain on phones held 10–30cm away.
 *
 * `margin`:
 *   QR "quiet zone" — modules of white space around the code. Spec minimum
 *   is 4. We default to 2 because banking apps tolerate it and it lets the
 *   QR fill more of a small mobile invoice card. Override to 4 for print.
 *
 * `width`:
 *   Output pixel width for PNG. SVG is resolution-independent and ignores
 *   this. Default 256px is the smallest that scans reliably on 1080p
 *   screens at arm's length.
 */
export interface PromptPayRenderOptions {
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  /** Only honoured by `renderPng` / `renderDataUrl`. SVG is vector. */
  width?: number;
}

export interface PromptPayQrResult {
  /** EMVCo TLV payload — the same string a banking app decodes. */
  payload: string;
  /** Rendered output. Format depends on the call (svg / png buffer / data-URL). */
  output: string | Buffer;
}

const DEFAULT_RENDER: Required<PromptPayRenderOptions> = {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 256,
};

@Injectable()
export class PromptPayService {
  private readonly logger = new Logger(PromptPayService.name);

  /**
   * Build the raw EMVCo payload only (no rendering).
   *
   * Use this when the caller wants to ship the string to a client-side QR
   * library (e.g. inline preview in admin web) or when persisting the
   * payload alongside an invoice for audit (so a regenerated QR can be
   * byte-compared against the original).
   *
   * Throws if `promptPayId` doesn't match one of the 10/13/15-digit forms.
   * Caller is responsible for catching and 400-ing — we don't wrap in
   * BadRequestException here because this service is also called from
   * background jobs (invoice batch generation) where 400 is meaningless.
   */
  buildPayload(opts: PromptPayQrOptions): string {
    return generatePromptPayPayload(opts);
  }

  /**
   * Render the PromptPay QR as an SVG string.
   *
   * SVG is the preferred format for the admin invoice detail page (vector,
   * scales cleanly to print) and for tenant LIFF (sharp at any DPI without
   * a 4× PNG asset). Returned `output` is the raw `<svg>...</svg>` markup
   * — caller is responsible for setting `Content-Type: image/svg+xml`.
   */
  async renderSvg(
    opts: PromptPayQrOptions,
    render?: PromptPayRenderOptions,
  ): Promise<PromptPayQrResult> {
    const payload = this.buildPayload(opts);
    const settings = { ...DEFAULT_RENDER, ...render };
    const svg = await QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel: settings.errorCorrectionLevel,
      margin: settings.margin,
    });
    return { payload, output: svg };
  }

  /**
   * Render as a PNG buffer — for stamping into receipt PDFs (Phase 1) or
   * pushing as a LINE image message attachment.
   *
   * Returns a `Buffer`, NOT a base64 string — callers that need base64
   * should call `renderDataUrl` instead, which is encoded once at the
   * `qrcode` layer rather than us re-encoding.
   */
  async renderPng(
    opts: PromptPayQrOptions,
    render?: PromptPayRenderOptions,
  ): Promise<PromptPayQrResult> {
    const payload = this.buildPayload(opts);
    const settings = { ...DEFAULT_RENDER, ...render };
    const png = await QRCode.toBuffer(payload, {
      errorCorrectionLevel: settings.errorCorrectionLevel,
      margin: settings.margin,
      width: settings.width,
      type: 'png',
    });
    return { payload, output: png };
  }

  /**
   * Render as a `data:image/png;base64,...` URL — convenient for inlining
   * into HTML emails / PDF generators that resolve `src` URLs but can't
   * fetch from R2 (e.g. wkhtmltopdf without `--enable-local-file-access`).
   *
   * NOT recommended for the LIFF UI: data-URL inflates payload by ~33%
   * vs a signed-URL `<img>` reference. Use `renderPng` + R2 upload for
   * recurring assets.
   */
  async renderDataUrl(
    opts: PromptPayQrOptions,
    render?: PromptPayRenderOptions,
  ): Promise<PromptPayQrResult> {
    const payload = this.buildPayload(opts);
    const settings = { ...DEFAULT_RENDER, ...render };
    const dataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: settings.errorCorrectionLevel,
      margin: settings.margin,
      width: settings.width,
    });
    return { payload, output: dataUrl };
  }
}
