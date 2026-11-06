// Markazlashtirilgan Ma'lumotlar Bazasi va State Management

// Dastlabki tadbirkorlar va arizalar
let state = {
    currentUser: {
        id: "user_777",
        name: "Sardor",
        role: "USER", // USER yoki VENDOR
        vendorId: "v_777",
        vendorStatus: "NONE", // NONE, PENDING, APPROVED, FROZEN
        debt: 0
    },
    
    // Arizalar va tasdiqlangan tadbirkorlar
    vendors: [
        {
            id: "v_1",
            name: "Azizbek",
            phone: "+998901112233",
            email: "aziz@gmail.com",
            tg: "@aziz_vendor",
            photo: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100",
            status: "PENDING",
            onlineHours: 5,
            debt: 0
        },
        {
            id: "v_2",
            name: "Jamshid",
            phone: "+998934445566",
            email: "jamshid@gmail.com",
            tg: "@jamshid_market",
            photo: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100",
            status: "APPROVED",
            onlineHours: 24,
            debt: 34000 // 30,000 dan oshgani uchun avtomatik muzlatishga tushadi
        }
    ],

    // Hamma cardlar aralashib turadi (Admin va Tadbirkorlarniki)
    products: [
        {
            id: "p_1",
            title: "Smartfon Redmi Note 13",
            price: 2400000,
            vendorId: "admin",
            vendorName: "Shoply Rasmiy",
            image: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400"
        },
        {
            id: "p_2",
            title: "Noutbuk Lenovo Legion",
            price: 9500000,
            vendorId: "v_2",
            vendorName: "Jamshid",
            image: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400"
        }
    ]
};

// Lokal xotiradan yuklash
function loadState() {
    const saved = localStorage.getItem('shoply_state');
    if(saved) {
        try { state = JSON.parse(saved); } catch(e){}
    }
}

function saveState() {
    localStorage.setItem('shoply_state', JSON.stringify(state));
}

loadState();
