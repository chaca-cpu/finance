// ==========================================
// 1. CONFIGURATION & GLOBAL STATE
// ==========================================
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw6K1ROVTYLBT366dmTPMhRi6d4FFkoQCMNKBaU72JqAwYvVx6ILytzj1YbbFwOv55A/exec"; 
const API_URL_TRANSAKSI = SCRIPT_URL;
const API_URL_VALIDASI = "https://script.google.com/macros/s/AKfycbwgME7HigyzKcT7rfMaBdfExU0hMsyk25yl7I39TsLckgg64wco42Cd1udpjGD9bRJiKw/exec";

// Kredensial login sisi client (sementara, tanpa backend auth).
// Ganti username/password di bawah ini sesuai kebutuhan Anda.
const LOGIN_CREDENTIALS = { username: "admin", password: "cashflow123" };

// Identitas toko, dipakai di header ringkasan "Salin ke WhatsApp" (Laporan Cash Harian).
// Cukup diisi sekali di sini.
const NAMA_TOKO = "Galaxymedia Sarana Telematika";
const ALAMAT_TOKO = "";

let globalIn = [];
let globalOut = [];
let currentDataMode = 'cash'; // 'cash' atau 'cashflow' — dikontrol pill toggle di Dashboard/Riwayat Transaksi/Laporan
let globalTransfer = []; 
let globalMasterData = []; 
let masterKatPemasukan = [];
let masterKatPengeluaran = [];
let globalSetoran = []; 
let globalOutAll = []; // Dideklarasikan di awal untuk mencegah scope error
let lastLaporanPeriodeSummary = null; // Menyimpan ringkasan hasil render terakhir Laporan Mingguan/Bulanan, dipakai oleh salinLaporanPeriodeKeWA()

// ==========================================
// FITUR BARU: ARSIP KETEPATAN BAYAR (terpisah total dari API/variabel lama)
// Ganti URL di bawah ini dengan URL Web App hasil deploy .gs baru Anda.
// ==========================================
const API_URL_ARSIP_KETEPATAN = "https://script.google.com/macros/s/AKfycbw7pe91P-rOh28uJ3-9890cpn2NHgXOhDOe9yHmJTxBgC74kz1wBdXAKzKFKw2PvRqpDg/exec";
let globalArsipKetepatan = [];

let globalDataKategori = {
    pemasukan: [],
    pengeluaran: [],
    setoran: []
};

let chartTrendInstance = null;
let chartCashflowTrendInstance = null;
let chartKatInInstance = null;
let chartKatOutInstance = null;

let selectedKatIn = "ALL";
let selectedKatOut = "ALL";

let currentPage = 1;
const ITEMS_PER_PAGE = 10;
let currentTransferPage = 1;

let sortState = {
    transaksi: { col: 'tanggal', dir: 'desc' },
    transfer: { col: 'tanggal', dir: 'desc' },
    master: { col: 'nama', dir: 'asc' }
};

// ==========================================
// 2. FETCH DATA FROM APPS SCRIPT
// ==========================================
// CACHE LOKAL (localStorage) — supaya app kelihatan instan begitu dibuka,
// sambil tetap ambil data terbaru di belakang layar (stale-while-revalidate).
// Data asli tetap dari Spreadsheet; ini cuma nyimpen SALINAN respons terakhir
// yang berhasil, biar tidak perlu nunggu Spreadsheet tiap kali app dibuka.
// ==========================================
const CACHE_KEY_TRANSAKSI = "cf_cache_transaksi_v1";
const CACHE_KEY_VALIDASI = "cf_cache_validasi_v1";

function simpanCache(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ data, waktu: Date.now() })); }
    catch (e) { /* localStorage penuh/diblokir browser — abaikan, tidak fatal */ }
}

function ambilCache(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && parsed.data ? parsed.data : null;
    } catch (e) { return null; }
}

function terapkanDataTransaksi(dataTransaksi) {
    if (!dataTransaksi) return false;
    if (!(dataTransaksi.status === "success" || dataTransaksi.pemasukan || dataTransaksi.dataPemasukan)) return false;

    globalIn = dataTransaksi.pemasukan || dataTransaksi.dataPemasukan || [];
    globalOut = dataTransaksi.pengeluaran || dataTransaksi.dataPengeluaran || [];
    globalSetoran = dataTransaksi.setoranBank || dataTransaksi.setoran || [];
    masterKatPemasukan = dataTransaksi.kategoriPemasukan || [];
    masterKatPengeluaran = dataTransaksi.kategoriPengeluaran || [];

    globalDataKategori.pemasukan = dataTransaksi.kategoriPemasukan || [];
    globalDataKategori.pengeluaran = dataTransaksi.kategoriPengeluaran || [];
    globalDataKategori.setoran = dataTransaksi.kategoriSetoran || [];

    globalOutAll = dataTransaksi["Input Pengeluaran ALL"] ||
        dataTransaksi.pengeluaranAll ||
        dataTransaksi.inputPengeluaranAll ||
        dataTransaksi.pengeluaran_all ||
        dataTransaksi["Pengeluaran ALL"] || [];

    return true;
}

function terapkanDataValidasi(dataValidasi, dataTransaksi) {
    if (!dataValidasi) return false;

    if (Array.isArray(dataValidasi)) {
        processMasterData(dataValidasi);
        return true;
    } else if (typeof dataValidasi === 'object') {
        globalTransfer = dataValidasi.validasiTransfer || dataValidasi.transfer || [];
        const masterSource = dataValidasi.masterData || dataValidasi.data || dataValidasi.pelanggan || (dataTransaksi && dataTransaksi.masterData);
        if (masterSource) processMasterData(masterSource);
        return true;
    }
    return false;
}

async function fetchData() {
    // 1. TAMPILKAN DULU DATA CACHE (kalau ada) — biar app langsung kelihatan isi,
    //    tidak nunggu Spreadsheet, walau datanya mungkin beberapa saat lalu.
    const cacheTransaksi = ambilCache(CACHE_KEY_TRANSAKSI);
    const cacheValidasi = ambilCache(CACHE_KEY_VALIDASI);
    let sudahRenderDariCache = false;

    if (cacheTransaksi || cacheValidasi) {
        if (cacheTransaksi) terapkanDataTransaksi(cacheTransaksi);
        if (cacheValidasi) terapkanDataValidasi(cacheValidasi, cacheTransaksi);

        populateCategoryDropdown();
        renderAllViews();
        renderSheetPengeluaranALL(globalOutAll);
        sudahRenderDariCache = true;
        console.log("Data cache ditampilkan dulu, mengambil data terbaru di belakang layar...");
    }

    // 2. AMBIL DATA ASLI DARI SPREADSHEET DI BELAKANG LAYAR (PENTING: kedua request
    //    di-handle TERPISAH via Promise.allSettled, bukan Promise.all — supaya kalau
    //    salah satu endpoint gagal, endpoint yang berhasil tetap diproses).
    const [hasilTransaksi, hasilValidasi] = await Promise.allSettled([
        fetch(API_URL_TRANSAKSI).then(r => r.json()),
        fetch(API_URL_VALIDASI).then(r => r.json())
    ]);

    if (hasilTransaksi.status === "fulfilled") {
        const dataTransaksi = hasilTransaksi.value;
        const berhasil = terapkanDataTransaksi(dataTransaksi);
        if (berhasil) {
            simpanCache(CACHE_KEY_TRANSAKSI, dataTransaksi);
        } else {
            console.warn("API_URL_TRANSAKSI merespons tapi struktur JSON tidak dikenali. Cek nama field di response:", dataTransaksi);
        }
    } else {
        console.error("Gagal memuat API_URL_TRANSAKSI (Dashboard/Riwayat/Setoran akan kosong" + (sudahRenderDariCache ? ", tetap tampilkan data cache" : "") + "):", hasilTransaksi.reason);
    }

    if (hasilValidasi.status === "fulfilled") {
        const dataValidasi = hasilValidasi.value;
        const dataTransaksi = hasilTransaksi.status === "fulfilled" ? hasilTransaksi.value : null;
        const berhasil = terapkanDataValidasi(dataValidasi, dataTransaksi);
        if (berhasil) simpanCache(CACHE_KEY_VALIDASI, dataValidasi);
    } else {
        console.error("Gagal memuat API_URL_VALIDASI (Validasi Transfer/Master Data akan kosong" + (sudahRenderDariCache ? ", tetap tampilkan data cache" : "") + "):", hasilValidasi.reason);
    }

    populateCategoryDropdown();
    renderAllViews();
    renderSheetPengeluaranALL(globalOutAll);
    refreshCashflowViews();

    if (hasilTransaksi.status === "fulfilled" && hasilValidasi.status === "fulfilled") {
        console.log("Data berhasil dimuat sepenuhnya (terbaru dari Spreadsheet)!");
    } else {
        console.warn("Data dimuat sebagian. Lihat pesan error di atas untuk tahu endpoint mana yang bermasalah.");
    }
}

// ==========================================
// 3. RENDER ALL VIEWS & DASHBOARD
// ==========================================
function renderAllViews() {
    const searchVal = document.getElementById("search-input") ? document.getElementById("search-input").value.toLowerCase() : "";
    const selectedType = document.getElementById("type-select") ? document.getElementById("type-select").value : "ALL";
    const selectedCat = document.getElementById("category-select") ? document.getElementById("category-select").value : "ALL";

    let filteredIn = globalIn.filter(item => {
        const cat = getCategory(item, "Pemasukan");
        const matchSearch = searchVal === "" || JSON.stringify(item).toLowerCase().includes(searchVal);
        const matchCat = (selectedCat === "ALL" || cat === selectedCat);
        return matchSearch && matchCat;
    });

    let filteredOut = globalOut.filter(item => {
        const cat = getCategory(item, "Pengeluaran");
        const matchSearch = searchVal === "" || JSON.stringify(item).toLowerCase().includes(searchVal);
        const matchCat = (selectedCat === "ALL" || cat === selectedCat);
        return matchSearch && matchCat;
    });

    if (selectedType === "Pemasukan") filteredOut = [];
    if (selectedType === "Pengeluaran") filteredIn = [];

    const totalIn = filteredIn.reduce((sum, i) => sum + getNominal(i), 0);
    const totalOut = filteredOut.reduce((sum, i) => sum + getNominal(i), 0);
    const saldoBersih = totalIn - totalOut;

    const totalSetor = globalSetoran.reduce((sum, i) => sum + getNominal(i), 0);
    const cashKantor = saldoBersih - totalSetor;

    const elIn = document.getElementById("stat-pemasukan");
    const elOut = document.getElementById("stat-pengeluaran");
    const elSaldo = document.getElementById("stat-saldo");
    const elSetor = document.getElementById("stat-setor");
    const elCashKantor = document.getElementById("stat-cash-kantor");

    if (elIn) elIn.innerText = formatIDR(totalIn);
    if (elOut) elOut.innerText = formatIDR(totalOut);
    if (elSaldo) elSaldo.innerText = formatIDR(saldoBersih);
    if (elSetor) elSetor.innerText = formatIDR(totalSetor);
    if (elCashKantor) elCashKantor.innerText = formatIDR(cashKantor);

    renderTableWithPagination(filteredIn, filteredOut);
    renderDashboardChart(filteredIn, filteredOut);
    renderCategoryViews();

    renderTransferTable();
    renderMasterDataTable();
    renderSetoranTable();
    if (typeof renderLaporanKetepatan === "function") renderLaporanKetepatan();
}

// ==========================================
// 3B. LOGIN / LOGOUT (sesi + fallback aman jika storage diblokir browser)
// ==========================================
let _sessionMemory = false; // fallback in-memory jika sessionStorage tidak bisa diakses (mode privat/iframe)

function safeStorageGet(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function safeStorageSet(key, val) {
    try { sessionStorage.setItem(key, val); } catch (e) { /* storage diblokir, pakai fallback memori */ }
}
function safeStorageRemove(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* abaikan */ }
}

function showApp() {
    const loginPage = document.getElementById('login-page');
    const appShell = document.getElementById('app-shell');
    if (loginPage) loginPage.style.display = 'none';
    if (appShell) appShell.classList.add('app-visible');
    const toko = document.getElementById('profile-toko');
    if (toko) toko.textContent = NAMA_TOKO;
}

function showLogin() {
    const loginPage = document.getElementById('login-page');
    const appShell = document.getElementById('app-shell');
    if (loginPage) loginPage.style.display = 'flex';
    if (appShell) appShell.classList.remove('app-visible');
}

function handleLogin(event) {
    if (event) event.preventDefault();
    const username = (document.getElementById('login-username').value || '').trim();
    const password = document.getElementById('login-password').value || '';
    const errEl = document.getElementById('login-error');

    if (username === LOGIN_CREDENTIALS.username && password === LOGIN_CREDENTIALS.password) {
        _sessionMemory = true;
        safeStorageSet('cashflow_logged_in', 'true');
        if (errEl) errEl.innerText = '';
        showApp();
    } else {
        if (errEl) errEl.innerText = 'Username atau password salah.';
    }
    return false;
}

function handleLogout() {
    _sessionMemory = false;
    safeStorageRemove('cashflow_logged_in');
    showLogin();
}

function checkSession() {
    if (_sessionMemory || safeStorageGet('cashflow_logged_in') === 'true') {
        showApp();
    } else {
        showLogin();
    }
}

// Pencarian di topbar: Enter -> buka Riwayat Transaksi dan terapkan kata kunci
function handleGlobalSearch(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const q = event.target.value.trim();
    navigateTo('transaksi');
    if (currentDataMode === 'cashflow') {
        const inputCf = document.getElementById('search-cashflow-transaksi');
        if (inputCf) inputCf.value = q;
        if (typeof renderCashflowTransaksiTable === 'function') renderCashflowTransaksiTable();
    } else {
        const input = document.getElementById('search-input');
        if (input) input.value = q;
        if (typeof handleFilter === 'function') handleFilter();
    }
}
window.handleGlobalSearch = handleGlobalSearch;

// ==========================================
// TEMA TAMPILAN (Light / Dark Glass)
// ==========================================
function applyTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    try { localStorage.setItem('cashflow_theme', themeName); } catch (e) { /* storage diblokir, abaikan */ }
}

function cycleTheme() {
    const THEMES = ['light', 'dark'];
    const current = document.body.getAttribute('data-theme') || 'light';
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    applyTheme(next);
    if (typeof refreshChartsTheme === 'function') refreshChartsTheme();
}

function initTheme() {
    let saved = 'light';
    try { saved = localStorage.getItem('cashflow_theme') || 'light'; } catch (e) { /* abaikan */ }
    if (saved === 'dark-glass') saved = 'dark'; // migrasi nama tema lama
    document.body.setAttribute('data-theme', saved);
}

// ==========================================
// 4. NAVIGATION & SIDEBAR
// ==========================================
function navigateTo(pageId) {
    document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.menu-btn').forEach(b => b.classList.remove('active'));

    const activePage = document.getElementById(`page-${pageId}`);
    const activeNav = document.getElementById(`nav-${pageId}`);

    if (activePage) activePage.classList.add('active');
    if (activeNav) activeNav.classList.add('active');

    // Jika halaman yang dituju adalah sub-menu, otomatis buka grup induknya di sidebar
    const parentGroupId = SUBMENU_PARENT_MAP[pageId];
    if (parentGroupId) {
        toggleMenuGroup(parentGroupId, true);
    }

    if (pageId === 'dashboard') {
        renderDashboardChart(globalIn, globalOut);
    } else if (pageId === 'transaksi') {
        renderAllViews();
        renderCategoryViews();
        updateKategoriInsightVisibility();
    } else if (pageId === 'master') {
        renderMasterDataTable();
    } else if (pageId === 'setoran') {
        renderSetoranTable();
    } else if (pageId === 'laporan-ketepatan') {
        renderLaporanKetepatan();
    } else if (pageId === 'pengeluaran-all') {
        renderSheetPengeluaranALL();
    } else if (pageId === 'laporan-periode') { // <-- TAMBAHAN NAVIGASI
        if (currentDataMode === 'cashflow') { renderLaporanPeriode(); } else { renderLaporanHarianCash(); }
    } else if (pageId === 'archive') {
        renderArchiveTabs();
    } else if (pageId === 'rekap-bank') {
        renderRekapBank();
    }

    // Sinkronkan tampilan pill toggle Cash/Cashflow di halaman yang baru aktif
    if (typeof setDataMode === 'function') setDataMode(currentDataMode);

    if (window.innerWidth <= 768) {
        document.body.classList.remove('sidebar-open');
    }
}

function toggleSidebar() {
    if (window.innerWidth <= 768) {
        // Mobile: sidebar adalah drawer yang default tersembunyi
        document.body.classList.toggle('sidebar-open');
    } else {
        // Desktop: sidebar default tampil, tombol ini yang collapse/expand
        document.body.classList.toggle('sidebar-collapsed');
    }
}

// ==========================================
// SUB MENU SIDEBAR (Accordion Interaktif)
// ==========================================
// Peta: id sub-halaman -> id grup menu induknya (dipakai untuk auto-expand saat navigasi langsung)
const SUBMENU_PARENT_MAP = {
    'setoran': 'transaksi',
    'laporan-ketepatan': 'laporan-periode',
    'pengeluaran-all': 'laporan-periode',
    'archive': 'laporan-periode',
    'rekap-bank': 'laporan-periode'
};

function toggleMenuGroup(groupId, forceOpen = false) {
    const group = document.getElementById(`menu-group-${groupId}`);
    if (!group) return;

    if (forceOpen) {
        group.classList.add('expanded');
        return;
    }

    const isOpen = group.classList.contains('expanded');
    // Accordion: tutup grup lain saat salah satu grup dibuka
    document.querySelectorAll('.menu-group.expanded').forEach(g => {
        if (g !== group) g.classList.remove('expanded');
    });
    group.classList.toggle('expanded', !isOpen);
}

// Dipanggil saat menu UTAMA (yang punya sub-menu) diklik: tetap navigasi + buka/tutup submenu-nya
function handleParentMenuClick(pageId) {
    navigateTo(pageId);
    toggleMenuGroup(pageId);
}

// ==========================================
// 5. SORTING & UTILITIES
// ==========================================
function handleSort(targetTable, colName) {
    if (!sortState[targetTable]) return;
    
    if (sortState[targetTable].col === colName) {
        sortState[targetTable].dir = sortState[targetTable].dir === 'asc' ? 'desc' : 'asc';
    } else {
        sortState[targetTable].col = colName;
        sortState[targetTable].dir = 'desc';
    }

    if (targetTable === 'transaksi') renderAllViews();
    if (targetTable === 'transfer') renderTransferTable();
    if (targetTable === 'master') renderMasterDataTable();
}

function sortDataList(list, colType, direction = 'desc') {
    return list.sort((a, b) => {
        let valA, valB;

        if (colType === 'tanggal') {
            valA = parseToDateObj(a["Tanggal"] || a["tgl"] || a["Tanggal Pembayaran"] || a["tanggalBayar"]);
            valB = parseToDateObj(b["Tanggal"] || b["tgl"] || b["Tanggal Pembayaran"] || b["tanggalBayar"]);
        } else if (colType === 'nominal') {
            valA = getNominal(a) || getJumlahTagihan(a);
            valB = getNominal(b) || getJumlahTagihan(b);
        } else if (colType === 'nama') {
            valA = (a.nama || a["Nama Pelanggan"] || "").toLowerCase();
            valB = (b.nama || b["Nama Pelanggan"] || "").toLowerCase();
        } else {
            valA = (a[colType] || "").toString().toLowerCase();
            valB = (b[colType] || "").toString().toLowerCase();
        }

        if (valA < valB) return direction === 'asc' ? -1 : 1;
        if (valA > valB) return direction === 'asc' ? 1 : -1;
        return 0;
    });
}

// ==========================================
// 6. TABLES RENDERING
// ==========================================
function renderRecentTransactions(inList, outList) {
    const tbody = document.getElementById("tbody-recent-transaksi");
    if (!tbody) return;

    let combined = [
        ...(inList || []).map(i => ({ ...i, _type: 'Pemasukan' })),
        ...(outList || []).map(i => ({ ...i, _type: 'Pengeluaran' }))
    ];

    combined = combined
        .map(item => ({ item, d: parseToDateObj(item["Tanggal"] || item["tgl"] || item["TANGGAL"] || "") }))
        .sort((a, b) => {
            const ta = a.d ? a.d.getTime() : 0;
            const tb = b.d ? b.d.getTime() : 0;
            return tb - ta;
        })
        .slice(0, 5)
        .map(x => x.item);

    if (combined.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center">Belum ada transaksi</td></tr>`;
        return;
    }

    tbody.innerHTML = combined.map(item => {
        const isIncome = item._type === 'Pemasukan';
        const val = getNominal(item);
        const tagClass = isIncome ? 'tag-in' : 'tag-out';
        const amtClass = isIncome ? 'amount-in' : 'amount-out';
        const sign = isIncome ? '+' : '-';
        const keterangan = item["Keterangan/Catatan"] || item["Catatan"] || item["Keterangan"] || "-";

        return `
            <tr>
                <td>${formatTanggalClean(item["Tanggal"] || item["tgl"] || item["TANGGAL"] || "-")}</td>
                <td><span class="badge-tag ${tagClass}">${item._type}</span></td>
                <td class="td-category">${getCategory(item, item._type)}</td>
                <td>${keterangan}</td>
                <td class="text-right ${amtClass}"><strong>${sign}${formatIDR(val)}</strong></td>
            </tr>
        `;
    }).join("");
}

