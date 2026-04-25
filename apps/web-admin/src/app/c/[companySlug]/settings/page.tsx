import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { getAccessTokenFromCookie } from '@/lib/cookies';
import { type CompanyWire, companyWireSchema } from '@/queries/company';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
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
  try {
    company = await api.get(`/c/${companySlug}`, companyWireSchema, { token });
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
    </div>
  );
}
