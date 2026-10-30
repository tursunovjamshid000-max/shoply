SHOPLY — NETLIFY SHARED STORAGE BUILD

Bu versiya Netlify Functions + Netlify Blobs orqali mahsulotlar, sozlamalar, sharhlar va buyurtmalarni bitta umumiy doimiy saqlash joyiga yozadi. Bir Telegram Mini App ichida bir xil Netlify domenini ochgan barcha foydalanuvchilar bitta ma’lumotni ko‘radi.

Fayllar:
- public/index.html — xaridor sayti
- public/admin.html — admin paneli
- netlify/functions/state.mjs — umumiy ma’lumotlar API
- netlify/functions/orders.mjs — buyurtmalar API
- netlify.toml — Netlify yo‘llari

DEPLOY:
1. Butun loyiha papkasini GitHub repository ga yuklang (GitHub saytining Add file / Upload files funksiyasidan foydalanish mumkin).
2. Netlify dashboard > Add new site > Import an existing project > GitHub orqali repository ni ulang.
3. Build settings da publish directory = public bo‘lsin; functions directory = netlify/functions.
4. Deploy tugagach, mavjud Netlify domeningizga deploy qiling. Faqat public papkasini alohida drag-and-drop qilish yetmaydi, chunki serverless functions ham deploy qilinishi shart.
5. Saytning asosiy sahifasi va Telegram Mini App URL aynan shu Netlify domenida qolsin.

Eslatma: serverless functionlar Netlify Blobs ni birinchi ishlatganda storage yaratadi. Mahsulotlar va sharhlar browser localStorage ga emas, shared Blobs store ga yuboriladi. Birinchi marta yangi backendga o‘tilganda eski qurilmalardagi faqat localStorage da turgan mahsulotlarni admin panelida qayta saqlash/import qilish kerak bo‘lishi mumkin.

XAVFSIZLIK: admin panelining mavjud login tekshiruvi frontendda qolgan. Haqiqiy savdo uchun admin API ga server-side autentifikatsiya qo‘shish tavsiya etiladi.
