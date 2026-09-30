<?php
// ===================================================================
// CEKLIS: Inisialisasi data & handler AJAX.
// Blok ini WAJIB dijalankan sebelum HTML apa pun dikirim ke browser,
// supaya saat JS memanggil fetch('index.php?action=...'), respons yang
// diterima murni JSON — bukan JSON yang "menempel" di belakang seluruh
// halaman HTML.
// ===================================================================
$ceklisFile = __DIR__ . '/data.json';
$ckUploadDir = __DIR__ . '/uploads/ceklis';
$ckUploadUrl = 'uploads/ceklis';

if (!is_dir($ckUploadDir)) {
    mkdir($ckUploadDir, 0755, true);
}

if (!file_exists($ceklisFile)) {
    file_put_contents($ceklisFile, json_encode([
        "kategoriPengambilan" => ["Pengambilan", "Kekurangan Tagihan", "Kelebihan Tagihan"],
        "items" => []
    ], JSON_PRETTY_PRINT));
}

$dbCeklis = json_decode(file_get_contents($ceklisFile), true)
    ?? ["kategoriPengambilan" => ["Pengambilan", "Kekurangan Tagihan", "Kelebihan Tagihan"], "items" => []];

// Deteksi apakah request ini berasal dari fetch/AJAX (JS), bukan navigasi browser biasa
$isAjaxCeklis = isset($_SERVER['HTTP_X_REQUESTED_WITH']) && strtolower($_SERVER['HTTP_X_REQUESTED_WITH']) === 'xmlhttprequest';

// Berapa hari sebelum jatuh tempo item mulai dianggap "mendekati" (tampil di alert merah)
define('CK_REMINDER_THRESHOLD', 3);

// Hitung berapa hari lagi menuju tanggal jatuh tempo (berulang tiap bulan, angka 1-31)
function ckHitungSisaHari($tanggalJatuhTempo) {
    $hariIni = (int) date('j');
    $jumlahHariBulanIni = (int) date('t');
    $due = max(1, min(31, (int) $tanggalJatuhTempo));
    $due = min($due, $jumlahHariBulanIni); // jaga-jaga kalau due lebih besar dari jumlah hari bulan ini

    if ($due >= $hariIni) {
        return $due - $hariIni;
    }
    // Sudah lewat bulan ini -> hitung ke tanggal yang sama bulan depan
    return ($jumlahHariBulanIni - $hariIni) + $due;
}

// Helper: hitung ulang data terfilter & kelompokkan per kategori, lalu kembalikan sebagai array untuk JSON
function ckBuildResponse($dbCeklis, $search, $filterKat, $filterTanggal = 'ALL') {
    $search = strtolower($search);
    $filteredItems = array_filter($dbCeklis['items'], function ($item) use ($search, $filterKat, $filterTanggal) {
        // 🛠️ Search sekarang mencakup SEMUA kolom (nama, deskripsi, alamat, no HP, kategori, tanggal, nominal)
        $haystack = strtolower(implode(' ', [
            $item['namaCatatan'] ?? '',
            $item['deskripsi'] ?? '',
            $item['alamat'] ?? '',
            $item['noHp'] ?? '',
            $item['kategori'] ?? '',
            (string)($item['tanggalJatuhTempo'] ?? ''),
            (string)($item['nominal'] ?? ''),
        ]));
        $matchSearch = empty($search) || strpos($haystack, $search) !== false;
        $matchKat = ($filterKat === 'ALL') || ($item['kategori'] ?? '') === $filterKat;
        $matchTanggal = ($filterTanggal === 'ALL' || $filterTanggal === '') || ((int)($item['tanggalJatuhTempo'] ?? 0) === (int)$filterTanggal);
        return $matchSearch && $matchKat && $matchTanggal;
    });
    $grouped = [];
    $alerts = [];
    foreach ($filteredItems as $item) {
        $kat = $item['kategori'] ?? 'Tanpa Kategori';
        $grouped[$kat][] = $item;
    }
    // Alert dihitung dari SELURUH data (bukan hasil filter), supaya tetap muncul walau lagi difilter/dicari
    foreach ($dbCeklis['items'] as $item) {
        if (!empty($item['status'])) continue; // sudah selesai, tidak perlu diingatkan
        if (empty($item['tanggalJatuhTempo'])) continue;
        $sisaHari = ckHitungSisaHari($item['tanggalJatuhTempo']);
        if ($sisaHari <= CK_REMINDER_THRESHOLD) {
            $item['_sisaHari'] = $sisaHari;
            $alerts[] = $item;
        }
    }
    usort($alerts, function ($a, $b) { return $a['_sisaHari'] <=> $b['_sisaHari']; });

    return [
        'success' => true,
        'grouped' => $grouped,
        'categories' => $dbCeklis['kategoriPengambilan'],
        'alerts' => $alerts,
    ];
}

// Helper: proses upload foto (jika ada), kembalikan nama file atau null
function ckProsesUploadFoto($ckUploadDir, $ckUploadUrl) {
    if (empty($_FILES['foto']) || $_FILES['foto']['error'] === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    if ($_FILES['foto']['error'] !== UPLOAD_ERR_OK) {
        return null;
    }
    $ekstensiValid = ['jpg', 'jpeg', 'png', 'webp'];
    $ekstensi = strtolower(pathinfo($_FILES['foto']['name'], PATHINFO_EXTENSION));
    if (!in_array($ekstensi, $ekstensiValid, true)) {
        return null;
    }
    $namaBaru = uniqid('ck_', true) . '.' . $ekstensi;
    if (move_uploaded_file($_FILES['foto']['tmp_name'], $ckUploadDir . '/' . $namaBaru)) {
        return $ckUploadUrl . '/' . $namaBaru;
    }
    return null;
}

// Aksi POST: Tambah Data Baru via Modal
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'add') {
    $fotoPath = ckProsesUploadFoto($ckUploadDir, $ckUploadUrl);

    $newItem = [
        "id" => time(),
        "namaCatatan" => trim($_POST['namaCatatan'] ?? ''),
        "deskripsi" => trim($_POST['deskripsi'] ?? ''),
        "kategori" => $_POST['kategori'] ?? 'Umum',
        "nominal" => (float)($_POST['nominal'] ?? 0),
        "status" => isset($_POST['status']),
        "tanggalJatuhTempo" => max(1, min(31, (int)($_POST['tanggalJatuhTempo'] ?? 1))),
        "noHp" => trim($_POST['noHp'] ?? ''),
        "alamat" => trim($_POST['alamat'] ?? ''),
        "foto" => $fotoPath
    ];

    if (!empty($newItem['namaCatatan'])) {
        array_unshift($dbCeklis['items'], $newItem);
        file_put_contents($ceklisFile, json_encode($dbCeklis, JSON_PRETTY_PRINT));
    }

    if ($isAjaxCeklis) {
        header('Content-Type: application/json');
        // Tampilkan semua data (tanpa filter) supaya catatan baru pasti terlihat
        echo json_encode(ckBuildResponse($dbCeklis, '', 'ALL', 'ALL'));
        exit;
    }
    header("Location: index.php#page-ceklis");
    exit;
}

// Aksi POST: Edit Data yang Sudah Ada (CRUD - Update)
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'edit') {
    $editId = $_POST['id'] ?? null;
    $fotoBaru = ckProsesUploadFoto($ckUploadDir, $ckUploadUrl);

    foreach ($dbCeklis['items'] as &$item) {
        if ($item['id'] == $editId) {
            // Kalau ada foto baru diupload, pakai itu (dan hapus foto lama dari disk).
            // Kalau tidak, pertahankan foto lama (existingFoto dikirim dari form sebagai fallback).
            if ($fotoBaru) {
                if (!empty($item['foto'])) {
                    $fotoLama = __DIR__ . '/' . $item['foto'];
                    if (is_file($fotoLama)) @unlink($fotoLama);
                }
                $item['foto'] = $fotoBaru;
            } elseif (!isset($_POST['hapusFoto'])) {
                $item['foto'] = $_POST['existingFoto'] ?? ($item['foto'] ?? null);
            } else {
                // Checkbox "Hapus Foto" dicentang -> hapus foto lama
                if (!empty($item['foto'])) {
                    $fotoLama = __DIR__ . '/' . $item['foto'];
                    if (is_file($fotoLama)) @unlink($fotoLama);
                }
                $item['foto'] = null;
            }

            $item['namaCatatan'] = trim($_POST['namaCatatan'] ?? $item['namaCatatan']);
            $item['deskripsi'] = trim($_POST['deskripsi'] ?? '');
            $item['kategori'] = $_POST['kategori'] ?? $item['kategori'];
            $item['nominal'] = (float)($_POST['nominal'] ?? 0);
            $item['status'] = isset($_POST['status']);
            $item['tanggalJatuhTempo'] = max(1, min(31, (int)($_POST['tanggalJatuhTempo'] ?? 1)));
            $item['noHp'] = trim($_POST['noHp'] ?? '');
            $item['alamat'] = trim($_POST['alamat'] ?? '');
            break;
        }
    }
    unset($item);

    file_put_contents($ceklisFile, json_encode($dbCeklis, JSON_PRETTY_PRINT));

    if ($isAjaxCeklis) {
        header('Content-Type: application/json');
        echo json_encode(ckBuildResponse($dbCeklis, '', 'ALL', 'ALL'));
        exit;
    }
    header("Location: index.php#page-ceklis");
    exit;
}

// Aksi GET: Toggle Status, Hapus Data, atau Ambil Daftar (list) via AJAX
if (isset($_GET['action']) && in_array($_GET['action'], ['toggle', 'delete', 'list'], true)) {
    $id = $_GET['id'] ?? null;
    $reqSearch = $_GET['search'] ?? '';
    $reqKategori = $_GET['kategori'] ?? 'ALL';
    $reqTanggal = $_GET['tanggal'] ?? 'ALL';

    if ($_GET['action'] === 'toggle' && $id) {
        foreach ($dbCeklis['items'] as &$item) {
            if ($item['id'] == $id) {
                $item['status'] = !$item['status'];
                break;
            }
        }
        unset($item);
        file_put_contents($ceklisFile, json_encode($dbCeklis, JSON_PRETTY_PRINT));
    } elseif ($_GET['action'] === 'delete' && $id) {
        foreach ($dbCeklis['items'] as $item) {
            if ($item['id'] == $id && !empty($item['foto'])) {
                $fotoFisik = __DIR__ . '/' . $item['foto'];
                if (is_file($fotoFisik)) @unlink($fotoFisik);
            }
        }
        $dbCeklis['items'] = array_values(array_filter($dbCeklis['items'], function ($item) use ($id) {
            return $item['id'] != $id;
        }));
        file_put_contents($ceklisFile, json_encode($dbCeklis, JSON_PRETTY_PRINT));
    }
    // action === 'list' tidak mengubah data, hanya mengambil ulang tampilan

    if ($isAjaxCeklis) {
        header('Content-Type: application/json');
        echo json_encode(ckBuildResponse($dbCeklis, $reqSearch, $reqKategori, $reqTanggal));
        exit;
    }
    header("Location: index.php#page-ceklis");
    exit;
}
?>
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Cashflow Workspace</title>
    <!-- Font Inter & Chart.js -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fredoka:wght@400;500;600;700&family=Pixelify+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="styles.css">
