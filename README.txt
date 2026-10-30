SHOPLY — SHARED DATA BUILD (ORIGINAL DESIGN PRESERVED)

Dizayn/CSS/HTML ko‘rinishi o‘zgartirilmagan. Root index.html va admin.html aynan Netlify publish papkasi public/ ichiga ham qo‘yilgan; Netlify endi eski public dizaynini emas, siz yuborgan oxirgi dizaynni ko‘rsatadi.

Umumiy ma’lumotlar Netlify Functions + Netlify Blobs orqali saqlanadi:
- Mahsulotlar, sozlamalar, bannerlar, sharhlar va tashriflar: /api/state
- Buyurtmalar: /api/orders (admin panel o‘qiydigan shoply_orders_v1 umumiy kalitiga yoziladi)
- Admin yoki foydalanuvchi ma’lumotni yangilasa, boshqa ochiq sahifalar 5 soniyagacha bo‘lgan intervalda yangilaydi.

DEPLOY:
1. ZIPni oching va ichidagi SHOPLY_REBUILT papkasining BUTUN tarkibini GitHub repository rootiga yuklang.
2. Netlify build settings: Publish directory = public; Functions directory = netlify/functions.
3. @netlify/blobs dependency package.json da mavjud. Netlify'da qayta deploy qiling.
4. Deploy tugagach, asosiy URL va /admin.html ni ochib tekshiring.
5. Netlify Blobs birinchi ishga tushishda shared store yaratadi. Eski localStorage'dagi mahsulotlar bo‘lsa, birinchi marta admin ochilgan qurilmadan serverga ko‘chiriladi.

Eslatma: Bu loyiha ichidagi amaldagi shared backend Netlify Blobs. ZIP ichida Appwrite SDK yoki Appwrite API integratsiyasi yo‘q; bu versiya umumiy ko‘rinishni Netlify Blobs orqali ta’minlaydi.