// ==========================================
// TOGGLE MODE: CASH vs CASHFLOW (keseluruhan data pembayaran / Antrean Validasi)
// ==========================================
function setDataMode(mode) {
    currentDataMode = mode;

    // Sinkronkan tampilan semua pill toggle yang ada di halaman manapun
    document.querySelectorAll('.mode-toggle[data-page] .mode-btn').forEach(btn => {
        const page = btn.closest('.mode-toggle').dataset.page;
        if (!['dashboard', 'transaksi', 'laporan-periode'].includes(page)) return; // sub-toggle (chart/periode) dikelola fungsinya sendiri
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const showCash = mode === 'cash';

    const dashCash = document.getElementById('dashboard-cash-view');
    const dashCashflow = document.getElementById('dashboard-cashflow-view');
    if (dashCash) dashCash.style.display = showCash ? '' : 'none';
    if (dashCashflow) { dashCashflow.style.display = showCash ? 'none' : ''; if (!showCash) renderCashflowDashboard(); }

    const txCash = document.getElementById('transaksi-cash-view');
    const txCashflow = document.getElementById('transaksi-cashflow-view');
    if (txCash) txCash.style.display = showCash ? '' : 'none';
    if (txCashflow) { txCashflow.style.display = showCash ? 'none' : ''; if (!showCash) renderCashflowTransaksiTable(); }

    const lapCash = document.getElementById('laporan-cash-view');
    const lapCashflow = document.getElementById('laporan-cashflow-view');
    if (lapCash) { lapCash.style.display = showCash ? '' : 'none'; if (showCash) renderLaporanHarianCash(); }
    if (lapCashflow) {
        lapCashflow.style.display = showCash ? 'none' : '';
        if (!showCash) {
            const subHarianAktif = document.getElementById('cashflow-harian-view')?.style.display !== 'none';
            if (subHarianAktif) renderLaporanHarianCashflow(); else renderLaporanPeriode();
        }
    }
}

// Dipanggil setiap kali data pelanggan (Master Data) selesai dimuat/berubah, supaya tampilan
// Cashflow yang sedang terbuka langsung terisi (sebelumnya hanya terisi kalau toggle diklik ulang).
function refreshCashflowViews() {
    if (currentDataMode !== 'cashflow') return;
    if (typeof renderCashflowDashboard === 'function') renderCashflowDashboard();
    if (typeof renderCashflowTransaksiTable === 'function') renderCashflowTransaksiTable();
}

// Seluruh data pembayaran pelanggan yang sudah dibayar (Antrean Validasi), baik yang sudah ACC maupun belum
function getPaidMasterEntries() {
    return (globalMasterData || []).filter(item => {
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "TGL_BAYAR", "Tgl Bayar", "TGL BAYAR"]);
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        const strTgl = String(tglBayar).trim().toLowerCase();
        const strMetode = String(metode).trim().toLowerCase();
        return (strTgl !== "" && strTgl !== "-" && strTgl !== "undefined" && strTgl !== "null") ||
               (strMetode !== "" && strMetode !== "-" && strMetode !== "undefined" && strMetode !== "null");
    });
}

// ==========================================================
// HALAMAN REKAP BANK (Sub Menu Laporan)
// Kelompokkan uang masuk (data pembayaran pelanggan) berdasarkan
// nilai field "metode" (BCA, DANA, Cash, dll), per Harian/Mingguan/Bulanan.
// ==========================================================
let currentPeriodeRekapBank = 'harian';
let lastRekapBankResult = null;

function setPeriodeRekapBank(mode) {
    currentPeriodeRekapBank = mode;
    document.querySelectorAll('.mode-toggle[data-page="rekap-bank"] .mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const elHarian = document.getElementById('rekap-bank-filter-harian');
    const elBulanTahun = document.getElementById('rekap-bank-filter-bulan-tahun');
    const elTahun = document.getElementById('rekap-bank-filter-tahun');
    const elMinggu = document.getElementById('rekap-bank-filter-minggu');

    if (elHarian) elHarian.style.display = mode === 'harian' ? '' : 'none';
    if (elBulanTahun) elBulanTahun.style.display = mode === 'harian' ? 'none' : '';
    if (elTahun) elTahun.style.display = mode === 'harian' ? 'none' : '';
    if (elMinggu) elMinggu.style.display = mode === 'mingguan' ? '' : 'none';

    renderRekapBank();
}

function renderRekapBank() {
    const isi = document.getElementById('isi-rekap-bank');
    const judul = document.getElementById('judul-rekap-bank');
    if (!isi) return;

    const paid = typeof getPaidMasterEntries === 'function' ? getPaidMasterEntries() : [];

    let startDate, endDate, labelPeriode;

    if (currentPeriodeRekapBank === 'harian') {
        const dateInput = document.getElementById('rekap-bank-tanggal');
        if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
        if (!dateInput || !dateInput.value) return;
        const [y, m, d] = dateInput.value.split('-').map(Number);
        startDate = new Date(y, m - 1, d);
        endDate = new Date(y, m - 1, d);
        labelPeriode = `Harian — ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    } else {
        const bulan = parseInt(document.getElementById('rekap-bank-bulan')?.value || (new Date().getMonth() + 1));
        const tahun = parseInt(document.getElementById('rekap-bank-tahun')?.value || new Date().getFullYear());
        const NAMA_BULAN = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

        if (currentPeriodeRekapBank === 'mingguan') {
            const mingguVal = document.getElementById('rekap-bank-minggu')?.value || '1';
            const rentang = { '1': [1,7], '2': [8,14], '3': [15,21], '4': [22,28], '5': [29,31] }[mingguVal] || [1,7];
            const lastDay = new Date(tahun, bulan, 0).getDate();
            startDate = new Date(tahun, bulan - 1, Math.min(rentang[0], lastDay));
            endDate = new Date(tahun, bulan - 1, Math.min(rentang[1], lastDay));
            labelPeriode = `Mingguan — Minggu ke-${mingguVal} (${NAMA_BULAN[bulan - 1]} ${tahun})`;
        } else {
            const lastDay = new Date(tahun, bulan, 0).getDate();
            startDate = new Date(tahun, bulan - 1, 1);
            endDate = new Date(tahun, bulan - 1, lastDay);
            labelPeriode = `Bulanan — ${NAMA_BULAN[bulan - 1]} ${tahun}`;
        }
    }

    if (judul) judul.textContent = `Rekap Per Bank — ${labelPeriode}`;

    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    const dalamPeriode = paid.filter(item => {
        const d = parseToDateObj(getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]));
        return d && d >= startDate && d <= endDate;
    });

    if (dalamPeriode.length === 0) {
        isi.innerHTML = `<p class="text-center" style="padding:20px;">Tidak ada uang masuk pada periode ini.</p>`;
        return;
    }

    const perBank = {};
    let totalSemua = 0;

    dalamPeriode.forEach(item => {
        const metode = normalisasiNamaBank(getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]));

        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        if (!perBank[metode]) perBank[metode] = { total: 0, count: 0 };
        perBank[metode].total += nominal;
        perBank[metode].count += 1;
        totalSemua += nominal;
    });

    const formatRp = num => 'Rp ' + Number(num || 0).toLocaleString('id-ID');
    const rowMain = (label, value) => `
        <div class="lap-line lap-line-main">
            <span class="lap-label">${label}</span>
            <span class="lap-leader"></span>
            <span class="lap-value">${value}</span>
        </div>`;
    const rowCategory = (label, value) => `
        <div class="lap-line lap-line-category">
            <span class="lap-label">${label}</span>
            <span class="lap-leader"></span>
            <span class="lap-value">${value}</span>
        </div>`;

    let html = '';
    html += rowMain('Total Uang Masuk', formatRp(totalSemua));

    // Urutkan dari nominal terbesar ke terkecil
    const urutBank = Object.entries(perBank).sort((a, b) => b[1].total - a[1].total);
    urutBank.forEach(([bank, data]) => {
        html += rowCategory(`${bank} (${data.count} transaksi)`, formatRp(data.total));
    });

    isi.innerHTML = html;

    // Simpan hasil terakhir supaya tombol "Salin ke WhatsApp" tidak perlu hitung ulang
    lastRekapBankResult = { labelPeriode, urutBank, totalSemua };
}

// Susun rekap bank yang sedang tampil jadi teks siap kirim WA, lalu salin ke clipboard
async function salinRekapBankKeWA() {
    if (!lastRekapBankResult) return;
    const { labelPeriode, urutBank, totalSemua } = lastRekapBankResult;

    const lines = [];
    lines.push("*REKAP UANG MASUK PER BANK*");
    lines.push(`${NAMA_TOKO}${ALAMAT_TOKO ? " - " + ALAMAT_TOKO : ""}`);
    lines.push(labelPeriode);
    lines.push("");

    if (urutBank.length === 0) {
        lines.push("Tidak ada uang masuk pada periode ini");
    } else {
        urutBank.forEach(([bank, data]) => {
            lines.push(`${bank} (${data.count}x) : ${formatRpWA(data.total)}`);
        });
    }
    lines.push("");
    lines.push(`*Total Uang Masuk : ${formatRpWA(totalSemua)}*`);

    const text = lines.join("\n");

    try {
        await navigator.clipboard.writeText(text);
        alert("Rekap berhasil disalin! Tinggal paste ke grup WhatsApp.");
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); alert("Rekap berhasil disalin! Tinggal paste ke grup WhatsApp."); }
        catch (e2) { alert("Gagal menyalin otomatis. Silakan salin manual dari kotak berikut:\n\n" + text); }
        document.body.removeChild(ta);
    }
}

function renderCashflowDashboard() {
    const paid = getPaidMasterEntries();
    let totalNominal = 0, nominalCash = 0, nominalTransfer = 0;

    paid.forEach(item => {
        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        totalNominal += nominal;
        if (isMetodeCash(metode)) nominalCash += nominal; else nominalTransfer += nominal;
    });

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('cf-stat-total-transaksi', paid.length.toLocaleString('id-ID'));
    setText('cf-stat-total-nominal', formatIDR(totalNominal));
    setText('cf-stat-nominal-cash', formatIDR(nominalCash));
    setText('cf-stat-nominal-transfer', formatIDR(nominalTransfer));

    renderCashflowDashboardChart(paid);

    const tbody = document.getElementById('tbody-cashflow-dashboard');
    if (!tbody) return;

    const sorted = paid
        .map(item => ({ item, d: parseToDateObj(getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"])) }))
        .sort((a, b) => (b.d ? b.d.getTime() : 0) - (a.d ? a.d.getTime() : 0))
        .slice(0, 10)
        .map(x => x.item);

    if (sorted.length === 0) {
        const dataBelumMasuk = !globalMasterData || globalMasterData.length === 0;
        tbody.innerHTML = `<tr><td colspan="5" class="text-center">${dataBelumMasuk
            ? 'Data pelanggan belum termuat dari server. Tunggu sebentar atau muat ulang halaman (Ctrl+F5).'
            : 'Belum ada pelanggan yang tercatat sudah membayar'}</td></tr>`;
        return;
    }

    tbody.innerHTML = sorted.map(item => {
        const nama = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA"]) || "Tanpa Nama";
        const area = getValueByKeys(item, ["area", "Area", "_sheetName", "AREA"]) || "-";
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode"]) || "-";
        const tgl = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]) || "-";
        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        return `
            <tr>
                <td>${formatTanggalClean(tgl)}</td>
                <td><strong>${nama}</strong></td>
                <td>${area}</td>
                <td><span class="badge-tag ${isMetodeCash(metode) ? 'tag-in' : 'tag-transfer'}">${metode}</span></td>
                <td class="text-right"><strong>${formatIDR(nominal)}</strong></td>
            </tr>
        `;
    }).join("");
}

function renderCashflowTransaksiTable() {
    const tbody = document.getElementById('tbody-cashflow-transaksi');
    if (!tbody) return;

    const searchVal = document.getElementById('search-cashflow-transaksi') ? document.getElementById('search-cashflow-transaksi').value.toLowerCase() : "";
    let paid = getPaidMasterEntries();

    if (searchVal) {
        paid = paid.filter(item => JSON.stringify(item).toLowerCase().includes(searchVal));
    }

    paid = paid
        .map(item => ({ item, d: parseToDateObj(getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"])) }))
        .sort((a, b) => (b.d ? b.d.getTime() : 0) - (a.d ? a.d.getTime() : 0))
        .map(x => x.item);

    if (paid.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center">Tidak ada data pembayaran ditemukan</td></tr>`;
        return;
    }

    tbody.innerHTML = paid.map(item => {
        const nama = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA"]) || "Tanpa Nama";
        const area = getValueByKeys(item, ["area", "Area", "_sheetName", "AREA"]) || "-";
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode"]) || "-";
        const tgl = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]) || "-";
        const keterangan = item.keterangan || item.Keterangan || "-";
        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        return `
            <tr>
                <td>${formatTanggalClean(tgl)}</td>
                <td><strong>${nama}</strong></td>
                <td>${area}</td>
                <td><span class="badge-tag ${isMetodeCash(metode) ? 'tag-in' : 'tag-transfer'}">${metode}</span></td>
                <td>${keterangan}</td>
                <td class="text-right"><strong>${formatIDR(nominal)}</strong></td>
            </tr>
        `;
    }).join("");
}

const BULAN_INDO = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

// Format nominal ala pesan WA: "Rp 150.000" (pakai spasi, beda dikit dari formatIDR() bawaan app)
function formatRpWA(num) {
    return 'Rp ' + Number(num || 0).toLocaleString('id-ID');
}

// Cocokkan item transaksi (Pemasukan/Pengeluaran/Setoran) dengan tanggal tertentu (bandingkan Y/M/D saja)
function isSameDate(dateObj, refDate) {
    if (!dateObj || !refDate) return false;
    return dateObj.getFullYear() === refDate.getFullYear() &&
           dateObj.getMonth() === refDate.getMonth() &&
           dateObj.getDate() === refDate.getDate();
}

// Parser tanggal universal khusus Laporan Cash Harian.
// Dibuat terpisah dari parseToDateObj() (dipakai fitur lain) supaya perbaikan ini
// tidak menyentuh/berdampak ke bagian aplikasi selain Laporan Cash.
// Mendukung: Date object asli, "dd/mm/yyyy", "dd-mm-yyyy", ISO "yyyy-mm-dd" / "yyyy-mm-ddTHH:mm:ss.sssZ"
// (format umum yang dikembalikan Google Apps Script untuk kolom bertipe Date di Sheets), dan fallback native Date parser.
function parseTanggalCash(raw) {
    if (!raw) return null;
    if (raw instanceof Date) return isNaN(raw.getTime()) ? null : new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());

    const str = String(raw).trim();
    if (!str || str === "-" || str.toLowerCase() === "undefined" || str.toLowerCase() === "null") return null;

    // Format dd/mm/yyyy atau dd-mm-yyyy (boleh diikuti jam, mis. "28/08/2026 14:30")
    let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
        const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
        if (!isNaN(d.getTime())) return d;
    }

    // Format ISO yyyy-mm-dd (mis. "2026-08-28" atau "2026-08-28T00:00:00.000Z")
    m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
        const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        if (!isNaN(d.getTime())) return d;
    }

    // Fallback: serahkan ke native Date parser (mis. format "Wed Aug 28 2026 00:00:00 GMT+0700")
    const fallback = new Date(str);
    if (!isNaN(fallback.getTime())) {
        return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
    }

    return null;
}

function getItemDate(item) {
    return parseTanggalCash(item["Tanggal"] || item["tgl"] || item["TANGGAL"] || item["Tanggal Transaksi"] || "");
}

// Versi murni (tanpa sentuh DOM) dari pengelompokan bank untuk 1 tanggal spesifik —
// dipakai bareng oleh Rekap Bank (tab Harian) & Laporan Harian Cashflow gabungan.
function hitungRekapBankUntukTanggal(selectedDate) {
    const paid = typeof getPaidMasterEntries === 'function' ? getPaidMasterEntries() : [];
    const start = new Date(selectedDate); start.setHours(0, 0, 0, 0);
    const end = new Date(selectedDate); end.setHours(23, 59, 59, 999);

    const dalamPeriode = paid.filter(item => {
        const d = parseToDateObj(getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]));
        return d && d >= start && d <= end;
    });

    const perBank = {};
    let totalSemua = 0;

    dalamPeriode.forEach(item => {
        const metode = normalisasiNamaBank(getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]));

        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        if (!perBank[metode]) perBank[metode] = { total: 0, count: 0 };
        perBank[metode].total += nominal;
        perBank[metode].count += 1;
        totalSemua += nominal;
    });

    const urutBank = Object.entries(perBank).sort((a, b) => b[1].total - a[1].total);
    return { urutBank, totalSemua };
}

