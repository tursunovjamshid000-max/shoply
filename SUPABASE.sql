-- SHOPLY data store (key-value JSONB)
-- Yangi modul qo'shimcha jadvallar talab qilmaydi.
-- Seller ma'lumotlari quyidagi key'lar orqali saqlanadi:
--   shoply_seller_applications_v1
--   shoply_sellers_v1
--   shoply_commission_log_v1

CREATE TABLE IF NOT EXISTS public.shoply_data (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.shoply_data ENABLE ROW LEVEL SECURITY;
-- Server-side service_role key bypasses RLS. Do not expose that key in browser code.
