// Foydalanuvchi Interfeysi Boshqaruvi
let currentTabMode = 'all'; // 'all' yoki 'vendor'

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

function initApp() {
    renderProducts();
    updateUI();
}

function updateUI() {
    const vendorTabBtn = document.getElementById('navVendorTab');
    const vendorHeader = document.getElementById('vendorHeader');
    const vendorApplyContainer = document.getElementById('vendorApplyContainer');
    const statusText = document.getElementById('vendorStatusText');

    if (state.currentUser.vendorStatus === 'APPROVED' || state.currentUser.vendorStatus === 'FROZEN') {
        vendorTabBtn.classList.remove('hidden');
        vendorTabBtn.classList.add('flex');
        
        document.getElementById('debtBadge').innerText = state.currentUser.debt.toLocaleString() + " so'm";
        document.getElementById('totalDebtDisplay').innerText = state.currentUser.debt.toLocaleString() + " so'm";
        vendorApplyContainer.classList.add('hidden');
    } else if (state.currentUser.vendorStatus === 'PENDING') {
        statusText.classList.remove('hidden');
        statusText.innerText = "Arizangiz ko'rib chiqilmoqda...";
        document.getElementById('applyVendorBtn').disabled = true;
    }
}

function switchTab(mode) {
    currentTabMode = mode;
    const navAll = document.getElementById('navAllProducts');
    const navVendor = document.getElementById('navVendorTab');
    const vendorHeader = document.getElementById('vendorHeader');

    if (mode === 'all') {
        navAll.className = "w-full text-left px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 font-semibold text-sm flex items-center justify-between";
        navVendor.className = "w-full text-left px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 font-semibold text-sm flex items-center justify-between";
        vendorHeader.classList.add('hidden');
        document.getElementById('sectionTitle').innerText = "Barcha Mahsulotlar";
    } else {
        navVendor.className = "w-full text-left px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 font-semibold text-sm flex items-center justify-between";
        navAll.className = "w-full text-left px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 font-semibold text-sm flex items-center justify-between";
        vendorHeader.classList.remove('hidden');
        document.getElementById('sectionTitle').innerText = "Mening Mahsulotlarim";
    }

    renderProducts();
}

function renderProducts() {
    const grid = document.getElementById('productsGrid');
    grid.innerHTML = '';

    let list = state.products;
    if (currentTabMode === 'vendor') {
        list = state.products.filter(p => p.vendorId === state.currentUser.vendorId);
    }

    list.forEach(prod => {
        const isOwner = prod.vendorId === state.currentUser.vendorId;
        const card = document.createElement('div');
        card.className = "bg-white border rounded-xl overflow-hidden shadow-sm product-card flex flex-col justify-between p-3 space-y-2";
        card.innerHTML = `
            <img src="${prod.image}" class="h-36 w-full object-cover rounded-lg">
            <div class="flex-1 flex flex-col justify-between">
                <div>
                    <span class="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">${prod.vendorName}</span>
                    <h4 class="font-bold text-gray-800 text-xs mt-1">${prod.title}</h4>
                    <p class="text-indigo-600 font-extrabold text-sm mt-1">${prod.price.toLocaleString()} so'm</p>
                </div>
                
                <!-- Pastida tadbirkor akkounti va tahrirlash/o'chirish -->
                <div class="mt-3 pt-2 border-t flex justify-between items-center text-xs">
                    ${isOwner ? `
                        <button onclick="openEditCard('${prod.id}')" class="text-indigo-600 font-semibold hover:underline text-[11px]">Tahrirlash</button>
                        <button onclick="deleteCard('${prod.id}')" class="text-red-600 font-semibold hover:underline text-[11px]">O'chirish</button>
                    ` : `
                        <button onclick="checkoutProduct('${prod.id}')" class="w-full bg-indigo-600 text-white font-bold py-1.5 rounded hover:bg-indigo-700 text-xs">Savatga va Rasmiylashtirish</button>
                    `}
                </div>
            </div>
        `;
        grid.appendChild(card);
    });

    document.getElementById('productCount').innerText = list.length + " ta";
}