</head>
<body>


    <!-- Filter "gooey" untuk animasi liquid di halaman login -->
    <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
        <defs>
            <filter id="login-goo" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="blur"/>
                <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"/>
            </filter>
        </defs>
    </svg>

    <!-- Sprite karakter (stiker) untuk tema Neoabstrak & Minecraft -->
    <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs><symbol id="mc-creeper" viewBox="0 0 12 16" shape-rendering="crispEdges"><rect x="2" y="0" width="2" height="1" fill="#5fb04a"/><rect x="4" y="0" width="1" height="1" fill="#4a9a3a"/><rect x="5" y="0" width="3" height="1" fill="#5fb04a"/><rect x="8" y="0" width="1" height="1" fill="#4a9a3a"/><rect x="9" y="0" width="1" height="1" fill="#5fb04a"/><rect x="2" y="1" width="1" height="1" fill="#5fb04a"/><rect x="3" y="1" width="1" height="1" fill="#4a9a3a"/><rect x="4" y="1" width="5" height="1" fill="#5fb04a"/><rect x="9" y="1" width="1" height="1" fill="#4a9a3a"/><rect x="2" y="2" width="1" height="1" fill="#5fb04a"/><rect x="3" y="2" width="2" height="1" fill="#141414"/><rect x="5" y="2" width="2" height="1" fill="#5fb04a"/><rect x="7" y="2" width="2" height="1" fill="#141414"/><rect x="9" y="2" width="1" height="1" fill="#5fb04a"/><rect x="2" y="3" width="1" height="1" fill="#5fb04a"/><rect x="3" y="3" width="2" height="1" fill="#141414"/><rect x="5" y="3" width="2" height="1" fill="#5fb04a"/><rect x="7" y="3" width="2" height="1" fill="#141414"/><rect x="9" y="3" width="1" height="1" fill="#5fb04a"/><rect x="2" y="4" width="3" height="1" fill="#5fb04a"/><rect x="5" y="4" width="2" height="1" fill="#141414"/><rect x="7" y="4" width="3" height="1" fill="#5fb04a"/><rect x="2" y="5" width="2" height="1" fill="#5fb04a"/><rect x="4" y="5" width="4" height="1" fill="#141414"/><rect x="8" y="5" width="2" height="1" fill="#5fb04a"/><rect x="2" y="6" width="2" height="1" fill="#5fb04a"/><rect x="4" y="6" width="4" height="1" fill="#141414"/><rect x="8" y="6" width="2" height="1" fill="#5fb04a"/><rect x="2" y="7" width="2" height="1" fill="#5fb04a"/><rect x="4" y="7" width="1" height="1" fill="#141414"/><rect x="5" y="7" width="2" height="1" fill="#5fb04a"/><rect x="7" y="7" width="1" height="1" fill="#141414"/><rect x="8" y="7" width="2" height="1" fill="#5fb04a"/><rect x="4" y="8" width="1" height="1" fill="#4a9a3a"/><rect x="5" y="8" width="2" height="1" fill="#5fb04a"/><rect x="7" y="8" width="1" height="1" fill="#4a9a3a"/><rect x="4" y="9" width="4" height="1" fill="#5fb04a"/><rect x="4" y="10" width="1" height="1" fill="#5fb04a"/><rect x="5" y="10" width="1" height="1" fill="#4a9a3a"/><rect x="6" y="10" width="2" height="1" fill="#5fb04a"/><rect x="4" y="11" width="3" height="1" fill="#5fb04a"/><rect x="7" y="11" width="1" height="1" fill="#4a9a3a"/><rect x="2" y="12" width="8" height="1" fill="#5fb04a"/><rect x="2" y="13" width="1" height="1" fill="#5fb04a"/><rect x="3" y="13" width="1" height="1" fill="#4a9a3a"/><rect x="4" y="13" width="1" height="1" fill="#5fb04a"/><rect x="7" y="13" width="1" height="1" fill="#5fb04a"/><rect x="8" y="13" width="1" height="1" fill="#4a9a3a"/><rect x="9" y="13" width="1" height="1" fill="#5fb04a"/><rect x="2" y="14" width="3" height="1" fill="#5fb04a"/><rect x="7" y="14" width="3" height="1" fill="#5fb04a"/><rect x="2" y="15" width="1" height="1" fill="#5fb04a"/><rect x="3" y="15" width="1" height="1" fill="#2f6f2a"/><rect x="4" y="15" width="1" height="1" fill="#5fb04a"/><rect x="7" y="15" width="1" height="1" fill="#5fb04a"/><rect x="8" y="15" width="1" height="1" fill="#2f6f2a"/><rect x="9" y="15" width="1" height="1" fill="#5fb04a"/></symbol><symbol id="mc-villager" viewBox="0 0 12 16" shape-rendering="crispEdges"><rect x="2" y="0" width="8" height="1" fill="#c9a07c"/><rect x="2" y="1" width="8" height="1" fill="#c9a07c"/><rect x="2" y="2" width="8" height="1" fill="#5a3a22"/><rect x="2" y="3" width="1" height="1" fill="#c9a07c"/><rect x="3" y="3" width="1" height="1" fill="#f4f4f4"/><rect x="4" y="3" width="1" height="1" fill="#2e8b57"/><rect x="5" y="3" width="2" height="1" fill="#c9a07c"/><rect x="7" y="3" width="1" height="1" fill="#2e8b57"/><rect x="8" y="3" width="1" height="1" fill="#f4f4f4"/><rect x="9" y="3" width="1" height="1" fill="#c9a07c"/><rect x="2" y="4" width="3" height="1" fill="#c9a07c"/><rect x="5" y="4" width="2" height="1" fill="#a97b58"/><rect x="7" y="4" width="3" height="1" fill="#c9a07c"/><rect x="2" y="5" width="3" height="1" fill="#c9a07c"/><rect x="5" y="5" width="2" height="1" fill="#a97b58"/><rect x="7" y="5" width="3" height="1" fill="#c9a07c"/><rect x="2" y="6" width="3" height="1" fill="#c9a07c"/><rect x="5" y="6" width="2" height="1" fill="#a97b58"/><rect x="7" y="6" width="3" height="1" fill="#c9a07c"/><rect x="2" y="7" width="8" height="1" fill="#c9a07c"/><rect x="2" y="8" width="8" height="1" fill="#6b4a2b"/><rect x="2" y="9" width="2" height="1" fill="#6b4a2b"/><rect x="4" y="9" width="1" height="1" fill="#5a3c22"/><rect x="5" y="9" width="2" height="1" fill="#6b4a2b"/><rect x="7" y="9" width="1" height="1" fill="#5a3c22"/><rect x="8" y="9" width="2" height="1" fill="#6b4a2b"/><rect x="2" y="10" width="8" height="1" fill="#8b5e34"/><rect x="2" y="11" width="1" height="1" fill="#8b5e34"/><rect x="3" y="11" width="1" height="1" fill="#6f4a28"/><rect x="4" y="11" width="4" height="1" fill="#8b5e34"/><rect x="8" y="11" width="1" height="1" fill="#6f4a28"/><rect x="9" y="11" width="1" height="1" fill="#8b5e34"/><rect x="2" y="12" width="8" height="1" fill="#6b4a2b"/><rect x="2" y="13" width="1" height="1" fill="#6b4a2b"/><rect x="3" y="13" width="1" height="1" fill="#5a3c22"/><rect x="4" y="13" width="4" height="1" fill="#6b4a2b"/><rect x="8" y="13" width="1" height="1" fill="#5a3c22"/><rect x="9" y="13" width="1" height="1" fill="#6b4a2b"/><rect x="2" y="14" width="8" height="1" fill="#6b4a2b"/><rect x="2" y="15" width="2" height="1" fill="#3d2a18"/><rect x="8" y="15" width="2" height="1" fill="#3d2a18"/></symbol><symbol id="mc-golem" viewBox="0 0 14 16" shape-rendering="crispEdges"><rect x="4" y="0" width="6" height="1" fill="#cfd2cf"/><rect x="4" y="1" width="1" height="1" fill="#cfd2cf"/><rect x="5" y="1" width="1" height="1" fill="#a9aea9"/><rect x="6" y="1" width="2" height="1" fill="#cfd2cf"/><rect x="8" y="1" width="1" height="1" fill="#a9aea9"/><rect x="9" y="1" width="1" height="1" fill="#cfd2cf"/><rect x="4" y="2" width="1" height="1" fill="#cfd2cf"/><rect x="5" y="2" width="1" height="1" fill="#222222"/><rect x="6" y="2" width="2" height="1" fill="#cfd2cf"/><rect x="8" y="2" width="1" height="1" fill="#222222"/><rect x="9" y="2" width="1" height="1" fill="#cfd2cf"/><rect x="4" y="3" width="2" height="1" fill="#cfd2cf"/><rect x="6" y="3" width="2" height="1" fill="#a8805f"/><rect x="8" y="3" width="2" height="1" fill="#cfd2cf"/><rect x="4" y="4" width="2" height="1" fill="#cfd2cf"/><rect x="6" y="4" width="2" height="1" fill="#a8805f"/><rect x="8" y="4" width="2" height="1" fill="#cfd2cf"/><rect x="4" y="5" width="1" height="1" fill="#cfd2cf"/><rect x="5" y="5" width="1" height="1" fill="#a9aea9"/><rect x="6" y="5" width="2" height="1" fill="#cfd2cf"/><rect x="8" y="5" width="1" height="1" fill="#a9aea9"/><rect x="9" y="5" width="1" height="1" fill="#cfd2cf"/><rect x="2" y="6" width="10" height="1" fill="#cfd2cf"/><rect x="0" y="7" width="2" height="1" fill="#cfd2cf"/><rect x="2" y="7" width="1" height="1" fill="#a9aea9"/><rect x="3" y="7" width="8" height="1" fill="#cfd2cf"/><rect x="11" y="7" width="1" height="1" fill="#a9aea9"/><rect x="12" y="7" width="2" height="1" fill="#cfd2cf"/><rect x="0" y="8" width="8" height="1" fill="#cfd2cf"/><rect x="8" y="8" width="2" height="1" fill="#5f8f4f"/><rect x="10" y="8" width="4" height="1" fill="#cfd2cf"/><rect x="0" y="9" width="1" height="1" fill="#cfd2cf"/><rect x="1" y="9" width="1" height="1" fill="#a9aea9"/><rect x="2" y="9" width="7" height="1" fill="#cfd2cf"/><rect x="9" y="9" width="1" height="1" fill="#5f8f4f"/><rect x="10" y="9" width="1" height="1" fill="#d63a2a"/><rect x="11" y="9" width="1" height="1" fill="#cfd2cf"/><rect x="12" y="9" width="1" height="1" fill="#a9aea9"/><rect x="13" y="9" width="1" height="1" fill="#cfd2cf"/><rect x="0" y="10" width="2" height="1" fill="#cfd2cf"/><rect x="4" y="10" width="6" height="1" fill="#cfd2cf"/><rect x="12" y="10" width="2" height="1" fill="#cfd2cf"/><rect x="0" y="11" width="2" height="1" fill="#cfd2cf"/><rect x="4" y="11" width="2" height="1" fill="#cfd2cf"/><rect x="6" y="11" width="1" height="1" fill="#a9aea9"/><rect x="7" y="11" width="3" height="1" fill="#cfd2cf"/><rect x="12" y="11" width="2" height="1" fill="#cfd2cf"/><rect x="0" y="12" width="2" height="1" fill="#a9aea9"/><rect x="4" y="12" width="2" height="1" fill="#cfd2cf"/><rect x="8" y="12" width="2" height="1" fill="#cfd2cf"/><rect x="12" y="12" width="2" height="1" fill="#a9aea9"/><rect x="4" y="13" width="2" height="1" fill="#cfd2cf"/><rect x="8" y="13" width="2" height="1" fill="#cfd2cf"/><rect x="4" y="14" width="2" height="1" fill="#cfd2cf"/><rect x="8" y="14" width="2" height="1" fill="#cfd2cf"/><rect x="4" y="15" width="2" height="1" fill="#7c817c"/><rect x="8" y="15" width="2" height="1" fill="#7c817c"/></symbol><symbol id="mc-chicken" viewBox="0 0 10 10" shape-rendering="crispEdges"><rect x="2" y="0" width="1" height="1" fill="#d63a2a"/><rect x="1" y="1" width="3" height="1" fill="#f2f2f2"/><rect x="1" y="2" width="1" height="1" fill="#f2f2f2"/><rect x="2" y="2" width="1" height="1" fill="#141414"/><rect x="3" y="2" width="1" height="1" fill="#f2f2f2"/><rect x="0" y="3" width="2" height="1" fill="#f0a020"/><rect x="2" y="3" width="1" height="1" fill="#f2f2f2"/><rect x="3" y="3" width="1" height="1" fill="#d63a2a"/><rect x="4" y="3" width="1" height="1" fill="#f2f2f2"/><rect x="1" y="4" width="6" height="1" fill="#f2f2f2"/><rect x="0" y="5" width="4" height="1" fill="#f2f2f2"/><rect x="4" y="5" width="2" height="1" fill="#d2d2d2"/><rect x="6" y="5" width="2" height="1" fill="#f2f2f2"/><rect x="0" y="6" width="3" height="1" fill="#f2f2f2"/><rect x="3" y="6" width="3" height="1" fill="#d2d2d2"/><rect x="6" y="6" width="3" height="1" fill="#f2f2f2"/><rect x="1" y="7" width="7" height="1" fill="#f2f2f2"/><rect x="2" y="8" width="1" height="1" fill="#e0a030"/><rect x="5" y="8" width="1" height="1" fill="#e0a030"/><rect x="2" y="9" width="1" height="1" fill="#e0a030"/><rect x="5" y="9" width="1" height="1" fill="#e0a030"/></symbol><symbol id="neo-star" viewBox="0 0 100 100"><g stroke="#1b1b2f" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"><polygon points="50.0,10.0 61.2,38.6 91.8,40.4 68.1,59.9 75.9,89.6 50.0,73.0 24.1,89.6 31.9,59.9 8.2,40.4 38.8,38.6" fill="#ffd23f"/><circle cx="41" cy="54" r="3.6" fill="#1b1b2f" stroke="none"/><circle cx="59" cy="54" r="3.6" fill="#1b1b2f" stroke="none"/><path d="M43 63 Q50 70 57 63" fill="none" stroke-width="3.6"/><circle cx="35" cy="62" r="4" fill="#ff8fa3" stroke="none"/><circle cx="65" cy="62" r="4" fill="#ff8fa3" stroke="none"/></g></symbol><symbol id="neo-cat" viewBox="0 0 100 100"><g stroke="#1b1b2f" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"><path d="M17 46 L15 12 L41 29 Z" fill="#ff9f43"/><path d="M83 46 L85 12 L59 29 Z" fill="#ff9f43"/><ellipse cx="50" cy="58" rx="37" ry="32" fill="#ff9f43"/><path d="M44 34 L44 42 M50 32 L50 40 M56 34 L56 42" fill="none" stroke-width="3.6"/><circle cx="36" cy="56" r="4.6" fill="#1b1b2f" stroke="none"/><circle cx="64" cy="56" r="4.6" fill="#1b1b2f" stroke="none"/><path d="M46 64 L54 64 L50 69 Z" fill="#ff7aa8" stroke-width="3"/><path d="M50 69 L50 72 M43 74 Q50 79 57 74" fill="none" stroke-width="3.4"/><path d="M21 64 L8 62 M21 70 L9 75 M79 64 L92 62 M79 70 L91 75" fill="none" stroke-width="3.4"/></g></symbol><symbol id="neo-coin" viewBox="0 0 100 100"><g stroke="#1b1b2f" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"><circle cx="50" cy="52" r="41" fill="#ffc83d"/><circle cx="50" cy="52" r="30" fill="#ffdd6b" stroke-width="3.4"/><circle cx="41" cy="47" r="3.8" fill="#1b1b2f" stroke="none"/><circle cx="59" cy="47" r="3.8" fill="#1b1b2f" stroke="none"/><path d="M40 58 Q50 69 60 58" fill="none" stroke-width="3.8"/><path d="M26 30 Q33 22 43 20" fill="none" stroke="#ffffff" stroke-width="4"/></g></symbol><symbol id="mc-flower-r" viewBox="0 0 8 10" shape-rendering="crispEdges"><rect x="3" y="4" width="2" height="6" fill="#3f7a1c"/><rect x="1" y="7" width="2" height="1" fill="#5d9b2f"/><rect x="5" y="6" width="2" height="1" fill="#5d9b2f"/><rect x="2" y="0" width="4" height="4" fill="#d63a2a"/><rect x="1" y="1" width="6" height="2" fill="#d63a2a"/><rect x="3" y="1" width="2" height="2" fill="#f7d51d"/></symbol><symbol id="mc-flower-y" viewBox="0 0 8 10" shape-rendering="crispEdges"><rect x="3" y="4" width="2" height="6" fill="#3f7a1c"/><rect x="1" y="7" width="2" height="1" fill="#5d9b2f"/><rect x="5" y="6" width="2" height="1" fill="#5d9b2f"/><rect x="2" y="0" width="4" height="4" fill="#f7d51d"/><rect x="1" y="1" width="6" height="2" fill="#f7d51d"/><rect x="3" y="1" width="2" height="2" fill="#e08a10"/></symbol><symbol id="mc-zombie" viewBox="0 0 12 16" shape-rendering="crispEdges"><rect x="2" y="0" width="8" height="6" fill="#6aa84f"/><rect x="3" y="3" width="2" height="1" fill="#1a1a1a"/><rect x="7" y="3" width="2" height="1" fill="#1a1a1a"/><rect x="4" y="5" width="4" height="1" fill="#3f6b2d"/><rect x="2" y="6" width="8" height="5" fill="#2aa5a5"/><rect x="0" y="6" width="2" height="5" fill="#6aa84f"/><rect x="10" y="6" width="2" height="5" fill="#6aa84f"/><rect x="2" y="11" width="4" height="5" fill="#3b3f9e"/><rect x="6" y="11" width="4" height="5" fill="#3b3f9e"/><rect x="2" y="15" width="4" height="1" fill="#26296b"/><rect x="6" y="15" width="4" height="1" fill="#26296b"/></symbol><symbol id="mc-tree" viewBox="0 0 12 12" shape-rendering="crispEdges"><rect x="3" y="0" width="6" height="1" fill="#5fb04a"/><rect x="1" y="1" width="10" height="1" fill="#4f9f36"/><rect x="0" y="2" width="12" height="3" fill="#3f8f2a"/><rect x="1" y="5" width="10" height="1" fill="#2f7a1f"/><rect x="3" y="6" width="6" height="1" fill="#2f6e1f"/><rect x="2" y="2" width="2" height="1" fill="#5fb04a"/><rect x="7" y="3" width="2" height="1" fill="#5fb04a"/><rect x="3" y="4" width="2" height="1" fill="#2f6e1f"/><rect x="5" y="7" width="2" height="5" fill="#6b4a2b"/><rect x="6" y="7" width="1" height="5" fill="#5a3c22"/></symbol><symbol id="mc-house" viewBox="0 0 16 14" shape-rendering="crispEdges"><rect x="5" y="0" width="6" height="1" fill="#6b4a2b"/><rect x="3" y="1" width="10" height="1" fill="#7a5536"/><rect x="1" y="2" width="14" height="1" fill="#6b4a2b"/><rect x="0" y="3" width="16" height="1" fill="#5a3c22"/><rect x="1" y="4" width="14" height="7" fill="#b98a55"/><rect x="1" y="7" width="14" height="1" fill="#a97c50"/><rect x="7" y="7" width="2" height="4" fill="#5a3c22"/><rect x="3" y="6" width="2" height="2" fill="#9fd0e8"/><rect x="11" y="6" width="2" height="2" fill="#9fd0e8"/><rect x="1" y="11" width="14" height="3" fill="#8a8a8a"/><rect x="3" y="12" width="2" height="1" fill="#6f6f6f"/><rect x="9" y="11" width="2" height="1" fill="#6f6f6f"/></symbol><symbol id="mc-bird" viewBox="0 0 8 4" shape-rendering="crispEdges"><rect x="0" y="0" width="1" height="1" fill="#2a2a2a"/><rect x="7" y="0" width="1" height="1" fill="#2a2a2a"/><rect x="1" y="1" width="1" height="1" fill="#2a2a2a"/><rect x="6" y="1" width="1" height="1" fill="#2a2a2a"/><rect x="2" y="2" width="1" height="1" fill="#2a2a2a"/><rect x="5" y="2" width="1" height="1" fill="#2a2a2a"/><rect x="3" y="3" width="2" height="1" fill="#2a2a2a"/></symbol><symbol id="mc-dolphin" viewBox="0 0 16 8" shape-rendering="crispEdges"><rect x="3" y="2" width="9" height="4" fill="#5f86ab"/><rect x="12" y="3" width="2" height="2" fill="#5f86ab"/><rect x="14" y="4" width="2" height="1" fill="#7fa3c2"/><rect x="6" y="0" width="2" height="2" fill="#4a6f93"/><rect x="1" y="3" width="2" height="2" fill="#5f86ab"/><rect x="0" y="1" width="1" height="2" fill="#4a6f93"/><rect x="0" y="5" width="1" height="2" fill="#4a6f93"/><rect x="4" y="5" width="8" height="1" fill="#d8e6f2"/><rect x="12" y="3" width="1" height="1" fill="#111111"/></symbol><symbol id="mc-fish" viewBox="0 0 8 5" shape-rendering="crispEdges"><rect x="2" y="1" width="5" height="3" fill="#f0a030"/><rect x="0" y="0" width="2" height="1" fill="#e8853a"/><rect x="1" y="1" width="1" height="1" fill="#e8853a"/><rect x="1" y="3" width="1" height="1" fill="#e8853a"/><rect x="0" y="4" width="2" height="1" fill="#e8853a"/><rect x="4" y="1" width="1" height="3" fill="#ffffff"/><rect x="6" y="1" width="1" height="1" fill="#111111"/></symbol><symbol id="mc-dragon-a" viewBox="0 0 24 13" shape-rendering="crispEdges"><rect x="6" y="5" width="10" height="3" fill="#22222b"/><rect x="7" y="7" width="8" height="1" fill="#3a3a46"/><rect x="2" y="6" width="4" height="2" fill="#22222b"/><rect x="0" y="7" width="2" height="1" fill="#22222b"/><rect x="16" y="4" width="3" height="3" fill="#22222b"/><rect x="19" y="3" width="5" height="4" fill="#2a2a35"/><rect x="21" y="4" width="1" height="1" fill="#e040fb"/><rect x="20" y="6" width="4" height="1" fill="#14141a"/><rect x="20" y="2" width="1" height="1" fill="#5b5b66"/><rect x="22" y="2" width="1" height="1" fill="#5b5b66"/><rect x="8" y="4" width="1" height="1" fill="#3a3a46"/><rect x="9" y="3" width="1" height="1" fill="#3a3a46"/><rect x="10" y="2" width="1" height="1" fill="#3a3a46"/><rect x="11" y="1" width="1" height="1" fill="#3a3a46"/><rect x="12" y="0" width="1" height="1" fill="#3a3a46"/><rect x="9" y="4" width="4" height="1" fill="#17171f"/><rect x="10" y="3" width="3" height="1" fill="#17171f"/><rect x="11" y="2" width="2" height="1" fill="#17171f"/><rect x="13" y="4" width="1" height="1" fill="#3a3a46"/><rect x="14" y="3" width="1" height="1" fill="#3a3a46"/><rect x="15" y="2" width="1" height="1" fill="#3a3a46"/><rect x="16" y="1" width="1" height="1" fill="#3a3a46"/><rect x="17" y="0" width="1" height="1" fill="#3a3a46"/><rect x="14" y="4" width="4" height="1" fill="#17171f"/><rect x="15" y="3" width="3" height="1" fill="#17171f"/><rect x="16" y="2" width="2" height="1" fill="#17171f"/></symbol><symbol id="mc-dragon-b" viewBox="0 0 24 13" shape-rendering="crispEdges"><rect x="6" y="5" width="10" height="3" fill="#22222b"/><rect x="7" y="7" width="8" height="1" fill="#3a3a46"/><rect x="2" y="6" width="4" height="2" fill="#22222b"/><rect x="0" y="7" width="2" height="1" fill="#22222b"/><rect x="16" y="4" width="3" height="3" fill="#22222b"/><rect x="19" y="3" width="5" height="4" fill="#2a2a35"/><rect x="21" y="4" width="1" height="1" fill="#e040fb"/><rect x="20" y="6" width="4" height="1" fill="#14141a"/><rect x="20" y="2" width="1" height="1" fill="#5b5b66"/><rect x="22" y="2" width="1" height="1" fill="#5b5b66"/><rect x="8" y="8" width="1" height="1" fill="#3a3a46"/><rect x="9" y="9" width="1" height="1" fill="#3a3a46"/><rect x="10" y="10" width="1" height="1" fill="#3a3a46"/><rect x="11" y="11" width="1" height="1" fill="#3a3a46"/><rect x="12" y="12" width="1" height="1" fill="#3a3a46"/><rect x="9" y="8" width="4" height="1" fill="#17171f"/><rect x="10" y="9" width="3" height="1" fill="#17171f"/><rect x="11" y="10" width="2" height="1" fill="#17171f"/><rect x="13" y="8" width="1" height="1" fill="#3a3a46"/><rect x="14" y="9" width="1" height="1" fill="#3a3a46"/><rect x="15" y="10" width="1" height="1" fill="#3a3a46"/><rect x="16" y="11" width="1" height="1" fill="#3a3a46"/><rect x="17" y="12" width="1" height="1" fill="#3a3a46"/><rect x="14" y="8" width="4" height="1" fill="#17171f"/><rect x="15" y="9" width="3" height="1" fill="#17171f"/><rect x="16" y="10" width="2" height="1" fill="#17171f"/></symbol><symbol id="mc-enderman" viewBox="0 0 6 20" shape-rendering="crispEdges"><rect x="1" y="0" width="4" height="4" fill="#161616"/><rect x="2" y="1" width="2" height="1" fill="#2a2a2a"/><rect x="1" y="2" width="1" height="1" fill="#cc66ff"/><rect x="4" y="2" width="1" height="1" fill="#cc66ff"/><rect x="1" y="4" width="4" height="6" fill="#1c1c1c"/><rect x="0" y="4" width="1" height="10" fill="#161616"/><rect x="5" y="4" width="1" height="10" fill="#161616"/><rect x="1" y="10" width="2" height="10" fill="#161616"/><rect x="3" y="10" width="2" height="10" fill="#161616"/></symbol><symbol id="mc-pillar" viewBox="0 0 6 16" shape-rendering="crispEdges"><rect x="1" y="0" width="4" height="4" fill="#ff4fd8"/><rect x="2" y="1" width="2" height="2" fill="#ffd0f7"/><rect x="2" y="4" width="2" height="1" fill="#c236a8"/><rect x="0" y="5" width="6" height="11" fill="#1b1230"/><rect x="0" y="5" width="6" height="1" fill="#2a1b4a"/><rect x="1" y="7" width="1" height="1" fill="#3d2a63"/><rect x="4" y="10" width="1" height="1" fill="#3d2a63"/><rect x="2" y="13" width="1" height="1" fill="#3d2a63"/></symbol><symbol id="mc-flame" viewBox="0 0 14 6" shape-rendering="crispEdges"><rect x="0" y="2" width="3" height="2" fill="#ffe14a"/><rect x="3" y="1" width="3" height="4" fill="#ff9f1c"/><rect x="6" y="0" width="4" height="6" fill="#ff5a1f"/><rect x="10" y="1" width="3" height="4" fill="#e03a10"/><rect x="13" y="2" width="1" height="2" fill="#7a1f10"/><rect x="4" y="2" width="2" height="2" fill="#ffe14a"/></symbol></defs></svg>

    <!-- ================= HALAMAN LOGIN ================= -->
    <div class="login-page" id="login-page">
        <div class="login-liquid" aria-hidden="true">
            <span class="lq lq-1"></span>
            <span class="lq lq-2"></span>
            <span class="lq lq-3"></span>
            <span class="lq lq-4"></span>
            <span class="lq lq-cursor" id="login-cursor-blob"></span>
        </div>
        <div class="login-deco login-deco-left" aria-hidden="true">
            <svg class="stk stk-mc" viewBox="0 0 14 16" aria-hidden="true"><use href="#mc-golem"/></svg>
        </div>
        <div class="login-deco login-deco-right" aria-hidden="true">
            <svg class="stk stk-mc" viewBox="0 0 12 16" aria-hidden="true"><use href="#mc-villager"/></svg>
        </div>
        <div class="login-box">
            <div class="login-deco-perch" aria-hidden="true">
                <svg class="stk stk-mc" viewBox="0 0 12 16" aria-hidden="true"><use href="#mc-creeper"/></svg>
            </div>
            <div class="login-brand">
                <span class="brand-dot"></span>
                <span class="brand-title">Cashflow Studio</span>
            </div>
            <p class="login-subtitle">Masuk untuk mengakses workspace keuangan Anda</p>

            <form id="login-form" onsubmit="handleLogin(event)">
                <div class="login-theme" id="login-theme">
                    <span class="login-theme-label" id="login-theme-label">Pilih tema tampilan <span class="req" aria-hidden="true">*</span></span>
                    <div class="login-theme-grid" role="radiogroup" aria-labelledby="login-theme-label" aria-required="true">
                        <button type="button" class="login-theme-card" role="radio" aria-checked="false" data-login-theme="light" onclick="pickLoginTheme('light')"><span class="theme-swatch swatch-light"><i></i><i></i></span>Terang</button>
                        <button type="button" class="login-theme-card" role="radio" aria-checked="false" data-login-theme="reference" onclick="pickLoginTheme('reference')"><span class="theme-swatch swatch-reference"><i></i><i></i></span>Referensi</button>
                        <button type="button" class="login-theme-card" role="radio" aria-checked="false" data-login-theme="dark" onclick="pickLoginTheme('dark')"><span class="theme-swatch swatch-dark"><i></i><i></i></span>Gelap</button>
                        <button type="button" class="login-theme-card" role="radio" aria-checked="false" data-login-theme="cartoon" onclick="pickLoginTheme('cartoon')"><span class="theme-swatch swatch-cartoon"><i></i><i></i></span>Neoabstrak</button>
                        <button type="button" class="login-theme-card" role="radio" aria-checked="false" data-login-theme="minecraft" onclick="pickLoginTheme('minecraft')"><span class="theme-swatch swatch-minecraft"><i></i><i></i></span>Minecraft</button>
                    </div>
                    <div class="login-theme-palette" id="login-palette" hidden>
                        <span class="palette-label">Warna tema Neoabstrak: <b id="login-palette-name">Kuning</b></span>
                        <div class="palette-row" role="radiogroup" aria-label="Warna tema Neoabstrak">
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Kuning" title="Kuning" data-palette-value="kuning" style="--sw-bg:#ffe27a;--sw-pr:#2f6bff" onclick="setPalette('kuning')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Pink" title="Pink" data-palette-value="pink" style="--sw-bg:#ffb8d6;--sw-pr:#e0337f" onclick="setPalette('pink')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Mint" title="Mint" data-palette-value="mint" style="--sw-bg:#9ee8c6;--sw-pr:#0f9d6b" onclick="setPalette('mint')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Lavender" title="Lavender" data-palette-value="lavender" style="--sw-bg:#cbb8ff;--sw-pr:#6d3bff" onclick="setPalette('lavender')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Oranye" title="Oranye" data-palette-value="oranye" style="--sw-bg:#ffc08a;--sw-pr:#f2600c" onclick="setPalette('oranye')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Malam" title="Malam" data-palette-value="gelap" style="--sw-bg:#232741;--sw-pr:#8ea2ff" onclick="setPalette('gelap')"></button>
                        </div>
                    </div>
                    <div class="login-theme-palette" id="login-mc-palette" hidden>
                        <span class="palette-label">Warna tema Minecraft: <b id="login-mc-palette-name">Rumput</b></span>
                        <div class="palette-row" role="radiogroup" aria-label="Warna tema Minecraft">
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Rumput" title="Rumput" data-mc-palette-value="rumput" style="--sw-bg:#b9e38c;--sw-pr:#4f8f25" onclick="setMcPalette('rumput')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Langit" title="Langit" data-mc-palette-value="langit" style="--sw-bg:#a7dcff;--sw-pr:#2f86c4" onclick="setMcPalette('langit')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Pasir" title="Pasir" data-mc-palette-value="pasir" style="--sw-bg:#f0dc9f;--sw-pr:#c2710c" onclick="setMcPalette('pasir')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Sakura" title="Sakura" data-mc-palette-value="sakura" style="--sw-bg:#ffd3e6;--sw-pr:#d6477f" onclick="setMcPalette('sakura')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Kayu" title="Kayu" data-mc-palette-value="kayu" style="--sw-bg:#cfa874;--sw-pr:#5d9b2f" onclick="setMcPalette('kayu')"></button>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="login-username" class="form-input" placeholder="Masukkan username" required autocomplete="username">
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <div class="password-field">
                        <input type="password" id="login-password" class="form-input" placeholder="Masukkan password" required autocomplete="current-password">
                        <button type="button" class="btn-eye" id="btn-toggle-password" onclick="togglePasswordVisibility()" aria-label="Tampilkan password" aria-pressed="false" title="Tampilkan password">
                            <svg class="eye-on" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
                            <svg class="eye-off" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="m2 2 20 20"/></svg>
                        </button>
                    </div>
                </div>
                <button type="submit" class="btn-login">Masuk</button>
                <p class="login-error" id="login-error"></p>
            </form>
        </div>
    </div>

    <!-- ================= APP SHELL ================= -->
    <div class="app-shell" id="app-shell">

    <!-- Overlay Latar Belakang Mobile -->
    <div class="sidebar-overlay" onclick="toggleSidebar()"></div>

    <!-- Topbar -->
    <header class="top-header">
        <div class="header-left">
            <button class="btn-toggle-sidebar" onclick="toggleSidebar()" aria-label="Buka/tutup menu">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="14" y2="18"/></svg>
            </button>
            <label class="header-search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="search" id="global-search" placeholder="Cari transaksi, lalu tekan Enter" onkeydown="handleGlobalSearch(event)" aria-label="Cari transaksi">
            </label>
        </div>

        <div class="header-right">

            <div class="theme-switcher">
                <button class="btn-theme-toggle" onclick="toggleThemeMenu(event)" aria-label="Pilih tema tampilan" aria-haspopup="true" aria-expanded="false" id="btn-theme-toggle" title="Pilih tema">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7H16c3 0 5.5-2.5 5.5-5.5C21.5 6 17.2 2 12 2z"/></svg>
                </button>
                <div class="theme-menu" id="theme-menu" role="menu" hidden>
                    <button type="button" class="theme-option" role="menuitemradio" data-theme-value="light" onclick="setTheme('light')">
                        <span class="theme-swatch swatch-light"><i></i><i></i></span><span class="theme-name">Terang</span>
                    </button>
                    <button type="button" class="theme-option" role="menuitemradio" data-theme-value="reference" onclick="setTheme('reference')">
                        <span class="theme-swatch swatch-reference"><i></i><i></i></span><span class="theme-name">Referensi</span>
                    </button>
                    <button type="button" class="theme-option" role="menuitemradio" data-theme-value="dark" onclick="setTheme('dark')">
                        <span class="theme-swatch swatch-dark"><i></i><i></i></span><span class="theme-name">Gelap</span>
                    </button>
                    <button type="button" class="theme-option" role="menuitemradio" data-theme-value="cartoon" onclick="setTheme('cartoon')">
                        <span class="theme-swatch swatch-cartoon"><i></i><i></i></span><span class="theme-name">Neoabstrak</span>
                    </button>
                    <div class="theme-menu-palette" id="theme-menu-palette" hidden>
                        <span class="palette-label">Warna: <b id="menu-palette-name">Kuning</b></span>
                        <div class="palette-row" role="radiogroup" aria-label="Warna tema Neoabstrak">
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Kuning" title="Kuning" data-palette-value="kuning" style="--sw-bg:#ffe27a;--sw-pr:#2f6bff" onclick="setPalette('kuning')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Pink" title="Pink" data-palette-value="pink" style="--sw-bg:#ffb8d6;--sw-pr:#e0337f" onclick="setPalette('pink')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Mint" title="Mint" data-palette-value="mint" style="--sw-bg:#9ee8c6;--sw-pr:#0f9d6b" onclick="setPalette('mint')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Lavender" title="Lavender" data-palette-value="lavender" style="--sw-bg:#cbb8ff;--sw-pr:#6d3bff" onclick="setPalette('lavender')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Oranye" title="Oranye" data-palette-value="oranye" style="--sw-bg:#ffc08a;--sw-pr:#f2600c" onclick="setPalette('oranye')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Malam" title="Malam" data-palette-value="gelap" style="--sw-bg:#232741;--sw-pr:#8ea2ff" onclick="setPalette('gelap')"></button>
                        </div>
                    </div>
                    <button type="button" class="theme-option" role="menuitemradio" data-theme-value="minecraft" onclick="setTheme('minecraft')">
                        <span class="theme-swatch swatch-minecraft"><i></i><i></i></span><span class="theme-name">Minecraft</span>
                    </button>
                    <div class="theme-menu-palette" id="theme-menu-mc-palette" hidden>
                        <span class="palette-label">Warna: <b id="menu-mc-palette-name">Rumput</b></span>
                        <div class="palette-row" role="radiogroup" aria-label="Warna tema Minecraft">
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Rumput" title="Rumput" data-mc-palette-value="rumput" style="--sw-bg:#b9e38c;--sw-pr:#4f8f25" onclick="setMcPalette('rumput')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Langit" title="Langit" data-mc-palette-value="langit" style="--sw-bg:#a7dcff;--sw-pr:#2f86c4" onclick="setMcPalette('langit')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Pasir" title="Pasir" data-mc-palette-value="pasir" style="--sw-bg:#f0dc9f;--sw-pr:#c2710c" onclick="setMcPalette('pasir')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Sakura" title="Sakura" data-mc-palette-value="sakura" style="--sw-bg:#ffd3e6;--sw-pr:#d6477f" onclick="setMcPalette('sakura')"></button>
                            <button type="button" class="palette-option" role="radio" aria-checked="false" aria-label="Kayu" title="Kayu" data-mc-palette-value="kayu" style="--sw-bg:#cfa874;--sw-pr:#5d9b2f" onclick="setMcPalette('kayu')"></button>
                        </div>
                    </div>
                </div>
            </div>

            <?php $ckJumlahAlertHeader = count(ckBuildResponse($dbCeklis, '', 'ALL', 'ALL')['alerts']); ?>
            <button class="btn-bell" onclick="navigateTo('ceklis')" aria-label="Pengingat jatuh tempo" title="Pengingat jatuh tempo">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <span class="bell-dot" id="bell-dot" <?= $ckJumlahAlertHeader > 0 ? '' : 'hidden' ?>></span>
            </button>

            <div class="profile-chip">
                <div class="profile-avatar" aria-hidden="true">A</div>
                <div class="profile-text">
                    <span class="profile-name">Admin</span>
                    <span class="profile-sub" id="profile-toko"></span>
                </div>
            </div>
        </div>
    </header>

<aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
        <div class="app-brand">
            <span class="brand-dot"></span>
            <span class="brand-title">Cashflow Studio</span>
        </div>
    </div>

    <div class="sidebar-menu">
        <div class="menu-label">MENU UTAMA</div>
        
        <!-- Dashboard -->
        <button class="menu-btn active" id="nav-dashboard" onclick="navigateTo('dashboard')">
            <svg class="menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
            <span class="menu-text">Dashboard</span>
        </button>

        <!-- Riwayat Transaksi (Parent, punya sub-menu) -->
        <div class="menu-group" id="menu-group-transaksi">
            <button class="menu-btn has-submenu" id="nav-transaksi" onclick="handleParentMenuClick('transaksi')">
                <svg class="menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/></svg>
                <span class="menu-text">Riwayat Transaksi</span>
                <svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>

            <!-- Sub Menu Bersarang (Geser Ke Kanan) -->
            <div class="sub-menu-container">
                <button class="menu-btn sub-menu-btn" id="nav-setoran" onclick="navigateTo('setoran')">
                    <svg class="menu-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg>
                    <span class="menu-text">Setoran</span>
                </button>
            </div>
        </div>

        <!-- Antrean Validasi -->
        <button class="menu-btn" id="nav-master" onclick="navigateTo('master')">
            <svg class="menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6l8-3 8 3z"/><path d="m9 12 2 2 4-4"/></svg>
            <span class="menu-text">Antrean Validasi</span>
        </button>

        <div class="menu-label">LAPORAN &amp; CATATAN</div>
        <!-- Laporan (Parent, punya sub-menu) -->
        <div class="menu-group" id="menu-group-laporan-periode">
            <button class="menu-btn has-submenu" id="nav-laporan-periode" onclick="handleParentMenuClick('laporan-periode')">
                <svg class="menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <path d="M9 17v-3"></path>
                    <path d="M12 17v-6"></path>
                    <path d="M15 17v-2"></path>
                </svg>
                <span class="menu-text">Laporan</span>
                <svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </button>

            <!-- Sub Menu Laporan: Ketepatan Bayar & Pengeluaran ALL -->
            <div class="sub-menu-container">
                <button class="menu-btn sub-menu-btn" id="nav-laporan-ketepatan" onclick="navigateTo('laporan-ketepatan')">
                    <svg class="menu-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>
                    <span class="menu-text">Ketepatan Bayar</span>
                </button>

                <button class="menu-btn sub-menu-btn" id="nav-pengeluaran-all" onclick="navigateTo('pengeluaran-all')">
                    <svg class="menu-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>
                    <span class="menu-text">Pengeluaran ALL</span>
                </button>

                <button class="menu-btn sub-menu-btn" id="nav-archive" onclick="navigateTo('archive')">
                    <svg class="menu-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>
                    <span class="menu-text">Archive</span>
                </button>

                <button class="menu-btn sub-menu-btn" id="nav-rekap-bank" onclick="navigateTo('rekap-bank')">
                    <svg class="menu-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2H10a2 2 0 0 0-2 2v16"/></svg>
                    <span class="menu-text">Rekap Bank</span>
                </button>
            </div>
        </div>
        
        <!-- Ceklis Pengambilan -->
