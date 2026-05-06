import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type CompanyWire, companyWireSchema } from '@/queries/company';
import {
  type CompanyLineChannelPublicWire,
  companyLineChannelPublicWireSchema,
} from '@/queries/line-channel';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LineChannelForm } from './_components/line-channel-form';
import { SettingsForm } from './_components/settings-form';

export const metadata: Metadata = {
  title: 'ตั้งค่า',
};

interface SettingsPageProps {
  params: Promise<{ companySlug: string }>;
}

/**
 * /c/[companySlug]/settings — Company-level settings.
 *
 * MVP scope: PromptPay payee config only. Phase 2 will add company name /
 * timezone / billing day / invoice template fields.
 *
 * Server Component fetches the current company row (with promptPayId +
 * promptPayName) so the form pre-fills the existing values. Form is a
 * Client Component because Save needs `useTransition` for optimistic UX.
 */
export default async function SettingsPage({ params }: SettingsPageProps) {
  const { companySlug } = await params;

  const token = await getAccessTokenFromCookie();
  if (!token) {
    redirect(`/login?next=/c/${companySlug}/settings`);
  }

  let company: CompanyWire;
  let lineChannel: CompanyLineChannelPublicWire | null = null;
  try {
    company = await api.get(`/c/${companySlug}`, companyWireSchema, { token });
    // LINE channel is optional — 404 = "not yet configured", any other
    // error bubbles up to the outer catch.
    try {
      lineChannel = await api.get(
        `/c/${companySlug}/line-channel`,
        companyLineChannelPublicWireSchema,
        { token },
      );
    } catch (lineErr) {
      if (
        lineErr instanceof ApiError &&
        (lineErr.statusCode === 404 || lineErr.code === 'NotFoundException')
      ) {
        lineChannel = null; // unconfigured — render empty form
      } else {
        throw lineErr;
      }
    }
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.statusCode === 401 || err.code === 'UnauthorizedException')
    ) {
      redirect(`/login?next=/c/${companySlug}/settings`);
    }
    console.error('[settings/page] failed to load company:', err);
    return (
      <Card>
        <CardHeader>
          <CardTitle>โหลดข้อมูลไม่สำเร็จ</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            กรุณาลองรีเฟรชหน้านี้ หรือติดต่อทีมเทคนิคหากปัญหายังเกิดขึ้น
          </p>
        </CardContent>
      </Card>
    );
  }

  const promptPayConfigured = Boolean(company.promptPayId && company.promptPayName);
  const lineChannelConfigured = Boolean(
    lineChannel?.hasChannelSecret && lineChannel?.hasChannelAccessToken,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">ตั้งค่า</h1>
        <p className="text-sm text-muted-foreground">
          จัดการค่าระบบของหอพัก — บัญชี PromptPay สำหรับรับโอน, ภายหลัง: ชื่อหอพัก, รอบบิล, template ใบแจ้งหนี้
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">PromptPay สำหรับรับชำระค่าเช่า</CardTitle>
          <CardDescription>
            QR ในใบแจ้งหนี้ใช้บัญชีนี้รับโอน — ตั้งค่าให้เรียบร้อยก่อนกด "ออกบิล" (ไม่งั้นระบบจะปฏิเสธด้วย error{' '}
            <code>PromptPayNotConfigured</code>)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!promptPayConfigured ? (
            <p
              role="alert"
              className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
            >
              ⚠️ ยังไม่ได้ตั้ง PromptPay — ผู้เช่าจะไม่เห็น QR ในบิล + admin จะออกบิลไม่ได้
            </p>
          ) : null}
          <SettingsForm
            companySlug={companySlug}
            initialPromptPayId={company.promptPayId ?? ''}
            initialPromptPayName={company.promptPayName ?? ''}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">LINE Official Account</CardTitle>
          <CardDescription>
            ใช้สำหรับ push บิลใหม่ + ผลตรวจสลิป + ประกาศ ไปหาผู้เช่า — ตั้งค่าก่อนค่อยใช้ "ส่งประกาศ" / "ออกบิล"
            (ไม่งั้นข้อความจะไปไม่ถึงผู้เช่า) ดูวิธีสร้าง LINE OA ใน{' '}
            <a
              href="https://developers.line.biz/console/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              LINE Developers Console
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!lineChannelConfigured ? (
            <p
              role="alert"
              className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
            >
              ⚠️ ยังไม่ได้เชื่อม LINE OA — ระบบจะส่งประกาศ / push บิลให้ผู้เช่าไม่ได้
            </p>
          ) : null}
          <LineChannelForm
            companySlug={companySlug}
            initialChannelId={lineChannel?.channelId ?? ''}
            initialBasicId={lineChannel?.basicId ?? ''}
            initialDisplayName={lineChannel?.displayName ?? ''}
            hasChannelSecret={lineChannel?.hasChannelSecret ?? false}
            hasChannelAccessToken={lineChannel?.hasChannelAccessToken ?? false}
          />
        </CardContent>
      </Card>
    </div>
  );
}