// 3% Komissiya hisoblash va Rasmiylashtirish mantiqi
function checkoutProduct(prodId) {
    const prod = state.products.find(p => p.id === prodId);
    if (!prod) return;

    if (prod.vendorId !== 'admin') {
        // Har bir sotilgan mahsulotning 3% i tadbirkor qarziga hisoblanadi
        const commission = prod.price * 0.03;
        
        // Tadbirkorni topib qarzini oshiramiz
        const vendor = state.vendors.find(v => v.id === prod.vendorId);
        if (vendor) {
            vendor.debt += commission;
            // Agar qarz 30,000 so'mdan oshsa, akkount muzlatiladi
            if (vendor.debt >= 30000) {
                vendor.status = "FROZEN";
            }
        }

        if (prod.vendorId === state.currentUser.vendorId) {
            state.currentUser.debt += commission;
            if (state.currentUser.debt >= 30000) {
                state.currentUser.vendorStatus = "FROZEN";
            }
        }
        saveState();
        updateUI();
    }

    alert(`Mahsulot rasmiylashtirildi! Tadbirkorga 3% komissiya (${(prod.price * 0.03).toLocaleString()} so'm) qarz sifatida yozildi.`);
}

function openApplyModal() {
    document.getElementById('applyModal').classList.remove('hidden');
}

function closeApplyModal() {
    document.getElementById('applyModal').classList.add('hidden');
}

function submitVendorApplication(e) {
    e.preventDefault();
    state.currentUser.vendorStatus = "PENDING";

    const newVendor = {
        id: state.currentUser.vendorId,
        name: state.currentUser.name,
        phone: document.getElementById('appPhone').value,
        email: document.getElementById('appEmail').value,
        tg: document.getElementById('appTg').value,
        photo: document.getElementById('appPhoto').value,
        status: "PENDING",
        onlineHours: 1,
        debt: 0
    };

    state.vendors.push(newVendor);
    saveState();
    closeApplyModal();
    updateUI();
    alert("Arizangiz admin tekshiruviga yuborildi!");
}

function openAddCard() {
    if (state.currentUser.vendorStatus === "FROZEN" || state.currentUser.debt >= 30000) {
        alert("Sizning qarzingiz 30,000 so'mdan oshgan va akkountingiz muzlatilgan! To'lov qilmaguningizcha card qo'sha olmaysiz.");
        return;
    }
    document.getElementById('cardEditId').value = '';
    document.getElementById('cardModalTitle').innerText = "Yangi Card qo'shish";
    document.getElementById('cardForm').reset();
    document.getElementById('cardModal').classList.remove('hidden');
}

function openEditCard(id) {
    const prod = state.products.find(p => p.id === id);
    if (!prod) return;
    document.getElementById('cardEditId').value = prod.id;
    document.getElementById('cardTitle').value = prod.title;
    document.getElementById('cardPrice').value = prod.price;
    document.getElementById('cardImage').value = prod.image;
    document.getElementById('cardModalTitle').innerText = "Cardni Tahrirlash";
    document.getElementById('cardModal').classList.remove('hidden');
}

function closeCardModal() {
    document.getElementById('cardModal').classList.add('hidden');
}

function saveCard(e) {
    e.preventDefault();
    const id = document.getElementById('cardEditId').value;
    const title = document.getElementById('cardTitle').value;
    const price = parseFloat(document.getElementById('cardPrice').value);
    const image = document.getElementById('cardImage').value;

    if (id) {
        const prod = state.products.find(p => p.id === id);
        if (prod) {
            prod.title = title;
            prod.price = price;
            prod.image = image;
        }
    } else {
        const newProd = {
            id: 'p_' + Date.now(),
            title,
            price,
            vendorId: state.currentUser.vendorId,
            vendorName: state.currentUser.name,
            image
        };
        state.products.push(newProd);
    }

    saveState();
    closeCardModal();
    renderProducts();
}

function deleteCard(id) {
    if (confirm("Ushbu cardni o'chirib yubormoqchimisiz?")) {
        state.products = state.products.filter(p => p.id !== id);
        saveState();
        renderProducts();
    }
}
