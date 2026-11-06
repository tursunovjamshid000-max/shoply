SHOPLY — TADBIRKORLIK (SELLER MARKETPLACE) MODULI

=== DEPLOY ===
1) Fayllar: index.html, admin.html, seller.html, server.js, package.json, SUPABASE.sql
2) Render: Build = npm install | Start = node server.js
3) Env:
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   ADMIN_LOGIN (default: shoply)
   ADMIN_PASSWORD (default: 24001214)
4) SUPABASE.sql — bir marta ishga tushirish yetarli (IF NOT EXISTS)

=== TADBIRKOR KIRISH OQIMI ===
1. Foydalanuvchi Telegram Mini App orqali do‘konga kiradi
2. Profil → «Savdo qilish uchun ariza» (3% rozilik majburiy)
3. Admin → Tadbirkorlar → Arizani Tasdiqlash
4. Foydalanuvchi qayta kirganda: «Login yaratish» ko‘rinadi
5. seller.html da login + parol (2 marta) yaratadi
6. Keyin seller.html ga login/parol bilan kiradi
7. Login Sozlamalarda ko‘rinadi; parolni o‘zgartirish mumkin

=== ADMIN TADBIRKORLAR ===
- Statistik kartalar (jami / faol / muzlatilgan / arizalar)
- Arizalar va Tadbirkorlar tablari
- Qidiruv, filter
- Tasdiqlash / rad etish / muzlatish / faollashtirish
- Tadbirkor mahsulotlarini ko‘rish va o‘chirish

=== KOMISSIYA ===
- Buyurtma statusi «Yetkazildi» bo‘lganda server 3% hisoblaydi
- Qarz >= 30 000 so‘m → avtomatik muzlatish
- Takroriy hisoblash oldini olish (commissionApplied + log)

=== XAVFSIZLIK ===
- Parollar scrypt hash (serverda)
- Service role key faqat serverda
- Tadbirkor faqat o‘z ma’lumotlarini boshqaradi
- Mavjud katalog / buyurtmalar / bannerlar saqlanadi
