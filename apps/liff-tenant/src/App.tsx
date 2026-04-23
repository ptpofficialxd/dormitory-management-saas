import { Route, Routes } from 'react-router-dom';
import { BindPage } from './pages/BindPage.js';

/**
 * Routes for the LIFF tenant app.
 *
 *   /c/:companySlug/bind?code=XXXX-XXXX  → BindPage (peek → confirm → redeem)
 *
 * Anything else redirects to a generic "not found" — LIFF deep links should
 * always include both the slug and the code.
 */
export function App() {
  return (
    <Routes>
      <Route path="/c/:companySlug/bind" element={<BindPage />} />
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