// ==========================================================
// SUB-TOGGLE "Harian" vs "Mingguan/Bulanan" di dalam tab Cashflow Laporan
// ==========================================================
function setSubPeriodeCashflow(mode) {
    document.querySelectorAll('.mode-toggle[data-page="laporan-cashflow-subperiode"] .mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const elHarian = document.getElementById('cashflow-harian-view');
    const elPeriode = document.getElementById('cashflow-periode-view');
    if (elHarian) elHarian.style.display = mode === 'harian' ? '' : 'none';
    if (elPeriode) elPeriode.style.display = mode === 'harian' ? 'none' : '';

    if (mode === 'harian') renderLaporanHarianCashflow(); else renderLaporanPeriode();
}

let lastLaporanHarianCashflowResult = null;

function renderLaporanHarianCashflow() {
    const dateInput = document.getElementById('cashflow-harian-tanggal');
    if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
    if (!dateInput || !dateInput.value) return;

    const [y, m, d] = dateInput.value.split('-').map(Number);
    const selectedDate = new Date(y, m - 1, d);

    const judulEl = document.getElementById('judul-laporan-harian-cashflow');
    if (judulEl) judulEl.textContent = `Laporan Harian Finance — ${String(d).padStart(2,'0')}-${String(m).padStart(2,'0')}-${y}`;

    const cash = hitungLaporanHarianCash(selectedDate);
    const bank = hitungRekapBankUntukTanggal(selectedDate);

    const isi = document.getElementById('isi-laporan-harian-cashflow');
    if (!isi) return;

    const listItem = (item, isIncome) => {
        const nominal = getNominal(item);
        return `<div style="display:flex; justify-content:space-between; padding: 3px 0;">
            <span>${getItemLabel(item)}</span>
            <strong class="${isIncome ? 'amount-in' : 'amount-out'}">${formatRpWA(nominal)}</strong>
        </div>`;
    };

    let html = `
        <div style="font-weight:700; color: var(--green-primary); margin-bottom: 4px;">— Cashflow Cash —</div>
        <div style="display:flex; justify-content:space-between; padding: 6px 0; border-bottom: 1px dashed var(--border-subtle); font-weight: 700;">
            <span>Saldo Awal</span><span>${formatRpWA(cash.cashAwal)}</span>
        </div>

        <div style="margin-top: 12px; font-weight: 700; color: #059669;">Pemasukan</div>
        ${cash.pemasukanHariIni.length ? cash.pemasukanHariIni.map(i => listItem(i, true)).join("") : '<div class="text-muted" style="padding:4px 0;">Tidak ada pemasukan</div>'}
        <div style="display:flex; justify-content:space-between; padding: 6px 0; border-top: 1px dashed var(--border-subtle); font-weight: 700;">
            <span>Total Masuk</span><span class="amount-in">${formatRpWA(cash.totalPemasukan)}</span>
        </div>

        <div style="margin-top: 14px; font-weight: 700; color: #dc2626;">Pengeluaran</div>
        ${cash.pengeluaranHariIni.length ? cash.pengeluaranHariIni.map(i => listItem(i, false)).join("") : '<div class="text-muted" style="padding:4px 0;">Tidak ada pengeluaran</div>'}
        <div style="display:flex; justify-content:space-between; padding: 6px 0; border-top: 1px dashed var(--border-subtle); font-weight: 700;">
            <span>Total Keluar</span><span class="amount-out">${formatRpWA(cash.totalPengeluaran)}</span>
        </div>

        <div style="display:flex; justify-content:space-between; padding: 4px 0; margin-top:8px;">
            <span>Setoran</span><span>${formatRpWA(cash.totalSetor)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; padding: 6px 0; border-top: 1px solid var(--border-subtle); font-weight: 800;">
            <span>Saldo Akhir</span><span>${formatRpWA(cash.totalCashAkhir)}</span>
        </div>

        <div style="border-top: 1px solid var(--border-subtle); margin: 16px 0;"></div>

        <div style="font-weight:700; color: var(--green-primary); margin-bottom: 4px;">— Bank &amp; E-Wallet —</div>
        ${bank.urutBank.length ? bank.urutBank.map(([nama, data]) => `
            <div style="display:flex; justify-content:space-between; padding: 3px 0;">
                <span>${nama} (${data.count}x)</span><strong>${formatRpWA(data.total)}</strong>
            </div>`).join("") : '<div class="text-muted" style="padding:4px 0;">Tidak ada pembayaran via bank/e-wallet</div>'}

        <div style="display:flex; justify-content:space-between; padding: 8px 0; margin-top: 8px; border-top: 1px solid var(--border-subtle); font-weight: 800; font-size: 13px; color: var(--green-primary);">
            <span>TOTAL MASUK</span><span>${formatRpWA(bank.totalSemua)}</span>
        </div>
    `;

    isi.innerHTML = html;
    lastLaporanHarianCashflowResult = { d, m, y, cash, bank };
}

// Susun Laporan Harian Finance gabungan (Cashflow Cash + Bank & E-Wallet) persis format WA, lalu salin
async function salinLaporanHarianCashflowKeWA() {
    if (!lastLaporanHarianCashflowResult) return;
    const { d, m, y, cash, bank } = lastLaporanHarianCashflowResult;
    const GARIS = "━━━━━━━━━━━━━━━━━━━━━━━";
    const tanggalStr = `${String(d).padStart(2,'0')}-${String(m).padStart(2,'0')}-${y}`;

    const lines = [];
    lines.push(GARIS);
    lines.push(`    *LAPORAN HARIAN FINANCE* `);
    lines.push(`  *${NAMA_TOKO}*`);
    lines.push(`        *Tanggal ${tanggalStr}*`);
    lines.push(GARIS);
    lines.push("");
    lines.push("`--- CASHFLOW CASH ---`");
    lines.push("");
    lines.push(`*Saldo Awal*: ${formatRpWA(cash.cashAwal)}`);
    lines.push("");
    lines.push("*Pemasukan*");
    if (cash.pemasukanHariIni.length) {
        cash.pemasukanHariIni.forEach((item, idx) => lines.push(`${idx + 1}. ${getItemLabel(item)}: ${formatRpWA(getNominal(item))}`));
    } else {
        lines.push("Tidak ada pemasukan");
    }
    lines.push(`*Total Masuk*: ${formatRpWA(cash.totalPemasukan)}`);
    lines.push("");
    lines.push("*Pengeluaran*");
    if (cash.pengeluaranHariIni.length) {
        cash.pengeluaranHariIni.forEach((item, idx) => lines.push(`${idx + 1}. ${getItemLabel(item)}: ${formatRpWA(getNominal(item))}`));
    } else {
        lines.push("Tidak ada pengeluaran");
    }
    lines.push(`*Total Keluar*: ${formatRpWA(cash.totalPengeluaran)}`);
    lines.push("");
    lines.push(`*Setoran*: ${formatRpWA(cash.totalSetor)}`);
    lines.push(`*Saldo Akhir*: ${formatRpWA(cash.totalCashAkhir)}`);
    lines.push("");
    lines.push("`--- BANK & E-WALLET ---`");
    lines.push("");
    if (bank.urutBank.length) {
        bank.urutBank.forEach(([nama, data], idx) => lines.push(`${idx + 1}. ${nama} (${data.count}x): ${formatRpWA(data.total)}`));
    } else {
        lines.push("Tidak ada pembayaran via bank/e-wallet");
    }
    lines.push("");
    lines.push(`*TOTAL MASUK*: ${formatRpWA(bank.totalSemua)}`);
    lines.push(GARIS);

    const text = lines.join("\n");

    try {
        await navigator.clipboard.writeText(text);
        alert("Laporan harian berhasil disalin! Tinggal paste ke grup WhatsApp.");
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); alert("Laporan harian berhasil disalin! Tinggal paste ke grup WhatsApp."); }
        catch (e2) { alert("Gagal menyalin otomatis. Silakan salin manual dari kotak berikut:\n\n" + text); }
        document.body.removeChild(ta);
    }
}

function getItemLabel(item) {
    const label = getValueByKeys(item, [
        "Keterangan/Catatan", "Keterangan / Catatan", "Keterangan", "keterangan", "KETERANGAN",
        "Catatan", "catatan", "CATATAN", "Uraian", "uraian", "Rincian", "Detail", "Deskripsi", "deskripsi",
        "Nama Item", "Item", "item"
    ]);
    return (label && label !== "-") ? label : "Tanpa Keterangan";
}

// Hitung ringkasan cashflow cash untuk 1 tanggal tertentu: cash awal (akumulasi hari-hari sebelumnya),
// daftar pemasukan & pengeluaran hari itu, setoran hari itu, sampai saldo cash akhir hari itu.
function hitungLaporanHarianCash(selectedDate) {
    let cashAwal = 0;
    globalIn.forEach(item => { const d = getItemDate(item); if (d && d < selectedDate) cashAwal += getNominal(item); });
    globalOut.forEach(item => { const d = getItemDate(item); if (d && d < selectedDate) cashAwal -= getNominal(item); });
    globalSetoran.forEach(item => {
        const d = getItemDate(item) || parseTanggalCash(getValueByKeys(item, ["Tanggal", "tgl", "Tgl"]));
        if (d && d < selectedDate) cashAwal -= getNominal(item);
    });

    const pemasukanHariIni = globalIn.filter(item => isSameDate(getItemDate(item), selectedDate));
    const pengeluaranHariIni = globalOut.filter(item => isSameDate(getItemDate(item), selectedDate));
    const setoranHariIni = globalSetoran.filter(item => {
        const d = getItemDate(item) || parseTanggalCash(getValueByKeys(item, ["Tanggal", "tgl", "Tgl"]));
        return isSameDate(d, selectedDate);
    });

    const totalPemasukan = pemasukanHariIni.reduce((s, i) => s + getNominal(i), 0);
    const totalPengeluaran = pengeluaranHariIni.reduce((s, i) => s + getNominal(i), 0);
    const totalSetor = setoranHariIni.reduce((s, i) => s + getNominal(i), 0);
    const totalCash = cashAwal + totalPemasukan - totalPengeluaran;
    const totalCashAkhir = totalCash - totalSetor;

    return { cashAwal, pemasukanHariIni, pengeluaranHariIni, totalPemasukan, totalPengeluaran, totalSetor, totalCash, totalCashAkhir };
}

function renderLaporanHarianCash() {
    const dateInput = document.getElementById('filter-tanggal-harian');
    if (dateInput && !dateInput.value) {
        dateInput.value = new Date().toISOString().split('T')[0];
    }
    if (!dateInput || !dateInput.value) return;

    const [y, m, d] = dateInput.value.split('-').map(Number);
    const selectedDate = new Date(y, m - 1, d);

    const judulEl = document.getElementById('judul-laporan-harian');
    if (judulEl) judulEl.textContent = `Ringkasan Cashflow Harian — ${d} ${BULAN_INDO[m - 1]} ${y}`;

    const r = hitungLaporanHarianCash(selectedDate);
    const isi = document.getElementById('isi-laporan-harian');
    if (!isi) return;

    const listItem = (item, isIncome) => {
        const nominal = getNominal(item);
        return `<div class="cash-line-item" style="display:flex; align-items:baseline; gap:10px; padding: 6px 8px;">
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${getItemLabel(item)}</span>
            <span style="flex:1; border-bottom: 1px dotted var(--border-subtle); min-width: 12px; margin-bottom: 3px;"></span>
            <strong class="${isIncome ? 'amount-in' : 'amount-out'}" style="white-space: nowrap;">${formatRpWA(nominal)}</strong>
        </div>`;
    };

    isi.innerHTML = `
        <div style="display:flex; justify-content:space-between; padding: 6px 0; border-bottom: 1px dashed var(--border-subtle); font-weight: 700;">
            <span>Cash Awal</span><span>${formatRpWA(r.cashAwal)}</span>
        </div>

        <div class="cash-section-in">
            <div style="font-weight: 700; color: #059669;">Pemasukan</div>
            ${r.pemasukanHariIni.length ? r.pemasukanHariIni.map(i => listItem(i, true)).join("") : '<div class="text-muted" style="padding:4px 6px;">Tidak ada pemasukan</div>'}
            <div style="display:flex; justify-content:space-between; padding: 6px 6px 2px 6px; border-top: 1px dashed var(--border-subtle); font-weight: 700;">
                <span>Total Pemasukan</span><span class="amount-in">${formatRpWA(r.totalPemasukan)}</span>
            </div>
        </div>

        <div class="cash-section-out">
            <div style="font-weight: 700; color: #dc2626;">Pengeluaran</div>
            ${r.pengeluaranHariIni.length ? r.pengeluaranHariIni.map(i => listItem(i, false)).join("") : '<div class="text-muted" style="padding:4px 6px;">Tidak ada pengeluaran</div>'}
            <div style="display:flex; justify-content:space-between; padding: 6px 6px 2px 6px; border-top: 1px dashed var(--border-subtle); font-weight: 700;">
                <span>Total Pengeluaran</span><span class="amount-out">${formatRpWA(r.totalPengeluaran)}</span>
            </div>
        </div>

        <div style="border-top: 1px solid var(--border-subtle); margin: 14px 0;"></div>

        <div style="display:flex; justify-content:space-between; padding: 4px 0; font-weight: 800; font-size: 12.5px;">
            <span>TOTAL CASH</span><span>${formatRpWA(r.totalCash)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; padding: 4px 0;">
            <span>Setor</span><span>${formatRpWA(r.totalSetor)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; padding: 8px 0; margin-top: 6px; border-top: 1px solid var(--border-subtle); font-weight: 800; font-size: 13px; color: var(--green-primary);">
            <span>TOTAL CASH AKHIR</span><span>${formatRpWA(r.totalCashAkhir)}</span>
        </div>
    `;
}

// Susun teks ringkasan harian persis format yang biasa dikirim ke grup WA, lalu salin ke clipboard
async function salinLaporanHarianKeWA() {
    const dateInput = document.getElementById('filter-tanggal-harian');
    if (!dateInput || !dateInput.value) return;
    const [y, m, d] = dateInput.value.split('-').map(Number);
    const selectedDate = new Date(y, m - 1, d);
    const r = hitungLaporanHarianCash(selectedDate);

    const lines = [];
    lines.push("*DAILY CASHFLOW*");
    lines.push(`${NAMA_TOKO} - ${ALAMAT_TOKO}`);
    lines.push(`Rekap Tanggal ${d} ${BULAN_INDO[m - 1]} ${y}`);
    lines.push("");
    lines.push("*SALDO AWAL*");
    lines.push(formatRpWA(r.cashAwal));
    lines.push("");
    lines.push("*PEMASUKAN*");
    if (r.pemasukanHariIni.length) {
        r.pemasukanHariIni.forEach(item => lines.push(`${getItemLabel(item)} : ${formatRpWA(getNominal(item))}`));
    } else {
        lines.push("Tidak ada pemasukan");
    }
    lines.push(`*Total Pemasukan : ${formatRpWA(r.totalPemasukan)}*`);
    lines.push("");
    lines.push("*PENGELUARAN*");
    if (r.pengeluaranHariIni.length) {
        r.pengeluaranHariIni.forEach(item => lines.push(`${getItemLabel(item)} : ${formatRpWA(getNominal(item))}`));
    } else {
        lines.push("Tidak ada pengeluaran");
    }
    lines.push(`*Total Pengeluaran : ${formatRpWA(r.totalPengeluaran)}*`);
    lines.push("");
    lines.push("*SETORAN*");
    lines.push(formatRpWA(r.totalSetor));
    lines.push("");
    lines.push("*SALDO AKHIR*");
    lines.push(formatRpWA(r.totalCashAkhir));

    const text = lines.join("\n");

    try {
        await navigator.clipboard.writeText(text);
        alert("Ringkasan berhasil disalin! Tinggal paste ke grup WhatsApp.");
    } catch (e) {
        // Fallback untuk browser yang membatasi akses clipboard
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); alert("Ringkasan berhasil disalin! Tinggal paste ke grup WhatsApp."); }
        catch (e2) { alert("Gagal menyalin otomatis. Silakan salin manual dari kotak berikut:\n\n" + text); }
        document.body.removeChild(ta);
    }
}

function renderTableWithPagination(inList, outList) {
    const tbody = document.getElementById("tbody-transaksi");
    if (!tbody) return;

    tbody.innerHTML = "";

    let combined = [
        ...inList.map(i => ({ ...i, _type: 'Pemasukan' })),
        ...outList.map(i => ({ ...i, _type: 'Pengeluaran' }))
    ];

    combined = sortDataList(combined, sortState.transaksi.col, sortState.transaksi.dir);
    const totalItems = combined.length;

    if (totalItems === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center">Tidak ada transaksi ditemukan</td></tr>`;
        return;
    }

    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);
    const paginatedItems = combined.slice(startIndex, endIndex);

    paginatedItems.forEach(item => {
        const isIncome = item._type === 'Pemasukan';
        const val = getNominal(item);
        const tagClass = isIncome ? 'tag-in' : 'tag-out';
        const amtClass = isIncome ? 'amount-in' : 'amount-out';
        const sign = isIncome ? '+' : '-';

        tbody.innerHTML += `
            <tr>
                <td>${formatTanggalClean(item["Tanggal"] || item["tgl"] || item["TANGGAL"] || "-")}</td>
                <td><span class="badge-tag ${tagClass}">${item._type}</span></td>
                <td class="td-category">${getCategory(item, item._type)}</td>
                <td>${item["Keterangan/Catatan"] || item["Catatan"] || item["Keterangan"] || "-"}</td>
                <td>${item["Minggu Ke-"] ? "M-" + item["Minggu Ke-"] : "-"}</td>
                <td class="text-right ${amtClass}"><strong>${sign}${formatIDR(val)}</strong></td>
            </tr>
        `;
    });

    if (document.getElementById("pagination-info")) document.getElementById("pagination-info").innerText = `Menampilkan ${startIndex + 1} - ${endIndex} dari ${totalItems} data`;
    if (document.getElementById("page-current")) document.getElementById("page-current").innerText = `${currentPage} / ${totalPages}`;
    if (document.getElementById("btn-prev")) document.getElementById("btn-prev").disabled = (currentPage === 1);
    if (document.getElementById("btn-next")) document.getElementById("btn-next").disabled = (currentPage === totalPages);
}

function changePage(delta) {
    currentPage += delta;
    renderAllViews();
}

function updateKategoriInsightVisibility() {
    const typeSelect = document.getElementById('type-select');
    const type = typeSelect ? typeSelect.value : 'ALL';
    const boxIn = document.getElementById('kategori-insight-pemasukan');
    const boxOut = document.getElementById('kategori-insight-pengeluaran');
    if (boxIn) boxIn.style.display = (type === 'Pemasukan') ? '' : 'none';
    if (boxOut) boxOut.style.display = (type === 'Pengeluaran') ? '' : 'none';
}

function handleFilter() {
    currentPage = 1;
    renderAllViews();
    updateKategoriInsightVisibility();
}

function renderTransferTable() {
    const tbody = document.getElementById("tbody-transfer");
    if (!tbody) return;

    tbody.innerHTML = "";

    const searchVal = document.getElementById("search-transfer") ? document.getElementById("search-transfer").value.toLowerCase() : "";
    const statusVal = document.getElementById("status-transfer-select") ? document.getElementById("status-transfer-select").value : "ALL";

    let filtered = globalTransfer.filter(item => {
        const textData = JSON.stringify(item).toLowerCase();
        const matchSearch = textData.includes(searchVal);
        const statusItem = (item["Status"] || item["Status Validasi"] || item["status"] || "Pending").toString().trim();
        const matchStatus = (statusVal === "ALL" || statusItem.toLowerCase() === statusVal.toLowerCase());
        return matchSearch && matchStatus;
    });

    filtered = sortDataList(filtered, sortState.transfer.col, sortState.transfer.dir);
    const totalItems = filtered.length;

    if (totalItems === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center">Tidak ada data validasi transfer</td></tr>`;
        return;
    }

    const startIndex = (currentTransferPage - 1) * ITEMS_PER_PAGE;
    const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, totalItems);
    const paginatedItems = filtered.slice(startIndex, endIndex);

    paginatedItems.forEach(item => {
        const nominal = getNominal(item);
        const tgl = item["Tanggal"] || item["Tgl"] || item["Tanggal Transfer"] || "-";
        const pengirim = item["Nama Pengirim"] || item["Pengirim"] || "-";
        const bank = item["Bank"] || item["Metode"] || "-";
        const ket = item["Keterangan"] || item["Catatan"] || "-";
        const status = item["Status"] || "Pending";
        const buktiLink = item["Bukti"] || item["Bukti Transfer"] || "";

        let statusBadgeClass = "tag-pending";
        const stLower = status.toString().toLowerCase();
        if (stLower.includes("valid") && !stLower.includes("tidak")) {
            statusBadgeClass = "tag-approved";
        } else if (stLower.includes("tidak") || stLower.includes("reject")) {
            statusBadgeClass = "tag-rejected";
        }

        const buktiHtml = (buktiLink && buktiLink.toString().startsWith("http")) 
            ? `<a href="${buktiLink}" target="_blank" class="btn-link-bukti">Lihat Bukti</a>`
            : `<span class="text-muted">-</span>`;

        tbody.innerHTML += `
            <tr>
                <td>${formatTanggalClean(tgl)}</td>
                <td class="td-category">${pengirim}</td>
                <td>${bank}</td>
                <td>${ket}</td>
                <td>${buktiHtml}</td>
                <td><span class="badge-tag ${statusBadgeClass}">${status}</span></td>
                <td class="text-right amount-in"><strong>${formatIDR(nominal)}</strong></td>
            </tr>
        `;
    });
}

function changePageTransfer(delta) {
    currentTransferPage += delta;
    renderTransferTable();
}

function handleFilterTransfer() {
    currentTransferPage = 1;
    renderTransferTable();
}

function renderSetoranTable() {
    const tbody = document.getElementById("tbody-setoran");
    if (!tbody) return;

    tbody.innerHTML = "";
    const searchVal = document.getElementById("search-setoran") ? document.getElementById("search-setoran").value.toLowerCase() : "";
    const listSetoran = globalSetoran || [];

    let filtered = listSetoran.filter(item => JSON.stringify(item).toLowerCase().includes(searchVal));

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding:20px;">Belum ada riwayat setoran bank</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        let tgl = "-";
        let kat = "Setoran Bank";
        let ket = "-";

        for (let key in item) {
            let lowerKey = key.toLowerCase();
            if (lowerKey.includes("tgl") || lowerKey.includes("tanggal")) tgl = item[key];
            if (lowerKey.includes("kat") || lowerKey.includes("bank") || lowerKey.includes("tujuan")) kat = item[key];
            if (lowerKey.includes("ket") || lowerKey.includes("catat") || lowerKey.includes("uraian")) ket = item[key];
        }

        const nominal = getNominal(item);

        tbody.innerHTML += `
            <tr>
                <td>${formatTanggalClean(tgl)}</td>
                <td><span class="badge-tag tag-approved">${kat || 'Bank'}</span></td>
                <td>${ket || '-'}</td>
                <td class="text-right amount-in"><strong>${formatIDR(nominal)}</strong></td>
            </tr>
        `;
    });
}

