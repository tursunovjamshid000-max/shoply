// Admin Panel Interaktiv Mantiqlari
let currentAdminTab = 'applications';
let selectedVendor = null;

document.addEventListener('DOMContentLoaded', () => {
    renderAdminVendors();
});

function switchAdminTab(tab) {
    currentAdminTab = tab;
    const btnApp = document.getElementById('tabApplicationsBtn');
    const btnApproved = document.getElementById('tabApprovedBtn');

    if(tab === 'applications') {
        btnApp.className = "pb-2 px-3 border-b-2 border-indigo-600 font-bold text-indigo-600 text-xs";
        btnApproved.className = "pb-2 px-3 border-b-2 border-transparent text-gray-500 font-bold text-xs hover:text-gray-700";
    } else {
        btnApproved.className = "pb-2 px-3 border-b-2 border-indigo-600 font-bold text-indigo-600 text-xs";
        btnApp.className = "pb-2 px-3 border-b-2 border-transparent text-gray-500 font-bold text-xs hover:text-gray-700";
    }

    renderAdminVendors();
}

function renderAdminVendors() {
    const list = document.getElementById('adminVendorList');
    list.innerHTML = '';

    const apps = state.vendors.filter(v => v.status === 'PENDING');
    const approved = state.vendors.filter(v => v.status === 'APPROVED' || v.status === 'FROZEN');

    document.getElementById('appCount').innerText = apps.length;
    document.getElementById('approvedCount').innerText = approved.length;

    const data = currentAdminTab === 'applications' ? apps : approved;

    data.forEach(v => {
        const isFrozen = v.status === 'FROZEN' || v.debt >= 30000;
        const card = document.createElement('div');
        card.className = "p-2.5 border rounded-lg hover:border-indigo-500 cursor-pointer transition bg-gray-50 flex justify-between items-center";
        card.onclick = () => selectVendorForDetail(v);

        card.innerHTML = `
            <div class="flex items-center space-x-3">
                <img src="${v.photo}" class="w-9 h-9 rounded-full object-cover">
                <div>
                    <h5 class="font-bold text-xs text-gray-800">${v.name}</h5>
                    <p class="text-[10px] text-gray-500">${v.tg}</p>
                </div>
            </div>
            ${currentAdminTab === 'applications' ? `
                <div class="flex space-x-1">
                    <button onclick="approveVendor('${v.id}', event)" class="bg-green-600 text-white text-[10px] font-bold px-2 py-1 rounded">Tasdiqlash</button>
                    <button onclick="rejectVendor('${v.id}', event)" class="bg-red-600 text-white text-[10px] font-bold px-2 py-1 rounded">Rad etish</button>
                </div>
            ` : `
                <span class="text-[10px] font-bold ${isFrozen ? 'text-red-600 bg-red-50 px-2 py-0.5 rounded' : 'text-green-600'}">
                    ${isFrozen ? 'Muzlatilgan (' + v.debt.toLocaleString() + ' so'm)' : v.debt.toLocaleString() + ' so'm'}
                </span>
            `}
        `;
        list.appendChild(card);
    });
}

function selectVendorForDetail(vendor) {
    selectedVendor = vendor;
    document.getElementById('emptyAdminState').classList.add('hidden');
    document.getElementById('vendorDetailSection').classList.remove('hidden');

    document.getElementById('dPhoto').src = vendor.photo;
    document.getElementById('dName').innerText = vendor.name;
    document.getElementById('dTg').innerText = vendor.tg;
    document.getElementById('dPhone').innerText = vendor.phone;
    document.getElementById('dEmail').innerText = vendor.email;
    document.getElementById('dOnlineHours').innerText = vendor.onlineHours + " soat";
    
    const isFrozen = vendor.status === 'FROZEN' || vendor.debt >= 30000;
    const statusBadge = document.getElementById('dStatus');
    statusBadge.innerText = isFrozen ? "Muzlatilgan" : "Online";
    statusBadge.className = isFrozen ? "text-[10px] px-2 py-0.5 rounded font-bold bg-red-100 text-red-700" : "text-[10px] px-2 py-0.5 rounded font-bold bg-green-100 text-green-700";

    document.getElementById('dDebt').innerText = "Qarz: " + vendor.debt.toLocaleString() + " so'm";

    renderVendorProducts(vendor.id);
}

function renderVendorProducts(vendorId) {
    const grid = document.getElementById('dProducts');
    grid.innerHTML = '';

    const vProducts = state.products.filter(p => p.vendorId === vendorId);

    if (vProducts.length === 0) {
        grid.innerHTML = '<p class="text-[11px] text-gray-400 col-span-2">Mahsulotlar mavjud emas</p>';
        return;
    }

    vProducts.forEach(p => {
        const card = document.createElement('div');
        card.className = "p-2 border rounded bg-gray-50 flex items-center justify-between";
        card.innerHTML = `
            <div class="truncate mr-1">
                <p class="font-bold text-[11px] truncate">${p.title}</p>
                <span class="text-[10px] text-indigo-600 font-semibold">${p.price.toLocaleString()} so'm</span>
            </div>
            <button onclick="adminDeleteProduct('${p.id}')" class="text-red-600 text-xs p-1 hover:text-red-800" title="Noma'qul cardni o'chirish">
                <i class="fa-solid fa-trash"></i>
            </button>
        `;
        grid.appendChild(card);
    });
}

function approveVendor(id, e) {
    e.stopPropagation();
    const vendor = state.vendors.find(v => v.id === id);
    if(vendor) {
        vendor.status = "APPROVED";
        if(state.currentUser.vendorId === id) {
            state.currentUser.vendorStatus = "APPROVED";
        }
        saveState();
        renderAdminVendors();
    }
}

function rejectVendor(id, e) {
    e.stopPropagation();
    state.vendors = state.vendors.filter(v => v.id !== id);
    saveState();
    renderAdminVendors();
}

function toggleFreezeStatus() {
    if (!selectedVendor) return;
    if (selectedVendor.status === "FROZEN") {
        selectedVendor.status = "APPROVED";
        selectedVendor.debt = 0; // Qarz to'langach qayta tiklanadi
        alert("Tadbirkor muzlatishdan chiqarildi va qarzi nollashtirildi!");
    } else {
        selectedVendor.status = "FROZEN";
        alert("Tadbirkor akkounti vaqtincha muzlatildi!");
    }
    saveState();
    renderAdminVendors();
    selectVendorForDetail(selectedVendor);
}

function adminDeleteProduct(prodId) {
    if (confirm("Noma'qul mahsulotni o'chirib yubormoqchimisiz?")) {
        state.products = state.products.filter(p => p.id !== prodId);
        saveState();
        if (selectedVendor) renderVendorProducts(selectedVendor.id);
    }
}