<button class="menu-btn" id="nav-ceklis" onclick="navigateTo('ceklis')">
    <svg class="menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
    <span class="menu-text">Checklist</span>
</button>


</div>

    <div class="sidebar-bottom">
        <div class="sidebar-stickers" aria-hidden="true">
            <svg class="stk stk-mc" viewBox="0 0 12 16" aria-hidden="true"><use href="#mc-villager"/></svg>
            <svg class="stk stk-mc" viewBox="0 0 14 16" aria-hidden="true"><use href="#mc-golem"/></svg>
            <svg class="stk stk-mc" viewBox="0 0 10 10" aria-hidden="true"><use href="#mc-chicken"/></svg>
        </div>
        <button class="btn-logout" onclick="handleLogout()" aria-label="Keluar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span>Keluar</span>
        </button>
    </div>

</aside>



    <!-- Main Content -->
    <main class="main-content">

        <!-- PAGE 1: DASHBOARD -->
        <section id="page-dashboard" class="page-view active">
            <div class="page-header">
                <h2>Ringkasan Keuangan</h2>
                <p>Monitor pemasukan, pengeluaran, dan saldo bersih Anda.</p>
                <div class="mode-toggle" data-page="dashboard">
                    <button type="button" class="mode-btn active" data-mode="cash" onclick="setDataMode('cash')">Cash</button>
                    <button type="button" class="mode-btn" data-mode="cashflow" onclick="setDataMode('cashflow')">Cashflow</button>
                </div>
            </div>

            <div id="dashboard-cash-view">
            <div class="metrics-grid metrics-5">
                <div class="card-stat">
                    <div class="stat-header"><span>Pemasukan</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="stat-pemasukan">Rp 0</div>
                    <div class="stat-desc">Kas masuk</div>
                </div>

                <div class="card-stat">
                    <div class="stat-header"><span>Pengeluaran</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="stat-pengeluaran">Rp 0</div>
                    <div class="stat-desc">Kas keluar</div>
                </div>

                <div class="card-stat has-spark">
                    <div class="stat-header"><span>Saldo Bersih</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="stat-saldo">Rp 0</div>
                    <div class="stat-desc">Selisih bersih</div>
                    <div class="stat-spark"><canvas id="chartSpark"></canvas></div>
                </div>

                <div class="card-stat">
                    <div class="stat-header"><span>Cash Ter-setor</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="stat-setor">Rp 0</div>
                    <div class="stat-desc">Sudah masuk bank</div>
                </div>

                <div class="card-stat">
                    <div class="stat-header"><span>Cash Kantor</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="stat-cash-kantor">Rp 0</div>
                    <div class="stat-desc">Belum tersetor</div>
                </div>
            </div>

            <div class="dash-row">
                <div class="chart-card">
                    <div class="chart-header-flex">
                        <div>
                            <h4>Laporan Kas</h4>
                            <p>Pemasukan vs pengeluaran</p>
                        </div>
                        <div class="chart-tools">
                            <input type="month" id="filter-bulan-cash-chart" class="form-control" value="<?= date('Y-m') ?>" onchange="renderDashboardChart(globalIn || [], globalOut || [])">
                            <div class="mode-toggle" data-page="cash-chart">
                                <button type="button" class="mode-btn active" data-mode="mingguan" onclick="setCashChartMode('mingguan')">Mingguan</button>
                                <button type="button" class="mode-btn" data-mode="harian" onclick="setCashChartMode('harian')">Harian</button>
                            </div>
                        </div>
                    </div>
                    <div class="chart-box">
                        <canvas id="chartTrend"></canvas>
                    </div>
                </div>

                <div class="chart-card">
                    <div class="chart-header">
                        <h4>Komposisi Kas</h4>
                        <p>Ke mana pemasukan mengalir</p>
                    </div>
                    <div class="donut-wrap">
                        <div class="donut-canvas-box">
                            <canvas id="chartDonut"></canvas>
                            <div class="donut-center">
                                <strong id="donut-total">Rp 0</strong>
                                <span>Total pemasukan</span>
                            </div>
                        </div>
                        <div class="donut-legend">
                            <div class="donut-legend-item"><strong id="donut-val-setor">Rp 0</strong><span><i class="dot-in-2"></i>Ter-setor</span></div>
                            <div class="donut-legend-item"><strong id="donut-val-kantor">Rp 0</strong><span><i class="dot-in"></i>Cash kantor</span></div>
                            <div class="donut-legend-item"><strong id="donut-val-keluar">Rp 0</strong><span><i class="dot-out"></i>Pengeluaran</span></div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="dash-row dash-row-table">
                <div class="table-card">
                    <div class="chart-header">
                        <h4>Transaksi Terbaru</h4>
                        <p>5 transaksi pemasukan/pengeluaran paling baru</p>
                    </div>
                    <div class="table-responsive">
                        <table class="table-recent">
                            <thead>
                                <tr>
                                    <th>Tanggal</th>
                                    <th>Tipe</th>
                                    <th>Kategori</th>
                                    <th>Keterangan</th>
                                    <th class="text-right">Nominal</th>
                                </tr>
                            </thead>
                            <tbody id="tbody-recent-transaksi">
                                <tr><td colspan="5" class="text-center cell-loading">Memuat transaksi terbaru...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="chart-card">
                    <div class="chart-header">
                        <h4>Kategori Pemasukan Teratas</h4>
                        <p>Berdasarkan total nominal</p>
                    </div>
                    <div class="cat-total" id="cat-total">Rp 0</div>
                    <div class="cat-total-sub">Total pemasukan</div>
                    <div class="cat-list" id="cat-list">
                        <div class="cat-empty">Memuat kategori...</div>
                    </div>
                </div>
            </div>
            </div>
            <!-- /dashboard-cash-view -->

            <div id="dashboard-cashflow-view" style="display:none;">
            <div class="metrics-grid metrics-5">
                <div class="card-stat">
                    <div class="stat-header"><span>Pemasukan</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="cf-stat-pemasukan">Rp 0</div>
                    <div class="stat-desc" id="cf-stat-pemasukan-desc">0 pembayaran</div>
                </div>

                <div class="card-stat">
                    <div class="stat-header"><span>Pengeluaran</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="cf-stat-pengeluaran">Rp 0</div>
                    <div class="stat-desc" id="cf-stat-pengeluaran-desc">Kas keluar</div>
                </div>

                <div class="card-stat has-spark">
                    <div class="stat-header"><span>Saldo Bersih</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="cf-stat-saldo">Rp 0</div>
                    <div class="stat-desc">Pemasukan − pengeluaran</div>
                    <div class="stat-spark"><canvas id="chartCashflowSpark"></canvas></div>
                </div>

                <div class="card-stat">
                    <div class="stat-header"><span>Via Cash</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="cf-stat-nominal-cash">Rp 0</div>
                    <div class="stat-desc">Dibayar tunai</div>
                </div>

                <div class="card-stat">
                    <div class="stat-header"><span>Via Transfer</span><div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div></div>
                    <div class="stat-value" id="cf-stat-nominal-transfer">Rp 0</div>
                    <div class="stat-desc">Dibayar non-tunai</div>
                </div>
            </div>

            <div class="dash-row">
                <div class="chart-card">
                    <div class="chart-header-flex">
                        <div>
                            <h4>Tren Arus Kas</h4>
                            <p id="cf-periode-label">Pemasukan (Cash &amp; Transfer) vs pengeluaran</p>
                        </div>
                        <div class="chart-tools">
                            <input type="month" id="filter-bulan-cashflow-chart" class="form-control" value="<?= date('Y-m') ?>" onchange="renderCashflowDashboard()">
                            <div class="mode-toggle" data-page="cashflow-chart">
                                <button type="button" class="mode-btn active" data-mode="mingguan" onclick="setCashflowChartMode('mingguan')">Mingguan</button>
                                <button type="button" class="mode-btn" data-mode="harian" onclick="setCashflowChartMode('harian')">Harian</button>
                            </div>
                        </div>
                    </div>
                    <div class="chart-box">
                        <canvas id="chartCashflowTrend"></canvas>
                    </div>
                </div>

                <div class="chart-card">
                    <div class="chart-header">
                        <h4>Komposisi Arus Kas</h4>
                        <p>Cash, transfer, dan pengeluaran</p>
                    </div>
                    <div class="donut-wrap">
                        <div class="donut-canvas-box">
                            <canvas id="chartCashflowDonut"></canvas>
                            <div class="donut-center">
                                <strong id="cf-donut-total">Rp 0</strong>
                                <span>Saldo bersih</span>
                            </div>
                        </div>
                        <div class="donut-legend">
                            <div class="donut-legend-item"><strong id="cf-donut-val-cash">Rp 0</strong><span><i class="dot-in"></i>Via Cash</span></div>
                            <div class="donut-legend-item"><strong id="cf-donut-val-transfer">Rp 0</strong><span><i class="dot-in-2"></i>Via Transfer</span></div>
                            <div class="donut-legend-item"><strong id="cf-donut-val-keluar">Rp 0</strong><span><i class="dot-out"></i>Pengeluaran</span></div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="dash-row dash-row-table">
                <div class="table-card">
                    <div class="chart-header">
                        <h4>Transaksi Terbaru</h4>
                        <p>5 pembayaran/pengeluaran paling baru di bulan terpilih</p>
                    </div>
                    <div class="table-responsive">
                        <table class="table-recent">
                            <thead>
                                <tr>
                                    <th>Tanggal</th>
                                    <th>Tipe</th>
                                    <th>Nama / Keterangan</th>
                                    <th>Area / Kategori</th>
                                    <th class="text-right">Nominal</th>
                                </tr>
                            </thead>
                            <tbody id="tbody-cashflow-dashboard">
                                <tr><td colspan="5" class="text-center cell-loading">Memuat data transaksi...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="chart-card">
                    <div class="chart-header">
                        <h4>Area Pembayaran Teratas</h4>
                        <p>Berdasarkan total nominal</p>
                    </div>
                    <div class="cat-total" id="cf-cat-total">Rp 0</div>
                    <div class="cat-total-sub">Total pemasukan</div>
                    <div class="cat-list" id="cf-cat-list">
                        <div class="cat-empty">Memuat area...</div>
                    </div>
                </div>
            </div>
            </div>
        </section>

        <!-- PAGE 2: TRANSAKSI -->
        <section id="page-transaksi" class="page-view">
            <div class="page-header">
                <h2>Riwayat Transaksi Keuangan</h2>
                <p>Daftar transaksi kas masuk dan pengeluaran operasional.</p>
                <div class="page-actions">
                    <button type="button" onclick="openAddModal('pemasukan')" class="btn-primary-add">+ Masuk</button>
                    <button type="button" onclick="openAddModal('pengeluaran')" class="btn-primary-add">+ Keluar</button>
                    <button type="button" onclick="openAddModal('setoran')" class="btn-primary-add">+ Setor</button>
                </div>
                <div class="mode-toggle" data-page="transaksi">
                    <button type="button" class="mode-btn active" data-mode="cash" onclick="setDataMode('cash')">Cash</button>
                    <button type="button" class="mode-btn" data-mode="cashflow" onclick="setDataMode('cashflow')">Cashflow</button>
                </div>
            </div>

            <div id="transaksi-cash-view">
            <div class="filter-bar">
                <div class="search-box">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input type="text" id="search-input" placeholder="Cari transaksi..." oninput="handleFilter()">
                </div>
                
                <div class="filter-group">
                    <select id="type-select" class="form-control" onchange="handleFilter()">
                        <option value="ALL">Semua Tipe Transaksi</option>
                        <option value="Pemasukan">Pemasukan (+)</option>
                        <option value="Pengeluaran">Pengeluaran (-)</option>
                    </select>

                    <select id="category-select" class="form-control" onchange="handleFilter()">
                        <option value="ALL">Semua Kategori</option>
                    </select>
                </div>


            </div>

            <!-- Ringkasan Kategori: otomatis muncul saat filter Tipe = Pemasukan atau Pengeluaran -->
            <div id="kategori-insight-pemasukan" style="display:none;">
                <div class="chart-card full-width mb-4">
                    <div class="chart-header-flex">
                        <div>
                            <h4 id="title-kat-pemasukan">Tren Pemasukan: Semua Kategori</h4>
                            <p id="sub-kat-pemasukan">Menampilkan akumulasi seluruh alokasi kas masuk</p>
                        </div>
                        <button class="btn-reset-filter" onclick="filterCategoryTrend('Pemasukan', 'ALL')">Lihat Semua</button>
                    </div>
                    <div class="chart-box">
                        <canvas id="chartKatPemasukan"></canvas>
                    </div>
                </div>
                <div id="kat-pemasukan-list" class="kategori-grid mb-4"></div>
            </div>

            <div id="kategori-insight-pengeluaran" style="display:none;">
                <div class="chart-card full-width mb-4">
                    <div class="chart-header-flex">
                        <div>
                            <h4 id="title-kat-pengeluaran">Tren Pengeluaran: Semua Kategori</h4>
                            <p id="sub-kat-pengeluaran">Menampilkan akumulasi seluruh alokasi kas keluar</p>
                        </div>
                        <button class="btn-reset-filter" onclick="filterCategoryTrend('Pengeluaran', 'ALL')">Lihat Semua</button>
                    </div>
                    <div class="chart-box">
                        <canvas id="chartKatPengeluaran"></canvas>
                    </div>
                </div>
                <div id="kat-pengeluaran-list" class="kategori-grid mb-4"></div>
            </div>

            <div class="table-card">
                <div class="table-responsive">
                    <table>
                        <thead>
                            <tr>
                                <th>Tanggal</th>
                                <th>Tipe</th>
                                <th>Kategori</th>
                                <th>Keterangan / Catatan</th>
                                <th>Minggu</th>
                                <th class="text-right">Nominal</th>
                            </tr>
                        </thead>
                        <tbody id="tbody-transaksi">
                            <tr><td colspan="6" class="text-center cell-loading">Memuat data...</td></tr>
                        </tbody>
                    </table>
                </div>
                
                <div class="pagination-bar">
                    <span class="page-info" id="pagination-info">Menampilkan 0 data</span>
                    <div class="pagination-controls">
                        <button class="btn-page" id="btn-prev" onclick="changePage(-1)" disabled>‹ Prev</button>
                        <span class="page-num" id="page-current">1</span>
                        <button class="btn-page" id="btn-next" onclick="changePage(1)" disabled>Next ›</button>
                    </div>
                </div>
            </div>
            </div>
            <!-- /transaksi-cash-view -->

            <div id="transaksi-cashflow-view" style="display:none;">
                <div class="filter-bar">
                    <div class="search-box">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input type="text" id="search-cashflow-transaksi" placeholder="Cari nama, area, metode..." oninput="renderCashflowTransaksiTable()">
                    </div>
                </div>
                <div class="table-card">
                    <div class="table-responsive">
                        <table>
                            <thead>
                                <tr>
                                    <th>Tanggal Bayar</th>
                                    <th>Nama Pelanggan</th>
                                    <th>Area</th>
                                    <th>Metode</th>
                                    <th>Keterangan</th>
                                    <th class="text-right">Nominal</th>
                                </tr>
                            </thead>
                            <tbody id="tbody-cashflow-transaksi">
                                <tr><td colspan="6" class="text-center cell-loading">Memuat data pembayaran...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </section>

        <!-- PAGE 3: ANTREAN VALIDASI PEMBAYARAN -->