// 1. RENDER TABEL & HITUNG TOTAL NOMINAL
function renderSheetPengeluaranALL(data = globalOutAll) {
    const tbody = document.getElementById("body-pengeluaran-all");
    const statTotalEl = document.getElementById("stat-total-pengeluaran-all");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding:20px;">Data tidak ditemukan.</td></tr>`;
        if (statTotalEl) statTotalEl.innerText = formatIDR(0);
        return;
    }

    let totalNominalSum = 0;

    data.forEach((item, index) => {
        const tanggal = getValueByKeys(item, ["Tanggal", "tanggal", "TANGGAL", "Tgl", "tgl"]) || item[0] || "-";
        const kategori = getValueByKeys(item, ["Kategori", "kategori", "KATEGORI", "Kategori Pengeluaran", "Jenis", "Jenis Pengeluaran"]) || item[1] || "-";

        let rawNominal = getValueByKeys(item, ["Nominal", "nominal", "NOMINAL", "Jumlah", "jumlah", "JUMLAH", "Total", "total", "Pengeluaran", "pengeluaran", "Debet", "debet", "Kredit", "kredit"]);
        if ((rawNominal === "" || rawNominal === undefined || rawNominal === null) && typeof getNominal === 'function') {
            rawNominal = getNominal(item);
        }

        const nominal = typeof cleanToNumber === 'function' ? cleanToNumber(rawNominal) : (Number(rawNominal) || 0);
        
        // Akumulasi total
        totalNominalSum += nominal;

        const minggu = getValueByKeys(item, ["Minggu", "minggu", "MINGGU", "Minggu Ke-", "Minggu Ke", "mingguKe"]) || item[3] || "-";

        let keterangan = getValueByKeys(item, [
            "Keterangan", "keterangan", "KETERANGAN", "Catatan", "catatan", "CATATAN",
            "Keterangan/Catatan", "Keterangan / Catatan", "Uraian", "uraian", "Rincian", "Detail", "Deskripsi"
        ]);
        if (!keterangan || keterangan === "-") {
            keterangan = item[4] || item[5] || item[6] || "-";
        }

        let teksMinggu = "-";
        if (minggu !== "-") {
            teksMinggu = String(minggu).toLowerCase().includes("minggu") ? minggu : "Minggu " + minggu;
        }

        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${formatTanggalClean(tanggal)}</td>
            <td><span class="badge-tag tag-out">${kategori}</span></td>
            <td class="text-right amount-out"><strong>${formatIDR(nominal)}</strong></td>
            <td>${teksMinggu}</td>
            <td>${keterangan}</td>
        `;
        tbody.appendChild(row);
    });

    // Update tampilan Card Total Pengeluaran
    if (statTotalEl) {
        statTotalEl.innerText = formatIDR(totalNominalSum);
    }
}



// 3. RESET FILTER
function resetFilterPengeluaranALL() {
    if (document.getElementById("filter-bulan-pengeluaran-all")) document.getElementById("filter-bulan-pengeluaran-all").value = "";
    if (document.getElementById("filter-tanggal-pengeluaran-all")) document.getElementById("filter-tanggal-pengeluaran-all").value = "";
    renderSheetPengeluaranALL(globalOutAll);
}




// ==========================================
// 7. CHARTS & CATEGORY VIEWS
// ==========================================
function renderCategoryCharts() {
    renderSingleCategoryChart('Pemasukan', globalIn, selectedKatIn, 'chartKatPemasukan', 'title-kat-pemasukan', 'sub-kat-pemasukan', '#2f5bea');
    renderSingleCategoryChart('Pengeluaran', globalOut, selectedKatOut, 'chartKatPengeluaran', 'title-kat-pengeluaran', 'sub-kat-pengeluaran', '#dc2626');
}

if (window.Chart) { Chart.defaults.font.family = "'Plus Jakarta Sans', -apple-system, sans-serif"; }

function getChartThemeColors() {
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    return {
        isDark: isDark,
        text: isDark ? '#9ca3af' : '#6b7280',
        grid: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)',
        tipBg: isDark ? '#1f232c' : '#ffffff',
        tipText: isDark ? '#f3f4f6' : '#111827',
        tipBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.08)',
        // seri 1 = biru (gradasi atas -> bawah), seri 2 = lime, seri 3 = lavender
        c1Top: isDark ? '#5b84ff' : '#2f5bea',
        c1Bottom: isDark ? '#3a4f99' : '#9db3ff',
        c2Top: '#a3e635',
        c2Bottom: isDark ? '#5c7d1c' : '#e4f9b4',
        c3: isDark ? '#33406e' : '#c9d6ff',
        brand: isDark ? '#5b84ff' : '#2f5bea',
        empty: isDark ? '#262b36' : '#e9ebf0'
    };
}

// Format ringkas untuk sumbu grafik & angka besar (contoh: Rp 12,5 jt)
function formatCompactIDR(value) {
    const n = Number(value) || 0;
    return 'Rp ' + new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Gradasi vertikal untuk batang (dihitung ulang saat chartArea tersedia)
function makeBarGradient(top, bottom) {
    return function (context) {
        const area = context.chart.chartArea;
        if (!area) return top;
        const g = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
        g.addColorStop(0, top);
        g.addColorStop(1, bottom);
        return g;
    };
}

// Grafik batang bergradasi, sudut membulat — dipakai Dashboard (Cash) & Dashboard (Cashflow)
function buildTrendBarChart(canvasId, labels, seriesDefs) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const t = getChartThemeColors();
    return new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: labels,
            datasets: seriesDefs.map(function (d) {
                return {
                    label: d.label,
                    data: d.data,
                    backgroundColor: makeBarGradient(d.top, d.bottom),
                    borderRadius: 12,
                    borderSkipped: false,
                    maxBarThickness: 38,
                    categoryPercentage: 0.7,
                    barPercentage: 0.9
                };
            })
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'end',
                    labels: { color: t.text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { size: 12, weight: '600' } }
                },
                tooltip: {
                    backgroundColor: t.tipBg,
                    titleColor: t.tipText,
                    bodyColor: t.tipText,
                    borderColor: t.tipBorder,
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 12,
                    displayColors: true,
                    boxPadding: 4,
                    usePointStyle: true,
                    titleFont: { size: 12, weight: '700' },
                    bodyFont: { size: 12 },
                    callbacks: { label: function (c) { return c.dataset.label + ': ' + formatIDR(c.parsed.y); } }
                }
            },
            scales: {
                x: { ticks: { color: t.text, font: { size: 11 } }, grid: { display: false }, border: { display: false } },
                y: {
                    beginAtZero: true,
                    ticks: { color: t.text, font: { size: 11 }, callback: function (v) { return formatCompactIDR(v); } },
                    grid: { color: t.grid, drawTicks: false },
                    border: { display: false }
                }
            }
        }
    });
}

let chartSparkInstance = null;
let chartDonutInstance = null;

// Grafik area kecil di dasar kartu "Saldo Bersih" (selisih pemasukan - pengeluaran per periode)
function renderSparkline(values) {
    const canvas = document.getElementById('chartSpark');
    if (!canvas) return;
    if (chartSparkInstance) chartSparkInstance.destroy();
    const t = getChartThemeColors();
    const data = values && values.length > 1 ? values : [0, 0];
    chartSparkInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: data.map(function (_, i) { return i + 1; }),
            datasets: [{
                data: data,
                borderColor: t.brand,
                borderWidth: 2,
                fill: 'start',
                tension: 0.45,
                pointRadius: 0,
                backgroundColor: function (context) {
                    const area = context.chart.chartArea;
                    if (!area) return 'transparent';
                    const g = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                    g.addColorStop(0, t.isDark ? 'rgba(91,132,255,0.35)' : 'rgba(47,91,234,0.28)');
                    g.addColorStop(1, 'rgba(47,91,234,0)');
                    return g;
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 6 } },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false, grace: '10%' } }
        }
    });
}

// Gauge/donut terbuka 270°, ujung membulat: komposisi pemasukan -> ter-setor / cash kantor / pengeluaran
function renderDonutKomposisi(totalIn, totalOut) {
    const canvas = document.getElementById('chartDonut');
    if (!canvas) return;
    if (chartDonutInstance) chartDonutInstance.destroy();
    const t = getChartThemeColors();

    const totalSetor = (globalSetoran || []).reduce(function (sum, i) { return sum + getNominal(i); }, 0);
    const kantor = Math.max(totalIn - totalOut - totalSetor, 0);
    const values = [totalSetor, kantor, totalOut];
    const adaData = values.some(function (v) { return v > 0; });

    const setText = function (id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setText('donut-total', formatCompactIDR(totalIn));
    setText('donut-val-setor', formatCompactIDR(totalSetor));
    setText('donut-val-kantor', formatCompactIDR(kantor));
    setText('donut-val-keluar', formatCompactIDR(totalOut));

    chartDonutInstance = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Ter-setor', 'Cash kantor', 'Pengeluaran'],
            datasets: [{
                data: adaData ? values : [1],
                backgroundColor: adaData ? [t.c1Top, t.c2Top, t.c3] : [t.empty],
                borderWidth: 0,
                borderRadius: adaData ? 14 : 0,
                spacing: adaData ? 4 : 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            rotation: -135,
            circumference: 270,
            cutout: '74%',
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: adaData,
                    backgroundColor: t.tipBg,
                    titleColor: t.tipText,
                    bodyColor: t.tipText,
                    borderColor: t.tipBorder,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 12,
                    callbacks: { label: function (c) { return c.label + ': ' + formatIDR(c.parsed); } }
                }
            }
        }
    });
}

// Daftar 4 kategori pemasukan terbesar, dengan batang porsi (seperti daftar negara di referensi)
function renderTopKategoriPemasukan(inList) {
    const listEl = document.getElementById('cat-list');
    const totalEl = document.getElementById('cat-total');
    if (!listEl) return;

    const map = {};
    inList.forEach(function (item) {
        const cat = getCategory(item, 'Pemasukan') || 'Lainnya';
        map[cat] = (map[cat] || 0) + getNominal(item);
    });
    const entries = Object.keys(map).map(function (k) { return [k, map[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    const total = entries.reduce(function (sum, e) { return sum + e[1]; }, 0);
    if (totalEl) totalEl.textContent = formatIDR(total);

    if (!entries.length || total <= 0) {
        listEl.innerHTML = '<div class="cat-empty">Belum ada data pemasukan.</div>';
        return;
    }
    listEl.innerHTML = entries.slice(0, 4).map(function (e) {
        const pct = Math.round((e[1] / total) * 100);
        return '<div class="cat-row">' +
            '<div class="cat-row-top"><span>' + escHtml(e[0]) + '</span><span>' + formatCompactIDR(e[1]) + ' · ' + pct + '%</span></div>' +
            '<div class="cat-bar"><div style="width:' + Math.max(pct, 2) + '%"></div></div>' +
            '</div>';
    }).join('');
}

function refreshChartsTheme() {
    // Render ulang chart yang sedang aktif supaya warna axis/grid ikut tema baru
    if (typeof renderDashboardChart === 'function' && chartTrendInstance) {
        renderDashboardChart(globalIn || [], globalOut || []);
    }
    if (typeof renderCashflowDashboardChart === 'function' && chartCashflowTrendInstance) {
        renderCashflowDashboardChart(getPaidMasterEntries());
    }
    if (typeof renderCategoryViews === 'function') renderCategoryViews();
}

function renderSingleCategoryChart(type, dataList, selectedCategory, canvasId, titleId, subTitleId, colorTheme) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    if (type === 'Pemasukan') {
        if (chartKatInInstance && typeof chartKatInInstance.destroy === 'function') chartKatInInstance.destroy();
    } else {
        if (chartKatOutInstance && typeof chartKatOutInstance.destroy === 'function') chartKatOutInstance.destroy();
    }

    const titleEl = document.getElementById(titleId);
    const subEl = document.getElementById(subTitleId);
    if (titleEl) {
        titleEl.innerText = selectedCategory === 'ALL' 
            ? `Tren ${type}: Semua Kategori` 
            : `Tren ${type}: ${selectedCategory}`;
    }
    if (subEl) {
        subEl.innerText = selectedCategory === 'ALL' 
            ? `Menampilkan akumulasi seluruh alokasi kas ${type === 'Pemasukan' ? 'masuk' : 'keluar'}` 
            : `Menampilkan rincian transaksi kategori ${selectedCategory}`;
    }

    let filtered = dataList;
    if (selectedCategory !== 'ALL') {
        filtered = dataList.filter(item => getCategory(item, type) === selectedCategory);
    }

    const labelMap = {};
    filtered.forEach(item => {
        let key = selectedCategory === 'ALL' 
            ? getCategory(item, type) 
            : (item["Minggu Ke-"] ? `Minggu ${item["Minggu Ke-"]}` : (formatTanggalClean(item["Tanggal"]) || "Lainnya"));
        labelMap[key] = (labelMap[key] || 0) + getNominal(item);
    });

    const labels = Object.keys(labelMap);
    const values = Object.values(labelMap);
    const themeColors = getChartThemeColors();
    const isBar = selectedCategory === 'ALL';

    const gradBar = ctx.createLinearGradient(0, 0, 0, 230);
    gradBar.addColorStop(0, colorTheme);
    gradBar.addColorStop(1, colorTheme + '66');
    let fillStyle = gradBar;
    if (!isBar) {
        const gradientCat = ctx.createLinearGradient(0, 0, 0, 230);
        gradientCat.addColorStop(0, colorTheme + '40');
        gradientCat.addColorStop(1, colorTheme + '00');
        fillStyle = gradientCat;
    }

    const newChart = new Chart(ctx, {
        type: isBar ? 'bar' : 'line',
        data: {
            labels: labels,
            datasets: [{
                label: `Total ${type}`,
                data: values,
                backgroundColor: fillStyle,
                borderColor: colorTheme,
                borderWidth: isBar ? 0 : 3,
                borderRadius: isBar ? 12 : 0,
                borderSkipped: false,
                maxBarThickness: 34,
                fill: !isBar,
                tension: 0.45,
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBackgroundColor: colorTheme,
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: themeColors.tipBg,
                    titleColor: themeColors.tipText,
                    bodyColor: themeColors.tipText,
                    borderColor: themeColors.tipBorder,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 10,
                    displayColors: false,
                    titleFont: { size: 10, weight: '700' },
                    bodyFont: { size: 10 },
                    callbacks: {
                        label: (c) => formatIDR(c.parsed.y)
                    }
                }
            },
            scales: {
                x: {
                    ticks: { display: false },
                    grid: { display: false },
                    border: { display: false }
                },
                y: {
                    beginAtZero: true,
                    ticks: { callback: value => formatCompactIDR(value), color: themeColors.text, font: { size: 11 } },
                    grid: { color: themeColors.grid, drawTicks: false },
                    border: { display: false }
                }
            }
        }
    });

    if (type === 'Pemasukan') chartKatInInstance = newChart;
    else chartKatOutInstance = newChart;
}

const BULAN_PENDEK = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function getBulanKeyFromDate(raw) {
    const d = raw ? parseToDateObj(raw) : null;
    if (!d || isNaN(d.getTime())) return { sortKey: '9999-99', label: 'Lainnya' };
    const y = d.getFullYear();
    const m = d.getMonth();
    return { sortKey: `${y}-${String(m).padStart(2, '0')}`, label: BULAN_PENDEK[m] };
}
function getBulanKey(item) {
    const raw = item["Tanggal"] || item["tanggal"] || item["Tgl"] || null;
    return getBulanKeyFromDate(raw);
}

let cashChartMode = 'mingguan';

function setCashChartMode(mode) {
    cashChartMode = mode;
    document.querySelectorAll('.mode-toggle[data-page="cash-chart"] .mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    renderDashboardChart(globalIn || [], globalOut || []);
}

function renderDashboardChart(inList, outList) {
    renderRecentTransactions(inList, outList);
    const canvas = document.getElementById("chartTrend");
    if (!canvas) return;
    if (chartTrendInstance) chartTrendInstance.destroy();

    const monthInput = document.getElementById("filter-bulan-cash-chart");
    const selectedMonth = monthInput && monthInput.value ? monthInput.value : new Date().toISOString().slice(0, 7);
    const [selYear, selMonth] = selectedMonth.split('-').map(Number);

    const bulanMap = {}; // sortKey -> { label, in, out }

    const addToMap = (item, field) => {
        const raw = item["Tanggal"] || item["tanggal"] || item["Tgl"] || null;
        const d = raw ? parseToDateObj(raw) : null;
        if (!d || isNaN(d.getTime())) return;
        if (d.getFullYear() !== selYear || (d.getMonth() + 1) !== selMonth) return;

        let sortKey, label;
        if (cashChartMode === 'harian') {
            const day = d.getDate();
            sortKey = String(day).padStart(2, '0');
            label = String(day);
        } else {
            const week = getWeekOfMonth(d);
            sortKey = String(week);
            label = `Minggu ${week}`;
        }

        if (!bulanMap[sortKey]) bulanMap[sortKey] = { label, in: 0, out: 0 };
        bulanMap[sortKey][field] += getNominal(item);
    };

    inList.forEach(item => addToMap(item, 'in'));
    outList.forEach(item => addToMap(item, 'out'));

    if (cashChartMode === 'mingguan') {
        for (let w = 1; w <= 4; w++) {
            const k = String(w);
            if (!bulanMap[k]) bulanMap[k] = { label: `Minggu ${w}`, in: 0, out: 0 };
        }
    }

    const sortedKeys = Object.keys(bulanMap).sort();
    const labels = sortedKeys.map(k => bulanMap[k].label);
    const dataIn = sortedKeys.map(k => bulanMap[k].in);
    const dataOut = sortedKeys.map(k => bulanMap[k].out);
    const t = getChartThemeColors();

    chartTrendInstance = buildTrendBarChart('chartTrend', labels, [
        { label: 'Pemasukan', data: dataIn, top: t.c1Top, bottom: t.c1Bottom },
        { label: 'Pengeluaran', data: dataOut, top: t.c2Top, bottom: t.c2Bottom }
    ]);

    // Kartu & panel pendamping (semua memakai daftar yang sama dengan angka KPI)
    renderSparkline(sortedKeys.map(k => bulanMap[k].in - bulanMap[k].out));
    const totalIn = inList.reduce((sum, i) => sum + getNominal(i), 0);
    const totalOut = outList.reduce((sum, i) => sum + getNominal(i), 0);
    renderDonutKomposisi(totalIn, totalOut);
    renderTopKategoriPemasukan(inList);
}

let cashflowChartMode = 'mingguan';

function setCashflowChartMode(mode) {
    cashflowChartMode = mode;
    document.querySelectorAll('.mode-toggle[data-page="cashflow-chart"] .mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    renderCashflowDashboardChart(getPaidMasterEntries());
}

function getWeekOfMonth(dateObj) {
    const day = dateObj.getDate();
    if (day <= 7) return 1;
    if (day <= 14) return 2;
    if (day <= 21) return 3;
    return 4; // tanggal 22 s/d akhir bulan masuk Minggu ke-4
}

let cashflowBulanSudahDisesuaikan = false;

// Bila bulan berjalan belum punya pembayaran, pindahkan filter ke bulan terakhir yang ada datanya
// (hanya sekali, sebelum pengguna mengubah filter sendiri) agar grafik tidak tampak kosong.
function sesuaikanBulanCashflow(paid) {
    if (cashflowBulanSudahDisesuaikan || !paid || paid.length === 0) return;
    const monthInput = document.getElementById("filter-bulan-cashflow-chart");
    if (!monthInput) return;
    cashflowBulanSudahDisesuaikan = true;
    const ym = d => d.getFullYear() * 100 + (d.getMonth() + 1);
    const semua = paid.map(item => {
        const tgl = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]);
        const d = tgl ? parseToDateObj(tgl) : null;
        return d && !isNaN(d.getTime()) ? ym(d) : null;
    }).filter(v => v !== null);
    if (semua.length === 0) return;
    const [y, m] = (monthInput.value || "").split('-').map(Number);
    if (semua.includes(y * 100 + m)) return;
    const terakhir = Math.max(...semua);
    monthInput.value = `${Math.floor(terakhir / 100)}-${String(terakhir % 100).padStart(2, '0')}`;
}

function renderCashflowDashboardChart(paid) {
    const canvas = document.getElementById("chartCashflowTrend");
    if (!canvas) return;
    sesuaikanBulanCashflow(paid);
    const ctx = canvas.getContext("2d");
    if (chartCashflowTrendInstance) chartCashflowTrendInstance.destroy();

    const monthInput = document.getElementById("filter-bulan-cashflow-chart");
    const selectedMonth = monthInput && monthInput.value ? monthInput.value : new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const [selYear, selMonth] = selectedMonth.split('-').map(Number);

    const groupMap = {}; // sortKey -> { label, cash, transfer }

    paid.forEach(item => {
        const tglRaw = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]);
        const d = tglRaw ? parseToDateObj(tglRaw) : null;
        if (!d || isNaN(d.getTime())) return;
        if (d.getFullYear() !== selYear || (d.getMonth() + 1) !== selMonth) return; // hanya bulan terpilih

        let sortKey, label;
        if (cashflowChartMode === 'harian') {
            const day = d.getDate();
            sortKey = String(day).padStart(2, '0');
            label = String(day);
        } else {
            const week = getWeekOfMonth(d);
            sortKey = String(week);
            label = `Minggu ${week}`;
        }

        if (!groupMap[sortKey]) groupMap[sortKey] = { label, cash: 0, transfer: 0 };
        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        if (isMetodeCash(metode)) groupMap[sortKey].cash += nominal; else groupMap[sortKey].transfer += nominal;
    });

    // Pastikan urutan Minggu 1-4 selalu tampil walau datanya kosong
    if (cashflowChartMode === 'mingguan') {
        for (let w = 1; w <= 4; w++) {
            const k = String(w);
            if (!groupMap[k]) groupMap[k] = { label: `Minggu ${w}`, cash: 0, transfer: 0 };
        }
    }

    const sortedKeys = Object.keys(groupMap).sort();
    const labels = sortedKeys.map(k => groupMap[k].label);
    const dataCash = sortedKeys.map(k => groupMap[k].cash);
    const dataTransfer = sortedKeys.map(k => groupMap[k].transfer);
    const t = getChartThemeColors();

    chartCashflowTrendInstance = buildTrendBarChart('chartCashflowTrend', labels, [
        { label: 'Cash', data: dataCash, top: t.c1Top, bottom: t.c1Bottom },
        { label: 'Transfer', data: dataTransfer, top: t.c2Top, bottom: t.c2Bottom }
    ]);
}

function renderCategoryViews() {
    const inGrid = document.getElementById("kat-pemasukan-list");
    if (inGrid) {
        inGrid.innerHTML = "";
        const inCatMap = {};
        globalIn.forEach(item => {
            const cat = getCategory(item, "Pemasukan");
            inCatMap[cat] = (inCatMap[cat] || 0) + getNominal(item);
        });

        Object.keys(inCatMap).forEach(cat => {
            const isActive = (selectedKatIn === cat);
            const safeCat = cat.replace(/'/g, "\\'"); 

            inGrid.innerHTML += `
                <div class="kategori-card ${isActive ? 'active-in' : ''}" style="border-left: 4px solid var(--brand); cursor: pointer;" onclick="filterCategoryTrend('Pemasukan', '${safeCat}')">
                    <div class="k-title">${cat}</div>
                    <div class="k-val" style="color: var(--brand);">${formatIDR(inCatMap[cat])}</div>
                </div>
            `;
        });
    }

    const outGrid = document.getElementById("kat-pengeluaran-list");
    if (outGrid) {
        outGrid.innerHTML = "";
        const outCatMap = {};
        globalOut.forEach(item => {
            const cat = getCategory(item, "Pengeluaran");
            outCatMap[cat] = (outCatMap[cat] || 0) + getNominal(item);
        });

        Object.keys(outCatMap).forEach(cat => {
            const isActive = (selectedKatOut === cat);
            const safeCat = cat.replace(/'/g, "\\'");

            outGrid.innerHTML += `
                <div class="kategori-card ${isActive ? 'active-out' : ''}" style="border-left: 4px solid #dc2626; cursor: pointer;" onclick="filterCategoryTrend('Pengeluaran', '${safeCat}')">
                    <div class="k-title">${cat}</div>
                    <div class="k-val" style="color: #dc2626;">${formatIDR(outCatMap[cat])}</div>
                </div>
            `;
        });
    }

    if (typeof renderCategoryCharts === "function") renderCategoryCharts();
}

function filterCategoryTrend(type, categoryName) {
    if (type === 'Pemasukan') {
        selectedKatIn = (selectedKatIn === categoryName && categoryName !== 'ALL') ? 'ALL' : categoryName;
    } else {
        selectedKatOut = (selectedKatOut === categoryName && categoryName !== 'ALL') ? 'ALL' : categoryName;
    }
    renderCategoryViews();
}

// ==========================================
// 8. MASTER DATA & VALIDATION LOGIC
// ==========================================
function processMasterData(rawData) {
    if (!rawData) return;
    let parsedData = [];

    if (typeof rawData === 'object' && !Array.isArray(rawData)) {
        rawData = rawData["MASTER DATA"] || rawData["masterData"] || rawData.data || rawData.pelanggan || Object.values(rawData)[0] || [];
    }

    if (!Array.isArray(rawData) || rawData.length === 0) {
        globalMasterData = [];
        refreshCashflowViews();
        return;
    }

    if (Array.isArray(rawData[0])) {
        const headers = rawData[0].map(h => h.toString().trim());
        for (let i = 1; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length === 0) continue;
            let obj = {};
            headers.forEach((header, index) => {
                obj[header] = row[index] !== undefined ? row[index] : "";
            });
            obj["_rowIndex"] = i + 1;
            parsedData.push(obj);
        }
    } else {
        parsedData = rawData.map((item, idx) => ({
            ...item,
            _rowIndex: item._rowIndex !== undefined ? item._rowIndex : idx + 2
        }));
    }

    globalMasterData = parsedData;
    populateAreaDropdown();
    renderMasterDataTable();
    refreshCashflowViews();
}

function populateAreaDropdown() {
    const areaSelect = document.getElementById("area-select");
    if (!areaSelect) return;

    const currentVal = areaSelect.value;
    areaSelect.innerHTML = `<option value="ALL">Semua Area Sheet</option>`;

    const areas = new Set();
    globalMasterData.forEach(item => {
        const areaName = item.area || item._sheetName || "";
        if (areaName && areaName !== "-" && !isExcludedSheetName(areaName)) {
            areas.add(areaName.toString().trim());
        }
    });

    Array.from(areas).sort().forEach(area => {
        const opt = document.createElement("option");
        opt.value = area;
        opt.innerText = `Area: ${area}`;
        areaSelect.appendChild(opt);
    });

    areaSelect.value = currentVal || "ALL";
}

function getValueByKeys(item, possibleKeys) {
    for (let key of possibleKeys) {
        if (item[key] !== undefined && item[key] !== null && item[key] !== "") {
            return item[key].toString().trim();
        }
    }
    return "";
}

function renderMasterDataTable() {
    const tbody = document.getElementById("tbody-master-data");
    if (!tbody) return;

    if (!globalMasterData || globalMasterData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="padding:20px;">Belum ada data pelanggan ditemukan.</td></tr>`;
        updateMasterStats([]);
        return;
    }

    const searchVal = document.getElementById("search-master") ? document.getElementById("search-master").value.toLowerCase() : "";
    const selectedArea = document.getElementById("area-select") ? document.getElementById("area-select").value : "ALL";

    let filtered = globalMasterData.filter(item => {
        const area = getValueByKeys(item, ["area", "Area", "_sheetName", "AREA"]) || "Umum";
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "tgl", "TGL_BAYAR"]);
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        const isACC = item.status === true || item.status === "true" || item.status === "TRUE";

        const isSudahBayar = (tglBayar !== "" && tglBayar !== "-") || (metode !== "" && metode !== "-");

        if (!isSudahBayar || isACC) return false;

        const matchSearch = searchVal === "" || JSON.stringify(item).toLowerCase().includes(searchVal);
        const matchArea = (selectedArea === "ALL" || selectedArea === "" || area.toUpperCase() === selectedArea.toUpperCase());

        return matchSearch && matchArea;
    });

    filtered = sortDataList(filtered, sortState.master.col, sortState.master.dir);
    
    updateMasterStats(filtered);

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="padding:20px;">🎉 Semua antrean pembayaran telah divalidasi.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map((item, index) => {
        const tagihanVal = typeof item.tagihan === "number" ? item.tagihan : parseFloat(item.tagihan.toString().replace(/[^0-9]/g, "")) || 0;
        const safeSheetName = (item._sheetName || item.area || "Sheet1").replace(/'/g, "\\'");
        const namaPelanggan = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA"]) || "Tanpa Nama";
        const tglText = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran"]) || "-";
        const metodeText = getValueByKeys(item, ["metode", "Metode Bayar", "Metode"]) || "-";

        return `
            <tr id="row-queue-${item._rowIndex}">
                <td>${index + 1}</td>
                <td><strong>${namaPelanggan}</strong></td>
                <td><span class="badge-tag tag-in">${item.area || item._sheetName || '-'}</span></td>
                <td>${item.tempo ? 'Tgl ' + item.tempo : '-'}</td>
                <td class="text-right"><strong>${formatIDR(tagihanVal)}</strong></td>
                <td class="small text-muted">${tglText}</td>
                <td class="small"><strong>${metodeText}</strong></td>
                <td class="small text-muted">${item.keterangan || item.Keterangan || '-'}</td>
                <td class="text-center">
                    <button type="button" class="btn-acc" onclick="submitValidation(${item._rowIndex}, '${safeSheetName}', this)">
                        <svg class="btn-acc-icon" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-8"/></svg>
                        <span>ACC</span>
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

async function submitValidation(rowIndex, sheetName, btnElement) {
    if (!sheetName || sheetName === "-" || isExcludedSheetName(sheetName)) {
        alert("Gagal: Nama sheet daerah tidak valid.");
        return;
    }

    if (!confirm(`Apakah Anda yakin ingin memvalidasi pembayaran ini? (Akan mencentang kotak di Sheet '${sheetName}')`)) return;

    const originalText = btnElement.innerHTML;
    btnElement.disabled = true;
    btnElement.classList.add("is-loading");
    btnElement.innerHTML = '<span class="btn-acc-spinner" aria-hidden="true"></span><span>Memproses</span>';

    try {
        const response = await fetch(API_URL_VALIDASI, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: "acc", rowIndex: rowIndex, sheetName: sheetName })
        });

        const result = await response.json();

        if (result.status === "success") {
            const targetItem = globalMasterData.find(item => item._rowIndex === rowIndex && item._sheetName === sheetName);
            if (targetItem) targetItem.status = true;

            renderMasterDataTable();
        } else {
            alert("Gagal memvalidasi: " + (result.message || "Terjadi kesalahan"));
            btnElement.disabled = false;
            btnElement.classList.remove("is-loading");
            btnElement.innerHTML = originalText;
        }
    } catch (err) {
        console.error("Gagal memproses ACC:", err);
        alert("Gagal terhubung ke server saat proses ACC.");
        btnElement.disabled = false;
        btnElement.classList.remove("is-loading");
        btnElement.innerHTML = originalText;
    }
}

function updateMasterStats(dataAntreanTampil) {
    let totalNominalAntrean = 0;
    dataAntreanTampil.forEach(item => {
        totalNominalAntrean += getJumlahTagihan(item);
    });

    const statTotal = document.getElementById("stat-master-total");
    const statCount = document.getElementById("stat-master-lunas");
    
    if (statTotal) statTotal.innerText = formatIDR(totalNominalAntrean);
    if (statCount) statCount.innerText = `${dataAntreanTampil.length} Orang Antrean`;

    let countSudahBayar = 0;
    let totalNominalBayar = 0;

    (globalMasterData || []).forEach(item => {
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "tgl", "TGL_BAYAR"]);
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        
        const isSudahBayar = (tglBayar !== "" && tglBayar !== "-") || (metode !== "" && metode !== "-");

        if (isSudahBayar) {
            countSudahBayar++;
            totalNominalBayar += getJumlahTagihan(item);
        }
    });

    const statBayarBulanIni = document.getElementById("stat-master-bayar-bulan-ini");
    const statNominalBulanIni = document.getElementById("stat-master-nominal-bulan-ini");

    if (statBayarBulanIni) statBayarBulanIni.innerText = `${countSudahBayar} Pelanggan`;
    if (statNominalBulanIni) statNominalBulanIni.innerText = formatIDR(totalNominalBayar);
}

// ==========================================
// 9. MODAL & FORM SUBMISSION
// ==========================================
function openModal() {
    const modal = document.getElementById("modal-form");
    const dateInput = document.getElementById("in-tanggal");
    if (modal) modal.classList.add("show");
    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
}

function closeModal() {
    const modal = document.getElementById("modal-form");
    const form = document.getElementById("transaction-form");
    if (modal) modal.classList.remove("show");
    if (form) form.reset();
}

const closeInputModal = closeModal;

function openAddModal(type) {
    const modal = document.getElementById("modal-form");
    const title = document.querySelector(".modal-header h3");
    
    const dateInput = document.getElementById("input-tanggal") || document.getElementById("in-tanggal");
    const selectKategori = document.getElementById("input-kategori") || document.getElementById("in-kategori");
    const targetSheetInput = document.getElementById("input-sheet-target") || document.getElementById("in-sheet-target");

    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    if (selectKategori) selectKategori.innerHTML = '<option value="">-- Pilih Kategori --</option>';

    let categories = [];
    let sheetTargetValue = "";

    if (type === 'pemasukan') {
        if (title) title.innerText = "Tambah Pemasukan Baru";
        sheetTargetValue = "Input Pemasukan";
        categories = (globalDataKategori.pemasukan && globalDataKategori.pemasukan.length > 0) 
            ? globalDataKategori.pemasukan 
            : [...new Set(globalIn.map(i => getCategory(i, "Pemasukan")))];
    } else if (type === 'pengeluaran') {
        if (title) title.innerText = "Tambah Pengeluaran Baru";
        sheetTargetValue = "Input Pengeluaran";
        categories = (globalDataKategori.pengeluaran && globalDataKategori.pengeluaran.length > 0) 
            ? globalDataKategori.pengeluaran 
            : [...new Set(globalOut.map(i => getCategory(i, "Pengeluaran")))];
    } else if (type === 'setoran') {
        if (title) title.innerText = "Tambah Setoran Bank";
        sheetTargetValue = "Setoran";
        categories = globalDataKategori.setoran && globalDataKategori.setoran.length > 0 
            ? globalDataKategori.setoran 
            : ["BCA", "BRI", "Mandiri", "Cash/Tunai"];
    }

    if (targetSheetInput) targetSheetInput.value = sheetTargetValue;

    if (selectKategori && categories.length > 0) {
        categories.forEach(kat => {
            if (kat && kat !== "-") {
                const option = document.createElement("option");
                option.value = kat;
                option.textContent = kat;
                selectKategori.appendChild(option);
            }
        });
    }

    if (modal) modal.classList.add("show");
}

async function submitData(event) {
    if (event) event.preventDefault();

    const getValue = (ids) => {
        for (let id of ids) {
            const el = document.getElementById(id);
            if (el && el.value) return el.value.trim();
        }
        return "";
    };

    const payload = {
        tipe: getValue(["input-sheet-target", "in-sheet-target"]),
        tanggal: getValue(["input-tanggal", "in-tanggal"]),
        kategori: getValue(["input-kategori", "in-kategori"]),
        nominal: getValue(["input-nominal", "in-nominal"]),
        keterangan: getValue(["input-keterangan", "in-keterangan"])
    };

    if (!payload.tipe) {
        alert("Gagal: Tipe target sheet tidak terdeteksi. Pastikan input hidden 'in-sheet-target' ada di HTML.");
        return;
    }

    if (!payload.kategori || !payload.nominal) {
        alert("Peringatan: Kategori dan Nominal wajib diisi!");
        return;
    }

    closeModal();

    try {
        const response = await fetch(SCRIPT_URL, {
            method: "POST",
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.status === "success" || result.result === "success") {
            alert("✅ Data berhasil disimpan ke Sheet!");
            fetchData(); 
        } else {
            alert("❌ Gagal menyimpan ke Sheet: " + (result.message || result.error || "Sheet tidak ditemukan. Pastikan nama tab di Spreadsheet sesuai."));
        }
    } catch (err) {
        console.error("Gagal simpan background:", err);
        alert("Gagal terhubung ke Google Sheets. Periksa koneksi internet.");
    }
}

// ==========================================
// 10. HELPER FUNCTIONS
// ==========================================
function populateCategoryDropdown() {
    const select = document.getElementById("category-select");
    if (!select) return;

    select.innerHTML = `<option value="ALL">Semua Kategori</option>`;
    const categories = new Set([...masterKatPemasukan, ...masterKatPengeluaran]);

    globalIn.forEach(i => categories.add(getCategory(i, "Pemasukan")));
    globalOut.forEach(i => categories.add(getCategory(i, "Pengeluaran")));

    categories.forEach(cat => {
        if (cat) {
            const opt = document.createElement("option");
            opt.value = cat;
            opt.innerText = cat;
            select.appendChild(opt);
        }
    });
}

function isExcludedSheetName(sheetName) {
    if (!sheetName) return true;
    const name = sheetName.toString().toUpperCase().trim();
    const excludedKeywords = [
        "DASHBOARD", "DASBORD", "KOORDINATOR", 
        "MASTER", "REKAP", "REKAPAN", "SUMMARY",
        "PEMASUKAN", "PENGELUARAN", "VALIDASI TRANSFER", "TRANSFER"
    ];
    return excludedKeywords.some(kw => name.includes(kw));
}

function getNominal(item) {
    if (!item || typeof item !== 'object') return 0;
    
    const priorityKeys = ["nominal", "jumlah", "total", "setor", "harga", "tagihan", "kredit", "debet", "debit", "masuk", "keluar", "bayar"];
    
    for (let key in item) {
        let lowerKey = key.toLowerCase().trim();
        for (let pKey of priorityKeys) {
            if (lowerKey.includes(pKey)) {
                let raw = item[key];
                let val = cleanToNumber(raw);
                if (val > 0) return val;
            }
        }
    }
    return 0;
}

function getCategory(item, type) {
    return item[`Kategori ${type}`] || item["Kategori"] || item["kategori"] || "Lainnya";
}

function formatIDR(val) {
    const num = Number(val) || 0;
    return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(num);
}

function formatTanggalClean(val) {
    if (!val || val === "-") return "-";
    let str = val.toString().trim();
    let d = parseToDateObj(str);

    if (!d || d.getTime() === 0) return str;

    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');

    if (hours === "00" && minutes === "00") {
        return `${day}/${month}/${year}`;
    }
    return `${day}/${month}/${year} ${hours}:${minutes}`;
}

function getJumlahTagihan(item) {
    if (!item || typeof item !== 'object') return 0;
    
    const rawVal = getValueByKeys(item, [
        "Jumlah Nominal Tagihan Pelanggan",
        "jumlah nominal tagihan pelanggan",
        "JUMLAH NOMINAL TAGIHAN PELANGGAN",
        "Jumlah Nominal Tagihan",
        "Nominal Tagihan Pelanggan",
        "tagihan",
        "Tagihan"
    ]);

    if (rawVal === undefined || rawVal === null || rawVal === "" || rawVal === "-") return 0;

    const cleaned = String(rawVal).replace(/[^0-9]/g, '');
    return parseInt(cleaned, 10) || 0;
}

function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0
    }).format(amount || 0);
}

// Parser tanggal. TIDAK lagi bergantung pada bulan berjalan (new Date()) -> hasilnya
// selalu sama kapan pun dibuka. Aturan:
//  - Date object / ISO (YYYY-MM-DD, ...T...) -> dibaca apa adanya
//  - "A/B/YYYY": kalau salah satu angka > 12, otomatis jelas mana tanggal & bulannya
//  - kalau dua-duanya <= 12 (ambigu, mis. 05/09/2026): pakai refDate (tanggal jatuh tempo)
//    dan pilih tafsiran yang paling dekat dengannya; tanpa refDate -> default DD/MM/YYYY
function parseToDateObj(str, refDate) {
    if (!str || str === "-" || str === "undefined") return null;
    if (str instanceof Date) {
        return isNaN(str.getTime()) ? null : new Date(str.getFullYear(), str.getMonth(), str.getDate());
    }

    const cleanStr = String(str).trim();

    if (cleanStr.includes("T")) {
        const d = new Date(cleanStr);
        if (!isNaN(d.getTime())) {
            return new Date(d.getFullYear(), d.getMonth(), d.getDate());
        }
    }

    const mk = (y, mo, d) => {
        const dt = new Date(y, mo - 1, d);
        return (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) ? dt : null;
    };

    // ISO tanggal saja: YYYY-MM-DD
    const iso = cleanStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (iso) return mk(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10));

    const m = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
        const p1 = parseInt(m[1], 10);
        const p2 = parseInt(m[2], 10);
        const year = parseInt(m[3], 10);

        const asDMY = mk(year, p2, p1); // p1 = tanggal, p2 = bulan
        const asMDY = mk(year, p1, p2); // p1 = bulan,   p2 = tanggal

        if (asDMY && !asMDY) return asDMY;
        if (asMDY && !asDMY) return asMDY;
        if (!asDMY && !asMDY) return null;
        if (p1 === p2) return asDMY;

        if (refDate instanceof Date && !isNaN(refDate.getTime())) {
            const jarak = (d) => Math.abs(d.getTime() - refDate.getTime());
            return jarak(asMDY) < jarak(asDMY) ? asMDY : asDMY;
        }
        return asDMY;
    }

    const d = new Date(cleanStr);
    return isNaN(d.getTime()) ? null : d;
}



// Toleransi (dalam hari) untuk metode CASH tetap dihitung "Tepat Waktu"
// Contoh: jatuh tempo tanggal 1, dibayar cash tanggal 11 (H+10) -> masih dianggap Tepat Waktu.
const TOLERANSI_HARI_CASH = 10;

// Deteksi apakah metode pembayaran termasuk kategori CASH/TUNAI
function isMetodeCash(metodeStr) {
    const m = String(metodeStr || "").trim().toLowerCase();
    return m.includes("cash") || m.includes("tunai");
}

// Ambil nama bank/e-wallet murni dari field Metode. Menangani berbagai format:
// "BCA a.n Budi Santoso", "Transfer BRI", dan "BRI - Firmansyah" (bank-nama dipisah strip/titik dua)
// -> semua disederhanakan jadi cukup "BCA" / "BRI".
function normalisasiNamaBank(metodeRaw) {
    let s = String(metodeRaw || "").trim();
    if (!s || s === "-") return "Tidak Diketahui";

    s = s.replace(/\b(a\.?n\.?|a\/n|atas\s*nama)\b[\s\S]*$/i, "").trim();
    s = s.replace(/^transfer\b\s*/i, "").trim();

    // Potong di pemisah pertama (strip/en-dash/em-dash/titik dua) — sisanya biasanya nama pelanggan
    s = s.split(/\s*[-–—:]\s*/)[0].trim();

    s = s.replace(/[\-:(),.\s]+$/g, "").trim();

    return s || "Tidak Diketahui";
}

function evalKetepatanPembayaran(jatuhTempoStr, tglBayarStr, metodeStr = "") {
    // jatuhTempoStr boleh: Date object (paling aman), string tanggal lengkap, atau angka tanggal saja ("1".."31")
    const tempoStr = (jatuhTempoStr instanceof Date) ? "" : String(jatuhTempoStr || "").trim();
    const hanyaTanggal = !(jatuhTempoStr instanceof Date) && /^\d{1,2}$/.test(tempoStr);

    let dDue = null;
    let dPaid = null;

    if (hanyaTanggal) {
        // Tidak ada info bulan/periode -> tebak jatuh tempo terdekat dari tanggal bayar
        dPaid = parseToDateObj(tglBayarStr);
        if (!dPaid) {
            return { isTelat: false, statusText: "Data Tidak Lengkap", daysDiff: 0, keterangan: "-" };
        }
        const dayTempo = parseInt(tempoStr, 10);
        const y = dPaid.getFullYear();
        const m = dPaid.getMonth();
        const buat = (bulan) => {
            const akhir = new Date(y, bulan + 1, 0).getDate();
            return new Date(y, bulan, Math.min(dayTempo, akhir));
        };
        const kandidat = [buat(m), buat(m + 1), buat(m - 1)];
        kandidat.sort((p, q) => Math.abs(dPaid - p) - Math.abs(dPaid - q));
        dDue = kandidat[0];
    } else {
        // Tanggal jatuh tempo lengkap -> baca dulu, lalu pakai sebagai acuan untuk membaca tanggal bayar
        dDue = parseToDateObj(jatuhTempoStr);
        dPaid = parseToDateObj(tglBayarStr, dDue);
        if (!dPaid) {
            return { isTelat: false, statusText: "Data Tidak Lengkap", daysDiff: 0, keterangan: "-" };
        }
    }

    if (!dDue || isNaN(dDue.getTime())) {
        return { isTelat: false, statusText: "Data Tidak Lengkap", daysDiff: 0, keterangan: "-" };
    }

    dDue.setHours(0, 0, 0, 0);
    dPaid.setHours(0, 0, 0, 0);

    const diffTime = dPaid.getTime() - dDue.getTime();
    const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

    // Selisih > 120 hari hampir pasti salah data (periode/tempo/tanggal bayar keliru), beri penanda
    const catatanCek = Math.abs(diffDays) > 120 ? " ⚠ cek data" : "";

    // Toleransi khusus CASH: telat sampai H+TOLERANSI_HARI_CASH masih dianggap Tepat Waktu
    const toleransi = isMetodeCash(metodeStr) ? TOLERANSI_HARI_CASH : 0;

    if (diffDays <= toleransi) {
        return {
            isTelat: false,
            statusText: "Tepat Waktu",
            daysDiff: Math.abs(diffDays),
            keterangan: (diffDays <= 0
                ? (diffDays === 0 ? "Pas Tanggal Tempo" : `${Math.abs(diffDays)} Hari Lebih Awal`)
                : `Tepat Waktu (Cash, H+${diffDays})`) + catatanCek
        };
    } else {
        return {
            isTelat: true,
            statusText: "Telat Bayar",
            daysDiff: diffDays,
            keterangan: `Telat ${diffDays} Hari` + catatanCek
        };
    }
}

// ==========================================
// INISIALISASI DROPDOWN FILTER TANGGAL BAYAR
// ==========================================
function initFilterTglBayar() {
    const select = document.getElementById("filter-tgl-bayar-ketepatan");
    if (!select) return;

    let optionsHTML = '<option value="ALL">Semua Tgl Bayar</option>';
    for (let i = 1; i <= 31; i++) {
        optionsHTML += `<option value="${i}">Bayar Tgl ${i}</option>`;
    }
    select.innerHTML = optionsHTML;
}

// ==========================================
// RENDER LAPORAN KETEPATAN BAYAR (KEBAL TYPO / DATA KOSONG)
// ==========================================
function renderLaporanKetepatan() {
    const searchInput = document.getElementById("search-ketepatan");
    const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const filterStatus = (document.getElementById("filter-status-ketepatan")?.value || "ALL").toUpperCase();
    const filterTempo = document.getElementById("filter-tempo-ketepatan")?.value || "ALL";
    const filterBayar = (document.getElementById("filter-bayar-ketepatan")?.value || "ALL").toUpperCase();

    let countTotalPaid = 0;
    let countTepat = 0;
    let countTelat = 0;

    let totalNominalPaid = 0;
    let totalNominalUnpaid = 0;
    let countUnpaid = 0;

    let filteredList = [];

    (globalMasterData || []).forEach(item => {
        const namaPelanggan = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA", "Pelanggan"]) || "Tanpa Nama";
        const areaSheet = getValueByKeys(item, ["area", "Area", "_sheetName", "AREA", "Wilayah"]) || "-";
        
        // 🛠️ PERBAIKAN 1: Hapus kata "tgl" dan "Bayar" generik agar tidak bentrok dengan tanggal tagihan/input
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "TGL_BAYAR", "Tgl Bayar", "TGL BAYAR"]) || "";
        const jatuhTempoRaw = getValueByKeys(item, ["tempo", "jatuhTempo", "Jatuh Tempo", "JATUH TEMPO", "JatuhTempo", "TEMPO", "JT"]);
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]) || "";
        
        const nominalClean = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;

        const jatuhTempoStr = jatuhTempoRaw !== undefined && jatuhTempoRaw !== null ? String(jatuhTempoRaw).replace(/[^0-9]/g, "").trim() : "";
        const filterTempoStr = String(filterTempo).replace(/[^0-9]/g, "").trim();

        // 1. Filter Jatuh Tempo
        if (filterTempo !== "ALL" && jatuhTempoStr !== filterTempoStr) {
            return;
        }

        // 2. Filter Search Keyword
        const tglFormatted = typeof formatTanggalClean === "function" ? formatTanggalClean(tglBayar).toLowerCase() : "";
        const rawTglStr = String(tglBayar).toLowerCase();
        
        const searchNormalized = searchTerm.replace(/\//g, "-");
        const rawNormalized = rawTglStr.replace(/\//g, "-");
        const formattedNormalized = tglFormatted.replace(/\//g, "-");

        const matchSearch = !searchTerm || 
                            namaPelanggan.toLowerCase().includes(searchTerm) || 
                            areaSheet.toLowerCase().includes(searchTerm) ||
                            rawTglStr.includes(searchTerm) || 
                            tglFormatted.includes(searchTerm) ||
                            rawNormalized.includes(searchNormalized) ||
                            formattedNormalized.includes(searchNormalized);

        if (!matchSearch) return;

        // 3. Cek Status Pembayaran (Paid vs Unpaid)
        const strTgl = String(tglBayar).trim().toLowerCase();
        const strMetode = String(metode).trim().toLowerCase();
        
        const isPaid = (strTgl !== "" && strTgl !== "-" && strTgl !== "undefined" && strTgl !== "null") || 
                       (strMetode !== "" && strMetode !== "-" && strMetode !== "undefined" && strMetode !== "null");

        // Perhitungan Akumulasi Card Ringkasan
        if (isPaid) {
            totalNominalPaid += nominalClean;
            countTotalPaid++;
        } else {
            totalNominalUnpaid += nominalClean;
            countUnpaid++;
        }

        // 🛠️ PERBAIKAN 2: Filter Pembayaran Dropdown (Kebal Variasi Value HTML)
        if ((filterBayar === "UNPAID" || filterBayar === "BELUM BAYAR" || filterBayar === "BELUM_BAYAR") && isPaid) return;
        if ((filterBayar === "PAID" || filterBayar === "SUDAH BAYAR" || filterBayar === "LUNAS") && !isPaid) return;

        // 4. Evaluasi Ketepatan Waktu
        let evalRes = { isTelat: false, statusText: "Belum Bayar", daysDiff: 0, keterangan: "Menunggu Pembayaran" };
        
        if (isPaid) {
            const jatuhTempoResolved = resolveDueDateStringForEval(item, tglBayar) || jatuhTempoRaw;
            evalRes = typeof evalKetepatanPembayaran === "function" 
                ? evalKetepatanPembayaran(jatuhTempoResolved, tglBayar, metode) 
                : { isTelat: false, statusText: "Lunas", keterangan: "Sudah Bayar" };
                
            if (evalRes.isTelat) {
                countTelat++;
            } else {
                countTepat++;
            }

            // Filter Tepat / Telat
            const matchStatus = filterStatus === "ALL" || 
                               (filterStatus === "TEPAT" && !evalRes.isTelat) || 
                               (filterStatus === "TELAT" && evalRes.isTelat);
            if (!matchStatus) return;
        } else {
            // Jika memilih filter khusus TEPAT / TELAT saat melihat data belum bayar
            if (filterStatus !== "ALL") return;
        }

        filteredList.push({
            nama: namaPelanggan,
            area: areaSheet,
            jatuhTempo: jatuhTempoStr || "-",
            tanggalBayar: isPaid ? tglBayar : "-",
            nominal: nominalClean,
            isPaid: isPaid,
            eval: evalRes
        });
    });

    // Update Dashboard Metrics UI
    const pctTepat = countTotalPaid > 0 ? Math.round((countTepat / countTotalPaid) * 100) : 0;
    const pctTelat = countTotalPaid > 0 ? Math.round((countTelat / countTotalPaid) * 100) : 0;

    if (document.getElementById("stat-ketepatan-total")) document.getElementById("stat-ketepatan-total").innerText = `${countTotalPaid} Pelanggan`;
    if (document.getElementById("stat-ketepatan-tepat")) document.getElementById("stat-ketepatan-tepat").innerText = `${countTepat} Pelanggan`;
    if (document.getElementById("stat-ketepatan-tepat-pct")) document.getElementById("stat-ketepatan-tepat-pct").innerText = `${pctTepat}% dari total bayar`;
    
    if (document.getElementById("stat-ketepatan-telat")) document.getElementById("stat-ketepatan-telat").innerText = `${countTelat} Pelanggan`;
    if (document.getElementById("stat-ketepatan-telat-pct")) document.getElementById("stat-ketepatan-telat-pct").innerText = `${pctTelat}% dari total bayar`;
    
    if (document.getElementById("stat-ketepatan-score")) document.getElementById("stat-ketepatan-score").innerText = `${pctTepat}%`;

    if (document.getElementById("stat-ketepatan-nominal-paid")) document.getElementById("stat-ketepatan-nominal-paid").innerText = typeof formatRupiah === "function" ? formatRupiah(totalNominalPaid) : totalNominalPaid;
    if (document.getElementById("stat-ketepatan-count-paid")) document.getElementById("stat-ketepatan-count-paid").innerText = `${countTotalPaid} Pelanggan Lunas`;

    if (document.getElementById("stat-ketepatan-nominal-unpaid")) document.getElementById("stat-ketepatan-nominal-unpaid").innerText = typeof formatRupiah === "function" ? formatRupiah(totalNominalUnpaid) : totalNominalUnpaid;
    if (document.getElementById("stat-ketepatan-count-unpaid")) document.getElementById("stat-ketepatan-count-unpaid").innerText = `${countUnpaid} Pelanggan Belum Bayar`;

    // Render Tabel DOM
    const tbody = document.getElementById("tbody-laporan-ketepatan");
    if (!tbody) return;

    if (filteredList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding:20px;">Tidak ada data pelanggan belum bayar yang ditemukan.</td></tr>`;
        return;
    }

    tbody.innerHTML = filteredList.map((item, idx) => {
        let badgeClass = "tag-pending";
        if (item.isPaid) {
            badgeClass = item.eval.isTelat ? "tag-out" : "tag-in";
        }

        const formattedTgl = item.isPaid && typeof formatTanggalClean === "function" 
            ? formatTanggalClean(item.tanggalBayar) 
            : "-";

        const formattedNominal = typeof formatRupiah === "function" ? formatRupiah(item.nominal) : item.nominal;

        return `
            <tr>
                <td>${idx + 1}</td>
                <td><strong>${item.nama}</strong></td>
                <td><span class="badge-tag tag-in">${item.area}</span></td>
                <td>Tgl ${item.jatuhTempo}</td>
                <td class="text-right amount-in"><strong>${formattedNominal}</strong></td>
                <td>${formattedTgl}</td>
                <td class="text-center">${item.eval.keterangan}</td>
                <td class="text-center">
                    <span class="badge-tag ${badgeClass}">${item.eval.statusText}</span>
                </td>
            </tr>
        `;
    }).join("");
}





// ==========================================================
// HALAMAN ARCHIVE (Sub Menu Laporan)
// Tab per bulan ("07 Jul 26", "08 Agu 26", dst), data dari
// Spreadsheet Archive Pembayaran Pelanggan (API_URL_ARSIP_KETEPATAN),
// dirender dalam format yang SAMA seperti Laporan Bulanan utama.
// ==========================================================

const NAMA_BULAN_ARSIP = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const NAMA_BULAN_SINGKAT_ARSIP = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function formatLabelTabArchive(bulan, tahun) {
    return `${String(bulan).padStart(2, '0')} ${NAMA_BULAN_SINGKAT_ARSIP[bulan - 1]} ${String(tahun).slice(-2)}`;
}

// Bangun 6 tab bulan terakhir (termasuk bulan berjalan), lalu otomatis muat tab paling baru
function renderArchiveTabs() {
    const bar = document.getElementById('archive-tab-bar');
    if (!bar) return;

    const now = new Date();
    const tabs = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        tabs.push({ bulan: d.getMonth() + 1, tahun: d.getFullYear() });
    }

    bar.innerHTML = tabs.map((t, idx) => {
        const aktif = idx === tabs.length - 1 ? 'active' : '';
        return `<button type="button" class="archive-tab-btn ${aktif}" onclick="pilihTabArchive(${t.bulan}, ${t.tahun}, this)">${formatLabelTabArchive(t.bulan, t.tahun)}</button>`;
    }).join("");

    const tabTerakhir = tabs[tabs.length - 1];
    fetchArsipUntukArchive(tabTerakhir.bulan, tabTerakhir.tahun);
}

