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
let globalMasterSumber = ''; // asal Master Data: 'Master Data' (API Validasi) atau '⚠ API Cashflow' (fallback) — ditampilkan di kartu Pemasukan Cashflow
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
        globalMasterSumber = 'Master Data';
        processMasterData(dataValidasi);
        return true;
    } else if (typeof dataValidasi === 'object') {
        globalTransfer = dataValidasi.validasiTransfer || dataValidasi.transfer || [];
        const dariValidasi = dataValidasi.masterData || dataValidasi.data || dataValidasi.pelanggan;
        const masterSource = dariValidasi || (dataTransaksi && dataTransaksi.masterData);
        // Penanda sumber: kalau API Validasi tidak membawa Master Data, kode jatuh ke data script Cashflow (fallback lama)
        globalMasterSumber = dariValidasi ? 'Master Data' : (masterSource ? '⚠ API Cashflow' : '');
        if (masterSource) {
            if (!dariValidasi) console.warn('[Master Data] API_URL_VALIDASI tidak punya kunci masterData/data/pelanggan — memakai masterData dari API_URL_TRANSAKSI (Cashflow). Kunci yang ada:', Object.keys(dataValidasi));
            processMasterData(masterSource);
        }
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
        refreshCashflowViews();
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
    resetLoginForm();
}

// Tampilkan / sembunyikan password (ikon mata di kolom password)
function togglePasswordVisibility() {
    const input = document.getElementById('login-password');
    const btn = document.getElementById('btn-toggle-password');
    if (!input || !btn) return;
    const tampil = input.type === 'password';
    input.type = tampil ? 'text' : 'password';
    btn.classList.toggle('is-visible', tampil);
    btn.setAttribute('aria-pressed', tampil ? 'true' : 'false');
    btn.setAttribute('aria-label', tampil ? 'Sembunyikan password' : 'Tampilkan password');
    btn.title = tampil ? 'Sembunyikan password' : 'Tampilkan password';
    input.focus();
}

// Kembalikan form login ke keadaan awal (dipanggil saat halaman login ditampilkan lagi)
function resetLoginForm() {
    const input = document.getElementById('login-password');
    const btn = document.getElementById('btn-toggle-password');
    const errEl = document.getElementById('login-error');
    if (input) { input.type = 'password'; input.value = ''; }
    if (btn) {
        btn.classList.remove('is-visible');
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Tampilkan password');
        btn.title = 'Tampilkan password';
    }
    if (errEl) { errEl.innerText = ''; errEl.dataset.kind = ''; }
    _loginThemePicked = false; // login berikutnya wajib memilih tema lagi
    const themeBox = document.getElementById('login-theme');
    if (themeBox) themeBox.classList.remove('needs-pick');
    if (typeof syncThemeExtras === 'function') syncThemeExtras();
}

function loginReduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function handleLogin(event) {
    if (event) event.preventDefault();
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const username = (usernameEl.value || '').trim();
    const password = passwordEl.value || '';
    const errEl = document.getElementById('login-error');
    const box = document.querySelector('#login-page .login-box');
    const btn = document.querySelector('#login-form .btn-login');
    if (btn && btn.disabled) return false; // sedang transisi masuk, cegah klik ganda

    // Tema wajib dipilih dulu sebelum masuk
    if (!_loginThemePicked) {
        if (errEl) { errEl.innerText = 'Pilih tema tampilan terlebih dahulu.'; errEl.dataset.kind = 'theme'; }
        const themeBox = document.getElementById('login-theme');
        if (themeBox) {
            themeBox.classList.add('needs-pick');
            const firstCard = themeBox.querySelector('.login-theme-card');
            if (firstCard) firstCard.focus();
        }
        if (box && box.animate && !loginReduceMotion()) {
            box.animate(
                [{ transform: 'translateX(0)' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
                { duration: 420, easing: 'ease-in-out' }
            );
        }
        return false;
    }

    if (username === LOGIN_CREDENTIALS.username && password === LOGIN_CREDENTIALS.password) {
        _sessionMemory = true;
        safeStorageSet('cashflow_logged_in', 'true');
        if (errEl) errEl.innerText = '';

        const selesai = function () { showApp(); resetLoginForm(); if (btn) btn.disabled = false; };
        if (box && box.animate && !loginReduceMotion()) {
            // Kartu login menguap ke atas sebentar sebelum dashboard tampil
            if (btn) btn.disabled = true;
            const anim = box.animate(
                [{ opacity: 1, transform: 'translateY(0) scale(1, 1)' }, { opacity: 0, transform: 'translateY(-14px) scale(0.96, 1.04)' }],
                { duration: 300, easing: 'ease-in', fill: 'forwards' }
            );
            anim.onfinish = function () { selesai(); anim.cancel(); };
        } else {
            selesai();
        }
    } else {
        if (errEl) errEl.innerText = 'Username atau password salah.';
        // Kartu bergetar sebagai penanda salah (Web Animations API, tidak bentrok dengan animasi CSS)
        if (box && box.animate && !loginReduceMotion()) {
            box.animate(
                [{ transform: 'translateX(0)' }, { transform: 'translateX(-9px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
                { duration: 420, easing: 'ease-in-out' }
            );
        }
        passwordEl.focus();
        passwordEl.select();
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
// TEMA TAMPILAN — 5 pilihan: light (Terang) · reference (Referensi) · dark (Gelap netral)
//   · biru (palet biru #03195b → #cbe9fd, terang) · hijau (palet hijau #051F20 → #DAF1DE, gelap)
// ==========================================
const THEMES = ['light', 'reference', 'dark', 'biru', 'hijau'];
const DARK_THEMES = ['dark', 'hijau'];
let _loginThemePicked = false; // tema harus dipilih eksplisit setiap kali login

function applyTheme(themeName) {
    if (THEMES.indexOf(themeName) === -1) themeName = 'light';
    document.body.setAttribute('data-theme', themeName);
    try { localStorage.setItem('cashflow_theme', themeName); } catch (e) { /* storage diblokir, abaikan */ }
    document.querySelectorAll('.theme-option').forEach(function (btn) {
        const on = btn.dataset.themeValue === themeName;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    syncThemeExtras();
}

// Sinkronkan UI pemilih tema di halaman login
function syncThemeExtras() {
    const current = document.body.getAttribute('data-theme');
    document.querySelectorAll('.login-theme-card').forEach(function (btn) {
        const on = _loginThemePicked && btn.dataset.loginTheme === current;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
}

// Dipanggil saat user memilih tema di halaman login
function pickLoginTheme(name) {
    _loginThemePicked = true;
    applyTheme(name);
    const box = document.getElementById('login-theme');
    if (box) box.classList.remove('needs-pick');
    const errEl = document.getElementById('login-error');
    if (errEl && errEl.dataset.kind === 'theme') { errEl.innerText = ''; errEl.dataset.kind = ''; }
    if (typeof refreshChartsTheme === 'function') refreshChartsTheme();
}

function setTheme(themeName) {
    applyTheme(themeName);
    closeThemeMenu();
    if (typeof refreshChartsTheme === 'function') refreshChartsTheme();
}

// Dipertahankan agar pemanggil lama tetap valid: berpindah ke tema berikutnya
function cycleTheme() {
    const current = document.body.getAttribute('data-theme') || 'light';
    setTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
}

function toggleThemeMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('theme-menu');
    const btn = document.getElementById('btn-theme-toggle');
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

function closeThemeMenu() {
    const menu = document.getElementById('theme-menu');
    const btn = document.getElementById('btn-theme-toggle');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function (e) {
    if (!e.target.closest('.theme-switcher')) closeThemeMenu();
});
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeThemeMenu();
});

function initTheme() {
    let saved = 'light';
    try { saved = localStorage.getItem('cashflow_theme') || 'light'; } catch (e) { /* abaikan */ }
    if (saved === 'dark-glass') saved = 'dark'; // migrasi nama tema lama
    if (saved === 'cartoon') saved = 'biru';      // tema Neoabstrak dihapus -> Biru
    if (saved === 'minecraft') saved = 'hijau';   // tema Minecraft dihapus -> Hijau
    if (saved === 'midnight' || saved === 'crystal') saved = 'biru';
    applyTheme(saved);
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
                <td class="td-category" title="${escHtml(getCategory(item, item._type))}">${getCategory(item, item._type)}</td>
                <td title="${escHtml(keterangan)}">${keterangan}</td>
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
        const d = getTanggalBayarAktual(item);
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

const NAMA_BULAN_PANJANG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const KEYS_TGL_BAYAR = ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "TGL_BAYAR", "Tgl Bayar", "TGL BAYAR"];

// Kunci kolom tanggal bayar yang dikenali Laporan Harian & Rekap Bank.
// = KEYS_TGL_BAYAR + "tgl" (kolom "tgl" juga dipakai Antrean Validasi). Sebelumnya laporan hanya membaca 3 nama kolom,
// padahal daftar "sudah bayar" (getPaidMasterEntries) memakai 6 nama. Akibatnya pembayaran yang tanggalnya ada di
// kolom lain (mis. "Tgl Bayar"/"tgl") lolos ke daftar bayar tetapi DIBUANG saat difilter per tanggal -> tidak tercatat.
const KEYS_TGL_BAYAR_LAPORAN = [...KEYS_TGL_BAYAR, "tgl", "Tgl", "TGL"];

// Tanggal bayar sebuah baris pelanggan (Date lokal, jam 00:00) atau null bila kosong / tidak terbaca.
// Format ambigu (5/9 vs 9/5) dibaca dengan acuan jatuh tempo, sama seperti dashboard Cashflow.
function getTanggalBayarAktual(item) {
    const raw = getValueByKeys(item, KEYS_TGL_BAYAR_LAPORAN);
    if (!raw || raw === "-" || raw === "undefined" || raw === "null") return null;
    try {
        const t = getTanggalPeriodeCashflow(item);
        if (t && t.paid && !isNaN(t.paid.getTime())) return t.paid;
    } catch (e) { /* jatuh ke pembaca tanggal biasa di bawah */ }
    return parseToDateObj(raw);
}

// Menentukan BULAN sebuah pembayaran untuk dashboard Cashflow.
//  - Bayar LEBIH AWAL dari jatuh tempo (mis. tempo 1 Okt, bayar 29 Sep) -> ikut bulan jatuh tempo (Okt),
//    sama seperti Laporan Periode yang menghitung tagihan di periode jatuh temponya.
//  - Bayar tepat waktu / telat -> ikut tanggal bayar (uang diterima di bulan itu).
// Tanggal bayar dibaca dengan acuan tanggal jatuh tempo, sehingga format ambigu (5/9 vs 9/5)
// dipilih yang paling dekat dengan jatuh tempo dan tidak tertukar lagi.
// Mengembalikan null bila tanggal bayar kosong / tidak terbaca.
function getTanggalPeriodeCashflow(item) {
    const tglRaw = getValueByKeys(item, KEYS_TGL_BAYAR);
    const s = String(tglRaw === undefined || tglRaw === null ? "" : tglRaw).trim();
    if (s === "" || s === "-" || s === "undefined" || s === "null") return null;

    // Tanggal bayar "A/B/YYYY" yang ambigu (dua-duanya <= 12) punya 2 tafsiran: DD/MM dan MM/DD.
    // Pilih PASANGAN (tanggal bayar, jatuh tempo) yang paling dekat jaraknya, sekaligus menentukan
    // tahun jatuh tempo (periode+tempo tidak membawa tahun). Tanpa periode/tempo -> DD/MM.
    const kandidatBayar = [];
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
        const p1 = parseInt(m[1], 10), p2 = parseInt(m[2], 10), y = parseInt(m[3], 10);
        const mk = (yy, mo, dd) => { const dt = new Date(yy, mo - 1, dd); return (dt.getFullYear() === yy && dt.getMonth() === mo - 1 && dt.getDate() === dd) ? dt : null; };
        const dmy = mk(y, p2, p1), mdy = mk(y, p1, p2);
        if (dmy) kandidatBayar.push(dmy);
        if (mdy && p1 !== p2) kandidatBayar.push(mdy);
    } else {
        const one = parseToDateObj(tglRaw);
        if (one && !isNaN(one.getTime())) kandidatBayar.push(one);
    }
    if (kandidatBayar.length === 0) return null;

    const tahunUji = new Set();
    kandidatBayar.forEach(p => [p.getFullYear() - 1, p.getFullYear(), p.getFullYear() + 1].forEach(t => tahunUji.add(t)));
    const kandidatTempo = [];
    if (typeof getJatuhTempoDate === "function") {
        tahunUji.forEach(t => { const dd = getJatuhTempoDate(item, t); if (dd && !isNaN(dd.getTime())) kandidatTempo.push(dd); });
    }

    let paid = kandidatBayar[0], due = null, jarak = Infinity;
    kandidatBayar.forEach(p => kandidatTempo.forEach(dd => {
        const sc = Math.abs(p - dd);
        if (sc < jarak) { jarak = sc; paid = p; due = dd; }
    }));

    // Selisih > 120 hari hampir pasti salah data (periode/tempo keliru): jangan dipakai untuk memindah bulan
    if (due && Math.abs(paid - due) / 86400000 > 120) due = null;

    const efektif = (due && paid < due) ? due : paid;
    const dipindah = efektif.getFullYear() !== paid.getFullYear() || efektif.getMonth() !== paid.getMonth();
    return { tglRaw, paid, due, efektif, dipindah };
}

// Sumber pengeluaran untuk mode Cashflow: HANYA tab/sheet "Pengeluaran ALL" (globalOutAll) —
// sama persis dengan halaman Pengeluaran ALL & Laporan Cashflow. Pengeluaran kas (globalOut) tidak dipakai.
function getPengeluaranCashflowEntries() {
    const src = globalOutAll || [];
    const hasil = [];
    src.forEach(item => {
        const rawTgl = getValueByKeys(item, ["Tanggal", "tanggal", "TANGGAL", "Tgl", "tgl"]) || item[0] || "";
        const d = parseToDateObjPengeluaranALL(rawTgl);
        if (!d || isNaN(d.getTime())) return;

        let rawNominal = getValueByKeys(item, ["Nominal", "nominal", "NOMINAL", "Jumlah", "jumlah", "JUMLAH", "Total", "total", "Pengeluaran", "pengeluaran", "Debet", "debet", "Kredit", "kredit"]);
        if ((rawNominal === "" || rawNominal === undefined || rawNominal === null) && typeof getNominal === 'function') {
            rawNominal = getNominal(item);
        }
        const nominal = typeof cleanToNumber === 'function' ? cleanToNumber(rawNominal) : (Number(rawNominal) || 0);
        const kategori = getValueByKeys(item, ["Kategori", "kategori", "KATEGORI", "Kategori Pengeluaran", "Jenis", "Jenis Pengeluaran"]) || item[1] || "Lain-lain";
        let keterangan = getValueByKeys(item, [
            "Keterangan", "keterangan", "KETERANGAN", "Catatan", "catatan", "CATATAN",
            "Keterangan/Catatan", "Keterangan / Catatan", "Uraian", "uraian", "Rincian", "Detail", "Deskripsi"
        ]);
        if (!keterangan || keterangan === "-") keterangan = item[4] || item[5] || item[6] || "";
        hasil.push({ d, tgl: rawTgl, nominal, kategori, keterangan });
    });
    return hasil;
}

function getCashflowSelectedMonth() {
    const el = document.getElementById('filter-bulan-cashflow-chart');
    let v = el && el.value ? el.value : '';
    if (!v) {
        const now = new Date();
        v = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    const [y, m] = v.split('-').map(Number);
    return { y, m };
}

// Satu sumber data untuk seluruh dashboard Cashflow: pemasukan (pembayaran pelanggan) dan
// pengeluaran, dua-duanya dipotong ke bulan yang dipilih di filter (default: bulan ini).
// Pemasukan masuk ke bulan jatuh tempo bila dibayar lebih awal (lihat getTanggalPeriodeCashflow).
// ----------------------------------------------------------
// PEMASUKAN KODE 002 (kasbon / piutang dll) — dari sheet Input Pemasukan (globalIn).
// Kategori di sheet diberi kode: 001 = pemasukan biasa, 002 = kasbon dll.
// Kode dideteksi di mana pun posisinya di teks kategori ("002", "002 - Kasbon", "Kasbon (002)", dst).
// Dulu entri ini hanya muncul di mode Cash; sekarang ikut masuk ke Dashboard & Laporan Cashflow.
// ----------------------------------------------------------
const KODE_KATEGORI_KASBON = '002';

function isKategoriKode002(teksKategori) {
    return new RegExp('(^|[^0-9])' + KODE_KATEGORI_KASBON + '([^0-9]|$)').test(String(teksKategori || ''));
}

function getPemasukanKasbonEntries() {
    const hasil = [];
    (globalIn || []).forEach(item => {
        const kategori = getCategory(item, 'Pemasukan');
        if (!isKategoriKode002(kategori)) return;
        const d = getItemDate(item);
        if (!d || isNaN(d.getTime())) return;
        // Utamakan kolom nominal yang eksplisit; getNominal() hanya cadangan (sudah melewati kolom kategori/kode)
        const nominalEksplisit = cleanToNumber(getValueByKeys(item, ["Nominal", "nominal", "NOMINAL", "Jumlah", "jumlah", "JUMLAH", "Total", "total"]));
        const nominal = nominalEksplisit > 0 ? nominalEksplisit : getNominal(item);
        const keterangan = getValueByKeys(item, [
            "Keterangan/Catatan", "Keterangan / Catatan", "Keterangan", "keterangan", "KETERANGAN",
            "Catatan", "catatan", "CATATAN", "Uraian", "uraian", "Rincian", "Detail", "Deskripsi"
        ]);
        const tgl = item["Tanggal"] || item["tgl"] || item["TANGGAL"] || item["Tanggal Transaksi"] || "";
        hasil.push({ d, tgl, nominal, kategori, keterangan: keterangan || "" });
    });
    return hasil;
}

function getCashflowDashboardData() {
    const allPaid = getPaidMasterEntries();
    const allOut = getPengeluaranCashflowEntries();
    const allKasbon = getPemasukanKasbonEntries();
    sesuaikanBulanCashflow(allPaid, allOut.concat(allKasbon));
    const { y, m } = getCashflowSelectedMonth();
    const inMonth = d => d && !isNaN(d.getTime()) && d.getFullYear() === y && (d.getMonth() + 1) === m;

    const paid = [];
    let cash = 0, transfer = 0;
    allPaid.forEach(item => {
        const t = getTanggalPeriodeCashflow(item);
        if (!t || !inMonth(t.efektif)) return;
        const nominal = typeof getNominalMasterPelanggan === "function" ? getNominalMasterPelanggan(item) : 0;
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]) || "";
        const isCash = isMetodeCash(metode);
        if (isCash) cash += nominal; else transfer += nominal;
        // d = tanggal untuk pengelompokan/urutan (efektif); tgl = tanggal bayar asli untuk ditampilkan
        paid.push({ item, d: t.efektif, tgl: t.tglRaw, tglBayar: t.paid, due: t.due, dipindah: t.dipindah, nominal, metode, isCash });
    });

    // Pemasukan kode 002 (kasbon dll) dari data Cash -> dihitung sebagai pemasukan tunai.
    // Dibungkus seperti baris pembayaran pelanggan supaya grafik, tabel & daftar area ikut terisi.
    let totalKasbon = 0, countKasbon = 0;
    allKasbon.forEach(e => {
        if (!inMonth(e.d)) return;
        cash += e.nominal;
        totalKasbon += e.nominal;
        countKasbon++;
        const label = e.keterangan && e.keterangan !== "-" ? e.keterangan : e.kategori;
        paid.push({
            item: { nama: label, area: e.kategori }, d: e.d, tgl: e.tgl, tglBayar: e.d, due: null, dipindah: false,
            nominal: e.nominal, metode: 'Kasbon', isCash: true, isKasbon: true
        });
    });

    const keluar = allOut.filter(e => inMonth(e.d));
    const totalKeluar = keluar.reduce((sum, e) => sum + e.nominal, 0);
    const totalMasuk = cash + transfer;
    return { y, m, paid, keluar, cash, transfer, totalKasbon, countKasbon, totalMasuk, totalKeluar, saldo: totalMasuk - totalKeluar };
}

function renderCashflowDashboard() {
    const data = getCashflowDashboardData();

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('cf-stat-pemasukan', formatIDR(data.totalMasuk));
    setText('cf-stat-pemasukan-desc', (data.paid.length - data.countKasbon).toLocaleString('id-ID') + ' pembayaran' + (data.countKasbon ? ' + ' + data.countKasbon + ' kasbon (002)' : '') + (globalMasterSumber ? ' · ' + globalMasterSumber : ''));
    setText('cf-stat-pengeluaran', formatIDR(data.totalKeluar));
    setText('cf-stat-pengeluaran-desc', (!globalOutAll || globalOutAll.length === 0)
        ? 'Data Pengeluaran ALL belum termuat'
        : data.keluar.length.toLocaleString('id-ID') + ' transaksi · Pengeluaran ALL');
    setText('cf-stat-saldo', formatIDR(data.saldo));
    setText('cf-stat-nominal-cash', formatIDR(data.cash));
    setText('cf-stat-nominal-transfer', formatIDR(data.transfer));
    setText('cf-periode-label', 'Pemasukan vs pengeluaran · ' + NAMA_BULAN_PANJANG[data.m - 1] + ' ' + data.y);

    renderCashflowDashboardChart(data);

    const tbody = document.getElementById('tbody-cashflow-dashboard');
    if (!tbody) return;

    // Gabungkan pembayaran masuk + pengeluaran, ambil 5 terbaru
    const gabungan = [
        ...data.paid.map(p => ({ jenis: 'masuk', d: p.d, tgl: p.tgl, nominal: p.nominal, p })),
        ...data.keluar.map(e => ({ jenis: 'keluar', d: e.d, tgl: e.tgl, nominal: e.nominal, e }))
    ].sort((a, b) => b.d.getTime() - a.d.getTime()).slice(0, 5);

    if (gabungan.length === 0) {
        const dataBelumMasuk = (!globalMasterData || globalMasterData.length === 0) && data.keluar.length === 0;
        tbody.innerHTML = `<tr><td colspan="5" class="text-center">${dataBelumMasuk
            ? 'Data belum termuat dari server. Tunggu sebentar atau muat ulang halaman (Ctrl+F5).'
            : 'Belum ada pembayaran maupun pengeluaran di bulan ini'}</td></tr>`;
        return;
    }

    tbody.innerHTML = gabungan.map(row => {
        if (row.jenis === 'masuk') {
            const it = row.p.item;
            const nama = getValueByKeys(it, ["nama", "Nama Pelanggan", "Nama", "NAMA"]) || "Tanpa Nama";
            const area = getValueByKeys(it, ["area", "Area", "_sheetName", "AREA"]) || "-";
            const metode = row.p.metode || "-";
            return `
            <tr>
                <td>${formatTanggalClean(row.tgl || "-")}</td>
                <td><span class="badge-tag ${row.p.isCash ? 'tag-in' : 'tag-transfer'}">${escHtml(row.p.isKasbon ? 'Kasbon' : (row.p.isCash ? 'Cash' : (metode !== '-' ? metode : 'Transfer')))}</span></td>
                <td title="${escHtml(nama)}"><strong>${escHtml(nama)}</strong>${row.p.dipindah && row.p.due ? `<small style="display:block;font-weight:400;font-size:11px;color:var(--text-muted);">Masuk ${NAMA_BULAN_PANJANG[row.p.due.getMonth()]} (tempo ${String(row.p.due.getDate()).padStart(2, '0')}/${String(row.p.due.getMonth() + 1).padStart(2, '0')})</small>` : ''}</td>
                <td title="${escHtml(area)}">${escHtml(area)}</td>
                <td class="text-right amount-in"><strong>+${formatIDR(row.nominal)}</strong></td>
            </tr>`;
        }
        const e = row.e;
        const ket = e.keterangan && String(e.keterangan).trim() !== '' && String(e.keterangan).trim() !== '-' ? e.keterangan : e.kategori;
        return `
            <tr>
                <td>${formatTanggalClean(row.tgl || "-")}</td>
                <td><span class="badge-tag tag-out">Pengeluaran</span></td>
                <td title="${escHtml(ket)}"><strong>${escHtml(ket)}</strong></td>
                <td title="${escHtml(e.kategori)}">${escHtml(e.kategori)}</td>
                <td class="text-right amount-out"><strong>-${formatIDR(row.nominal)}</strong></td>
            </tr>`;
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
        const d = getTanggalBayarAktual(item);
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

        <div style="margin-top: 12px; font-weight: 700; color: var(--success-text);">Pemasukan</div>
        ${cash.pemasukanHariIni.length ? cash.pemasukanHariIni.map(i => listItem(i, true)).join("") : '<div class="text-muted" style="padding:4px 0;">Tidak ada pemasukan</div>'}
        <div style="display:flex; justify-content:space-between; padding: 6px 0; border-top: 1px dashed var(--border-subtle); font-weight: 700;">
            <span>Total Masuk</span><span class="amount-in">${formatRpWA(cash.totalPemasukan)}</span>
        </div>

        <div style="margin-top: 14px; font-weight: 700; color: var(--danger-text);">Pengeluaran</div>
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
            <div style="font-weight: 700; color: var(--success-text);">Pemasukan</div>
            ${r.pemasukanHariIni.length ? r.pemasukanHariIni.map(i => listItem(i, true)).join("") : '<div class="text-muted" style="padding:4px 6px;">Tidak ada pemasukan</div>'}
            <div style="display:flex; justify-content:space-between; padding: 6px 6px 2px 6px; border-top: 1px dashed var(--border-subtle); font-weight: 700;">
                <span>Total Pemasukan</span><span class="amount-in">${formatRpWA(r.totalPemasukan)}</span>
            </div>
        </div>

        <div class="cash-section-out">
            <div style="font-weight: 700; color: var(--danger-text);">Pengeluaran</div>
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
    renderSingleCategoryChart('Pemasukan', globalIn, selectedKatIn, 'chartKatPemasukan', 'title-kat-pemasukan', 'sub-kat-pemasukan', getChartThemeColors().inC);
    renderSingleCategoryChart('Pengeluaran', globalOut, selectedKatOut, 'chartKatPengeluaran', 'title-kat-pengeluaran', 'sub-kat-pengeluaran', getChartThemeColors().outC);
}

if (window.Chart) { Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif"; }

// Baca design token dari CSS (styles.css) supaya warna grafik tidak hard-code
function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name);
    return (v && v.trim()) || fallback;
}

// Hex (#rrggbb) -> rgba(...) untuk isi area transparan
function hexToRgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    if (h.length !== 6) return hex;
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

// Radius sudut batang grafik (sama untuk semua tema)
function chartRadius(r) {
    return r;
}

function getChartThemeColors() {
    const isDark = DARK_THEMES.indexOf(document.body.getAttribute('data-theme')) !== -1;
    const c1 = cssVar('--chart-1', '#6c63ff');
    const c1Soft = cssVar('--chart-1-soft', '#c9c5ff');
    const c2 = cssVar('--chart-2', '#86d9a5');
    // Ujung bawah batang: warna yang sama, dibuat lebih pudar (gradasi seperti referensi)
    const fade = function (c) { return hexToRgba(c, isDark ? 0.45 : 0.6); };
    return {
        isDark: isDark,
        text: cssVar('--text-secondary', '#6b7280'),
        grid: cssVar('--chart-grid', 'rgba(15,23,42,0.05)'),
        tipBg: cssVar('--tooltip-bg', cssVar('--surface', '#ffffff')),
        tipText: cssVar('--text-primary', '#202124'),
        tipBorder: cssVar('--border', '#e8eaed'),
        // Batang datar (tanpa gradasi): seri 1 = aksen, seri 2 = hijau lembut, seri 3 = abu
        c1Top: c1,
        c1Bottom: fade(c1),
        c2Top: c2,
        c2Bottom: fade(c2),
        fade: fade,
        track: cssVar('--chart-track', isDark ? '#1d1d1f' : '#f1f2f6'),
        c3: cssVar('--chart-3', '#d3d7e0'),
        c1Soft: c1Soft,
        brand: c1,
        spark: cssVar('--chart-spark', c1),
        danger: cssVar('--danger', '#ef4444'),
        // Seri dashboard: masuk / masuk-2 / keluar (token tema)
        inC: cssVar('--chart-in', c1),
        in2C: cssVar('--chart-in-2', c2),
        outC: cssVar('--chart-out', cssVar('--danger', '#ef4444')),
        empty: cssVar('--chart-empty', '#eceef2'),
        // Garis tepi batang/donut (opsional lewat token --chart-outline); default: tanpa garis
        outline: cssVar('--chart-outline', 'transparent'),
        outlineW: parseFloat(cssVar('--chart-outline-w', '0')) || 0
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
// Gradasi per-batang: atas = warna penuh, bawah = pudar (mengikuti tinggi tiap batang)
function makeBarGradientPerBar(top, bottom) {
    return function (context) {
        const chart = context.chart;
        const el = context.element;
        if (!el || !chart.chartArea) return top;
        const p = el.getProps(['y', 'base'], true);
        const y1 = Math.min(p.y, p.base), y2 = Math.max(p.y, p.base);
        if (!isFinite(y1) || !isFinite(y2) || y2 - y1 < 1) return top;
        const g = chart.ctx.createLinearGradient(0, y1, 0, y2);
        g.addColorStop(0, top);
        g.addColorStop(1, bottom);
        return g;
    };
}

// Latar "track" abu setinggi area plot di belakang tiap batang/kelompok batang (bentuk pil)
const ckBarTrackPlugin = {
    id: 'ckBarTrack',
    beforeDatasetsDraw: function (chart, args, opts) {
        if (!opts || opts.enabled === false || !chart.chartArea) return;
        const area = chart.chartArea;
        const metas = [];
        chart.data.datasets.forEach(function (_, i) {
            if (chart.isDatasetVisible(i)) metas.push(chart.getDatasetMeta(i));
        });
        if (!metas.length) return;
        const ctx = chart.ctx;
        const pad = metas.length > 1 ? (opts.pad != null ? opts.pad : 4) : 0;
        const maxR = opts.radius != null ? opts.radius : 18;
        const count = (chart.data.labels || []).length;
        ctx.save();
        ctx.fillStyle = opts.color || 'rgba(0,0,0,0.05)';
        for (let i = 0; i < count; i++) {
            let left = Infinity, right = -Infinity;
            metas.forEach(function (m) {
                const bar = m.data[i];
                if (!bar) return;
                const p = bar.getProps(['x', 'width'], true);
                if (!isFinite(p.x) || !isFinite(p.width)) return;
                left = Math.min(left, p.x - p.width / 2);
                right = Math.max(right, p.x + p.width / 2);
            });
            if (!isFinite(left)) continue;
            const x = left - pad, w = right - left + pad * 2;
            const y = area.top, h = area.bottom - area.top;
            const r = Math.max(0, Math.min(w / 2, maxR, h / 2));
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.arcTo(x + w, y, x + w, y + r, r);
            ctx.lineTo(x + w, y + h - r);
            ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
            ctx.lineTo(x + r, y + h);
            ctx.arcTo(x, y + h, x, y + h - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }
};

function buildTrendBarChart(canvasId, labels, seriesDefs) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const t = getChartThemeColors();
    // Mode Harian (banyak batang): tanpa latar pil, batang lebih tipis & sudut lebih kecil
    const padat = labels.length > 8;
    const jml = seriesDefs.length;
    return new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: labels,
            datasets: seriesDefs.map(function (d) {
                return {
                    label: d.label,
                    data: d.data,
                    backgroundColor: d.top,
                    borderColor: t.outline,
                    borderWidth: t.outlineW ? (padat ? Math.min(t.outlineW, 1.5) : t.outlineW) : 0,
                    borderRadius: chartRadius(padat ? 3 : 5),
                    borderSkipped: false,
                    maxBarThickness: padat ? 14 : (jml > 2 ? 30 : 44),
                    categoryPercentage: padat ? 0.9 : 0.72,
                    barPercentage: padat ? 0.85 : 0.9
                };
            })
        },
        plugins: [ckBarTrackPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                ckBarTrack: { enabled: false },
                legend: {
                    position: 'top',
                    align: 'end',
                    labels: { color: t.text, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 14, font: { size: 11.5, weight: '500' } }
                },
                tooltip: {
                    backgroundColor: t.tipBg,
                    titleColor: t.tipText,
                    bodyColor: t.tipText,
                    borderColor: t.tipBorder,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: true,
                    boxPadding: 4,
                    usePointStyle: true,
                    titleFont: { size: 11.5, weight: '600' },
                    bodyFont: { size: 11.5 },
                    callbacks: {
                        label: function (c) { return c.dataset.label + ': ' + formatIDR(c.parsed.y); },
                        labelColor: function (c) { return { borderColor: 'transparent', backgroundColor: seriesDefs[c.datasetIndex].top }; }
                    }
                }
            },
            scales: {
                x: { ticks: { color: t.text, font: { size: 10.5 }, padding: 8, maxRotation: 0, autoSkip: true, autoSkipPadding: 8 }, grid: { display: false }, border: { display: false } },
                y: {
                    beginAtZero: true,
                    ticks: { color: t.text, font: { size: 10.5 }, padding: 8, callback: function (v) { return formatCompactIDR(v); } },
                    grid: { color: t.grid, drawTicks: false, borderDash: [4, 4] },
                    border: { display: false, dash: [4, 4] }
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
                borderColor: t.spark,
                borderWidth: 2,
                fill: 'start',
                tension: 0.45,
                pointRadius: 0,
                backgroundColor: function (context) {
                    const area = context.chart.chartArea;
                    if (!area) return 'transparent';
                    const g = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                    g.addColorStop(0, hexToRgba(t.spark, t.isDark ? 0.3 : 0.2));
                    g.addColorStop(1, hexToRgba(t.spark, 0));
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
                backgroundColor: adaData ? [t.in2C, t.inC, t.outC] : [t.empty],
                borderColor: t.outline,
                borderWidth: adaData ? t.outlineW : 0,
                borderRadius: chartRadius(adaData ? 6 : 0),
                spacing: adaData ? 3 : 0
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
                    cornerRadius: 8,
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
        renderCashflowDashboardChart();
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

    let fillStyle = colorTheme; // batang solid
    if (!isBar) {
        const gradientCat = ctx.createLinearGradient(0, 0, 0, 230);
        gradientCat.addColorStop(0, colorTheme + '26');
        gradientCat.addColorStop(1, colorTheme + '00');
        fillStyle = gradientCat;
    }

    const newChart = new Chart(ctx, {
        type: isBar ? 'bar' : 'line',
        plugins: isBar ? [ckBarTrackPlugin] : [],
        data: {
            labels: labels,
            datasets: [{
                label: `Total ${type}`,
                data: values,
                backgroundColor: fillStyle,
                borderColor: (isBar && themeColors.outlineW) ? themeColors.outline : colorTheme,
                borderWidth: isBar ? themeColors.outlineW : 2,
                borderRadius: chartRadius(isBar ? 5 : 0),
                borderSkipped: false,
                maxBarThickness: 34,
                categoryPercentage: 0.78,
                barPercentage: 0.92,
                fill: !isBar,
                tension: 0.45,
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBackgroundColor: colorTheme,
                pointHoverBorderColor: themeColors.tipBg,
                pointHoverBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                ckBarTrack: { enabled: false },
                legend: { display: false },
                tooltip: {
                    backgroundColor: themeColors.tipBg,
                    titleColor: themeColors.tipText,
                    bodyColor: themeColors.tipText,
                    borderColor: themeColors.tipBorder,
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 8,
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
                    ticks: { callback: value => formatCompactIDR(value), color: themeColors.text, font: { size: 10.5 }, padding: 8 },
                    grid: { color: themeColors.grid, drawTicks: false, borderDash: [4, 4] },
                    border: { display: false, dash: [4, 4] }
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
        { label: 'Pemasukan', data: dataIn, top: t.inC, bottom: t.fade(t.inC) },
        { label: 'Pengeluaran', data: dataOut, top: t.outC, bottom: t.fade(t.outC) }
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
    renderCashflowDashboardChart();
}

function getWeekOfMonth(dateObj) {
    const day = dateObj.getDate();
    if (day <= 7) return 1;
    if (day <= 14) return 2;
    if (day <= 21) return 3;
    return 4; // tanggal 22 s/d akhir bulan masuk Minggu ke-4
}

let cashflowBulanSudahDisesuaikan = false;

// Bila bulan berjalan belum punya pembayaran MAUPUN pengeluaran, pindahkan filter ke bulan terakhir
// yang ada datanya (hanya sekali, sebelum pengguna mengubah filter sendiri) agar dashboard tidak kosong.
function sesuaikanBulanCashflow(paid, keluar) {
    if (cashflowBulanSudahDisesuaikan) return;
    if ((!paid || paid.length === 0) && (!keluar || keluar.length === 0)) return;
    const monthInput = document.getElementById("filter-bulan-cashflow-chart");
    if (!monthInput) return;
    cashflowBulanSudahDisesuaikan = true;
    const ym = d => d.getFullYear() * 100 + (d.getMonth() + 1);
    const semua = (paid || []).map(item => {
        const t = getTanggalPeriodeCashflow(item);
        return t ? ym(t.efektif) : null;
    }).concat((keluar || []).map(e => ym(e.d))).filter(v => v !== null);
    if (semua.length === 0) return;
    const [y, m] = (monthInput.value || "").split('-').map(Number);
    if (semua.includes(y * 100 + m)) return;
    const terakhir = Math.max(...semua);
    monthInput.value = `${Math.floor(terakhir / 100)}-${String(terakhir % 100).padStart(2, '0')}`;
}

function renderCashflowDashboardChart(data) {
    const canvas = document.getElementById("chartCashflowTrend");
    if (!canvas) return;
    if (!data || Array.isArray(data)) data = getCashflowDashboardData();
    if (chartCashflowTrendInstance) chartCashflowTrendInstance.destroy();

    const groupMap = {}; // sortKey -> { label, cash, transfer, keluar }
    const kunci = (d) => {
        if (cashflowChartMode === 'harian') {
            const day = d.getDate();
            return { sortKey: String(day).padStart(2, '0'), label: String(day) };
        }
        const week = getWeekOfMonth(d);
        return { sortKey: String(week), label: `Minggu ${week}` };
    };
    const ambil = (d) => {
        const { sortKey, label } = kunci(d);
        if (!groupMap[sortKey]) groupMap[sortKey] = { label, cash: 0, transfer: 0, keluar: 0 };
        return groupMap[sortKey];
    };

    data.paid.forEach(p => { const g = ambil(p.d); if (p.isCash) g.cash += p.nominal; else g.transfer += p.nominal; });
    data.keluar.forEach(e => { ambil(e.d).keluar += e.nominal; });

    // Pastikan urutan Minggu 1-4 selalu tampil walau datanya kosong
    if (cashflowChartMode === 'mingguan') {
        for (let w = 1; w <= 4; w++) {
            const k = String(w);
            if (!groupMap[k]) groupMap[k] = { label: `Minggu ${w}`, cash: 0, transfer: 0, keluar: 0 };
        }
    }

    const sortedKeys = Object.keys(groupMap).sort();
    const labels = sortedKeys.map(k => groupMap[k].label);
    const t = getChartThemeColors();

    chartCashflowTrendInstance = buildTrendBarChart('chartCashflowTrend', labels, [
        { label: 'Cash', data: sortedKeys.map(k => groupMap[k].cash), top: t.inC, bottom: t.fade(t.inC) },
        { label: 'Transfer', data: sortedKeys.map(k => groupMap[k].transfer), top: t.in2C, bottom: t.fade(t.in2C) },
        { label: 'Pengeluaran', data: sortedKeys.map(k => groupMap[k].keluar), top: t.outC, bottom: t.fade(t.outC) }
    ]);

    // Kartu & panel pendamping (sama seperti tampilan Cash)
    renderCashflowSparkline(sortedKeys.map(k => groupMap[k].cash + groupMap[k].transfer - groupMap[k].keluar));
    renderCashflowDonut(data);
    renderTopAreaCashflow(data.paid);
}

let chartCashflowSparkInstance = null;
let chartCashflowDonutInstance = null;

function renderCashflowSparkline(values) {
    const canvas = document.getElementById('chartCashflowSpark');
    if (!canvas) return;
    if (chartCashflowSparkInstance) chartCashflowSparkInstance.destroy();
    const t = getChartThemeColors();
    const data = values && values.length > 1 ? values : [0, 0];
    chartCashflowSparkInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: data.map(function (_, i) { return i + 1; }),
            datasets: [{
                data: data,
                borderColor: t.spark,
                borderWidth: 2,
                fill: 'start',
                tension: 0.45,
                pointRadius: 0,
                backgroundColor: function (context) {
                    const area = context.chart.chartArea;
                    if (!area) return 'transparent';
                    const g = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                    g.addColorStop(0, hexToRgba(t.spark, t.isDark ? 0.3 : 0.2));
                    g.addColorStop(1, hexToRgba(t.spark, 0));
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

// Gauge/donut 270°: Via Cash / Via Transfer / Pengeluaran, dengan saldo bersih di tengah
function renderCashflowDonut(data) {
    const canvas = document.getElementById('chartCashflowDonut');
    if (!canvas) return;
    if (chartCashflowDonutInstance) chartCashflowDonutInstance.destroy();
    const t = getChartThemeColors();

    const values = [data.cash, data.transfer, data.totalKeluar];
    const adaData = values.some(function (v) { return v > 0; });

    const setText = function (id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setText('cf-donut-total', formatCompactIDR(data.saldo));
    setText('cf-donut-val-cash', formatCompactIDR(data.cash));
    setText('cf-donut-val-transfer', formatCompactIDR(data.transfer));
    setText('cf-donut-val-keluar', formatCompactIDR(data.totalKeluar));

    chartCashflowDonutInstance = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Via Cash', 'Via Transfer', 'Pengeluaran'],
            datasets: [{
                data: adaData ? values : [1],
                backgroundColor: adaData ? [t.inC, t.in2C, t.outC] : [t.empty],
                borderColor: t.outline,
                borderWidth: adaData ? t.outlineW : 0,
                borderRadius: chartRadius(adaData ? 6 : 0),
                spacing: adaData ? 3 : 0
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
                    cornerRadius: 8,
                    callbacks: { label: function (c) { return c.label + ': ' + formatIDR(c.parsed); } }
                }
            }
        }
    });
}

// Daftar 4 area dengan total pemasukan terbesar (bulan terpilih), dengan batang porsi
function renderTopAreaCashflow(paid) {
    const listEl = document.getElementById('cf-cat-list');
    const totalEl = document.getElementById('cf-cat-total');
    if (!listEl) return;

    const map = {};
    (paid || []).forEach(function (p) {
        const area = getValueByKeys(p.item, ['area', 'Area', '_sheetName', 'AREA']) || 'Lainnya';
        map[area] = (map[area] || 0) + p.nominal;
    });
    const entries = Object.keys(map).map(function (k) { return [k, map[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    const total = entries.reduce(function (sum, e) { return sum + e[1]; }, 0);
    if (totalEl) totalEl.textContent = formatIDR(total);

    if (!entries.length || total <= 0) {
        listEl.innerHTML = '<div class="cat-empty">Belum ada data pembayaran.</div>';
        return;
    }
    listEl.innerHTML = entries.slice(0, 4).map(function (e) {
        const pct = Math.round((e[1] / total) * 100);
        return '<div class="cat-row">' +
            '<div class="cat-row-top"><span>' + escHtml(String(e[0])) + '</span><span>' + formatCompactIDR(e[1]) + ' · ' + pct + '%</span></div>' +
            '<div class="cat-bar"><div style="width:' + Math.max(pct, 2) + '%"></div></div>' +
            '</div>';
    }).join('');
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
                <div class="kategori-card ${isActive ? 'active-in' : ''}" style="border-left: 3px solid var(--primary); cursor: pointer;" onclick="filterCategoryTrend('Pemasukan', '${safeCat}')">
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
                <div class="kategori-card ${isActive ? 'active-out' : ''}" style="border-left: 3px solid var(--danger); cursor: pointer;" onclick="filterCategoryTrend('Pengeluaran', '${safeCat}')">
                    <div class="k-title">${cat}</div>
                    <div class="k-val" style="color: var(--danger-text);">${formatIDR(outCatMap[cat])}</div>
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
    
    // Kolom yang BUKAN nominal dilewati. Contoh bug sebelumnya: kolom "Kategori Pemasukan" mengandung
    // kata "masuk", sehingga kode kategori "002 - Kasbon" terbaca sebagai nominal Rp 2.
    const skipKeyPattern = /kategori|kode|minggu|tanggal|tgl|keterangan|catatan|uraian|nama/;

    for (let key in item) {
        let lowerKey = key.toLowerCase().trim();
        if (skipKeyPattern.test(lowerKey)) continue;
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
        let tglBayarTampil = tglBayar;
        
        if (isPaid) {
            if (typeof evalKetepatanPembayaran === "function") {
                const hasilEval = evalKetepatanItem(item, tglBayar, metode, jatuhTempoRaw);
                evalRes = hasilEval.evalRes;
                tglBayarTampil = hasilEval.tglTampil;
            } else {
                evalRes = { isTelat: false, statusText: "Lunas", keterangan: "Sudah Bayar" };
            }
                
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
            tanggalBayar: isPaid ? tglBayarTampil : "-",
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
        if (isi) isi.innerHTML = `<p class="text-center" style="padding:20px; color:var(--danger-text);">URL API Arsip belum diisi. Buka app.js, cari <code>API_URL_ARSIP_KETEPATAN</code>, lalu ganti dengan URL Web App hasil deploy .gs Anda.</p>`;
        return;
    }

    if (isi) isi.innerHTML = `<p class="text-center cell-loading" style="padding:20px 0;">Memuat data arsip ${NAMA_BULAN_ARSIP[bulan - 1]} ${tahun}...</p>`;

    try {
        const res = await fetch(`${API_URL_ARSIP_KETEPATAN}?bulan=${bulan}&tahun=${tahun}`);
        const json = await res.json();

        if (json.status !== "success") {
            if (isi) isi.innerHTML = `<p class="text-center" style="padding:20px; color:var(--danger-text);">${json.message || "Gagal memuat data arsip."}</p>`;
            globalArsipKetepatan = [];
            return;
        }

        globalArsipKetepatan = json.data || [];
        renderLaporanArchiveBulanan(bulan, tahun);
    } catch (err) {
        if (isi) isi.innerHTML = `<p class="text-center" style="padding:20px; color:var(--danger-text);">Gagal menghubungi server arsip: ${err.message}</p>`;
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

    // ===== SUSUN TAMPILAN — format & urutan sama dengan Laporan Bulanan utama =====
    ensureLaporanStyles();
    const R = RPT;
    const lastDayArsip = new Date(tahun, bulan, 0).getDate();
    let html = '<div class="rpt">' + R.head('Laporan Finance Bulanan', `Periode Tanggal 1 - ${lastDayArsip} ${labelBulanTahun}`);

    html += R.section('Pemasukan');
    html += R.group('Total Pemasukan Bulan Ini', formatRp(totalPemasukan));
    html += R.item('Tagihan Rutin Pelanggan (Arsip)', formatRp(totalTagihanRutin));

    html += R.section('Pengeluaran');
    html += R.group('Total Pengeluaran Bulan Ini', formatRp(totalPengeluaran));
    if (Object.keys(katPengeluaran).length === 0) {
        html += R.item('Tidak ada rincian pengeluaran', '-');
    } else {
        for (const [kat, total] of Object.entries(katPengeluaran)) {
            html += R.item(kat, formatRp(total));
        }
    }
    html += R.key('Laba / Rugi Bulan Ini', formatRp(selisih), selisih);

    html += R.section('Ketepatan Bayar & Piutang');
    html += R.line('Persentase Tagihan Terbayar Tepat Waktu', totalPelangganAktif > 0 ? `${persenTepatWaktu}% ( ${countBayarTepatWaktu} dari ${totalPelangganAktif} pelanggan )` : '-');
    html += R.group('Total Piutang Belum Terbayar Akhir Bulan', countPiutangBelumBayar > 0 ? `${formatRp(totalPiutangBelumBayar)} ( ${countPiutangBelumBayar} pelanggan )` : '-');
    piutangBelumBayarList.forEach(p => {
        html += R.item(`${p.nama} (${p.area})`, formatRp(p.nominal));
    });

    html += R.section('Rincian Pengeluaran');
    html += R.group('Total Pengeluaran Operasional', totalOperasional > 0 ? formatRp(totalOperasional) : '-');
    for (const [label, total] of Object.entries(detailOperasional)) html += R.item(label, formatRp(total));
    html += R.group('Total Pengeluaran Gaji Karyawan', totalGajiKaryawan > 0 ? formatRp(totalGajiKaryawan) : '-');
    for (const [label, total] of Object.entries(detailGajiKaryawan)) html += R.item(label, formatRp(total));
    html += R.group('Total Pengeluaran Pengadaan Barang', totalPengadaanBarang > 0 ? formatRp(totalPengadaanBarang) : '-');
    for (const [label, total] of Object.entries(detailPengadaanBarang)) html += R.item(label, formatRp(total));

    html += R.section('Reimbursement');
    html += R.group('Total Reimbursement Yang Diproses', totalReimbursement > 0 ? formatRp(totalReimbursement) : '-');
    for (const [kat, total] of Object.entries(katReimbursement)) html += R.item(kat, formatRp(total));

    isi.innerHTML = html + '</div>';
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

    // 0. Pakai parser yang SAMA dengan data pembayaran (parseToDateObj) supaya "05/03/2026" selalu dibaca
    //    5 Maret (DD/MM/YYYY). Sebelumnya new Date() membacanya sebagai 3 Mei (MM/DD) untuk tanggal 1-12,
    //    sehingga pengeluaran masuk ke bulan yang salah di Dashboard/Laporan Cashflow.
    if (typeof parseToDateObj === 'function') {
        const seragam = parseToDateObj(cleanStr);
        if (seragam) return seragam;
    }

    // 1. Fallback: ISO (YYYY-MM-DD) / Date string
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
// Memakai parseToDateObj: format "A/B/YYYY" yang salah satunya > 12 otomatis dikenali (mis. "9/29/2026"
// = 29 September), tidak lagi meluber jadi bulan ke-29 / tahun 2028. Yang ambigu (dua-duanya <= 12)
// dibaca DD/MM/YYYY.
function parseFlexDate(dateVal) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return dateVal;
    return parseToDateObj(String(dateVal).trim());
}

// Perbaikan tanggal bayar yang ambigu (misal "9/12/2026" bisa berarti 9 Desember ATAU 12 September).
// Yang ambigu dipilih tafsiran yang PALING DEKAT dengan tanggal acuan (refDate = tanggal jatuh tempo;
// bila tidak diberikan, tanggal 15 bulan/tahun yang diharapkan). Tanggal yang tidak ambigu dibaca apa adanya.
function parseFlexDateSmart(dateVal, expectedMonth, expectedYear, refDate) {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return dateVal;
    const ref = (refDate instanceof Date && !isNaN(refDate.getTime()))
        ? refDate
        : new Date(expectedYear, (expectedMonth || 1) - 1, 15);
    return parseToDateObj(String(dateVal).trim(), ref);
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
// Baca tanggal bayar & jatuh tempo SEKALIGUS sebagai satu pasangan.
// Masalah sebelumnya (lingkaran): tanggal bayar ambigu "10/01/2026" dibaca dulu sebagai 10 Januari (DD/MM),
// tahun jatuh tempo lalu ditebak dari tanggal itu (Okt 2025), kemudian tanggal bayar "dikunci" memakai jatuh tempo
// yang sudah salah tadi -> bayar 1 Okt 2026 (MM/DD) tetap dibaca 10 Jan 2026 dan dihitung telat 101 hari.
// Sekarang: coba KEDUA tafsiran tanggal bayar (DD/MM dan MM/DD) x kandidat tahun jatuh tempo, lalu pilih
// pasangan yang paling dekat jaraknya. Mengembalikan { paid, due } (Date) atau null bila tidak bisa ditentukan
// (mis. periode kosong -> due null, dan pemanggil memakai logika lama).
function resolvePasanganBayarTempo(item, tglBayarRaw) {
    const raw = String(tglBayarRaw === undefined || tglBayarRaw === null ? "" : tglBayarRaw).trim();
    if (raw === "" || raw === "-" || raw === "undefined" || raw === "null") return { paid: null, due: null };

    const mk = (yy, mo, dd) => {
        const dt = new Date(yy, mo - 1, dd);
        return (dt.getFullYear() === yy && dt.getMonth() === mo - 1 && dt.getDate() === dd) ? dt : null;
    };
    const kandidatBayar = [];
    const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4}|\d{2})(?!\d)/);
    if (m) {
        const p1 = parseInt(m[1], 10), p2 = parseInt(m[2], 10);
        let y = parseInt(m[3], 10);
        if (m[3].length === 2) y += 2000;
        const dmy = mk(y, p2, p1), mdy = mk(y, p1, p2);
        if (dmy) kandidatBayar.push(dmy);
        if (mdy && p1 !== p2) kandidatBayar.push(mdy);
    } else {
        const one = parseToDateObj(raw);
        if (one && !isNaN(one.getTime())) kandidatBayar.push(new Date(one.getFullYear(), one.getMonth(), one.getDate()));
    }
    if (kandidatBayar.length === 0) return { paid: null, due: null };

    const tahunUji = new Set();
    kandidatBayar.forEach(p => [p.getFullYear() - 1, p.getFullYear(), p.getFullYear() + 1].forEach(t => tahunUji.add(t)));

    let paid = kandidatBayar[0], due = null, jarak = Infinity;
    kandidatBayar.forEach(p => tahunUji.forEach(t => {
        const dd = getJatuhTempoDate(item, t);
        if (!dd || isNaN(dd.getTime())) return;
        const sc = Math.abs(p - dd);
        if (sc < jarak) { jarak = sc; paid = p; due = dd; }
    }));
    return { paid, due };
}

// Evaluasi ketepatan 1 baris pelanggan (dipakai tabel Ketepatan Bayar).
// tglTampil = tanggal bayar yang sudah dibaca benar (format YYYY-MM-DD) agar kolom tanggal di tabel konsisten dengan statusnya.
function evalKetepatanItem(item, tglBayar, metode, jatuhTempoRaw) {
    const pasangan = resolvePasanganBayarTempo(item, tglBayar);
    const jatuhTempoResolved = pasangan.due || resolveDueDateStringForEval(item, tglBayar) || jatuhTempoRaw;
    const evalRes = evalKetepatanPembayaran(jatuhTempoResolved, pasangan.paid || tglBayar, metode);
    let tglTampil = tglBayar;
    if (pasangan.paid) {
        const p = pasangan.paid;
        tglTampil = `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
    }
    return { evalRes, tglTampil };
}

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

// ==========================================
// TAMPILAN LAPORAN (kop surat + seksi + baris grup/item/total)
// Dipakai Laporan Mingguan/Bulanan dan halaman Archive. Hanya mengatur TAMPILAN —
// isi/angka laporan tetap dihitung oleh fungsi renderer masing-masing.
// Style disuntikkan dari sini supaya tidak bergantung pada styles.css; boleh dipindah ke styles.css.
// ==========================================
function ensureLaporanStyles() {
    if (document.getElementById('rpt-style')) return;
    const st = document.createElement('style');
    st.id = 'rpt-style';
    st.textContent = `
.rpt { font-size: 11.5px; line-height: 1.45; color: var(--text-primary, #202124); }
.rpt-head { text-align: center; padding: 2px 0 10px; border-bottom: 2px solid var(--text-primary, #202124); margin-bottom: 4px; }
.rpt-head-co { font-weight: 800; font-size: 12.5px; letter-spacing: .02em; text-transform: uppercase; }
.rpt-head-title { font-weight: 700; margin-top: 2px; }
.rpt-head-periode { color: var(--text-secondary, #6b7280); margin-top: 1px; }
.rpt-section { font-weight: 800; margin: 16px 0 4px; padding-bottom: 3px; border-bottom: 1px solid var(--border-subtle, rgba(128,128,128,.35)); }
.rpt-row { display: grid; grid-template-columns: minmax(0, 1fr) 7em 7em; column-gap: 8px; align-items: baseline; padding: 4px 6px; }
.rpt-label { min-width: 0; overflow-wrap: anywhere; }
.rpt-val { text-align: right; white-space: nowrap; }
.rpt-group { background: rgba(128,128,128,.12); font-weight: 600; margin-top: 2px; }
.rpt-group .rpt-val { grid-column: 3; }
.rpt-item { padding-left: 20px; color: var(--text-secondary, #6b7280); }
.rpt-item .rpt-val { grid-column: 2; }
.rpt-line .rpt-val { grid-column: 3; font-weight: 600; }
.rpt-key { font-weight: 800; margin-top: 8px; padding-top: 6px; padding-bottom: 6px; border-top: 1px solid var(--text-primary, #202124); border-bottom: 3px double var(--text-primary, #202124); }
.rpt-key .rpt-val { grid-column: 3; }
.rpt-neg .rpt-val { color: var(--danger-text, #b91c1c); }
.rpt .rpt-row .rpt-val.rpt-wide { grid-column: 2 / span 2; white-space: normal; }
@media print { .rpt-group { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;
    document.head.appendChild(st);
}

const RPT = {
    _row(kind, label, value, extraClass) {
        const v = String(value === undefined || value === null ? '' : value);
        const batas = kind === 'item' ? 14 : 16;
        const wide = v.length > batas ? ' rpt-wide' : '';
        return `<div class="rpt-row rpt-${kind}${extraClass ? ' ' + extraClass : ''}"><span class="rpt-label">${escHtml(label)}</span><span class="rpt-val${wide}">${escHtml(v)}</span></div>`;
    },
    // Kop laporan: nama perusahaan, judul, periode
    head(judul, periode) {
        return `<div class="rpt-head"><div class="rpt-head-co">${escHtml(NAMA_TOKO)}</div><div class="rpt-head-title">${escHtml(judul)}</div><div class="rpt-head-periode">${escHtml(periode)}</div></div>`;
    },
    section(judul) { return `<div class="rpt-section">${escHtml(judul)}</div>`; },
    // Baris kelompok (berlatar abu) — nilai di kolom kanan, rincian di bawahnya
    group(label, value) { return this._row('group', label, value); },
    // Baris rincian (menjorok) — nilai di kolom tengah
    item(label, value) { return this._row('item', label, value); },
    // Baris biasa tanpa rincian
    line(label, value) { return this._row('line', label, value); },
    // Baris hasil akhir (Laba/Rugi, Selisih) — tebal, bergaris; merah bila negatif
    key(label, value, angka) { return this._row('key', label, value, Number(angka) < 0 ? 'rpt-neg' : ''); }
};

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
        const paidDate = isPaid ? parseFlexDateSmart(tglBayar, dueDateOwn.getMonth() + 1, dueDateOwn.getFullYear(), dueDateOwn) : null;

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

    // Pemasukan kode 002 (kasbon / piutang kasbon yang sudah terbayar) dari data Cash, dalam periode terpilih
    let totalKasbonMasuk = 0, countKasbonMasuk = 0;
    const detailKasbonMasuk = {};
    getPemasukanKasbonEntries().forEach(e => {
        if (!isInPeriode(e.d)) return;
        totalKasbonMasuk += e.nominal;
        countKasbonMasuk++;
        const label = e.keterangan && e.keterangan !== "-" ? e.keterangan : e.kategori;
        detailKasbonMasuk[label] = (detailKasbonMasuk[label] || 0) + e.nominal;
    });

    const totalPemasukan = totalTagihanRutin + totalPiutangLunas + totalKasbonMasuk;

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
    // MENYUSUN TAMPILAN LAPORAN (kop + seksi + baris grup/item) — isi & angka sama seperti sebelumnya
    // ==========================================
    ensureLaporanStyles();
    const R = RPT;
    const namaBulanTahun = `${NAMA_BULAN_PANJANG[bulan - 1]} ${tahun}`;
    const judulKop = isBulananView ? 'Laporan Finance Bulanan' : 'Laporan Finance Mingguan';
    const periodeKop = isBulananView
        ? `Periode Tanggal 1 - ${lastDayOfMonth} ${namaBulanTahun}`
        : `${periodeText.split(' / ')[0]} · Tanggal ${startDayActual} - ${endDayActual} ${namaBulanTahun}`;
    let html = '<div class="rpt">' + R.head(judulKop, periodeKop);

    if (isBulananView) {
        const labelBulanTahun = namaBulanTahun;

        const persenTepatWaktu = totalPelangganAktif > 0
            ? ((countBayarTepatWaktu / totalPelangganAktif) * 100).toFixed(2).replace('.', ',')
            : '0';

        // Pemasukan
        html += R.section('Pemasukan');
        html += R.group('Total Pemasukan Bulan Ini', formatRp(totalPemasukan));
        html += R.item('Tagihan Rutin Pelanggan', formatRp(totalTagihanRutin));
        html += R.item('Tagihan Piutang Bulan Lalu', countPiutangLunas > 0 ? `${countPiutangLunas} pelanggan, total ${formatRp(totalPiutangLunas)}` : '-');
        html += R.item('Pemasukan Kasbon / Piutang Kasbon Terbayar (002)', countKasbonMasuk > 0 ? `${countKasbonMasuk} transaksi, total ${formatRp(totalKasbonMasuk)}` : '-');

        // Pengeluaran + hasil akhir
        html += R.section('Pengeluaran');
        html += R.group('Total Pengeluaran Bulan Ini', formatRp(totalPengeluaran));
        if (Object.keys(katPengeluaran).length === 0) {
            html += R.item('Tidak ada rincian pengeluaran', '-');
        } else {
            for (const [kat, total] of Object.entries(katPengeluaran)) {
                html += R.item(kat, formatRp(total));
            }
        }
        html += R.key('Laba / Rugi Bulan Ini', formatRp(selisih), selisih);

        // Ketepatan bayar & piutang
        html += R.section('Ketepatan Bayar & Piutang');
        html += R.line('Persentase Tagihan Terbayar Tepat Waktu', totalPelangganAktif > 0 ? `${persenTepatWaktu}% ( ${countBayarTepatWaktu} dari ${totalPelangganAktif} pelanggan )` : '-');
        html += R.group('Total Piutang Belum Terbayar Akhir Bulan', countPiutangBelumBayar > 0 ? `${formatRp(totalPiutangBelumBayar)} ( ${countPiutangBelumBayar} pelanggan )` : '-');
        piutangBelumBayarList.forEach(p => {
            html += R.item(`${p.nama} (${p.area})`, formatRp(p.nominal));
        });

        // Rincian pengeluaran per jenis
        html += R.section('Rincian Pengeluaran');
        html += R.group('Total Pengeluaran Operasional', totalOperasional > 0 ? formatRp(totalOperasional) : '-');
        for (const [label, total] of Object.entries(detailOperasional)) {
            html += R.item(label, formatRp(total));
        }
        html += R.group('Total Pengeluaran Gaji Karyawan', totalGajiKaryawan > 0 ? formatRp(totalGajiKaryawan) : '-');
        for (const [label, total] of Object.entries(detailGajiKaryawan)) {
            html += R.item(label, formatRp(total));
        }
        html += R.group('Total Pengeluaran Pengadaan Barang', totalPengadaanBarang > 0 ? formatRp(totalPengadaanBarang) : '-');
        for (const [label, total] of Object.entries(detailPengadaanBarang)) {
            html += R.item(label, formatRp(total));
        }

        // Reimbursement
        html += R.section('Reimbursement');
        html += R.group('Total Reimbursement Yang Diproses', totalReimbursement > 0 ? formatRp(totalReimbursement) : '-');
        for (const [kat, total] of Object.entries(katReimbursement)) {
            html += R.item(kat, formatRp(total));
        }

        // Penutup (belum ada sumber data otomatis untuk saldo awal & budget)
        html += R.section('Penutup');
        html += R.line('Cashflow Akhir Bulan (Saldo)', '-');
        html += R.line('Anggaran vs Realisasi', `Budget: - | Realisasi: ${formatRp(totalPengeluaran)} | Selisih: -`);
        html += R.line('Rekomendasi / Catatan Untuk Owner', '-');

        const judulElB = document.getElementById('judul-laporan-periode');
        if (judulElB) judulElB.textContent = `Laporan Bulanan — ${labelBulanTahun}`;

        lastLaporanPeriodeSummary = {
            isBulananView: true,
            periodeLabel: labelBulanTahun,
            totalPemasukan, totalPengeluaran, selisih,
            persenTepatWaktu, countBayarTepatWaktu, totalPelangganAktif,
            countPiutangBelumBayar, totalPiutangBelumBayar
        };

        isi.innerHTML = html + '</div>';
        return;
    }

    // ==========================================
    // TAMPILAN LAPORAN MINGGUAN
    // ==========================================

    // Pemasukan
    html += R.section('Pemasukan');
    html += R.group(`Total Pemasukan ${labelPeriode}`, formatRp(totalPemasukan));
    html += R.item('Tagihan Rutin Pelanggan', formatRp(totalTagihanRutin));
    html += R.item('Tagihan Piutang Minggu Lalu', `${countPiutangLunas} pelanggan, total ${formatRp(totalPiutangLunas)}`);
    html += R.item('Pemasukan Kasbon / Piutang Kasbon Terbayar (002)', countKasbonMasuk > 0 ? `${countKasbonMasuk} transaksi, total ${formatRp(totalKasbonMasuk)}` : '-');

    // Pengeluaran + hasil akhir
    html += R.section('Pengeluaran');
    html += R.group(`Total Pengeluaran ${labelPeriode}`, formatRp(totalPengeluaran));
    if (Object.keys(katPengeluaran).length === 0) {
        html += R.item('Tidak ada rincian pengeluaran', 'Rp 0');
    } else {
        for (const [kat, total] of Object.entries(katPengeluaran)) {
            html += R.item(kat, formatRp(total));
        }
    }
    html += R.key('Selisih (Surplus / Defisit)', formatRp(selisih), selisih);

    // Pelanggan & piutang
    html += R.section('Pelanggan & Piutang');
    html += R.line('Jumlah Pelanggan Bayar Tepat Waktu', `${countBayarTepatWaktu} dari ${totalPelangganAktif} pelanggan aktif`);
    html += R.line('Jumlah Piutang Belum Terbayar', `${countPiutangBelumBayar} pelanggan, total ${formatRp(totalPiutangBelumBayar)}`);
    if (piutangH7List.length === 0) {
        html += R.line('Piutang > H+7 (perlu eskalasi owner)', '-');
    } else {
        html += R.group('Piutang > H+7 (perlu eskalasi owner)', '');
        piutangH7List
            .sort((a, b) => b.daysOverdueToday - a.daysOverdueToday)
            .forEach(p => {
                html += R.item(`${p.nama} (${p.area}) — Telat ${p.daysOverdueToday} hari`, formatRp(p.nominal));
            });
    }

    // Tagihan rutin & reimbursement
    html += R.section('Tagihan Rutin & Reimbursement');
    html += R.group('Tagihan Rutin Yang Dibayar Minggu Ini', formatRp(totalRutinDibayar));
    for (const [kat, total] of Object.entries(katRutinDibayar)) {
        html += R.item(kat, formatRp(total));
    }
    html += R.group('Reimbursement Yang Diproses', formatRp(totalReimbursement));
    for (const [kat, total] of Object.entries(katReimbursement)) {
        html += R.item(kat, formatRp(total));
    }

    // Catatan (belum ada sumber data otomatis)
    html += R.section('Catatan');
    html += R.line('Catatan / Temuan Penting', '-');

    const judulElM = document.getElementById('judul-laporan-periode');
    if (judulElM) judulElM.textContent = `Laporan Mingguan — ${periodeText}`;

    lastLaporanPeriodeSummary = {
        isBulananView: false,
        periodeLabel: periodeText,
        totalPemasukan, totalPengeluaran, selisih,
        countBayarTepatWaktu, totalPelangganAktif,
        countPiutangBelumBayar, totalPiutangBelumBayar
    };

    isi.innerHTML = html + '</div>';
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
    const akhirBulan = new Date(tahun, bulan, 0, 23, 59, 59, 999);

    // Memakai aturan yang SAMA dengan renderLaporanPeriode (jatuh tempo dari periode+tempo, tanggal bayar
    // dibaca dengan acuan jatuh tempo), jadi hasilnya persis seperti yang dihitung laporan.
    const grup = { cocok: [], noTempo: [], bedaBulan: [], gagalParse: [], lewatAkhir: [] };
    let totalAntrean = 0;

    (globalMasterData || []).forEach(item => {
        const tglBayar = getValueByKeys(item, ["tanggalBayar", "Tanggal Bayar", "Tanggal Pembayaran", "TGL_BAYAR", "Tgl Bayar", "TGL BAYAR"]);
        const metode = getValueByKeys(item, ["metode", "Metode Bayar", "Metode", "METODE"]);
        const isACC = item.status === true || item.status === "true" || item.status === "TRUE";
        const isPaid = (tglBayar && tglBayar !== "-") || (metode && metode !== "-");
        if (!isPaid || isACC) return; // sama seperti isi Daftar Antrean

        const nominal = getNominalMasterPelanggan(item);
        const nama = getValueByKeys(item, ["nama", "Nama Pelanggan", "Nama", "NAMA"]) || "Tanpa Nama";
        const periode = getValueByKeys(item, ["periode", "Periode", "PERIODE"]);
        const tempo = getValueByKeys(item, ["tempo", "jatuhTempo", "Jatuh Tempo", "TEMPO"]);
        totalAntrean += nominal;

        const dueDateOwn = resolveDueDateForLaporan(item, tahun, bulan);
        if (!dueDateOwn) { grup.noTempo.push({ nama, nominal, periode, tempo }); return; }

        if (dueDateOwn.getFullYear() !== tahun || (dueDateOwn.getMonth() + 1) !== bulan) {
            grup.bedaBulan.push({ nama, nominal, periode, tempo, jatuhTempo: dueDateOwn.toLocaleDateString('id-ID') });
            return;
        }

        const paidDate = parseFlexDateSmart(tglBayar, dueDateOwn.getMonth() + 1, dueDateOwn.getFullYear(), dueDateOwn);
        if (!paidDate) { grup.gagalParse.push({ nama, nominal, tglBayarRaw: tglBayar }); return; }
        if (paidDate > akhirBulan) {
            grup.lewatAkhir.push({ nama, nominal, tglBayarRaw: tglBayar, terbaca: paidDate.toLocaleDateString('id-ID'), jatuhTempo: dueDateOwn.toLocaleDateString('id-ID') });
            return;
        }
        grup.cocok.push({ nama, nominal });
    });

    const sum = arr => arr.reduce((s, i) => s + i.nominal, 0);
    const rp = n => "Rp " + n.toLocaleString('id-ID');
    console.log("=== DIAGNOSA SELISIH ANTREAN vs LAPORAN BULANAN ===");
    console.log("Bulan/Tahun laporan yang dicek:", bulan + "/" + tahun);
    console.log("Total di Daftar Antrean (belum ACC):", rp(totalAntrean));
    console.log("Masuk Laporan Bulanan ini:", rp(sum(grup.cocok)), "(" + grup.cocok.length + " pelanggan)");
    console.log("--- 1) Tidak ada jatuh tempo valid (tempo kosong) ---", rp(sum(grup.noTempo)));
    console.table(grup.noTempo);
    console.log("--- 2) Jatuh tempo (periode+tempo) jatuh di bulan/tahun lain ---", rp(sum(grup.bedaBulan)));
    console.table(grup.bedaBulan);
    console.log("--- 3) Tanggal bayar gagal dibaca ---", rp(sum(grup.gagalParse)));
    console.table(grup.gagalParse);
    console.log("--- 4) Tanggal bayar terbaca SETELAH akhir bulan laporan ---", rp(sum(grup.lewatAkhir)));
    console.table(grup.lewatAkhir);
    return { totalAntrean, masukLaporan: sum(grup.cocok), ...grup };
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
window.setTheme = setTheme;
window.pickLoginTheme = pickLoginTheme;
window.toggleThemeMenu = toggleThemeMenu;


// ==========================================
// POPUP PENGINGAT CHECKLIST — tampil di SEMUA halaman, pojok kanan atas.
// Mengambil ulang daftar alert (read-only: action=list) tiap CK_TOAST_INTERVAL_MS
// dan hanya tampil jika ada catatan jatuh tempo (H-3 s/d hari ini).
// ==========================================
const CK_TOAST_INTERVAL_MS = 45000; // jeda 45 detik: dihitung sejak popup tertutup sampai popup berikutnya muncul
const CK_TOAST_VISIBLE_MS = 6000;   // lama popup tampil sebelum menutup sendiri
const CK_TOAST_HIDE_ANIM_MS = 520;  // durasi animasi keluar (liquid)
let ckToastHideTimer = null;
let ckToastRemoveTimer = null;
let ckPollTimer = null;

function ckSchedulePoll(ms) {
    clearTimeout(ckPollTimer);
    ckPollTimer = setTimeout(ckPollAlerts, ms);
}

function ckToastRoot() {
    let root = document.getElementById('ck-toast-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'ck-toast-root';
        root.className = 'ck-toast-root';
        root.setAttribute('aria-live', 'polite');
        document.body.appendChild(root);
    }
    return root;
}

function ckHideToast() {
    clearTimeout(ckToastHideTimer);
    const root = document.getElementById('ck-toast-root');
    if (!root) return;
    const toast = root.firstElementChild;
    if (!toast) return;
    toast.classList.remove('show');
    toast.classList.add('hide');
    clearTimeout(ckToastRemoveTimer);
    ckToastRemoveTimer = setTimeout(function () { root.innerHTML = ''; }, CK_TOAST_HIDE_ANIM_MS);
    ckSchedulePoll(CK_TOAST_INTERVAL_MS); // popup berikutnya: 45 detik setelah yang ini tertutup
}

function ckShowToast(alerts) {
    const root = ckToastRoot();
    clearTimeout(ckToastHideTimer);
    clearTimeout(ckToastRemoveTimer);
    clearTimeout(ckPollTimer); // selama popup tampil, tidak ada polling baru

    const MAX_ROWS = 3;
    const rows = alerts.slice(0, MAX_ROWS).map(function (item) {
        const today = item._sisaHari == 0;
        return '<div class="ck-toast-item">' +
            '<span class="ck-toast-name">' + escHtml(item.namaCatatan) + '</span>' +
            '<span class="ck-toast-badge' + (today ? ' today' : '') + '">' + (today ? 'Hari ini' : 'H-' + item._sisaHari) + '</span>' +
            '</div>';
    }).join('');
    const more = alerts.length > MAX_ROWS ? '<div class="ck-toast-more">+' + (alerts.length - MAX_ROWS) + ' catatan lainnya</div>' : '';

    root.innerHTML =
        '<div class="ck-toast" role="alert">' +
            '<div class="ck-toast-head">' +
                '<span class="ck-toast-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></span>' +
                '<span class="ck-toast-title">' + alerts.length + ' pengingat jatuh tempo</span>' +
                '<button type="button" class="ck-toast-close" aria-label="Tutup pengingat">&times;</button>' +
            '</div>' +
            '<div class="ck-toast-list">' + rows + '</div>' + more +
        '</div>';

    const toast = root.firstElementChild;
    toast.addEventListener('click', function (e) {
        if (e.target.closest('.ck-toast-close')) { e.stopPropagation(); ckHideToast(); return; }
        ckHideToast();
        if (typeof navigateTo === 'function') navigateTo('ceklis');
    });
    requestAnimationFrame(function () { toast.classList.add('show'); });
    ckToastHideTimer = setTimeout(ckHideToast, CK_TOAST_VISIBLE_MS);
}

function ckPollAlerts() {
    const shell = document.getElementById('app-shell');
    if (!shell || !shell.classList.contains('app-visible') || document.hidden) {
        ckSchedulePoll(CK_TOAST_INTERVAL_MS); // belum login / tab tidak aktif: cek lagi nanti
        return;
    }
    let toastTampil = false;
    fetch('index.php?action=list', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data || !data.success) return;
            const dot = document.getElementById('bell-dot');
            if (dot) dot.hidden = !(data.alerts && data.alerts.length);
            if (data.alerts && data.alerts.length) { ckShowToast(data.alerts); toastTampil = true; }
        })
        .catch(function () { /* gagal jaringan: diam saja, coba lagi di putaran berikutnya */ })
        .then(function () {
            // Bila popup tampil, jadwal berikutnya diatur saat popup tertutup (ckHideToast)
            if (!toastTampil) ckSchedulePoll(CK_TOAST_INTERVAL_MS);
        });
}

function initCeklisToast() {
    ckSchedulePoll(CK_TOAST_INTERVAL_MS);
}

// ==========================================
// ANIMASI LIQUID HALAMAN LOGIN
// Satu gumpalan mengikuti kursor dengan gerak melambat; ia menyatu dengan
// gumpalan lain lewat filter goo (lihat #login-goo di index.php).
// Loop berhenti sendiri saat gumpalan sudah diam atau login disembunyikan.
// ==========================================
function initLoginLiquid() {
    const page = document.getElementById('login-page');
    const blob = document.getElementById('login-cursor-blob');
    if (!page || !blob) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let tx = window.innerWidth * 0.72, ty = window.innerHeight * 0.3;
    let x = tx, y = ty, raf = 0;

    function paint() { blob.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-50%)'; }
    function loop() {
        if (page.style.display === 'none') { raf = 0; return; }
        x += (tx - x) * 0.07;
        y += (ty - y) * 0.07;
        paint();
        if (Math.abs(tx - x) < 0.3 && Math.abs(ty - y) < 0.3) { raf = 0; return; }
        raf = requestAnimationFrame(loop);
    }
    function kejar(e) {
        tx = e.clientX; ty = e.clientY;
        if (!raf && page.style.display !== 'none') raf = requestAnimationFrame(loop);
    }
    page.addEventListener('pointermove', kejar, { passive: true });
    page.addEventListener('pointerdown', kejar, { passive: true });
    paint();
}

document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initLoginLiquid();
    initCeklisToast();
    try { checkSession(); } catch (e) { showLogin(); }
    initFilterTempo();
    fetchData();
});
