SHOPLY — BARQAROR VA TEZROQ VERSIYA

1) GitHub repository rootiga ZIP ichidagi index.html, admin.html, server.js, package.json va SUPABASE.sql fayllarini joylang.
2) Render Build Command: npm install
3) Render Start Command: node server.js
4) Render Environment Variables:
   SUPABASE_URL = mavjud Supabase Project URL
   SUPABASE_SERVICE_ROLE_KEY = Supabase service_role key (faqat Render serverida)
   ADMIN_LOGIN = shoply
   ADMIN_PASSWORD = kuchli_yangi_parol
   ADMIN_SESSION_SECRET = uzun_tasodifiy_maxfiy_qiymat
   SMTP_HOST = SMTP server manzili
   SMTP_PORT = 587
   SMTP_SECURE = false
   SMTP_USER = email SMTP login
   SMTP_PASS = email SMTP paroli yoki app password
   SMTP_FROM = SHOPLY <tasdiqlangan-email@domen.uz>
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


7) SHOPLY NASIYA DEMO:
- Mahsulot tafsilotlari ichida 2 va 3 haftalik sinov bo‘lib to‘lash hisob-kitobi bor. Maksimum muddat 3 hafta.
- Arizalar /api/installment-requests orqali serverga yoziladi; admin paneldagi “Nasiya arizalari” bo‘limida ko‘rinadi.
- Admin arizalarni ko‘rishi va holatini o‘zgartirishi uchun admin login orqali beriladigan HttpOnly cookie ishlatiladi.
- ADMIN_SESSION_SECRET environment variable qo‘ying (uzun tasodifiy maxfiy qiymat). ADMIN_PASSWORD ni ham albatta o‘zgartiring.
- Bu demo haqiqiy kredit/nasiya shartnomasi emas va moliyalashtirishni tasdiqlamaydi. Haqiqiy nasiya savdosi uchun qonuniy biznes/hamkor va huquqiy talablar kerak.
- Nasiya arizasida email tasdiqlash kodi talab qilinmaydi: foydalanuvchi email manzilini kiritadi. Email eslatmalari uchun SMTP sozlamalari kerak bo‘ladi.
- Kod 6 xonali, 10 daqiqa amal qiladi; qayta yuborish oralig‘i 1 daqiqa, noto‘g‘ri urinishlar 5 ta bilan cheklangan.
- Telegram username so‘ralmaydi: mijoz email va telefon bilan aloqa qiladi. Email manzili foydalanuvchi tomonidan kiritiladi; uning egasi ekanini alohida tasdiqlash bu demo oqimida yo‘q.
- Joylashuv maydoni mijozdan qo‘lda so‘raladi; brauzer GPS koordinatalari yashirincha olinmaydi.
- Sinov arizasi faqat zarur aloqa ma’lumotlarini yig‘adi; pasport/ID rasmi yoki karta ma’lumotlarini so‘ramaydi.


=== SHOPLY NASIYA KENGAYTIRILGAN MODULI ===

Yangi nasiya boshqaruv sahifasi: /nasiya.html (faqat parol; email so‘ralmaydi).
Render Environment Variables: INSTALLMENT_ADMIN_PASSWORD (qiymatni faqat server sozlamasida kiriting), NASIYA_SESSION_SECRET (uzun tasodifiy maxfiy kalit). Parolni HTML/JS ichiga yozmang. 24001202 sodda parol bo‘lgani uchun ommaviy internetda ishlatish xavfsiz emas; imkon bo‘lsa kuchliroq parol tanlang.

Nasiya arizasi uchun email OTP kerak emas. Avtomatik email eslatmalarini yoqish uchun SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS va SMTP_FROM sozlang.

SMS yuborish uchun Eskiz hisobidan olingan ESKIZ_EMAIL, ESKIZ_PASSWORD va ESKIZ_FROM qiymatlarini Render Environment Variables ga kiriting. SMS tugmasi provayderga jo‘natadi; yetkazilish holatini Eskiz kabinetidan tekshiring.

Ma’lumotlar Supabase shoply_data jadvalidagi shoply_installment_requests_v1 yozuvida saqlanadi. SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY talab qilinadi. Surat JPEG/PNG/WEBP, 350 KB atrofida; faqat mijoz roziligi bilan. Surat shaxsni tasdiqlash o‘rnini bosmaydi. Telegram profil ma’lumoti faqat Telegram Mini App ichida mavjud bo‘lsa olinadi; username bo‘lmasa bo‘sh qoladi. Telefon raqami Telegram'dan avtomatik olinmaydi.

Tasdiqlangan arizalarda 2 yoki 3 haftalik jadval tuziladi. Email eslatmalar server ishlayotgan paytda har 10 daqiqada tekshiriladi. Sayt ichidagi shaxsiy nasiya ma’lumotlari ariza yuborgan brauzerda saqlangan maxsus token bilan olinadi.

MUHIM XAVFSIZLIK: nasiya ma’lumotlari, lokatsiya va surat shaxsiy ma’lumot hisoblanadi. Faqat zarur ma’lumotni yig‘ing, foydalanuvchidan alohida rozilik oling, bazaga kirishni cheklang va maxfiylik siyosatini e’lon qiling. Email/SMS tasdig‘i shaxsni yoki to‘lov qobiliyatini tasdiqlamaydi. Haqiqiy nasiya savdosi uchun qonuniy biznes/hamkor, shartnoma va moliyaviy tekshiruv zarur.