function pilihTabArchive(bulan, tahun, btnEl) {
    document.querySelectorAll('.archive-tab-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    fetchArsipUntukArchive(bulan, tahun);
}

async function fetchArsipUntukArchive(bulan, tahun) {
    const isi = document.getElementById("isi-laporan-archive");
    const judul = document.getElementById("judul-laporan-archive");
    if (judul) judul.textContent = `Laporan Bulanan — ${NAMA_BULAN_ARSIP[bulan - 1]} ${tahun}`;

    if (API_URL_ARSIP_KETEPATAN.includes("GANTI_DENGAN_URL")) {
        if (isi) isi.innerHTML = `<p class="text-center" style="padding:20px; color:#dc2626;">URL API Arsip belum diisi. Buka app.js, cari <code>API_URL_ARSIP_KETEPATAN</code>, lalu ganti dengan URL Web App hasil deploy .gs Anda.</p>`;
        return;
    }

    if (isi) isi.innerHTML = `<p class="text-center cell-loading" style="padding:20px 0;">Memuat data arsip ${NAMA_BULAN_ARSIP[bulan - 1]} ${tahun}...</p>`;

    try {
        const res = await fetch(`${API_URL_ARSIP_KETEPATAN}?bulan=${bulan}&tahun=${tahun}`);
        const json = await res.json();

        if (json.status !== "success") {
            if (isi) isi.innerHTML = `<p class="text-center" style="padding:20px; color:#dc2626;">${json.message || "Gagal memuat data arsip."}</p>`;
            globalArsipKetepatan = [];
            return;
        }

        globalArsipKetepatan = json.data || [];
        renderLaporanArchiveBulanan(bulan, tahun);
    } catch (err) {
        if (isi) isi.innerHTML = `<p class="text-center" style="padding:20px; color:#dc2626;">Gagal menghubungi server arsip: ${err.message}</p>`;
    }
}

// Susun laporan bulanan dari data arsip, PERSIS format visual yang sama dengan
// renderLaporanPeriode() versi Bulanan (rowMain/rowCategory) — Pemasukan dari arsip,
// Pengeluaran tetap dari globalOutAll (data pengeluaran memang sudah historis/lintas bulan).
function renderLaporanArchiveBulanan(bulan, tahun) {
    const isi = document.getElementById('isi-laporan-archive');
    if (!isi) return;

    if (!globalArsipKetepatan || globalArsipKetepatan.length === 0) {
        isi.innerHTML = `<p class="text-center" style="padding:20px;">Tidak ada data arsip pada bulan ini.</p>`;
        return;
    }

    const formatRp = num => 'Rp ' + Number(num || 0).toLocaleString('id-ID');
    const rowMain = (label, value) => `
        <div class="lap-line lap-line-main">
            <span class="lap-label">${label}</span>
            <span class="lap-leader"></span>
            <span class="lap-value">${value}</span>
        </div>`;
    const rowCategory = (label, value) => `
        <div class="lap-line lap-line-category">
            <span class="lap-label">${label}</span>
            <span class="lap-leader"></span>
            <span class="lap-value">${value}</span>
        </div>`;

    // ===== 1. PEMASUKAN — dari data arsip pembayaran pelanggan =====
    let totalTagihanRutin = 0, countBayarTepatWaktu = 0, totalPelangganAktif = 0;
    let totalPiutangBelumBayar = 0, countPiutangBelumBayar = 0;
    const piutangBelumBayarList = [];

    globalArsipKetepatan.forEach(item => {
        const nama = item["Nama Pelanggan"] || "Tanpa Nama";
        const area = item["Area Sheet"] || item["Area Pelanggan"] || "-";
        const jatuhTempo = item["Tanggal Jatuh Tempo"] !== undefined ? item["Tanggal Jatuh Tempo"] : "-";
        const nominal = parseFloat(item["Jumlah Tagihan"]) || 0;
        const tglBayar = item["Tanggal Pembayaran"] || "";
        const metode = item["Metode Pembayaran"] || "";
        const statusBayar = String(item["Status Pembayaran"] || "").toLowerCase();
        const isPaid = statusBayar.includes("sudah");

        totalPelangganAktif++;
        if (isPaid) {
            totalTagihanRutin += nominal;
            const evalRes = typeof evalKetepatanPembayaran === "function"
                ? evalKetepatanPembayaran(jatuhTempo, tglBayar, metode)
                : { isTelat: false };
            if (!evalRes.isTelat) countBayarTepatWaktu++;
        } else {
            totalPiutangBelumBayar += nominal;
            countPiutangBelumBayar++;
            piutangBelumBayarList.push({ nama, area, nominal });
        }
    });

    const totalPemasukan = totalTagihanRutin;

    // ===== 2. PENGELUARAN — dari globalOutAll, difilter ke bulan/tahun arsip yang dipilih =====
    let totalPengeluaran = 0;
    const katPengeluaran = {};
    let totalReimbursement = 0;
    const katReimbursement = {};
    let totalOperasional = 0, totalGajiKaryawan = 0, totalPengadaanBarang = 0;
    const detailOperasional = {}, detailGajiKaryawan = {}, detailPengadaanBarang = {};

    const isInBulanArchive = (d) => d && !isNaN(d.getTime()) && d.getFullYear() === tahun && (d.getMonth() + 1) === bulan;

    (globalOutAll || []).forEach(item => {
        const rawTgl = getValueByKeys(item, ["Tanggal", "tanggal", "TANGGAL", "Tgl", "tgl"]) || item[0] || "";
        const d = parseToDateObjPengeluaranALL(rawTgl);
        if (!isInBulanArchive(d)) return;

        let rawNominal = getValueByKeys(item, ["Nominal", "nominal", "NOMINAL", "Jumlah", "jumlah", "JUMLAH", "Total", "total", "Pengeluaran", "pengeluaran", "Debet", "debet", "Kredit", "kredit"]);
        if ((rawNominal === "" || rawNominal === undefined || rawNominal === null) && typeof getNominal === 'function') {
            rawNominal = getNominal(item);
        }
        const nominal = typeof cleanToNumber === 'function' ? cleanToNumber(rawNominal) : (Number(rawNominal) || 0);

        const category = getValueByKeys(item, ["Kategori", "kategori", "KATEGORI", "Kategori Pengeluaran", "Jenis", "Jenis Pengeluaran"]) || item[1] || "Lain-lain";
        const keterangan = getValueByKeys(item, ["Keterangan", "keterangan", "KETERANGAN", "Catatan", "catatan", "Uraian", "uraian"]) || "";

        totalPengeluaran += nominal;
        katPengeluaran[category] = (katPengeluaran[category] || 0) + nominal;

        if (matchKeyword(category, KEYWORDS_REIMBURSEMENT) || matchKeyword(keterangan, KEYWORDS_REIMBURSEMENT)) {
            totalReimbursement += nominal;
            katReimbursement[category] = (katReimbursement[category] || 0) + nominal;
        }

        const gabunganTeks = (category + " " + keterangan).toLowerCase();
        const labelItem = (keterangan && String(keterangan).trim() !== "" && String(keterangan).trim() !== "-") ? keterangan : category;
        if (gabunganTeks.includes('gaji') || gabunganTeks.includes('karyawan') || gabunganTeks.includes('payroll')) {
            totalGajiKaryawan += nominal;
            detailGajiKaryawan[labelItem] = (detailGajiKaryawan[labelItem] || 0) + nominal;
        } else if (gabunganTeks.includes('pengadaan') || gabunganTeks.includes('aset') || gabunganTeks.includes('peralatan') || gabunganTeks.includes('material') || gabunganTeks.includes('barang')) {
            totalPengadaanBarang += nominal;
            detailPengadaanBarang[labelItem] = (detailPengadaanBarang[labelItem] || 0) + nominal;
        } else if (gabunganTeks.includes('operasional')) {
            totalOperasional += nominal;
            detailOperasional[labelItem] = (detailOperasional[labelItem] || 0) + nominal;
        }
    });

    const selisih = totalPemasukan - totalPengeluaran;
    const labelBulanTahun = `${NAMA_BULAN_ARSIP[bulan - 1]} ${tahun}`;
    const persenTepatWaktu = totalPelangganAktif > 0
        ? ((countBayarTepatWaktu / totalPelangganAktif) * 100).toFixed(2).replace('.', ',')
        : '0';

    // ===== SUSUN TAMPILAN — format & urutan sama persis dengan Laporan Bulanan utama =====
    let html = '';
    html += rowMain('Bulan / Tahun', labelBulanTahun);

    html += rowMain('Total Pemasukan Bulan Ini', formatRp(totalPemasukan));
    html += rowCategory('Tagihan Rutin Pelanggan (Arsip)', formatRp(totalTagihanRutin));

    html += rowMain('Total Pengeluaran Bulan Ini', formatRp(totalPengeluaran));
    if (Object.keys(katPengeluaran).length === 0) {
        html += rowCategory('Tidak ada rincian pengeluaran', '-');
    } else {
        for (const [kat, total] of Object.entries(katPengeluaran)) {
            html += rowCategory(kat, formatRp(total));
        }
    }

    html += rowMain('Laba / Rugi Bulan Ini', formatRp(selisih));
    html += rowMain('Persentase Tagihan Terbayar Tepat Waktu', totalPelangganAktif > 0 ? `${persenTepatWaktu}% ( ${countBayarTepatWaktu} dari ${totalPelangganAktif} pelanggan )` : '-');

    html += rowMain('Total Piutang Belum Terbayar Akhir Bulan', countPiutangBelumBayar > 0 ? `${formatRp(totalPiutangBelumBayar)} ( ${countPiutangBelumBayar} pelanggan )` : '-');
    piutangBelumBayarList.forEach(p => {
        html += rowCategory(`${p.nama} (${p.area})`, formatRp(p.nominal));
    });

    html += rowMain('Total Pengeluaran Operasional', totalOperasional > 0 ? formatRp(totalOperasional) : '-');
    for (const [label, total] of Object.entries(detailOperasional)) html += rowCategory(label, formatRp(total));

    html += rowMain('Total Pengeluaran Gaji Karyawan', totalGajiKaryawan > 0 ? formatRp(totalGajiKaryawan) : '-');
    for (const [label, total] of Object.entries(detailGajiKaryawan)) html += rowCategory(label, formatRp(total));

    html += rowMain('Total Pengeluaran Pengadaan Barang', totalPengadaanBarang > 0 ? formatRp(totalPengadaanBarang) : '-');
    for (const [label, total] of Object.entries(detailPengadaanBarang)) html += rowCategory(label, formatRp(total));

    html += rowMain('Total Reimbursement Yang Diproses', totalReimbursement > 0 ? formatRp(totalReimbursement) : '-');
    for (const [kat, total] of Object.entries(katReimbursement)) html += rowCategory(kat, formatRp(total));

    isi.innerHTML = html;
}

function initFilterTempo() {
    const select = document.getElementById("filter-tempo-ketepatan");
    if (!select) return;

    let optionsHTML = '<option value="ALL">Semua Tanggal Tempo</option>';
    for (let i = 1; i <= 31; i++) {
        optionsHTML += `<option value="${i}">Tempo Tgl ${i}</option>`;
    }
    select.innerHTML = optionsHTML;
}

function getNominalMasterPelanggan(item) {
    if (!item || typeof item !== 'object') return 0;
    
    const rawVal = getValueByKeys(item, [
        "tagihan", "Tagihan", "TAGIHAN", "Jumlah Tagihan", "JUMLAH TAGIHAN",
        "nominal", "Nominal", "NOMINAL", "jumlah", "Jumlah", "JUMLAH",
        "bayar", "Bayar", "BAYAR", "tarif", "Tarif", "biaya", "Biaya", "harga", "Harga"
    ]);

    if (rawVal !== "" && rawVal !== null && rawVal !== undefined) {
        if (typeof rawVal === 'number') return rawVal;
        const cleaned = String(rawVal).replace(/[^0-9]/g, '');
        const parsed = parseFloat(cleaned);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    return getJumlahTagihan(item) || getNominal(item) || 0;
}

function cleanToNumber(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;
    if (typeof raw === "number") return raw;

    let str = String(raw).trim();

    if (str.includes(",")) {
        str = str.split(",")[0];
    }

    let cleaned = str.replace(/[^0-9]/g, "");
    let parsed = parseInt(cleaned, 10);
    return isNaN(parsed) ? 0 : parsed;
}


// ==========================================
// PARSER KHUSUS PENGELUARAN ALL (ISOLATED)
// ==========================================
function parseToDateObjPengeluaranALL(str) {
    if (!str || str === "-" || str === "undefined") return null;
    if (str instanceof Date) return str;
    const cleanStr = String(str).trim();

    // 1. Parse ISO (YYYY-MM-DD) / Date string
    let d = new Date(cleanStr);
    if (!isNaN(d.getTime())) return d;

    // 2. Parse format DD/MM/YYYY atau DD-MM-YYYY
    const delimiter = cleanStr.includes("/") ? "/" : (cleanStr.includes("-") ? "-" : "");
    if (delimiter) {
        const parts = cleanStr.split(" ")[0].split(delimiter);
        if (parts.length === 3) {
            let day, month, year;
            if (parts[0].length === 4) { // YYYY-MM-DD
                year = parseInt(parts[0], 10);
                month = parseInt(parts[1], 10) - 1;
                day = parseInt(parts[2], 10);
            } else { // DD/MM/YYYY
                day = parseInt(parts[0], 10);
                month = parseInt(parts[1], 10) - 1;
                year = parseInt(parts[2], 10);
            }
            if (year < 100) year += 2000;
            if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                return new Date(year, month, day);
            }
        }
    }
    return null;
}


// Helper Parser Tanggal Fleksibel
function parseFlexDate(dateVal) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return dateVal;
    
    const str = String(dateVal).trim();
    const matchDMY = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (matchDMY) {
        return new Date(parseInt(matchDMY[3]), parseInt(matchDMY[2]) - 1, parseInt(matchDMY[1]));
    }
    
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}
// Perbaikan tanggal bayar yang ambigu (misal "9/12/2026" bisa berarti 9 Desember
// ATAU 12 September). Kalau hasil baca awal (asumsi DD/MM/YYYY) bulannya tidak
// cocok dengan bulan jatuh tempo (expectedMonth/expectedYear), coba tukar posisi
// tanggal & bulan; kalau versi tukar itu cocok, dipakai versi yang ditukar.
function parseFlexDateSmart(dateVal, expectedMonth, expectedYear) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return dateVal;

    const str = String(dateVal).trim();
    const matchDMY = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (matchDMY) {
        const a = parseInt(matchDMY[1], 10); // asumsi tanggal
        const b = parseInt(matchDMY[2], 10); // asumsi bulan
        const y = parseInt(matchDMY[3], 10);

        const naive = new Date(y, b - 1, a);
        const naiveCocok = (naive.getFullYear() === expectedYear && naive.getMonth() + 1 === expectedMonth);

        if (!naiveCocok && a <= 12 && b <= 31) {
            const swapped = new Date(y, a - 1, b);
            const swappedCocok = (swapped.getFullYear() === expectedYear && swapped.getMonth() + 1 === expectedMonth);
            if (swappedCocok) return swapped;
        }
        return naive;
    }

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