<section id="page-master" class="page-view">
    <div class="page-header">
        <h2>Antrean Validasi Pembayaran</h2>
        <p>Data pembayaran pelanggan yang memerlukan persetujuan/validasi pengawas.</p>
    </div>
    
    <!-- Metrik Ringkasan Antrean (4 Card Disatukan) -->
    <div class="metrics-grid metrics-4 mb-4">
        <div class="card-stat card-emerald">
            <div class="stat-header"><span>Sudah Bayar (Bulan Ini)</span></div>
            <div class="stat-value" id="stat-master-bayar-bulan-ini">0 Pelanggan</div>
            <div class="stat-desc">Termasuk Sudah ACC</div>
        </div>

        <div class="card-stat card-blue">
            <div class="stat-header"><span>Total Lunas (Bulan Ini)</span></div>
            <div class="stat-value" id="stat-master-nominal-bulan-ini">Rp 0</div>
            <div class="stat-desc">Akumulasi Bulan Ini</div>
        </div>

        <div class="card-stat card-blue">
            <div class="stat-header"><span>Total Nominal Antrean</span></div>
            <div class="stat-value" id="stat-master-total">Rp 0</div>
            <div class="stat-desc">Nilai Pembayaran Masuk</div>
        </div>

        <div class="card-stat card-amber">
            <div class="stat-header"><span>Jumlah Antrean</span></div>
            <div class="stat-value" id="stat-master-lunas">0 Orang</div>
            <div class="stat-desc">Belum Divalidasi</div>
        </div>
    </div>

    <!-- Filter Controls -->
    <div class="filter-bar">
        <div class="search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-master" placeholder="Cari nama pelanggan..." oninput="renderMasterDataTable()">
        </div>
        
        <div class="filter-group">
            <select id="area-select" class="form-control" onchange="renderMasterDataTable()">
                <option value="ALL">Semua Area Sheet</option>
            </select>
        </div>
    </div>

    <!-- Tabel Antrean Validasi -->
    <div class="table-card">
        <div class="table-responsive">
            <table>
                <thead>
                    <tr>
                        <th>No</th>
                        <th>Nama Pelanggan</th>
                        <th>Area Sheet</th>
                        <th>Jatuh Tempo</th>
                        <th class="text-right">Jumlah Tagihan</th>
                        <th>Tanggal Bayar</th>
                        <th>Metode Bayar</th>
                        <th>Keterangan</th>
                        <th class="text-center">Aksi</th>
                    </tr>
                </thead>
                <tbody id="tbody-master-data">
                    <tr><td colspan="9" class="text-center cell-loading">Memuat antrean validasi...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</section>


        <!-- PAGE 4: KATEGORI PEMASUKAN -->
        <!-- PAGE 5: (dulu Kategori Pemasukan/Pengeluaran — sekarang digabung ke Riwayat Transaksi) -->
        
        <!-- PAGE 6: RIWAYAT SETORAN BANK -->
<section id="page-setoran" class="page-view">
    <div class="page-header">
        <h2>Riwayat Setoran Bank</h2>
        <p>Daftar pencatatan uang tersetor ke rekening bank.</p>
    </div>

    <!-- Bilah Filter & Pencarian (Sesuai Tema) -->
    <div class="filter-bar">
        <div class="search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-setoran" placeholder="Cari setoran..." oninput="renderSetoranTable()">
        </div>
    </div>

    <!-- Tabel Data Setoran -->
    <div class="table-card">
        <div class="table-responsive">
            <table>
                <thead>
                    <tr>
                        <th>Tanggal</th>
                        <th>Kategori / Bank</th>
                        <th>Keterangan / Catatan</th>
                        <th class="text-right">Nominal</th>
                    </tr>
                </thead>
                <tbody id="tbody-setoran">
                    <tr><td colspan="4" class="text-center cell-loading">Memuat data setoran...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</section>

