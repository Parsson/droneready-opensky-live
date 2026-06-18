<?php
declare(strict_types=1);

/*
  FlyMonitor - /api/flight-store.php
  Speichert Fluganmeldungen inkl. Behörden-PIN serverseitig.
  Der Ordner /api/data muss beschreibbar sein.
*/

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: https://www.flymonitor.de');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    echo json_encode(['ok' => true]);
    exit;
}

$dataDir = __DIR__ . '/data';
$dataFile = $dataDir . '/flight-store.json';

if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0755, true);
}

function read_store(string $file): array {
    if (!file_exists($file)) return [];
    $raw = file_get_contents($file);
    $data = json_decode($raw ?: '[]', true);
    return is_array($data) ? $data : [];
}

function write_store(string $file, array $entries): bool {
    return file_put_contents(
        $file,
        json_encode(array_values($entries), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
        LOCK_EX
    ) !== false;
}

function normalize_pin($value): string {
    return preg_replace('/\D+/', '', (string)$value);
}

function entry_has_pin(array $entry, string $pin): bool {
    $pins = [];

    if (!empty($entry['authorityPin'])) {
        $pins[] = normalize_pin($entry['authorityPin']);
    }

    if (!empty($entry['authorityPins']) && is_array($entry['authorityPins'])) {
        foreach ($entry['authorityPins'] as $p) {
            $pins[] = normalize_pin($p);
        }
    }

    return in_array($pin, array_filter($pins), true);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $pin = normalize_pin($_GET['pin'] ?? '');

    if (!preg_match('/^\d{6}$/', $pin)) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Ungültige PIN.']);
        exit;
    }

    foreach (read_store($dataFile) as $entry) {
        if (is_array($entry) && entry_has_pin($entry, $pin)) {
            echo json_encode(['ok' => true, 'entry' => $entry]);
            exit;
        }
    }

    http_response_code(404);
    echo json_encode(['ok' => false, 'error' => 'Keine Fluganmeldung mit dieser PIN gefunden.']);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true);

    if (!is_array($payload) || ($payload['action'] ?? '') !== 'save' || empty($payload['entry']) || !is_array($payload['entry'])) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Ungültige Speicherdaten.']);
        exit;
    }

    $entry = $payload['entry'];
    $entry['updatedAtServer'] = date('c');

    $entries = read_store($dataFile);
    $registration = trim((string)($entry['registrationNumber'] ?? ''));
    $id = trim((string)($entry['id'] ?? ''));
    $updated = false;

    foreach ($entries as $index => $existing) {
        if (!is_array($existing)) continue;

        $sameId = $id !== '' && trim((string)($existing['id'] ?? '')) === $id;
        $sameReg = $registration !== '' && trim((string)($existing['registrationNumber'] ?? '')) === $registration;

        if ($sameId || $sameReg) {
            $entries[$index] = array_merge($existing, $entry);
            $updated = true;
            break;
        }
    }

    if (!$updated) {
        $entries[] = $entry;
    }

    if (!write_store($dataFile, $entries)) {
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'flight-store.json konnte nicht geschrieben werden. Prüfe Schreibrechte für /api/data.']);
        exit;
    }

    echo json_encode([
        'ok' => true,
        'saved' => true,
        'registrationNumber' => $registration,
        'authorityPin' => $entry['authorityPin'] ?? '',
    ]);
    exit;
}

http_response_code(405);
echo json_encode(['ok' => false, 'error' => 'Methode nicht erlaubt.']);