// Helper Baca Properti JSON (Abaikan Kapitalisasi Key)
function getProp(obj, keys, defaultVal = '') {
    if (!obj) return defaultVal;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
            return obj[k];
        }
    }
    return defaultVal;
}

// Helper: ubah field "periode" (nama bulan Indonesia) + "tempo" (tanggal jatuh tempo)
// menjadi objek Date lengkap. refYear dipakai karena field periode tidak menyertakan tahun.
const BULAN_INDO_MAP = {
    'JANUARI': 1, 'FEBRUARI': 2, 'MARET': 3, 'APRIL': 4, 'MEI': 5, 'JUNI': 6,
    'JULI': 7, 'AGUSTUS': 8, 'SEPTEMBER': 9, 'OKTOBER': 10, 'NOVEMBER': 11, 'DESEMBER': 12
};
function getJatuhTempoDate(item, refYear) {
    const periodeRaw = getValueByKeys(item, ["periode", "Periode", "PERIODE"]) || "";
    const tempoRaw = getValueByKeys(item, ["tempo", "jatuhTempo", "Jatuh Tempo", "JATUH TEMPO", "JatuhTempo", "TEMPO", "JT"]) || "";

    const bulanNum = BULAN_INDO_MAP[String(periodeRaw).trim().toUpperCase()];
    const dayNum = parseInt(String(tempoRaw).replace(/[^0-9]/g, ""), 10);

    if (!bulanNum || isNaN(dayNum)) return null;
    const akhirBulan = new Date(refYear, bulanNum, 0).getDate(); // tempo tgl 31 di bulan 30 hari -> tgl 30
    return new Date(refYear, bulanNum - 1, Math.min(dayNum, akhirBulan));
}