<!-- PAGE: LAPORAN KETEPATAN PEMBAYARAN -->
<section id="page-laporan-ketepatan" class="page-view">
    <div class="page-header">
        <h2>Dashboard Ketepatan Pembayaran</h2>
        <p>Analisis disiplin waktu pembayaran pelanggan berdasarkan tanggal jatuh tempo.</p>
    </div>

    <!-- Ringkasan Jumlah Pelanggan -->
    <div class="metrics-grid metrics-4 mb-4">
        <div class="card-stat card-blue">
            <div class="stat-header"><span>Total Sudah Bayar</span></div>
            <div class="stat-value" id="stat-ketepatan-total">0 Pelanggan</div>
            <div class="stat-desc">Sudah Melakukan Pembayaran</div>
        </div>

        <div class="card-stat card-emerald">
            <div class="stat-header"><span>Tepat Waktu</span></div>
            <div class="stat-value" id="stat-ketepatan-tepat">0 Pelanggan</div>
            <div class="stat-desc" id="stat-ketepatan-tepat-pct">0% dari total bayar</div>
        </div>

        <div class="card-stat card-amber">
            <div class="stat-header"><span>Telat Bayar</span></div>
            <div class="stat-value" id="stat-ketepatan-telat">0 Pelanggan</div>
            <div class="stat-desc" id="stat-ketepatan-telat-pct">0% dari total bayar</div>
        </div>

        <div class="card-stat card-blue">
            <div class="stat-header"><span>Tingkat Ketepatan</span></div>
            <div class="stat-value" id="stat-ketepatan-score">0%</div>
            <div class="stat-desc">Skor Performa Pembayaran</div>
        </div>
    </div>
    
    <!-- Kartu Nominal Terbayar & Belum Terbayar -->
    <div class="metrics-grid metrics-2 mb-4">
        <div class="card-stat card-emerald">
            <div class="stat-header"><span>Total Nominal Terbayar</span></div>
            <div class="stat-value" id="stat-ketepatan-nominal-paid">Rp 0</div>
            <div class="stat-desc" id="stat-ketepatan-count-paid">0 Pelanggan Lunas</div>
        </div>

        <div class="card-stat card-amber">
            <div class="stat-header"><span>Total Belum Terbayar</span></div>
            <div class="stat-value" id="stat-ketepatan-nominal-unpaid">Rp 0</div>
            <div class="stat-desc" id="stat-ketepatan-count-unpaid">0 Pelanggan Belum Bayar</div>
        </div>
    </div>
    
    <!-- BILAH FILTER BARU: TAMBAH FILTER BAYAR (BELUM / TERBAYAR) -->
    <div class="filter-bar">
        <div class="search-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" id="search-ketepatan" placeholder="Cari nama atau tanggal bayar..." oninput="renderLaporanKetepatan()">
        </div>
        
        <div class="filter-group">
            <!-- Filter Status Pembayaran (Lunas/Belum Bayar) -->
            <select id="filter-bayar-ketepatan" class="form-control" onchange="renderLaporanKetepatan()">
                <option value="ALL">Semua Pembayaran (Semua)</option>
                <option value="UNPAID" selected>⚠️ Belum Bayar</option>
                <option value="PAID">✅ Sudah Bayar (Lunas)</option>
            </select>

            <!-- Filter Status Ketepatan -->
            <select id="filter-status-ketepatan" class="form-control" onchange="renderLaporanKetepatan()">
                <option value="ALL">Semua Status Ketepatan</option>
                <option value="TEPAT">Tepat Waktu</option>
                <option value="TELAT">Telat Bayar</option>
            </select>

            <!-- Filter Jatuh Tempo -->
            <select id="filter-tempo-ketepatan" class="form-control" onchange="renderLaporanKetepatan()">
                <!-- Otomatis diisi oleh initFilterTempo() -->
            </select>
        </div>
    </div> 

    <!-- TABEL LAPORAN KETEPATAN BAYAR (TAMBAH KOLOM JUMLAH TAGIHAN) -->
    <div class="table-card">
        <div class="table-responsive">
            <table>
                <thead>
                    <tr>
                        <th>No</th>
                        <th>Nama Pelanggan</th>
                        <th>Area</th>
                        <th>Jatuh Tempo</th>
                        <th class="text-right">Jumlah Tagihan</th>
                        <th>Tanggal Bayar</th>
                        <th class="text-center">Keterangan</th>
                        <th class="text-center">Status</th>
                    </tr>
                </thead>
                <tbody id="tbody-laporan-ketepatan">
                    <tr><td colspan="8" class="text-center cell-loading">Memuat data...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</section>




<!-- PAGE: PENGELUARAN ALL -->
<section id="page-pengeluaran-all" class="page-view">
    <div class="page-header">
        <h2>Data Input Pengeluaran ALL</h2>
        <p>Rekapitulasi seluruh data transaksi pengeluaran secara menyeluruh.</p>
    </div>

    <!-- Card Total Ringkas & Sesuai Tema Website -->
    <div class="metrics-grid mb-4" style="max-width: 600px;">
        <div class="card-stat card-amber">
            <div class="stat-header">
                <span>Total Pengeluaran All</span>
                <div class="stat-icon" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg></div>
            </div>
            <div class="stat-value" id="stat-total-pengeluaran-all">Rp 0</div>
            <div class="stat-desc">Akumulasi Pengeluaran</div>
        </div>
    </div>

    <!-- Filter Bar Sesuai UI System -->
    <div class="filter-bar">
        <div class="filter-group" style="align-items: flex-end;">
            <div>
                <label style="display: block; margin-bottom: 4px;">Filter Bulan</label>
                <input type="month" id="filter-bulan-pengeluaran-all" class="form-control" onchange="filterPengeluaranALL()">
            </div>
            <div>
                <label style="display: block; margin-bottom: 4px;">Filter Spesifik Tanggal</label>
                <input type="date" id="filter-tanggal-pengeluaran-all" class="form-control" onchange="filterPengeluaranALL()">
            </div>
            <button type="button" class="btn-reset-filter" onclick="resetFilterPengeluaranALL()" style="padding: 8px 14px; height: 38px;">Reset Filter</button>
        </div>
    </div>

    <!-- Tabel Data Pengeluaran -->
    <div class="table-card">
        <div class="table-responsive">
            <table>
                <thead>
                    <tr>
                        <th>No</th>
                        <th>Tanggal</th>
                        <th>Kategori</th>
                        <th class="text-right">Nominal</th>
                        <th>Minggu</th>
                        <th>Keterangan</th>
                    </tr>
                </thead>
                <tbody id="body-pengeluaran-all">
                    <tr><td colspan="6" class="text-center cell-loading">Memuat data pengeluaran ALL...</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</section>



<!-- HALAMAN: LAPORAN MINGGUAN FINANCE -->
<section id="page-laporan-periode" class="page-view">
    <div class="page-header">
        <h2>Laporan Finance</h2>
        <p>Tab <strong>Cash</strong>: ringkasan cashflow kas harian siap kirim ke grup WA. Tab <strong>Cashflow</strong>: laporan mingguan/bulanan gabungan.</p>
        <div class="mode-toggle" data-page="laporan-periode">
            <button type="button" class="mode-btn active" data-mode="cash" onclick="setDataMode('cash')">Cash</button>
            <button type="button" class="mode-btn" data-mode="cashflow" onclick="setDataMode('cashflow')">Cashflow</button>
        </div>
    </div>

    <!-- ============ TAB CASH: Ringkasan Cashflow Harian (format WA) ============ -->
    <div id="laporan-cash-view">
        <div class="filter-bar" style="margin-bottom: 20px;">
            <div class="filter-group" style="display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;">
                <div>
                    <label style="display: block; margin-bottom: 4px;">Tanggal</label>
                    <input type="date" id="filter-tanggal-harian" class="form-control" onchange="renderLaporanHarianCash()">
                </div>
                <button type="button" class="btn-reset-filter" onclick="salinLaporanHarianKeWA()">📋 Salin ke WhatsApp</button>
            </div>
        </div>

        <div class="table-card" style="max-width: 480px;">
            <div class="chart-header" style="padding: 16px 16px 4px;">
                <h4 id="judul-laporan-harian">Ringkasan Cashflow Harian</h4>
                <p>Cash awal dihitung otomatis dari akumulasi saldo hari-hari sebelumnya.</p>
            </div>
            <div id="isi-laporan-harian" style="padding: 4px 16px 18px 16px; font-size: 11.5px; line-height: 1.9;">
                <p class="text-center cell-loading" style="padding: 20px 0;">Memuat ringkasan harian...</p>
            </div>
        </div>
    </div>

    <!-- ============ TAB CASHFLOW: Laporan Mingguan/Bulanan (gabungan tagihan pelanggan + pengeluaran) ============ -->
    <div id="laporan-cashflow-view" style="display:none;">
        <div class="mode-toggle" data-page="laporan-cashflow-subperiode" style="margin-bottom: 14px; margin-top: 0;">
            <button type="button" class="mode-btn" data-mode="harian" onclick="setSubPeriodeCashflow('harian')">Harian</button>
            <button type="button" class="mode-btn active" data-mode="periode" onclick="setSubPeriodeCashflow('periode')">Mingguan / Bulanan</button>
        </div>

        <!-- Sub-tampilan: HARIAN (gabungan Cashflow Cash + Rekap Bank, siap salin ke WA) -->
        <div id="cashflow-harian-view" style="display:none;">
            <div class="filter-bar" style="margin-bottom: 20px;">
                <div class="filter-group" style="display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;">
                    <div>
                        <label style="display: block; margin-bottom: 4px;">Tanggal</label>
                        <input type="date" id="cashflow-harian-tanggal" class="form-control" onchange="renderLaporanHarianCashflow()">
                    </div>
                </div>
            </div>

            <div class="table-card" style="max-width: 480px;">
                <div class="chart-header" style="padding: 16px 16px 4px; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                    <div>
                        <h4 id="judul-laporan-harian-cashflow">Laporan Harian Finance</h4>
                        <p>Cashflow Cash harian + rekap pembayaran via Cash &amp; Transfer.</p>
                    </div>
                    <button type="button" class="btn-reset-filter" onclick="salinLaporanHarianCashflowKeWA()">📋 Salin ke WhatsApp</button>
                </div>
                <div id="isi-laporan-harian-cashflow" style="padding: 4px 16px 18px 16px; font-size: 11.5px; line-height: 1.9;">
                    <p class="text-center cell-loading" style="padding: 20px 0;">Memuat laporan harian...</p>
                </div>
            </div>
        </div>

        <!-- Sub-tampilan: MINGGUAN / BULANAN (laporan lama, tidak berubah) -->
        <div id="cashflow-periode-view">
        <div class="filter-bar" style="margin-bottom: 20px;">
            <div class="filter-group" style="display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;">
                <div>
                    <label style="display: block; margin-bottom: 4px;">Bulan</label>
                    <select id="filter-bulan-laporan" class="form-control" onchange="renderLaporanPeriode()">
                        <option value="1">Januari</option>
                        <option value="2">Februari</option>
                        <option value="3">Maret</option>
                        <option value="4">April</option>
                        <option value="5">Mei</option>
                        <option value="6">Juni</option>
                        <option value="7">Juli</option>
                        <option value="8">Agustus</option>
                        <option value="9">September</option>
                        <option value="10">Oktober</option>
                        <option value="11">November</option>
                        <option value="12">Desember</option>
                    </select>
                </div>
                <div>
                    <label style="display: block; margin-bottom: 4px;">Tahun</label>
                    <select id="filter-tahun-laporan" class="form-control" onchange="renderLaporanPeriode()">
                        <option value="2024">2024</option>
                        <option value="2025">2025</option>
                        <option value="2026" selected>2026</option>
                    </select>
                </div>
                <div>
                    <label style="display: block; margin-bottom: 4px;">Periode Minggu</label>
                    <select id="filter-minggu-laporan" class="form-control" onchange="renderLaporanPeriode()">
                        <option value="all" selected>Bulanan (Semua Minggu / Tanggal 1 s/d 31)</option>
                        <option value="1">Minggu ke-1 / Tanggal 1 s/d 7</option>
                        <option value="2">Minggu ke-2 / Tanggal 8 s/d 14</option>
                        <option value="3">Minggu ke-3 / Tanggal 15 s/d 21</option>
                        <option value="4">Minggu ke-4 / Tanggal 22 s/d 28</option>
                        <option value="5">Minggu ke-5 / Tanggal 29 s/d 31</option>
                    </select>
                </div>
            </div>
        </div>

        <div class="table-card" style="max-width: 480px;">
            <div class="chart-header" style="padding: 16px 16px 4px; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
                <div>
                    <h4 id="judul-laporan-periode">Laporan Finance</h4>
                    <p>Ringkasan otomatis dari data pelanggan &amp; pengeluaran.</p>
                </div>
                <button type="button" class="btn-reset-filter" onclick="salinLaporanPeriodeKeWA()">📋 Salin ke WhatsApp</button>
            </div>
            <div id="isi-laporan-periode" style="padding: 4px 16px 18px 16px; font-size: 11.5px; line-height: 1.9;">
                <p class="text-center cell-loading" style="padding: 20px 0;">Memuat laporan finance...</p>
            </div>
        </div>
        </div>
    </div>

</section>

<!-- PAGE: ARCHIVE (Sub Menu Laporan) -->
<section id="page-archive" class="page-view">
    <div class="page-header">
        <h2>Archive Laporan Bulanan</h2>
        <p>Laporan bulanan dari arsip Spreadsheet Pembayaran Pelanggan bulan-bulan sebelumnya — format sama seperti Laporan utama.</p>
    </div>

    <div class="archive-tab-bar" id="archive-tab-bar"></div>

    <div class="table-card" style="max-width: 480px;">
        <div class="chart-header" style="padding: 16px 16px 4px;">
            <h4 id="judul-laporan-archive">Laporan Bulanan</h4>
            <p>Data dari arsip Spreadsheet Pembayaran Pelanggan.</p>
        </div>
        <div id="isi-laporan-archive" style="padding: 4px 16px 18px 16px; font-size: 11.5px; line-height: 1.9;">
            <p class="text-center text-muted" style="padding: 20px 0;">Pilih tab bulan di atas.</p>
        </div>
    </div>
</section>

