<?php
declare(strict_types=1);

/*
  FlyMonitor - /api/send-flightmail-browser-pdf.php
  Version: browser-upload-pdf-multi-attachments-2026-06-08-final

  Sendet ausschließlich den hochgeladenen PDF-Anhang aus der App.
  Diese Datei enthält keine PDF-Erzeugung.
*/

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: https://www.flymonitor.de');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Cache-Control');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

$version = 'browser-upload-pdf-multi-attachments-2026-06-08-final';


function fm_clean_filename(string $name, string $fallback = 'Dokument.pdf'): string
{
    $name = basename($name ?: $fallback);
    $name = preg_replace('/[^A-Za-z0-9_.-]/', '-', $name) ?: $fallback;
    if (!str_ends_with(strtolower($name), '.pdf')) {
        $name .= '.pdf';
    }
    return $name;
}

function fm_add_pdf_attachment(string &$body, string $boundary, string $fileName, string $pdfData): void
{
    $body .= '--' . $boundary . "\r\n";
    $body .= 'Content-Type: application/pdf; name="' . $fileName . '"' . "\r\n";
    $body .= 'Content-Transfer-Encoding: base64' . "\r\n";
    $body .= 'Content-Disposition: attachment; filename="' . $fileName . '"' . "\r\n\r\n";
    $body .= chunk_split(base64_encode($pdfData)) . "\r\n";
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    echo json_encode(['ok' => true, 'version' => $version]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'success' => false, 'error' => 'Nur POST erlaubt.', 'version' => $version]);
    exit;
}

if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'multipart/form-data') === false) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'success' => false,
        'error' => 'Falscher Request: Erwartet multipart/form-data mit attachment. JSON/Text wird nicht akzeptiert.',
        'version' => $version
    ]);
    exit;
}

$toRaw = (string)($_POST['to'] ?? $_POST['recipients'] ?? '');
$recipients = preg_split('/[;,]+/', $toRaw) ?: [];
$recipients = array_values(array_unique(array_filter(array_map('trim', $recipients), function ($email) {
    return filter_var($email, FILTER_VALIDATE_EMAIL);
})));

if (!$recipients) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'success' => false, 'error' => 'Keine gültige Empfänger-Adresse übergeben.', 'version' => $version]);
    exit;
}

if (!isset($_FILES['attachment']) || !is_uploaded_file($_FILES['attachment']['tmp_name'])) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'success' => false,
        'error' => 'Kein PDF-Anhang empfangen. Der Server erzeugt absichtlich keine PDF aus Mailtext.',
        'version' => $version
    ]);
    exit;
}

$pdfData = file_get_contents($_FILES['attachment']['tmp_name']);
$fileSize = is_string($pdfData) ? strlen($pdfData) : 0;

if ($pdfData === false || substr($pdfData, 0, 4) !== '%PDF') {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'success' => false,
        'error' => 'Der hochgeladene Anhang ist keine gültige PDF-Datei.',
        'version' => $version
    ]);
    exit;
}

if ($fileSize < 5000) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'success' => false,
        'error' => 'Die empfangene PDF ist zu klein und sieht nicht nach vollständiger Fluganmeldung aus: ' . $fileSize . ' Bytes.',
        'version' => $version
    ]);
    exit;
}

$fileName = fm_clean_filename((string)($_FILES['attachment']['name'] ?? 'UAS-Fluganmeldung.pdf'), 'UAS-Fluganmeldung.pdf');

$extraAttachments = [];

if (!empty($_FILES['attachments']) && is_array($_FILES['attachments']['tmp_name'] ?? null)) {
    foreach ($_FILES['attachments']['tmp_name'] as $index => $tmpName) {
        if (!is_string($tmpName) || !is_uploaded_file($tmpName)) {
            continue;
        }

        $extraData = file_get_contents($tmpName);
        if ($extraData === false || substr($extraData, 0, 4) !== '%PDF') {
            continue;
        }

        $extraAttachments[] = [
            'name' => fm_clean_filename((string)($_FILES['attachments']['name'][$index] ?? ('Dokument-' . ($index + 1) . '.pdf')), 'Dokument.pdf'),
            'data' => $extraData,
            'bytes' => strlen($extraData),
        ];
    }
}

$subject = trim((string)($_POST['subject'] ?? 'UAS-Fluganmeldung FlyMonitor'));
$messageText = (string)($_POST['message'] ?? 'Anbei erhalten Sie die vollständige UAS-Fluganmeldung als PDF.');

$fromEmail = 'noreply@flymonitor.de';
$fromName = 'FlyMonitor';
$to = implode(',', $recipients);
$encodedSubject = '=?UTF-8?B?' . base64_encode($subject) . '?=';
$boundary = 'flymonitor_' . bin2hex(random_bytes(12));

$headers = [];
$headers[] = 'MIME-Version: 1.0';
$headers[] = 'From: ' . $fromName . ' <' . $fromEmail . '>';
$headers[] = 'Reply-To: ' . $fromEmail;
$headers[] = 'Return-Path: ' . $fromEmail;
$headers[] = 'X-Mailer: PHP/' . phpversion();
$headers[] = 'Content-Type: multipart/mixed; boundary="' . $boundary . '"';

$body = '';
$body .= '--' . $boundary . "\r\n";
$body .= "Content-Type: text/plain; charset=UTF-8\r\n";
$body .= "Content-Transfer-Encoding: 8bit\r\n\r\n";
$body .= $messageText . "\r\n\r\n";
$body .= '--' . $boundary . "\r\n";
$body .= 'Content-Type: application/pdf; name="' . $fileName . '"' . "\r\n";
$body .= 'Content-Transfer-Encoding: base64' . "\r\n";
$body .= 'Content-Disposition: attachment; filename="' . $fileName . '"' . "\r\n\r\n";
$body .= chunk_split(base64_encode($pdfData)) . "\r\n";
$body .= '--' . $boundary . "--\r\n";

$errorMessage = null;
set_error_handler(function ($severity, $message) use (&$errorMessage) {
    $errorMessage = $message;
    return true;
});

try {
    $sent = mail($to, $encodedSubject, $body, implode("\r\n", $headers), '-f' . $fromEmail);
} catch (Throwable $e) {
    $sent = false;
    $errorMessage = $e->getMessage();
} finally {
    restore_error_handler();
}

if (!$sent) {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'success' => false,
        'error' => $errorMessage ?: 'PHP mail() konnte die E-Mail nicht senden.',
        'version' => $version
    ]);
    exit;
}

echo json_encode([
    'ok' => true,
    'success' => true,
    'message' => 'E-Mail wurde mit hochgeladener Browser-PDF und Zusatz-PDFs versendet.',
    'attachment' => $fileName,
    'attachmentBytes' => $fileSize,
    'extraAttachments' => array_map(function ($item) { return ['name' => $item['name'], 'bytes' => $item['bytes']]; }, $extraAttachments),
    'extraAttachmentCount' => count($extraAttachments),
    'version' => $version,
    'sentTo' => $recipients
]);
