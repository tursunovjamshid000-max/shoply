SHOPLY — BARQAROR VA TEZROQ VERSIYA

1) GitHub repository rootiga ZIP ichidagi index.html, admin.html, server.js, package.json va SUPABASE.sql fayllarini joylang.
2) Render Build Command: npm install
3) Render Start Command: node server.js
4) Render Environment Variables:
   SUPABASE_URL = mavjud Supabase Project URL
   SUPABASE_SERVICE_ROLE_KEY = Supabase service_role key (faqat Render serverida)
   ADMIN_LOGIN = shoply
   ADMIN_PASSWORD = 24001214
5) Supabase SQL Editor'da SUPABASE.sql ni bir marta ishga tushiring.
6) Render deploy tugagach /api/health manzilida database: configured ko'rinishi kerak.

MUHIM:
- Eski Supabase jadvalidagi yozuvlar o'chirilmaydi. Server faqat mavjud key/value yozuvlarini o'qiydi va yangilaydi.
- /api/state/:key uchun DELETE ataylab o'chirilgan. Admin interfeysi kolleksiyani yangilangan qiymat bilan PUT qiladi.
- Savatcha Telegram user ID asosida brauzerning o'zida ajratilgan; u umumiy do'kon bazasiga yozilmaydi.
- Mahsulotlar, bannerlar, sozlamalar, sharhlar, promo-kodlar va buyurtmalar Supabase shoply_data jadvalida saqlanadi.
- offline.js endi sahifalarda ulanmagan: u API so'rovlarini localStorage bilan almashtirib, qurilmalararo sinxronlashga xalaqit berishi mumkin edi.
- Admin panel doimiy 3 soniyalik polling qilmaydi; ma'lumot faqat sahifa ochilganda olinadi va o'zgarish saqlanganda yuboriladi.

Agar /api/health database: missing desa, Render environment variables noto'g'ri yoki yo'q. Service role keyni hech qachon frontend fayliga qo'ymang.
