SHOPLY — BARQAROR VERSIYA + TADBIRKORLIK (SELLER MARKETPLACE) MODULI

1) GitHub repository rootiga ZIP ichidagi fayllarni joylang:
   index.html, admin.html, seller.html, server.js, package.json, SUPABASE.sql

2) Render Build Command: npm install
3) Render Start Command: node server.js

4) Render Environment Variables:
   SUPABASE_URL = mavjud Supabase Project URL
   SUPABASE_SERVICE_ROLE_KEY = Supabase service_role key (faqat serverda)
   ADMIN_LOGIN = shoply
   ADMIN_PASSWORD = 24001214

5) Supabase SQL Editor'da SUPABASE.sql ni bir marta ishga tushiring
   (jadval allaqachon bo'lsa hech narsa buzilmaydi — faqat IF NOT EXISTS).

6) Render deploy tugagach /api/health manzilida database: configured ko'rinsin.

=== TADBIRKORLIK MODULI ===

Yangi funksiyalar:
- Foydalanuvchi profilidan «Savdo qilish uchun ariza» (Telegram ID bilan)
- Admin → Tadbirkorlar: arizalarni tasdiqlash / rad etish
- seller.html — tadbirkor paneli (mahsulot, buyurtma, qarz, statistika)
- Tadbirkor mahsulotlari asosiy katalogga qo'shiladi (sellerId bilan)
- Buyurtma «Yetkazildi» holatiga o'tganda server 3% komissiyani hisoblaydi
- Qarz >= 30 000 so'm bo'lsa hisob avtomatik muzlatiladi
- Muzlatilgan tadbirkor yangi mahsulot qo'sha/tahrirlay olmaydi
- Faqat admin qayta faollashtira oladi

Yangi API endpointlar:
  POST /api/seller/apply
  GET  /api/seller/my-application?userId=
  GET  /api/seller/me?userId=
  GET  /api/seller/products?userId=
  POST /api/seller/products
  POST /api/seller/products/delete
  GET  /api/seller/orders?userId=
  POST /api/seller/orders/status
  GET  /api/seller/commissions?userId=
  GET  /api/admin/seller-applications
  POST /api/admin/seller-applications/review
  GET  /api/admin/sellers
  POST /api/admin/sellers/freeze
  GET  /api/admin/commissions

Yangi Supabase key'lar (shoply_data jadvalida avtomatik yaratiladi):
  shoply_seller_applications_v1
  shoply_sellers_v1
  shoply_commission_log_v1

MUHIM XAVFSIZLIK:
- Service role key faqat serverda (frontendga chiqarilmagan)
- Komissiya faqat serverda hisoblanadi (buyurtma Yetkazildi bo'lganda)
- Tadbirkor faqat o'z mahsulotlarini boshqaradi
- Mavjud mahsulotlar, buyurtmalar, bannerlar, promo o'chirilmaydi
- /api/state/:key DELETE o'chirilgan holatda qoladi

Mavjud funksiyalar saqlanadi: katalog, savat, Telegram buyurtma, admin mahsulotlar,
bannerlar, promo, sharhlar, dizayn sozlamalari.
