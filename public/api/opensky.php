<?php
header("Access-Control-Allow-Origin: *");
header("Content-Type: application/json");

$clientId = "info@bajela.de-api-client";
$clientSecret = "wM1v7nmWcAzvB1Q2rcEE3QgjvBPt6gYX";

$lamin = $_GET["lamin"] ?? 47;
$lomin = $_GET["lomin"] ?? 5;
$lamax = $_GET["lamax"] ?? 55;
$lomax = $_GET["lomax"] ?? 15;

$cacheKey = md5($lamin . "_" . $lomin . "_" . $lamax . "_" . $lomax);
$cacheFile = __DIR__ . "/opensky_cache_" . $cacheKey . ".json";
$cacheAge = 120;

if (file_exists($cacheFile) && time() - filemtime($cacheFile) < $cacheAge) {
    echo file_get_contents($cacheFile);
    exit;
}

function json_error($message, $cacheFile = null) {
    if ($cacheFile && file_exists($cacheFile)) {
        echo file_get_contents($cacheFile);
        exit;
    }

    echo json_encode([
        "error" => $message,
        "states" => []
    ]);
    exit;
}

$tokenUrl = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

$ch = curl_init($tokenUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query([
        "grant_type" => "client_credentials",
        "client_id" => $clientId,
        "client_secret" => $clientSecret
    ]),
    CURLOPT_HTTPHEADER => [
        "Content-Type: application/x-www-form-urlencoded"
    ],
    CURLOPT_TIMEOUT => 20
]);

$tokenResponse = curl_exec($ch);
$tokenHttp = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if (curl_errno($ch)) {
    json_error("Token Fehler: " . curl_error($ch), $cacheFile);
}

curl_close($ch);

$tokenData = json_decode($tokenResponse, true);

if ($tokenHttp !== 200 || empty($tokenData["access_token"])) {
    json_error("Token HTTP " . $tokenHttp, $cacheFile);
}

$accessToken = $tokenData["access_token"];

$apiUrl = "https://opensky-network.org/api/states/all?lamin=$lamin&lomin=$lomin&lamax=$lamax&lomax=$lomax";

$ch = curl_init($apiUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT => 20,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer " . $accessToken,
        "Accept: application/json",
        "User-Agent: DroneReady/1.0"
    ]
]);

$response = curl_exec($ch);
$apiHttp = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if (curl_errno($ch)) {
    json_error("OpenSky Fehler: " . curl_error($ch), $cacheFile);
}

curl_close($ch);

if ($apiHttp !== 200 || !$response) {
    json_error("OpenSky HTTP " . $apiHttp, $cacheFile);
}

file_put_contents($cacheFile, $response);

echo $response;
?>