// Ubah (periode + tempo) suatu item jadi tanggal jatuh tempo lengkap (objek Date).
// Dikembalikan sebagai Date, BUKAN string "DD/MM/YYYY", supaya tidak dibaca ulang dan
// tertukar tanggal/bulannya (tempo tgl 1 Oktober dulu terbaca 10 Januari).
// Tahun dipilih (tahun bayar -1 / 0 / +1) yang jatuh temponya paling dekat dengan tanggal bayar,
// jadi periode Desember yang dibayar Januari, atau periode Januari yang dibayar Desember, tetap benar.
function resolveDueDateStringForEval(item, tglBayarStr) {
    if (typeof getJatuhTempoDate !== "function") return null;
    const paidDate = parseToDateObj(tglBayarStr);
    const baseYear = paidDate ? paidDate.getFullYear() : new Date().getFullYear();

    let terbaik = null;
    [baseYear - 1, baseYear, baseYear + 1].forEach(th => {
        const due = getJatuhTempoDate(item, th);
        if (!due || isNaN(due.getTime())) return;
        if (!terbaik) { terbaik = due; return; }
        if (!paidDate) return;
        if (Math.abs(paidDate - due) < Math.abs(paidDate - terbaik)) terbaik = due;
    });
    return terbaik;
}

// Fungsi Utama Render Laporan Sesuai Format Dokumen
// ==========================================
// KATA KUNCI KATEGORI (SESUAIKAN DENGAN NAMA KATEGORI DI SHEET "Input Pengeluaran ALL")
// ==========================================
// Kata kunci untuk mendeteksi "Tagihan Rutin" operasional pokok (bensin, listrik, air, dll)
const KEYWORDS_TAGIHAN_RUTIN = ['bensin', 'listrik', 'pln', 'air', 'pdam', 'wifi', 'internet', 'token'];
// Kata kunci untuk mendeteksi item Reimbursement
const KEYWORDS_REIMBURSEMENT = ['reimburse', 'reimbursement', 'penggantian'];

function matchKeyword(text, keywords) {
    const t = String(text || "").toLowerCase();
    return keywords.some(k => t.includes(k));
}

// Menentukan tanggal jatuh tempo pelanggan relatif terhadap bulan/tahun laporan yang dipilih.
// Jika data punya field "periode" (nama bulan) yang valid, dipakai untuk menentukan bulan jatuh tempo asli
// (berguna untuk piutang yang jatuh temponya di bulan sebelumnya). Jika tidak ada, diasumsikan
// jatuh tempo ada di bulan/tahun laporan yang sedang dipilih (tagihan bulanan rutin).
function resolveDueDateForLaporan(item, tahunLaporan, bulanLaporanFallback) {
    const tempoRaw = getValueByKeys(item, ["tempo", "jatuhTempo", "Jatuh Tempo", "JATUH TEMPO", "JatuhTempo", "TEMPO", "JT"]);
    const dayNum = parseInt(String(tempoRaw || "").replace(/[^0-9]/g, ""), 10);
    if (!dayNum) return null;

    const periodeRaw = getValueByKeys(item, ["periode", "Periode", "PERIODE"]);
    let bulanNum = BULAN_INDO_MAP[String(periodeRaw || "").trim().toUpperCase()];
    if (!bulanNum) bulanNum = bulanLaporanFallback;

    const lastDayOfThatMonth = new Date(tahunLaporan, bulanNum, 0).getDate();
    const safeDay = Math.min(dayNum, lastDayOfThatMonth);
    return new Date(tahunLaporan, bulanNum - 1, safeDay);
}

