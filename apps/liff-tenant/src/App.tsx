import { Route, Routes } from 'react-router-dom';
import { BindPage } from './pages/BindPage.js';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage.js';
import { InvoicesPage } from './pages/InvoicesPage.js';
import { PayPage } from './pages/PayPage.js';

/**
 * Routes for the LIFF tenant app.
 *
 *   /c/:companySlug/bind?code=XXXX-XXXX  → BindPage (peek → confirm → redeem)
 *   /c/:companySlug/invoices             → InvoicesPage (tenant home / bills)
 *   /c/:companySlug/invoices/:id         → InvoiceDetailPage (items + history + Pay CTA)
 *   /c/:companySlug/invoices/:id/pay     → PayPage (slip upload single-page flow)
 *
 * Anything else redirects to a generic "not found" — LIFF deep links should
 * always include the slug; specific surface (bind / invoices / pay) is per
 * route.
 */
export function App() {
  return (
    <Routes>
      <Route path="/c/:companySlug/bind" element={<BindPage />} />
      <Route path="/c/:companySlug/invoices" element={<InvoicesPage />} />
      <Route path="/c/:companySlug/invoices/:id" element={<InvoiceDetailPage />} />
      <Route path="/c/:companySlug/invoices/:id/pay" element={<PayPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-6 text-center">
      <h1 className="mb-2 text-xl font-semibold">ลิงก์ไม่ถูกต้อง</h1>
      <p className="text-sm text-gray-600">กรุณาเปิดลิงก์ที่ได้รับจากผู้ดูแลหอพักอีกครั้ง</p>
    </main>
  );
}