<!-- PAGE: REKAP BANK (Sub Menu Laporan) -->
<section id="page-rekap-bank" class="page-view">
    <div class="page-header">
        <h2>Rekap Uang Masuk Per Bank</h2>
        <p>Lacak uang masuk berdasarkan bank/metode pembayaran (BCA, DANA, Cash, dll), per hari, minggu, atau bulan.</p>
        <div class="mode-toggle" data-page="rekap-bank">
            <button type="button" class="mode-btn active" data-mode="harian" onclick="setPeriodeRekapBank('harian')">Harian</button>
            <button type="button" class="mode-btn" data-mode="mingguan" onclick="setPeriodeRekapBank('mingguan')">Mingguan</button>
            <button type="button" class="mode-btn" data-mode="bulanan" onclick="setPeriodeRekapBank('bulanan')">Bulanan</button>
        </div>
    </div>

    <div class="filter-bar" style="margin-bottom: 20px;">
        <div class="filter-group" style="display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap;">
            <div id="rekap-bank-filter-harian">
                <label style="display: block; margin-bottom: 4px;">Tanggal</label>
                <input type="date" id="rekap-bank-tanggal" class="form-control" onchange="renderRekapBank()">
            </div>
            <div id="rekap-bank-filter-bulan-tahun" style="display:none;">
                <label style="display: block; margin-bottom: 4px;">Bulan</label>
                <select id="rekap-bank-bulan" class="form-control" onchange="renderRekapBank()">
                    <option value="1">Januari</option><option value="2">Februari</option><option value="3">Maret</option>
                    <option value="4">April</option><option value="5">Mei</option><option value="6">Juni</option>
                    <option value="7">Juli</option><option value="8">Agustus</option><option value="9" selected>September</option>
                    <option value="10">Oktober</option><option value="11">November</option><option value="12">Desember</option>
                </select>
            </div>
            <div id="rekap-bank-filter-tahun" style="display:none;">
                <label style="display: block; margin-bottom: 4px;">Tahun</label>
                <select id="rekap-bank-tahun" class="form-control" onchange="renderRekapBank()">
                    <option value="2024">2024</option><option value="2025">2025</option><option value="2026" selected>2026</option>
                </select>
            </div>
            <div id="rekap-bank-filter-minggu" style="display:none;">
                <label style="display: block; margin-bottom: 4px;">Minggu Ke-</label>
                <select id="rekap-bank-minggu" class="form-control" onchange="renderRekapBank()">
                    <option value="1">Minggu ke-1 / Tanggal 1 s/d 7</option>
                    <option value="2" selected>Minggu ke-2 / Tanggal 8 s/d 14</option>
                    <option value="3">Minggu ke-3 / Tanggal 15 s/d 21</option>
                    <option value="4">Minggu ke-4 / Tanggal 22 s/d 28</option>
                    <option value="5">Minggu ke-5 / Tanggal 29 s/d 31</option>
                </select>
            </div>
        </div>
    </div>

    <div class="table-card" style="max-width: 480px;">
        <div class="chart-header" style="padding: 16px 16px 4px; display:flex; align-items:flex-start; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <div>
                <h4 id="judul-rekap-bank">Rekap Per Bank</h4>
                <p>Total nominal masuk dikelompokkan per bank/metode pembayaran.</p>
            </div>
            <button type="button" class="btn-reset-filter" onclick="salinRekapBankKeWA()">📋 Salin ke WhatsApp</button>
        </div>
        <div id="isi-rekap-bank" style="padding: 4px 16px 18px 16px; font-size: 11.5px; line-height: 1.9;">
            <p class="text-center cell-loading" style="padding: 20px 0;">Memuat rekap bank...</p>
        </div>
    </div>
</section>




<section id="page-ceklis" class="page-view">
<?php
// Variabel $dbCeklis sudah disiapkan oleh handler AJAX di paling atas file (sebelum <!DOCTYPE html>).
// Bagian di bawah ini hanya untuk render awal halaman (saat pertama kali dibuka / fallback tanpa JS).

// Filtering & Search (render awal halaman)
$search = strtolower($_GET['search'] ?? '');
$filterKat = $_GET['kategori'] ?? 'ALL';
$filterTanggal = $_GET['tanggal'] ?? 'ALL';

$filteredItems = array_filter($dbCeklis['items'], function($item) use ($search, $filterKat, $filterTanggal) {
    $haystack = strtolower(implode(' ', [
        $item['namaCatatan'] ?? '',
        $item['deskripsi'] ?? '',
        $item['alamat'] ?? '',
        $item['noHp'] ?? '',
        $item['kategori'] ?? '',
        (string)($item['tanggalJatuhTempo'] ?? ''),
        (string)($item['nominal'] ?? ''),
    ]));
    $matchSearch = empty($search) || strpos($haystack, $search) !== false;
    $matchKat = ($filterKat === 'ALL') || ($item['kategori'] ?? '') === $filterKat;
    $matchTanggal = ($filterTanggal === 'ALL' || $filterTanggal === '') || ((int)($item['tanggalJatuhTempo'] ?? 0) === (int)$filterTanggal);
    return $matchSearch && $matchKat && $matchTanggal;
});

// Pengelompokan Data per Kategori
$grouped = [];
foreach ($filteredItems as $item) {
    $kat = $item['kategori'] ?? 'Tanpa Kategori';
    $grouped[$kat][] = $item;
}

// Reminder: catatan yang mendekati / sudah jatuh tempo (dihitung dari SELURUH data, bukan hasil filter)
$alertsAwal = [];
foreach ($dbCeklis['items'] as $item) {
    if (!empty($item['status'])) continue;
    if (empty($item['tanggalJatuhTempo'])) continue;
    $sisaHari = ckHitungSisaHari($item['tanggalJatuhTempo']);
    if ($sisaHari <= CK_REMINDER_THRESHOLD) {
        $item['_sisaHari'] = $sisaHari;
        $alertsAwal[] = $item;
    }
}
usort($alertsAwal, function($a, $b) { return $a['_sisaHari'] <=> $b['_sisaHari']; });

// Palet warna aksen kartu per kategori (berulang jika kategori lebih banyak dari palet)
$ckPalet = ['#6c63ff', '#3b82f6', '#22c55e', '#f59e0b', '#a78bfa', '#14b8a6'];
?>

<!-- Style modul Checklist kini ada di styles.css (bagian 5) -->

<div class="ck-wrapper">

    <!-- Lightbox Foto Fullscreen -->
    <div class="ck-photo-lightbox" id="ck-photo-lightbox" onclick="ckClosePhotoLightbox()">
        <span class="ck-photo-lightbox-close">&times;</span>
        <img id="ck-photo-lightbox-img" src="" alt="Foto">
    </div>


    <?php if (!empty($alertsAwal)): ?>
    <!-- Alert Reminder: Catatan yang mendekati / sudah jatuh tempo -->
    <div class="ck-alert-box" id="ck-alert-box">
        <div class="ck-alert-header">⚠️ Pengingat Jatuh Tempo</div>
        <div class="ck-alert-list" id="ck-alert-list">
            <?php foreach ($alertsAwal as $item): ?>
                <div class="ck-alert-item">
                    <div>
                        <div class="ck-alert-name"><?= htmlspecialchars($item['namaCatatan']) ?></div>
                        <div class="ck-alert-sub">Setiap tanggal <?= (int)$item['tanggalJatuhTempo'] ?> · <?= htmlspecialchars($item['kategori'] ?? '') ?></div>
                    </div>
                    <span class="ck-alert-badge <?= $item['_sisaHari'] == 0 ? 'today' : '' ?>">
                        <?= $item['_sisaHari'] == 0 ? 'Jatuh tempo hari ini' : 'H-' . $item['_sisaHari'] ?>
                    </span>
                </div>
            <?php endforeach; ?>
        </div>
    </div>
    <?php else: ?>
    <div class="ck-alert-box" id="ck-alert-box" style="display:none;">
        <div class="ck-alert-header">⚠️ Pengingat Jatuh Tempo</div>
        <div class="ck-alert-list" id="ck-alert-list"></div>
    </div>
    <?php endif; ?>

    <!-- Header Controls -->
    <div class="ck-toolbar">
        <form method="GET" class="ck-filter-form" id="ck-filter-form" onsubmit="ckApplyFilter(event)">
            <input type="text" name="search" id="ck-search-input" class="ck-input" style="flex: 1; min-width: 140px;" placeholder="Cari nama, alamat, kategori, dll..." value="<?= htmlspecialchars($_GET['search'] ?? '') ?>">
            <select name="kategori" id="ck-kategori-select" class="ck-select" onchange="ckApplyFilter()">
                <option value="ALL">Semua Kategori</option>
                <?php foreach ($dbCeklis['kategoriPengambilan'] as $kat): ?>
                    <option value="<?= htmlspecialchars($kat) ?>" <?= $filterKat === $kat ? 'selected' : '' ?>><?= htmlspecialchars($kat) ?></option>
                <?php endforeach; ?>
            </select>
            <select name="tanggal" id="ck-tanggal-select" class="ck-select" onchange="ckApplyFilter()">
                <option value="ALL">Semua Tanggal</option>
                <?php for ($t = 1; $t <= 31; $t++): ?>
                    <option value="<?= $t ?>" <?= (string)$filterTanggal === (string)$t ? 'selected' : '' ?>>Tgl <?= $t ?></option>
                <?php endfor; ?>
            </select>
            <button type="submit" class="ck-btn ck-btn-secondary">Cari</button>
        </form>
        <button type="button" class="ck-btn ck-btn-primary" onclick="openCeklisModal()">+ Catatan Baru</button>
    </div>

    <!-- Tampilan Sticky Notes White -->
    <div class="ck-grid" id="ck-grid">
        <?php if (empty($grouped)): ?>
            <div class="ck-empty">Tidak ada catatan yang cocok. Ubah pencarian atau tambah catatan baru.</div>
        <?php else: ?>
            <?php $ckIdx = 0; foreach ($grouped as $kategoriName => $items): ?>
                <?php $ckAccent = $ckPalet[$ckIdx % count($ckPalet)]; $ckIdx++; ?>
                <div class="ck-card" style="--ck-accent: <?= $ckAccent ?>;">
                    <div class="ck-card-header"><?= htmlspecialchars($kategoriName) ?></div>
                    <ol class="ck-list">
                        <?php foreach ($items as $item): ?>
                            <li class="ck-item <?= $item['status'] ? 'completed' : '' ?>" data-id="<?= $item['id'] ?>" data-item="<?= htmlspecialchars(json_encode($item), ENT_QUOTES) ?>">
                                <div class="ck-item-row">
                                    <div class="ck-item-left">
                                        <input type="checkbox" class="ck-checkbox" data-id="<?= $item['id'] ?>" <?= $item['status'] ? 'checked' : '' ?>>
                                        <?php if (!empty($item['foto'])): ?>
                                            <img class="ck-avatar" src="<?= htmlspecialchars($item['foto']) ?>" alt="" onclick="event.stopPropagation(); ckOpenPhotoLightbox('<?= htmlspecialchars($item['foto'], ENT_QUOTES) ?>')">
                                        <?php else: ?>
                                            <div class="ck-avatar-placeholder"><?= strtoupper(substr($item['namaCatatan'], 0, 1)) ?></div>
                                        <?php endif; ?>
                                        <div style="min-width:0;">
                                            <div class="ck-title"><?= htmlspecialchars($item['namaCatatan']) ?></div>
                                            <div class="ck-meta">
                                                <span>Rp <?= number_format($item['nominal'], 0, ',', '.') ?></span>
                                                <span>•</span>
                                                <span class="ck-due-badge">Tgl <?= (int)($item['tanggalJatuhTempo'] ?? 0) ?></span>
                                            </div>
                                            <?php if (!empty($item['deskripsi'])): ?>
                                                <div class="ck-desc"><?= htmlspecialchars($item['deskripsi']) ?></div>
                                            <?php endif; ?>
                                            <?php if (!empty($item['noHp']) || !empty($item['alamat'])): ?>
                                            <div class="ck-contact">
                                                <?php if (!empty($item['noHp'])): ?><span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> <?= htmlspecialchars($item['noHp']) ?></span><?php endif; ?>
                                                <?php if (!empty($item['alamat'])): ?><span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> <?= htmlspecialchars($item['alamat']) ?></span><?php endif; ?>
                                            </div>
                                            <?php endif; ?>
                                        </div>
                                    </div>
                                    <div class="ck-item-actions">
                                        <button type="button" class="ck-btn-edit" data-id="<?= $item['id'] ?>" title="Edit">✎</button>
                                        <button type="button" class="ck-btn-del" data-id="<?= $item['id'] ?>" title="Hapus">&times;</button>
                                    </div>
                                </div>
                            </li>
                        <?php endforeach; ?>
                    </ol>
                </div>
            <?php endforeach; ?>
        <?php endif; ?>
    </div>
</div>

<!-- Modal Pop-Up Form Input (dipakai untuk Tambah maupun Edit) -->
<div id="modalCeklis" class="ck-modal-backdrop">
    <div class="ck-modal">
        <div class="ck-modal-header">
            <h4 class="ck-modal-title" id="ck-modal-title-text">Tambah Catatan Checklist</h4>
            <button type="button" class="ck-btn-del" style="font-size: 20px;" onclick="closeCeklisModal()">&times;</button>
        </div>
        <form method="POST" action="index.php" id="ck-add-form" onsubmit="ckSubmitAdd(event)" enctype="multipart/form-data">
            <input type="hidden" name="action" id="ck-form-action" value="add">
            <input type="hidden" name="id" id="ck-form-id" value="">
            <input type="hidden" name="existingFoto" id="ck-form-existing-foto" value="">
            <div class="ck-modal-body">
                <div class="ck-form-group">
                    <label>Nama Catatan / Pelanggan</label>
                    <input type="text" name="namaCatatan" id="ck-form-nama" class="ck-input" style="width: 100%;" required placeholder="Masukkan nama catatan">
                </div>
                <div class="ck-form-group">
                    <label>Deskripsi Keterangan</label>
                    <input type="text" name="deskripsi" id="ck-form-deskripsi" class="ck-input" style="width: 100%;" placeholder="Keterangan tambahan (opsional)">
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div class="ck-form-group">
                        <label>Kategori</label>
                        <select name="kategori" id="ck-form-kategori" class="ck-select" style="width: 100%;" required>
                            <?php foreach ($dbCeklis['kategoriPengambilan'] as $kat): ?>
                                <option value="<?= htmlspecialchars($kat) ?>"><?= htmlspecialchars($kat) ?></option>
                            <?php endforeach; ?>
                        </select>
                    </div>
                    <div class="ck-form-group">
                        <label>Nominal (Rp)</label>
                        <input type="number" name="nominal" id="ck-form-nominal" class="ck-input" style="width: 100%;" placeholder="0">
                    </div>
                </div>
                <div class="ck-form-group">
                    <label>Tanggal Jatuh Tempo (Pengingat)</label>
                    <input type="number" name="tanggalJatuhTempo" id="ck-form-tempo" class="ck-input" style="width: 100%;" min="1" max="31" placeholder="Contoh: 5" value="<?= date('j') ?>" required>
                    <div class="ck-form-hint">Cukup isi tanggalnya saja (1–31). Akan diingatkan otomatis tiap bulan.</div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <div class="ck-form-group">
                        <label>No. HP</label>
                        <input type="tel" name="noHp" id="ck-form-nohp" class="ck-input" style="width: 100%;" placeholder="08xxxxxxxxxx">
                    </div>
                    <div class="ck-form-group">
                        <label>Foto</label>
                        <input type="file" name="foto" class="ck-input" style="width: 100%; padding: 6px 10px;" accept="image/png, image/jpeg, image/webp">
                    </div>
                </div>
                <div class="ck-form-group" id="ck-form-foto-lama-wrap" style="display:none;">
                    <label>Foto Saat Ini</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="ck-form-foto-lama-preview" src="" alt="" style="width:44px; height:44px; border-radius:8px; object-fit:cover; border:1px solid var(--border-subtle);">
                        <label style="display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--text-muted); cursor:pointer;">
                            <input type="checkbox" name="hapusFoto" id="ck-form-hapus-foto" class="ck-checkbox" style="width:16px;height:16px;">
                            <span>Hapus foto ini</span>
                        </label>
                    </div>
                    <div class="ck-form-hint">Upload foto baru di atas untuk mengganti, atau centang untuk menghapus.</div>
                </div>
                <div class="ck-form-group">
                    <label>Alamat</label>
                    <input type="text" name="alamat" id="ck-form-alamat" class="ck-input" style="width: 100%;" placeholder="Alamat (opsional)">
                </div>
                <div style="margin-top: 10px;">
                    <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
                        <input type="checkbox" name="status" id="ck-form-status" class="ck-checkbox" style="width:19px;height:19px;">
                        <span>Tandai Langsung Selesai</span>
                    </label>
                </div>
            </div>
            <div class="ck-modal-footer">
                <button type="button" class="ck-btn ck-btn-secondary" onclick="closeCeklisModal()">Batal</button>
                <button type="submit" class="ck-btn ck-btn-primary" id="ck-form-submit-btn">Simpan Catatan</button>
            </div>
        </form>
    </div>