function renderLaporanPeriode() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const bulan = parseInt(document.getElementById('filter-bulan-laporan')?.value || (today.getMonth() + 1));
    const tahun = parseInt(document.getElementById('filter-tahun-laporan')?.value || today.getFullYear());
    const mingguVal = document.getElementById('filter-minggu-laporan')?.value || 'all';
    const isi = document.getElementById('isi-laporan-periode');

    if (!isi) return;

    // Menentukan Rentang Tanggal berdasarkan Pilihan Minggu ("all" = satu bulan penuh / laporan bulanan)
    let startDay = 1, endDay = 31;
    let periodeText = `Bulanan / Seluruh Tanggal 1 s/d 31`;
    if (mingguVal === '1') { startDay = 1; endDay = 7; periodeText = `Minggu ke-1 / Tanggal ${startDay} s/d ${endDay}`; }
    else if (mingguVal === '2') { startDay = 8; endDay = 14; periodeText = `Minggu ke-2 / Tanggal ${startDay} s/d ${endDay}`; }
    else if (mingguVal === '3') { startDay = 15; endDay = 21; periodeText = `Minggu ke-3 / Tanggal ${startDay} s/d ${endDay}`; }
    else if (mingguVal === '4') { startDay = 22; endDay = 28; periodeText = `Minggu ke-4 / Tanggal ${startDay} s/d ${endDay}`; }
    else if (mingguVal === '5') { startDay = 29; endDay = 31; periodeText = `Minggu ke-5 / Tanggal ${startDay} s/d ${endDay}`; }

    const lastDayOfMonth = new Date(tahun, bulan, 0).getDate();
    const startDayActual = Math.min(startDay, lastDayOfMonth);
    const endDayActual = Math.min(endDay, lastDayOfMonth);
    const periodStartDate = new Date(tahun, bulan - 1, startDayActual, 0, 0, 0, 0);
    const periodEndDate = new Date(tahun, bulan - 1, endDayActual, 23, 59, 59, 999);

    const formatRp = num => 'Rp ' + Number(num || 0).toLocaleString('id-ID');

    // Helper cek apakah tanggal jatuh di bulan/tahun/rentang minggu yang dipilih (dipakai untuk Pengeluaran)
    const isInPeriode = (d) => {
        if (!d || isNaN(d.getTime())) return false;
        const isYear = d.getFullYear() === tahun;
        const isMonth = (d.getMonth() + 1) === bulan;
        const day = d.getDate();
        const isWeek = day >= startDayActual && day <= endDayActual;
        return isYear && isMonth && isWeek;
    };

    // ==========================================
    // 1. PEMASUKAN — Tagihan Rutin & Piutang Terbayar (dari globalMasterData)
    // ==========================================
    let totalTagihanRutin = 0, countTagihanRutin = 0;
    let totalPiutangLunas = 0, countPiutangLunas = 0;
    let totalPiutangBelumBayar = 0, countPiutangBelumBayar = 0;
    let totalPelangganAktif = 0;
    let countBayarTepatWaktu = 0;
    let piutangH7List = [];
    let piutangBelumBayarList = [];

    (globalMasterData || []).forEach(item => {
        const namaPelanggan = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA", "Pelanggan"]) || "Tanpa Nama";
        const areaSheet = getValueByKeys(item, ["area", "Area", "_sheetName", "AREA", "Wilayah"]) || "-";
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "TGL_BAYAR", "Tgl Bayar", "TGL BAYAR"]) || "";
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]) || "";
        const tempoRaw = getValueByKeys(item, ["tempo", "jatuhTempo", "Jatuh Tempo", "JATUH TEMPO", "JatuhTempo", "TEMPO", "JT"]);
        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;

        const dueDateOwn = resolveDueDateForLaporan(item, tahun, bulan);
        if (!dueDateOwn) return; // Data tanpa jatuh tempo valid, dilewati

        const strTgl = String(tglBayar).trim().toLowerCase();
        const strMetode = String(metode).trim().toLowerCase();
        const isPaid = (strTgl !== "" && strTgl !== "-" && strTgl !== "undefined" && strTgl !== "null") ||
                       (strMetode !== "" && strMetode !== "-" && strMetode !== "undefined" && strMetode !== "null");
        const paidDate = isPaid ? parseFlexDateSmart(tglBayar, dueDateOwn.getMonth() + 1, dueDateOwn.getFullYear()) : null;

        const dueDay = dueDateOwn.getDate();
        const dueInSelectedMonth = dueDateOwn.getFullYear() === tahun && (dueDateOwn.getMonth() + 1) === bulan;
        const dueInSelectedWeek = dueDay >= startDayActual && dueDay <= endDayActual;
        const dueInPeriod = dueInSelectedMonth && dueInSelectedWeek;

        if (dueInPeriod) {
            totalPelangganAktif++;
            const paidWithinPeriodEnd = isPaid && paidDate && paidDate <= periodEndDate;

            if (paidWithinPeriodEnd) {
                // Tagihan rutin periode ini, sudah dibayar (baik lebih awal, tepat waktu, atau telat tapi masih dalam periode ini)
                totalTagihanRutin += nominal;
                countTagihanRutin++;

                const dueDateOwnStr = `${String(dueDateOwn.getDate()).padStart(2, '0')}/${String(dueDateOwn.getMonth() + 1).padStart(2, '0')}/${dueDateOwn.getFullYear()}`;
                const evalRes = typeof evalKetepatanPembayaran === "function"
                    ? evalKetepatanPembayaran(dueDateOwnStr, tglBayar, metode)
                    : { isTelat: false };
                if (!evalRes.isTelat) countBayarTepatWaktu++;
            } else {
                // Belum dibayar sampai akhir periode ini (piutang belum terbayar utk periode ini)
                totalPiutangBelumBayar += nominal;
                countPiutangBelumBayar++;
                piutangBelumBayarList.push({ nama: namaPelanggan, area: areaSheet, nominal });

                // Eskalasi H+7: hanya untuk yang MASIH benar-benar belum bayar hari ini
                if (!isPaid) {
                    const daysOverdueToday = Math.floor((today - dueDateOwn) / 86400000);
                    if (daysOverdueToday > 7) {
                        piutangH7List.push({ nama: namaPelanggan, area: areaSheet, nominal, daysOverdueToday });
                    }
                }
            }
        } else if (isPaid && paidDate && paidDate >= periodStartDate && paidDate <= periodEndDate && dueDateOwn < periodStartDate) {
            // Piutang dari periode sebelumnya, baru dilunasi pada periode yang sedang dilihat ini
            totalPiutangLunas += nominal;
            countPiutangLunas++;
        }
    });

    const totalPemasukan = totalTagihanRutin + totalPiutangLunas;

    // ==========================================
    // 2. PENGELUARAN — dari globalOutAll (termasuk sub-rincian Tagihan Rutin & Reimbursement)
    // ==========================================
    let totalPengeluaran = 0;
    const katPengeluaran = {};

    let totalRutinDibayar = 0;
    const katRutinDibayar = {};

    let totalReimbursement = 0;
    const katReimbursement = {};

    // Rincian per-item (bukan per-kategori) khusus untuk format laporan Bulanan
    let totalOperasional = 0, totalGajiKaryawan = 0, totalPengadaanBarang = 0;
    const detailOperasional = {}, detailGajiKaryawan = {}, detailPengadaanBarang = {};

    (globalOutAll || []).forEach(item => {
        const rawTgl = getValueByKeys(item, ["Tanggal", "tanggal", "TANGGAL", "Tgl", "tgl"]) || item[0] || "";
        const d = parseToDateObjPengeluaranALL(rawTgl);
        if (!isInPeriode(d)) return;

        let rawNominal = getValueByKeys(item, ["Nominal", "nominal", "NOMINAL", "Jumlah", "jumlah", "JUMLAH", "Total", "total", "Pengeluaran", "pengeluaran", "Debet", "debet", "Kredit", "kredit"]);
        if ((rawNominal === "" || rawNominal === undefined || rawNominal === null) && typeof getNominal === 'function') {
            rawNominal = getNominal(item);
        }
        const nominal = typeof cleanToNumber === 'function' ? cleanToNumber(rawNominal) : (Number(rawNominal) || 0);

        const category = getValueByKeys(item, ["Kategori", "kategori", "KATEGORI", "Kategori Pengeluaran", "Jenis", "Jenis Pengeluaran"]) || item[1] || "Lain-lain";
        const keterangan = getValueByKeys(item, ["Keterangan", "keterangan", "KETERANGAN", "Catatan", "catatan", "Uraian", "uraian"]) || "";

        totalPengeluaran += nominal;
        katPengeluaran[category] = (katPengeluaran[category] || 0) + nominal;

        // Sub-rincian: Tagihan Rutin Operasional (bensin, listrik, air, dll)
        if (matchKeyword(category, KEYWORDS_TAGIHAN_RUTIN) || matchKeyword(keterangan, KEYWORDS_TAGIHAN_RUTIN)) {
            totalRutinDibayar += nominal;
            katRutinDibayar[category] = (katRutinDibayar[category] || 0) + nominal;
        }

        // Sub-rincian: Reimbursement
        if (matchKeyword(category, KEYWORDS_REIMBURSEMENT) || matchKeyword(keterangan, KEYWORDS_REIMBURSEMENT)) {
            totalReimbursement += nominal;
            katReimbursement[category] = (katReimbursement[category] || 0) + nominal;
        }

        // Rincian per-item untuk format laporan Bulanan (Operasional / Gaji Karyawan / Pengadaan Barang)
        const gabunganTeks = (category + " " + keterangan).toLowerCase();
        const labelItem = (keterangan && String(keterangan).trim() !== "" && String(keterangan).trim() !== "-") ? keterangan : category;
        if (gabunganTeks.includes('gaji') || gabunganTeks.includes('karyawan') || gabunganTeks.includes('payroll')) {
            totalGajiKaryawan += nominal;
            detailGajiKaryawan[labelItem] = (detailGajiKaryawan[labelItem] || 0) + nominal;
        } else if (gabunganTeks.includes('pengadaan') || gabunganTeks.includes('aset') || gabunganTeks.includes('peralatan') || gabunganTeks.includes('material') || gabunganTeks.includes('barang')) {
            totalPengadaanBarang += nominal;
            detailPengadaanBarang[labelItem] = (detailPengadaanBarang[labelItem] || 0) + nominal;
        } else if (gabunganTeks.includes('operasional')) {
            totalOperasional += nominal;
            detailOperasional[labelItem] = (detailOperasional[labelItem] || 0) + nominal;
        }
    });

    const selisih = totalPemasukan - totalPengeluaran;
    const labelPeriode = mingguVal === 'all' ? 'Bulan Ini' : 'Minggu Ini';
    const isBulananView = mingguVal === 'all';

    // ==========================================
    // MENYUSUN BARIS LIST (gaya sama seperti Laporan Cash Harian: label — leader titik — nilai)
    // ==========================================
    let html = '';

    // Baris KOMPONEN UTAMA — bold, dengan tint latar tipis sebagai pembeda antar section
    const rowMain = (label, value) => `
        <div class="lap-line lap-line-main">
            <span class="lap-label">${label}</span>
            <span class="lap-leader"></span>
            <span class="lap-value">${value}</span>
        </div>`;

    // Baris RINCIAN / KATEGORI — polos, sedikit indentasi
    const rowCategory = (label, value) => `
        <div class="lap-line lap-line-category">
            <span class="lap-label">${label}</span>
            <span class="lap-leader"></span>
            <span class="lap-value">${value}</span>
        </div>`;

    if (isBulananView) {
        // ==========================================
        // FORMAT LAPORAN BULANAN (sesuai format kantor, tata letak sama seperti mingguan)
        // ==========================================
        const NAMA_BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
        const labelBulanTahun = `${NAMA_BULAN[bulan - 1]} ${tahun}`;

        const persenTepatWaktu = totalPelangganAktif > 0
            ? ((countBayarTepatWaktu / totalPelangganAktif) * 100).toFixed(2).replace('.', ',')
            : '0';

        // 1. Bulan / Tahun
        html += rowMain('Bulan / Tahun', labelBulanTahun);

        // 2. Total Pemasukan Bulan Ini + rincian (sama seperti mingguan)
        html += rowMain('Total Pemasukan Bulan Ini', formatRp(totalPemasukan));
        html += rowCategory('Tagihan Rutin Pelanggan', formatRp(totalTagihanRutin));
        html += rowCategory('Tagihan Piutang Bulan Lalu', countPiutangLunas > 0 ? `${countPiutangLunas} pelanggan, total ${formatRp(totalPiutangLunas)}` : '-');

        // 3. Total Pengeluaran Bulan Ini + rincian PER KATEGORI (semua kategori, sama seperti mingguan)
        html += rowMain('Total Pengeluaran Bulan Ini', formatRp(totalPengeluaran));
        if (Object.keys(katPengeluaran).length === 0) {
            html += rowCategory('Tidak ada rincian pengeluaran', '-');
        } else {
            for (const [kat, total] of Object.entries(katPengeluaran)) {
                html += rowCategory(kat, formatRp(total));
            }
        }

        // 4. Laba / Rugi Bulan Ini
        html += rowMain('Laba / Rugi Bulan Ini', formatRp(selisih));

        // 5. Persentase Tagihan Terbayar Tepat Waktu
        html += rowMain('Persentase Tagihan Terbayar Tepat Waktu', totalPelangganAktif > 0 ? `${persenTepatWaktu}% ( ${countBayarTepatWaktu} dari ${totalPelangganAktif} pelanggan )` : '-');

        // 6. Total Piutang Belum Terbayar Akhir Bulan + rincian nama pelanggan
        html += rowMain('Total Piutang Belum Terbayar Akhir Bulan', countPiutangBelumBayar > 0 ? `${formatRp(totalPiutangBelumBayar)} ( ${countPiutangBelumBayar} pelanggan )` : '-');
        if (piutangBelumBayarList.length > 0) {
            piutangBelumBayarList.forEach(p => {
                html += rowCategory(`${p.nama} (${p.area})`, formatRp(p.nominal));
            });
        }

        // 7. Total Pengeluaran Operasional + rincian per item
        html += rowMain('Total Pengeluaran Operasional', totalOperasional > 0 ? formatRp(totalOperasional) : '-');
        for (const [label, total] of Object.entries(detailOperasional)) {
            html += rowCategory(label, formatRp(total));
        }

        // 8. Total Pengeluaran Gaji Karyawan + rincian per item
        html += rowMain('Total Pengeluaran Gaji Karyawan', totalGajiKaryawan > 0 ? formatRp(totalGajiKaryawan) : '-');
        for (const [label, total] of Object.entries(detailGajiKaryawan)) {
            html += rowCategory(label, formatRp(total));
        }

        // 9. Total Pengeluaran Pengadaan Barang + rincian per item
        html += rowMain('Total Pengeluaran Pengadaan Barang', totalPengadaanBarang > 0 ? formatRp(totalPengadaanBarang) : '-');
        for (const [label, total] of Object.entries(detailPengadaanBarang)) {
            html += rowCategory(label, formatRp(total));
        }

        // 10. Total Reimbursement Yang Diproses + rincian per item
        html += rowMain('Total Reimbursement Yang Diproses', totalReimbursement > 0 ? formatRp(totalReimbursement) : '-');
        for (const [kat, total] of Object.entries(katReimbursement)) {
            html += rowCategory(kat, formatRp(total));
        }

        // 11. Cashflow Akhir Bulan (Saldo) — belum ada sumber data saldo awal
        html += rowMain('Cashflow Akhir Bulan (Saldo)', '-');

        // 12. Anggaran vs Realisasi — Budget belum ada sumber data, Realisasi diisi otomatis
        html += rowMain('Anggaran vs Realisasi', `Budget: - | Realisasi: ${formatRp(totalPengeluaran)} | Selisih: -`);

        // 13. Rekomendasi / Catatan Untuk Owner — manual
        html += rowMain('Rekomendasi / Catatan Untuk Owner', '-');

        const judulElB = document.getElementById('judul-laporan-periode');
        if (judulElB) judulElB.textContent = `Laporan Bulanan — ${labelBulanTahun}`;

        lastLaporanPeriodeSummary = {
            isBulananView: true,
            periodeLabel: labelBulanTahun,
            totalPemasukan, totalPengeluaran, selisih,
            persenTepatWaktu, countBayarTepatWaktu, totalPelangganAktif,
            countPiutangBelumBayar, totalPiutangBelumBayar
        };

        isi.innerHTML = html;
        return;
    }

    // ==========================================
    // FORMAT LAPORAN MINGGUAN (format lama, tidak diubah)
    // ==========================================

    html += rowMain('Periode Laporan', periodeText);

    // 2. Total Pemasukan
    html += rowMain(`Total Pemasukan ${labelPeriode}`, formatRp(totalPemasukan));
    html += rowCategory('Tagihan Rutin Pelanggan', formatRp(totalTagihanRutin));
    html += rowCategory('Tagihan Piutang Minggu Lalu', `${countPiutangLunas} pelanggan, total ${formatRp(totalPiutangLunas)}`);

    // 3. Total Pengeluaran
    html += rowMain(`Total Pengeluaran ${labelPeriode}`, formatRp(totalPengeluaran));
    if (Object.keys(katPengeluaran).length === 0) {
        html += rowCategory('Tidak ada rincian pengeluaran', 'Rp 0');
    } else {
        for (const [kat, total] of Object.entries(katPengeluaran)) {
            html += rowCategory(kat, formatRp(total));
        }
    }

    // 4. Selisih (Surplus / Defisit)
    html += rowMain('Selisih (Surplus / Defisit)', formatRp(selisih));

    // 5. Jumlah Pelanggan Bayar Tepat Waktu
    html += rowMain('Jumlah Pelanggan Bayar Tepat Waktu', `${countBayarTepatWaktu} dari ${totalPelangganAktif} pelanggan aktif`);

    // 6. Jumlah Piutang Belum Terbayar
    html += rowMain('Jumlah Piutang Belum Terbayar', `${countPiutangBelumBayar} pelanggan, total ${formatRp(totalPiutangBelumBayar)}`);

    // 7. Piutang > H+7 (perlu eskalasi owner) — daftar nama sebagai rincian
    if (piutangH7List.length === 0) {
        html += rowMain('Piutang > H+7 (perlu eskalasi owner)', '-');
    } else {
        html += rowMain('Piutang > H+7 (perlu eskalasi owner)', '');
        piutangH7List
            .sort((a, b) => b.daysOverdueToday - a.daysOverdueToday)
            .forEach(p => {
                html += rowCategory(`${p.nama} (${p.area}) — Telat ${p.daysOverdueToday} hari`, formatRp(p.nominal));
            });
    }

    // 8. Tagihan Rutin Yang Dibayar Minggu Ini
    html += rowMain('Tagihan Rutin Yang Dibayar Minggu Ini', formatRp(totalRutinDibayar));
    if (Object.keys(katRutinDibayar).length > 0) {
        for (const [kat, total] of Object.entries(katRutinDibayar)) {
            html += rowCategory(kat, formatRp(total));
        }
    }

    // 9. Reimbursement Yang Diproses
    html += rowMain('Reimbursement Yang Diproses', formatRp(totalReimbursement));
    if (Object.keys(katReimbursement).length > 0) {
        for (const [kat, total] of Object.entries(katReimbursement)) {
            html += rowCategory(kat, formatRp(total));
        }
    }

    // 10. Catatan / Temuan Penting (belum ada sumber data otomatis)
    html += rowMain('Catatan / Temuan Penting', '-');

    const judulElM = document.getElementById('judul-laporan-periode');
    if (judulElM) judulElM.textContent = `Laporan Mingguan — ${periodeText}`;

    lastLaporanPeriodeSummary = {
        isBulananView: false,
        periodeLabel: periodeText,
        totalPemasukan, totalPengeluaran, selisih,
        countBayarTepatWaktu, totalPelangganAktif,
        countPiutangBelumBayar, totalPiutangBelumBayar
    };

    isi.innerHTML = html;
}

// Susun ringkasan singkat Laporan Mingguan/Bulanan (tanpa rincian kategori) lalu salin ke clipboard, siap kirim ke grup WA
async function salinLaporanPeriodeKeWA() {
    const r = lastLaporanPeriodeSummary;
    if (!r) { alert("Laporan belum dimuat. Silakan tunggu data selesai dimuat lalu coba lagi."); return; }

    const lines = [];
    lines.push(`RINGKASAN LAPORAN ${r.isBulananView ? 'BULANAN' : 'MINGGUAN'}`);
    lines.push(`Periode: ${r.periodeLabel}`);
    lines.push("");
    lines.push(`Pemasukan: ${formatRpWA(r.totalPemasukan)}`);
    lines.push(`Pengeluaran: ${formatRpWA(r.totalPengeluaran)}`);
    lines.push(`${r.isBulananView ? 'Laba/Rugi' : 'Selisih'}: ${formatRpWA(r.selisih)}`);
    lines.push("");
    lines.push(`Pelanggan bayar tepat waktu: ${r.countBayarTepatWaktu} dari ${r.totalPelangganAktif}`);
    lines.push(`Piutang belum terbayar: ${r.countPiutangBelumBayar} pelanggan, total ${formatRpWA(r.totalPiutangBelumBayar)}`);

    const text = lines.join("\n");

    try {
        await navigator.clipboard.writeText(text);
        alert("Ringkasan berhasil disalin! Tinggal paste ke grup WhatsApp.");
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); alert("Ringkasan berhasil disalin! Tinggal paste ke grup WhatsApp."); }
        catch (e2) { alert("Gagal menyalin otomatis. Silakan salin manual dari kotak berikut:\n\n" + text); }
        document.body.removeChild(ta);
    }
}


// ==========================================
// LOGIKA FILTER PENGELUARAN ALL
// ==========================================
function filterPengeluaranALL() {
    const filterBulan = document.getElementById("filter-bulan-pengeluaran-all")?.value || "";
    const filterTanggal = document.getElementById("filter-tanggal-pengeluaran-all")?.value || "";

    let filtered = globalOutAll.filter(item => {
        const rawTgl = getValueByKeys(item, ["Tanggal", "tanggal", "TANGGAL", "Tgl", "tgl"]) || item[0] || "";
        
        // Memakai parser khusus agar tidak menyenggol data lain
        const dObj = parseToDateObjPengeluaranALL(rawTgl);

        if (!dObj || isNaN(dObj.getTime())) return false;

        const year = dObj.getFullYear();
        const month = String(dObj.getMonth() + 1).padStart(2, '0');
        const day = String(dObj.getDate()).padStart(2, '0');

        const itemYYYYMM = `${year}-${month}`;
        const itemYYYYMMDD = `${year}-${month}-${day}`;

        if (filterTanggal !== "") {
            return itemYYYYMMDD === filterTanggal;
        }

        if (filterBulan !== "") {
            return itemYYYYMM === filterBulan;
        }

        return true;
    });

    renderSheetPengeluaranALL(filtered);
}





// ==========================================
// 11. GLOBAL EXPORTS & EVENT LISTENERS
// ==========================================
// ==========================================
// DEBUG SEMENTARA: Cek selisih Antrean vs Laporan Bulanan
// (boleh dihapus lagi setelah masalah ketemu)
// ==========================================
function debugSelisihLaporan() {
    const today = new Date();
    const bulan = parseInt(document.getElementById('filter-bulan-laporan')?.value || (today.getMonth() + 1));
    const tahun = parseInt(document.getElementById('filter-tahun-laporan')?.value || today.getFullYear());

    let totalAntrean = 0, totalMasukLaporan = 0;
    let noTempo = [], bedaBulan = [], gagalParseTglBayar = [];

    (globalMasterData || []).forEach(item => {
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "TGL_BAYAR", "Tgl Bayar", "TGL BAYAR"]);
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        const isACC = item.status === true || item.status === "true" || item.status === "TRUE";
        const isPaid = (tglBayar && tglBayar !== "-") || (metode && metode !== "-");
        if (!isPaid || isACC) return; // sama seperti isi Daftar Antrean

        const nominal = getNominalMasterPelanggan(item);
        const nama = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA"]) || "Tanpa Nama";
        totalAntrean += nominal;

        const dueDateOwn = resolveDueDateForLaporan(item, tahun, bulan);
        if (!dueDateOwn) {
            noTempo.push({ nama, nominal, periode: getValueByKeys(item, ["periode", "Periode", "PERIODE"]), tempo: getValueByKeys(item, ["tempo", "jatuhTempo", "Jatuh Tempo", "TEMPO"]) });
            return;
        }

        const dueInSelectedMonth = dueDateOwn.getFullYear() === tahun && (dueDateOwn.getMonth() + 1) === bulan;
        if (!dueInSelectedMonth) {
            bedaBulan.push({ nama, nominal, tempoBulan: dueDateOwn.getMonth() + 1, tempoTahun: dueDateOwn.getFullYear(), periodeAsli: getValueByKeys(item, ["periode", "Periode", "PERIODE"]) });
            return;
        }

        const paidDate = parseFlexDate(tglBayar);
        if (!paidDate) {
            gagalParseTglBayar.push({ nama, nominal, tglBayarRaw: tglBayar });
            return;
        }

        totalMasukLaporan += nominal;
    });

    console.log("=== DIAGNOSA SELISIH ANTREAN vs LAPORAN BULANAN ===");
    console.log("Bulan/Tahun laporan yang dicek:", bulan + "/" + tahun);
    console.log("Total di Daftar Antrean (belum ACC):", "Rp " + totalAntrean.toLocaleString('id-ID'));
    console.log("Yang cocok masuk Laporan Bulanan ini:", "Rp " + totalMasukLaporan.toLocaleString('id-ID'));
    console.log("--- 1) Tidak ada tanggal jatuh tempo valid ---", "Rp " + noTempo.reduce((s, i) => s + i.nominal, 0).toLocaleString('id-ID'));
    console.table(noTempo);
    console.log("--- 2) Jatuh tempo di bulan/tahun lain ---", "Rp " + bedaBulan.reduce((s, i) => s + i.nominal, 0).toLocaleString('id-ID'));
    console.table(bedaBulan);
    console.log("--- 3) Tanggal bayar gagal dibaca sistem ---", "Rp " + gagalParseTglBayar.reduce((s, i) => s + i.nominal, 0).toLocaleString('id-ID'));
    console.table(gagalParseTglBayar);
}



window.navigateTo = navigateTo;
window.debugSelisihLaporan = debugSelisihLaporan;
window.toggleSidebar = toggleSidebar;
window.handleSort = handleSort;
window.changePage = changePage;
window.handleFilter = handleFilter;
window.changePageTransfer = changePageTransfer;
window.handleFilterTransfer = handleFilterTransfer;
window.filterCategoryTrend = filterCategoryTrend;
window.openAddModal = openAddModal;
window.closeInputModal = closeInputModal;
window.closeModal = closeModal;
window.openModal = openModal;
window.submitData = submitData;
window.submitValidation = submitValidation;
window.renderLaporanKetepatan = renderLaporanKetepatan;
window.renderSheetPengeluaranALL = renderSheetPengeluaranALL;
window.resetFilterPengeluaranALL = resetFilterPengeluaranALL;
window.renderLaporanPeriode = renderLaporanPeriode; // <-- TAMBAHAN EXPORT
window.renderArchiveTabs = renderArchiveTabs;
window.renderRekapBank = renderRekapBank;
window.setPeriodeRekapBank = setPeriodeRekapBank;
window.salinRekapBankKeWA = salinRekapBankKeWA;
window.setSubPeriodeCashflow = setSubPeriodeCashflow;
window.renderLaporanHarianCashflow = renderLaporanHarianCashflow;
window.salinLaporanHarianCashflowKeWA = salinLaporanHarianCashflowKeWA;
window.pilihTabArchive = pilihTabArchive;

window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.handleParentMenuClick = handleParentMenuClick;
window.cycleTheme = cycleTheme;

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    try { checkSession(); } catch (e) { showLogin(); }
    initFilterTempo();
    fetchData();
});