</div>

<!-- Modal Control Script -->
<script>
function ckResetFormToAddMode() {
    const form = document.getElementById('ck-add-form');
    form.reset();
    document.getElementById('ck-form-action').value = 'add';
    document.getElementById('ck-form-id').value = '';
    document.getElementById('ck-form-existing-foto').value = '';
    document.getElementById('ck-modal-title-text').textContent = 'Tambah Catatan Checklist';
    document.getElementById('ck-form-submit-btn').textContent = 'Simpan Catatan';
    document.getElementById('ck-form-foto-lama-wrap').style.display = 'none';
    document.getElementById('ck-form-hapus-foto').checked = false;
    document.getElementById('ck-form-tempo').value = new Date().getDate();
}

function openCeklisModal() {
    ckResetFormToAddMode();
    document.getElementById('modalCeklis').classList.add('show');
}

// Buka modal dalam mode EDIT, isi ulang semua field dari data item yang sudah ada (CRUD - Update)
function ckOpenEditModal(id) {
    const li = document.querySelector('.ck-item[data-id="' + id + '"]');
    if (!li) {
        alert('Data catatan tidak ditemukan. Coba refresh halaman lalu ulangi.');
        return;
    }
    if (!li.dataset.item) {
        alert('Data catatan ini tidak lengkap untuk diedit. Coba refresh halaman.');
        return;
    }
    let item;
    try {
        item = JSON.parse(li.dataset.item);
    } catch (e) {
        alert('Gagal membaca data catatan ini. Coba refresh halaman lalu ulangi.');
        return;
    }

    ckResetFormToAddMode();

    document.getElementById('ck-form-action').value = 'edit';
    document.getElementById('ck-form-id').value = item.id;
    document.getElementById('ck-form-nama').value = item.namaCatatan || '';
    document.getElementById('ck-form-deskripsi').value = item.deskripsi || '';
    document.getElementById('ck-form-kategori').value = item.kategori || '';
    document.getElementById('ck-form-nominal').value = item.nominal || 0;
    document.getElementById('ck-form-tempo').value = item.tanggalJatuhTempo || 1;
    document.getElementById('ck-form-nohp').value = item.noHp || '';
    document.getElementById('ck-form-alamat').value = item.alamat || '';
    document.getElementById('ck-form-status').checked = !!item.status;

    if (item.foto) {
        document.getElementById('ck-form-existing-foto').value = item.foto;
        document.getElementById('ck-form-foto-lama-preview').src = item.foto;
        document.getElementById('ck-form-foto-lama-wrap').style.display = 'block';
    }

    document.getElementById('ck-modal-title-text').textContent = 'Edit Catatan';
    document.getElementById('ck-form-submit-btn').textContent = 'Simpan Perubahan';
    document.getElementById('modalCeklis').classList.add('show');
}

// Lightbox foto fullscreen — klik foto avatar untuk lihat ukuran penuh
function ckOpenPhotoLightbox(url) {
    document.getElementById('ck-photo-lightbox-img').src = url;
    document.getElementById('ck-photo-lightbox').classList.add('show');
}
function ckClosePhotoLightbox() {
    document.getElementById('ck-photo-lightbox').classList.remove('show');
    document.getElementById('ck-photo-lightbox-img').src = '';
}

// PENTING: fungsi ditulis dengan prefix "ck" supaya TIDAK bentrok dengan
// closeModal()/window.onclick milik modal lain (mis. modal-form Transaksi)
// yang didefinisikan di app.js. Sebelumnya nama generik ini saling menimpa
// sehingga salah satu pop-up jadi tidak berfungsi.
function ckCloseModalBackdrop() {
    document.getElementById('modalCeklis').classList.remove('show');
}
function closeCeklisModal() {
    ckCloseModalBackdrop();
}
document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'modalCeklis') ckCloseModalBackdrop();
});
// Setelah reload dari aksi tambah/centang/hapus catatan (PHP redirect),
// pastikan tampilan yang terbuka tetap halaman Checklist, bukan Dashboard.
if (window.location.hash === '#page-ceklis') {
    document.addEventListener('DOMContentLoaded', function () {
        if (typeof navigateTo === 'function') {
            navigateTo('ceklis');
        }
    });
}

// ===================== AJAX Checklist (tanpa reload halaman) =====================
function ckEscape(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// 🛠️ PERBAIKAN BUG EDIT: ckEscape() di atas TIDAK meng-escape tanda kutip ("),
// padahal aman untuk teks biasa tapi BAHAYA kalau dipakai untuk membungkus JSON
// ke dalam atribut HTML (data-item="...") — tanda kutip di dalam JSON akan
// "memutus" atribut lebih awal, sehingga JSON.parse() gagal ("Expected property
// name or '}'"). Fungsi baru ini meng-escape SEMUA karakter yang perlu,
// termasuk tanda kutip, supaya aman dipakai di dalam atribut HTML.
function ckEscapeAttr(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ckFormatRupiah(num) {
    return Number(num || 0).toLocaleString('id-ID');
}

function ckRenderGrid(grouped) {
    const container = document.getElementById('ck-grid');
    const kategoriList = Object.keys(grouped || {});
    const palet = ['#6c63ff', '#3b82f6', '#22c55e', '#f59e0b', '#a78bfa', '#14b8a6'];

    if (kategoriList.length === 0) {
        container.innerHTML = `
            <div class="ck-empty">Tidak ada catatan yang cocok. Ubah pencarian atau tambah catatan baru.</div>`;
        return;
    }

    let html = '';
    kategoriList.forEach(function (kategoriName, idx) {
        const items = grouped[kategoriName];
        const accent = palet[idx % palet.length];
        html += `<div class="ck-card" style="--ck-accent: ${accent};"><div class="ck-card-header">${ckEscape(kategoriName)}</div><ol class="ck-list">`;
        items.forEach(function (item) {
            const completed = item.status ? 'completed' : '';
            const checked = item.status ? 'checked' : '';
            const deskripsiHtml = item.deskripsi
                ? `<div class="ck-desc">${ckEscape(item.deskripsi)}</div>`
                : '';
            const avatarHtml = item.foto
                ? `<img class="ck-avatar" src="${ckEscape(item.foto)}" alt="" onclick="event.stopPropagation(); ckOpenPhotoLightbox('${ckEscape(item.foto)}')">`
                : `<div class="ck-avatar-placeholder">${ckEscape((item.namaCatatan || '?').charAt(0).toUpperCase())}</div>`;
            const kontakBaris = [];
            const icoPhone = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
            const icoPin = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
            if (item.noHp) kontakBaris.push(`<span>${icoPhone} ${ckEscape(item.noHp)}</span>`);
            if (item.alamat) kontakBaris.push(`<span>${icoPin} ${ckEscape(item.alamat)}</span>`);
            const kontakHtml = kontakBaris.length ? `<div class="ck-contact">${kontakBaris.join('')}</div>` : '';
            const itemDataAttr = ckEscapeAttr(JSON.stringify(item));
            html += `
                <li class="ck-item ${completed}" data-id="${item.id}" data-item="${itemDataAttr}">
                    <div class="ck-item-row">
                        <div class="ck-item-left">
                            <input type="checkbox" class="ck-checkbox" data-id="${item.id}" ${checked}>
                            ${avatarHtml}
                            <div style="min-width:0;">
                                <div class="ck-title">${ckEscape(item.namaCatatan)}</div>
                                <div class="ck-meta">
                                    <span>Rp ${ckFormatRupiah(item.nominal)}</span>
                                    <span>•</span>
                                    <span class="ck-due-badge">Tgl ${item.tanggalJatuhTempo || '-'}</span>
                                </div>
                                ${deskripsiHtml}
                                ${kontakHtml}
                            </div>
                        </div>
                        <div class="ck-item-actions">
                            <button type="button" class="ck-btn-edit" data-id="${item.id}" title="Edit">✎</button>
                            <button type="button" class="ck-btn-del" data-id="${item.id}" title="Hapus">&times;</button>
                        </div>
                    </div>
                </li>`;
        });
        html += `</ol></div>`;
    });
    container.innerHTML = html;
}

function ckRenderAlerts(alerts) {
    const box = document.getElementById('ck-alert-box');
    const list = document.getElementById('ck-alert-list');
    const bellDot = document.getElementById('bell-dot');
    if (bellDot) bellDot.hidden = !(alerts && alerts.length);
    if (!box || !list) return;
    if (!alerts || alerts.length === 0) {
        box.style.display = 'none';
        list.innerHTML = '';
        return;
    }
    box.style.display = 'block';
    list.innerHTML = alerts.map(function (item) {
        const badgeClass = item._sisaHari == 0 ? 'today' : '';
        const badgeText = item._sisaHari == 0 ? 'Jatuh tempo hari ini' : ('H-' + item._sisaHari);
        return `
            <div class="ck-alert-item">
                <div>
                    <div class="ck-alert-name">${ckEscape(item.namaCatatan)}</div>
                    <div class="ck-alert-sub">Setiap tanggal ${item.tanggalJatuhTempo} · ${ckEscape(item.kategori || '')}</div>
                </div>
                <span class="ck-alert-badge ${badgeClass}">${badgeText}</span>
            </div>`;
    }).join('');
}

function ckCurrentFilters() {
    return {
        search: document.getElementById('ck-search-input').value || '',
        kategori: document.getElementById('ck-kategori-select').value || 'ALL',
        tanggal: document.getElementById('ck-tanggal-select').value || 'ALL'
    };
}

function ckApplyFilter(event) {
    if (event) event.preventDefault();
    const filters = ckCurrentFilters();
    const params = new URLSearchParams({ action: 'list', search: filters.search, kategori: filters.kategori, tanggal: filters.tanggal });
    fetch('index.php?' + params.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.success) {
                ckRenderGrid(data.grouped);
                ckRenderAlerts(data.alerts);
            }
        })
        .catch(function () { alert('Gagal memuat data checklist, coba lagi.'); });
}

function ckToggleOrDelete(action, id) {
    const filters = ckCurrentFilters();
    const params = new URLSearchParams({ action: action, id: id, search: filters.search, kategori: filters.kategori, tanggal: filters.tanggal });
    fetch('index.php?' + params.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.success) {
                ckRenderGrid(data.grouped);
                ckRenderAlerts(data.alerts);
            }
        })
        .catch(function () { alert('Gagal memproses catatan, coba lagi.'); });
}

function ckSubmitAdd(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    fetch('index.php', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: formData
    })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.success) {
                closeCeklisModal();
                form.reset();
                document.getElementById('ck-search-input').value = '';
                document.getElementById('ck-kategori-select').value = 'ALL';
                document.getElementById('ck-tanggal-select').value = 'ALL';
                ckRenderGrid(data.grouped);
                ckRenderAlerts(data.alerts);
            } else if (data.error) {
                alert(data.error);
            }
        })
        .catch(function () { alert('Gagal menyimpan catatan, coba lagi.'); });
}

document.addEventListener('DOMContentLoaded', function () {
    const grid = document.getElementById('ck-grid');
    if (!grid) return;
    grid.addEventListener('click', function (e) {
        const delBtn = e.target.closest('.ck-btn-del');
        if (delBtn) {
            if (confirm('Hapus catatan ini?')) {
                ckToggleOrDelete('delete', delBtn.dataset.id);
            }
            return;
        }
        const editBtn = e.target.closest('.ck-btn-edit');
        if (editBtn) {
            ckOpenEditModal(editBtn.dataset.id);
            return;
        }
        const chk = e.target.closest('.ck-checkbox');
        if (chk) {
            ckToggleOrDelete('toggle', chk.dataset.id);
        }
    });
});
</script>
</section>






    </main>

    <!-- Modal Form Tambah Transaksi -->
    <div class="modal-overlay" id="modal-form">
        <div class="modal-box">
            <div class="modal-header">
                <h3>Tambah Transaksi Baru</h3>
<button class="btn-close" onclick="closeInputModal()">&times;</button>
            </div>
            <form id="transaction-form" onsubmit="submitData(event)">
                <div class="form-group">
                    <label>Tipe Transaksi</label>
                    <select id="in-tipe" class="form-input" onchange="updateFormCategories()" required>
                        <option value="Pemasukan">Pemasukan (+)</option>
                        <option value="Pengeluaran">Pengeluaran (-)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Tanggal</label>
                    <input type="date" id="in-tanggal" class="form-input" required>
                </div>
                <div class="form-group">
                    <label>Kategori</label>
                    <select id="in-kategori" class="form-input" required></select>
                </div>
                <div class="form-group">
                    <label>Nominal (Rp)</label>
                    <input type="number" id="in-nominal" class="form-input" placeholder="Contoh: 50000" required>
                </div>
                <div class="form-group">
                    <label>Minggu Ke-</label>
                    <input type="number" id="in-minggu" class="form-input" placeholder="Contoh: 1">
                </div>
                <div class="form-group">
                                        <label>Tujuan Sheet</label>
                    <input type="hidden" id="in-sheet-target" name="tipe">

                </div>
                <div class="form-group">
                    <label>Keterangan / Catatan</label>
                    <input type="text" id="in-keterangan" class="form-input" placeholder="Catatan transaksi">
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn-cancel" onclick="closeModal()">Batal</button>
                    <button type="submit" id="btn-save" class="btn-submit">Simpan Transaksi</button>
                </div>
            </form>
        </div>
    </div>
   

    </div> <!-- /.app-shell -->
    
    


    <script src="app.js"></script>
</body>
</html>
