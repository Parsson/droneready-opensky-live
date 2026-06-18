/*
 * FlyMonitor App.jsx refactor edition
 * Schritt 1: Architektur-Schnittkanten markiert.
 *
 * Empfohlene spätere Zielstruktur, ohne diese Einzeldatei zu brechen:
 * - src/config/api.js                 -> API-Endpunkte, Session-Konstanten
 * - src/services/storage.js           -> safeLoad/safeSave und Migrationen
 * - src/services/apiClient.js         -> apiGetJson/apiPostJson/fetchWithTimeout
 * - src/services/pdfReports.js        -> jsPDF-Exporte
 * - src/domain/flights.js             -> Fluganmeldungen, Status, PINs
 * - src/domain/gallery.js             -> Galerie, Wasserzeichen, Medienlogik
 * - src/domain/crm.js                 -> Kunden, Angebote, Rechnungen
 * - src/components/common/*.jsx       -> Card, Metric, Status, FormField
 * - src/components/maps/*.jsx         -> Leaflet-Kartenkomponenten
 *
 * Diese Datei bleibt absichtlich vollständig nutzbar, damit jede Zwischenversion
 * weiterhin als komplette App.jsx heruntergeladen und getestet werden kann.
 */

/* FlyMonitor Enterprise RC2 Baseline - stable build backup */
import React, { Component, useEffect, useMemo, useState } from "react";


function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => deg * Math.PI / 180;

  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

import {
  AlertTriangle,
  BatteryCharging,
  Bell,
  CheckCircle2,
  Cloud,
  CloudFog,
  CloudRain,
  CloudSun,
  Droplets,
  Download,
  Eye,
  Gauge,
  Layers,
  MapPin,
  Moon,
  Plane,
  Radar,
  Route,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  UploadCloud,
  Wind,
  XCircle,
} from "lucide-react";
import {
  Circle,
  MapContainer,
  Marker,
  Popup,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import { jsPDF } from "jspdf";

const ADMIN_LOGIN_API = "/api/admin-auth.php";
const COMPLETED_FLIGHTS_API = "/api/completed-flights.php";
const DESIGN_SETTINGS_API = "/api/design-settings.php";
const USERS_API = "/api/users.php";
const BACKUP_API = "/api/backup.php";
const AUDIT_LOG_API = "/api/audit-log.php";
const COMPLETED_FLIGHT_ATTACHMENT_UPLOAD_API = "/api/upload-completed-flight-attachment.php";
const ADMIN_SESSION_KEY = "flymonitor_admin_session";
const ADMIN_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const FRONTEND_DEMO_ADMIN_PASSWORD =
  typeof import.meta !== "undefined" && import.meta.env
    ? import.meta.env.VITE_FLYMONITOR_ADMIN_PASSWORD || ""
    : "";

const SECURITY_NOTES = Object.freeze({
  adminSession: "Clientseitige Sessiondaten dienen nur der UI. Autorisierung muss serverseitig geprüft werden.",
  demoPassword: "VITE_FLYMONITOR_ADMIN_PASSWORD darf nur für lokale Demo-/Fallback-Szenarien verwendet werden.",
});

function isBrowserRuntime() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function canUseWebStorage(storageName) {
  try {
    if (!isBrowserRuntime()) return false;
    const storage = window[storageName];
    const probeKey = "__flymonitor_storage_probe__";
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function getSessionStorageSafe() {
  return canUseWebStorage("sessionStorage") ? window.sessionStorage : null;
}

function getLocalStorageSafe() {
  return canUseWebStorage("localStorage") ? window.localStorage : null;
}


async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(url, {
      credentials: "include",
      ...options,
      signal: controller?.signal || options.signal,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        error: data?.error || data?.message || `HTTP ${response.status}`,
        data,
      };
    }

    return data;
  } catch (error) {
    return {
      ok: false,
      offline: true,
      error: error?.name === "AbortError" ? "Zeitüberschreitung der Anfrage" : String(error?.message || error),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}


function appListReducer(state, action) {
  const list = Array.isArray(state) ? state : [];
  switch (action?.type) {
    case "set":
      return Array.isArray(action.items) ? action.items : list;
    case "upsert": {
      const item = action.item || {};
      const id = String(item.id || "");
      if (!id) return [item, ...list];
      const withoutItem = list.filter((entry) => String(entry?.id || "") !== id);
      return [item, ...withoutItem];
    }
    case "remove":
      return list.filter((entry) => String(entry?.id || "") !== String(action.id || ""));
    case "clear":
      return [];
    default:
      return list;
  }
}

function usePersistentState(key, fallback) {
  const [value, setValue] = useState(() => safeLoad(key, fallback));

  useEffect(() => {
    safeSave(key, value);
  }, [key, value]);

  return [value, setValue];
}


function UiCard({ className = "", style = {}, children }) {
  return (
    <section className={`card ${className}`.trim()} style={style}>
      {children}
    </section>
  );
}

function UiButton({ children, variant = "primary", style = {}, ...props }) {
  const variantStyle = variant === "danger" ? LOGOUT_BUTTON_STYLE : {};
  return (
    <button {...props} style={{ ...variantStyle, ...style }}>
      {children}
    </button>
  );
}

function InlineHint({ tone = "", children }) {
  return <p className={`hint ${tone}`.trim()}>{children}</p>;
}


function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isValidDateInput(value) {
  if (!value) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime());
}

function parseCoordinatePair(value) {
  const parts = String(value || "").split(/[;,]/).map((item) => Number(String(item).trim()));
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function validateRequiredFields(data = {}, fields = []) {
  return fields.reduce((errors, field) => {
    if (!String(data?.[field] || "").trim()) errors[field] = "Pflichtfeld";
    return errors;
  }, {});
}


function updateDraftField(setDraft, field, value) {
  setDraft((current) => ({ ...current, [field]: value }));
}

function createEmptyEntity(prefix, defaults = {}) {
  return {
    id: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toLocaleString("de-DE"),
    updatedAt: new Date().toLocaleString("de-DE"),
    ...defaults,
  };
}

function normalizeTextInput(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}


function createPdfDocument(options) {
  return options ? new jsPDF(options) : new jsPDF();
}


const APP_REFACTOR_VERSION = "2026-06-18-step10";

function logClientIssue(scope, error, extra = {}) {
  const entry = {
    id: `client-issue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    scope,
    message: String(error?.message || error || "Unbekannter Fehler"),
    extra,
    createdAt: new Date().toLocaleString("de-DE"),
    appVersion: APP_REFACTOR_VERSION,
  };
  const current = safeLoad("flymonitor_client_issues", []);
  safeSave("flymonitor_client_issues", [entry, ...current].slice(0, 100));
  return entry;
}


const LOGOUT_BUTTON_STYLE = {
  background: "linear-gradient(135deg, #dc2626, #b91c1c)",
  color: "#fff",
  border: "none",
  boxShadow: "0 10px 25px rgba(220, 38, 38, 0.25)",
};

const ADMIN_AREA_STYLE = {
  background: "linear-gradient(135deg, #eef6ff, #f8fbff)",
  border: "2px solid #bfdbfe",
  borderRadius: "32px",
  padding: "24px",
  boxShadow: "0 18px 45px rgba(37, 99, 235, 0.12)",
};

const FLIGHT_STATUS_OPTIONS = ["Geplant", "Erfolgt", "Storno", "Verschiebung"];

const COMMUNICATION_METHODS = [
  "Direkte Sicht-/Rufverbindung",
  "Telefon",
  "Funkgerät",
  "WhatsApp / Messenger",
  "Betriebsfunk",
  "Sonstiges",
];

const FLIGHT_STATUS_STYLES = {
  Geplant: { background: "#fef3c7", color: "#92400e", border: "#f59e0b" },
  Erfolgt: { background: "#dcfce7", color: "#166534", border: "#22c55e" },
  Storno: { background: "#fee2e2", color: "#991b1b", border: "#ef4444" },
  Verschiebung: { background: "#dbeafe", color: "#1d4ed8", border: "#3b82f6" },
};

function formatFlightStatusTimestamp(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("de-DE");
}

function FlightStatusBadge({ value }) {
  const label = value || "Geplant";
  const style = FLIGHT_STATUS_STYLES[label] || FLIGHT_STATUS_STYLES.Geplant;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        width: "fit-content",
        padding: "7px 12px",
        borderRadius: "999px",
        fontWeight: 800,
        background: style.background,
        color: style.color,
        border: `1px solid ${style.border}`,
      }}
    >
      {label}
    </span>
  );
}

const demo = {
  city: "Kiel",
  lat: 54.323,
  lon: 10.122,
  status: "warning",
  summary: "Eingeschränkt empfehlenswert",
  wind: 18,
  gusts: 31,
  temp: 17,
  dew: 9,
  rain: 18,
  cloud: 44,
  visibility: 8,
  kp: 2,
  direction: "NW",
  sunrise: "05:18",
  sunset: "21:17",
  note: "Bitte Wetter, UAS-Zonen, Sichtkontakt und lokale Regeln vor Ort prüfen.",
  forecast: [],
};

const DEFAULT_DRONE_LOCATIONS = [
  {
    id: "loc-kiel-holtenau",
    category: "Kiel",
    name: "Holtenau / Fördebereich",
    address: "Kiel-Holtenau, Schleswig-Holstein, Deutschland",
    coordinates: "54.3718500, 10.1456500",
    lat: 54.37185,
    lon: 10.14565,
    note: "Vor Ort UAS-Zonen, Hafenbereich, Menschenansammlungen und lokale Regeln prüfen.",
  },
  {
    id: "loc-projensdorf",
    category: "Kiel",
    name: "Projensdorf / Grünbereich",
    address: "Projensdorfer Straße, Kiel, Schleswig-Holstein, Deutschland",
    coordinates: "54.3583000, 10.1025000",
    lat: 54.3583,
    lon: 10.1025,
    note: "Geeignet für ruhige Testflüge, trotzdem Abstand zu Wohnbebauung und Wegen beachten.",
  },
  {
    id: "loc-felde",
    category: "Umland",
    name: "Felde / freies Feld",
    address: "Felde, Kreis Rendsburg-Eckernförde, Schleswig-Holstein, Deutschland",
    coordinates: "54.3089000, 9.9283000",
    lat: 54.3089,
    lon: 9.9283,
    note: "Freie Flächen vor Ort prüfen. Grundstücksrechte und Naturschutz beachten.",
  },
  {
    id: "loc-bordesholm",
    category: "Umland",
    name: "Bordesholm / Seeumfeld",
    address: "Bordesholm, Schleswig-Holstein, Deutschland",
    coordinates: "54.1769000, 10.0319000",
    lat: 54.1769,
    lon: 10.0319,
    note: "Gewässer, Vögel und Naturschutzbereiche vor Flugbeginn prüfen.",
  },
];

const WEEKLY_SH_LOCATION_UPDATES = [
  {
    id: "weekly-sh-kiel-falckenstein",
    category: "Kiel",
    name: "Falckenstein / Förde",
    address: "Falckenstein, Kiel, Schleswig-Holstein, Deutschland",
    coordinates: "54.3924000, 10.1901000",
    lat: 54.3924,
    lon: 10.1901,
    note: "Küsten- und Fördebereich. Vor Ort UAS-Zonen, Naturschutz und Personenansammlungen prüfen.",
  },
  {
    id: "weekly-sh-laboe",
    category: "Umland",
    name: "Laboe / Küstenbereich",
    address: "Laboe, Kreis Plön, Schleswig-Holstein, Deutschland",
    coordinates: "54.4049000, 10.2178000",
    lat: 54.4049,
    lon: 10.2178,
    note: "Küstenbereich mit Wetterumschwung. Hafen, Strand, Menschen und lokale Regeln prüfen.",
  },
  {
    id: "weekly-sh-heikendorf",
    category: "Umland",
    name: "Heikendorf / Fördeblick",
    address: "Heikendorf, Kreis Plön, Schleswig-Holstein, Deutschland",
    coordinates: "54.3728000, 10.2054000",
    lat: 54.3728,
    lon: 10.2054,
    note: "Gute Übersichtslage. Vor jedem Flug Grundstücksrechte und Abstände prüfen.",
  },
  {
    id: "weekly-sh-flensburg",
    category: "Schleswig-Holstein",
    name: "Flensburg / Förde",
    address: "Flensburg, Schleswig-Holstein, Deutschland",
    coordinates: "54.7937000, 9.4469000",
    lat: 54.7937,
    lon: 9.4469,
    note: "Förde- und Grenznähe. Amtliche UAS-Informationen und lokale Einschränkungen prüfen.",
  },
  {
    id: "weekly-sh-luebeck",
    category: "Schleswig-Holstein",
    name: "Lübeck / Außenbereich",
    address: "Lübeck, Schleswig-Holstein, Deutschland",
    coordinates: "53.8655000, 10.6866000",
    lat: 53.8655,
    lon: 10.6866,
    note: "Städtischer Bereich. Menschenansammlungen, Wohngebiete und Kontrollzonen prüfen.",
  },
];



const DEFAULT_BLOG_POSTS = [
  {
    id: "blog-checkliste",
    category: "Checklisten",
    title: "Vor dem Drohnenflug: kurze Sicherheitsprüfung",
    date: "2026-05-17",
    text: "Wetter, Sichtkontakt, UAS-Zonen, Akkus, Notlandeplatz und rechtliche Vorgaben vor jedem Start prüfen.",
  },
  {
    id: "blog-wetter",
    category: "Wetter",
    title: "Warum Böen wichtiger sind als Durchschnittswind",
    date: "2026-05-17",
    text: "Für kleine Drohnen sind Windböen oft kritischer als die gemessene Durchschnittsgeschwindigkeit.",
  },
];


const DEFAULT_EMAIL_RECIPIENTS = [
  { id: "sh-dithmarschen", category: "Schleswig-Holstein Behörden", name: "Kreis Dithmarschen", responsibility: "Heide, Brunsbüttel, Büsum, Marne, Meldorf", emails: ["info@dithmarschen.de"], phone: "0481 97-0" },
  { id: "sh-herzogtum-lauenburg", category: "Schleswig-Holstein Behörden", name: "Kreis Herzogtum Lauenburg", responsibility: "Ratzeburg, Geesthacht, Schwarzenbek, Mölln", emails: ["info@kreis-rz.de"], phone: "04541 888-0" },
  { id: "sh-nordfriesland", category: "Schleswig-Holstein Behörden", name: "Kreis Nordfriesland", responsibility: "Husum, Sylt, Föhr, Amrum, Niebüll", emails: ["info@nordfriesland.de"], phone: "04841 67-0" },
  { id: "sh-ostholstein", category: "Schleswig-Holstein Behörden", name: "Kreis Ostholstein", responsibility: "Eutin, Fehmarn, Neustadt i.H., Grömitz", emails: ["info@kreis-oh.de"], phone: "04521 788-0" },
  { id: "sh-pinneberg", category: "Schleswig-Holstein Behörden", name: "Kreis Pinneberg", responsibility: "Elmshorn, Wedel, Quickborn, Tornesch", emails: ["info@kreis-pinneberg.de"], phone: "04121 4502-0" },
  { id: "sh-ploen", category: "Schleswig-Holstein Behörden", name: "Kreis Plön", responsibility: "Plön, Preetz, Schwentinental, Laboe", emails: ["info@kreis-ploen.de"], phone: "04522 743-0" },
  { id: "sh-rendsburg-eckernfoerde", category: "Schleswig-Holstein Behörden", name: "Kreis Rendsburg-Eckernförde", responsibility: "Rendsburg, Eckernförde, Kronshagen", emails: ["info@kreis-rd.de"], phone: "04331 202-0" },
  { id: "sh-schleswig-flensburg", category: "Schleswig-Holstein Behörden", name: "Kreis Schleswig-Flensburg", responsibility: "Schleswig, Kappeln, Glücksburg", emails: ["kreis@schleswig-flensburg.de"], phone: "04621 87-0" },
  { id: "sh-segeberg", category: "Schleswig-Holstein Behörden", name: "Kreis Segeberg", responsibility: "Norderstedt, Bad Segeberg, Kaltenkirchen", emails: ["info@segeberg.de"], phone: "04551 951-0" },
  { id: "sh-steinburg", category: "Schleswig-Holstein Behörden", name: "Kreis Steinburg", responsibility: "Itzehoe, Glückstadt, Wilster", emails: ["info@steinburg.de"], phone: "04821 69-0" },
  { id: "sh-stormarn", category: "Schleswig-Holstein Behörden", name: "Kreis Stormarn", responsibility: "Ahrensburg, Reinbek, Bargteheide", emails: ["info@kreis-stormarn.de"], phone: "04531 160-0" },
  { id: "sh-flensburg", category: "Schleswig-Holstein Städte", name: "Stadt Flensburg", responsibility: "Gesamtes Stadtgebiet Flensburg", emails: ["rathaus@flensburg.de"], phone: "0461 85-0" },
  { id: "sh-kiel", category: "Schleswig-Holstein Städte", name: "Landeshauptstadt Kiel", responsibility: "Gesamtes Stadtgebiet Kiel", emails: ["info@kiel.de"], phone: "0431 901-0" },
  { id: "sh-luebeck", category: "Schleswig-Holstein Städte", name: "Hansestadt Lübeck", responsibility: "Gesamtes Stadtgebiet Lübeck", emails: ["poststelle@luebeck.de"], phone: "0451 122-0" },
  { id: "sh-neumuenster", category: "Schleswig-Holstein Städte", name: "Stadt Neumünster", responsibility: "Gesamtes Stadtgebiet Neumünster", emails: ["rathaus@neumuenster.de"], phone: "04321 942-0" },
  { id: "sh-luftfahrtbehoerde", category: "Zentrale Luftfahrtbehörde Schleswig-Holstein", name: "Luftfahrtbehörde Schleswig-Holstein", responsibility: "Königsweg 59, 24114 Kiel", emails: ["Luftfahrtbehoerde-uas@lbv-sh.landsh.de"], phone: "0431 383-2408" },
];



function normalizeRecipientCategoryName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function findExistingRecipientCategory(categories, value) {
  const normalized = normalizeRecipientCategoryName(value).toLowerCase();
  return (categories || []).find(
    (category) => normalizeRecipientCategoryName(category).toLowerCase() === normalized
  );
}

function findExistingRecipientSubcategory(savedRecipients, category, value) {
  const normalizedCategory = normalizeRecipientCategoryName(category).toLowerCase();
  const normalizedValue = normalizeRecipientCategoryName(value).toLowerCase();

  return (savedRecipients || [])
    .filter(
      (recipient) =>
        normalizeRecipientCategoryName(recipient.category || "Allgemein").toLowerCase() === normalizedCategory
    )
    .map((recipient) => normalizeRecipientCategoryName(recipient.subcategory || "Allgemein"))
    .find((subcategory) => subcategory.toLowerCase() === normalizedValue);
}

function parseEmailRecipientBulkInput(raw, fallbackCategory = "Allgemein", fallbackSubcategory = "") {
  const text = String(raw || "").trim();
  if (!text) return [];

  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const recipients = [];

  for (const line of lines) {
    const emails = Array.from(new Set((line.match(emailRegex) || []).map((email) => email.trim())));
    if (!emails.length) continue;

    const cleanedName = line
      .replace(emailRegex, "")
      .replace(/[;,|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    recipients.push({
      id: `recipient-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      category: fallbackCategory || "Allgemein",
      name: cleanedName || emails.join(", "),
      responsibility: "",
      emails,
      phone: "",
    });
  }

  // Falls alles in einer Zeile mit mehreren E-Mails ohne Namen steht:
  if (!recipients.length) {
    const emails = Array.from(new Set((text.match(emailRegex) || []).map((email) => email.trim())));
    if (emails.length) {
      recipients.push({
        id: `recipient-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        category: fallbackCategory || "Allgemein",
        subcategory: fallbackSubcategory || "",
        name: `${emails.length} Empfänger`,
        responsibility: "",
        emails,
        phone: "",
      });
    }
  }

  return recipients;
}

function normalizeEmailRecipientList(list) {
  const seen = new Set();

  return (Array.isArray(list) ? list : [])
    .map((recipient) => {
      const emails = Array.isArray(recipient?.emails)
        ? recipient.emails
        : String(recipient?.emails || recipient?.email || "")
            .split(/[;,]/)
            .map((item) => item.trim())
            .filter(Boolean);

      return {
        id:
          recipient?.id ||
          `${String(recipient?.category || "Empfänger").toLowerCase()}-${String(recipient?.name || emails[0] || Date.now()).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        category: recipient?.category || "Gespeicherte Empfänger",
        subcategory: recipient?.subcategory || recipient?.subCategory || recipient?.department || "",
        name: recipient?.name || recipient?.label || emails[0] || "Empfänger",
        responsibility: recipient?.responsibility || recipient?.note || "",
        emails,
        phone: recipient?.phone || "",
      };
    })
    .filter((recipient) => recipient.emails.length)
    .filter((recipient) => {
      const key = `${recipient.category}|${recipient.name}|${recipient.emails.join(",")}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function loadEmailRecipientsFromAllKnownKeys() {
  const keys = [
    "droneready_email_recipients",
    "emailRecipients",
    "flymonitor_email_recipients",
    "savedEmailRecipients",
    "uas_email_recipients",
  ];

  let collected = [];
  let foundSavedList = false;

  for (const key of keys) {
    const stored = safeLoad(key, null);
    if (Array.isArray(stored)) {
      foundSavedList = true;
      if (stored.length) {
        collected = [...collected, ...stored];
      }
    }
  }

  // Wenn der Admin bereits gelöscht/gespeichert hat, niemals automatisch Defaults zurückholen.
  if (getLocalStorageSafe()?.getItem("droneready_email_recipients_touched") === "1" || foundSavedList) {
    return normalizeEmailRecipientList(collected);
  }

  return normalizeEmailRecipientList(DEFAULT_EMAIL_RECIPIENTS);
}


const EMPTY_CUSTOMER_FORM = {
  customerNumber: "",
  company: "",
  contactName: "",
  street: "",
  zip: "",
  city: "",
  email: "",
  phone: "",
  website: "",
  portalCode: "",
  notes: "",
};



const DEFAULT_GALLERY_ITEMS = [
  {
    id: "gal-kiel",
    category: "Kiel",
    title: "Beispielmotiv Kiel",
    imageUrl: "",
    text: "Galerieplatzhalter. Im Admin-Bereich kann ein Bildlink ergänzt werden.",
  },
  {
    id: "gal-umland",
    category: "Umland",
    title: "Beispielmotiv Umland",
    imageUrl: "",
    text: "Galerieplatzhalter. Im Admin-Bereich kann ein Bildlink ergänzt werden.",
  },
];

const DEFAULT_GALLERY_CATEGORIES = [
  { id: "gallery-cat-luftaufnahmen", name: "Luftaufnahmen", description: "Professionelle Drohnen- und Übersichtsaufnahmen.", subcategories: ["Baustelle", "Immobilien", "Landschaft"] },
  { id: "gallery-cat-einsaetze", name: "Einsätze", description: "Dokumentationen abgeschlossener Flüge und Projekte.", subcategories: ["Kontrolle", "Dokumentation", "Reportage"] },
  { id: "gallery-cat-allgemein", name: "Allgemein", description: "Weitere Galerieinhalte.", subcategories: ["Sonstiges"] },
];

const DEFAULT_FLYMONITOR_PRO_SETTINGS = {
  watermarkEnabled: false,
  watermarkText: "© FlyMonitor",
  watermarkTemplate: "{copyright}",
  watermarkPosition: "bottom-right",
  watermarkApplyToVideos: false,
  watermarkOpacity: 62,
  showcaseEnabled: true,
  customerPortalEnabled: true,
  autoInvoiceEnabled: false,
  weatherHistoryEnabled: true,
  backupMode: "manuell",
};

const DEFAULT_FLYMONITOR_MISSIONS = [];
const DEFAULT_FLYMONITOR_WEATHER_HISTORY = [];
const DEFAULT_FLYMONITOR_BACKUP_JOBS = [];

const ROLE_RIGHT_KEYS = ["read", "write", "edit", "delete", "export"];
const ROLE_RIGHT_LABELS = {
  read: "Lesen",
  write: "Schreiben",
  edit: "Bearbeiten",
  delete: "Löschen",
  export: "Exportieren",
};
const ROLE_MODULES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "registrations", label: "Fluganmeldungen" },
  { id: "completedFlights", label: "Abgeschlossene Flüge" },
  { id: "missions", label: "Missionen" },
  { id: "gallery", label: "Galerie" },
  { id: "crm", label: "CRM" },
  { id: "invoices", label: "Rechnungen" },
  { id: "analytics", label: "Analytics" },
  { id: "maintenance", label: "Wartung" },
  { id: "backup", label: "Backup" },
  { id: "users", label: "Benutzerverwaltung" },
];
const ROLE_OPTIONS_PRO = [
  { id: "admin", label: "Admin" },
  { id: "pilot", label: "Pilot" },
  { id: "spotter", label: "Spotter" },
  { id: "projektleiter", label: "Projektleiter" },
  { id: "buchhaltung", label: "Buchhaltung" },
  { id: "kunde", label: "Kunde" },
  { id: "behoerde", label: "Behörde" },
  { id: "gast", label: "Gast" },
];

function buildDefaultRolePermissions() {
  const matrix = {};
  const allRights = Object.fromEntries(ROLE_RIGHT_KEYS.map((key) => [key, true]));
  const readOnly = Object.fromEntries(ROLE_RIGHT_KEYS.map((key) => [key, key === "read"]));
  const none = Object.fromEntries(ROLE_RIGHT_KEYS.map((key) => [key, false]));

  ROLE_OPTIONS_PRO.forEach((role) => {
    matrix[role.id] = {};
    ROLE_MODULES.forEach((module) => {
      if (role.id === "admin") matrix[role.id][module.id] = { ...allRights };
      else if (role.id === "pilot") matrix[role.id][module.id] = { ...readOnly, write: ["registrations", "completedFlights", "missions", "gallery", "maintenance"].includes(module.id), edit: ["registrations", "completedFlights", "missions", "gallery", "maintenance"].includes(module.id), export: ["completedFlights", "missions", "gallery"].includes(module.id) };
      else if (role.id === "spotter") matrix[role.id][module.id] = { ...none, read: ["dashboard", "registrations", "missions"].includes(module.id), write: module.id === "missions" };
      else if (role.id === "projektleiter") matrix[role.id][module.id] = { ...readOnly, write: ["missions", "gallery", "crm"].includes(module.id), edit: ["missions", "gallery", "crm"].includes(module.id), export: ["missions", "gallery", "analytics"].includes(module.id) };
      else if (role.id === "buchhaltung") matrix[role.id][module.id] = { ...none, read: ["dashboard", "crm", "invoices", "analytics"].includes(module.id), write: module.id === "invoices", edit: module.id === "invoices", export: ["invoices", "analytics"].includes(module.id) };
      else if (role.id === "kunde") matrix[role.id][module.id] = { ...none, read: ["gallery", "invoices"].includes(module.id), export: module.id === "gallery" };
      else if (role.id === "behoerde") matrix[role.id][module.id] = { ...none, read: ["completedFlights", "registrations"].includes(module.id), export: module.id === "completedFlights" };
      else matrix[role.id][module.id] = { ...none, read: module.id === "dashboard" };
    });
  });
  return matrix;
}

const DEFAULT_ROLE_PERMISSIONS_PRO = buildDefaultRolePermissions();
const DEFAULT_LOCAL_ACCESS_USERS = [];

function normalizeAccessUser(user = {}) {
  const role = String(user.role || "pilot").trim().toLowerCase();
  const status = String(user.status || (Number(user.active) === 0 ? "Inaktiv" : "Aktiv"));
  return {
    id: user.id || `access-user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: user.name || user.displayName || "",
    email: user.email || "",
    role: ROLE_OPTIONS_PRO.some((item) => item.id === role) ? role : "pilot",
    status: ["Aktiv", "Inaktiv", "Gesperrt"].includes(status) ? status : "Aktiv",
    lastLogin: user.lastLogin || user.last_login || "",
    source: user.source || "local",
  };
}

function getRoleLabel(roleId) {
  return ROLE_OPTIONS_PRO.find((role) => role.id === roleId)?.label || roleId || "-";
}

function userStatusTone(status) {
  if (status === "Gesperrt") return "danger";
  if (status === "Inaktiv") return "warning";
  return "good";
}


const AUTHORITY_DOCUMENT_TYPES_PRO = [
  "A1/A3",
  "A2",
  "Versicherung",
  "Betriebsgenehmigung",
  "Aufstiegsgenehmigung",
  "Sondergenehmigung",
  "Behördenschreiben",
  "Sonstiges",
];

const AUTHORITY_DOCUMENT_CATEGORIES_PRO = [
  "Genehmigungen",
  "Versicherungen",
  "Lizenzen",
  "Behördenschreiben",
  "Nachweise",
  "Sonstige Dokumente",
];

const AUTHORITY_REMINDER_DAYS_PRO = [90, 30, 14, 7, 1];

function createEmptyAuthorityDocumentPro() {
  return {
    id: "",
    type: "A2",
    category: "Genehmigungen",
    title: "",
    number: "",
    issuer: "",
    issuedAt: "",
    validUntil: "",
    owner: "Robert Bajela",
    relatedDroneId: "",
    relatedMissionId: "",
    relatedCustomerId: "",
    fileName: "",
    fileUrl: "",
    fileType: "",
    notes: "",
    createdAt: "",
    updatedAt: "",
  };
}

function normalizeAuthorityDocumentPro(document = {}) {
  return {
    ...createEmptyAuthorityDocumentPro(),
    ...document,
    id: document.id || `authority-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: document.type || "A2",
    category: document.category || "Genehmigungen",
    title: document.title || document.name || document.type || "Dokument",
    createdAt: document.createdAt || new Date().toLocaleString("de-DE"),
  };
}

function daysUntilAuthorityExpiryPro(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function getAuthorityDocumentStatusPro(document = {}) {
  const days = daysUntilAuthorityExpiryPro(document.validUntil);
  if (days === null) return { label: "Ohne Frist", tone: "warning", days: null };
  if (days < 0) return { label: "Abgelaufen", tone: "danger", days };
  if (days <= 30) return { label: "Läuft bald ab", tone: "warning", days };
  return { label: "Gültig", tone: "good", days };
}

function formatAuthorityReminderTextPro(document = {}) {
  const status = getAuthorityDocumentStatusPro(document);
  const title = document.title || document.type || "Dokument";
  if (status.days === null) return `${title}: kein Ablaufdatum hinterlegt`;
  if (status.days < 0) return `${title}: seit ${Math.abs(status.days)} Tag(en) abgelaufen`;
  if (status.days === 0) return `${title}: läuft heute ab`;
  return `${title}: läuft in ${status.days} Tag(en) ab`;
}

function buildAuthorityDashboardStatsPro(documents = []) {
  const list = Array.isArray(documents) ? documents : [];
  const statuses = list.map(getAuthorityDocumentStatusPro);
  return {
    total: list.length,
    valid: statuses.filter((item) => item.tone === "good").length,
    warning: statuses.filter((item) => item.tone === "warning" && item.days !== null).length,
    expired: statuses.filter((item) => item.tone === "danger").length,
    withoutDate: statuses.filter((item) => item.days === null).length,
  };
}


const CLOUD_SYNC_TARGET_TYPES_PRO = [
  "Nextcloud",
  "Google Drive",
  "OneDrive",
  "Dropbox",
  "Lokales NAS",
  "FTP/SFTP",
  "Sonstiges",
];

const CLOUD_SYNC_SCOPES_PRO = [
  "Fluganmeldungen",
  "Abgeschlossene Flüge",
  "CRM",
  "Rechnungen",
  "Analytics",
  "Wartung",
  "Behörden-Center",
  "Galerie",
  "Benutzer & Rollen",
  "Backup-Historie",
];

const CLOUD_SYNC_INTERVALS_PRO = ["Manuell", "Täglich", "Wöchentlich", "Monatlich"];

function createEmptyCloudSyncTargetPro() {
  return {
    id: "",
    name: "",
    type: "Nextcloud",
    url: "",
    username: "",
    tokenHint: "",
    interval: "Manuell",
    active: true,
    scopes: ["Fluganmeldungen", "Abgeschlossene Flüge", "CRM", "Rechnungen", "Galerie", "Backup-Historie"],
    lastSyncAt: "",
    nextSyncAt: "",
    status: "Bereit",
    notes: "",
    createdAt: "",
    updatedAt: "",
  };
}

function normalizeCloudSyncTargetPro(target = {}) {
  const interval = CLOUD_SYNC_INTERVALS_PRO.includes(target.interval) ? target.interval : "Manuell";
  const scopes = Array.isArray(target.scopes) && target.scopes.length
    ? target.scopes.filter((scope) => CLOUD_SYNC_SCOPES_PRO.includes(scope))
    : createEmptyCloudSyncTargetPro().scopes;
  return {
    ...createEmptyCloudSyncTargetPro(),
    ...target,
    id: target.id || `cloud-target-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: target.name || target.label || target.type || "Cloud-Ziel",
    type: CLOUD_SYNC_TARGET_TYPES_PRO.includes(target.type) ? target.type : "Nextcloud",
    interval,
    scopes,
    active: target.active !== false,
    status: target.status || "Bereit",
    createdAt: target.createdAt || new Date().toLocaleString("de-DE"),
  };
}

function createCloudSyncLogEntryPro(target = {}, status = "Erfolgreich", details = "") {
  return {
    id: `cloud-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    targetId: target.id || "",
    targetName: target.name || "Cloud-Ziel",
    type: target.type || "Cloud",
    status,
    details,
    createdAt: new Date().toLocaleString("de-DE"),
  };
}

function buildCloudSyncDashboardStatsPro(targets = [], logs = []) {
  const targetList = Array.isArray(targets) ? targets : [];
  const logList = Array.isArray(logs) ? logs : [];
  const lastLog = logList[0] || null;
  const errorCount = logList.filter((log) => String(log.status || "").toLowerCase().includes("fehler")).length;
  const activeTargets = targetList.filter((target) => target.active !== false).length;
  const nextSyncAt = targetList
    .map((target) => target.nextSyncAt)
    .filter(Boolean)
    .sort()[0] || "";

  return {
    totalTargets: targetList.length,
    activeTargets,
    inactiveTargets: targetList.length - activeTargets,
    totalLogs: logList.length,
    errors: errorCount,
    lastSyncAt: lastLog?.createdAt || "Noch keine Synchronisation",
    nextSyncAt: nextSyncAt || "Nach Zeitplan",
  };
}


const PWA_MOBILE_CACHE_SCOPES_PRO = [
  "Missionen",
  "Checklisten",
  "Kunden",
  "Drohnen",
  "Wartung",
  "Behördenfristen",
  "Galerie-Metadaten",
];

const PWA_MOBILE_NOTIFICATION_TYPES_PRO = [
  "Wartung fällig",
  "Behördenfrist",
  "Neue Mission",
  "Offene Rechnung",
  "Cloud Sync",
];

const DEFAULT_MOBILE_PREFLIGHT_CHECKLIST_PRO = [
  "Akkus geprüft",
  "Propeller geprüft",
  "Remote-ID aktiv",
  "Wetter geprüft",
  "Genehmigungen geprüft",
  "Notlandeplatz definiert",
];

const DEFAULT_MOBILE_POSTFLIGHT_CHECKLIST_PRO = [
  "Flug beendet",
  "Medien gesichert",
  "Akkus dokumentiert",
  "Logbuch aktualisiert",
  "Kunde/Projekt informiert",
];

function createEmptyMobileMissionPro() {
  return {
    id: "",
    title: "",
    customerId: "",
    projectId: "",
    pilot: "Robert Bajela",
    drone: "",
    status: "Geplant",
    date: new Date().toISOString().slice(0, 10),
    startTime: "",
    endTime: "",
    address: "",
    lat: "",
    lon: "",
    coordinates: "",
    preflightChecklist: DEFAULT_MOBILE_PREFLIGHT_CHECKLIST_PRO.map((label) => ({ label, done: false })),
    postflightChecklist: DEFAULT_MOBILE_POSTFLIGHT_CHECKLIST_PRO.map((label) => ({ label, done: false })),
    offlineReady: true,
    synced: false,
    mediaCount: 0,
    notes: "",
    createdAt: "",
    updatedAt: "",
  };
}

function normalizeMobileMissionPro(mission = {}) {
  const preflightChecklist = Array.isArray(mission.preflightChecklist) && mission.preflightChecklist.length
    ? mission.preflightChecklist.map((item) => typeof item === "string" ? { label: item, done: false } : { label: item.label || "Check", done: Boolean(item.done) })
    : DEFAULT_MOBILE_PREFLIGHT_CHECKLIST_PRO.map((label) => ({ label, done: false }));

  const postflightChecklist = Array.isArray(mission.postflightChecklist) && mission.postflightChecklist.length
    ? mission.postflightChecklist.map((item) => typeof item === "string" ? { label: item, done: false } : { label: item.label || "Check", done: Boolean(item.done) })
    : DEFAULT_MOBILE_POSTFLIGHT_CHECKLIST_PRO.map((label) => ({ label, done: false }));

  const lat = mission.lat || mission.latitude || "";
  const lon = mission.lon || mission.lng || mission.longitude || "";
  const coordinates = mission.coordinates || (lat && lon ? `${lat}, ${lon}` : "");

  return {
    ...createEmptyMobileMissionPro(),
    ...mission,
    id: mission.id || `mobile-mission-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: mission.title || mission.name || "Mobile Mission",
    status: mission.status || "Geplant",
    lat,
    lon,
    coordinates,
    preflightChecklist,
    postflightChecklist,
    offlineReady: mission.offlineReady !== false,
    synced: Boolean(mission.synced),
    mediaCount: Number(mission.mediaCount || 0),
    createdAt: mission.createdAt || new Date().toLocaleString("de-DE"),
  };
}

function buildMobileDashboardStatsPro(missions = [], settings = {}) {
  const list = Array.isArray(missions) ? missions : [];
  return {
    total: list.length,
    offlineReady: list.filter((mission) => mission.offlineReady !== false).length,
    unsynced: list.filter((mission) => !mission.synced).length,
    active: list.filter((mission) => ["Aktiv", "Gestartet"].includes(mission.status)).length,
    mediaCount: list.reduce((sum, mission) => sum + Number(mission.mediaCount || 0), 0),
    installReady: settings.installPromptSeen ? "Install-Hinweis angezeigt" : "PWA vorbereitet",
  };
}


function parseGalleryCoordinates(item = {}) {
  const raw = String(item.coordinates || item.coords || "").trim();
  if (raw) {
    const parsed = parseCoordinatePair(raw);
    if (parsed) return parsed;
  }

  const lat = Number(item.lat || item.latitude);
  const lon = Number(item.lon || item.lng || item.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return null;
}

function formatGalleryCoordinates(item = {}) {
  const point = parseGalleryCoordinates(item);
  return point ? `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}` : "";
}

function getWatermarkStyle(position = "bottom-right", opacity = 62) {
  const safeOpacity = Math.max(20, Math.min(95, Number(opacity || 62))) / 100;
  const base = {
    position: "absolute",
    zIndex: 4,
    padding: "5px 9px",
    borderRadius: "999px",
    background: `rgba(15,23,42,${safeOpacity})`,
    color: "#fff",
    fontSize: "12px",
    fontWeight: 800,
    pointerEvents: "none",
    backdropFilter: "blur(4px)",
  };
  if (position === "top-left") return { ...base, top: 10, left: 10 };
  if (position === "top-right") return { ...base, top: 10, right: 10 };
  if (position === "bottom-left") return { ...base, bottom: 10, left: 10 };
  return { ...base, bottom: 10, right: 10 };
}


function findWatermarkCustomer(item = {}, customers = []) {
  const customerValue = String(item.customerId || item.customerNumber || item.customerName || "").trim().toLowerCase();
  if (!customerValue) return null;
  return (customers || []).find((customer) =>
    [customer.id, customer.customerNumber, customer.company, customer.contactName, customer.name]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .includes(customerValue)
  ) || null;
}

function findWatermarkMission(item = {}, missions = []) {
  const projectValue = String(item.projectId || item.projectName || item.missionId || item.missionName || "").trim().toLowerCase();
  if (!projectValue) return null;
  return (missions || []).find((mission) =>
    [mission.id, mission.title, mission.name, mission.projectId, mission.projectName]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .includes(projectValue)
  ) || null;
}

function resolveGalleryWatermark(item = {}, settings = {}, customers = [], missions = []) {
  if (!settings?.watermarkEnabled) return null;
  if (item.watermarkMode === "off") return null;

  const mediaType = getGalleryMediaType(item);
  if (mediaType === "video" && !settings.watermarkApplyToVideos) return null;

  const customer = findWatermarkCustomer(item, customers);
  const mission = findWatermarkMission(item, missions);
  const customerName =
    item.customerName ||
    customer?.company ||
    customer?.contactName ||
    customer?.customerNumber ||
    "";
  const projectName =
    item.projectName ||
    item.projectId ||
    mission?.title ||
    mission?.name ||
    "";

  const template = String(item.watermarkText || settings.watermarkTemplate || settings.watermarkText || "© FlyMonitor");
  const replacements = {
    copyright: settings.watermarkText || "© FlyMonitor",
    customer: customerName,
    project: projectName,
    mission: mission?.title || mission?.name || projectName,
    category: item.category || "",
    subcategory: item.subcategory || item.subCategory || "",
    title: item.title || item.name || "",
    date: item.date || item.uploadedAt || new Date().toLocaleDateString("de-DE"),
  };

  const text = template.replace(/\{(copyright|customer|project|mission|category|subcategory|title|date)\}/g, (_, key) => replacements[key] || "").replace(/\s+•\s+$/g, "").replace(/^\s+•\s+/g, "").replace(/\s{2,}/g, " ").trim();

  if (!text) return null;

  return {
    text,
    position: item.watermarkPosition || settings.watermarkPosition || "bottom-right",
    opacity: item.watermarkOpacity || settings.watermarkOpacity || 62,
  };
}

function normalizeGalleryText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeGalleryCategoryList(list, items = []) {
  const byName = new Map();
  const addCategory = (category) => {
    const name = normalizeGalleryText(category?.name || category?.category || category);
    if (!name) return;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    const subcategories = Array.from(new Set([
      ...(Array.isArray(existing?.subcategories) ? existing.subcategories : []),
      ...(Array.isArray(category?.subcategories) ? category.subcategories : []),
      category?.subcategory,
      category?.subCategory,
    ].map(normalizeGalleryText).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"de"));
    byName.set(key, {
      id: existing?.id || category?.id || `gallery-cat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      description: normalizeGalleryText(category?.description || existing?.description || ""),
      subcategories,
    });
  };
  (Array.isArray(list) ? list : []).forEach(addCategory);
  (Array.isArray(items) ? items : []).forEach((item) => {
    const name = normalizeGalleryText(item?.category || "Allgemein");
    const subcategory = normalizeGalleryText(item?.subcategory || item?.subCategory || "");
    addCategory({ name, subcategories: subcategory ? [subcategory] : [] });
  });
  if (!byName.size) DEFAULT_GALLERY_CATEGORIES.forEach(addCategory);
  return Array.from(byName.values()).sort((a,b)=>a.name.localeCompare(b.name,"de"));
}

function getGallerySubcategories(categories = [], categoryName = "") {
  const category = (categories || []).find((item) => normalizeGalleryText(item.name).toLowerCase() === normalizeGalleryText(categoryName).toLowerCase());
  return Array.isArray(category?.subcategories) ? category.subcategories : [];
}

function getGalleryMediaType(item = {}) {
  const explicit = String(item?.mediaType || "").toLowerCase();
  if (explicit === "video" || explicit === "image") return explicit;
  const url = String(item?.videoUrl || item?.imageUrl || "").toLowerCase();
  if (/\.(mp4|webm|mov|m4v|avi)(\?|#|$)/i.test(url)) return "video";
  return item?.videoUrl ? "video" : "image";
}

function getGalleryMediaUrl(item = {}) {
  const type = getGalleryMediaType(item);
  return type === "video" ? normalizeUploadUrl(item.videoUrl || item.imageUrl || "") : normalizeUploadUrl(item.imageUrl || item.videoUrl || "");
}

const DEFAULT_SAFETY_MEASURES = `Es findet kein Überflug über umliegende
Straßen und Wohnhäuser statt. Der Flug
erfolgt nur in dem im Anhang
gekennzeichnetem Bereich (Siehe Anhang).
Der Start- und Landebereich wird bei
Bedarf vor unbefugtem Betreten (Pylonen,
ggf. Absperrband, Tragen einer Warnweste
mit der Aufschrift "Vorsicht Luftaufnahmen
– Bitte Abstand halten") gesichert.
Personen die sich dem UAS dennoch nähern,
werden auf die Gefahrenquellen
hingewiesen, ggf. wird eine Landung in
einer sicheren Entfernung eingeleitet.
Sollte der Flug auf Grund des Wetters
nicht stattfinden können, so werde ich
mich schriftlich/telefonisch bei Ihnen
melden.`;

const LEGAL_CONFIRMATION_TEXT = `Hiermit bestätige ich, alle erforderlichen Dokumente am Tage des Fluges für eventuelle
Kontrollen durch die Polizei, das Ordnungsamt oder der Luftfahrtbehörde mitzuführen.

Hiermit bestätige ich, die rechtlichen Vorgaben der Genehmigung (Allgemeinerlaubnis) für
geographische UAS-Gebiete nach Artikel 15 der Durchführungsverordnung (EU) 2019/947 i.V.m. §
21 h LuftVO zum Betrieb von Luftfahrzeugsystemen im Bundesland Schleswig-Holstein einzuhalten.`;

const emptyFlightReport = {
  registrationNumber: "",
  authorityPin: "",
  pinCreatedAt: "",
  status: "Geplant",
  updatedAt: "",
  cancellationReason: "",
  postponementDate: "",
  postponementStartTime: "",
  postponementEndTime: "",
  date: new Date().toISOString().slice(0, 10),
  startTime: "",
  endTime: "",
  company: "",
  contactName: "Robert Bajela",
  email: "fluganmeldung@pxfoto.de",
  phone: "0178 / 983 97 70",
  street: "Moorkamp 1",
  zip: "24106",
  city: "Kiel",
  operatorId: "DEUkyl6amy3ysdlx",
  pilot: "Robert Bajela",
  missionLeaderName: "Robert Bajela",
  missionLeaderPhone: "0178 / 983 97 70",
  emergencyContactName: "",
  emergencyContactPhone: "",
  spotterAvailable: "Nein",
  spotterName: "",
  spotterPhone: "",
  communicationMethod: "",
  spotters: [],
  exceptionPermit: "DEU-GEO-SHVV00000120/002",
  exceptionPermitValidUntil: "",
  license: "A1/A3, A2",
  licenseValidUntil: "",
  remotePilotId: "DEU-RP-171dgdhj3gl4",
  insurance: "helden.de",
  insuranceNumber: "3W868001",
  insuranceValidUntil: "",
  drone: "",
  weight: "",
  droneSerialNumber: "",
  droneCClass: "",
  droneRemoteId: "",
  startPoint: "",
  landingPoint: "",
  maxHeight: "120",
  purpose: "Film- und Fotoaufnahmen",
  distanceKm: "",
  batteryStart: "",
  batteryEnd: "",
  weather: "",
  wind: "",
  gusts: "",
  incidents: "",
  safetyMeasures: DEFAULT_SAFETY_MEASURES,
  legalConfirm: false,
  legalConfirmationText: LEGAL_CONFIRMATION_TEXT,
  notes: "",
};

const airportAliases = [
  { keys: ["frankfurt", "fra"], name: "Frankfurt Flughafen", latitude: 50.0379, longitude: 8.5622 },
  { keys: ["münchen", "munich", "muc"], name: "München Flughafen", latitude: 48.3538, longitude: 11.7861 },
  { keys: ["berlin", "ber", "brandenburg"], name: "Berlin Brandenburg Flughafen", latitude: 52.3667, longitude: 13.5033 },
  { keys: ["hamburg", "ham"], name: "Hamburg Flughafen", latitude: 53.6304, longitude: 9.9882 },
  { keys: ["düsseldorf", "duesseldorf", "dus"], name: "Düsseldorf Flughafen", latitude: 51.2895, longitude: 6.7668 },
  { keys: ["köln", "koeln", "bonn", "cgn"], name: "Köln/Bonn Flughafen", latitude: 50.8659, longitude: 7.1427 },
  { keys: ["stuttgart", "str"], name: "Stuttgart Flughafen", latitude: 48.6899, longitude: 9.2219 },
  { keys: ["hannover", "hanover", "haj"], name: "Hannover Flughafen", latitude: 52.4611, longitude: 9.6851 },
  { keys: ["nürnberg", "nuernberg", "nue"], name: "Nürnberg Flughafen", latitude: 49.4987, longitude: 11.078 },
  { keys: ["bremen", "bre"], name: "Bremen Flughafen", latitude: 53.0475, longitude: 8.7867 },
  { keys: ["leipzig", "halle", "lej"], name: "Leipzig/Halle Flughafen", latitude: 51.4239, longitude: 12.2364 },
  { keys: ["dortmund", "dtm"], name: "Dortmund Flughafen", latitude: 51.5183, longitude: 7.6122 },
  { keys: ["memmingen", "fmm"], name: "Memmingen Flughafen", latitude: 47.9888, longitude: 10.2395 },
  { keys: ["hahn", "hhn"], name: "Frankfurt-Hahn Flughafen", latitude: 49.9487, longitude: 7.2639 },
];

function safeLoad(key, fallback) {
  try {
    const storage = getLocalStorageSafe();
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeSave(key, value) {
  try {
    const storage = getLocalStorageSafe();
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`Speichern fehlgeschlagen: ${key}`, error);
    return false;
  }
}

function safeRemove(key) {
  try {
    const storage = getLocalStorageSafe();
    if (!storage) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}


function getAdminSession() {
  try {
    const storage = getSessionStorageSafe();
    if (!storage) return null;
    return JSON.parse(storage.getItem(ADMIN_SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function isAdminSessionActive() {
  const session = getAdminSession();
  return Boolean(session?.authenticated && Number(session?.expiresAt || 0) > Date.now());
}

function saveAdminSession(data = {}) {
  const session = {
    authenticated: true,
    role: data.role || "admin",
    email: data.email || "",
    loginAt: data.loginAt || new Date().toISOString(),
    expiresAt: Date.now() + ADMIN_SESSION_TIMEOUT_MS,
  };

  const storage = getSessionStorageSafe();
  storage?.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
  storage?.setItem("droneready_admin_unlocked", "true");
  return session;
}

function refreshAdminSession() {
  const session = getAdminSession();
  if (!session?.authenticated) return null;

  const refreshed = {
    ...session,
    expiresAt: Date.now() + ADMIN_SESSION_TIMEOUT_MS,
  };

  getSessionStorageSafe()?.setItem(ADMIN_SESSION_KEY, JSON.stringify(refreshed));
  return refreshed;
}

function clearAdminSession() {
  const storage = getSessionStorageSafe();
  storage?.removeItem(ADMIN_SESSION_KEY);
  storage?.removeItem("droneready_admin_unlocked");
}

function writeAuditLog(action, details = {}) {
  const current = safeLoad("flymonitor_audit_log", []);
  const entry = {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    action,
    details,
    createdAt: new Date().toLocaleString("de-DE"),
  };

  safeSave("flymonitor_audit_log", [entry, ...current].slice(0, 500));
  return entry;
}

async function postAdminAction(action, payload = {}) {
  const session = getAdminSession();

  try {
    const response = await fetch(ADMIN_LOGIN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action, ...payload, session }),
    });

    return await response.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, offline: true, error: String(error?.message || error) };
  }
}


async function apiGetJson(url) {
  return fetchJsonWithTimeout(url);
}

async function apiPostJson(url, payload = {}) {
  return fetchJsonWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function createAuthorityPin(existingPins = []) {
  const used = new Set((existingPins || []).map(normalizeAuthorityPin).filter(Boolean));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    let number;

    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      number = 100000 + (bytes[0] % 900000);
    } else {
      number = 100000 + Math.floor(Math.random() * 900000);
    }

    const pin = String(number);
    if (!used.has(pin)) return pin;
  }

  return String(Date.now()).slice(-6).padStart(6, "0");
}

function getAllKnownAuthorityPins(entries = []) {
  return (entries || [])
    .flatMap((entry) => [
      entry?.authorityPin,
      ...(Array.isArray(entry?.authorityPins) ? entry.authorityPins : []),
    ])
    .map(normalizeAuthorityPin)
    .filter(Boolean);
}

function createRandomRegistrationNumber() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne I/O/0/1, besser lesbar
  const bytes = new Uint8Array(10);

  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  const code = Array.from(bytes)
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");

  return `FM-${code}`;
}

function createUniqueRegistrationNumber(existingEntries = []) {
  const used = new Set(
    (existingEntries || [])
      .map((entry) => String(entry?.registrationNumber || "").trim().toUpperCase())
      .filter(Boolean)
  );

  let next = createRandomRegistrationNumber();
  let attempts = 0;

  while (used.has(next.toUpperCase()) && attempts < 50) {
    next = createRandomRegistrationNumber();
    attempts += 1;
  }

  return next;
}

function normalizeAuthorityPin(value) {
  return String(value || "").replace(/\D/g, "").trim();
}

function entryHasAuthorityPin(entry, pin) {
  const normalizedPin = normalizeAuthorityPin(pin);
  if (!normalizedPin) return false;

  const pins = [
    entry?.authorityPin,
    ...(Array.isArray(entry?.authorityPins) ? entry.authorityPins : []),
  ]
    .map(normalizeAuthorityPin)
    .filter(Boolean);

  return pins.includes(normalizedPin);
}

function getPinFromCurrentUrl() {
  if (typeof window === "undefined") return "";
  const searchPin = new URLSearchParams(window.location.search).get("pin");
  if (searchPin) return normalizeAuthorityPin(searchPin);

  const hash = window.location.hash || "";
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return normalizeAuthorityPin(new URLSearchParams(hashQuery).get("pin"));
}

function getAuthorityLink() {
  if (typeof window === "undefined") return "#behoerde";
  return `${window.location.origin}${window.location.pathname}#behoerde`;
}

const FLIGHT_STORE_API = "/api/flight-store.php";

async function saveFlightEntryToServer(entry) {
  try {
    const response = await fetch(FLIGHT_STORE_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", entry }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Server-Speicherung fehlgeschlagen");
    }

    return true;
  } catch (error) {
    console.warn("Fluganmeldung konnte nicht serverseitig gespeichert werden:", error);
    return false;
  }
}

async function getFlightEntryFromServerByPin(pin) {
  const normalizedPin = normalizeAuthorityPin(pin);
  if (!/^\d{6}$/.test(normalizedPin)) return null;

  try {
    const response = await fetch(`${FLIGHT_STORE_API}?pin=${encodeURIComponent(normalizedPin)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.entry) return null;

    return data.entry;
  } catch (error) {
    console.warn("Fluganmeldung konnte nicht vom Server geladen werden:", error);
    return null;
  }
}


function buildExactSelectedFlightReportEntry(selectedEntry, currentLogbook, fallbackPinCreator) {
  if (!selectedEntry) return null;

  const registrationNumber =
    String(selectedEntry.registrationNumber || "").trim() ||
    createUniqueRegistrationNumber(currentLogbook);

  const pin =
    normalizeAuthorityPin(selectedEntry.authorityPin) ||
    fallbackPinCreator(getAllKnownAuthorityPins(currentLogbook));

  // Wichtig: Hier wird bewusst NICHT anhand id oder Vorgangsnummer ein anderer
  // Eintrag aus dem Logbuch gesucht. Die PDF wird exakt aus dem Objekt erzeugt,
  // dessen Button "Fluganmeldung senden" angeklickt wurde.
  return {
    ...selectedEntry,
    registrationNumber,
    authorityPin: pin,
    authorityPins: Array.from(
      new Set(
        [
          ...(Array.isArray(selectedEntry.authorityPins) ? selectedEntry.authorityPins : []),
          selectedEntry.authorityPin,
          pin,
        ]
          .map(normalizeAuthorityPin)
          .filter(Boolean)
      )
    ),
    pinCreatedAt: selectedEntry.pinCreatedAt || new Date().toLocaleString("de-DE"),
    safetyMeasures: selectedEntry.safetyMeasures || DEFAULT_SAFETY_MEASURES,
    legalConfirmationText: selectedEntry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT,
  };
}

function mergeServerEntryIntoLocalLogbook(currentLogbook, serverEntry) {
  if (!serverEntry) return currentLogbook;

  const existingIndex = currentLogbook.findIndex(
    (item) =>
      String(item.id) === String(serverEntry.id) ||
      String(item.registrationNumber || "").trim().toLowerCase() ===
        String(serverEntry.registrationNumber || "").trim().toLowerCase()
  );

  if (existingIndex >= 0) {
    return currentLogbook.map((item, index) =>
      index === existingIndex ? { ...item, ...serverEntry } : item
    );
  }

  return [serverEntry, ...currentLogbook].slice(0, 200);
}

function findAirportAlias(value) {
  const t = String(value || "").toLowerCase();
  return airportAliases.find((a) => a.keys.some((k) => t.includes(k))) || null;
}

async function geocodeSearchValue(value) {
  const searchValue = String(value || "").trim();
  const looksLikeAddress =
    /\d/.test(searchValue) ||
    searchValue.includes(",") ||
    /(straße|strasse|str\.|weg|platz|allee|ring|kamp|chaussee|damm)/i.test(searchValue);

  if (looksLikeAddress) {
    const nominatimUrl =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&countrycodes=de&q=${encodeURIComponent(searchValue)}`;

    const data = await fetch(nominatimUrl, {
      headers: {
        Accept: "application/json",
      },
    }).then((r) => r.json());

    if (Array.isArray(data) && data.length) {
      const item = data[0];
      const address = item.address || {};
      const city =
        address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.county ||
        searchValue;

      return {
        name: city,
        latitude: Number(item.lat),
        longitude: Number(item.lon),
        displayName: item.display_name || searchValue,
        source: "Nominatim Adresse",
      };
    }
  }

  const airportAlias = findAirportAlias(searchValue);
  if (airportAlias) {
    return {
      name: airportAlias.name,
      latitude: airportAlias.latitude,
      longitude: airportAlias.longitude,
      displayName: airportAlias.name,
      source: "Flughafen-Alias",
    };
  }

  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchValue)}&count=1&language=de&format=json&countryCode=DE`
  ).then((r) => r.json());

  if (geo.results?.length) {
    const place = geo.results[0];
    return {
      name: place.name,
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
      displayName: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
      source: "Open-Meteo Ort",
    };
  }

  return null;
}

function rec(wind, gusts, rain, vis) {
  if (wind > 25 || gusts > 40 || rain > 50 || vis < 4) {
    return ["danger", "Nicht starten", "Kritische Bedingungen. Flug verschieben."];
  }
  if (wind > 18 || gusts > 30 || rain > 20 || vis < 7) {
    return ["warning", "Eingeschränkt empfehlenswert", "Bedingt geeignet. Böen und lokale Regeln prüfen."];
  }
  return ["good", "Gute Bedingungen", "Wetter sieht gut aus. UAS-Zonen trotzdem prüfen."];
}

function createPlaneIcon(heading = 0) {
  return new L.DivIcon({
    html: `<div style="width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:999px;background:rgba(255,255,255,.94);border:2px solid #0f172a;transform:rotate(${Number(heading) || 0}deg);filter:drop-shadow(0 3px 6px rgba(0,0,0,.45));"><svg width="23" height="23" viewBox="0 0 24 24" fill="#0f172a" xmlns="http://www.w3.org/2000/svg"><path d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"/></svg></div>`,
    className: "planeMarkerIcon",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

const homeIcon = new L.DivIcon({
  html: `<div style="font-size:28px;filter:drop-shadow(0 2px 5px rgba(0,0,0,.35));">📍</div>`,
  className: "",
  iconSize: [28, 28],
  iconAnchor: [14, 28],
});

function Status({ status, children }) {
  const Icon = status === "good" ? CheckCircle2 : status === "danger" ? XCircle : AlertTriangle;
  return (
    <span className={`status ${status}`}>
      <Icon size={17} />
      {children}
    </span>
  );
}


function getWeatherIcon(hour = {}) {
  if (Number(hour.rain || 0) >= 60 || Number(hour.precipitation || 0) > 0.5) {
    return <CloudRain size={20} />;
  }

  if (hour.cloud >= 75) {
    return <Cloud size={20} />;
  }

  if (hour.visibility !== null && hour.visibility <= 3) {
    return <CloudFog size={20} />;
  }

  if (hour.wind >= 25) {
    return <Wind size={20} />;
  }

  return <Sun size={20} />;
}

function buildFallbackHourly(day) {
  const min = Number(day?.min ?? 8);
  const max = Number(day?.max ?? 18);
  const rain = Number(day?.rain ?? 10);

  return Array.from({ length: 12 }, (_, index) => {
    const hourNumber = 7 + index;
    const progress = index / 11;
    const temp = Math.round(min + (max - min) * Math.sin(progress * Math.PI));
    const wind = 10 + Math.round(index % 5);
    const gusts = wind + 8 + Math.round(index % 4);

    return {
      time: `${day?.day || "demo"}-${hourNumber}`,
      hour: `${String(hourNumber).padStart(2, "0")}:00`,
      temp,
      rain,
      precipitation: rain > 40 ? 0.4 : 0,
      wind,
      gusts,
      cloud: Math.min(95, Math.max(10, rain + 25)),
      visibility: 8,
      fallback: true,
    };
  });
}

function FlightPlacesMap({ flights = [] }) {
  const points = (flights || [])
    .map((flight) => ({ flight, point: parseFirstCoordinatePair(flight.coordinates || flight.startPoint || flight.flightArea) }))
    .filter((item) => item.point);

  const center = points[0]?.point ? [points[0].point.lat, points[0].point.lon] : [54.323, 10.122];

  return (
    <div className="mapReal" style={{ minHeight: 480 }}>
      <MapContainer center={center} zoom={9} scrollWheelZoom className="leafletMap" whenReady={(map) => setTimeout(() => map.target.invalidateSize(), 300)}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {points.map(({ flight, point }, index) => (
          <Marker key={flight.id || flight.registrationNumber || index} position={[point.lat, point.lon]} icon={homeIcon}>
            <Popup>
              <b>{flight.registrationNumber || "Flug"}</b><br />
              {flight.date || ""}<br />
              Drohne: {flight.drone || "-"}<br />
              Pilot: {flight.pilot || "-"}<br />
              {flight.flightArea || flight.city || ""}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

function Metric({ icon: Icon, title, value, text, tone = "" }) {
  return (
    <div className={`card metric ${tone}`}>
      <div>
        <p className="label">{title}</p>
        <h3>{value}</h3>
        <p>{text}</p>
      </div>
      <div className="iconbox">
        <Icon size={24} />
      </div>
    </div>
  );
}

function ChangeView({ center }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 12);
    setTimeout(() => map.invalidateSize(), 250);
  }, [center, map]);
  return null;
}

async function reverseGeocodeAddress(lat, lon) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`
    );

    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);

    const data = await response.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch (error) {
    console.warn("Adresse konnte nicht ermittelt werden:", error);
    return `${lat}, ${lon}`;
  }
}

function MapClickHandler({ onPick }) {
  useMapEvents({
    click: async (event) => {
      const lat = Number(event.latlng.lat).toFixed(7);
      const lon = Number(event.latlng.lng).toFixed(7);
      const coordinates = `${lat}, ${lon}`;

      onPick?.({
        lat: Number(lat),
        lon: Number(lon),
        coordinates,
        address: "Adresse wird ermittelt...",
      });

      const address = await reverseGeocodeAddress(lat, lon);

      onPick?.({
        lat: Number(lat),
        lon: Number(lon),
        coordinates,
        address,
      });
    },
  });

  return null;
}

function DroneMap({ result, routeKm, aircraft, pickedLocation, onPick, mapFavoritePlaces = [], setMapFavoritePlaces = () => {} }) {
  const center = [Number(result.lat), Number(result.lon)];
  const route = [center, [Number(result.lat) + 0.01 + routeKm / 1000, Number(result.lon) + 0.018 + routeKm / 900]];

  return (
    <div className="mapReal">
      <MapContainer center={center} zoom={12} scrollWheelZoom className="leafletMap" whenReady={(map) => setTimeout(() => map.target.invalidateSize(), 300)}>
        <ChangeView center={center} />
        <MapClickHandler onPick={onPick} />
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Marker position={center} icon={homeIcon}>
          <Popup>
            <b>{result.city}</b><br />
            {result.summary}<br />
            Wind: {result.wind} km/h
            <hr style={{ margin: "8px 0" }} />
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault();

                const favorite = {
                  id: Date.now(),
                  name: result.city || "Kartenpunkt",
                  address: result.displayName || result.city || `${result.lat}, ${result.lon}`,
                  coordinates: `${Number(result.lat).toFixed(7)}, ${Number(result.lon).toFixed(7)}`,
                  lat: Number(result.lat),
                  lon: Number(result.lon),
                  savedAt: new Date().toLocaleString("de-DE"),
                };

                const next = [
                  favorite,
                  ...(mapFavoritePlaces || []).filter((place) => place.coordinates !== favorite.coordinates),
                ].slice(0, 30);

                setMapFavoritePlaces(next);
                localStorage.setItem("droneready_map_favorites", JSON.stringify(next));
                alert("Kartenpunkt wurde zu Favoriten hinzugefügt.");
              }}
              style={{ fontWeight: 800, color: "#0f172a", textDecoration: "none" }}
            >
              ⭐ Zu Favoriten
            </a>
          </Popup>
        </Marker>
        <Circle center={center} radius={1500} pathOptions={{ color: "#38bdf8", fillColor: "#38bdf8", fillOpacity: 0.12 }} />
        <Circle center={[Number(result.lat) + 0.022, Number(result.lon) + 0.028]} radius={1100} pathOptions={{ color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.16 }}><Popup>UAS-Zone Demo</Popup></Circle>
        <Circle center={[Number(result.lat) - 0.018, Number(result.lon) - 0.03]} radius={750} pathOptions={{ color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.16 }}><Popup>No-Fly Demo</Popup></Circle>
        <Circle center={[Number(result.lat) + 0.01, Number(result.lon) - 0.04]} radius={1400} pathOptions={{ color: "#3b82f6", fillColor: "#3b82f6", fillOpacity: 0.12 }}><Popup>CTR Demo</Popup></Circle>
        
        {pickedLocation ? (
          <Marker position={[Number(pickedLocation.lat), Number(pickedLocation.lon)]} icon={homeIcon}>
            <Popup>
              <b>Ausgewählter Einsatzort</b><br />
              {pickedLocation.address || pickedLocation.coordinates}<br />
              Koordinaten: {pickedLocation.coordinates}
              <hr style={{ margin: "8px 0" }} />
              <a
                href="#"
                onClick={(event) => {
                  event.preventDefault();

                  const favorite = {
                    id: Date.now(),
                    name: "Kartenpunkt",
                    address: pickedLocation.address || pickedLocation.coordinates,
                    coordinates: pickedLocation.coordinates || `${Number(pickedLocation.lat).toFixed(7)}, ${Number(pickedLocation.lon).toFixed(7)}`,
                    lat: Number(pickedLocation.lat),
                    lon: Number(pickedLocation.lon),
                    savedAt: new Date().toLocaleString("de-DE"),
                  };

                  const next = [
                    favorite,
                    ...(mapFavoritePlaces || []).filter((place) => place.coordinates !== favorite.coordinates),
                  ].slice(0, 30);

                  setMapFavoritePlaces(next);
                  localStorage.setItem("droneready_map_favorites", JSON.stringify(next));
                  alert("Kartenpunkt wurde zu Favoriten hinzugefügt.");
                }}
                style={{ fontWeight: 800, color: "#0f172a", textDecoration: "none" }}
              >
                ⭐ Zu Favoriten
              </a>
            </Popup>
          </Marker>
        ) : null}
        {aircraft.map((p) => (
          <Marker key={p.id} position={[Number(p.lat), Number(p.lon)]} icon={createPlaneIcon(p.heading)}>
            <Popup>✈ {p.name}<br />Höhe: {p.alt} m<br />Speed: {p.speed} km/h<br />{p.country || ""}</Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

function getCompletedFlightKey(entry) {
  return String(entry?.completedId || entry?.id || entry?.registrationNumber || "");
}

function getCompletedFlightLabel(entry) {
  const number = entry?.registrationNumber || "Ohne Vorgangsnummer";
  const pin = entry?.authorityPin ? ` · PIN ${entry.authorityPin}` : "";
  const date = entry?.date ? ` · ${entry.date}` : "";
  const place = entry?.city || entry?.flightArea ? ` · ${entry.city || entry.flightArea}` : "";
  const pilot = entry?.pilot ? ` · ${entry.pilot}` : "";
  return `${number}${pin}${date}${place}${pilot}`;
}

function getCompletedFlightCompareValues(entry) {
  if (!entry) return [];

  return [
    entry.completedId,
    entry.sourceLogbookId,
    entry.id,
    entry.registrationNumber,
    entry.authorityPin,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function isLogbookEntryAlreadyCompleted(entry, completedFlights = []) {
  const entryValues = new Set(getCompletedFlightCompareValues(entry));
  if (!entryValues.size) return false;

  return (completedFlights || []).some((completed) =>
    getCompletedFlightCompareValues(completed).some((value) => entryValues.has(value))
  );
}


function calculateFlightDurationMinutes(entry) {
  const start = String(entry?.actualStartTime || entry?.startTime || "").trim();
  const end = String(entry?.actualEndTime || entry?.endTime || "").trim();

  const toMinutes = (value) => {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };

  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);

  if (startMinutes === null || endMinutes === null) return null;

  let diff = endMinutes - startMinutes;
  if (diff < 0) diff += 24 * 60;

  return diff;
}

function formatFlightDuration(entry) {
  const minutes = calculateFlightDurationMinutes(entry);
  if (minutes === null) return "-";

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")} h`;
}

function buildDroneLogbookRows(completedFlights = []) {
  return (completedFlights || []).map((entry) => ({
    id: getCompletedFlightKey(entry),
    date: entry.date || "",
    registrationNumber: entry.registrationNumber || "",
    authorityPin: entry.authorityPin || "",
    drone: entry.drone || "",
    weight: entry.weight || "",
    pilot: entry.pilot || "",
    missionLeaderName: entry.missionLeaderName || "",
    missionLeaderPhone: entry.missionLeaderPhone || "",
    emergencyContactName: entry.emergencyContactName || "",
    emergencyContactPhone: entry.emergencyContactPhone || "",
    droneSerialNumber: entry.droneSerialNumber || "",
    droneCClass: entry.droneCClass || "",
    droneRemoteId: entry.droneRemoteId || "",
    startPoint: entry.startPoint || "",
    landingPoint: entry.landingPoint || "",
    spotterAvailable: entry.spotterAvailable || "Nein",
    spotterName: entry.spotterName || "",
    spotterPhone: entry.spotterPhone || "",
    communicationMethod: entry.communicationMethod || "",
    flightArea: entry.flightArea || entry.city || "",
    coordinates: entry.coordinates || "",
    startTime: entry.actualStartTime || entry.startTime || "",
    endTime: entry.actualEndTime || entry.endTime || "",
    duration: formatFlightDuration(entry),
    durationMinutes: calculateFlightDurationMinutes(entry) || 0,
    maxHeight: entry.maxHeight || "",
    maxDistance: entry.maxDistance || "",
    purpose: entry.purpose || "",
    weather: entry.weather || "",
    wind: entry.actualWind || entry.wind || "",
    gusts: entry.actualGusts || entry.gusts || "",
    batteryStart: entry.batteryStart || "",
    batteryEnd: entry.batteryEnd || "",
    status: entry.status || "Erfolgt",
    authorityInspection: entry.authorityInspection || "",
    incidents: entry.actualIncidents || entry.incidents || "",
    notes: entry.actualNotes || entry.notes || "",
  }));
}

function formatTotalFlightTime(totalMinutes) {
  const minutes = Number(totalMinutes || 0);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}:${String(rest).padStart(2, "0")} h`;
}


function toComparableDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const deMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (deMatch) {
    return `${deMatch[3]}-${String(deMatch[2]).padStart(2, "0")}-${String(deMatch[1]).padStart(2, "0")}`;
  }
  return raw.slice(0, 10);
}

function matchesCompletedFlightFilters(entry, filters = {}) {
  const query = String(filters.search || "").trim().toLowerCase();
  const pilot = String(filters.pilot || "").trim().toLowerCase();
  const drone = String(filters.drone || "").trim().toLowerCase();
  const from = String(filters.from || "").trim();
  const to = String(filters.to || "").trim();
  const date = toComparableDate(entry?.date || entry?.completedAt || entry?.savedAt || entry?.updatedAt);

  if (from && (!date || date < from)) return false;
  if (to && (!date || date > to)) return false;

  if (pilot && String(entry?.pilot || "").trim().toLowerCase() !== pilot) return false;
  if (drone && String(entry?.drone || "").trim().toLowerCase() !== drone) return false;

  if (!query) return true;

  const haystack = [
    entry?.registrationNumber,
    entry?.authorityPin,
    entry?.date,
    entry?.pilot,
    entry?.missionLeaderName,
    entry?.missionLeaderPhone,
    entry?.emergencyContactName,
    entry?.emergencyContactPhone,
    entry?.spotterName,
    entry?.spotterPhone,
    entry?.communicationMethod,
    entry?.drone,
    entry?.city,
    entry?.flightArea,
    entry?.coordinates,
    entry?.purpose,
    entry?.status,
    entry?.authorityType,
    entry?.authorityOffice,
    entry?.authorityResult,
    entry?.incidents,
    entry?.actualIncidents,
    entry?.notes,
    entry?.actualNotes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function filterCompletedFlights(entries = [], filters = {}) {
  return (entries || []).filter((entry) => matchesCompletedFlightFilters(entry, filters));
}

function isFilledDisplayValue(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return false;
  const emptyValues = new Set(["-", "–", "—", "Keine", "Nicht bestätigt", "- / - km/h", "/ km/h", "km/h"]);
  return !emptyValues.has(text);
}

function ReadOnlyValue({ label, value }) {
  if (!isFilledDisplayValue(value)) return null;

  return (
    <div className="listitem">
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}



function normalizeCompletedFlightAttachments(value) {
  const empty = { photos: [], videos: [], reports: [], authorityDocs: [], otherFiles: [] };
  const raw = value && typeof value === "object" ? value : {};
  return {
    photos: Array.isArray(raw.photos) ? raw.photos : [],
    videos: Array.isArray(raw.videos) ? raw.videos : [],
    reports: Array.isArray(raw.reports) ? raw.reports : [],
    authorityDocs: Array.isArray(raw.authorityDocs) ? raw.authorityDocs : [],
    otherFiles: Array.isArray(raw.otherFiles) ? raw.otherFiles : [],
  };
}

function getCompletedFlightAttachmentList(entry) {
  const attachments = normalizeCompletedFlightAttachments(entry?.attachments);
  return [
    ...attachments.photos.map((item) => ({ ...item, group: "Foto" })),
    ...attachments.videos.map((item) => ({ ...item, group: "Video" })),
    ...attachments.reports.map((item) => ({ ...item, group: "Einsatzbericht" })),
    ...attachments.authorityDocs.map((item) => ({ ...item, group: "Behördendokument" })),
    ...attachments.otherFiles.map((item) => ({ ...item, group: "Sonstige Datei" })),
  ].filter((item) => item && (item.name || item.dataUrl || item.url));
}

function formatCompletedFlightAttachmentSummary(entry) {
  const attachments = normalizeCompletedFlightAttachments(entry?.attachments);
  const parts = [
    attachments.photos.length ? `${attachments.photos.length} Foto(s)` : "",
    attachments.videos.length ? `${attachments.videos.length} Video(s)` : "",
    attachments.reports.length ? `${attachments.reports.length} Bericht(e)` : "",
    attachments.authorityDocs.length ? `${attachments.authorityDocs.length} Behördendokument(e)` : "",
    attachments.otherFiles.length ? `${attachments.otherFiles.length} sonstige Datei(en)` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

function normalizeUploadUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

function getCompletedFlightAttachmentHref(file) {
  return normalizeUploadUrl(
    file?.previewUrl ||
      file?.thumbnailUrl ||
      file?.browserUrl ||
      file?.convertedUrl ||
      file?.url ||
      file?.href ||
      file?.dataUrl ||
      ""
  );
}

function getCompletedFlightAttachmentOriginalHref(file) {
  return normalizeUploadUrl(file?.url || file?.href || file?.dataUrl || file?.previewUrl || file?.thumbnailUrl || "");
}


function stripCompletedFlightAttachmentForStorage(file) {
  if (!file || typeof file !== "object") return file;
  const { dataUrl, preview, base64, ...rest } = file;
  return rest;
}

function stripCompletedFlightAttachmentsForStorage(value) {
  const attachments = normalizeCompletedFlightAttachments(value);
  return {
    photos: attachments.photos.map(stripCompletedFlightAttachmentForStorage),
    videos: attachments.videos.map(stripCompletedFlightAttachmentForStorage),
    reports: attachments.reports.map(stripCompletedFlightAttachmentForStorage),
    authorityDocs: attachments.authorityDocs.map(stripCompletedFlightAttachmentForStorage),
    otherFiles: attachments.otherFiles.map(stripCompletedFlightAttachmentForStorage),
  };
}

function stripCompletedFlightForStorage(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...entry,
    attachments: stripCompletedFlightAttachmentsForStorage(entry.attachments),
  };
}

async function uploadCompletedFlightAttachmentToServer(file) {
  if (!file) throw new Error("Keine Datei ausgewählt.");

  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(COMPLETED_FLIGHT_ATTACHMENT_UPLOAD_API, {
    method: "POST",
    body: formData,
    credentials: "include",
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Upload fehlgeschlagen (${response.status})`);
  }

  const uploadedFile = data.file || data.attachment || data.upload || data;

  const serverUrl =
    uploadedFile.url ||
    data.url ||
    data.fileUrl ||
    data.href ||
    uploadedFile.originalUrl ||
    "";
  const previewUrl =
    uploadedFile.previewUrl ||
    uploadedFile.thumbnailUrl ||
    uploadedFile.browserUrl ||
    uploadedFile.convertedUrl ||
    data.previewUrl ||
    data.thumbnailUrl ||
    data.browserUrl ||
    data.convertedUrl ||
    serverUrl;

  return {
    id: uploadedFile.id || `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    url: normalizeUploadUrl(serverUrl),
    previewUrl: normalizeUploadUrl(previewUrl),
    thumbnailUrl: normalizeUploadUrl(uploadedFile.thumbnailUrl || data.thumbnailUrl || previewUrl),
    browserUrl: normalizeUploadUrl(uploadedFile.browserUrl || data.browserUrl || previewUrl),
    path: uploadedFile.path || data.path || data.filePath || "",
    name: uploadedFile.name || data.name || data.fileName || file.name || "Datei",
    type: uploadedFile.type || data.type || data.mime || file.type || "application/octet-stream",
    size: Number(uploadedFile.size || data.size || file.size || 0),
    addedAt: uploadedFile.addedAt || new Date().toLocaleString("de-DE"),
    converted: Boolean(uploadedFile.converted || data.converted),
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("Keine Datei übergeben."));
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      if (!result) {
        reject(new Error(`Datei ${file.name || ""} wurde leer gelesen.`));
        return;
      }
      resolve(result);
    };

    reader.onerror = () => {
      reject(new Error(`Datei ${file.name || ""} konnte nicht gelesen werden.`));
    };

    reader.onabort = () => {
      reject(new Error(`Lesen von ${file.name || ""} wurde abgebrochen.`));
    };

    reader.readAsDataURL(file);
  });
}

function isHeicLikeImage(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return (
    type.includes("heic") ||
    type.includes("heif") ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  );
}

function compressImageAttachment(file, maxSize = 1200, quality = 0.62) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("Keine Bilddatei übergeben."));
      return;
    }

    if (isHeicLikeImage(file)) {
      reject(new Error("HEIC/HEIF-Bilder können im Browser nicht zuverlässig komprimiert werden. Bitte als JPG/PNG exportieren."));
      return;
    }

    const reader = new FileReader();

    reader.onerror = () => {
      reject(new Error(`Bilddatei ${file.name || ""} konnte nicht gelesen werden.`));
    };

    reader.onabort = () => {
      reject(new Error(`Lesen von ${file.name || ""} wurde abgebrochen.`));
    };

    reader.onload = () => {
      const image = new Image();

      image.onerror = () => {
        reject(new Error(`Bild ${file.name || ""} konnte nicht geladen werden. Format eventuell nicht unterstützt.`));
      };

      image.onload = () => {
        try {
          const ratio = Math.min(1, maxSize / Math.max(image.width || 1, image.height || 1));
          const width = Math.max(1, Math.round((image.width || 1) * ratio));
          const height = Math.max(1, Math.round((image.height || 1) * ratio));

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;

          const context = canvas.getContext("2d");
          if (!context) {
            reject(new Error("Bild konnte nicht verarbeitet werden: Canvas nicht verfügbar."));
            return;
          }

          context.drawImage(image, 0, 0, width, height);

          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          if (!dataUrl || dataUrl.length < 50) {
            reject(new Error("Bildkomprimierung lieferte keine gültigen Daten."));
            return;
          }

          resolve({
            dataUrl,
            type: "image/jpeg",
            compressed: true,
            originalSize: file.size || 0,
          });
        } catch (error) {
          reject(new Error(`Bildkomprimierung fehlgeschlagen: ${error?.message || error}`));
        }
      };

      image.src = String(reader.result || "");
    };

    reader.readAsDataURL(file);
  });
}

async function readFileAsCompletedFlightAttachment(file) {
  console.log("ANHANG DATEI:", {
    name: file?.name,
    type: file?.type,
    size: file?.size,
  });

  if (!file) {
    throw new Error("Keine Datei ausgewählt.");
  }

  const isImage = String(file?.type || "").startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(String(file?.name || ""));
  const base = {
    id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name || "Datei",
    size: file.size || 0,
    addedAt: new Date().toLocaleString("de-DE"),
  };

  try {
    const uploaded = await uploadCompletedFlightAttachmentToServer(file);
    if (!uploaded.url) {
      throw new Error("Server-Upload lieferte keine Datei-URL zurück.");
    }

    return {
      ...base,
      id: uploaded.id || base.id,
      name: uploaded.name || base.name,
      type: uploaded.type || file.type || "application/octet-stream",
      size: uploaded.size || base.size,
      addedAt: uploaded.addedAt || base.addedAt,
      url: uploaded.url,
      previewUrl: uploaded.previewUrl || uploaded.url,
      thumbnailUrl: uploaded.thumbnailUrl || uploaded.previewUrl || uploaded.url,
      browserUrl: uploaded.browserUrl || uploaded.previewUrl || uploaded.url,
      path: uploaded.path || "",
      uploaded: true,
      converted: Boolean(uploaded.converted),
      storage: "server",
    };
  } catch (uploadError) {
    console.warn("Server-Upload fehlgeschlagen, versuche kleine lokale Speicherung:", uploadError);
  }

  if (isImage) {
    try {
      const compressed = await compressImageAttachment(file, 900, 0.48);
      return {
        ...base,
        type: compressed.type,
        dataUrl: compressed.dataUrl,
        compressed: compressed.compressed,
        originalSize: compressed.originalSize,
        storage: "local-fallback",
      };
    } catch (compressionError) {
      console.warn("Bildkomprimierung fehlgeschlagen:", compressionError);
      throw compressionError;
    }
  }

  const maxNonImageBytes = 800 * 1024;
  if ((file.size || 0) > maxNonImageBytes) {
    throw new Error(`${file.name || "Datei"} ist zu groß und konnte nicht auf den Server hochgeladen werden.`);
  }

  const dataUrl = await readFileAsDataUrl(file);
  return {
    ...base,
    type: file.type || "application/octet-stream",
    dataUrl,
    storage: "local-fallback",
  };
}


function dataUrlToBlob(dataUrl) {
  const [header, base64] = String(dataUrl || "").split(",");
  const mime = (header.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}



const MAIL_PDF_DOCUMENT_CATEGORIES = [
  "Versicherung",
  "Kompetenznachweis",
  "Fernpilotenzeugnis",
  "Ausnahmegenehmigung",
  "Betriebsgenehmigung",
  "Behördendokument",
  "Datenschutz",
  "Sonstiges",
];

function normalizeMailPdfDocument(document) {
  const doc = document && typeof document === "object" ? document : {};
  return {
    ...doc,
    id: doc.id || `mail-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    group: doc.group || "PDF-Dokument",
    title: doc.title || String(doc.name || "PDF-Dokument").replace(/\.pdf$/i, ""),
    category: doc.category || "Sonstiges",
    documentNumber: doc.documentNumber || "",
    issuedAt: doc.issuedAt || "",
    validUntil: doc.validUntil || "",
    autoAttach: Boolean(doc.autoAttach),
    reminderDays: Number(doc.reminderDays || 30),
    addedAt: doc.addedAt || new Date().toLocaleString("de-DE"),
  };
}

function normalizeMailPdfDocumentList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeMailPdfDocument);
}

function getMailPdfDocumentStatus(document) {
  if (!document?.validUntil) {
    return { tone: "warning", label: "Keine Gültigkeit", daysLeft: null };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const validUntil = new Date(`${document.validUntil}T00:00:00`);

  if (Number.isNaN(validUntil.getTime())) {
    return { tone: "warning", label: "Datum prüfen", daysLeft: null };
  }

  const daysLeft = Math.ceil((validUntil.getTime() - today.getTime()) / 86400000);
  const reminderDays = Number(document.reminderDays || 30);

  if (daysLeft < 0) return { tone: "danger", label: "Abgelaufen", daysLeft };
  if (daysLeft <= reminderDays) return { tone: "warning", label: `Läuft in ${daysLeft} Tag(en) ab`, daysLeft };
  return { tone: "good", label: "Gültig", daysLeft };
}

function summarizeMailPdfDocuments(documents = []) {
  const normalized = normalizeMailPdfDocumentList(documents);
  const expired = normalized.filter((document) => getMailPdfDocumentStatus(document).tone === "danger");
  const expiring = normalized.filter((document) => getMailPdfDocumentStatus(document).tone === "warning" && document.validUntil);
  const autoAttach = normalized.filter((document) => document.autoAttach);
  return { total: normalized.length, expired: expired.length, expiring: expiring.length, autoAttach: autoAttach.length, expiredItems: expired, expiringItems: expiring };
}

function formatMailPdfGermanDate(value) {
  if (!value) return "";
  const raw = String(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}.${match[2]}.${match[1]}`;
  return raw;
}

function formatMailPdfDocumentLine(document) {
  const status = getMailPdfDocumentStatus(document);
  const parts = [
    document.category || "Sonstiges",
    document.documentNumber ? `Nr. ${document.documentNumber}` : "",
    document.validUntil ? `gültig bis ${formatMailPdfGermanDate(document.validUntil)}` : "keine Gültigkeit",
    document.autoAttach ? "Auto-Anhang" : "manuell",
    status.label,
  ].filter(Boolean);
  return parts.join(" · ");
}



const DRONE_STATUS_OPTIONS = ["Aktiv", "Reserve", "Außer Betrieb"];
const DRONE_C_CLASS_OPTIONS = ["C0", "C1", "C2", "C3", "C4", "Bestandsdrohne", "Unbekannt"];
const BATTERY_STATUS_OPTIONS = ["Sehr gut", "Gut", "Beobachten", "Ersetzen", "Außer Betrieb"];
const MAINTENANCE_TYPES = ["Sichtprüfung", "Propellerwechsel", "Firmware-Update", "Reparatur", "Reinigung", "Kalibrierung", "Sonstiges"];

function createEmptyDroneAsset() {
  return {
    id: `drone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "",
    manufacturer: "DJI",
    model: "",
    serialNumber: "",
    remoteId: "",
    cClass: "C1",
    weight: "",
    purchaseDate: "",
    firmwareVersion: "",
    lastInspectionDate: "",
    status: "Aktiv",
    imageUrl: "",
    notes: "",
  };
}

function createEmptyBatteryAsset() {
  return {
    id: `battery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: "",
    droneId: "",
    serialNumber: "",
    chargeCycles: "",
    healthPercent: "100",
    purchaseDate: "",
    lastCheckDate: "",
    status: "Gut",
    notes: "",
  };
}

function createEmptyMaintenanceEntry() {
  return {
    id: `maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    droneId: "",
    date: new Date().toISOString().slice(0, 10),
    type: "Sichtprüfung",
    description: "",
    costs: "",
    nextMaintenance: "",
    notes: "",
  };
}

function normalizeDroneAsset(item) {
  const raw = item && typeof item === "object" ? item : {};
  return {
    ...createEmptyDroneAsset(),
    ...raw,
    id: raw.id || `drone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: raw.name || raw.model || "",
    status: raw.status || "Aktiv",
    cClass: raw.cClass || "Unbekannt",
  };
}

function normalizeBatteryAsset(item) {
  const raw = item && typeof item === "object" ? item : {};
  return {
    ...createEmptyBatteryAsset(),
    ...raw,
    id: raw.id || `battery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status: raw.status || "Gut",
  };
}

function normalizeMaintenanceEntry(item) {
  const raw = item && typeof item === "object" ? item : {};
  return {
    ...createEmptyMaintenanceEntry(),
    ...raw,
    id: raw.id || `maintenance-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: raw.type || "Sichtprüfung",
  };
}

function getDroneDisplayName(drone) {
  if (!drone) return "-";
  return drone.name || [drone.manufacturer, drone.model].filter(Boolean).join(" ") || drone.serialNumber || "Drohne";
}

function getFlightSpotters(entry = {}) {
  const listed = Array.isArray(entry.spotters) ? entry.spotters.filter((item) => item && (item.name || item.phone || item.communicationMethod)) : [];
  if (listed.length) return listed;
  if ((entry.spotterAvailable || "Nein") === "Ja") {
    return [{ name: entry.spotterName || "", phone: entry.spotterPhone || "", communicationMethod: entry.communicationMethod || "" }].filter((item) => item.name || item.phone || item.communicationMethod);
  }
  return [];
}

function formatSpottersSummary(entry = {}) {
  const spotters = getFlightSpotters(entry);
  if (!spotters.length) return (entry.spotterAvailable || "Nein") === "Ja" ? "Ja" : "Nein";
  return spotters.map((item, index) => `${index + 1}. ${item.name || "Beobachter"}${item.phone ? ` · ${item.phone}` : ""}${item.communicationMethod ? ` · ${item.communicationMethod}` : ""}`).join("\n");
}

function parseFirstCoordinatePair(value) {
  const match = String(value || "").match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function findDroneByFlightName(drones = [], flightDroneName = "") {
  const needle = String(flightDroneName || "").trim().toLowerCase();
  if (!needle) return null;
  return (drones || []).find((drone) => {
    const candidates = [drone.id, drone.name, drone.model, `${drone.manufacturer || ""} ${drone.model || ""}`]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    return candidates.includes(needle) || candidates.some((value) => value && needle.includes(value)) || candidates.some((value) => value.includes(needle));
  }) || null;
}

function buildDroneFlightStats(drones = [], completedFlights = []) {
  const rows = buildDroneLogbookRows(completedFlights || []);
  return (drones || []).map((drone) => {
    const displayName = getDroneDisplayName(drone);
    const matchedRows = rows.filter((row) => {
      const linked = findDroneByFlightName([drone], row.drone);
      return Boolean(linked) || String(row.drone || "").trim().toLowerCase() === displayName.toLowerCase();
    });
    const totalMinutes = matchedRows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
    const lastFlight = matchedRows
      .map((row) => row.date)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || "";
    const maxHeight = matchedRows.reduce((max, row) => Math.max(max, Number(String(row.maxHeight || "").replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0), 0);
    const maxDistance = matchedRows.reduce((max, row) => Math.max(max, Number(String(row.maxDistance || "").replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0), 0);
    return {
      droneId: drone.id,
      displayName,
      flights: matchedRows.length,
      totalMinutes,
      totalTime: formatTotalFlightTime(totalMinutes),
      averageTime: matchedRows.length ? formatTotalFlightTime(Math.round(totalMinutes / matchedRows.length)) : "0:00 h",
      lastFlight,
      maxHeight,
      maxDistance,
    };
  });
}

function getBatteryWarningTone(battery) {
  const cycles = Number(battery?.chargeCycles || 0);
  const health = Number(battery?.healthPercent || 100);
  if (cycles >= 250 || health <= 70 || battery?.status === "Ersetzen" || battery?.status === "Außer Betrieb") return "danger";
  if (cycles >= 150 || health <= 85 || battery?.status === "Beobachten") return "warning";
  return "good";
}

function getMaintenanceTone(entry) {
  if (!entry?.nextMaintenance) return "good";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const next = new Date(`${entry.nextMaintenance}T00:00:00`);
  if (Number.isNaN(next.getTime())) return "warning";
  const days = Math.ceil((next.getTime() - today.getTime()) / 86400000);
  if (days < 0) return "danger";
  if (days <= 14) return "warning";
  return "good";
}



function getEntryYear(value) {
  const date = toComparableDate(value);
  const year = String(date || "").slice(0, 4);
  return /^\d{4}$/.test(year) ? year : "";
}

function getBusinessAvailableYears(...lists) {
  const years = new Set([String(new Date().getFullYear())]);
  lists.flat().forEach((entry) => {
    const year = getEntryYear(entry?.date || entry?.completedAt || entry?.savedAt || entry?.updatedAt || entry?.nextMaintenance);
    if (year) years.add(year);
  });
  return Array.from(years).sort((a, b) => Number(b) - Number(a));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCsvFile(fileName, rows) {
  const csv = rows.map((row) => row.map(csvCell).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function groupFlightRowsByMonth(rows = []) {
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    label: `${String(index + 1).padStart(2, "0")}`,
    flights: 0,
    minutes: 0,
  }));

  rows.forEach((row) => {
    const date = toComparableDate(row.date);
    const month = Number(String(date).slice(5, 7));
    if (!month || month < 1 || month > 12) return;
    months[month - 1].flights += 1;
    months[month - 1].minutes += Number(row.durationMinutes || 0);
  });

  return months;
}

function buildBusinessDashboardStats({ completedFlights = [], droneAssets = [], batteryAssets = [], maintenanceEntries = [], mailPdfDocuments = [] }) {
  const flightRows = buildDroneLogbookRows(completedFlights);
  const now = new Date();
  const currentYear = String(now.getFullYear());
  const currentMonth = `${currentYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));

  const flightsThisYear = flightRows.filter((row) => getEntryYear(row.date) === currentYear);
  const flightsThisMonth = flightRows.filter((row) => String(toComparableDate(row.date)).startsWith(currentMonth));
  const flightsThisWeek = flightRows.filter((row) => {
    const date = new Date(`${toComparableDate(row.date)}T00:00:00`);
    return Number.isFinite(date.getTime()) && date >= weekStart;
  });

  const totalMinutes = flightRows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
  const authorityControls = completedFlights.filter((entry) => String(entry.authorityInspection || "").toLowerCase() === "ja" || entry.authorityType || entry.authorityOffice || entry.authorityResult);
  const maintenanceCosts = maintenanceEntries.reduce((sum, entry) => sum + (Number(String(entry.costs || "").replace(/[^0-9.,-]/g, "").replace(",", ".")) || 0), 0);
  const documentSummary = summarizeMailPdfDocuments(mailPdfDocuments);
  const batteryCritical = batteryAssets.filter((battery) => getBatteryWarningTone(battery) !== "good");
  const averageCycles = batteryAssets.length
    ? Math.round(batteryAssets.reduce((sum, battery) => sum + Number(battery.chargeCycles || 0), 0) / batteryAssets.length)
    : 0;
  const dueMaintenance = maintenanceEntries.filter((entry) => ["warning", "danger"].includes(getMaintenanceTone(entry)));

  return {
    flightRows,
    totalFlights: flightRows.length,
    flightsThisYear: flightsThisYear.length,
    flightsThisMonth: flightsThisMonth.length,
    flightsThisWeek: flightsThisWeek.length,
    totalMinutes,
    totalTime: formatTotalFlightTime(totalMinutes),
    averageFlightTime: flightRows.length ? formatTotalFlightTime(Math.round(totalMinutes / flightRows.length)) : "0:00 h",
    drones: droneAssets.length,
    activeDrones: droneAssets.filter((drone) => drone.status !== "Außer Betrieb").length,
    authorityControls: authorityControls.length,
    authorityPolice: authorityControls.filter((entry) => String(entry.authorityType || "").toLowerCase().includes("polizei")).length,
    authorityOffice: authorityControls.filter((entry) => String(entry.authorityType || "").toLowerCase().includes("ordnungs")).length,
    authorityLba: authorityControls.filter((entry) => String(entry.authorityType || "").toLowerCase().includes("lba")).length,
    maintenanceTotal: maintenanceEntries.length,
    maintenanceDue: dueMaintenance.length,
    maintenanceCosts,
    batteries: batteryAssets.length,
    batteryCritical: batteryCritical.length,
    averageCycles,
    documents: documentSummary.total,
    documentsExpiring: documentSummary.expiring,
    documentsExpired: documentSummary.expired,
    months: groupFlightRowsByMonth(flightRows),
    flightsByDrone: Array.from(new Set(flightRows.map((row) => row.drone).filter(Boolean))).map((drone) => {
      const rows = flightRows.filter((row) => row.drone === drone);
      const minutes = rows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
      return { drone, flights: rows.length, minutes, totalTime: formatTotalFlightTime(minutes) };
    }).sort((a, b) => b.minutes - a.minutes),
  };
}

function generateAuthorityControlProtocolPdf(flight) {
  if (!flight) return;

  const pdf = createPdfDocument();
  const registrationNumber = flight.registrationNumber || "Flug";
  const controlDate = formatFlightStatusTimestamp(flight.authorityControlDate);

  pdf.setFontSize(18);
  pdf.text("Behördenkontrollprotokoll", 20, 22);

  pdf.setFontSize(11);
  const rows = [
    ["Vorgangsnummer", registrationNumber],
    ["Behörden-PIN", flight.authorityPin || ""],
    ["Kontrolle erfolgt", flight.authorityInspection || ""],
    ["Kontrollierende Behörde", flight.authorityType || ""],
    ["Dienststelle", flight.authorityOffice || ""],
    ["Kontrollzeitpunkt", controlDate || ""],
    ["Ergebnis der Kontrolle", flight.authorityResult || ""],
    ["Pilot", flight.pilot || ""],
    ["Einsatzleiter", flight.missionLeaderName || ""],
    ["Telefon Einsatzleiter", flight.missionLeaderPhone || ""],
    ["Notfallkontakt", flight.emergencyContactName || ""],
    ["Telefon Notfallkontakt", flight.emergencyContactPhone || ""],
    ["Spotter / Beobachter", formatSpottersSummary(flight)],
    ["Drohne", flight.drone || ""],
    ["Remote-ID", flight.droneRemoteId || ""],
    ["Fluggebiet", flight.flightArea || ""],
  ];

  let y = 40;
  rows.forEach(([label, value]) => {
    if (!isFilledDisplayValue(value)) return;
    pdf.setFont(undefined, "bold");
    pdf.text(`${label}:`, 20, y);
    pdf.setFont(undefined, "normal");
    const lines = pdf.splitTextToSize(String(value), 95);
    pdf.text(lines, 75, y);
    y += Math.max(8, lines.length * 6);
  });

  const notes = flight.authorityInspectionNotes || "";
  if (isFilledDisplayValue(notes)) {
    y += 4;
    pdf.setFont(undefined, "bold");
    pdf.text("Bemerkungen:", 20, y);
    y += 8;
    pdf.setFont(undefined, "normal");
    pdf.text(pdf.splitTextToSize(String(notes), 170), 20, y);
  }

  pdf.save(`Kontrollprotokoll_${String(registrationNumber).replace(/[^a-zA-Z0-9_-]+/g, "_")}.pdf`);
}


function CompletedFlightAttachmentsView({ entry, authoritiesOnly = false }) {
  const files = getCompletedFlightAttachmentList(entry);
  if (!files.length) return null;
  if (authoritiesOnly && !entry?.attachmentsVisibleForAuthorities) return null;

  const isImageFile = (file) =>
    file?.group === "Foto" ||
    String(file?.type || "").startsWith("image/") ||
    String(file?.dataUrl || file?.url || "").startsWith("data:image/") ||
    /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(file?.name || ""));

  const imageFiles = files.filter((file) => {
    const href = getCompletedFlightAttachmentHref(file);
    return href && isImageFile(file);
  });

  const otherFiles = files.filter((file) => !imageFiles.includes(file));

  return (
    <div className="listitem" style={{ gridColumn: "1 / -1", alignItems: "stretch" }}>
      <strong>{authoritiesOnly ? "Medien / Nachweise zum tatsächlichen Flug" : "Dokumente & Medien"}</strong>
      <div style={{ display: "grid", gap: "14px" }}>
        {authoritiesOnly && imageFiles.length ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <span style={{ color: "#64748b", fontWeight: 700 }}>
              Hochgeladene Fotos als Vorschau
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: "12px",
              }}
            >
              {imageFiles.map((file, index) => {
                const href = getCompletedFlightAttachmentHref(file);
                const originalHref = getCompletedFlightAttachmentOriginalHref(file) || href;
                const title = file.name || `Foto ${index + 1}`;

                return (
                  <a
                    key={file.id || `${file.name}-${index}`}
                    href={originalHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={title}
                    style={{
                      display: "grid",
                      gap: "6px",
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <img
                      src={href}
                      alt={title}
                      loading="lazy"
                      style={{
                        width: "100%",
                        height: "92px",
                        objectFit: "cover",
                        borderRadius: "14px",
                        border: "1px solid #cbd5e1",
                        background: "#f8fafc",
                        boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)",
                      }}
                    />
                    <span
                      style={{
                        fontSize: "12px",
                        color: "#475569",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {title}
                    </span>
                  </a>
                );
              })}
            </div>
          </div>
        ) : null}

        {(!authoritiesOnly || otherFiles.length) ? (
          <div style={{ display: "grid", gap: "8px" }}>
            {files.map((file, index) => {
              const href = getCompletedFlightAttachmentHref(file);
              const originalHref = getCompletedFlightAttachmentOriginalHref(file) || href;
              const title = file.name || `Datei ${index + 1}`;
              const showImagePreview = !authoritiesOnly && href && isImageFile(file);

              if (authoritiesOnly && imageFiles.includes(file)) return null;

              return (
                <div key={file.id || `${file.name}-${index}`} style={{ display: "grid", gap: "6px" }}>
                  <span>
                    {file.group}: {href ? (
                      <a href={originalHref} target="_blank" rel="noopener noreferrer">
                        {title}
                      </a>
                    ) : (
                      title
                    )}
                  </span>

                  {showImagePreview ? (
                    <a href={originalHref} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                      <img
                        src={href}
                        alt={title}
                        loading="lazy"
                        style={{
                          width: "100%",
                          maxWidth: "420px",
                          maxHeight: "260px",
                          objectFit: "contain",
                          borderRadius: "16px",
                          border: "1px solid #cbd5e1",
                          background: "#f8fafc",
                          boxShadow: "0 8px 22px rgba(15, 23, 42, 0.12)",
                        }}
                      />
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}


function MapFavoriteSelect({
  favorites = [],
  onSelect,
  onSelectMultiple,
  selectedFavoriteIds = [],
  label = "Gespeicherten Kartenfavorit übernehmen"
}) {
  if (!favorites.length) {
    return (
      <label>
        {label}
        <select disabled value="" style={{ height: "46px", borderRadius: "14px", border: "1px solid #cbd5e1", padding: "0 12px", background: "white", color: "#0f172a" }}>
          <option>Noch keine Kartenfavoriten gespeichert</option>
        </select>
      </label>
    );
  }

  return (
    <label>
      {label}
      <select
        multiple
        value={selectedFavoriteIds}
        size={Math.min(6, Math.max(3, favorites.length))}
        style={{
          minHeight: "118px",
          borderRadius: "14px",
          border: "1px solid #cbd5e1",
          padding: "8px 12px",
          background: "white",
          color: "#0f172a"
        }}
        onChange={(event) => {
          const ids = Array.from(event.target.selectedOptions).map((option) => option.value);
          const selected = favorites.filter((item) => ids.includes(String(item.id)));

          if (onSelectMultiple) {
            onSelectMultiple(selected);
          } else if (selected[0]) {
            onSelect?.(selected[0]);
          }
        }}
      >
        {favorites.map((favorite) => (
          <option key={favorite.id} value={favorite.id}>
            {(favorite.address || favorite.coordinates || "Kartenfavorit").slice(0, 95)}
          </option>
        ))}
      </select>
      <span style={{ color: "#64748b", fontSize: "13px" }}>
        Mehrere Einträge mit Strg/Cmd oder Umschalt auswählen.
      </span>
    </label>
  );
}

function applyMapFavoritesToFlightData(currentData, favorites = []) {
  const selected = (favorites || []).filter(Boolean);

  if (!selected.length) return currentData;

  const uniqueSelected = Array.from(
    new Map(
      selected.map((favorite) => [
        String(favorite.id || favorite.coordinates || favorite.address || Math.random()),
        favorite,
      ])
    ).values()
  );

  const addresses = uniqueSelected
    .map((favorite) => {
      const label = [favorite.name, favorite.address || favorite.coordinates]
        .filter(Boolean)
        .join(" – ");
      return label || favorite.coordinates || "";
    })
    .filter(Boolean);

  const coordinates = uniqueSelected
    .map((favorite) => favorite.coordinates || (favorite.lat && favorite.lon ? `${favorite.lat}, ${favorite.lon}` : ""))
    .filter(Boolean);

  return {
    ...currentData,
    mapFavoriteIds: uniqueSelected.map((favorite) => favorite.id),
    selectedMapFavorites: uniqueSelected,
    flightArea: addresses.join("\n"),
    coordinates: coordinates.join("\n"),
    city: currentData.city || addresses[0] || currentData.city,
  };
}


function applyMapFavoriteToFlightData(currentData, favorite) {
  return applyMapFavoritesToFlightData(currentData, favorite ? [favorite] : []);
}

function FlightRegistrationEditFields({ data, setData, mapFavoritePlaces = [], droneAssets = [], usedAuthorityPins = [], existingFlightEntries = [] }) {
  const update = (field, value) => setData({ ...data, [field]: value });

  const updateSpotter = (index, field, value) => {
    const current = Array.isArray(data.spotters) ? [...data.spotters] : [];
    current[index] = { ...(current[index] || {}), [field]: value };
    setData({ ...data, spotters: current, spotterAvailable: current.length ? "Ja" : data.spotterAvailable });
  };

  const addSpotter = () => {
    const current = Array.isArray(data.spotters) ? data.spotters : [];
    setData({ ...data, spotterAvailable: "Ja", spotters: [...current, { name: "", phone: "", communicationMethod: "Direkte Sicht-/Rufverbindung" }] });
  };

  const removeSpotter = (index) => {
    const current = (Array.isArray(data.spotters) ? data.spotters : []).filter((_, i) => i !== index);
    setData({ ...data, spotters: current, spotterAvailable: current.length ? "Ja" : data.spotterAvailable });
  };

  const applyDroneSelection = (selectedDrone) => {
    const known = (droneAssets || []).find((drone) => {
      const values = [drone.id, drone.name, drone.model, `${drone.manufacturer || ""} ${drone.model || ""}`].map((v) => String(v || "").trim());
      return values.includes(selectedDrone);
    });
    setData({
      ...data,
      drone: selectedDrone,
      weight: known?.weight || (selectedDrone === "DJI Mavic Air 2" ? "570" : selectedDrone === "DJI Air 3 S" ? "740" : data.weight || ""),
      droneSerialNumber: known?.serialNumber || data.droneSerialNumber || "",
      droneCClass: known?.cClass || data.droneCClass || "",
      droneRemoteId: known?.remoteId || data.droneRemoteId || "",
    });
  };

  const updateStatusField = (field, value) => {
    setData({
      ...data,
      [field]: value,
      updatedAt: new Date().toISOString(),
    });
  };

  const currentStatus = data.status || "Geplant";

  return (
    <>
      <div className="profileGrid">
        <label>
          Vorgangsnummer
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={data.registrationNumber || ""}
              onChange={(e) => update("registrationNumber", e.target.value.trim().toUpperCase())}
              placeholder="z. B. FM-2026-000001"
              style={{ fontWeight: 800 }}
            />
            <button
              type="button"
              className="secondary smallButton"
              onClick={() => update("registrationNumber", createUniqueRegistrationNumber(existingFlightEntries))}
              title="Automatische Vorgangsnummer erzeugen"
              style={{ whiteSpace: "nowrap" }}
            >
              Auto
            </button>
          </div>
        </label>

        <label>
          Behörden-PIN
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              inputMode="numeric"
              maxLength={6}
              value={data.authorityPin || ""}
              onChange={(e) => update("authorityPin", e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="leer = automatisch"
              style={{ fontWeight: 800 }}
            />
            <button
              type="button"
              className="secondary smallButton"
              onClick={() => {
                const pin = createAuthorityPin([
                  ...(Array.isArray(usedAuthorityPins) ? usedAuthorityPins : []),
                  ...(Array.isArray(data.authorityPins) ? data.authorityPins : []),
                ]);
                setData({
                  ...data,
                  authorityPin: pin,
                  authorityPins: Array.from(new Set([...(Array.isArray(data.authorityPins) ? data.authorityPins : []), pin].map(normalizeAuthorityPin).filter(Boolean))),
                  pinCreatedAt: data.pinCreatedAt || new Date().toLocaleString("de-DE"),
                });
              }}
              title="Automatische Behörden-PIN erzeugen"
              style={{ whiteSpace: "nowrap" }}
            >
              Auto
            </button>
          </div>
          <small>Leer lassen für automatische PIN-Vergabe beim Speichern.</small>
        </label>

        <label>
          Status der Fluganmeldung
          <select
            value={currentStatus}
            onChange={(e) => updateStatusField("status", e.target.value)}
            style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px", fontWeight: 800 }}
          >
            {FLIGHT_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>

        <label>
          Aktualisiert am
          <input value={formatFlightStatusTimestamp(data.updatedAt)} readOnly style={{ background: "#f1f5f9", fontWeight: 700 }} />
        </label>

        {currentStatus === "Storno" ? (
          <label style={{ gridColumn: "1 / -1" }}>
            Storno-Begründung
            <textarea
              rows={3}
              value={data.cancellationReason || ""}
              onChange={(e) => updateStatusField("cancellationReason", e.target.value)}
              placeholder="Warum wurde die Fluganmeldung storniert?"
            />
          </label>
        ) : null}

        {currentStatus === "Verschiebung" ? (
          <>
            <label>
              Neues Flugdatum
              <input type="date" value={data.postponementDate || ""} onChange={(e) => updateStatusField("postponementDate", e.target.value)} />
            </label>
            <label>
              Neue Startzeit
              <input type="time" value={data.postponementStartTime || ""} onChange={(e) => updateStatusField("postponementStartTime", e.target.value)} />
            </label>
            <label>
              Neue Endzeit
              <input type="time" value={data.postponementEndTime || ""} onChange={(e) => updateStatusField("postponementEndTime", e.target.value)} />
            </label>
          </>
        ) : null}

        <label>Firma<input value={data.company || ""} onChange={(e) => update("company", e.target.value)} /></label>
        <label>Ansprechpartner<input value={data.contactName || ""} onChange={(e) => update("contactName", e.target.value)} /></label>

        <label>E-Mail<input type="email" value={data.email || ""} onChange={(e) => update("email", e.target.value)} /></label>
        <label>Telefon<input value={data.phone || ""} onChange={(e) => update("phone", e.target.value)} /></label>
        <label>Straße<input value={data.street || ""} onChange={(e) => update("street", e.target.value)} /></label>

        <label>PLZ<input value={data.zip || ""} onChange={(e) => update("zip", e.target.value)} /></label>
        <label>Ort<input value={data.city || ""} onChange={(e) => update("city", e.target.value)} /></label>
        <label>Betreiber-ID<input value={data.operatorId ?? "DEUkyl6amy3ysdlx"} onChange={(e) => update("operatorId", e.target.value)} /></label>

        <label>Pilot<input value={data.pilot || ""} onChange={(e) => update("pilot", e.target.value)} /></label>
        <label>Einsatzleiter<input value={data.missionLeaderName || ""} onChange={(e) => update("missionLeaderName", e.target.value)} placeholder="Name des Einsatzleiters" /></label>
        <label>Telefon Einsatzleiter<input value={data.missionLeaderPhone || ""} onChange={(e) => update("missionLeaderPhone", e.target.value)} placeholder="Telefon Einsatzleiter" /></label>
        <label>Notfallkontakt<input value={data.emergencyContactName || ""} onChange={(e) => update("emergencyContactName", e.target.value)} placeholder="Name Notfallkontakt" /></label>
        <label>Telefon Notfallkontakt<input value={data.emergencyContactPhone || ""} onChange={(e) => update("emergencyContactPhone", e.target.value)} placeholder="Telefon Notfallkontakt" /></label>
        <label>
          Spotter / Beobachter vorhanden
          <select
            value={data.spotterAvailable || "Nein"}
            onChange={(e) => update("spotterAvailable", e.target.value)}
            style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px", fontWeight: 800 }}
          >
            <option value="Nein">Nein</option>
            <option value="Ja">Ja</option>
          </select>
        </label>
        {(data.spotterAvailable || "Nein") === "Ja" ? (
          <>
            <label>Name Beobachter<input value={data.spotterName || ""} onChange={(e) => update("spotterName", e.target.value)} placeholder="Name des Spotters / Beobachters" /></label>
            <label>Telefon Beobachter<input value={data.spotterPhone || ""} onChange={(e) => update("spotterPhone", e.target.value)} placeholder="Telefonnummer des Beobachters" /></label>
            <label>
              Kommunikationsmittel
              <select
                value={data.communicationMethod || ""}
                onChange={(e) => update("communicationMethod", e.target.value)}
                style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px", fontWeight: 800 }}
              >
                <option value="">Bitte auswählen</option>
                {COMMUNICATION_METHODS.map((method) => (
                  <option key={method} value={method}>{method}</option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        {(data.spotterAvailable || "Nein") === "Ja" ? (
          <div className="card" style={{ gridColumn: "1 / -1", background: "#f8fafc" }}>
            <div className="sectionHead">
              <div><h3>Mehrere Spotter / Beobachter</h3><p>Optional mehrere Beobachter mit Kommunikationsmittel erfassen.</p></div>
              <button type="button" className="secondary smallButton" onClick={addSpotter}>+ Spotter hinzufügen</button>
            </div>
            {(Array.isArray(data.spotters) ? data.spotters : []).map((spotter, index) => (
              <div key={index} className="profileGrid" style={{ marginBottom: 12 }}>
                <label>Name<input value={spotter.name || ""} onChange={(e) => updateSpotter(index, "name", e.target.value)} /></label>
                <label>Telefon<input value={spotter.phone || ""} onChange={(e) => updateSpotter(index, "phone", e.target.value)} /></label>
                <label>Kommunikationsmittel<select value={spotter.communicationMethod || ""} onChange={(e) => updateSpotter(index, "communicationMethod", e.target.value)}><option value="">Bitte auswählen</option>{COMMUNICATION_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
                <label style={{ alignSelf: "end" }}><button type="button" className="secondary smallButton" onClick={() => removeSpotter(index)}>Entfernen</button></label>
              </div>
            ))}
            {!(Array.isArray(data.spotters) && data.spotters.length) ? <p>Noch keine zusätzlichen Spotter erfasst.</p> : null}
          </div>
        ) : null}
        <label>Ausnahmegenehmigung<input value={data.exceptionPermit ?? "DEU-GEO-SHVV00000120/002"} onChange={(e) => update("exceptionPermit", e.target.value)} placeholder="z. B. Allgemeinerlaubnis SH" /></label>
        <label>Gültigkeit Ausnahmegenehmigung<input type="date" value={data.exceptionPermitValidUntil || ""} onChange={(e) => update("exceptionPermitValidUntil", e.target.value)} /></label>
        <label>Kompetenznachweis / Lizenz<input value={data.license ?? "A1/A3, A2"} onChange={(e) => update("license", e.target.value)} /></label>
        <label>Gültigkeit Kompetenznachweis / Lizenz<input type="date" value={data.licenseValidUntil || ""} onChange={(e) => update("licenseValidUntil", e.target.value)} /></label>
        <label>Fernpiloten-ID<input value={data.remotePilotId ?? "DEU-RP-171dgdhj3gl4"} onChange={(e) => update("remotePilotId", e.target.value)} placeholder="z. B. DEU-RP-..." /></label>
        <label>Versicherung<input value={data.insurance ?? "helden.de"} onChange={(e) => update("insurance", e.target.value)} /></label>

        <label>Versicherungsnummer<input value={data.insuranceNumber ?? "3W868001"} onChange={(e) => update("insuranceNumber", e.target.value)} /></label>
        <label>Gültigkeit Versicherung<input type="date" value={data.insuranceValidUntil || ""} onChange={(e) => update("insuranceValidUntil", e.target.value)} /></label>
        <label>Flugdatum<input type="date" value={data.date || ""} onChange={(e) => update("date", e.target.value)} /></label>
        <label>Startzeit<input type="time" value={data.startTime || ""} onChange={(e) => update("startTime", e.target.value)} /></label>

        <label>Endzeit<input type="time" value={data.endTime || ""} onChange={(e) => update("endTime", e.target.value)} /></label>
        <MapFavoriteSelect
          favorites={mapFavoritePlaces}
          selectedFavoriteIds={Array.isArray(data.mapFavoriteIds) ? data.mapFavoriteIds.map(String) : []}
          onSelect={(favorite) => setData(applyMapFavoriteToFlightData(data, favorite))}
          onSelectMultiple={(favorites) => setData(applyMapFavoritesToFlightData(data, favorites))}
          label="Gespeicherte Kartenfavoriten übernehmen (mehrere möglich)"
        />
        {Array.isArray(data.selectedMapFavorites) && data.selectedMapFavorites.length ? (
          <div className="listitem" style={{ gridColumn: "1 / -1" }}>
            <strong>Ausgewählte Kartenfavoriten</strong>
            {data.selectedMapFavorites.map((favorite, index) => (
              <span key={`${favorite.id || index}`}>
                {index + 1}. {favorite.address || favorite.coordinates} · {favorite.coordinates}
              </span>
            ))}
          </div>
        ) : null}
        <label style={{ gridColumn: "1 / -1" }}>Fluggebiete / Einsatzstellen
          <textarea
            rows={4}
            value={data.flightArea || ""}
            onChange={(e) => update("flightArea", e.target.value)}
            placeholder="Mehrere Fluggebiete werden aus den Kartenfavoriten automatisch zeilenweise eingefügt."
          />
        </label>
        <label style={{ gridColumn: "1 / -1" }}>Koordinaten
          <textarea
            rows={3}
            value={data.coordinates || ""}
            onChange={(e) => update("coordinates", e.target.value)}
            placeholder="54.3510903, 10.1207161"
          />
        </label>

        <label>Startpunkt<input value={data.startPoint || ""} onChange={(e) => update("startPoint", e.target.value)} placeholder="Startpunkt / Startkoordinate" /></label>
        <label>Landepunkt<input value={data.landingPoint || ""} onChange={(e) => update("landingPoint", e.target.value)} placeholder="Landepunkt / Landekoordinate" /></label>
        <label>Max. Flughöhe Meter<input type="number" value={data.maxHeight || ""} onChange={(e) => update("maxHeight", e.target.value)} /></label>
        <label>
          Drohnenmodell
          <select
            value={data.drone || ""}
            onChange={(e) => applyDroneSelection(e.target.value)}
            style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px", fontWeight: 700 }}
          >
            <option value="">Bitte wählen</option>
            <option value="DJI Mavic Air 2">DJI Mavic Air 2</option>
            <option value="DJI Air 3 S">DJI Air 3 S</option>
            {(droneAssets || []).map((drone) => (
              <option key={drone.id} value={getDroneDisplayName(drone)}>{getDroneDisplayName(drone)}</option>
            ))}
          </select>
        </label>
        <label>Gewicht in g<input type="number" value={data.weight || ""} onChange={(e) => update("weight", e.target.value)} /></label>
        <label>Seriennummer Drohne<input value={data.droneSerialNumber || ""} onChange={(e) => update("droneSerialNumber", e.target.value)} /></label>
        <label>C-Klasse<input value={data.droneCClass || ""} onChange={(e) => update("droneCClass", e.target.value)} /></label>
        <label>Remote-ID<input value={data.droneRemoteId || ""} onChange={(e) => update("droneRemoteId", e.target.value)} /></label>

        <label>Zweck des Fluges<input value={data.purpose || ""} onChange={(e) => update("purpose", e.target.value)} /></label>
        <label>Strecke km<input type="number" step="0.1" value={data.distanceKm || ""} onChange={(e) => update("distanceKm", e.target.value)} /></label>
        <label>Akku Start %<input type="number" value={data.batteryStart || ""} onChange={(e) => update("batteryStart", e.target.value)} /></label>

        <label>Akku Ende %<input type="number" value={data.batteryEnd || ""} onChange={(e) => update("batteryEnd", e.target.value)} /></label>
        <label>Wetter<input value={data.weather || ""} onChange={(e) => update("weather", e.target.value)} placeholder="Nur manuell eintragen, wenn in PDF/Behördenseite sichtbar sein soll" /></label>
        <label>Wind km/h<input type="number" value={data.wind || ""} onChange={(e) => update("wind", e.target.value)} placeholder="Nur manuell" /></label>
        <label>Böen km/h<input type="number" value={data.gusts || ""} onChange={(e) => update("gusts", e.target.value)} placeholder="Nur manuell" /></label>
        <label>Vorkommnisse<textarea rows={3} value={data.incidents || ""} onChange={(e) => update("incidents", e.target.value)} /></label>

        <label>Sicherheitsvorkehrungen<textarea rows={8} value={data.safetyMeasures || DEFAULT_SAFETY_MEASURES} onChange={(e) => update("safetyMeasures", e.target.value)} /></label>
        <label>Bemerkungen / Notizen<textarea rows={4} value={data.notes || ""} onChange={(e) => update("notes", e.target.value)} /></label>
      </div>

      <label className="listitem" style={{ marginTop: "14px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <input type="checkbox" checked={Boolean(data.legalConfirm)} onChange={(e) => update("legalConfirm", e.target.checked)} style={{ width: "18px", height: "18px", marginTop: "3px" }} />
        <span style={{ whiteSpace: "pre-wrap" }}>{LEGAL_CONFIRMATION_TEXT}</span>
      </label>
    </>
  );
}


class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("App Fehler:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: "100vh",
          background: "#f8fafc",
          color: "#0f172a",
          padding: "32px",
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        }}>
          <div style={{
            maxWidth: "960px",
            margin: "0 auto",
            background: "#fff",
            border: "1px solid #fecaca",
            borderRadius: "24px",
            padding: "28px",
            boxShadow: "0 18px 45px rgba(15,23,42,.08)"
          }}>
            <h1 style={{ color: "#b91c1c", marginTop: 0 }}>App-Fehler statt weißer Seite</h1>
            <p>Bitte diesen Fehlertext kopieren oder als Screenshot senden:</p>
            <pre style={{
              whiteSpace: "pre-wrap",
              background: "#fee2e2",
              color: "#7f1d1d",
              padding: "16px",
              borderRadius: "16px",
              overflowX: "auto"
            }}>{String(this.state.error?.message || this.state.error)}</pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}



function minutesToTime(totalMinutes) {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const h = String(Math.floor(normalized / 60)).padStart(2, "0");
  const m = String(normalized % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function timeToMinutes(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function unusedGoldenHourFromSun(sunrise, sunset) {
  const sr = timeToMinutes(sunrise);
  const ss = timeToMinutes(sunset);

  if (sr === null || ss === null) {
    return {
      morning: "-",
      evening: "-",
      sunrise: sunrise || "-",
      sunset: sunset || "-",
    };
  }

  return {
    sunrise,
    sunset,
    morning: `${minutesToTime(sr + 20)}–${minutesToTime(sr + 80)}`,
    evening: `${minutesToTime(ss - 80)}–${minutesToTime(ss - 20)}`,
  };
}



async function loadImageAsDataUrl(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`QR-Code konnte nicht geladen werden: HTTP ${response.status}`);

  const blob = await response.blob();

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function createQrCodeDataUrl(value) {
  const qrUrl =
    "https://api.qrserver.com/v1/create-qr-code/" +
    `?size=360x360&margin=18&format=png&data=${encodeURIComponent(value)}`;

  return await loadImageAsDataUrl(qrUrl);
}

function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function hydrateEntryWithCurrentFormData(baseEntry, flightReportForm, editLogEntry, editingLogId) {
  const base = { ...(baseEntry || {}) };
  const baseReg = String(base.registrationNumber || "").trim();

  const shouldMerge = (candidate) => {
    if (!candidate || typeof candidate !== "object") return false;

    const candidateReg = String(candidate.registrationNumber || "").trim();
    const sameReg = baseReg && candidateReg && candidateReg === baseReg;
    const sameId = editingLogId && base.id && String(editingLogId) === String(base.id);

    return sameReg || sameId;
  };

  const merged = {
    ...base,
    ...(shouldMerge(editLogEntry) ? editLogEntry : {}),
    ...(shouldMerge(flightReportForm) ? flightReportForm : {}),
  };

  return {
    ...merged,
    id: base.id,
    registrationNumber: base.registrationNumber || merged.registrationNumber,
    authorityPin: base.authorityPin || merged.authorityPin,
    authorityPins: base.authorityPins || merged.authorityPins,
    pinCreatedAt: base.pinCreatedAt || merged.pinCreatedAt,
  };
}



function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function mergeNonEmptyFields(base, ...candidates) {
  const next = { ...(base || {}) };

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;

    for (const [key, value] of Object.entries(candidate)) {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        next[key] = value;
      }
    }
  }

  return next;
}

function resolveFlightPdfValue(entry, keys, fallback = "-") {
  const sources = [
    entry,
    entry?.formData,
    entry?.flightData,
    entry?.data,
    entry?.report,
    entry?.details,
  ].filter(Boolean);

  for (const source of sources) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
  }

  return fallback;
}



function parseDjiFlightRecordText(rawText, fileName = "DJI FlightRecord") {
  const text = String(rawText || "");
  const numberFrom = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const value = Number(String(match[1]).replace(",", "."));
        if (Number.isFinite(value)) return value;
      }
    }
    return "";
  };
  const stringFrom = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && String(match[1] || "").trim()) return String(match[1]).trim();
    }
    return "";
  };
  const points = Array.from(text.matchAll(/(-?\d{1,2}\.\d{5,})\s*[,;\s]\s*(-?\d{1,3}\.\d{5,})/g))
    .map((m) => ({ lat: Number(m[1]), lon: Number(m[2]) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  const first = points[0] || null;
  const last = points[points.length - 1] || null;
  const dateMatch = fileName.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/) || text.match(/(\d{4})[-/.](\d{2})[-/.](\d{2})/);
  const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : new Date().toISOString().slice(0, 10);
  const timeMatch = fileName.match(/(\d{2})[-_]?(\d{2})[-_]?(\d{2})/) || text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const startTime = timeMatch ? `${String(timeMatch[1]).padStart(2, "0")}:${String(timeMatch[2]).padStart(2, "0")}` : "";
  const durationSeconds = numberFrom([/duration[^0-9]*(\d+(?:[.,]\d+)?)/i, /flight\s*time[^0-9]*(\d+(?:[.,]\d+)?)/i]);
  let endTime = "";
  if (startTime && durationSeconds) {
    const [h, m] = startTime.split(":").map(Number);
    const total = h * 60 + m + Math.round(Number(durationSeconds) / 60);
    endTime = `${String(Math.floor((total % 1440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }
  const maxHeight = numberFrom([/max(?:imum)?\s*(?:height|altitude)[^0-9-]*(\d+(?:[.,]\d+)?)/i, /altitude[^0-9-]*(\d+(?:[.,]\d+)?)/i]);
  const distanceRaw = numberFrom([/total\s*distance[^0-9-]*(\d+(?:[.,]\d+)?)/i, /distance[^0-9-]*(\d+(?:[.,]\d+)?)/i]);
  const batteryStart = numberFrom([/battery[^0-9]*(100|\d{1,2})\s*%/i]);
  const batteryEnd = numberFrom([/remain(?:ing)?\s*battery[^0-9]*(100|\d{1,2})\s*%/i]);
  const drone = stringFrom([/aircraft\s*name[:=]\s*([^\n\r]+)/i, /product\s*type[:=]\s*([^\n\r]+)/i]) || "DJI Air 3S";
  return {
    fileName,
    date,
    startTime,
    endTime,
    drone,
    flightArea: first ? `DJI Flugroute Startpunkt ${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}` : "DJI FlightRecord Import",
    coordinates: first ? `${first.lat.toFixed(7)}, ${first.lon.toFixed(7)}` : "",
    maxHeight: maxHeight ? String(Math.round(maxHeight)) : "",
    distanceKm: distanceRaw ? String(distanceRaw > 100 ? (distanceRaw / 1000).toFixed(2) : distanceRaw.toFixed(2)) : "",
    batteryStart: batteryStart ? String(Math.round(batteryStart)) : "",
    batteryEnd: batteryEnd ? String(Math.round(batteryEnd)) : "",
    purpose: "DJI FlightRecord Import",
    notes: `Automatisch aus DJI FlightRecord importiert: ${fileName}`,
    routePoints: points.slice(0, 500),
    routeSummary: points.length ? `${points.length} GPS-Punkte erkannt. Start: ${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}${last ? ` · Ende: ${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}` : ""}` : "Keine GPS-Punkte erkannt. DJI FlightRecord kann verschlüsselt oder anders formatiert sein.",
  };
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}



function decodeTickerHtmlEntities(value) {
  if (value === null || value === undefined) return "";

  const textarea =
    typeof document !== "undefined"
      ? document.createElement("textarea")
      : null;

  let text = String(value);

  if (textarea) {
    textarea.innerHTML = text;
    text = textarea.value;
  }

  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function translateTickerTextToGerman(value) {
  let text = decodeTickerHtmlEntities(value);

  if (!text) return "";

  const replacements = [
    [/New EU-UAS Rules Published/gi, "Neue EU-UAS-Regeln veröffentlicht"],
    [/New EU UAS Rules Published/gi, "Neue EU-UAS-Regeln veröffentlicht"],
    [/New EU-UAS Regulation Published/gi, "Neue EU-UAS-Verordnung veröffentlicht"],
    [/EASA publishes new guidance for drone pilots/gi, "EASA veröffentlicht neue Hinweise für Drohnenpiloten"],
    [/EASA publishes new guidance/gi, "EASA veröffentlicht neue Hinweise"],
    [/Wind warning Northern Germany/gi, "Windwarnung Norddeutschland"],
    [/Strong gusts possible today up to/gi, "Heute sind starke Böen möglich bis"],
    [/OpenSky Live Data active/gi, "OpenSky Live-Daten aktiv"],
    [/ADS-B air traffic is updated automatically/gi, "ADS-B-Flugverkehr wird automatisch aktualisiert"],
    [/Current UAS/i, "Aktuelle UAS"],
    [/drone/gi, "Drohnen"],
    [/drones/gi, "Drohnen"],
    [/pilot/gi, "Pilot"],
    [/pilots/gi, "Piloten"],
    [/flight/gi, "Flug"],
    [/flights/gi, "Flüge"],
    [/airspace/gi, "Luftraum"],
    [/warning/gi, "Warnung"],
    [/weather/gi, "Wetter"],
    [/wind/gi, "Wind"],
    [/gusts/gi, "Böen"],
    [/rules/gi, "Regeln"],
    [/regulation/gi, "Verordnung"],
    [/guidance/gi, "Hinweise"],
    [/published/gi, "veröffentlicht"],
    [/active/gi, "aktiv"],
    [/updated automatically/gi, "automatisch aktualisiert"],
    [/remote id/gi, "Remote-ID"],
    [/geo ?zone/gi, "Geozone"],
    [/unmanned aircraft/gi, "unbemanntes Luftfahrzeug"],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  return text;
}

function normalizeUasTickerItemsToGerman(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      ...item,
      title: translateTickerTextToGerman(decodeTickerHtmlEntities(item.title || item.message || "UAS-Meldung")),
      text: translateTickerTextToGerman(decodeTickerHtmlEntities(item.text || "")),
      source: item.source || "UAS-Liveticker",
      url: normalizeTickerUrl(item.url || item.link || item.sourceUrl || item.href),
    }))
    .filter((item) => item.title || item.text);
}


function looksGermanTickerText(value) {
  const text = decodeTickerHtmlEntities(value).toLowerCase();

  const germanWords = [
    "der", "die", "das", "und", "oder", "für", "mit", "nicht", "neue", "neuer", "neues",
    "drohne", "drohnen", "uas", "flug", "flüge", "luftfahrt", "behörde", "regeln",
    "verordnung", "warnung", "wetter", "wind", "böen", "deutschland", "bund", "pilot",
    "piloten", "sicherheit", "genehmigung", "kontrollzone", "geozone", "luftraum"
  ];

  const englishWords = [
    "certified", "delivery", "platform", "private placement", "transaction", "leading",
    "autonomous", "technology", "company", "raises", "published", "guidance", "rules",
    "drone delivery", "aircraft", "market", "news", "announces", "launches"
  ];

  let germanScore = 0;
  let englishScore = 0;

  germanWords.forEach((word) => {
    if (text.includes(word)) germanScore += 1;
  });

  englishWords.forEach((word) => {
    if (text.includes(word)) englishScore += 2;
  });

  return germanScore >= 2 && englishScore === 0;
}

function germanOnlyTickerItems(items = []) {
  const normalized = normalizeUasTickerItemsToGerman(items);
  const german = normalized.filter((item) =>
    looksGermanTickerText(`${item.title || ""} ${item.text || ""}`)
  );

  if (german.length) return german;

  return [
    {
      id: "de-fallback-1",
      title: "UAS-Check vor jedem Flug empfohlen",
      text: "Bitte Wetter, Sichtkontakt, Akkuzustand, UAS-Zonen und lokale Vorgaben prüfen.",
      date: new Date().toLocaleString("de-DE"),
      source: "FlyMonitor"
    },
    {
      id: "de-fallback-2",
      title: "Wind und Böen für Drohnenbetrieb prüfen",
      text: "Böen können kleine UAS deutlich stärker beeinflussen als der Durchschnittswind.",
      date: new Date().toLocaleString("de-DE"),
      source: "FlyMonitor"
    },
    {
      id: "de-fallback-3",
      title: "Drohnenflug nur mit aktueller Lageprüfung",
      text: "Kontrollzonen, temporäre Sperrgebiete, Menschenansammlungen und Naturschutzbereiche beachten.",
      date: new Date().toLocaleString("de-DE"),
      source: "FlyMonitor"
    }
  ];
}


function normalizeTickerUrl(value) {
  const url = decodeTickerHtmlEntities(value || "");
  return /^https?:\/\//i.test(url) ? url : "";
}

function TickerNewsLink({ item, children, style = {} }) {
  const url = normalizeTickerUrl(item?.url || item?.link || item?.sourceUrl || item?.href);

  if (!url) {
    return <span style={style}>{children}</span>;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        ...style,
        color: "inherit",
        textDecoration: "none",
        cursor: "pointer",
      }}
      title="News öffnen"
    >
      {children}
    </a>
  );
}

function AppContent() {

  function formatGermanDate(value) {
    if (!value) return "";
    const raw = String(value || "").trim();

    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;

    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;

    return d.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  function normalizeIsoDate(value) {
    const raw = String(value || "").trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

    const german = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (german) {
      return `${german[3]}-${String(german[2]).padStart(2, "0")}-${String(german[1]).padStart(2, "0")}`;
    }

    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return "";

    return d.toISOString().slice(0, 10);
  }

  async function createFlightReportPdfBlob(entry) {
    const doc = createPdfDocument({ unit: "mm", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 8;
    const fullWidth = pageWidth - margin * 2;

    const colors = {
      dark: [15, 23, 42],
      muted: [100, 116, 139],
      border: [203, 213, 225],
      label: [241, 245, 249],
      soft: [248, 250, 252],
      greenBg: [240, 253, 244],
      greenBorder: [134, 239, 172],
      blue: [0, 178, 226],
    };

    const clean = (value, fallback = "-") => {
      const v = String(value ?? "").trim();
      return v || fallback;
    };

    const filled = (value) => {
      if (value === undefined || value === null) return false;
      const text = String(value).replace(/\s+/g, " ").trim();
      if (!text) return false;
      return !["-", "–", "—", "Keine", "Nicht bestätigt", "- / - km/h", "/ km/h", "km/h"].includes(text);
    };

    const onlyFilledRows = (rows) => rows.filter(([, value]) => filled(value));

    const address = [entry.street, [entry.zip, entry.city].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");

    const authorityPin = clean(entry.authorityPin, "");
    const authorityLink = authorityPin
      ? `${getAuthorityLink()}?pin=${encodeURIComponent(authorityPin)}`
      : getAuthorityLink();

    const created = clean(entry.pinCreatedAt || entry.createdAt || new Date().toLocaleString("de-DE"));
    const flightDate = formatGermanDate(entry.date);

    const source = entry.formData || entry.flightData || entry.data || entry.report || entry.details || entry;

    const sourceAddress = [
      source.street || entry.street,
      [source.zip || entry.zip, source.city || entry.city].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(", ");


    const setText = (size = 8.7, style = "normal", color = colors.dark) => {
      doc.setFont("helvetica", style);
      doc.setFontSize(size);
      doc.setTextColor(...color);
    };

    const footer = () => {
      setText(7.5, "normal", colors.muted);
      doc.text(
        "",
        pageWidth / 2,
        pageHeight - 8,
        { align: "center" }
      );
    };

    const wrapText = (value, width) => doc.splitTextToSize(clean(value), width);

    const roundedBox = (x, y, w, h, fill = colors.soft, stroke = colors.border) => {
      doc.setFillColor(...fill);
      doc.setDrawColor(...stroke);
      doc.roundedRect(x, y, w, h, 2.5, 2.5, "FD");
    };

    const drawTable = (x, y, width, rows, options = {}) => {
      const labelWidth = options.labelWidth || width * 0.33;
      const rowMinHeight = options.rowMinHeight || 9;
      const valueWidth = width - labelWidth;
      let cursorY = y;

      rows.forEach(([label, value]) => {
        const valueLines = wrapText(value, valueWidth - 6);
        const labelLines = wrapText(label, labelWidth - 5);
        const height = Math.max(rowMinHeight, Math.max(valueLines.length, labelLines.length) * 4.5 + 4);

        doc.setDrawColor(...colors.border);
        doc.setFillColor(...colors.label);
        doc.rect(x, cursorY, labelWidth, height, "FD");
        doc.setFillColor(255, 255, 255);
        doc.rect(x + labelWidth, cursorY, valueWidth, height, "FD");

        setText(8.5, "bold");
        doc.text(labelLines, x + 3, cursorY + 5.6);

        setText(8.5, "normal");
        doc.text(valueLines, x + labelWidth + 3, cursorY + 5.6);

        cursorY += height;
      });

      return cursorY;
    };

    const sectionTitle = (title, x, y) => {
      setText(12, "bold");
      doc.text(title, x, y);
      doc.setDrawColor(...colors.border);
      doc.line(x, y + 3, pageWidth - margin, y + 3);
      return y + 6;
    };

    const drawQrLike = (x, y, size, value) => {
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(15, 23, 42);
      doc.rect(x, y, size, size, "FD");

      const cells = 21;
      const c = size / cells;
      const seed = String(value || "flymonitor").split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);

      const finder = (cx, cy) => {
        doc.setFillColor(0, 0, 0);
        doc.rect(x + cx * c, y + cy * c, 7 * c, 7 * c, "F");
        doc.setFillColor(255, 255, 255);
        doc.rect(x + (cx + 1) * c, y + (cy + 1) * c, 5 * c, 5 * c, "F");
        doc.setFillColor(0, 0, 0);
        doc.rect(x + (cx + 2) * c, y + (cy + 2) * c, 3 * c, 3 * c, "F");
      };

      finder(1, 1);
      finder(13, 1);
      finder(1, 13);

      doc.setFillColor(0, 0, 0);
      for (let row = 0; row < cells; row += 1) {
        for (let col = 0; col < cells; col += 1) {
          const inFinder =
            (row >= 1 && row <= 7 && col >= 1 && col <= 7) ||
            (row >= 1 && row <= 7 && col >= 13 && col <= 19) ||
            (row >= 13 && row <= 19 && col >= 1 && col <= 7);

          if (inFinder) continue;

          const on = ((row * 31 + col * 17 + seed) % 5 === 0) || ((row + col + seed) % 11 === 0);
          if (on) doc.rect(x + col * c, y + row * c, c, c, "F");
        }
      }
    };

    // Seite 1
    doc.setFillColor(255, 255, 255);
    doc.rect(0, 0, pageWidth, pageHeight, "F");

    try {
      const logoDataUrl = await loadImageAsDataUrl("/logo_neu.png");
      doc.addImage(
        logoDataUrl,
        "PNG",
        pageWidth / 2 - 30,
        8,
        40,
        17
      );
    } catch (error) {
      console.warn("PDF-Logo konnte nicht geladen werden:", error);
      setText(18, "bold", colors.dark);
      doc.text("FlyMonitor", pageWidth / 2, 18, { align: "center" });
    }
    setText(8, "normal", colors.muted);
    doc.text("Drohnenflug · Wetter · Fluganmeldung", pageWidth / 2, 28, { align: "center" });
    setText(6.5, "bold", [22, 163, 74]);
    

    roundedBox(pageWidth / 2 - 60, 30, 120, 56, [255, 255, 255], colors.dark);
    setText(8, "bold", colors.muted);
    doc.text("BEHÖRDEN-LOGIN", pageWidth / 2, 37, { align: "center" });
    try {
      const qrDataUrl = await createQrCodeDataUrl(authorityLink);
      doc.addImage(qrDataUrl, "PNG", pageWidth / 2 - 15, 40, 30, 30);
    } catch (error) {
      console.warn("QR-Code konnte nicht geladen werden:", error);
      setText(7, "normal", colors.dark);
      doc.text("QR-Code nicht geladen", pageWidth / 2, 55, { align: "center" });
    }
    setText(8, "bold");
    doc.text("QR-Code scannen und Behörden-Login öffnen", pageWidth / 2, 75, { align: "center" });
    setText(6.6, "normal", colors.muted);
    doc.text(authorityLink, pageWidth / 2, 80, { align: "center", maxWidth: 108 });

    roundedBox(margin, 91, fullWidth, 35, colors.soft, colors.border);
    setText(19, "bold");
    doc.text("Drohnenflug-Anmeldung", margin + 5, 102);

    setText(8.7, "bold");
    doc.text("Vorgangsnummer:", margin + 5, 113);
    setText(8.7, "normal");
    doc.text(clean(entry.registrationNumber), margin + 39, 113);

    setText(8.7, "bold");
    doc.text("Erstellt / gespeichert:", margin + 5, 121);
    setText(8.7, "normal");
    doc.text(created, margin + 43, 121);

    setText(8.7, "bold");
    doc.text("Behörden-Link:", margin + 5, 129);
    setText(7.4, "normal");
    doc.text(getAuthorityLink(), margin + 34, 129, { maxWidth: 82 });

    setText(8.7, "bold");
    doc.text("Flugdatum:", pageWidth - 58, 105);
    setText(8.7, "normal");
    doc.text(flightDate || "-", pageWidth - 23, 105, { align: "right" });

    setText(8.7, "bold");
    doc.text("Behörden-PIN:", pageWidth - 58, 115);
    setText(8.7, "normal");
    doc.text(authorityPin || "-", pageWidth - 23, 115, { align: "right" });

    const statusText = clean(entry.status || source.status || "Geplant", "");
    if (statusText) {
      setText(8.7, "bold");
      doc.text("Status:", pageWidth - 58, 124);
      setText(8.7, "normal");
      doc.text(statusText, pageWidth - 23, 124, { align: "right" });
    }

    let y = 142;
    const halfGap = 4;
    const halfW = (fullWidth - halfGap) / 2;

    setText(12, "bold");
    doc.text("Kontaktdaten", margin, y);
    doc.text("Pilot / Betreiber", margin + halfW + halfGap, y);
    y += 4;

    const contactRows = onlyFilledRows([
      ["Firma", resolveFlightPdfValue(entry, ["company", "firma"])],
      ["Ansprechpartner", resolveFlightPdfValue(entry, ["contactName", "ansprechpartner", "contact", "pilot"])],
      ["E-Mail", resolveFlightPdfValue(entry, ["email", "eMail", "mail"])],
      ["Telefon", resolveFlightPdfValue(entry, ["phone", "telefon", "telephone"])],
      ["Anschrift", sourceAddress || address || ""],
    ]);

    const operatorRows = onlyFilledRows([
      ["Betreiber-ID", resolveFlightPdfValue(entry, ["operatorId", "betreiberId", "betreiberID", "uasOperatorId", "operator"])],
      ["Pilot", resolveFlightPdfValue(entry, ["pilot", "pilotName", "remotePilot"])],
      ["Einsatzleiter", entry.missionLeaderName || ""],
      ["Telefon Einsatzleiter", entry.missionLeaderPhone || ""],
      ["Notfallkontakt", entry.emergencyContactName || ""],
      ["Telefon Notfallkontakt", entry.emergencyContactPhone || ""],
      ["Spotter / Beobachter", formatSpottersSummary(entry)],
      ["Ausnahmegenehmigung", resolveFlightPdfValue(entry, ["exceptionPermit", "ausnahmegenehmigung", "permit", "permission"])],
      ["Gültigkeit Ausnahmegenehmigung", formatGermanDate(resolveFlightPdfValue(entry, ["exceptionPermitValidUntil", "exceptionPermitValidTo", "exceptionPermitValidity", "ausnahmegenehmigungGueltigBis"], ""))],
      ["Kompetenznachweis / Lizenz", resolveFlightPdfValue(entry, ["license", "kompetenznachweis", "competencyProof", "licenseNumber", "competency", "certificate"])],
      ["Gültigkeit Kompetenznachweis / Lizenz", formatGermanDate(resolveFlightPdfValue(entry, ["licenseValidUntil", "licenseValidTo", "licenseValidity", "kompetenznachweisGueltigBis"], ""))],
      ["Fernpiloten-ID", resolveFlightPdfValue(entry, ["remotePilotId", "fernpilotenId", "fernPilotenId", "remotePilotID", "pilotId"])],
      ["Versicherung", resolveFlightPdfValue(entry, ["insurance", "versicherung", "insurer", "insuranceProvider"])],
      ["Versicherungsnummer", resolveFlightPdfValue(entry, ["insuranceNumber", "versicherungsnummer", "policyNumber", "insurancePolicy"])],
      ["Gültigkeit Versicherung", formatGermanDate(resolveFlightPdfValue(entry, ["insuranceValidUntil", "insuranceValidTo", "insuranceValidity", "versicherungGueltigBis"], ""))],
    ]);

    const yAfterLeft = drawTable(margin, y, halfW, contactRows, { labelWidth: 32, rowMinHeight: 9 });
    const yAfterRight = drawTable(margin + halfW + halfGap, y, halfW, operatorRows, { labelWidth: 44, rowMinHeight: 9 });
    y = Math.max(yAfterLeft, yAfterRight) + 12;
doc.addPage();
    y = 22;
    y = sectionTitle("Flugdaten", margin, y);
y = drawTable(
  margin,
  y,
  fullWidth,
  onlyFilledRows([
    ["Flugdatum", formatGermanDate(source.date || entry.date) || ""],
    ["Uhrzeit von / bis", [source.startTime || entry.startTime, source.endTime || entry.endTime].filter(Boolean).join(" – ")],
    ["Fluggebiet / Einsatzstelle", source.flightArea || entry.flightArea || source.city || entry.city || ""],
    ["Koordinaten", source.coordinates || entry.coordinates || ""],
    ["Max. Flughöhe", (source.maxHeight || entry.maxHeight) ? `${source.maxHeight || entry.maxHeight} m` : ""],
  ]),
  { labelWidth: 58, rowMinHeight: 9 }
);



   
y += 12;

doc.addPage();
y = 22;
    y = sectionTitle("Drohne / Auftrag", margin, y);
    y = drawTable(
      margin,
      y,
      fullWidth,
      onlyFilledRows([
        ["Drohnenmodell", source.drone || entry.drone || ""],
        ["Seriennummer Drohne", source.droneSerialNumber || entry.droneSerialNumber || ""],
        ["C-Klasse", source.droneCClass || entry.droneCClass || ""],
        ["Remote-ID", source.droneRemoteId || entry.droneRemoteId || ""],
        ["Startpunkt", source.startPoint || entry.startPoint || ""],
        ["Landepunkt", source.landingPoint || entry.landingPoint || ""],
        ["Gewicht", (source.weight || entry.weight) ? `${source.weight || entry.weight} g` : ""],
        ["Zweck des Fluges", source.purpose || entry.purpose || ""],
        ["Strecke", cleanManualDistanceKm(source.distanceKm || entry.distanceKm) ? `${cleanManualDistanceKm(source.distanceKm || entry.distanceKm)} km` : ""],
        ["Akku Start / Ende", formatManualBattery(source.batteryStart || entry.batteryStart, source.batteryEnd || entry.batteryEnd) || ""],
        ["Wetter", source.weather || entry.weather || ""],
        ["Temperatur", (source.temperature || entry.temperature) ? `${source.temperature || entry.temperature} °C` : ""],
        ["Wind / Böen", (source.wind || entry.wind || source.gusts || entry.gusts) ? `${source.wind || entry.wind || "-"} / ${source.gusts || entry.gusts || "-"} km/h` : ""],
        ["Max. Entfernung zum Piloten", (source.maxDistance || entry.maxDistance) ? `${source.maxDistance || entry.maxDistance} m` : ""],
        ["Behördenkontrolle", source.authorityInspection || entry.authorityInspection || ""],
        ["Kontrollierende Behörde", (source.authorityInspection || entry.authorityInspection) === "Ja" ? (source.authorityType || entry.authorityType || "") : ""],
        ["Kontrollzeitpunkt", (source.authorityInspection || entry.authorityInspection) === "Ja" ? formatFlightStatusTimestamp(source.authorityControlDate || entry.authorityControlDate || "") : ""],
        ["Bemerkungen zur Behördenkontrolle", source.authorityInspectionNotes || entry.authorityInspectionNotes || ""],
        ["Dokumente & Medien", entry.attachmentsIncludeInPdf === false ? "" : formatCompletedFlightAttachmentSummary(entry)],
        ["Vorkommnisse", source.incidents || entry.incidents || ""],
      ]),
      { labelWidth: 58, rowMinHeight: 9 }
    );

    y += 7;

    const textBox = (title, body, x, startY, w, fill, border, minHeight = 22) => {
      const lines = wrapText(body || "-", w - 8);
      const h = Math.max(minHeight, 14 + lines.length * 4.5);
      roundedBox(x, startY, w, h, fill, border);
      setText(9.5, "bold");
      doc.text(title, x + 4, startY + 8);
      setText(8.4, "normal");
      doc.text(lines, x + 4, startY + 17);
      return startY + h + 7;
    };

    y = textBox(
      "Sicherheitsvorkehrungen",
      entry.safetyMeasures || DEFAULT_SAFETY_MEASURES,
      margin,
      y,
      fullWidth,
      colors.soft,
      colors.border,
      58
    );

    y = textBox(
      "Rechtliche Bestätigung",
      `${entry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT}\n\nStatus: ${entry.legalConfirm ? "Bestätigt" : "Nicht bestätigt"}`,
      margin,
      y,
      fullWidth,
      colors.greenBg,
      colors.greenBorder,
      48
    );

    textBox(
      "Bemerkungen / Notizen",
      entry.notes || "-",
      margin,
      y,
      fullWidth,
      colors.soft,
      colors.border,
      22
    );

    footer();

    doc.setProperties({
      title: `UAS-Fluganmeldung ${entry.registrationNumber || ""}`,
      subject: "UAS-Fluganmeldung",
      author: "FlyMonitor",
      creator: "FlyMonitor",
    });

    return doc.output("blob");
  }

  const [query, setQuery] = useState("Kiel");
  const [result, setResult] = useState(demo);
  const [aircraft, setAircraft] = useState([]);
  const [dark, setDark] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState(() => safeLoad("flymonitor_active_template", "executive"));
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState("kostenlose APIs bereit");
  const [calendarNotice, setCalendarNotice] = useState("");
  const [calendarDownloadHref, setCalendarDownloadHref] = useState("");
  const [calendarDownloadName, setCalendarDownloadName] = useState("drohnenflug.ics");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [selectedCalendarFlight, setSelectedCalendarFlight] = useState(null);

  const [tickerMessages, setTickerMessages] = useState(() =>
    safeLoad("droneready_news_ticker", [
      { id: "ticker-1", text: "⚠️ Achtung: Windböen heute ab 18 Uhr bis 45 km/h möglich.", createdAt: "System" },
      { id: "ticker-2", text: "📡 OpenSky Live-Daten aktiv.", createdAt: "System" },
      { id: "ticker-3", text: "🛩️ Neue Flugverbotszonen in Küstennähe beachten.", createdAt: "System" },
      { id: "ticker-4", text: "🌦️ Regenfront nähert sich aus Westen.", createdAt: "System" },
    ])
  );

  const [uasTicker, setUasTicker] = useState([]);
  const [uasTickerLastUpdate, setUasTickerLastUpdate] = useState(() => localStorage.getItem("flymonitor_uas_ticker_last_update") || "Noch nicht geladen");
  const [uasTickerAdminStatus, setUasTickerAdminStatus] = useState("Bereit");

  const [tickerInput, setTickerInput] = useState("");
  const [editingTickerId, setEditingTickerId] = useState(null);
  const [editingTickerText, setEditingTickerText] = useState("");

  const [routeKm, setRouteKm] = useState(2.4);
  const [selectedForecastDay, setSelectedForecastDay] = useState(null);
  const [fullscreenMap, setFullscreenMap] = useState(false);
  const [savedPlaces, setSavedPlaces] = useState(() => safeLoad("droneready_places", []));
  const [logbook, setLogbook] = useState(() => safeLoad("droneready_logbook", []));
  const [completedFlights, setCompletedFlights] = useState(() => safeLoad("flymonitor_completed_flights", []));
  const [completedFlightDraft, setCompletedFlightDraft] = useState({
    registrationNumber: "",
    authorityPin: "",
    date: "",
    startTime: "",
    endTime: "",
    actualStartTime: "",
    actualEndTime: "",
    city: "",
    flightArea: "",
    coordinates: "",
    pilot: "",
    drone: "",
    purpose: "",
    distanceKm: "",
    batteryStart: "",
    batteryEnd: "",
    weather: "",
    wind: "",
    gusts: "",
    actualWind: "",
    actualGusts: "",
    maxHeight: "",
    maxDistance: "",
    temperature: "",
    authorityInspection: "",
    authorityInspectionNotes: "",
    incidents: "",
    actualIncidents: "",
    actualNotes: "",
    attachments: normalizeCompletedFlightAttachments(),
    attachmentsVisibleForAuthorities: true,
    attachmentsIncludeInPdf: true,
    attachmentsIncludeInMail: false,
    notes: "",
  });
  const [editingCompletedFlightId, setEditingCompletedFlightId] = useState(null);
  const [selectedCompletedFlightId, setSelectedCompletedFlightId] = useState("");
  const [completedFlightSearch, setCompletedFlightSearch] = useState("");
  const [completedFlightFilterFrom, setCompletedFlightFilterFrom] = useState("");
  const [completedFlightFilterTo, setCompletedFlightFilterTo] = useState("");
  const [completedFlightFilterPilot, setCompletedFlightFilterPilot] = useState("");
  const [completedFlightFilterDrone, setCompletedFlightFilterDrone] = useState("");
  const [openFlightSearch, setOpenFlightSearch] = useState("");

  const completedFlightPilots = useMemo(() =>
    Array.from(new Set((completedFlights || []).map((entry) => entry.pilot).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), "de")),
    [completedFlights]
  );

  const completedFlightDrones = useMemo(() =>
    Array.from(new Set((completedFlights || []).map((entry) => entry.drone).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), "de")),
    [completedFlights]
  );

  const filteredCompletedFlights = useMemo(() =>
    filterCompletedFlights(completedFlights, {
      search: completedFlightSearch,
      from: completedFlightFilterFrom,
      to: completedFlightFilterTo,
      pilot: completedFlightFilterPilot,
      drone: completedFlightFilterDrone,
    }),
    [completedFlights, completedFlightSearch, completedFlightFilterFrom, completedFlightFilterTo, completedFlightFilterPilot, completedFlightFilterDrone]
  );

  const resetCompletedFlightFiltersWorking = () => {
    setCompletedFlightSearch("");
    setCompletedFlightFilterFrom("");
    setCompletedFlightFilterTo("");
    setCompletedFlightFilterPilot("");
    setCompletedFlightFilterDrone("");
  };

  const selectedCompletedFlightEntry = useMemo(() => {
    if (!selectedCompletedFlightId || selectedCompletedFlightId === "__new__") return null;
    return completedFlights.find((entry) => getCompletedFlightKey(entry) === selectedCompletedFlightId) || null;
  }, [completedFlights, selectedCompletedFlightId]);

  async function addCompletedFlightAttachmentsWorking(kind, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const results = await Promise.allSettled(files.map(readFileAsCompletedFlightAttachment));
    const newFiles = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);

    const failed = results
      .filter((result) => result.status === "rejected")
      .map((result, index) => {
        const file = files[index];
        const message = result.reason?.message || String(result.reason || "Unbekannter Fehler");
        return `${file?.name || "Datei"}: ${message}`;
      });

    if (newFiles.length) {
      setCompletedFlightDraft((current) => {
        const attachments = normalizeCompletedFlightAttachments(current.attachments);
        return {
          ...current,
          attachments: {
            ...attachments,
            [kind]: [...(attachments[kind] || []), ...newFiles],
          },
          updatedAt: new Date().toLocaleString("de-DE"),
        };
      });
    }

    if (failed.length) {
      console.error("Dateien konnten nicht gelesen werden:", failed);
      alert(`Einige Dateien konnten nicht gelesen werden:\n\n${failed.join("\n")}`);
    }
  }

  function removeCompletedFlightAttachmentWorking(kind, attachmentId) {
    setCompletedFlightDraft((current) => {
      const attachments = normalizeCompletedFlightAttachments(current.attachments);
      return {
        ...current,
        attachments: {
          ...attachments,
          [kind]: (attachments[kind] || []).filter((item) => String(item.id) !== String(attachmentId)),
        },
        updatedAt: new Date().toLocaleString("de-DE"),
      };
    });
  }


  const [logbookPage, setLogbookPage] = useState(1);
  const [adminUnlocked, setAdminUnlocked] = useState(() => isAdminSessionActive());
  const [adminRole, setAdminRole] = useState(() => getAdminSession()?.role || "gast");
  const [adminNotice, setAdminNotice] = useState("");
  const [adminPasswordInput, setAdminPasswordInput] = useState("");
  const [showAdminLoginModal, setShowAdminLoginModal] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminCenterTab, setAdminCenterTab] = useState("overview");
  const [publicPreviewMode, setPublicPreviewMode] = useState(false);
  const [auditLog, setAuditLog] = useState(() => safeLoad("flymonitor_audit_log", []));
  const [serverUsers, setServerUsers] = useState([]);
  const [backupNotice, setBackupNotice] = useState("");
  const [adminSearch, setAdminSearch] = useState("");
  const [mobileAdminMenu, setMobileAdminMenu] = useState(false);
  const [newUserForm, setNewUserForm] = useState({ name: "", email: "", role: "pilot", password: "" });
  const [rolePermissionMatrix, setRolePermissionMatrix] = useState(() => safeLoad("flymonitor_role_permissions", DEFAULT_ROLE_PERMISSIONS_PRO));
  const [localAccessUsers, setLocalAccessUsers] = useState(() => (safeLoad("flymonitor_access_users", DEFAULT_LOCAL_ACCESS_USERS) || []).map(normalizeAccessUser));
  const [roleSearch, setRoleSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("Alle");
  const [selectedPermissionRole, setSelectedPermissionRole] = useState("admin");
  const [authorityDocumentsPro, setAuthorityDocumentsPro] = useState(() => (safeLoad("flymonitor_authority_documents_pro", []) || []).map(normalizeAuthorityDocumentPro));
  const [authorityDocumentDraft, setAuthorityDocumentDraft] = useState(() => createEmptyAuthorityDocumentPro());
  const [editingAuthorityDocumentId, setEditingAuthorityDocumentId] = useState(null);
  const [authorityDocumentSearch, setAuthorityDocumentSearch] = useState("");
  const [authorityDocumentFilter, setAuthorityDocumentFilter] = useState("Alle");
  const [cloudSyncTargetsPro, setCloudSyncTargetsPro] = useState(() => (safeLoad("flymonitor_cloud_sync_targets_pro", []) || []).map(normalizeCloudSyncTargetPro));
  const [cloudSyncTargetDraft, setCloudSyncTargetDraft] = useState(() => createEmptyCloudSyncTargetPro());
  const [editingCloudSyncTargetId, setEditingCloudSyncTargetId] = useState(null);
  const [cloudSyncLogsPro, setCloudSyncLogsPro] = useState(() => safeLoad("flymonitor_cloud_sync_logs_pro", []));
  const [cloudSyncSearch, setCloudSyncSearch] = useState("");
  const [cloudSyncScopeFilter, setCloudSyncScopeFilter] = useState("Alle");
  const [mobileMissionsPro, setMobileMissionsPro] = useState(() => (safeLoad("flymonitor_mobile_missions_pro", []) || []).map(normalizeMobileMissionPro));
  const [mobileMissionDraftPro, setMobileMissionDraftPro] = useState(() => createEmptyMobileMissionPro());
  const [editingMobileMissionIdPro, setEditingMobileMissionIdPro] = useState(null);
  const [mobileMissionSearchPro, setMobileMissionSearchPro] = useState("");
  const [mobileMissionStatusFilterPro, setMobileMissionStatusFilterPro] = useState("Alle");
  const [mobilePwaSettingsPro, setMobilePwaSettingsPro] = useState(() => safeLoad("flymonitor_mobile_pwa_settings_pro", {
    appName: "FlyMonitor Mobile",
    offlineEnabled: true,
    installPromptSeen: false,
    cacheScopes: PWA_MOBILE_CACHE_SCOPES_PRO,
    notificationTypes: PWA_MOBILE_NOTIFICATION_TYPES_PRO,
    lastServiceWorkerCheck: "",
  }));

  const [customTheme, setCustomTheme] = useState(() => safeLoad("flymonitor_custom_theme", {
    name: "FlyMonitor Custom",
    primary: "#00B2E2",
    secondary: "#021B33",
    background: "#0F172A",
    logoUrl: "",
    mode: "dark",
  }));
  const [templateColorOverrides, setTemplateColorOverrides] = useState(() =>
    safeLoad("flymonitor_template_color_overrides", {})
  );
  const [savedEmailRecipients, setSavedEmailRecipients] = useState(() => loadEmailRecipientsFromAllKnownKeys());
  const [newRecipientCategory, setNewRecipientCategory] = useState("Behörde");
  const [newRecipientCategoryCustom, setNewRecipientCategoryCustom] = useState("");
  const [newRecipientSubcategory, setNewRecipientSubcategory] = useState("");
  const [newRecipientSubcategoryCustom, setNewRecipientSubcategoryCustom] = useState("");
  const [newRecipientName, setNewRecipientName] = useState("");
  const [newRecipientEmails, setNewRecipientEmails] = useState("");
  const [bulkRecipientInput, setBulkRecipientInput] = useState("");

  const [newRecipientResponsibility, setNewRecipientResponsibility] = useState("");
  const [selectedRecipientIds, setSelectedRecipientIds] = useState([]);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailEntry, setEmailEntry] = useState(null);
  const [emailRecipientSearch, setEmailRecipientSearch] = useState("");
  const [emailRecipientSelection, setEmailRecipientSelection] = useState([]);
  const [mailPdfDocuments, setMailPdfDocuments] = useState(() => normalizeMailPdfDocumentList(safeLoad("droneready_mail_pdf_documents", [])));
  const mailPdfDocumentSummary = useMemo(() => summarizeMailPdfDocuments(mailPdfDocuments), [mailPdfDocuments]);
  const [selectedMailPdfDocumentIds, setSelectedMailPdfDocumentIds] = useState([]);
  const [customers, setCustomers] = useState(() => safeLoad("flymonitor_customers", []));
  const [offers, setOffers] = useState(() => safeLoad("flymonitor_offers", []));
  const [selectedOfferId, setSelectedOfferId] = useState("");
  const [contracts, setContracts] = useState(() => safeLoad("flymonitor_contracts", []));
  const [selectedContractId, setSelectedContractId] = useState("");
  const [contractDraft, setContractDraft] = useState({
    contractNumber: "",
    title: "",
    customerId: "",
    customerName: "",
    type: "Kundenvertrag",
    status: "Entwurf",
    startDate: "",
    endDate: "",
    noticePeriodDays: 30,
    value: "",
    relatedOfferId: "",
    relatedInvoiceId: "",
    documentName: "",
    documentUrl: "",
    notes: "",
  });
  const [invoices, setInvoices] = useState(() => safeLoad("flymonitor_invoices", []));
  const [flymonitorProSettings, setFlymonitorProSettings] = useState(() => safeLoad("flymonitor_pro_settings", DEFAULT_FLYMONITOR_PRO_SETTINGS));
  const [missions, setMissions] = useState(() => safeLoad("flymonitor_missions", DEFAULT_FLYMONITOR_MISSIONS));
  const [missionDraft, setMissionDraft] = useState({
    title: "",
    customerId: "",
    projectId: "",
    pilot: "Robert Bajela",
    spotter: "",
    cameraOperator: "",
    drone: "DJI Air 3 S",
    date: "",
    startTime: "",
    endTime: "",
    location: "",
    address: "",
    coordinates: "",
    lat: "",
    lon: "",
    status: "Geplant",
    priority: "Normal",
    notes: "",
  });
  const [missionSearch, setMissionSearch] = useState("");
  const [missionStatusFilter, setMissionStatusFilter] = useState("Alle");
  const [weatherHistory, setWeatherHistory] = useState(() => safeLoad("flymonitor_weather_history", DEFAULT_FLYMONITOR_WEATHER_HISTORY));
  const [backupJobs, setBackupJobs] = useState(() => safeLoad("flymonitor_backup_jobs", DEFAULT_FLYMONITOR_BACKUP_JOBS));
  const [customerPortalSearch, setCustomerPortalSearch] = useState("");
  const [customerPortalStatusFilterPro, setCustomerPortalStatusFilterPro] = useState("Alle");
  const [compareBeforeId, setCompareBeforeId] = useState("");
  const [compareAfterId, setCompareAfterId] = useState("");
  const [customerForm, setCustomerForm] = useState(() => ({ ...EMPTY_CUSTOMER_FORM }));
  const [editingCustomerId, setEditingCustomerId] = useState(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [crmSelectedCustomerId, setCrmSelectedCustomerId] = useState("");
  const [crmActivityForm, setCrmActivityForm] = useState({ type: "Notiz", title: "", text: "" });
  const [crmContactForm, setCrmContactForm] = useState({ name: "", role: "", email: "", phone: "" });
  const [crmActivities, setCrmActivities] = useState(() => safeLoad("flymonitor_crm_activities", []));
  const [crmContacts, setCrmContacts] = useState(() => safeLoad("flymonitor_crm_contacts", []));
  const [crmDocuments, setCrmDocuments] = useState(() => safeLoad("flymonitor_crm_documents", []));

  useEffect(() => {
    localStorage.setItem("flymonitor_pro_settings", JSON.stringify(flymonitorProSettings));
  }, [flymonitorProSettings]);

  useEffect(() => {
    localStorage.setItem("flymonitor_role_permissions", JSON.stringify(rolePermissionMatrix || DEFAULT_ROLE_PERMISSIONS_PRO));
  }, [rolePermissionMatrix]);

  useEffect(() => {
    localStorage.setItem("flymonitor_access_users", JSON.stringify((localAccessUsers || []).map(normalizeAccessUser)));
  }, [localAccessUsers]);

  useEffect(() => {
    localStorage.setItem("flymonitor_authority_documents_pro", JSON.stringify((authorityDocumentsPro || []).map(normalizeAuthorityDocumentPro)));
  }, [authorityDocumentsPro]);

  useEffect(() => {
    localStorage.setItem("flymonitor_cloud_sync_targets_pro", JSON.stringify((cloudSyncTargetsPro || []).map(normalizeCloudSyncTargetPro)));
  }, [cloudSyncTargetsPro]);

  useEffect(() => {
    localStorage.setItem("flymonitor_cloud_sync_logs_pro", JSON.stringify(Array.isArray(cloudSyncLogsPro) ? cloudSyncLogsPro.slice(0, 300) : []));
  }, [cloudSyncLogsPro]);

  useEffect(() => {
    localStorage.setItem("flymonitor_mobile_missions_pro", JSON.stringify((mobileMissionsPro || []).map(normalizeMobileMissionPro)));
  }, [mobileMissionsPro]);

  useEffect(() => {
    localStorage.setItem("flymonitor_mobile_pwa_settings_pro", JSON.stringify(mobilePwaSettingsPro || {}));
  }, [mobilePwaSettingsPro]);


  useEffect(() => {
    localStorage.setItem("flymonitor_missions", JSON.stringify(Array.isArray(missions) ? missions : []));
  }, [missions]);

  useEffect(() => {
    localStorage.setItem("flymonitor_weather_history", JSON.stringify(Array.isArray(weatherHistory) ? weatherHistory : []));
  }, [weatherHistory]);

  useEffect(() => {
    localStorage.setItem("flymonitor_backup_jobs", JSON.stringify(Array.isArray(backupJobs) ? backupJobs : []));
  }, [backupJobs]);

  const [droneAssets, setDroneAssets] = useState(() => (safeLoad("flymonitor_drone_assets", []) || []).map(normalizeDroneAsset));
  const [batteryAssets, setBatteryAssets] = useState(() => (safeLoad("flymonitor_battery_assets", []) || []).map(normalizeBatteryAsset));
  const [maintenanceEntries, setMaintenanceEntries] = useState(() => (safeLoad("flymonitor_maintenance_entries", []) || []).map(normalizeMaintenanceEntry));
  const [droneAssetDraft, setDroneAssetDraft] = useState(() => createEmptyDroneAsset());
  const [batteryAssetDraft, setBatteryAssetDraft] = useState(() => createEmptyBatteryAsset());
  const [maintenanceDraft, setMaintenanceDraft] = useState(() => createEmptyMaintenanceEntry());


  const combinedAccessUsers = useMemo(() => {
    const serverList = (serverUsers || []).map((user) => normalizeAccessUser({ ...user, status: Number(user.active) ? "Aktiv" : "Inaktiv", source: "server" }));
    const localList = (localAccessUsers || []).map(normalizeAccessUser);
    const byKey = new Map();
    [...serverList, ...localList].forEach((user) => {
      const key = String(user.email || user.id || "").toLowerCase();
      if (!key) return;
      byKey.set(key, { ...(byKey.get(key) || {}), ...user });
    });
    return Array.from(byKey.values());
  }, [serverUsers, localAccessUsers]);

  const filteredAccessUsers = useMemo(() => {
    const query = String(roleSearch || "").trim().toLowerCase();
    return combinedAccessUsers.filter((user) => {
      const roleMatches = roleFilter === "Alle" || user.role === roleFilter;
      if (!roleMatches) return false;
      if (!query) return true;
      return [user.name, user.email, user.role, user.status].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [combinedAccessUsers, roleSearch, roleFilter]);

  const roleDashboardStats = useMemo(() => {
    const users = combinedAccessUsers;
    return {
      total: users.length,
      admins: users.filter((user) => user.role === "admin").length,
      pilots: users.filter((user) => user.role === "pilot").length,
      customers: users.filter((user) => user.role === "kunde").length,
      locked: users.filter((user) => user.status === "Gesperrt").length,
      inactive: users.filter((user) => user.status === "Inaktiv").length,
    };
  }, [combinedAccessUsers]);

  function updateLocalAccessUser(userId, patch = {}) {
    setLocalAccessUsers((current) => {
      const existing = (current || []).map(normalizeAccessUser);
      if (existing.some((user) => String(user.id) === String(userId))) {
        return existing.map((user) => String(user.id) === String(userId) ? normalizeAccessUser({ ...user, ...patch }) : user);
      }
      const serverUser = (serverUsers || []).find((user) => String(user.id) === String(userId));
      if (serverUser) return [...existing, normalizeAccessUser({ ...serverUser, ...patch, source: "local" })];
      return existing;
    });
  }

  function createLocalAccessUserWorking() {
    const name = String(newUserForm.name || "").trim();
    const email = String(newUserForm.email || "").trim();
    if (!name || !email) {
      alert("Bitte Name und E-Mail eintragen.");
      return;
    }
    const user = normalizeAccessUser({ name, email, role: newUserForm.role || "pilot", status: "Aktiv", lastLogin: "-" });
    setLocalAccessUsers((current) => [user, ...(current || []).map(normalizeAccessUser)]);
    setNewUserForm({ name: "", email: "", role: "pilot", password: "" });
    writeAuditLog("access_user_created", { email, role: user.role });
  }

  function deleteLocalAccessUserWorking(userId) {
    if (!window.confirm("Benutzer wirklich aus der lokalen Rollenverwaltung entfernen?")) return;
    setLocalAccessUsers((current) => (current || []).filter((user) => String(user.id) !== String(userId)));
    writeAuditLog("access_user_removed", { userId });
  }

  function togglePermissionWorking(roleId, moduleId, rightKey) {
    setRolePermissionMatrix((current) => {
      const base = current || DEFAULT_ROLE_PERMISSIONS_PRO;
      const rolePermissions = base[roleId] || {};
      const modulePermissions = rolePermissions[moduleId] || {};
      return {
        ...base,
        [roleId]: {
          ...rolePermissions,
          [moduleId]: {
            ...modulePermissions,
            [rightKey]: !Boolean(modulePermissions[rightKey]),
          },
        },
      };
    });
  }

  function resetRolePermissionsWorking() {
    if (!window.confirm("Rechte-Matrix auf Standard zurücksetzen?")) return;
    setRolePermissionMatrix(DEFAULT_ROLE_PERMISSIONS_PRO);
    writeAuditLog("role_permissions_reset", {});
  }

  const authorityDashboardStatsPro = useMemo(
    () => buildAuthorityDashboardStatsPro(authorityDocumentsPro),
    [authorityDocumentsPro]
  );

  const authorityReminderDocumentsPro = useMemo(() =>
    (Array.isArray(authorityDocumentsPro) ? authorityDocumentsPro : [])
      .map((document) => ({ document, status: getAuthorityDocumentStatusPro(document) }))
      .filter(({ status }) => status.days !== null && status.days <= 90)
      .sort((a, b) => Number(a.status.days || 0) - Number(b.status.days || 0)),
    [authorityDocumentsPro]
  );

  const filteredAuthorityDocumentsPro = useMemo(() => {
    const query = String(authorityDocumentSearch || "").trim().toLowerCase();
    const filter = String(authorityDocumentFilter || "Alle");
    return (Array.isArray(authorityDocumentsPro) ? authorityDocumentsPro : []).filter((document) => {
      const status = getAuthorityDocumentStatusPro(document);
      const filterMatches = filter === "Alle" || document.type === filter || status.label === filter || document.category === filter;
      if (!filterMatches) return false;
      if (!query) return true;
      return [document.title, document.type, document.category, document.number, document.issuer, document.owner, document.notes, document.fileName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [authorityDocumentsPro, authorityDocumentSearch, authorityDocumentFilter]);

  const cloudSyncDashboardStatsPro = useMemo(
    () => buildCloudSyncDashboardStatsPro(cloudSyncTargetsPro, cloudSyncLogsPro),
    [cloudSyncTargetsPro, cloudSyncLogsPro]
  );

  const filteredCloudSyncTargetsPro = useMemo(() => {
    const query = String(cloudSyncSearch || "").trim().toLowerCase();
    const scopeFilter = String(cloudSyncScopeFilter || "Alle");
    return (Array.isArray(cloudSyncTargetsPro) ? cloudSyncTargetsPro : []).filter((target) => {
      const scopeMatches = scopeFilter === "Alle" || (Array.isArray(target.scopes) && target.scopes.includes(scopeFilter));
      if (!scopeMatches) return false;
      if (!query) return true;
      return [target.name, target.type, target.url, target.username, target.interval, target.status, target.notes, ...(target.scopes || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [cloudSyncTargetsPro, cloudSyncSearch, cloudSyncScopeFilter]);

  const mobileDashboardStatsPro = useMemo(
    () => buildMobileDashboardStatsPro(mobileMissionsPro, mobilePwaSettingsPro),
    [mobileMissionsPro, mobilePwaSettingsPro]
  );

  const filteredMobileMissionsPro = useMemo(() => {
    const query = String(mobileMissionSearchPro || "").trim().toLowerCase();
    const statusFilter = String(mobileMissionStatusFilterPro || "Alle");
    return (Array.isArray(mobileMissionsPro) ? mobileMissionsPro : []).filter((mission) => {
      const matchesStatus = statusFilter === "Alle" || mission.status === statusFilter;
      const haystack = [mission.title, mission.customerId, mission.projectId, mission.pilot, mission.drone, mission.address, mission.coordinates, mission.notes].join(" ").toLowerCase();
      return matchesStatus && (!query || haystack.includes(query));
    });
  }, [mobileMissionsPro, mobileMissionSearchPro, mobileMissionStatusFilterPro]);

  async function attachAuthorityDocumentFilePro(file) {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setAuthorityDocumentDraft((current) => ({
        ...current,
        fileName: file.name || "Dokument",
        fileType: file.type || "application/octet-stream",
        fileUrl: dataUrl,
        updatedAt: new Date().toLocaleString("de-DE"),
      }));
    } catch (error) {
      alert(error?.message || "Dokument konnte nicht gelesen werden.");
    }
  }

  function resetAuthorityDocumentDraftPro() {
    setEditingAuthorityDocumentId(null);
    setAuthorityDocumentDraft(createEmptyAuthorityDocumentPro());
  }

  function saveAuthorityDocumentPro() {
    const title = String(authorityDocumentDraft.title || authorityDocumentDraft.type || "").trim();
    if (!title) {
      alert("Bitte Titel oder Dokumenttyp eintragen.");
      return;
    }
    const id = editingAuthorityDocumentId || authorityDocumentDraft.id || `authority-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const document = normalizeAuthorityDocumentPro({
      ...authorityDocumentDraft,
      id,
      title,
      updatedAt: new Date().toLocaleString("de-DE"),
      createdAt: authorityDocumentDraft.createdAt || new Date().toLocaleString("de-DE"),
    });
    setAuthorityDocumentsPro((current) => {
      const list = Array.isArray(current) ? current : [];
      const exists = list.some((item) => String(item.id) === String(id));
      return exists ? list.map((item) => String(item.id) === String(id) ? document : item) : [document, ...list];
    });
    writeAuditLog(editingAuthorityDocumentId ? "authority_document_updated" : "authority_document_created", { id, title: document.title, type: document.type });
    resetAuthorityDocumentDraftPro();
  }

  function editAuthorityDocumentPro(document) {
    setEditingAuthorityDocumentId(document.id);
    setAuthorityDocumentDraft(normalizeAuthorityDocumentPro(document));
  }

  function deleteAuthorityDocumentPro(id) {
    if (!window.confirm("Behördendokument wirklich löschen?")) return;
    setAuthorityDocumentsPro((current) => (Array.isArray(current) ? current : []).filter((item) => String(item.id) !== String(id)));
    writeAuditLog("authority_document_deleted", { id });
  }

  function exportAuthorityDocumentsPdfPro() {
    const pdf = createPdfDocument({ unit: "mm", format: "a4" });
    let y = 18;
    const line = (text, size = 10, bold = false) => {
      if (y > 280) { pdf.addPage(); y = 18; }
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(size);
      pdf.text(String(text || ""), 18, y, { maxWidth: 174 });
      y += size >= 14 ? 9 : 6;
    };
    line("FlyMonitor Behörden-Center", 16, true);
    line(`Erstellt am: ${new Date().toLocaleString("de-DE")}`);
    line(`Dokumente: ${authorityDashboardStatsPro.total} · Gültig: ${authorityDashboardStatsPro.valid} · Bald ablaufend: ${authorityDashboardStatsPro.warning} · Abgelaufen: ${authorityDashboardStatsPro.expired}`);
    y += 4;
    line("Fristen & Dokumente", 13, true);
    (Array.isArray(authorityDocumentsPro) ? authorityDocumentsPro : []).forEach((document) => {
      const status = getAuthorityDocumentStatusPro(document);
      line(`${document.type || "Dokument"} · ${document.title || "-"}`, 11, true);
      line(`Nummer: ${document.number || "-"} · Aussteller: ${document.issuer || "-"}`);
      line(`Ausgestellt: ${document.issuedAt || "-"} · Gültig bis: ${document.validUntil || "-"} · Status: ${status.label}`);
      if (document.notes) line(`Notiz: ${document.notes}`);
      y += 2;
    });
    if (!authorityDocumentsPro.length) line("Noch keine Behördendokumente erfasst.");
    pdf.save("FlyMonitor-Behoerden-Center-Pro.pdf");
  }

  const droneFlightStats = useMemo(() => buildDroneFlightStats(droneAssets, completedFlights), [droneAssets, completedFlights]);
  const totalDroneFlightMinutes = useMemo(() => droneFlightStats.reduce((sum, item) => sum + Number(item.totalMinutes || 0), 0), [droneFlightStats]);
  const dueMaintenanceEntries = useMemo(() => maintenanceEntries.filter((entry) => ["warning", "danger"].includes(getMaintenanceTone(entry))), [maintenanceEntries]);
  const batteryWarnings = useMemo(() => batteryAssets.filter((battery) => getBatteryWarningTone(battery) !== "good"), [batteryAssets]);
  const filteredCustomers = useMemo(() => {
    const query = String(customerSearch || "").trim().toLowerCase();
    const list = Array.isArray(customers) ? customers : [];
    if (!query) return list;
    return list.filter((customer) =>
      [
        customer.customerNumber,
        customer.company,
        customer.contactName,
        customer.email,
        customer.phone,
        customer.city,
        customer.portalCode,
        customer.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [customers, customerSearch]);

  const [annualReportYear, setAnnualReportYear] = useState(() => String(new Date().getFullYear()));
  const [annualReportLogo, setAnnualReportLogo] = useState(() => safeLoad("flymonitor_annual_report_logo", ""));
  const [annualReportLogoEveryPage, setAnnualReportLogoEveryPage] = useState(() => safeLoad("flymonitor_annual_report_logo_every_page", true));
  const [digitalSignature, setDigitalSignature] = useState(() => safeLoad("flymonitor_digital_signature", ""));
  const [signatureAnnualReport, setSignatureAnnualReport] = useState(() => safeLoad("flymonitor_signature_annual_report", true));
  const [signatureFlightReports, setSignatureFlightReports] = useState(() => safeLoad("flymonitor_signature_flight_reports", true));
  const [signatureAuthorityReports, setSignatureAuthorityReports] = useState(() => safeLoad("flymonitor_signature_authority_reports", true));
  const businessDashboardStats = useMemo(
    () => buildBusinessDashboardStats({ completedFlights, droneAssets, batteryAssets, maintenanceEntries, mailPdfDocuments }),
    [completedFlights, droneAssets, batteryAssets, maintenanceEntries, mailPdfDocuments]
  );
  const annualReportYears = useMemo(
    () => getBusinessAvailableYears(completedFlights, logbook, maintenanceEntries),
    [completedFlights, logbook, maintenanceEntries]
  );
  const annualFlightRows = useMemo(
    () => buildDroneLogbookRows(completedFlights).filter((row) => getEntryYear(row.date) === String(annualReportYear)),
    [completedFlights, annualReportYear]
  );
  const annualMonthStats = useMemo(() => groupFlightRowsByMonth(annualFlightRows), [annualFlightRows]);

  useEffect(() => {
    localStorage.setItem("flymonitor_customers", JSON.stringify(Array.isArray(customers) ? customers : []));
  }, [customers]);

  useEffect(() => {
    localStorage.setItem("flymonitor_crm_activities", JSON.stringify(Array.isArray(crmActivities) ? crmActivities : []));
  }, [crmActivities]);

  useEffect(() => {
    localStorage.setItem("flymonitor_crm_contacts", JSON.stringify(Array.isArray(crmContacts) ? crmContacts : []));
  }, [crmContacts]);

  useEffect(() => {
    localStorage.setItem("flymonitor_crm_documents", JSON.stringify(Array.isArray(crmDocuments) ? crmDocuments : []));
  }, [crmDocuments]);

  useEffect(() => {
    localStorage.setItem("flymonitor_offers", JSON.stringify(Array.isArray(offers) ? offers : []));
  }, [offers]);

  useEffect(() => {
    localStorage.setItem("flymonitor_contracts", JSON.stringify(Array.isArray(contracts) ? contracts : []));
  }, [contracts]);

  useEffect(() => {
    localStorage.setItem("flymonitor_invoices", JSON.stringify(Array.isArray(invoices) ? invoices : []));
  }, [invoices]);



  useEffect(() => {
    localStorage.setItem("flymonitor_drone_assets", JSON.stringify(droneAssets));
  }, [droneAssets]);

  useEffect(() => {
    localStorage.setItem("flymonitor_battery_assets", JSON.stringify(batteryAssets));
  }, [batteryAssets]);

  useEffect(() => {
    localStorage.setItem("flymonitor_maintenance_entries", JSON.stringify(maintenanceEntries));
  }, [maintenanceEntries]);

  useEffect(() => {
    localStorage.setItem("flymonitor_annual_report_logo", JSON.stringify(annualReportLogo || ""));
  }, [annualReportLogo]);

  useEffect(() => {
    localStorage.setItem("flymonitor_annual_report_logo_every_page", JSON.stringify(Boolean(annualReportLogoEveryPage)));
  }, [annualReportLogoEveryPage]);

  useEffect(() => {
    localStorage.setItem("flymonitor_digital_signature", JSON.stringify(digitalSignature || ""));
  }, [digitalSignature]);

  useEffect(() => {
    localStorage.setItem("flymonitor_signature_annual_report", JSON.stringify(Boolean(signatureAnnualReport)));
  }, [signatureAnnualReport]);

  useEffect(() => {
    localStorage.setItem("flymonitor_signature_flight_reports", JSON.stringify(Boolean(signatureFlightReports)));
  }, [signatureFlightReports]);

  useEffect(() => {
    localStorage.setItem("flymonitor_signature_authority_reports", JSON.stringify(Boolean(signatureAuthorityReports)));
  }, [signatureAuthorityReports]);

  useEffect(() => {
    setBatteryAssetDraft((current) => current.droneId || !droneAssets[0]?.id ? current : { ...current, droneId: droneAssets[0].id });
    setMaintenanceDraft((current) => current.droneId || !droneAssets[0]?.id ? current : { ...current, droneId: droneAssets[0].id });
  }, [droneAssets]);

  function getCrmCustomerKey(customer = {}) {
    return String(customer.id || customer.customerNumber || customer.company || customer.email || "").trim();
  }

  const crmSelectedCustomer = useMemo(() => {
    const selectedKey = String(crmSelectedCustomerId || "").trim();
    const list = Array.isArray(customers) ? customers : [];
    if (selectedKey) {
      const found = list.find((customer) => getCrmCustomerKey(customer) === selectedKey);
      if (found) return found;
    }
    return list[0] || null;
  }, [customers, crmSelectedCustomerId]);

  const crmSelectedCustomerKey = useMemo(() => getCrmCustomerKey(crmSelectedCustomer || {}), [crmSelectedCustomer]);

  const crmCustomerContacts = useMemo(
    () => (Array.isArray(crmContacts) ? crmContacts : []).filter((item) => String(item.customerKey) === String(crmSelectedCustomerKey)),
    [crmContacts, crmSelectedCustomerKey]
  );

  const crmDashboardStats = useMemo(() => {
    const activeCustomers = (Array.isArray(customers) ? customers : []).length;
    const openOffers = (Array.isArray(offers) ? offers : []).filter((offer) => !["Angenommen", "Abgelehnt"].includes(String(offer.status || ""))).length;
    const openInvoices = (Array.isArray(invoices) ? invoices : []).filter((invoice) => !["Bezahlt", "bezahlt"].includes(String(invoice.status || ""))).length;
    const crmActivityCount = Array.isArray(crmActivities) ? crmActivities.length : 0;
    return { activeCustomers, openOffers, openInvoices, crmActivityCount };
  }, [customers, offers, invoices, crmActivities]);

  function addCrmActivityWorking(typeOverride = "") {
    const customer = crmSelectedCustomer;
    const key = getCrmCustomerKey(customer || {});
    if (!key) {
      alert("Bitte zuerst einen Kunden auswählen.");
      return;
    }
    const title = String(crmActivityForm.title || "").trim();
    const text = String(crmActivityForm.text || "").trim();
    if (!title && !text) {
      alert("Bitte Titel oder Notiz eintragen.");
      return;
    }
    const entry = {
      id: `crm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customerKey: key,
      customerName: customer?.company || customer?.contactName || customer?.customerNumber || "Kunde",
      type: typeOverride || crmActivityForm.type || "Notiz",
      title: title || crmActivityForm.type || "CRM-Aktivität",
      text,
      createdAt: new Date().toLocaleString("de-DE"),
      createdBy: adminEmail || "Admin",
      source: "CRM",
    };
    setCrmActivities((current) => [entry, ...(Array.isArray(current) ? current : [])].slice(0, 1000));
    setCrmActivityForm({ type: "Notiz", title: "", text: "" });
  }

  function saveCrmContactWorking() {
    const key = getCrmCustomerKey(crmSelectedCustomer || {});
    if (!key) {
      alert("Bitte zuerst einen Kunden auswählen.");
      return;
    }
    const name = String(crmContactForm.name || "").trim();
    if (!name) {
      alert("Bitte einen Namen für den Ansprechpartner eintragen.");
      return;
    }
    const contact = {
      id: `crm-contact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customerKey: key,
      ...crmContactForm,
      name,
      createdAt: new Date().toLocaleString("de-DE"),
    };
    setCrmContacts((current) => [contact, ...(Array.isArray(current) ? current : [])].slice(0, 500));
    setCrmContactForm({ name: "", role: "", email: "", phone: "" });
  }

  function deleteCrmContactWorking(id) {
    if (!window.confirm("Ansprechpartner wirklich löschen?")) return;
    setCrmContacts((current) => (Array.isArray(current) ? current : []).filter((item) => String(item.id) !== String(id)));
  }

  function exportCrmCustomerDossierPdfWorking(customer = crmSelectedCustomer) {
    if (!customer) {
      alert("Bitte zuerst einen Kunden auswählen.");
      return;
    }
    const key = getCrmCustomerKey(customer);
    const contacts = (Array.isArray(crmContacts) ? crmContacts : []).filter((item) => String(item.customerKey) === String(key));
    const activities = crmCustomerActivities.slice(0, 25);
    const customerMissions = (Array.isArray(missions) ? missions : []).filter((mission) => String(mission.customerId || mission.customerKey || "") === String(key));
    const customerMedia = (Array.isArray(galleryItems) ? galleryItems : []).filter((item) => String(item.customerId || item.customerKey || "") === String(key));

    const pdf = createPdfDocument({ unit: "mm", format: "a4" });
    let y = 18;
    const line = (text, size = 10, bold = false) => {
      if (y > 280) { pdf.addPage(); y = 18; }
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(size);
      pdf.text(String(text || ""), 18, y, { maxWidth: 174 });
      y += size >= 14 ? 9 : 6;
    };

    line("FlyMonitor CRM-Kundenakte", 16, true);
    line(customer.company || customer.contactName || customer.customerNumber || "Kunde", 13, true);
    line(`Kundennummer: ${customer.customerNumber || "-"}`);
    line(`Ansprechpartner: ${customer.contactName || "-"}`);
    line(`E-Mail: ${customer.email || "-"} · Telefon: ${customer.phone || "-"}`);
    line(`Adresse: ${[customer.street, customer.zip, customer.city].filter(Boolean).join(", ") || "-"}`);
    y += 4;
    line("Kennzahlen", 13, true);
    line(`Missionen: ${customerMissions.length} · Medien: ${customerMedia.length} · Ansprechpartner: ${contacts.length} · Aktivitäten: ${activities.length}`);
    y += 4;
    line("Ansprechpartner", 13, true);
    contacts.slice(0, 12).forEach((contact) => line(`${contact.name || "-"} · ${contact.role || "-"} · ${contact.email || "-"} · ${contact.phone || "-"}`));
    if (!contacts.length) line("Keine Ansprechpartner hinterlegt.");
    y += 4;
    line("Timeline", 13, true);
    activities.forEach((activity) => line(`${activity.createdAt || ""} · ${activity.type || "Aktivität"}: ${activity.title || ""} ${activity.text ? `– ${activity.text}` : ""}`));
    if (!activities.length) line("Keine Aktivitäten vorhanden.");
    pdf.save(`CRM_Kundenakte_${String(customer.customerNumber || customer.company || "Kunde").replace(/[^a-zA-Z0-9_-]+/g, "_")}.pdf`);
  }

  function createCustomerNumberWorking(list = customers) {
    const year = new Date().getFullYear();
    const used = new Set((Array.isArray(list) ? list : []).map((item) => String(item.customerNumber || "").trim()));

    for (let index = 1; index <= 9999; index += 1) {
      const next = `KD-${year}-${String(index).padStart(4, "0")}`;
      if (!used.has(next)) return next;
    }

    return `KD-${year}-${Date.now().toString().slice(-4)}`;
  }

  function createCustomerPortalCodeWorking() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(8);

    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }

    return Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]).join("");
  }

  function resetCustomerFormWorking() {
    setEditingCustomerId(null);
    setCustomerForm({ ...EMPTY_CUSTOMER_FORM });
  }

  function saveCustomerWorking() {
    const company = String(customerForm.company || "").trim();
    const contactName = String(customerForm.contactName || "").trim();

    if (!company && !contactName) {
      alert("Bitte mindestens Firma oder Ansprechpartner eintragen.");
      return;
    }

    const existingId = editingCustomerId || customerForm.id || `customer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextCustomer = {
      ...customerForm,
      id: existingId,
      customerNumber: String(customerForm.customerNumber || "").trim() || createCustomerNumberWorking(customers),
      company,
      contactName,
      street: String(customerForm.street || "").trim(),
      zip: String(customerForm.zip || "").trim(),
      city: String(customerForm.city || "").trim(),
      email: String(customerForm.email || "").trim(),
      phone: String(customerForm.phone || "").trim(),
      website: String(customerForm.website || "").trim(),
      portalCode: String(customerForm.portalCode || "").trim() || createCustomerPortalCodeWorking(),
      notes: String(customerForm.notes || "").trim(),
      updatedAt: new Date().toLocaleString("de-DE"),
      createdAt: customerForm.createdAt || new Date().toLocaleString("de-DE"),
    };

    setCustomers((current) => [nextCustomer, ...(Array.isArray(current) ? current : []).filter((item) => String(item.id) !== String(existingId))]);
    resetCustomerFormWorking();
    writeAuditLog("customer_saved", { customerNumber: nextCustomer.customerNumber, company: nextCustomer.company });
    alert("Kunde wurde gespeichert.");
  }

  function editCustomerWorking(customer) {
    setEditingCustomerId(customer.id);
    setCustomerForm({ ...EMPTY_CUSTOMER_FORM, ...customer });
    setAdminCenterTab("customers");
  }

  function deleteCustomerWorking(customerId) {
    if (!window.confirm("Kunde wirklich löschen? Bestehende Flüge bleiben erhalten.")) return;
    const customer = (Array.isArray(customers) ? customers : []).find((item) => String(item.id) === String(customerId));
    setCustomers((current) => (Array.isArray(current) ? current : []).filter((item) => String(item.id) !== String(customerId)));
    if (String(editingCustomerId) === String(customerId)) resetCustomerFormWorking();
    writeAuditLog("customer_deleted", { customerNumber: customer?.customerNumber, company: customer?.company });
  }

  function exportCustomersCsvWorking() {
    const rows = [
      ["Kundennummer", "Firma", "Ansprechpartner", "Straße", "PLZ", "Ort", "E-Mail", "Telefon", "Website", "Portalcode", "Notizen"],
      ...(Array.isArray(customers) ? customers : []).map((customer) => [
        customer.customerNumber,
        customer.company,
        customer.contactName,
        customer.street,
        customer.zip,
        customer.city,
        customer.email,
        customer.phone,
        customer.website,
        customer.portalCode,
        customer.notes,
      ]),
    ];

    downloadCsvFile("flymonitor-kunden.csv", rows);
  }

  function saveDroneAssetWorking() {
    const normalized = normalizeDroneAsset(droneAssetDraft);
    if (!normalized.name && !normalized.model) {
      alert("Bitte mindestens Name oder Modell der Drohne eintragen.");
      return;
    }
    setDroneAssets((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);
    setDroneAssetDraft(createEmptyDroneAsset());
  }

  function editDroneAssetWorking(drone) {
    setDroneAssetDraft(normalizeDroneAsset(drone));
  }

  function deleteDroneAssetWorking(id) {
    if (!window.confirm("Drohne wirklich löschen? Akku- und Wartungseinträge bleiben erhalten.")) return;
    setDroneAssets((current) => current.filter((item) => String(item.id) !== String(id)));
  }

  function saveBatteryAssetWorking() {
    const normalized = normalizeBatteryAsset(batteryAssetDraft);
    if (!normalized.name && !normalized.serialNumber) {
      alert("Bitte Akku-Name oder Seriennummer eintragen.");
      return;
    }
    setBatteryAssets((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);
    setBatteryAssetDraft(createEmptyBatteryAsset());
  }

  function editBatteryAssetWorking(battery) {
    setBatteryAssetDraft(normalizeBatteryAsset(battery));
  }

  function deleteBatteryAssetWorking(id) {
    if (!window.confirm("Akku wirklich löschen?")) return;
    setBatteryAssets((current) => current.filter((item) => String(item.id) !== String(id)));
  }

  function saveMaintenanceEntryWorking() {
    const normalized = normalizeMaintenanceEntry(maintenanceDraft);
    if (!normalized.droneId && droneAssets[0]?.id) normalized.droneId = droneAssets[0].id;
    if (!normalized.description && !normalized.type) {
      alert("Bitte Wartungsart oder Beschreibung eintragen.");
      return;
    }
    setMaintenanceEntries((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);
    setMaintenanceDraft(createEmptyMaintenanceEntry());
  }

  function editMaintenanceEntryWorking(entry) {
    setMaintenanceDraft(normalizeMaintenanceEntry(entry));
  }

  function deleteMaintenanceEntryWorking(id) {
    if (!window.confirm("Wartungseintrag wirklich löschen?")) return;
    setMaintenanceEntries((current) => current.filter((item) => String(item.id) !== String(id)));
  }

  function exportMaintenancePdfWorking() {
    const pdf = createPdfDocument();
    pdf.setFontSize(18);
    pdf.text("FlyMonitor Wartungsbuch", 20, 22);
    pdf.setFontSize(10);
    pdf.text(`Erstellt am ${new Date().toLocaleString("de-DE")} · ${maintenanceEntries.length} Einträge`, 20, 31);
    let y = 45;
    maintenanceEntries.forEach((entry, index) => {
      const drone = droneAssets.find((item) => String(item.id) === String(entry.droneId));
      const lines = [
        `${index + 1}. ${formatMailPdfGermanDate(entry.date)} · ${getDroneDisplayName(drone)} · ${entry.type}`,
        entry.description || "",
        entry.nextMaintenance ? `Nächste Wartung: ${formatMailPdfGermanDate(entry.nextMaintenance)}` : "",
        entry.costs ? `Kosten: ${entry.costs} EUR` : "",
        entry.notes || "",
      ].filter(Boolean);
      const wrapped = pdf.splitTextToSize(lines.join("\n"), 170);
      if (y + wrapped.length * 6 > 285) {
        pdf.addPage();
        y = 20;
      }
      pdf.text(wrapped, 20, y);
      y += wrapped.length * 6 + 8;
    });
    pdf.save("FlyMonitor-Wartungsbuch.pdf");
  }

  useEffect(() => {
    if (!adminUnlocked) return;
    loadAuditLogWorking();
    loadUsersWorking();
    apiGetJson(DESIGN_SETTINGS_API).then((data) => {
      if (data?.ok && data.settings) {
        if (data.settings.activeTemplate) setActiveTemplate(data.settings.activeTemplate);
        if (data.settings.customTheme) setCustomTheme(data.settings.customTheme);
        if (data.settings.templateColorOverrides) setTemplateColorOverrides(data.settings.templateColorOverrides);
      }
    });
  }, [adminUnlocked]);

  useEffect(() => {
    localStorage.setItem("flymonitor_active_template", JSON.stringify(activeTemplate));
  }, [activeTemplate]);

  useEffect(() => {
    localStorage.setItem("flymonitor_custom_theme", JSON.stringify(customTheme));
  }, [customTheme]);

  useEffect(() => {
    localStorage.setItem("flymonitor_template_color_overrides", JSON.stringify(templateColorOverrides));
  }, [templateColorOverrides]);


  useEffect(() => {
    localStorage.setItem("flymonitor_active_template", JSON.stringify(activeTemplate));
    if (adminUnlocked) {
      apiPostJson(DESIGN_SETTINGS_API, { settings: { activeTemplate, customTheme, templateColorOverrides, dark, savedAt: new Date().toISOString() } });
    }
  }, [activeTemplate, adminUnlocked, dark]);

  useEffect(() => {
    let cancelled = false;
    async function loadPublicDesignSettings() {
      const result = await apiGetJson(DESIGN_SETTINGS_API);
      const settings = result?.settings || {};
      if (!cancelled && result.ok && settings.activeTemplate) {
        setActiveTemplate(settings.activeTemplate);
        if (typeof settings.dark === "boolean") setDark(settings.dark);
        if (settings.templateColorOverrides) setTemplateColorOverrides(settings.templateColorOverrides);
      }
    }
    loadPublicDesignSettings();
    return () => { cancelled = true; };
  }, []);


  useEffect(() => {
    localStorage.setItem("flymonitor_drone_assets", JSON.stringify(droneAssets));
  }, [droneAssets]);

  useEffect(() => {
    localStorage.setItem("flymonitor_battery_assets", JSON.stringify(batteryAssets));
  }, [batteryAssets]);

  useEffect(() => {
    localStorage.setItem("flymonitor_maintenance_entries", JSON.stringify(maintenanceEntries));
  }, [maintenanceEntries]);

  useEffect(() => {
    setBatteryAssetDraft((current) => current.droneId || !droneAssets[0]?.id ? current : { ...current, droneId: droneAssets[0].id });
    setMaintenanceDraft((current) => current.droneId || !droneAssets[0]?.id ? current : { ...current, droneId: droneAssets[0].id });
  }, [droneAssets]);

  function createCustomerNumberWorking(list = customers) {
    const year = new Date().getFullYear();
    const used = new Set((Array.isArray(list) ? list : []).map((item) => String(item.customerNumber || "").trim()));

    for (let index = 1; index <= 9999; index += 1) {
      const next = `KD-${year}-${String(index).padStart(4, "0")}`;
      if (!used.has(next)) return next;
    }

    return `KD-${year}-${Date.now().toString().slice(-4)}`;
  }

  function createCustomerPortalCodeWorking() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(8);

    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }

    return Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]).join("");
  }

  function resetCustomerFormWorking() {
    setEditingCustomerId(null);
    setCustomerForm({ ...EMPTY_CUSTOMER_FORM });
  }

  function saveCustomerWorking() {
    const company = String(customerForm.company || "").trim();
    const contactName = String(customerForm.contactName || "").trim();

    if (!company && !contactName) {
      alert("Bitte mindestens Firma oder Ansprechpartner eintragen.");
      return;
    }

    const existingId = editingCustomerId || customerForm.id || `customer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const nextCustomer = {
      ...customerForm,
      id: existingId,
      customerNumber: String(customerForm.customerNumber || "").trim() || createCustomerNumberWorking(customers),
      company,
      contactName,
      street: String(customerForm.street || "").trim(),
      zip: String(customerForm.zip || "").trim(),
      city: String(customerForm.city || "").trim(),
      email: String(customerForm.email || "").trim(),
      phone: String(customerForm.phone || "").trim(),
      website: String(customerForm.website || "").trim(),
      portalCode: String(customerForm.portalCode || "").trim() || createCustomerPortalCodeWorking(),
      notes: String(customerForm.notes || "").trim(),
      updatedAt: new Date().toLocaleString("de-DE"),
      createdAt: customerForm.createdAt || new Date().toLocaleString("de-DE"),
    };

    setCustomers((current) => [nextCustomer, ...(Array.isArray(current) ? current : []).filter((item) => String(item.id) !== String(existingId))]);
    resetCustomerFormWorking();
    writeAuditLog("customer_saved", { customerNumber: nextCustomer.customerNumber, company: nextCustomer.company });
    alert("Kunde wurde gespeichert.");
  }

  function editCustomerWorking(customer) {
    setEditingCustomerId(customer.id);
    setCustomerForm({ ...EMPTY_CUSTOMER_FORM, ...customer });
    setAdminCenterTab("customers");
  }

  function deleteCustomerWorking(customerId) {
    if (!window.confirm("Kunde wirklich löschen? Bestehende Flüge bleiben erhalten.")) return;
    const customer = (Array.isArray(customers) ? customers : []).find((item) => String(item.id) === String(customerId));
    setCustomers((current) => (Array.isArray(current) ? current : []).filter((item) => String(item.id) !== String(customerId)));
    if (String(editingCustomerId) === String(customerId)) resetCustomerFormWorking();
    writeAuditLog("customer_deleted", { customerNumber: customer?.customerNumber, company: customer?.company });
  }

  function exportCustomersCsvWorking() {
    const rows = [
      ["Kundennummer", "Firma", "Ansprechpartner", "Straße", "PLZ", "Ort", "E-Mail", "Telefon", "Website", "Portalcode", "Notizen"],
      ...(Array.isArray(customers) ? customers : []).map((customer) => [
        customer.customerNumber,
        customer.company,
        customer.contactName,
        customer.street,
        customer.zip,
        customer.city,
        customer.email,
        customer.phone,
        customer.website,
        customer.portalCode,
        customer.notes,
      ]),
    ];

    downloadCsvFile("flymonitor-kunden.csv", rows);
  }

  function saveDroneAssetWorking() {
    const normalized = normalizeDroneAsset(droneAssetDraft);
    if (!normalized.name && !normalized.model) {
      alert("Bitte mindestens Name oder Modell der Drohne eintragen.");
      return;
    }
    setDroneAssets((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);
    setDroneAssetDraft(createEmptyDroneAsset());
  }

  function editDroneAssetWorking(drone) {
    setDroneAssetDraft(normalizeDroneAsset(drone));
  }

  function deleteDroneAssetWorking(id) {
    if (!window.confirm("Drohne wirklich löschen? Akku- und Wartungseinträge bleiben erhalten.")) return;
    setDroneAssets((current) => current.filter((item) => String(item.id) !== String(id)));
  }

  function saveBatteryAssetWorking() {
    const normalized = normalizeBatteryAsset(batteryAssetDraft);
    if (!normalized.name && !normalized.serialNumber) {
      alert("Bitte Akku-Name oder Seriennummer eintragen.");
      return;
    }
    setBatteryAssets((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);
    setBatteryAssetDraft(createEmptyBatteryAsset());
  }

  function editBatteryAssetWorking(battery) {
    setBatteryAssetDraft(normalizeBatteryAsset(battery));
  }

  function deleteBatteryAssetWorking(id) {
    if (!window.confirm("Akku wirklich löschen?")) return;
    setBatteryAssets((current) => current.filter((item) => String(item.id) !== String(id)));
  }

  function saveMaintenanceEntryWorking() {
    const normalized = normalizeMaintenanceEntry(maintenanceDraft);
    if (!normalized.droneId && droneAssets[0]?.id) normalized.droneId = droneAssets[0].id;
    if (!normalized.description && !normalized.type) {
      alert("Bitte Wartungsart oder Beschreibung eintragen.");
      return;
    }
    setMaintenanceEntries((current) => [normalized, ...current.filter((item) => String(item.id) !== String(normalized.id))]);
    setMaintenanceDraft(createEmptyMaintenanceEntry());
  }

  function editMaintenanceEntryWorking(entry) {
    setMaintenanceDraft(normalizeMaintenanceEntry(entry));
  }

  function deleteMaintenanceEntryWorking(id) {
    if (!window.confirm("Wartungseintrag wirklich löschen?")) return;
    setMaintenanceEntries((current) => current.filter((item) => String(item.id) !== String(id)));
  }

  function exportMaintenancePdfWorking() {
    const pdf = createPdfDocument();
    pdf.setFontSize(18);
    pdf.text("FlyMonitor Wartungsbuch", 20, 22);
    pdf.setFontSize(10);
    pdf.text(`Erstellt am ${new Date().toLocaleString("de-DE")} · ${maintenanceEntries.length} Einträge`, 20, 31);
    let y = 45;
    maintenanceEntries.forEach((entry, index) => {
      const drone = droneAssets.find((item) => String(item.id) === String(entry.droneId));
      const lines = [
        `${index + 1}. ${formatMailPdfGermanDate(entry.date)} · ${getDroneDisplayName(drone)} · ${entry.type}`,
        entry.description || "",
        entry.nextMaintenance ? `Nächste Wartung: ${formatMailPdfGermanDate(entry.nextMaintenance)}` : "",
        entry.costs ? `Kosten: ${entry.costs} EUR` : "",
        entry.notes || "",
      ].filter(Boolean);
      const wrapped = pdf.splitTextToSize(lines.join("\n"), 170);
      if (y + wrapped.length * 6 > 285) {
        pdf.addPage();
        y = 20;
      }
      pdf.text(wrapped, 20, y);
      y += wrapped.length * 6 + 8;
    });
    pdf.save("FlyMonitor-Wartungsbuch.pdf");
  }

  useEffect(() => {
    if (!adminUnlocked) return;
    let cancelled = false;
    async function loadCompletedFlightsFromServer() {
      const result = await apiGetJson(COMPLETED_FLIGHTS_API);
      if (!cancelled && result.ok && Array.isArray(result.items)) {
        setCompletedFlights(result.items);
        localStorage.setItem("flymonitor_completed_flights", JSON.stringify(result.items));
      }
    }
    loadCompletedFlightsFromServer();
    return () => { cancelled = true; };
  }, [adminUnlocked]);

  const activeTemplateOverride = templateColorOverrides?.[activeTemplate] || null;
  const hasActiveTemplateOverride = Boolean(activeTemplateOverride);
  const templateColorStyle = hasActiveTemplateOverride
    ? {
        "--fm-template-primary": activeTemplateOverride.primary || "#00B2E2",
        "--fm-template-secondary": activeTemplateOverride.secondary || "#021B33",
        "--fm-template-accent": activeTemplateOverride.accent || activeTemplateOverride.primary || "#00B2E2",
        "--fm-template-background": activeTemplateOverride.background || "#f8fafc",
        "--fm-template-surface": activeTemplateOverride.surface || "#ffffff",
        "--fm-template-text": activeTemplateOverride.text || "#0f172a",
      }
    : {};
  const appClassName = ["app", dark ? "dark" : "", `template-${activeTemplate}`, hasActiveTemplateOverride ? "template-customized" : ""].filter(Boolean).join(" ");

  const professionalTemplates = useMemo(() => [
    { id: "platinum", name: "FlyMonitor Platinum", group: "Premium", description: "Dunkelblau, Türkis, Glas-Effekte und Radar-Premium-Look." },
    { id: "mission", name: "Mission Control", group: "Control", description: "Einsatzleitstellen-Optik mit dunkler Karte und Live-Panels." },
    { id: "executive", name: "Executive Pro", group: "Business", description: "Seriöses Management-Dashboard mit klaren Karten." },
    { id: "executiveDark", name: "Executive Dark", group: "Business", description: "Anthrazit, Gold und hochwertige Kontraste." },
    { id: "aero", name: "Aero Glass", group: "Aviation", description: "Helles Glas-Design für moderne Luftfahrt-Ansichten." },
    { id: "aviation", name: "Aviation Authority", group: "Aviation", description: "Behördlich-seriöse Aviation-Optik mit Linienraster." },
    { id: "tower", name: "Tower Control", group: "Control", description: "Flugsicherungs-Look mit Radar- und ADS-B-Fokus." },
    { id: "government", name: "Government", group: "Public", description: "Dunkelblau/Weiß für Behördenkommunikation und Anträge." },
    { id: "dji", name: "DJI Enterprise", group: "Drone", description: "Cleanes Drohnen-Operations-Dashboard mit Orange-Akzenten." },
    { id: "stealth", name: "Stealth Black", group: "Dark", description: "Tiefschwarz mit Cyan-Akzenten für Premium-Branding." },
    { id: "black", name: "Premium Black Edition", group: "Dark", description: "Schwarze Warnwesten-Optik, Neon-Cyan und Silber." },
    { id: "safety", name: "Safety Vest", group: "Safety", description: "Warnwesten-Design mit Signal-Akzenten." },
    { id: "minimal", name: "Minimal White", group: "Clean", description: "Sehr ruhiges, weißes Professional-Layout." },
    { id: "apple", name: "Apple Professional", group: "Clean", description: "Viel Weißraum, weiche Schatten und Premium-Typografie." },
    { id: "microsoft", name: "Microsoft Fluent", group: "Clean", description: "Fluent-Style mit Transparenzen und ruhigen Flächen." },
    { id: "google", name: "Google Material 3", group: "Clean", description: "Material-You-Anmutung mit weichen Flächen." },
    { id: "tesla", name: "Tesla Minimal", group: "Clean", description: "Reduziertes, sehr modernes Interface." },
    { id: "ocean", name: "Ocean Radar", group: "Premium", description: "Türkis-blauer Küsten- und Radar-Look." },
    { id: "lufthansa", name: "Lufthansa Style", group: "Airline", description: "Dunkelblau, Weiß und gelbe Akzente." },
    { id: "airbus", name: "Airbus Operations", group: "Airline", description: "Cockpit-inspirierte technische Oberfläche." },
    { id: "nato", name: "NATO Operations", group: "Operations", description: "Oliv, Slate und Einsatzkarten-Charakter." },
    { id: "emergency", name: "Einsatzleitstelle", group: "Operations", description: "Feuerwehr/Polizei-ähnliche Statusanzeigen." },
    { id: "cyber", name: "Cyber Security", group: "Tech", description: "SOC-Look mit dunklen Karten und Neon-Akzenten." },
    { id: "enterprise", name: "Enterprise SaaS", group: "Business", description: "KPI-lastiges Firmen-Dashboard mit Premium-Karten." },
    { id: "corporateBlue", name: "Corporate Blue", group: "Corporate", description: "Klassisches Blau für Unternehmen." },
    { id: "corporateGreen", name: "Corporate Green", group: "Corporate", description: "Grüne Akzente für Safety und Nachhaltigkeit." },
    { id: "corporateRed", name: "Corporate Red", group: "Corporate", description: "Kräftige Akzente für Einsatz- und Warnstatus." },
    { id: "platinumLight", name: "Platinum Light", group: "Premium", description: "Helle Variante des FlyMonitor Premium-Designs." },
    { id: "authorityPortal", name: "Behörden Portal", group: "Public", description: "Formular- und Prüfportal für Behördenzugriffe." },
    { id: "droneCommand", name: "Drone Command Center", group: "Drone", description: "Zentrale Drohnen-Einsatzübersicht mit großen Statuskarten." },
    { id: "radarGreen", name: "Radar Green", group: "Operations", description: "Schwarzer Radarschirm mit kräftigem Grün für Lagebilder." },
    { id: "policeBlue", name: "Police Blue", group: "Authorities", description: "Blaue Behördenoptik für Polizei- und Ordnungsamt-Workflows." },
    { id: "fireOps", name: "Fire Ops", group: "Authorities", description: "Rot-dunkles Einsatzdesign für Feuerwehr und Gefahrenlagen." },
    { id: "medicalAir", name: "Medical Air", group: "Authorities", description: "Helle Rettungsdienst-Optik mit medizinischen Akzenten." },
    { id: "sarOps", name: "SAR Operations", group: "Authorities", description: "Such- und Rettungsdesign mit Orange, Blau und Kartenfokus." },
    { id: "maritime", name: "Maritime Coast", group: "Aviation", description: "Küsten- und Hafenlook für Förde, See und Offshore-Flüge." },
    { id: "forest", name: "Forest Survey", group: "Nature", description: "Grüne Vermessungsoptik für Natur, Wald und Umweltmonitoring." },
    { id: "desertOps", name: "Desert Ops", group: "Operations", description: "Sandfarbene Einsatzoptik mit robustem Field-Charakter." },
    { id: "aurora", name: "Aurora Night", group: "Premium", description: "Dunkles Premium-Theme mit violett-türkisem Nordlicht-Verlauf." },
    { id: "carbon", name: "Carbon Pro", group: "Premium", description: "Carbon-schwarze Oberfläche mit metallischen Akzenten." },
    { id: "slateGov", name: "Slate Government", group: "Public", description: "Neutraler Grau-Blau-Look für sachliche Behördenportale." },
    { id: "neonBlue", name: "Neon Blue", group: "Tech", description: "Dunkles Technikdesign mit leuchtend blauen Statuslinien." },
    { id: "sunrise", name: "Sunrise Ops", group: "Premium", description: "Warme Morgenfarben für freundliche öffentliche Ansichten." },
    { id: "nordicIce", name: "Nordic Ice", group: "Clean", description: "Kühles, helles Design mit Eisblau und klaren Flächen." },
    { id: "terminal", name: "Terminal Ops", group: "Tech", description: "Command-Line-Optik für technische Admin- und Live-Daten." },
    { id: "nightMap", name: "Night Map", group: "Map", description: "Dunkle Karten- und Lageansicht für Nachtbetrieb." },
    { id: "bronze", name: "Bronze Executive", group: "Business", description: "Dunkles Executive-Theme mit warmen Bronze-Akzenten." },
    { id: "matrix", name: "Matrix UAS", group: "Tech", description: "Schwarz-grüner Tech-Look für Live-Systeme und Monitoring." },
    { id: "whiteLabel", name: "White Label Pro", group: "Custom", description: "Sehr neutrale Basis für eigenes Branding und Kundenportale." },
    { id: "custom", name: "Custom Theme", group: "Custom", description: "Vorbereitet für eigene Farben, Logo und Hintergrundbilder." },
  ], []);

  const templatePreviewColors = useMemo(() => ({
    platinum: ["#021B33", "#00B2E2", "#F8FAFC"], mission: ["#03131f", "#22c55e", "#dffaf0"], executive: ["#0f172a", "#2563eb", "#ffffff"], executiveDark: ["#020617", "#d4af37", "#f8fafc"],
    aero: ["#e0f2fe", "#38bdf8", "#0f172a"], aviation: ["#0b1f4d", "#60a5fa", "#ffffff"], tower: ["#03131f", "#22c55e", "#eafff6"], government: ["#0b1f4d", "#1d4ed8", "#ffffff"],
    dji: ["#ffffff", "#f97316", "#111827"], stealth: ["#020617", "#22d3ee", "#f8fafc"], black: ["#050505", "#00B2E2", "#cbd5e1"], safety: ["#111827", "#f97316", "#fef3c7"],
    minimal: ["#ffffff", "#e5e7eb", "#111827"], apple: ["#ffffff", "#94a3b8", "#111827"], microsoft: ["#ffffff", "#2563eb", "#10b981"], google: ["#ffffff", "#4285f4", "#34a853"], tesla: ["#ffffff", "#dc2626", "#111827"],
    ocean: ["#ecfeff", "#0891b2", "#083344"], lufthansa: ["#05164d", "#facc15", "#ffffff"], airbus: ["#eff6ff", "#0ea5e9", "#0f172a"], nato: ["#334155", "#84cc16", "#f8fafc"], emergency: ["#7f1d1d", "#ef4444", "#ffffff"],
    cyber: ["#020617", "#22d3ee", "#a7f3d0"], enterprise: ["#eff6ff", "#2563eb", "#0f172a"], corporateBlue: ["#eff6ff", "#2563eb", "#1e3a8a"], corporateGreen: ["#ecfdf5", "#16a34a", "#064e3b"], corporateRed: ["#fff1f2", "#dc2626", "#7f1d1d"], platinumLight: ["#f8fafc", "#00B2E2", "#021B33"], authorityPortal: ["#f8fafc", "#1d4ed8", "#0b1f4d"], droneCommand: ["#03131f", "#22c55e", "#f8fafc"],
    radarGreen: ["#020617", "#39ff14", "#d1fae5"], policeBlue: ["#06172d", "#2563eb", "#dbeafe"], fireOps: ["#1f0505", "#ef4444", "#fee2e2"], medicalAir: ["#ffffff", "#06b6d4", "#dc2626"], sarOps: ["#0f172a", "#f97316", "#38bdf8"],
    maritime: ["#082f49", "#06b6d4", "#e0f2fe"], forest: ["#052e16", "#22c55e", "#f0fdf4"], desertOps: ["#78350f", "#f59e0b", "#fffbeb"], aurora: ["#020617", "#a855f7", "#22d3ee"], carbon: ["#09090b", "#94a3b8", "#f8fafc"],
    slateGov: ["#334155", "#64748b", "#f8fafc"], neonBlue: ["#020617", "#2563eb", "#93c5fd"], sunrise: ["#fff7ed", "#fb923c", "#7c2d12"], nordicIce: ["#f0f9ff", "#7dd3fc", "#0f172a"], terminal: ["#020617", "#22c55e", "#bbf7d0"],
    nightMap: ["#020617", "#3b82f6", "#cbd5e1"], bronze: ["#1c1917", "#b45309", "#fed7aa"], matrix: ["#000000", "#00ff66", "#d1fae5"], whiteLabel: ["#ffffff", "#0f172a", "#64748b"], custom: [customTheme.background || "#0F172A", customTheme.primary || "#00B2E2", customTheme.secondary || "#021B33"],
  }), [customTheme.background, customTheme.primary, customTheme.secondary]);

  const activateTemplateWorking = (templateId) => {
    setActiveTemplate(templateId);
    localStorage.setItem("flymonitor_active_template", JSON.stringify(templateId));
    writeAuditLog("template_changed", { template: templateId });
  };

  const activeTemplateLabel =
    professionalTemplates.find((template) => template.id === activeTemplate)?.name ||
    activeTemplate ||
    "FlyMonitor Platinum";


  const getTemplateDefaultColorObject = (templateId = activeTemplate) => {
    const colors = templatePreviewColors[templateId] || templatePreviewColors.custom || ["#0f172a", "#00B2E2", "#ffffff"];
    return {
      background: colors[0] || "#f8fafc",
      primary: colors[1] || "#00B2E2",
      secondary: colors[0] || "#021B33",
      accent: colors[1] || "#00B2E2",
      surface: colors[2] || "#ffffff",
      text: ["stealth", "black", "cyber", "radarGreen", "terminal", "matrix", "nightMap", "carbon", "aurora", "bronze"].includes(templateId) ? "#f8fafc" : "#0f172a",
    };
  };

  const activeTemplateColorDraft = {
    ...getTemplateDefaultColorObject(activeTemplate),
    ...(templateColorOverrides?.[activeTemplate] || {}),
  };

  function updateActiveTemplateColorWorking(key, value) {
    setTemplateColorOverrides((prev) => ({
      ...(prev || {}),
      [activeTemplate]: {
        ...getTemplateDefaultColorObject(activeTemplate),
        ...((prev || {})[activeTemplate] || {}),
        [key]: value,
      },
    }));
  }

  function resetActiveTemplateColorsWorking() {
    setTemplateColorOverrides((prev) => {
      const next = { ...(prev || {}) };
      delete next[activeTemplate];
      return next;
    });
    writeAuditLog("template_colors_reset", { template: activeTemplate });
  }

  useEffect(() => {
    const events = ["click", "keydown", "mousemove", "touchstart"];

    const syncAdminSession = () => {
      if (!isAdminSessionActive()) {
        setAdminUnlocked(false);
        setAdminRole("gast");
        clearAdminSession();
        return;
      }

      const session = refreshAdminSession();
      setAdminUnlocked(true);
      setAdminRole(session?.role || "admin");
    };

    events.forEach((eventName) => window.addEventListener(eventName, syncAdminSession, { passive: true }));
    const timer = window.setInterval(syncAdminSession, 60 * 1000);

    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, syncAdminSession));
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const clean = normalizeEmailRecipientList(savedEmailRecipients);
    const value = JSON.stringify(clean);
    localStorage.setItem("droneready_email_recipients", value);
    localStorage.setItem("emailRecipients", value);
    localStorage.setItem("flymonitor_email_recipients", value);
    localStorage.setItem("savedEmailRecipients", value);
  }, [savedEmailRecipients]);



  useEffect(() => {
    const clean = normalizeEmailRecipientList(savedEmailRecipients);
    const value = JSON.stringify(clean);
    localStorage.setItem("droneready_email_recipients", value);
    localStorage.setItem("emailRecipients", value);
    localStorage.setItem("flymonitor_email_recipients", value);
    localStorage.setItem("savedEmailRecipients", value);

    if (!selectedRecipientIds.length && clean.length) {
      setSelectedRecipientIds(clean.map((recipient) => recipient.id));
    }
  }, [savedEmailRecipients, selectedRecipientIds.length]);


  const recipientsByCategory = useMemo(() => {
    const categoryGroups = {};
    savedEmailRecipients.forEach((recipient) => {
      const category = recipient.category || "Allgemein";
      const subcategory = recipient.subcategory || "Allgemein";
      if (!categoryGroups[category]) categoryGroups[category] = {};
      if (!categoryGroups[category][subcategory]) categoryGroups[category][subcategory] = [];
      categoryGroups[category][subcategory].push(recipient);
    });
    return Object.entries(categoryGroups)
      .sort(([a], [b]) => a.localeCompare(b, "de"))
      .map(([category, subgroups]) => ({
        category,
        recipients: Object.values(subgroups).flat(),
        subcategories: Object.entries(subgroups)
          .sort(([a], [b]) => a.localeCompare(b, "de"))
          .map(([subcategory, recipients]) => ({
            subcategory,
            recipients: recipients.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "de")),
          })),
      }));
  }, [savedEmailRecipients]);


  const recipientCategoryOptions = useMemo(() => {
    return Array.from(
      new Set(
        savedEmailRecipients
          .map((recipient) => normalizeRecipientCategoryName(recipient.category || "Allgemein"))
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "de"));
  }, [savedEmailRecipients]);


  const recipientSubcategoryOptions = useMemo(() => {
    const selectedCategory =
      normalizeRecipientCategoryName(newRecipientCategoryCustom) ||
      findExistingRecipientCategory(recipientCategoryOptions, newRecipientCategory) ||
      normalizeRecipientCategoryName(newRecipientCategory);

    if (!selectedCategory) return [];

    return Array.from(
      new Set(
        savedEmailRecipients
          .filter(
            (recipient) =>
              normalizeRecipientCategoryName(recipient.category || "Allgemein").toLowerCase() ===
              normalizeRecipientCategoryName(selectedCategory).toLowerCase()
          )
          .map((recipient) => normalizeRecipientCategoryName(recipient.subcategory || "Allgemein"))
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "de"));
  }, [savedEmailRecipients, newRecipientCategory, recipientCategoryOptions]);

  const [editingRecipientId, setEditingRecipientId] = useState(null);
  const [editRecipient, setEditRecipient] = useState({});
  const [editingRecipientCategory, setEditingRecipientCategory] = useState(null);
  const [editRecipientCategoryName, setEditRecipientCategoryName] = useState("");
  const [editingLogId, setEditingLogId] = useState(null);
  const [editLogEntry, setEditLogEntry] = useState({});
  const [flightReportForm, setFlightReportForm] = useState(emptyFlightReport);
  const [djiImportReports, setDjiImportReports] = useState([]);
  const [mapPick, setMapPick] = useState(null);
  const [mapFavoritePlaces, setMapFavoritePlaces] = useState(() => safeLoad("droneready_map_favorites", []));
  const [editingFavoriteId, setEditingFavoriteId] = useState(null);
  const [editFavorite, setEditFavorite] = useState({ name: "", address: "" });
  const [droneLocations, setDroneLocations] = useState(() => safeLoad("droneready_drone_locations", DEFAULT_DRONE_LOCATIONS));
  const [locationCategoryFilter, setLocationCategoryFilter] = useState("Alle");
  const [blogPosts, setBlogPosts] = useState(() => safeLoad("droneready_blog_posts", DEFAULT_BLOG_POSTS));
  const [galleryItems, setGalleryItems] = useState(() => safeLoad("droneready_gallery_items", DEFAULT_GALLERY_ITEMS));

  const crmCustomerActivities = useMemo(() => {
    const key = String(crmSelectedCustomerKey || "");
    const activityItems = (Array.isArray(crmActivities) ? crmActivities : [])
      .filter((item) => String(item.customerKey) === key)
      .map((item) => ({ ...item, source: item.source || "CRM" }));

    const missionItems = (Array.isArray(missions) ? missions : [])
      .filter((mission) => String(mission.customerId || mission.customerKey || "") === key)
      .map((mission) => ({
        id: `crm-mission-${mission.id}`,
        type: "Mission",
        title: mission.title || mission.name || "Mission",
        text: [mission.status, mission.date, mission.location || mission.address].filter(Boolean).join(" · "),
        createdAt: mission.createdAt || mission.date || "",
        source: "Missionen",
      }));

    const mediaItems = (Array.isArray(galleryItems) ? galleryItems : [])
      .filter((item) => String(item.customerId || item.customerKey || "") === key)
      .map((item) => ({
        id: `crm-media-${item.id}`,
        type: getGalleryMediaType(item) === "video" ? "Video" : "Bild",
        title: item.title || "Galerie-Medium",
        text: [item.category, item.subcategory, item.projectId || item.projectName].filter(Boolean).join(" · "),
        createdAt: item.uploadedAt || item.addedAt || "",
        source: "Galerie",
      }));

    const invoiceItems = (Array.isArray(invoices) ? invoices : [])
      .filter((invoice) => String(invoice.customerId || invoice.customerKey || "") === key)
      .map((invoice) => ({
        id: `crm-invoice-${invoice.id}`,
        type: "Rechnung",
        title: invoice.invoiceNumber || invoice.title || "Rechnung",
        text: [invoice.status || "Offen", invoice.totalGross || invoice.total || invoice.amount].filter(Boolean).join(" · "),
        createdAt: invoice.date || invoice.createdAt || "",
        source: "Rechnungen",
      }));

    return [...activityItems, ...missionItems, ...mediaItems, ...invoiceItems]
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }, [crmActivities, crmSelectedCustomerKey, missions, galleryItems, invoices]);
  const [galleryManagedCategories, setGalleryManagedCategories] = useState(() =>
    normalizeGalleryCategoryList(safeLoad("droneready_gallery_categories", DEFAULT_GALLERY_CATEGORIES), safeLoad("droneready_gallery_items", DEFAULT_GALLERY_ITEMS))
  );
  const [blogCategoryFilter, setBlogCategoryFilter] = useState("Alle");
  const [galleryCategoryFilter, setGalleryCategoryFilter] = useState("Alle");
  const [gallerySubcategoryFilter, setGallerySubcategoryFilter] = useState("Alle");
  const [galleryMapCustomerFilter, setGalleryMapCustomerFilter] = useState("Alle");
  const [galleryMapProjectFilter, setGalleryMapProjectFilter] = useState("Alle");
  const [galleryMapMediaFilter, setGalleryMapMediaFilter] = useState("Alle");
  const [galleryMapFavoriteOnly, setGalleryMapFavoriteOnly] = useState(false);
  const [selectedGalleryMapItem, setSelectedGalleryMapItem] = useState(null);
  const [downloadCenterSearch, setDownloadCenterSearch] = useState("");
  const [downloadCenterCategory, setDownloadCenterCategory] = useState("Alle");
  const [downloadCenterCustomer, setDownloadCenterCustomer] = useState("Alle");
  const [downloadCenterProject, setDownloadCenterProject] = useState("Alle");
  const [downloadCenterMediaType, setDownloadCenterMediaType] = useState("Alle");
  const [downloadCenterFavoritesOnly, setDownloadCenterFavoritesOnly] = useState(false);
  const [newGalleryCategory, setNewGalleryCategory] = useState({ name: "", description: "", subcategory: "" });
  const [editingGalleryCategoryId, setEditingGalleryCategoryId] = useState(null);
  const [editGalleryCategory, setEditGalleryCategory] = useState({ name: "", description: "", subcategoriesText: "" });
  const [newBlogPost, setNewBlogPost] = useState({ category: "Allgemein", title: "", text: "", imageUrl: "" });
  const [editingBlogId, setEditingBlogId] = useState(null);
  const [editBlogPost, setEditBlogPost] = useState({ category: "", title: "", text: "", imageUrl: "" });
  const [expandedBlogPosts, setExpandedBlogPosts] = useState({});

  const [newDroneLocation, setNewDroneLocation] = useState({
    category: "Allgemein",
    name: "",
    address: "",
    coordinates: "",
    lat: "",
    lon: "",
    note: "",
  });
  const [editingLocationId, setEditingLocationId] = useState(null);
  const [editDroneLocation, setEditDroneLocation] = useState({
    category: "",
    name: "",
    address: "",
    coordinates: "",
    lat: "",
    lon: "",
    note: "",
  });

  const [newGalleryItem, setNewGalleryItem] = useState({ category: "Allgemein", subcategory: "Sonstiges", title: "", imageUrl: "", videoUrl: "", mediaType: "image", text: "", featured: false, favorite: false, tags: "", coordinates: "", address: "", customerId: "", projectId: "", watermarkText: "", watermarkPosition: "", watermarkMode: "inherit" });
  const [editingGalleryId, setEditingGalleryId] = useState(null);
  const [editGalleryItem, setEditGalleryItem] = useState({ category: "", subcategory: "", title: "", imageUrl: "", videoUrl: "", mediaType: "image", text: "", featured: false, favorite: false, tags: "", coordinates: "", address: "", customerId: "", projectId: "", watermarkText: "", watermarkPosition: "", watermarkMode: "inherit" });
  const [authorityQuery, setAuthorityQuery] = useState("");
  const [authorityReport, setAuthorityReport] = useState(null);
  const [authorityError, setAuthorityError] = useState("");
  const [authorityPinRequestEmail, setAuthorityPinRequestEmail] = useState("");
  const [activePage, setActivePage] = useState(() => {
    const currentHash = String(window.location.hash || "").toLowerCase();
    if (currentHash.startsWith("#behoerde")) return "authority";
    if (currentHash.startsWith("#galerie") || currentHash.startsWith("#gallery")) return "gallery";
    if (currentHash.startsWith("#blog")) return "blog";
    if (currentHash.startsWith("#locations")) return "locations";
    if (getPinFromCurrentUrl()) return "authority";
    return "home";
  });
  const [waypoints, setWaypoints] = useState([
    { name: "Start", latOffset: 0, lonOffset: 0 },
    { name: "WP1", latOffset: 0.012, lonOffset: 0.018 },
    { name: "Ziel", latOffset: 0.022, lonOffset: 0.035 },
  ]);
  const [uvIndex, setUvIndex] = useState(4);
  const [airQuality, setAirQuality] = useState({ pm10: 12, pm25: 6, quality: "Gut" });
  const [updateReady, setUpdateReady] = useState(false);
  const [droneProfile, setDroneProfile] = useState(() => safeLoad("droneready_drone", { name: "DJI Mini", weight: "< 250 g", battery: 34 }));

  useEffect(() => {
    const handleUpdateReady = () => {
      setUpdateReady(true);
    };

    window.addEventListener("flymonitor:update-ready", handleUpdateReady);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (!registration) return;

        if (registration.waiting) {
          setUpdateReady(true);
        }

        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateReady(true);
            }
          });
        });
      }).catch((error) => {
        console.warn("PWA-Updateprüfung fehlgeschlagen:", error);
      });
    }

    return () => {
      window.removeEventListener("flymonitor:update-ready", handleUpdateReady);
    };
  }, []);

  async function loadUasTickerWorking(force = false) {
    try {
      setUasTickerAdminStatus(force ? "Liveticker wird manuell aktualisiert ..." : "Liveticker wird geladen ...");
      const response = await fetch(`/api/get-uas-ticker.php?${force ? "force=1&" : ""}t=${Date.now()}`, {
        cache: "no-store",
      });

      const data = await response.json();

      if (Array.isArray(data)) {
        const nextTicker = germanOnlyTickerItems(data);
        setUasTicker(nextTicker);
        const label = new Date().toLocaleString("de-DE");
        setUasTickerLastUpdate(label);
        localStorage.setItem("flymonitor_uas_ticker_last_update", label);
        setUasTickerAdminStatus(`${nextTicker.length} UAS-Meldungen geladen.`);
        return nextTicker;
      }

      setUasTickerAdminStatus("Die Liveticker-API hat keine Liste zurückgegeben.");
      return [];
    } catch (error) {
      console.warn("UAS-Liveticker konnte nicht geladen werden:", error);
      setUasTickerAdminStatus("UAS-Liveticker konnte nicht geladen werden.");
      return [];
    }
  }

  function clearUasTickerCacheWorking() {
    localStorage.removeItem("flymonitor_uas_ticker_last_update");
    setUasTickerLastUpdate("Cache lokal geleert");
    loadUasTickerWorking(true);
  }

  useEffect(() => {
    let mounted = true;

    async function loadInitialTicker() {
      if (!mounted) return;
      await loadUasTickerWorking(false);
    }

    loadInitialTicker();

    const interval = window.setInterval(() => loadUasTickerWorking(false), 60 * 1000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const flightTime = useMemo(() => Math.max(4, Math.round(routeKm * 5 + result.wind / 5)), [routeKm, result.wind]);
  const battery = useMemo(() => Math.max(18, 100 - Math.round(flightTime * 3.2 + result.wind)), [flightTime, result.wind]);
  const score = useMemo(() => Math.max(0, Math.round(100 - result.wind * 1.3 - result.gusts * 0.7 - result.rain * 0.45 - result.kp * 2)), [result]);
  const combinedTickerMessages = useMemo(() => {
    const automaticMessages = uasTicker.map((item, index) => ({
      id: item.id || `uas-${index}`,
      text: translateTickerTextToGerman(
        item.title
          ? `${item.title}${item.text ? ` – ${translateTickerTextToGerman(decodeTickerHtmlEntities(item.text))}` : ""}`
          : item.message || item.text || "UAS-Meldung"
      ),
      createdAt: item.date || item.createdAt || "Automatisch",
      source: item.source || "UAS-Liveticker",
      url: normalizeTickerUrl(item.url || item.link || item.sourceUrl || item.href),
    }));

    return [...automaticMessages, ...tickerMessages].slice(0, 30);
  }, [uasTicker, tickerMessages]);

  const visibleLogbook = logbook.slice((logbookPage - 1) * 10, logbookPage * 10);
  const totalLogbookPages = Math.max(1, Math.ceil(logbook.length / 10));
  const calendarFlightsByDate = useMemo(() => {
    const groups = {};

    logbook.forEach((entry) => {
      const key = normalizeIsoDate(entry.date);
      if (!key) return;

      if (!groups[key]) groups[key] = [];
      groups[key].push(entry);
    });

    return groups;
  }, [logbook]);

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - startOffset);

    return Array.from({ length: 42 }, (_, index) => {
      const d = new Date(start);
      d.setDate(start.getDate() + index);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      return {
        date: d,
        iso,
        inMonth: d.getMonth() === month,
        flights: calendarFlightsByDate[iso] || [],
      };
    });
  }, [calendarMonth, calendarFlightsByDate]);


  const groupedEmailRecipients = useMemo(() => {
    const groups = new Map();

    savedEmailRecipients.forEach((recipient) => {
      const category = recipient.category || "Ohne Kategorie";
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(recipient);
    });

    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b, "de"))
      .map(([category, recipients]) => ({
        category,
        recipients: recipients.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "de")),
      }));
  }, [savedEmailRecipients]);

  const droneLocationCategories = useMemo(
    () => ["Alle", ...Array.from(new Set(droneLocations.map((item) => item.category || "Allgemein"))).sort((a, b) => a.localeCompare(b, "de"))],
    [droneLocations]
  );

  const filteredDroneLocations = useMemo(
    () =>
      locationCategoryFilter === "Alle"
        ? droneLocations
        : droneLocations.filter((item) => (item.category || "Allgemein") === locationCategoryFilter),
    [droneLocations, locationCategoryFilter]
  );

  const blogCategories = useMemo(
    () => ["Alle", ...Array.from(new Set(blogPosts.map((item) => item.category || "Allgemein"))).sort((a, b) => a.localeCompare(b, "de"))],
    [blogPosts]
  );

  const filteredBlogPosts = useMemo(
    () =>
      blogCategoryFilter === "Alle"
        ? blogPosts
        : blogPosts.filter((item) => (item.category || "Allgemein") === blogCategoryFilter),
    [blogPosts, blogCategoryFilter]
  );


  useEffect(() => {
    runWeeklyLocationUpdateWorking(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const galleryCategories = useMemo(
    () => ["Alle", ...galleryManagedCategories.map((category) => category.name)],
    [galleryManagedCategories]
  );

  const gallerySubcategories = useMemo(() => {
    if (galleryCategoryFilter === "Alle") {
      return ["Alle", ...Array.from(new Set(galleryManagedCategories.flatMap((category) => category.subcategories || []).map(normalizeGalleryText).filter(Boolean))).sort((a, b) => a.localeCompare(b, "de"))];
    }
    return ["Alle", ...getGallerySubcategories(galleryManagedCategories, galleryCategoryFilter)];
  }, [galleryManagedCategories, galleryCategoryFilter]);

  const newGallerySubcategoryOptions = useMemo(
    () => getGallerySubcategories(galleryManagedCategories, newGalleryItem.category),
    [galleryManagedCategories, newGalleryItem.category]
  );

  const editGallerySubcategoryOptions = useMemo(
    () => getGallerySubcategories(galleryManagedCategories, editGalleryItem.category),
    [galleryManagedCategories, editGalleryItem.category]
  );

  const filteredGalleryItems = useMemo(
    () => galleryItems.filter((item) => {
      const itemCategory = item.category || "Allgemein";
      const itemSubcategory = item.subcategory || item.subCategory || "Sonstiges";
      const categoryMatches = galleryCategoryFilter === "Alle" || itemCategory === galleryCategoryFilter;
      const subcategoryMatches = gallerySubcategoryFilter === "Alle" || itemSubcategory === gallerySubcategoryFilter;
      return categoryMatches && subcategoryMatches;
    }),
    [galleryItems, galleryCategoryFilter, gallerySubcategoryFilter]
  );


  const galleryMapItems = useMemo(
    () => filteredGalleryItems
      .map((item) => ({ item, point: parseGalleryCoordinates(item) }))
      .filter((entry) => entry.point),
    [filteredGalleryItems]
  );

  const galleryMapCustomerOptions = useMemo(() => {
    const savedCustomers = Array.isArray(customers) ? customers : [];
    const fromMedia = galleryItems
      .map((item) => item.customerId || item.customerNumber || item.customerName || "")
      .filter(Boolean);
    return ["Alle", ...Array.from(new Set([
      ...savedCustomers.map((customer) => customer.customerNumber || customer.id || customer.company || customer.contactName || "").filter(Boolean),
      ...fromMedia,
    ])).sort((a, b) => String(a).localeCompare(String(b), "de"))];
  }, [customers, galleryItems]);

  const galleryMapProjectOptions = useMemo(() => {
    const missionOptions = (Array.isArray(missions) ? missions : [])
      .map((mission) => mission.title || mission.name || mission.id || "")
      .filter(Boolean);
    const mediaProjects = galleryItems.map((item) => item.projectId || item.projectName || "").filter(Boolean);
    return ["Alle", ...Array.from(new Set([...missionOptions, ...mediaProjects])).sort((a, b) => String(a).localeCompare(String(b), "de"))];
  }, [missions, galleryItems]);

  const proGalleryMapItems = useMemo(() => {
    return galleryMapItems.filter(({ item }) => {
      const mediaType = getGalleryMediaType(item);
      const customerValue = String(item.customerId || item.customerNumber || item.customerName || "").trim();
      const projectValue = String(item.projectId || item.projectName || "").trim();
      const customerMatches = galleryMapCustomerFilter === "Alle" || customerValue === galleryMapCustomerFilter;
      const projectMatches = galleryMapProjectFilter === "Alle" || projectValue === galleryMapProjectFilter;
      const mediaMatches = galleryMapMediaFilter === "Alle" || mediaType === galleryMapMediaFilter;
      const favoriteMatches = !galleryMapFavoriteOnly || Boolean(item.favorite || item.featured);
      return customerMatches && projectMatches && mediaMatches && favoriteMatches;
    });
  }, [galleryMapItems, galleryMapCustomerFilter, galleryMapProjectFilter, galleryMapMediaFilter, galleryMapFavoriteOnly]);

  const galleryMapCenter = useMemo(() => {
    const first = proGalleryMapItems[0]?.point || galleryMapItems[0]?.point;
    return first ? [first.lat, first.lon] : [54.323, 10.122];
  }, [proGalleryMapItems, galleryMapItems]);

  const showcaseGalleryItems = useMemo(
    () => galleryItems
      .filter((item) => item.featured || getGalleryMediaUrl(item))
      .slice(0, 12),
    [galleryItems]
  );

  const customerPortalCustomers = useMemo(() => {
    const query = String(customerPortalSearch || "").trim().toLowerCase();
    const list = Array.isArray(customers) ? customers : [];
    if (!query) return list;
    return list.filter((customer) => [customer.company, customer.contactName, customer.customerNumber, customer.email].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [customers, customerPortalSearch]);

  const customerPortalProRows = useMemo(() => {
    const normalize = (value) => String(value || "").trim().toLowerCase();
    const query = normalize(customerPortalSearch);
    return (Array.isArray(customers) ? customers : []).map((customer) => {
      const customerKeys = [customer.id, customer.customerNumber, customer.company, customer.contactName, customer.email]
        .map(normalize)
        .filter(Boolean);
      const matchesCustomer = (value) => {
        const normalized = normalize(value);
        return normalized && customerKeys.some((key) => key === normalized || key.includes(normalized) || normalized.includes(key));
      };
      const customerMissions = (missions || []).filter((mission) =>
        matchesCustomer(mission.customerId || mission.customerNumber || mission.customerName || mission.customer)
      );
      const customerInvoices = (invoices || []).filter((invoice) =>
        matchesCustomer(invoice.customerId || invoice.customerNumber || invoice.customerName || invoice.customer)
      );
      const customerMedia = (galleryItems || []).filter((item) =>
        matchesCustomer(item.customerId || item.customerNumber || item.customerName || item.customer)
      );
      const customerDocuments = (crmDocuments || []).filter((document) =>
        matchesCustomer(document.customerId || document.customerNumber || document.customerName)
      );
      const openInvoices = customerInvoices.filter((invoice) => !/bezahlt|paid/i.test(String(invoice.status || invoice.paymentStatus || "")));
      const openMissions = customerMissions.filter((mission) => !/abgeschlossen|erledigt|completed/i.test(String(mission.status || "")));
      const portalCode = customer.portalCode || customer.customerNumber || customer.id || "";
      const status = portalCode ? "Aktiv" : "Ohne Code";
      const haystack = [customer.company, customer.contactName, customer.customerNumber, customer.email, portalCode, status]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return { customer, portalCode, status, customerMissions, customerInvoices, customerMedia, customerDocuments, openInvoices, openMissions, haystack };
    }).filter((row) => {
      if (customerPortalStatusFilterPro !== "Alle" && row.status !== customerPortalStatusFilterPro) return false;
      if (query && !row.haystack.includes(query)) return false;
      return true;
    });
  }, [customers, missions, invoices, galleryItems, crmDocuments, customerPortalSearch, customerPortalStatusFilterPro]);

  const customerPortalProStats = useMemo(() => {
    const rows = customerPortalProRows || [];
    return {
      total: rows.length,
      active: rows.filter((row) => row.status === "Aktiv").length,
      withoutCode: rows.filter((row) => row.status === "Ohne Code").length,
      openInvoices: rows.reduce((sum, row) => sum + row.openInvoices.length, 0),
      openMissions: rows.reduce((sum, row) => sum + row.openMissions.length, 0),
      documents: rows.reduce((sum, row) => sum + row.customerDocuments.length, 0),
      media: rows.reduce((sum, row) => sum + row.customerMedia.length, 0),
    };
  }, [customerPortalProRows]);

  function exportCustomerPortalProPackage() {
    downloadJsonWorking(`flymonitor-kundenportal-pro-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      module: "Customer Portal",
      stats: customerPortalProStats,
      customers: customerPortalProRows.map(({ customer, portalCode, status, customerMissions, customerInvoices, customerMedia, customerDocuments }) => ({
        customer,
        portalCode,
        status,
        missions: customerMissions,
        invoices: customerInvoices,
        media: customerMedia,
        documents: customerDocuments,
      })),
    });
  }

  const comparisonBefore = useMemo(() => galleryItems.find((item) => String(item.id) === String(compareBeforeId)) || null, [galleryItems, compareBeforeId]);
  const comparisonAfter = useMemo(() => galleryItems.find((item) => String(item.id) === String(compareAfterId)) || null, [galleryItems, compareAfterId]);

  const downloadCenterCustomerOptions = useMemo(() => {
    const values = new Set(["Alle"]);
    (galleryItems || []).forEach((item) => {
      const value = String(item.customerId || item.customerNumber || item.customerName || "").trim();
      if (value) values.add(value);
    });
    (customers || []).forEach((customer) => {
      const value = String(customer.customerNumber || customer.id || customer.company || customer.contactName || "").trim();
      if (value) values.add(value);
    });
    return Array.from(values);
  }, [galleryItems, customers]);

  const downloadCenterProjectOptions = useMemo(() => {
    const values = new Set(["Alle"]);
    (galleryItems || []).forEach((item) => {
      const value = String(item.projectId || item.projectName || item.missionId || "").trim();
      if (value) values.add(value);
    });
    (missions || []).forEach((mission) => {
      const value = String(mission.title || mission.name || mission.id || "").trim();
      if (value) values.add(value);
    });
    return Array.from(values);
  }, [galleryItems, missions]);

  const downloadCenterItems = useMemo(() => {
    const query = String(downloadCenterSearch || "").trim().toLowerCase();
    return (galleryItems || []).filter((item) => {
      const mediaUrl = getGalleryMediaUrl(item);
      if (!mediaUrl) return false;
      const mediaType = getGalleryMediaType(item);
      const customerValue = String(item.customerId || item.customerNumber || item.customerName || "").trim();
      const projectValue = String(item.projectId || item.projectName || item.missionId || "").trim();
      const tags = Array.isArray(item.tags) ? item.tags.join(", ") : String(item.tags || "");
      const haystack = [item.title, item.category, item.subcategory, item.text, item.address, customerValue, projectValue, tags].filter(Boolean).join(" ").toLowerCase();
      if (downloadCenterCategory !== "Alle" && String(item.category || "Allgemein") !== downloadCenterCategory) return false;
      if (downloadCenterCustomer !== "Alle" && customerValue !== downloadCenterCustomer) return false;
      if (downloadCenterProject !== "Alle" && projectValue !== downloadCenterProject) return false;
      if (downloadCenterMediaType !== "Alle" && mediaType !== downloadCenterMediaType) return false;
      if (downloadCenterFavoritesOnly && !Boolean(item.favorite || item.featured)) return false;
      if (query && !haystack.includes(query)) return false;
      return true;
    });
  }, [galleryItems, downloadCenterSearch, downloadCenterCategory, downloadCenterCustomer, downloadCenterProject, downloadCenterMediaType, downloadCenterFavoritesOnly]);

  function downloadJsonWorking(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function downloadBlobWorking(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function createSafeDownloadFilename(value = "flymonitor-download") {
    return String(value || "flymonitor-download").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "flymonitor-download";
  }

  function getGalleryDownloadFilename(item = {}) {
    const mediaUrl = getGalleryMediaUrl(item);
    const extensionMatch = String(mediaUrl || item.imageUrl || item.videoUrl || "").match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
    const extension = extensionMatch?.[1] || (getGalleryMediaType(item) === "video" ? "mp4" : "jpg");
    return `${createSafeDownloadFilename(item.title || item.name || item.id || "medium")}.${extension}`;
  }

  function downloadGalleryMediaWorking(item) {
    const mediaUrl = getGalleryMediaUrl(item);
    if (!mediaUrl) {
      alert("Für dieses Medium ist keine Download-URL vorhanden.");
      return;
    }
    const link = document.createElement("a");
    link.href = mediaUrl;
    link.download = getGalleryDownloadFilename(item);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function exportDownloadPackageWorking(items = downloadCenterItems, label = "Download-Center") {
    const normalizedItems = (items || []).map((item) => ({
      id: item.id,
      title: item.title || item.name || "Medium",
      type: getGalleryMediaType(item),
      url: getGalleryMediaUrl(item),
      filename: getGalleryDownloadFilename(item),
      category: item.category || "Allgemein",
      subcategory: item.subcategory || "",
      customerId: item.customerId || item.customerNumber || item.customerName || "",
      projectId: item.projectId || item.projectName || item.missionId || "",
      tags: Array.isArray(item.tags) ? item.tags : String(item.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      address: item.address || "",
      coordinates: formatGalleryCoordinates(item) || item.coordinates || "",
      favorite: Boolean(item.favorite || item.featured),
    }));

    downloadJsonWorking(`${createSafeDownloadFilename(label)}-${Date.now()}.json`, {
      type: "FlyMonitor Download-Paket",
      createdAt: new Date().toISOString(),
      count: normalizedItems.length,
      filters: {
        search: downloadCenterSearch,
        category: downloadCenterCategory,
        customer: downloadCenterCustomer,
        project: downloadCenterProject,
        mediaType: downloadCenterMediaType,
        favoritesOnly: downloadCenterFavoritesOnly,
      },
      items: normalizedItems,
    });
  }

  function exportGalleryPdfWorking(items = downloadCenterItems, title = "FlyMonitor Galerie-Export") {
    const doc = createPdfDocument({ orientation: "portrait", unit: "mm", format: "a4" });
    const rows = (items || []).slice(0, 120);
    let y = 18;

    doc.setFontSize(18);
    doc.text(title, 14, y);
    y += 8;
    doc.setFontSize(10);
    doc.text(`Erstellt: ${new Date().toLocaleString("de-DE")}`, 14, y);
    y += 8;
    doc.text(`Medien: ${rows.length}`, 14, y);
    y += 10;

    rows.forEach((item, index) => {
      if (y > 270) {
        doc.addPage();
        y = 16;
      }
      const tags = Array.isArray(item.tags) ? item.tags.join(", ") : String(item.tags || "");
      const line1 = `${index + 1}. ${item.title || "Medium"} (${getGalleryMediaType(item) === "video" ? "Video" : "Bild"})`;
      const line2 = `${item.category || "Allgemein"}${item.subcategory ? ` / ${item.subcategory}` : ""}${item.customerId ? ` · Kunde: ${item.customerId}` : ""}${item.projectId ? ` · Projekt: ${item.projectId}` : ""}`;
      const line3 = `${formatGalleryCoordinates(item) || item.coordinates || item.address || "Kein Standort"}${tags ? ` · Tags: ${tags}` : ""}`;
      doc.setFontSize(11);
      doc.text(line1.slice(0, 110), 14, y);
      y += 6;
      doc.setFontSize(9);
      doc.text(line2.slice(0, 130), 14, y);
      y += 5;
      doc.text(line3.slice(0, 130), 14, y);
      y += 7;
    });

    doc.save(`${createSafeDownloadFilename(title)}-${Date.now()}.pdf`);
  }

  function exportDownloadHtmlWorking(items = downloadCenterItems, title = "FlyMonitor Download-Center") {
    const cards = (items || []).map((item) => {
      const mediaUrl = getGalleryMediaUrl(item);
      const mediaType = getGalleryMediaType(item);
      const preview = mediaType === "video"
        ? `<video src="${mediaUrl}" controls style="width:100%;max-height:260px;border-radius:16px;background:#0f172a"></video>`
        : `<img src="${mediaUrl}" alt="" style="width:100%;max-height:260px;object-fit:cover;border-radius:16px">`;
      return `<article class="card"><h2>${item.title || "Medium"}</h2>${mediaUrl ? preview : ""}<p>${item.category || "Allgemein"}${item.subcategory ? ` / ${item.subcategory}` : ""}</p><p>${item.text || ""}</p>${mediaUrl ? `<a href="${mediaUrl}" download>Original herunterladen</a>` : ""}</article>`;
    }).join("\n");
    const html = `<!doctype html><html lang="de"><meta charset="utf-8"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#f8fafc;color:#0f172a;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.card{background:white;border:1px solid #e2e8f0;border-radius:22px;padding:16px;box-shadow:0 12px 30px rgba(15,23,42,.08)}a{font-weight:800;color:#2563eb}</style><body><h1>${title}</h1><p>Erstellt: ${new Date().toLocaleString("de-DE")} · Medien: ${(items || []).length}</p><div class="grid">${cards}</div></body></html>`;
    downloadBlobWorking(`${createSafeDownloadFilename(title)}-${Date.now()}.html`, new Blob([html], { type: "text/html;charset=utf-8" }));
  }

  function createDefaultMissionChecklistWorking() {
    return [
      { id: `check-${Date.now()}-weather`, label: "Wetter, Wind und Sicht geprüft", done: false, group: "Vorbereitung" },
      { id: `check-${Date.now()}-uas`, label: "UAS-Zonen / Genehmigung geprüft", done: false, group: "Vorbereitung" },
      { id: `check-${Date.now()}-battery`, label: "Akkus, Propeller und Speicherkarte geprüft", done: false, group: "Vorbereitung" },
      { id: `check-${Date.now()}-area`, label: "Start-/Landeplatz und Notlandeplatz definiert", done: false, group: "Vorbereitung" },
      { id: `check-${Date.now()}-customer`, label: "Kunde / Ansprechpartner informiert", done: false, group: "Kommunikation" },
      { id: `check-${Date.now()}-media`, label: "Medien nach dem Flug gesichert", done: false, group: "Nachbereitung" },
      { id: `check-${Date.now()}-report`, label: "Bericht / Flugbuch aktualisiert", done: false, group: "Nachbereitung" },
    ];
  }

  function getMissionCustomerWorking(mission = {}) {
    return (Array.isArray(customers) ? customers : []).find((item) =>
      String(item.id || item.customerNumber || item.company || item.contactName) === String(mission.customerId || mission.customerNumber || mission.customerName)
    );
  }

  function getMissionMediaWorking(mission = {}) {
    const missionKeys = [mission.id, mission.title, mission.projectId]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    return (Array.isArray(galleryItems) ? galleryItems : []).filter((item) => {
      const value = String(item.projectId || item.missionId || item.missionTitle || "").trim().toLowerCase();
      return value && missionKeys.includes(value);
    });
  }

  function getMissionFlightsWorking(mission = {}) {
    const missionKeys = [mission.id, mission.title, mission.projectId]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    return [ ...(Array.isArray(completedFlights) ? completedFlights : []), ...(Array.isArray(logbook) ? logbook : []) ]
      .filter((entry) => {
        const haystack = [entry.missionId, entry.projectId, entry.missionTitle, entry.registrationNumber, entry.flightArea, entry.city]
          .map((value) => String(value || "").trim().toLowerCase());
        return missionKeys.some((key) => haystack.includes(key));
      });
  }

  const filteredMissions = (Array.isArray(missions) ? missions : []).filter((mission) => {
    const statusOk = missionStatusFilter === "Alle" || String(mission.status || "Geplant") === missionStatusFilter;
    const query = String(missionSearch || "").trim().toLowerCase();
    if (!statusOk) return false;
    if (!query) return true;
    return [mission.title, mission.customerName, mission.pilot, mission.drone, mission.location, mission.address, mission.status, mission.notes]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  function addMissionWorking() {
    const title = String(missionDraft.title || "").trim();
    if (!title) {
      alert("Bitte einen Missionstitel eintragen.");
      return;
    }
    const customer = (Array.isArray(customers) ? customers : []).find((item) => String(item.id) === String(missionDraft.customerId));
    const point = parseGalleryCoordinates(missionDraft);
    const item = {
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...missionDraft,
      title,
      lat: point?.lat ?? missionDraft.lat ?? "",
      lon: point?.lon ?? missionDraft.lon ?? "",
      customerName: customer?.company || customer?.contactName || "Ohne Kunde",
      checklist: createDefaultMissionChecklistWorking(),
      mediaIds: [],
      flightIds: [],
      createdAt: new Date().toLocaleString("de-DE"),
      updatedAt: new Date().toLocaleString("de-DE"),
    };
    setMissions([item, ...(Array.isArray(missions) ? missions : [])].slice(0, 300));
    setMissionDraft({ title: "", customerId: "", projectId: "", pilot: "Robert Bajela", spotter: "", cameraOperator: "", drone: "DJI Air 3 S", date: "", startTime: "", endTime: "", location: "", address: "", coordinates: "", lat: "", lon: "", status: "Geplant", priority: "Normal", notes: "" });
  }

  function updateMissionWorking(id, patch = {}) {
    setMissions((current) => (Array.isArray(current) ? current : []).map((mission) =>
      mission.id === id ? { ...mission, ...patch, updatedAt: new Date().toLocaleString("de-DE") } : mission
    ));
  }

  function toggleMissionChecklistWorking(missionId, checklistId) {
    setMissions((current) => (Array.isArray(current) ? current : []).map((mission) => {
      if (mission.id !== missionId) return mission;
      const checklist = (Array.isArray(mission.checklist) ? mission.checklist : createDefaultMissionChecklistWorking()).map((item) =>
        item.id === checklistId ? { ...item, done: !item.done } : item
      );
      return { ...mission, checklist, updatedAt: new Date().toLocaleString("de-DE") };
    }));
  }

  function addMissionChecklistItemWorking(missionId) {
    const label = window.prompt("Neuer Checklistenpunkt:");
    if (!String(label || "").trim()) return;
    setMissions((current) => (Array.isArray(current) ? current : []).map((mission) => {
      if (mission.id !== missionId) return mission;
      const checklist = Array.isArray(mission.checklist) ? mission.checklist : [];
      return {
        ...mission,
        checklist: [...checklist, { id: `check-${Date.now()}-${Math.random().toString(36).slice(2)}`, label: String(label).trim(), done: false, group: "Manuell" }],
        updatedAt: new Date().toLocaleString("de-DE"),
      };
    }));
  }

  function exportMissionJsonWorking(mission) {
    if (!mission) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      mission,
      customer: getMissionCustomerWorking(mission) || null,
      media: getMissionMediaWorking(mission),
      flights: getMissionFlightsWorking(mission),
      weather: (Array.isArray(weatherHistory) ? weatherHistory : []).filter((entry) => String(entry.missionId || entry.projectId || "") === String(mission.id || mission.title)),
    };
    downloadBlobWorking(`mission-${createSafeDownloadFilename(mission.title || mission.id)}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }));
  }

  function exportMissionPdfWorking(mission) {
    if (!mission) return;
    const doc = createPdfDocument({ unit: "mm", format: "a4" });
    const media = getMissionMediaWorking(mission);
    const flights = getMissionFlightsWorking(mission);
    const checklist = Array.isArray(mission.checklist) ? mission.checklist : [];
    let y = 16;
    doc.setFontSize(18);
    doc.text("FlyMonitor Missionsbericht", 14, y);
    y += 10;
    doc.setFontSize(12);
    [
      `Mission: ${mission.title || "-"}`,
      `Kunde: ${mission.customerName || "Ohne Kunde"}`,
      `Status: ${mission.status || "Geplant"}`,
      `Datum: ${mission.date || "-"} ${mission.startTime || ""}${mission.endTime ? ` - ${mission.endTime}` : ""}`,
      `Pilot: ${mission.pilot || "-"} · Drohne: ${mission.drone || "-"}`,
      `Ort: ${mission.location || mission.address || "-"}`,
      `Koordinaten: ${mission.coordinates || formatGalleryCoordinates(mission) || "-"}`,
    ].forEach((line) => { doc.text(String(line).slice(0, 110), 14, y); y += 7; });
    y += 2;
    doc.setFontSize(14); doc.text("Checkliste", 14, y); y += 7; doc.setFontSize(10);
    checklist.slice(0, 18).forEach((item) => { doc.text(`${item.done ? "[x]" : "[ ]"} ${item.label}`.slice(0, 115), 16, y); y += 5; });
    y += 3;
    doc.setFontSize(14); doc.text("Verknüpfungen", 14, y); y += 7; doc.setFontSize(10);
    doc.text(`Medien: ${media.length} · Flüge: ${flights.length}`, 16, y); y += 7;
    if (mission.notes) { doc.setFontSize(14); doc.text("Notizen", 14, y); y += 7; doc.setFontSize(10); doc.text(doc.splitTextToSize(String(mission.notes), 180), 16, y); }
    doc.save(`missionsbericht-${createSafeDownloadFilename(mission.title || mission.id)}.pdf`);
  }

  function createInvoiceFromCompletedFlightWorking(entry) {
    if (!entry) return;
    const invoice = {
      id: `RE-${Date.now()}`,
      offerId: "",
      customerId: "",
      customerName: entry.contactName || entry.company || entry.pilot || "Flugkunde",
      title: `Drohnenflug ${entry.registrationNumber || entry.date || ""}`.trim(),
      items: [{ description: `Drohnenflug ${entry.flightArea || entry.city || ""}`.trim(), qty: 1, price: 0 }],
      amount: 0,
      status: "Offen",
      createdAt: new Date().toLocaleString("de-DE"),
      sourceFlightId: getCompletedFlightKey(entry),
    };
    setInvoices([invoice, ...(Array.isArray(invoices) ? invoices : [])].slice(0, 300));
    alert(`Rechnung ${invoice.id} wurde aus dem abgeschlossenen Flug erstellt.`);
  }

  function captureWeatherSnapshotWorking(entry = null) {
    const sourceEntry = entry || selectedCompletedFlightEntry || flightReportForm;
    const snapshot = {
      id: `weather-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      registrationNumber: sourceEntry?.registrationNumber || "",
      date: sourceEntry?.date || new Date().toISOString().slice(0, 10),
      location: sourceEntry?.flightArea || sourceEntry?.city || demo.city,
      temperature: sourceEntry?.actualTemperature || sourceEntry?.temperature || demo.temp,
      wind: sourceEntry?.actualWind || sourceEntry?.wind || demo.wind,
      gusts: sourceEntry?.actualGusts || sourceEntry?.gusts || demo.gusts,
      rain: sourceEntry?.rain || demo.rain,
      visibility: sourceEntry?.visibility || demo.visibility,
      createdAt: new Date().toLocaleString("de-DE"),
    };
    setWeatherHistory([snapshot, ...(Array.isArray(weatherHistory) ? weatherHistory : [])].slice(0, 500));
    alert("Wetterhistorie wurde gespeichert.");
  }

  function createBackupJobWorking(type = "Manuell") {
    const item = {
      id: `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      status: "geplant",
      createdAt: new Date().toLocaleString("de-DE"),
      note: "Backup-Auftrag in der App-Historie erfasst. Server-Backup über /api/backup.php ausführen.",
    };
    setBackupJobs([item, ...(Array.isArray(backupJobs) ? backupJobs : [])].slice(0, 100));
  }


  function resetCloudSyncTargetDraftPro() {
    setEditingCloudSyncTargetId(null);
    setCloudSyncTargetDraft(createEmptyCloudSyncTargetPro());
  }

  function updateCloudSyncTargetScopePro(scope, checked) {
    setCloudSyncTargetDraft((current) => {
      const scopes = new Set(Array.isArray(current.scopes) ? current.scopes : []);
      if (checked) scopes.add(scope);
      else scopes.delete(scope);
      return { ...current, scopes: Array.from(scopes) };
    });
  }

  function saveCloudSyncTargetPro() {
    const name = String(cloudSyncTargetDraft.name || cloudSyncTargetDraft.type || "").trim();
    if (!name) {
      alert("Bitte einen Namen für das Cloud-Ziel eintragen.");
      return;
    }

    const id = editingCloudSyncTargetId || cloudSyncTargetDraft.id || `cloud-target-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const target = normalizeCloudSyncTargetPro({
      ...cloudSyncTargetDraft,
      id,
      name,
      updatedAt: new Date().toLocaleString("de-DE"),
      createdAt: cloudSyncTargetDraft.createdAt || new Date().toLocaleString("de-DE"),
    });

    setCloudSyncTargetsPro((current) => {
      const list = Array.isArray(current) ? current : [];
      const exists = list.some((item) => String(item.id) === String(id));
      return exists ? list.map((item) => String(item.id) === String(id) ? target : item) : [target, ...list];
    });
    writeAuditLog(editingCloudSyncTargetId ? "cloud_sync_target_updated" : "cloud_sync_target_created", { id, name: target.name, type: target.type });
    resetCloudSyncTargetDraftPro();
  }

  function editCloudSyncTargetPro(target) {
    setEditingCloudSyncTargetId(target.id);
    setCloudSyncTargetDraft(normalizeCloudSyncTargetPro(target));
  }

  function deleteCloudSyncTargetPro(id) {
    if (!window.confirm("Cloud-Sync-Ziel wirklich löschen?")) return;
    setCloudSyncTargetsPro((current) => (Array.isArray(current) ? current : []).filter((target) => String(target.id) !== String(id)));
    writeAuditLog("cloud_sync_target_deleted", { id });
  }

  function buildCloudSyncPayloadPro() {
    return {
      exportedAt: new Date().toLocaleString("de-DE"),
      version: "Cloud Sync Pro",
      targets: cloudSyncTargetsPro,
      logs: cloudSyncLogsPro,
      data: {
        customers,
        offers,
        invoices,
        galleryItems,
        galleryManagedCategories,
        missions,
        weatherHistory,
        completedFlights,
        authorityDocumentsPro,
        rolePermissionMatrix,
        localAccessUsers,
        backupJobs,
      },
    };
  }

  function runCloudSyncTargetPro(target) {
    const normalized = normalizeCloudSyncTargetPro(target);
    const payload = buildCloudSyncPayloadPro();
    const log = createCloudSyncLogEntryPro(
      normalized,
      "Erfolgreich vorgemerkt",
      `${normalized.scopes.length} Bereich(e) für ${normalized.type} vorbereitet. Echte Übertragung benötigt serverseitige Cloud-API.`
    );

    setCloudSyncLogsPro((current) => [log, ...(Array.isArray(current) ? current : [])].slice(0, 300));
    setCloudSyncTargetsPro((current) => (Array.isArray(current) ? current : []).map((item) =>
      String(item.id) === String(normalized.id)
        ? { ...item, lastSyncAt: log.createdAt, status: "Vorgemerkt", updatedAt: log.createdAt }
        : item
    ));
    createBackupJobWorking(`Cloud Sync ${normalized.type}`);
    downloadJsonWorking(`flymonitor-cloud-sync-${normalized.type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}.json`, payload);
    writeAuditLog("cloud_sync_export_created", { targetId: normalized.id, targetName: normalized.name, type: normalized.type });
  }

  function exportCloudSyncSettingsPro() {
    downloadJsonWorking(`flymonitor-cloud-sync-konfiguration-${Date.now()}.json`, {
      exportedAt: new Date().toLocaleString("de-DE"),
      targets: cloudSyncTargetsPro,
      logs: cloudSyncLogsPro,
    });
  }

  function resetMobileMissionDraftPro() {
    setEditingMobileMissionIdPro(null);
    setMobileMissionDraftPro(createEmptyMobileMissionPro());
  }

  function saveMobileMissionPro() {
    const title = String(mobileMissionDraftPro.title || "").trim();
    if (!title) {
      alert("Bitte einen Titel für die mobile Mission eintragen.");
      return;
    }

    const id = editingMobileMissionIdPro || mobileMissionDraftPro.id || `mobile-mission-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mission = normalizeMobileMissionPro({
      ...mobileMissionDraftPro,
      id,
      title,
      updatedAt: new Date().toLocaleString("de-DE"),
      createdAt: mobileMissionDraftPro.createdAt || new Date().toLocaleString("de-DE"),
    });

    setMobileMissionsPro((current) => {
      const list = Array.isArray(current) ? current : [];
      const exists = list.some((item) => String(item.id) === String(id));
      return exists ? list.map((item) => String(item.id) === String(id) ? mission : item) : [mission, ...list];
    });
    writeAuditLog(editingMobileMissionIdPro ? "mobile_mission_updated" : "mobile_mission_created", { id, title: mission.title, status: mission.status });
    resetMobileMissionDraftPro();
  }

  function editMobileMissionPro(mission) {
    setEditingMobileMissionIdPro(mission.id);
    setMobileMissionDraftPro(normalizeMobileMissionPro(mission));
  }

  function deleteMobileMissionPro(id) {
    if (!window.confirm("Mobile Mission wirklich löschen?")) return;
    setMobileMissionsPro((current) => (Array.isArray(current) ? current : []).filter((mission) => String(mission.id) !== String(id)));
    writeAuditLog("mobile_mission_deleted", { id });
  }

  function toggleMobileChecklistItemPro(listKey, index) {
    setMobileMissionDraftPro((current) => {
      const list = Array.isArray(current[listKey]) ? current[listKey] : [];
      return {
        ...current,
        [listKey]: list.map((item, itemIndex) => itemIndex === index ? { ...item, done: !item.done } : item),
      };
    });
  }

  function useCurrentPositionForMobileMissionPro() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      alert("GPS ist in diesem Browser nicht verfügbar.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = Number(position.coords.latitude).toFixed(7);
        const lon = Number(position.coords.longitude).toFixed(7);
        setMobileMissionDraftPro((current) => ({
          ...current,
          lat,
          lon,
          coordinates: `${lat}, ${lon}`,
          address: current.address || "GPS-Standort vom Mobilgerät",
        }));
        writeAuditLog("mobile_gps_position_captured", { lat, lon });
      },
      (error) => {
        alert(`GPS konnte nicht gelesen werden: ${error.message || error}`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function markMobileMissionSyncedPro(id) {
    setMobileMissionsPro((current) => (Array.isArray(current) ? current : []).map((mission) =>
      String(mission.id) === String(id)
        ? { ...mission, synced: true, updatedAt: new Date().toLocaleString("de-DE") }
        : mission
    ));
    writeAuditLog("mobile_mission_marked_synced", { id });
  }

  function exportPwaMobilePackagePro() {
    const manifest = {
      name: mobilePwaSettingsPro.appName || "FlyMonitor Mobile",
      short_name: "FlyMonitor",
      start_url: "/",
      display: "standalone",
      background_color: "#021B33",
      theme_color: "#00B2E2",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    };

    downloadJsonWorking(`flymonitor-pwa-mobile-konfiguration-${Date.now()}.json`, {
      exportedAt: new Date().toLocaleString("de-DE"),
      manifest,
      settings: mobilePwaSettingsPro,
      mobileMissions: mobileMissionsPro,
      offlineScopes: mobilePwaSettingsPro.cacheScopes || PWA_MOBILE_CACHE_SCOPES_PRO,
      notificationTypes: mobilePwaSettingsPro.notificationTypes || PWA_MOBILE_NOTIFICATION_TYPES_PRO,
    });
    writeAuditLog("pwa_mobile_package_exported", { missions: mobileMissionsPro.length });
  }

  function ensureRegistrationNumber(data = flightReportForm) {
    const current = String(data.registrationNumber || "").trim();
    if (current) return current;

    return createUniqueRegistrationNumber(logbook);
  }

  function openNewFlightRegistrationWorking() {
    const generatedRegistrationNumber = createUniqueRegistrationNumber(logbook);

    setEditingLogId(null);
    setEditLogEntry({});
    setFlightReportForm({
      ...emptyFlightReport,
      registrationNumber: generatedRegistrationNumber,
      date: new Date().toISOString().slice(0, 10),
      safetyMeasures: DEFAULT_SAFETY_MEASURES,
      legalConfirmationText: LEGAL_CONFIRMATION_TEXT,
      legalConfirm: false,
    });

    setActivePage("registrationForm");
    if (typeof window !== "undefined") {
      window.location.hash = "fluganmeldung";
      setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
    }
  }


  async function loadAircraft(lat, lon) {
    try {
      const lamin = Number(lat) - 1.4;
      const lamax = Number(lat) + 1.4;
      const lomin = Number(lon) - 2.0;
      const lomax = Number(lon) + 2.0;
      const response = await fetch(`/api/opensky.php?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`);
      if (!response.ok) throw new Error(`OpenSky HTTP ${response.status}`);
      const data = await response.json();
      const planes = (data.states || [])
        .filter((s) => s[5] !== null && s[6] !== null)
        .slice(0, 80)
        .map((s, index) => ({
          id: s[0] || `opensky-${index}`,
          name: (s[1] || "UNKNOWN").trim(),
          lon: Number(s[5]),
          lat: Number(s[6]),
          alt: Math.round(s[7] || 0),
          speed: Math.round((s[9] || 0) * 3.6),
          heading: Math.round(s[10] || 0),
          country: s[2] || "",
        }));
      setAircraft(planes);
      return planes.length ? `OpenSky Live: ${planes.length} Flugzeuge` : "OpenSky Live: keine Flugzeuge im Bereich";
    } catch (error) {
      console.warn("OpenSky konnte nicht geladen werden:", error);
      setAircraft([]);
      return "OpenSky aktuell nicht erreichbar";
    }
  }

  useEffect(() => {
    loadAircraft(result.lat, result.lon).then(setSource);
    const interval = setInterval(() => loadAircraft(result.lat, result.lon).then(setSource), 120000);
    return () => clearInterval(interval);
  }, [result.lat, result.lon]);

  async function loadAirQuality(lat, lon) {
    try {
      const data = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=uv_index,pm10,pm2_5`).then((r) => r.json());
      const c = data.current || {};
      const pm10 = Math.round(c.pm10 || 0);
      const pm25 = Math.round(c.pm2_5 || 0);
      const uv = Math.round(c.uv_index || 0);
      let quality = "Gut";
      if (pm25 > 25 || pm10 > 50) quality = "Mäßig";
      if (pm25 > 50 || pm10 > 100) quality = "Schlecht";
      setUvIndex(uv);
      setAirQuality({ pm10, pm25, quality });
      return "Air Quality Live";
    } catch {
      return "Air Quality nicht erreichbar";
    }
  }


  function triggerWeatherWarningIfNeeded(weatherResult) {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("flymonitor_weather_notifications") !== "1") return;

    const wind = Number(weatherResult?.wind || 0);
    const gusts = Number(weatherResult?.gusts || 0);
    const rain = Number(weatherResult?.rain || 0);
    const visibility = Number(weatherResult?.visibility || 99);

    const warnings = [];
    if (wind >= 25) warnings.push(`Wind ${wind} km/h`);
    if (gusts >= 40) warnings.push(`Böen ${gusts} km/h`);
    if (rain >= 50) warnings.push(`Regenrisiko ${rain} %`);
    if (visibility < 4) warnings.push(`Sichtweite ${visibility} km`);

    if (!warnings.length) return;

    const cooldownKey = "flymonitor_weather_warning_last";
    const lastWarningAt = Number(localStorage.getItem(cooldownKey) || 0);
    const cooldownMs = 30 * 60 * 1000;

    if (Date.now() - lastWarningAt < cooldownMs) {
      console.info("FlyMonitor Wetterwarnung unterdrückt: 30-Minuten-Sperre aktiv.", warnings);
      return;
    }

    localStorage.setItem(cooldownKey, String(Date.now()));
    console.warn("FlyMonitor Wetterwarnung ausgelöst:", warnings);

    const title = "⚠ FlyMonitor Wetterwarnung";
    const body = `${weatherResult?.city || "Standort"}: ${warnings.join(", ")}`;

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, {
        body,
        icon: "/logo_neu.png",
      });
    } else {
      alert(`${title}\n${body}`);
    }
  }

  async function checkWeather(value = query) {
    try {
      setLoading(true);
      setSource("lade Live-Daten...");
      const place = await geocodeSearchValue(value);
      if (!place) {
        setSource("Ort oder Adresse nicht gefunden");
        return;
      }
      const weather = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,relative_humidity_2m,precipitation&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,cloud_cover,visibility&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=auto&forecast_days=14`
      ).then((r) => r.json());
      const c = weather.current || {};
      const wind = Math.round(c.wind_speed_10m || 0);
      const gusts = Math.round(c.wind_gusts_10m || wind);
      const temp = Math.round(c.temperature_2m || 0);
      const cloud = Math.round(c.cloud_cover || 0);
      const hum = Math.round(c.relative_humidity_2m || 60);
      const rain = c.precipitation > 0 ? 60 : Math.min(45, Math.round(cloud / 2));
      const vis = weather.hourly?.visibility?.[0] ? Math.round(weather.hourly.visibility[0] / 1000) : 10;
      const [status, summary, note] = rec(wind, gusts, rain, vis);
      const dirs = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
      const hourlyByDay = {};
      (weather.hourly?.time || []).forEach((time, index) => {
        const dayKey = String(time).slice(0, 10);
        if (!hourlyByDay[dayKey]) hourlyByDay[dayKey] = [];

        hourlyByDay[dayKey].push({
          time,
          hour: String(time).slice(11, 16),
          temp: Math.round(weather.hourly?.temperature_2m?.[index] ?? 0),
          rain: Math.round(weather.hourly?.precipitation_probability?.[index] ?? 0),
          precipitation: Number(weather.hourly?.precipitation?.[index] ?? 0),
          wind: Math.round(weather.hourly?.wind_speed_10m?.[index] ?? 0),
          gusts: Math.round(weather.hourly?.wind_gusts_10m?.[index] ?? 0),
          cloud: Math.round(weather.hourly?.cloud_cover?.[index] ?? 0),
          visibility: weather.hourly?.visibility?.[index]
            ? Math.round(weather.hourly.visibility[index] / 1000)
            : null,
        });
      });

      const forecast = (weather.daily?.time || []).slice(0, 14).map((d, i) => ({
        day: d,
        max: Math.round(weather.daily.temperature_2m_max?.[i] || 0),
        min: Math.round(weather.daily.temperature_2m_min?.[i] || 0),
        rain: Math.round(weather.daily.precipitation_probability_max?.[i] || 0),
        sunrise: weather.daily?.sunrise?.[i]?.slice(11, 16) || "",
        sunset: weather.daily?.sunset?.[i]?.slice(11, 16) || "",
        hourly: hourlyByDay[d] || [],
      }));
      const nextWeatherResult = {
        city: place.name,
        lat: place.latitude,
        lon: place.longitude,
        status,
        summary,
        wind,
        gusts,
        temp,
        dew: Math.round(temp - (100 - hum) / 5),
        rain,
        cloud,
        visibility: vis,
        kp: 2,
        direction: dirs[Math.round(((c.wind_direction_10m || 0) % 360) / 45) % 8],
        sunrise: weather.daily?.sunrise?.[0]?.slice(11, 16) || "05:30",
        sunset: weather.daily?.sunset?.[0]?.slice(11, 16) || "21:00",
        note,
        forecast,
      };

      setResult(nextWeatherResult);
      triggerWeatherWarningIfNeeded(nextWeatherResult);
      setSelectedForecastDay(forecast[0] || null);
      const os = await loadAircraft(place.latitude, place.longitude);
      const aq = await loadAirQuality(place.latitude, place.longitude);
      setSource(`${place.source || "Geocoding"} + Open-Meteo + ${os} + ${aq}`);
    } catch (error) {
      console.error(error);
      setSource("Live-Daten nicht erreichbar");
    } finally {
      setLoading(false);
    }
  }

  function useGps() {
    if (!navigator.geolocation) return setSource("GPS nicht verfügbar");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setResult({ ...demo, city: "Aktueller Standort", lat, lon, summary: "GPS aktiv", note: "GPS erkannt." });
        loadAircraft(lat, lon).then(setSource);
      },
      () => setSource("GPS abgelehnt")
    );
  }

  function installPwaWorking() {
    alert("Android: Chrome-Menü ⋮ → App installieren. iPhone: Safari → Teilen → Zum Home-Bildschirm.");
  }

  async function unlockAdminWorking() {
    const password = String(adminPasswordInput || "").trim();
    if (!password) return false;

    setAdminNotice("Admin-Login wird geprüft...");
    const result = await postAdminAction("login", { password });

    const demoLoginAllowed =
      !result.ok &&
      FRONTEND_DEMO_ADMIN_PASSWORD &&
      password === FRONTEND_DEMO_ADMIN_PASSWORD;

    if (result.ok || demoLoginAllowed) {
      const session = saveAdminSession({
        role: result.role || "admin",
        email: result.email || "",
      });
      setAdminUnlocked(true);
      setPublicPreviewMode(false);
      setActivePage("home");
      setAdminCenterTab("overview");
      setAdminRole(session.role);
      window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 80);
      setAdminPasswordInput("");
      setAdminNotice(demoLoginAllowed ? "Demo-Admin aktiv. Produktiv bitte PHP-Login verwenden." : "Admin-Session aktiv.");
      writeAuditLog("admin_login", { role: session.role, mode: demoLoginAllowed ? "frontend-demo" : "server" });
      return true;
    }

    setAdminNotice(result.offline ? "Login-API nicht erreichbar." : "Falsches Passwort oder keine Admin-Rechte.");
    alert(result.offline ? "Login-API nicht erreichbar. Bitte /api/admin-auth.php installieren." : "Falsches Passwort.");
    return false;
  }

  function lockAdminWorking() {
    writeAuditLog("admin_logout", { role: adminRole });
    setAdminUnlocked(false);
    setAdminRole("gast");
    setAdminPasswordInput("");
    setAdminNotice("");
    clearAdminSession();
    setEditingLogId(null);
    setEditLogEntry({});
  }

  async function loadAuditLogWorking() {
    const localItems = safeLoad("flymonitor_audit_log", []);
    const result = await apiGetJson(AUDIT_LOG_API);
    if (result?.ok && Array.isArray(result.items)) {
      setAuditLog(result.items);
      return;
    }
    setAuditLog(localItems);
  }

  async function runBackupWorking() {
    setBackupNotice("Backup wird erstellt...");
    const result = await apiPostJson(BACKUP_API, { action: "create" });
    if (result?.ok) {
      setBackupNotice(`Backup erstellt: ${result.file || result.filename || "fertig"}`);
      writeAuditLog("backup_created", { file: result.file || result.filename || "server" });
      loadAuditLogWorking();
      return;
    }
    setBackupNotice(result?.error ? `Backup fehlgeschlagen: ${result.error}` : "Backup-API nicht erreichbar.");
  }

  async function loadUsersWorking() {
    const result = await apiGetJson(USERS_API);
    if (result?.ok && Array.isArray(result.users)) {
      setServerUsers(result.users);
    }
  }

  async function createUserWorking() {
    if (!newUserForm.email || !newUserForm.password) {
      alert("Bitte E-Mail und Passwort eintragen.");
      return;
    }
    const result = await apiPostJson(USERS_API, { action: "create", ...newUserForm });
    if (!result?.ok) {
      alert(result?.error || "Benutzer konnte nicht erstellt werden.");
      return;
    }
    setNewUserForm({ name: "", email: "", role: "pilot", password: "" });
    writeAuditLog("user_created", { email: newUserForm.email, role: newUserForm.role });
    loadUsersWorking();
    loadAuditLogWorking();
  }

  async function updateUserRoleWorking(id, role) {
    const result = await apiPostJson(USERS_API, { action: "update_role", id, role });
    if (!result?.ok) return alert(result?.error || "Rolle konnte nicht geändert werden.");
    loadUsersWorking();
    loadAuditLogWorking();
  }

  async function toggleUserActiveWorking(id, active) {
    const result = await apiPostJson(USERS_API, { action: "set_active", id, active });
    if (!result?.ok) return alert(result?.error || "Benutzerstatus konnte nicht geändert werden.");
    loadUsersWorking();
    loadAuditLogWorking();
  }

  async function saveDesignSettingsWorking() {
    const settings = { activeTemplate, customTheme, templateColorOverrides, dark };
    localStorage.setItem("flymonitor_design_settings", JSON.stringify(settings));
    const result = await apiPostJson(DESIGN_SETTINGS_API, { action: "save", settings });
    writeAuditLog("design_settings_saved", { activeTemplate });
    if (result?.ok || result?.offline) {
      alert(result?.ok ? "Design wurde gespeichert." : "Design lokal gespeichert. Server-API ist nicht erreichbar.");
    } else {
      alert(result?.error || "Design konnte nicht gespeichert werden.");
    }
    loadAuditLogWorking();
  }

  function exportCompletedFlightsCsvWorking() {
    const rows = completedFlights.map((entry) => ({
      Vorgangsnummer: entry.registrationNumber || "",
      Datum: entry.date || "",
      Start: entry.startTime || "",
      Ende: entry.endTime || "",
      Ort: entry.city || entry.flightArea || "",
      Pilot: entry.pilot || "",
      Drohne: entry.drone || "",
      Zweck: entry.purpose || "",
    }));
    const header = Object.keys(rows[0] || { Vorgangsnummer: "", Datum: "", Start: "", Ende: "", Ort: "", Pilot: "", Drohne: "", Zweck: "" });
    const csv = [
  header.join(";"),
  ...rows.map((row) =>
    header
      .map((key) => `"${String(row[key] || "").replace(/"/g, '""')}"`)
      .join(";")
  ),
].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flymonitor-erfolgte-fluege-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    writeAuditLog("completed_flights_csv_export", { count: rows.length });
  }

  function restoreDefaultEmailRecipientsWorking() {
    const existingById = new Map(savedEmailRecipients.map((recipient) => [recipient.id, recipient]));
    const merged = [
      ...DEFAULT_EMAIL_RECIPIENTS.map((recipient) => existingById.get(recipient.id) || recipient),
      ...savedEmailRecipients.filter((recipient) => !DEFAULT_EMAIL_RECIPIENTS.some((item) => item.id === recipient.id)),
    ];

    setSavedEmailRecipients(merged);
    localStorage.setItem("droneready_email_recipients", JSON.stringify(merged));
    alert("Schleswig-Holstein Behörden wurden als gespeicherte Empfänger geladen.");
  }

  function saveCurrentLocationWorking() {
    const item = { city: result.city || query || "Unbekannt", lat: result.lat, lon: result.lon, savedAt: new Date().toLocaleString("de-DE") };
    const next = [item, ...savedPlaces.filter((place) => place.city !== item.city)].slice(0, 10);
    setSavedPlaces(next);
    localStorage.setItem("droneready_places", JSON.stringify(next));
    alert("Ort wurde lokal gespeichert.");
  }

  function saveMapPickAsFavoriteWorking() {
    if (!mapPick?.coordinates) {
      alert("Bitte zuerst einen Punkt auf der Karte setzen.");
      return;
    }

    const item = {
      id: Date.now(),
      coordinates: mapPick.coordinates,
      address: mapPick.address || mapPick.coordinates,
      lat: mapPick.lat,
      lon: mapPick.lon,
      savedAt: new Date().toLocaleString("de-DE"),
    };

    const next = [
      item,
      ...mapFavoritePlaces.filter((place) => place.coordinates !== item.coordinates),
    ].slice(0, 30);

    setMapFavoritePlaces(next);
    localStorage.setItem("droneready_map_favorites", JSON.stringify(next));
    alert("Kartenpunkt wurde als Favorit gespeichert.");
  }

  function useMapFavoriteWorking(place) {
    const picked = {
      lat: Number(place.lat),
      lon: Number(place.lon),
      coordinates: place.coordinates,
      address: place.address || place.coordinates,
    };

    setMapPick(picked);
    setFlightReportForm((prev) => applyMapFavoritesToFlightData(prev, [place]));
  }

  function deleteMapFavoriteWorking(id) {
    const next = mapFavoritePlaces.filter((place) => place.id !== id);
    setMapFavoritePlaces(next);
    localStorage.setItem("droneready_map_favorites", JSON.stringify(next));
  }


  function startEditMapFavoriteWorking(place) {
    if (!adminUnlocked) {
      alert("Bearbeiten ist nur nach Admin-Login möglich.");
      return;
    }

    setEditingFavoriteId(place.id);
    setEditFavorite({
      name: place.name || "",
      address: place.address || "",
    });
  }

  function saveEditedMapFavoriteWorking(placeId) {
    if (!adminUnlocked) {
      alert("Bearbeiten ist nur nach Admin-Login möglich.");
      return;
    }

    const next = mapFavoritePlaces.map((place) =>
      place.id === placeId
        ? {
            ...place,
            name: String(editFavorite.name || "").trim(),
            address: String(editFavorite.address || "").trim(),
            updatedAt: new Date().toLocaleString("de-DE"),
          }
        : place
    );

    setMapFavoritePlaces(next);
    localStorage.setItem("droneready_map_favorites", JSON.stringify(next));
    setEditingFavoriteId(null);
    setEditFavorite({ name: "", address: "" });
    alert("Favorit wurde aktualisiert.");
  }

  function normalizeLocationFromForm(form) {
    const coordinates = String(form.coordinates || "").trim();
    const [latFromCoordinates, lonFromCoordinates] = coordinates
      .split(",")
      .map((value) => Number(String(value || "").trim()));

    const lat = Number(form.lat || latFromCoordinates);
    const lon = Number(form.lon || lonFromCoordinates);

    return {
      category: String(form.category || "Allgemein").trim() || "Allgemein",
      name: String(form.name || "").trim(),
      address: String(form.address || "").trim(),
      coordinates: coordinates || (Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(7)}, ${lon.toFixed(7)}` : ""),
      lat,
      lon,
      note: String(form.note || "").trim(),
    };
  }

  function addDroneLocationWorking() {
    if (!adminUnlocked) {
      alert("Diese Funktion ist nur nach Admin-Login verfügbar.");
      return;
    }

    const location = normalizeLocationFromForm(newDroneLocation);

    if (!location.name || !location.address || !location.coordinates || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
      alert("Bitte Name, Adresse, Koordinaten sowie gültige Lat/Lon-Werte eintragen.");
      return;
    }

    const item = {
      ...location,
      id: `loc-${Date.now()}`,
    };

    const next = [item, ...droneLocations].slice(0, 200);
    setDroneLocations(next);
    localStorage.setItem("droneready_drone_locations", JSON.stringify(next));
    setNewDroneLocation({ category: "Allgemein", name: "", address: "", coordinates: "", lat: "", lon: "", note: "" });
  }

  function startEditDroneLocationWorking(location) {
    if (!adminUnlocked) return;
    setEditingLocationId(location.id);
    setEditDroneLocation({
      category: location.category || "Allgemein",
      name: location.name || "",
      address: location.address || "",
      coordinates: location.coordinates || "",
      lat: String(location.lat || ""),
      lon: String(location.lon || ""),
      note: location.note || "",
    });
  }

  function saveEditedDroneLocationWorking() {
    if (!adminUnlocked) {
      alert("Diese Funktion ist nur nach Admin-Login verfügbar.");
      return;
    }

    const location = normalizeLocationFromForm(editDroneLocation);

    if (!location.name || !location.address || !location.coordinates || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
      alert("Bitte Name, Adresse, Koordinaten sowie gültige Lat/Lon-Werte eintragen.");
      return;
    }

    const next = droneLocations.map((item) =>
      item.id === editingLocationId ? { ...item, ...location } : item
    );

    setDroneLocations(next);
    localStorage.setItem("droneready_drone_locations", JSON.stringify(next));
    setEditingLocationId(null);
    setEditDroneLocation({ category: "", name: "", address: "", coordinates: "", lat: "", lon: "", note: "" });
  }

  function deleteDroneLocationWorking(id) {
    if (!adminUnlocked) {
      alert("Diese Funktion ist nur nach Admin-Login verfügbar.");
      return;
    }

    if (!window.confirm("Location wirklich löschen?")) return;

    const next = droneLocations.filter((item) => item.id !== id);
    setDroneLocations(next);
    localStorage.setItem("droneready_drone_locations", JSON.stringify(next));
  }


  function mergeWeeklySchleswigHolsteinLocations(currentLocations = []) {
    const byId = new Map((currentLocations || []).map((location) => [location.id, location]));

    WEEKLY_SH_LOCATION_UPDATES.forEach((location) => {
      byId.set(location.id, {
        ...location,
        updatedAt: new Date().toLocaleString("de-DE"),
        source: "Automatische Wochenaktualisierung Schleswig-Holstein",
      });
    });

    return Array.from(byId.values()).slice(0, 250);
  }

  function runWeeklyLocationUpdateWorking(force = false) {
    const lastUpdate = localStorage.getItem("droneready_locations_weekly_update");
    const lastTime = lastUpdate ? Number(lastUpdate) : 0;
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    if (!force && Date.now() - lastTime < weekMs) return;

    const next = mergeWeeklySchleswigHolsteinLocations(droneLocations);
    setDroneLocations(next);
    localStorage.setItem("droneready_drone_locations", JSON.stringify(next));
    localStorage.setItem("droneready_locations_weekly_update", String(Date.now()));

    if (force) {
      alert("Locations Schleswig-Holstein wurden aktualisiert.");
    }
  }

  function readImageFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("Bitte eine Bilddatei auswählen."));
        return;
      }

      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function uploadBlogImageWorking(event, mode = "new") {
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      const imageUrl = await readFileAsImageDataUrl(file, 900, 0.62);

      if (mode === "edit") {
        setEditBlogPost((prev) => ({ ...prev, imageUrl }));
      } else {
        setNewBlogPost((prev) => ({ ...prev, imageUrl }));
      }

      event.target.value = "";
    } catch (error) {
      alert(error.message || "Bild konnte nicht gelesen werden.");
      event.target.value = "";
    }
  }

  function persistGalleryCategoriesWorking(nextCategories) {
    const normalized = normalizeGalleryCategoryList(nextCategories, galleryItems);
    setGalleryManagedCategories(normalized);
    localStorage.setItem("droneready_gallery_categories", JSON.stringify(normalized));
    return normalized;
  }

  function addGalleryCategoryWorking() {
    if (!adminUnlocked) { alert("Diese Funktion ist nur nach Admin-Login verfügbar."); return; }
    const name = normalizeGalleryText(newGalleryCategory.name);
    if (!name) { alert("Bitte einen Kategorienamen eintragen."); return; }

    const subcategory = normalizeGalleryText(newGalleryCategory.subcategory);
    const description = normalizeGalleryText(newGalleryCategory.description);
    const existingCategory = galleryManagedCategories.find(
      (category) => normalizeGalleryText(category.name).toLowerCase() === name.toLowerCase()
    );

    // Wenn die Kategorie bereits existiert, darf sie trotzdem um eine neue
    // Unterkategorie erweitert werden. So kann zuerst "Baustellen" ohne
    // Unterkategorie angelegt und später "Baustellen > Hochbau" ergänzt werden.
    if (existingCategory) {
      if (!subcategory) {
        alert("Diese Kategorie gibt es bereits. Bitte eine neue Unterkategorie eintragen oder die Kategorie bearbeiten.");
        return;
      }

      const existingSubcategories = Array.isArray(existingCategory.subcategories)
        ? existingCategory.subcategories.map(normalizeGalleryText).filter(Boolean)
        : [];

      if (existingSubcategories.some((item) => item.toLowerCase() === subcategory.toLowerCase())) {
        alert("Diese Unterkategorie gibt es in dieser Kategorie bereits.");
        return;
      }

      const next = galleryManagedCategories.map((category) =>
        category.id === existingCategory.id
          ? {
              ...category,
              description: description || category.description || "",
              subcategories: [...existingSubcategories, subcategory].sort((a, b) => a.localeCompare(b, "de")),
            }
          : category
      );

      persistGalleryCategoriesWorking(next);
      setNewGalleryCategory({ name: "", description: "", subcategory: "" });
      return;
    }

    const next = [
      ...galleryManagedCategories,
      {
        id: `gallery-cat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name,
        description,
        subcategories: subcategory ? [subcategory] : [],
      },
    ];
    persistGalleryCategoriesWorking(next);
    setNewGalleryCategory({ name: "", description: "", subcategory: "" });
  }

  function startEditGalleryCategoryWorking(category) {
    if (!adminUnlocked) return;
    setEditingGalleryCategoryId(category.id);
    setEditGalleryCategory({ name: category.name || "", description: category.description || "", subcategoriesText: (category.subcategories || []).join("\n") });
  }

  function saveEditedGalleryCategoryWorking() {
    if (!adminUnlocked) { alert("Diese Funktion ist nur nach Admin-Login verfügbar."); return; }
    const name = normalizeGalleryText(editGalleryCategory.name);
    if (!name) { alert("Bitte einen Kategorienamen eintragen."); return; }
    const oldCategory = galleryManagedCategories.find((category) => category.id === editingGalleryCategoryId);
    const oldName = oldCategory?.name || "";
    const subcategories = Array.from(new Set(String(editGalleryCategory.subcategoriesText || "").split(/\n|,|;/).map(normalizeGalleryText).filter(Boolean)));
    const nextCategories = galleryManagedCategories.map((category) => category.id === editingGalleryCategoryId ? { ...category, name, description: normalizeGalleryText(editGalleryCategory.description), subcategories: subcategories.length ? subcategories : ["Sonstiges"] } : category);
    persistGalleryCategoriesWorking(nextCategories);
    if (oldName && oldName !== name) {
      const nextItems = galleryItems.map((item) => (item.category || "Allgemein") === oldName ? { ...item, category: name } : item);
      setGalleryItems(nextItems);
      localStorage.setItem("droneready_gallery_items", JSON.stringify(nextItems));
      if (galleryCategoryFilter === oldName) setGalleryCategoryFilter(name);
    }
    setEditingGalleryCategoryId(null);
    setEditGalleryCategory({ name: "", description: "", subcategoriesText: "" });
  }

  function deleteGalleryCategoryWorking(category) {
    if (!adminUnlocked) return;
    const name = category?.name || "";
    const usedCount = galleryItems.filter((item) => (item.category || "Allgemein") === name).length;
    const message = usedCount ? `Kategorie „${name}“ löschen? ${usedCount} Galerieeintrag(e) werden nach „Allgemein“ verschoben.` : `Kategorie „${name}“ löschen?`;
    if (!window.confirm(message)) return;
    const nextCategories = galleryManagedCategories.filter((item) => item.id !== category.id);
    persistGalleryCategoriesWorking(nextCategories.length ? nextCategories : DEFAULT_GALLERY_CATEGORIES);
    if (usedCount) {
      const nextItems = galleryItems.map((item) => (item.category || "Allgemein") === name ? { ...item, category: "Allgemein", subcategory: item.subcategory || "Sonstiges" } : item);
      setGalleryItems(nextItems);
      localStorage.setItem("droneready_gallery_items", JSON.stringify(nextItems));
    }
    if (galleryCategoryFilter === name) { setGalleryCategoryFilter("Alle"); setGallerySubcategoryFilter("Alle"); }
  }

  async function uploadGalleryImageWorking(event, mode = "new") {
    const file = event.target.files?.[0];

    if (!file) return;

    const isVideo = String(file.type || "").startsWith("video/") || /\.(mp4|webm|mov|m4v|avi)$/i.test(file.name || "");
    const isImage = String(file.type || "").startsWith("image/") || /\.(jpe?g|png|webp|gif)$/i.test(file.name || "");

    if (!isImage && !isVideo) {
      alert("Bitte eine Bild- oder Videodatei auswählen.");
      event.target.value = "";
      return;
    }

    try {
      const title = file.name.replace(/\.[^.]+$/, "");

      if (isVideo) {
        const uploaded = await uploadCompletedFlightAttachmentToServer(file);
        const videoUrl = uploaded.url || uploaded.browserUrl || uploaded.previewUrl || "";
        if (!videoUrl) throw new Error("Video-Upload lieferte keine URL zurück.");

        if (mode === "edit") {
          setEditGalleryItem((prev) => ({
            ...prev,
            mediaType: "video",
            videoUrl,
            imageUrl: prev.imageUrl || "",
            title: prev.title || title,
          }));
        } else {
          setNewGalleryItem((prev) => ({
            ...prev,
            mediaType: "video",
            videoUrl,
            imageUrl: prev.imageUrl || "",
            title: prev.title || title,
          }));
        }
      } else {
        const imageUrl = await readFileAsImageDataUrl(file, 900, 0.62);

        if (mode === "edit") {
          setEditGalleryItem((prev) => ({
            ...prev,
            mediaType: "image",
            imageUrl,
            videoUrl: prev.videoUrl || "",
            title: prev.title || title,
          }));
        } else {
          setNewGalleryItem((prev) => ({
            ...prev,
            mediaType: "image",
            imageUrl,
            videoUrl: prev.videoUrl || "",
            title: prev.title || title,
          }));
        }
      }

      event.target.value = "";
    } catch (error) {
      alert(error.message || "Datei konnte nicht verarbeitet werden.");
      event.target.value = "";
    }
  }

  function startEditBlogPostWorking(post) {
    if (!adminUnlocked) return;
    setEditingBlogId(post.id);
    setEditBlogPost({
      category: post.category || "Allgemein",
      title: post.title || "",
      text: post.text || "",
      imageUrl: post.imageUrl || "",
    });
  }

  function saveEditedBlogPostWorking() {
    if (!adminUnlocked) {
      alert("Diese Funktion ist nur nach Admin-Login verfügbar.");
      return;
    }

    if (!editBlogPost.title.trim() || !editBlogPost.text.trim()) {
      alert("Bitte Titel und Text eintragen.");
      return;
    }

    const next = blogPosts.map((post) =>
      post.id === editingBlogId
        ? {
            ...post,
            category: editBlogPost.category.trim() || "Allgemein",
            title: editBlogPost.title.trim(),
            text: editBlogPost.text.trim(),
            imageUrl: editBlogPost.imageUrl || "",
          }
        : post
    );

    setBlogPosts(next);
    localStorage.setItem("droneready_blog_posts", JSON.stringify(next));
    setEditingBlogId(null);
    setEditBlogPost({ category: "", title: "", text: "", imageUrl: "" });
  }

  function shownBlogText(post) {
    const textValue = String(post?.text || "").trim();
    if (adminUnlocked || expandedBlogPosts[post.id]) return textValue;

    const sentences = textValue.match(/[^.!?]+[.!?]+(?:\s|$)/g);
    if (sentences && sentences.length > 3) {
      return sentences.slice(0, 3).join(" ").trim();
    }

    const words = textValue.split(/\s+/);
    if (words.length > 35) {
      return words.slice(0, Math.ceil(words.length / 2)).join(" ");
    }

    return textValue;
  }

  function blogNeedsReadMore(post) {
    const textValue = String(post?.text || "").trim();
    if (!textValue || adminUnlocked) return false;

    const sentences = textValue.match(/[^.!?]+[.!?]+(?:\s|$)/g);
    if (sentences && sentences.length > 3) return true;

    return textValue.split(/\s+/).length > 35;
  }

  function startEditGalleryItemWorking(item) {
    if (!adminUnlocked) return;
    setEditingGalleryId(item.id);
    setEditGalleryItem({
      category: item.category || "Allgemein",
      subcategory: item.subcategory || item.subCategory || "Sonstiges",
      title: item.title || "",
      imageUrl: item.imageUrl || "",
      videoUrl: item.videoUrl || "",
      mediaType: getGalleryMediaType(item),
      text: item.text || "",
      featured: Boolean(item.featured),
      favorite: Boolean(item.favorite),
      tags: Array.isArray(item.tags) ? item.tags.join(", ") : String(item.tags || ""),
      coordinates: item.coordinates || formatGalleryCoordinates(item) || "",
      address: item.address || item.locationAddress || "",
      customerId: item.customerId || item.customerNumber || item.customerName || "",
      projectId: item.projectId || item.projectName || "",
      watermarkText: item.watermarkText || "",
      watermarkPosition: item.watermarkPosition || "",
      watermarkMode: item.watermarkMode || "inherit",
    });
  }

  function saveEditedGalleryItemWorking() {
    if (!adminUnlocked) {
      alert("Diese Funktion ist nur nach Admin-Login verfügbar.");
      return;
    }

    if (!editGalleryItem.title.trim()) {
      alert("Bitte mindestens einen Titel eintragen.");
      return;
    }

    const next = galleryItems.map((item) =>
      item.id === editingGalleryId
        ? {
            ...item,
            category: editGalleryItem.category.trim() || "Allgemein",
            subcategory: editGalleryItem.subcategory?.trim() || "Sonstiges",
            title: editGalleryItem.title.trim(),
            imageUrl: editGalleryItem.imageUrl?.trim() || "",
            videoUrl: editGalleryItem.videoUrl?.trim() || "",
            mediaType: editGalleryItem.mediaType || (editGalleryItem.videoUrl ? "video" : "image"),
            text: editGalleryItem.text.trim(),
            featured: Boolean(editGalleryItem.featured),
            favorite: Boolean(editGalleryItem.favorite),
            tags: String(editGalleryItem.tags || "").split(/[,#]/).map((tag) => tag.trim()).filter(Boolean),
            coordinates: String(editGalleryItem.coordinates || "").trim(),
            address: String(editGalleryItem.address || "").trim(),
            customerId: String(editGalleryItem.customerId || "").trim(),
            projectId: String(editGalleryItem.projectId || "").trim(),
            watermarkText: String(editGalleryItem.watermarkText || "").trim(),
            watermarkPosition: String(editGalleryItem.watermarkPosition || "").trim(),
            watermarkMode: editGalleryItem.watermarkMode || "inherit",
          }
        : item
    );

    setGalleryItems(next);
    localStorage.setItem("droneready_gallery_items", JSON.stringify(next));
    setEditingGalleryId(null);
    setEditGalleryItem({ category: "", subcategory: "", title: "", imageUrl: "", videoUrl: "", mediaType: "image", text: "", featured: false, favorite: false, tags: "", coordinates: "", address: "", customerId: "", projectId: "", watermarkText: "", watermarkPosition: "", watermarkMode: "inherit" });
  }



  function cancelEditGalleryItemWorking() {
    setEditingGalleryId(null);
    setEditGalleryItem({
      category: "",
      subcategory: "",
      title: "",
      imageUrl: "",
      videoUrl: "",
      mediaType: "image",
      text: "",
      featured: false,
      favorite: false,
      tags: "",
      coordinates: "",
      address: "",
      customerId: "",
      projectId: "",
    });
  }

  function readFileAsImageDataUrl(file, maxSize = 900, quality = 0.62) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("Keine gültige Bilddatei."));
        return;
      }

      const reader = new FileReader();

      reader.onload = () => {
        const img = new Image();

        img.onload = () => {
          try {
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            const width = Math.max(1, Math.round(img.width * scale));
            const height = Math.max(1, Math.round(img.height * scale));

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext("2d", { alpha: false });
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);

            resolve(canvas.toDataURL("image/jpeg", quality));
          } catch (error) {
            reject(error);
          }
        };

        img.onerror = () => reject(new Error("Bild konnte nicht geladen werden."));
        img.src = String(reader.result || "");
      };

      reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
      reader.readAsDataURL(file);
    });
  }


  function trimGalleryForStorage(items, maxItems = 60) {
    return (items || []).slice(0, maxItems);
  }

  function trySaveGalleryItems(nextItems) {
    const attempts = [
      trimGalleryForStorage(nextItems, 80),
      trimGalleryForStorage(nextItems, 50),
      trimGalleryForStorage(nextItems, 30),
      trimGalleryForStorage(nextItems, 15),
    ];

    let lastError = null;

    for (const attempt of attempts) {
      try {
        localStorage.setItem("droneready_gallery_items", JSON.stringify(attempt));
        return attempt;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Browser-Speicher ist voll.");
  }

  async function addGalleryFilesWorking(event) {
    if (!adminUnlocked) {
      alert("Upload ist nur nach Admin-Login verfügbar.");
      event.target.value = "";
      return;
    }

    const files = Array.from(event.target.files || []);
    const mediaFiles = files.filter((file) =>
      file && (
        String(file.type || "").startsWith("image/") ||
        String(file.type || "").startsWith("video/") ||
        /\.(jpe?g|png|webp|gif|mp4|webm|mov|m4v|avi)$/i.test(file.name || "")
      )
    );

    if (!mediaFiles.length) {
      alert("Bitte gültige Bild- oder Videodateien auswählen.");
      event.target.value = "";
      return;
    }

    try {
      const uploadedItems = [];

      for (const file of mediaFiles) {
        const isVideo = String(file.type || "").startsWith("video/") || /\.(mp4|webm|mov|m4v|avi)$/i.test(file.name || "");
        const title = file.name.replace(/\.[^.]+$/, "");

        if (isVideo) {
          const uploaded = await uploadCompletedFlightAttachmentToServer(file);
          const videoUrl = uploaded.url || uploaded.browserUrl || uploaded.previewUrl || "";
          if (!videoUrl) throw new Error(`${file.name} konnte nicht hochgeladen werden.`);
          uploadedItems.push({
            id: `gallery-video-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            category: newGalleryItem.category?.trim() || "Upload",
            subcategory: newGalleryItem.subcategory?.trim() || "Sonstiges",
            title,
            imageUrl: "",
            videoUrl,
            mediaType: "video",
            text: newGalleryItem.text?.trim() || "",
            featured: Boolean(newGalleryItem.featured),
            favorite: Boolean(newGalleryItem.favorite),
            tags: String(newGalleryItem.tags || "").split(/[,#]/).map((tag) => tag.trim()).filter(Boolean),
            coordinates: String(newGalleryItem.coordinates || "").trim(),
            address: String(newGalleryItem.address || "").trim(),
            customerId: String(newGalleryItem.customerId || "").trim(),
            projectId: String(newGalleryItem.projectId || "").trim(),
            watermarkText: String(newGalleryItem.watermarkText || "").trim(),
            watermarkPosition: String(newGalleryItem.watermarkPosition || "").trim(),
            watermarkMode: newGalleryItem.watermarkMode || "inherit",
            uploadedAt: new Date().toLocaleString("de-DE"),
          });
        } else {
          const imageUrl = await readFileAsImageDataUrl(file, 900, 0.62);
          uploadedItems.push({
            id: `gallery-image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            category: newGalleryItem.category?.trim() || "Upload",
            subcategory: newGalleryItem.subcategory?.trim() || "Sonstiges",
            title,
            imageUrl,
            videoUrl: "",
            mediaType: "image",
            text: newGalleryItem.text?.trim() || "",
            featured: Boolean(newGalleryItem.featured),
            favorite: Boolean(newGalleryItem.favorite),
            tags: String(newGalleryItem.tags || "").split(/[,#]/).map((tag) => tag.trim()).filter(Boolean),
            coordinates: String(newGalleryItem.coordinates || "").trim(),
            address: String(newGalleryItem.address || "").trim(),
            customerId: String(newGalleryItem.customerId || "").trim(),
            projectId: String(newGalleryItem.projectId || "").trim(),
            watermarkText: String(newGalleryItem.watermarkText || "").trim(),
            watermarkPosition: String(newGalleryItem.watermarkPosition || "").trim(),
            watermarkMode: newGalleryItem.watermarkMode || "inherit",
            uploadedAt: new Date().toLocaleString("de-DE"),
          });
        }
      }

      let savedItems;
      let next = [...uploadedItems, ...galleryItems];

      try {
        savedItems = trySaveGalleryItems(next);
      } catch (storageError) {
        console.warn("Speicher voll, versuche Upload ohne alte Galerieeinträge:", storageError);
        try {
          savedItems = trySaveGalleryItems(uploadedItems);
        } catch (secondError) {
          console.error("Galerie konnte auch ohne alte Einträge nicht gespeichert werden:", secondError);
          alert("Der Browser-Speicher ist voll. Videos werden serverseitig gespeichert; bitte trotzdem alte lokale Galerieeinträge reduzieren oder kleinere Bilder verwenden.");
          event.target.value = "";
          return;
        }
      }

      setGalleryItems(savedItems);
      setNewGalleryItem((prev) => ({ ...prev, title: "", imageUrl: "", videoUrl: "" }));

      alert(`${uploadedItems.length} Galerie-Datei(en) wurden hochgeladen. Bilder und Videos können jetzt bearbeitet oder gelöscht werden.`);
      event.target.value = "";
    } catch (error) {
      console.error("Galerie-Upload fehlgeschlagen:", error);
      alert(error.message || "Ein oder mehrere Dateien konnten nicht verarbeitet werden.");
      event.target.value = "";
    }
  }

  function addDroneLocationToFavoritesWorking(location) {
    const coordinates = String(location?.coordinates || "").trim();
    const [latFromCoordinates, lonFromCoordinates] = coordinates
      .split(",")
      .map((value) => Number(String(value || "").trim()));

    const lat = Number.isFinite(Number(location?.lat)) ? Number(location.lat) : latFromCoordinates;
    const lon = Number.isFinite(Number(location?.lon)) ? Number(location.lon) : lonFromCoordinates;

    if (!coordinates || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      alert("Diese Location hat keine gültigen Koordinaten.");
      return;
    }

    const favorite = {
      id: `location-favorite-${location?.id || Date.now()}`,
      coordinates: coordinates || `${lat.toFixed(7)}, ${lon.toFixed(7)}`,
      address: location.address || location.name || coordinates,
      lat,
      lon,
      savedAt: new Date().toLocaleString("de-DE"),
      source: "Drohnen-Location",
      locationId: location?.id || "",
      name: location?.name || "Drohnen-Location",
      category: location?.category || "Location",
      note: location?.note || "",
    };

    const next = [
      favorite,
      ...mapFavoritePlaces.filter((place) =>
        String(place.coordinates || "").trim() !== favorite.coordinates &&
        String(place.locationId || "") !== String(favorite.locationId || "__none__")
      ),
    ].slice(0, 30);

    setMapFavoritePlaces(next);
    localStorage.setItem("droneready_map_favorites", JSON.stringify(next));

    const picked = {
      lat: favorite.lat,
      lon: favorite.lon,
      coordinates: favorite.coordinates,
      address: favorite.address,
    };

    setMapPick(picked);

    setResult((prev) => ({
      ...prev,
      city: favorite.name || favorite.address || prev.city,
      lat: favorite.lat,
      lon: favorite.lon,
      note: favorite.note || prev.note,
    }));

    setFlightReportForm((prev) => ({
      ...prev,
      mapFavoriteIds: Array.from(new Set([...(Array.isArray(prev.mapFavoriteIds) ? prev.mapFavoriteIds : []), favorite.id])),
      selectedMapFavorites: Array.from(
        new Map(
          [
            ...(Array.isArray(prev.selectedMapFavorites) ? prev.selectedMapFavorites : []),
            favorite,
          ].map((item) => [String(item.id || item.coordinates), item])
        ).values()
      ),
      coordinates: favorite.coordinates,
      flightArea: favorite.address,
      city: prev.city || favorite.address,
    }));

    setActivePage("home");
    setTimeout(() => {
      const mapElement = document.querySelector(".mapReal");
      if (mapElement?.scrollIntoView) {
        mapElement.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 150);

    alert("Location wurde als Kartenpunkt/Favorit gespeichert und auf der Karte geöffnet.");
  }

  function addBlogPostWorking() {
    if (!newBlogPost.title.trim() || !newBlogPost.text.trim()) {
      alert("Bitte Titel und Text für den Blog eintragen.");
      return;
    }

    const item = {
      id: Date.now(),
      category: newBlogPost.category.trim() || "Allgemein",
      title: newBlogPost.title.trim(),
      text: newBlogPost.text.trim(),
      imageUrl: newBlogPost.imageUrl || "",
      date: new Date().toISOString().slice(0, 10),
    };

    const next = [item, ...blogPosts].slice(0, 100);
    setBlogPosts(next);
    localStorage.setItem("droneready_blog_posts", JSON.stringify(next));
    setNewBlogPost({ category: "Allgemein", title: "", text: "", imageUrl: "" });
  }

  function deleteBlogPostWorking(id) {
    if (!window.confirm("Blogbeitrag wirklich löschen?")) return;
    const next = blogPosts.filter((item) => item.id !== id);
    setBlogPosts(next);
    localStorage.setItem("droneready_blog_posts", JSON.stringify(next));
  }

  function addGalleryItemWorking() {
    if (!newGalleryItem.title.trim()) {
      alert("Bitte mindestens einen Titel für die Galerie eintragen.");
      return;
    }

    const mediaType = newGalleryItem.mediaType || (newGalleryItem.videoUrl ? "video" : "image");
    const item = {
      id: Date.now(),
      category: newGalleryItem.category.trim() || "Allgemein",
      subcategory: newGalleryItem.subcategory?.trim() || "Sonstiges",
      title: newGalleryItem.title.trim(),
      imageUrl: newGalleryItem.imageUrl?.trim() || "",
      videoUrl: newGalleryItem.videoUrl?.trim() || "",
      mediaType,
      text: newGalleryItem.text.trim(),
      featured: Boolean(newGalleryItem.featured),
      favorite: Boolean(newGalleryItem.favorite),
      tags: String(newGalleryItem.tags || "").split(/[,#]/).map((tag) => tag.trim()).filter(Boolean),
      coordinates: String(newGalleryItem.coordinates || "").trim(),
      address: String(newGalleryItem.address || "").trim(),
      customerId: String(newGalleryItem.customerId || "").trim(),
      projectId: String(newGalleryItem.projectId || "").trim(),
      watermarkText: String(newGalleryItem.watermarkText || "").trim(),
      watermarkPosition: String(newGalleryItem.watermarkPosition || "").trim(),
      watermarkMode: newGalleryItem.watermarkMode || "inherit",
      uploadedAt: new Date().toLocaleString("de-DE"),
    };

    if (mediaType === "image" && !item.imageUrl) {
      alert("Bitte ein Bild hochladen oder eine Bild-URL eintragen.");
      return;
    }
    if (mediaType === "video" && !item.videoUrl && !item.imageUrl) {
      alert("Bitte ein Video hochladen oder eine Video-URL eintragen.");
      return;
    }

    const next = [item, ...galleryItems].slice(0, 100);
    setGalleryItems(next);
    localStorage.setItem("droneready_gallery_items", JSON.stringify(next));
    setNewGalleryItem({ category: "Allgemein", subcategory: "Sonstiges", title: "", imageUrl: "", videoUrl: "", mediaType: "image", text: "", featured: false, favorite: false, tags: "", coordinates: "", address: "", customerId: "", projectId: "", watermarkText: "", watermarkPosition: "", watermarkMode: "inherit" });
  }

  function deleteGalleryItemWorking(id) {
    if (!window.confirm("Galerieeintrag wirklich löschen?")) return;
    const next = galleryItems.filter((item) => item.id !== id);
    setGalleryItems(next);
    localStorage.setItem("droneready_gallery_items", JSON.stringify(next));
  }

  function saveGalleryItemsWorking(nextItems) {
    setGalleryItems(nextItems);
    localStorage.setItem("droneready_gallery_items", JSON.stringify(nextItems));
  }

  function assignCurrentMapPointToGalleryDraftWorking(target = "new") {
    if (!mapPick?.coordinates) {
      alert("Bitte zuerst auf der Karte einen Punkt setzen.");
      return;
    }
    const patch = { coordinates: mapPick.coordinates, address: mapPick.address || mapPick.coordinates };
    if (target === "edit") {
      setEditGalleryItem((prev) => ({ ...prev, ...patch }));
    } else {
      setNewGalleryItem((prev) => ({ ...prev, ...patch }));
    }
  }

  function toggleGalleryFavoriteWorking(id) {
    const next = galleryItems.map((item) => item.id === id ? { ...item, favorite: !Boolean(item.favorite) } : item);
    saveGalleryItemsWorking(next);
  }

  function clearLocalDataWorking() {
    localStorage.removeItem("droneready_places");
    localStorage.removeItem("droneready_logbook");
    localStorage.removeItem("flymonitor_completed_flights");
    localStorage.removeItem("droneready_drone");
    localStorage.removeItem("droneready_map_favorites");
    setSavedPlaces([]);
    setMapFavoritePlaces([]);
    setMapPick(null);
    setLogbook([]);
    setCompletedFlights([]);
    setLogbookPage(1);
    alert("Lokale DroneReady-Daten wurden gelöscht.");
  }

  
  async function importDjiFlightRecordsWorking(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    try {
      const imported = [];
      for (const file of files) {
        const rawText = await readTextFile(file);
        imported.push(parseDjiFlightRecordText(rawText, file.name));
      }
      setDjiImportReports(imported);
      if (imported[0]) applyDjiImportToFlightReportWorking(imported[0], false);
      alert(`${imported.length} DJI FlightRecord-Datei(en) wurden importiert.`);
      event.target.value = "";
    } catch (error) {
      console.error("DJI FlightRecord Import fehlgeschlagen:", error);
      alert("DJI FlightRecord konnte nicht gelesen werden. Bitte TXT/CSV-Datei aus DJI Fly verwenden.");
      event.target.value = "";
    }
  }

  function applyDjiImportToFlightReportWorking(report, scrollToForm = true) {
    if (!report) return;
    setFlightReportForm((prev) => ({
      ...prev,
      ...report,
      legalConfirm: prev.legalConfirm,
      safetyMeasures: prev.safetyMeasures || DEFAULT_SAFETY_MEASURES,
      djiImport: true,
      djiImportFileName: report.fileName,
      djiRoutePoints: report.routePoints,
    }));
    if (report.coordinates) {
      const [lat, lon] = report.coordinates.split(",").map((value) => Number(value.trim()));
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        setMapPick({ lat, lon, latitude: lat, longitude: lon, coordinates: report.coordinates, address: report.flightArea });
      }
    }
    if (scrollToForm) {
      setActivePage("registrationForm");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

async function saveActualFlightReportWorking() {
    const registrationNumber = ensureRegistrationNumber(flightReportForm);
    const manualAuthorityPin = normalizeAuthorityPin(flightReportForm.authorityPin);

    if (manualAuthorityPin && !/^\d{6}$/.test(manualAuthorityPin)) {
      alert("Bitte eine 6-stellige Behörden-PIN eingeben oder das Feld leer lassen, damit automatisch eine PIN erzeugt wird.");
      return;
    }

    if (activePage === "registrationForm" && !adminUnlocked && !flightReportForm.legalConfirm) {
      alert("Bitte die rechtliche Bestätigung anklicken.");
      return;
    }

    const normalizeRegistrationNumber = (value) =>
      String(value || "")
        .trim()
        .toLowerCase();

    const existingEntry = editingLogId
      ? logbook.find((item) => item.id === editingLogId)
      : logbook.find(
          (item) =>
            normalizeRegistrationNumber(item.registrationNumber) ===
            normalizeRegistrationNumber(registrationNumber)
        );

    const nowText = new Date().toLocaleString("de-DE");

    const mergedFormData = mergeNonEmptyFields(existingEntry || {}, flightReportForm);

    const entry = {
      ...mergedFormData,
      id: existingEntry?.id || Date.now(),
      registrationNumber,
      authorityPin:
        manualAuthorityPin ||
        normalizeAuthorityPin(existingEntry?.authorityPin) ||
        createAuthorityPin(getAllKnownAuthorityPins(logbook)),
      authorityPins: Array.from(
        new Set(
          [
            ...(Array.isArray(existingEntry?.authorityPins) ? existingEntry.authorityPins : []),
            existingEntry?.authorityPin,
            manualAuthorityPin,
          ]
            .map(normalizeAuthorityPin)
            .filter(Boolean)
        )
      ),
      pinCreatedAt: flightReportForm.pinCreatedAt || existingEntry?.pinCreatedAt || nowText,
      city: flightReportForm.city || existingEntry?.city || result.city || "Unbekannt",
      drone: flightReportForm.drone || existingEntry?.drone || droneProfile.name || "",
      distanceKm: cleanManualDistanceKm(flightReportForm.distanceKm || existingEntry?.distanceKm),
      batteryEnd: cleanManualBatteryEnd(flightReportForm.batteryEnd || existingEntry?.batteryEnd),
      score,
      wind: flightReportForm.wind || existingEntry?.wind || "",
      gusts: flightReportForm.gusts || existingEntry?.gusts || "",
      temperature: flightReportForm.temperature || existingEntry?.temperature || result.temp || "",
      visibility: flightReportForm.visibility || existingEntry?.visibility || result.visibility || "",
      cloud: flightReportForm.cloud || existingEntry?.cloud || result.cloud || "",
      weatherArchivedAt: nowText,
      recommendation: flightReportForm.recommendation || existingEntry?.recommendation || "",
      safetyMeasures: flightReportForm.safetyMeasures || existingEntry?.safetyMeasures || DEFAULT_SAFETY_MEASURES,
      legalConfirm: Boolean(flightReportForm.legalConfirm || existingEntry?.legalConfirm),
      legalConfirmationText: LEGAL_CONFIRMATION_TEXT,
      savedAt: existingEntry?.savedAt || nowText,
      updatedAt: nowText,
    };

    const next = existingEntry
      ? logbook.map((item) => (item.id === existingEntry.id ? entry : item))
      : [entry, ...logbook].slice(0, 200);

    if (String(entry.status || "").trim() === "Erfolgt") {
      const archivedEntry = {
        ...entry,
        completedId: entry.completedId || `completed-${entry.id || Date.now()}`,
        sourceLogbookId: entry.id || "",
        completedAt: entry.completedAt || nowText,
        status: "Erfolgt",
      };

      const completedNext = [
        archivedEntry,
        ...completedFlights.filter(
          (item) =>
            String(item.registrationNumber || "") !== String(archivedEntry.registrationNumber || "")
        ),
      ].slice(0, 300);

      saveCompletedFlightArchiveWorking(completedNext);
    }

    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    await saveFlightEntryToServer(entry);
    setFlightReportForm({ ...emptyFlightReport });
    setEditingLogId(null);
    setEditLogEntry({});
    setLogbookPage(1);
    alert(existingEntry ? "Fluganmeldung wurde aktualisiert." : "Fluganmeldung wurde gespeichert.");
  }

  function startEditLogEntry(entry) {
    if (!adminUnlocked) {
      alert("Bearbeiten ist nur nach Admin-Login möglich.");
      return;
    }

    setEditingLogId(entry.id);
    setEditLogEntry({ ...entry });
    setFlightReportForm({
      ...emptyFlightReport,
      ...entry,
      date: normalizeIsoDate(entry.date) || emptyFlightReport.date,
      safetyMeasures: entry.safetyMeasures || DEFAULT_SAFETY_MEASURES,
      legalConfirmationText: entry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT,
      legalConfirm: true,
    });
    setActivePage("registrationForm");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEditLogEntryWorking(entry) {
    startEditLogEntry(entry);
  }

  function cancelEditLogEntry() {
    setEditingLogId(null);
    setEditLogEntry({});
  }

  async function saveEditedLogEntry() {
    const next = logbook.map((entry) =>
      entry.id === editingLogId
        ? {
            ...entry,
            ...editLogEntry,
            authorityPin: editLogEntry.authorityPin || entry.authorityPin || createAuthorityPin(),
            authorityPins: Array.from(
              new Set(
                [
                  ...(Array.isArray(entry.authorityPins) ? entry.authorityPins : []),
                  entry.authorityPin,
                  editLogEntry.authorityPin,
                ]
                  .map(normalizeAuthorityPin)
                  .filter(Boolean)
              )
            ),
            pinCreatedAt: editLogEntry.pinCreatedAt || entry.pinCreatedAt || new Date().toLocaleString("de-DE"),
          }
        : entry
    );
    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    const savedEntry = next.find((entry) => entry.id === editingLogId);
    if (savedEntry) await saveFlightEntryToServer(savedEntry);
    setEditingLogId(null);
    setEditLogEntry({});
    alert("Logbucheintrag wurde gespeichert.");
  }

  function deleteLogEntry(id) {
    if (!window.confirm("Diesen Logbucheintrag wirklich löschen?")) return;
    const next = logbook.filter((entry) => entry.id !== id);
    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    setLogbookPage(1);
  }


  function deleteLogEntryWorking(id) {
    deleteLogEntry(id);
  }

  function duplicateLogEntryForNewRegistration(entry) {
    if (!entry) return;
    const registrationNumber = createUniqueRegistrationNumber(logbook);
    setEditingLogId(null);
    setEditLogEntry({});
    setFlightReportForm({
      ...emptyFlightReport,
      ...entry,
      id: undefined,
      registrationNumber,
      authorityPin: "",
      authorityPins: [],
      pinCreatedAt: "",
      date: normalizeIsoDate(entry.date) || emptyFlightReport.date,
      legalConfirm: false,
      safetyMeasures: entry.safetyMeasures || DEFAULT_SAFETY_MEASURES,
      legalConfirmationText: entry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT,
    });
    setActivePage("registrationForm");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  
  function saveCompletedFlightArchiveWorking(next) {
    if (!adminUnlocked) {
      alert("Nur Admins dürfen Abgeschlossene Flüge ändern.");
      return;
    }
    const storageSafeNext = (Array.isArray(next) ? next : []).map(stripCompletedFlightForStorage);

    postAdminAction("completed_flights_save", { count: storageSafeNext.length });
    apiPostJson(COMPLETED_FLIGHTS_API, { items: storageSafeNext }).then((result) => {
      if (!result.ok) {
        console.warn("Server-Speicherung der abgeschlossenen Flüge fehlgeschlagen:", result);
      }
    });
    writeAuditLog("completed_flights_save", { count: storageSafeNext.length });
    setCompletedFlights(storageSafeNext);

    try {
      localStorage.setItem("flymonitor_completed_flights", JSON.stringify(storageSafeNext));
    } catch (error) {
      console.error("Abgeschlossene Flüge konnten lokal nicht gespeichert werden:", error);
      try {
        const withoutAttachments = storageSafeNext.map((entry) => ({
          ...entry,
          attachments: normalizeCompletedFlightAttachments(),
        }));
        localStorage.setItem("flymonitor_completed_flights", JSON.stringify(withoutAttachments));
      } catch (secondError) {
        console.error("Auch reduzierte lokale Speicherung fehlgeschlagen:", secondError);
      }
      alert(
        "Der Flug wurde übernommen. Einige lokale Browserdaten konnten nicht gespeichert werden. " +
        "Server-Bilder bleiben über ihre Upload-URL erhalten."
      );
    }
  }

  function archiveCompletedFlightWorking(entry) {
    if (!adminUnlocked) {
      alert("Bitte zuerst als Admin einloggen.");
      return;
    }
    if (!entry) return;

    const archived = {
      ...entry,
      completedId: entry.completedId || `completed-${entry.id || Date.now()}`,
      sourceLogbookId: entry.sourceLogbookId || entry.id || "",
      authorityPin: normalizeAuthorityPin(entry.authorityPin) || createAuthorityPin(getAllKnownAuthorityPins([...logbook, ...completedFlights])),
      authorityPins: Array.from(
        new Set(
          [
            ...(Array.isArray(entry.authorityPins) ? entry.authorityPins : []),
            entry.authorityPin,
          ]
            .map(normalizeAuthorityPin)
            .filter(Boolean)
        )
      ),
      actualStartTime: entry.actualStartTime || entry.startTime || "",
      actualEndTime: entry.actualEndTime || entry.endTime || "",
      actualIncidents: entry.actualIncidents || entry.incidents || "",
      actualNotes: entry.actualNotes || entry.notes || "",
      actualWeather: entry.actualWeather || entry.weather || "",
      wind: entry.wind || entry.actualWind || "",
      gusts: entry.gusts || entry.actualGusts || "",
      actualWind: entry.actualWind || entry.wind || "",
      actualGusts: entry.actualGusts || entry.gusts || "",
      maxHeight: entry.maxHeight || "",
      maxDistance: entry.maxDistance || "",
      temperature: entry.temperature || "",
      authorityInspection: entry.authorityInspection || "",
      authorityType: entry.authorityInspection === "Ja" ? (entry.authorityType || "") : "",
      authorityControlDate: entry.authorityInspection === "Ja" ? (entry.authorityControlDate || "") : "",
      authorityOffice: entry.authorityInspection === "Ja" ? (entry.authorityOffice || "") : "",
      authorityResult: entry.authorityInspection === "Ja" ? (entry.authorityResult || "") : "",
      authorityInspectionNotes: entry.authorityInspectionNotes || "",
      attachments: normalizeCompletedFlightAttachments(entry.attachments),
      attachmentsVisibleForAuthorities: entry.attachmentsVisibleForAuthorities !== false,
      attachmentsIncludeInPdf: entry.attachmentsIncludeInPdf !== false,
      attachmentsIncludeInMail: Boolean(entry.attachmentsIncludeInMail),
      updatedAt: entry.updatedAt || entry.completedAt || "",
      actualDistanceKm: entry.actualDistanceKm || entry.distanceKm || "",
      actualBatteryStart: entry.actualBatteryStart || entry.batteryStart || "",
      actualBatteryEnd: entry.actualBatteryEnd || entry.batteryEnd || "",
      completedAt: entry.completedAt || new Date().toLocaleString("de-DE"),
      status: "Erfolgt",
    };

    const next = [
      archived,
      ...completedFlights.filter(
        (item) =>
          String(item.completedId || item.id || "") !== String(archived.completedId || archived.id || "") &&
          String(item.registrationNumber || "") !== String(archived.registrationNumber || "")
      ),
    ].slice(0, 300);

    saveCompletedFlightArchiveWorking(next);
    alert("Flug wurde in „Abgeschlossene Flüge“ gespeichert.");
  }

  function applyCompletedFlightRegistrationLookupWorking(value) {
    const registrationNumber = String(value || "").trim();
    const normalizedRegistrationNumber = registrationNumber.toLowerCase();

    const possibleSources = [
      ...(Array.isArray(logbook) ? logbook : []),
      authorityReport,
    ].filter(Boolean);

    const matchingFlight = possibleSources.find((entry) => {
      const entryRegistration = String(entry?.registrationNumber || "").trim().toLowerCase();
      return normalizedRegistrationNumber && entryRegistration === normalizedRegistrationNumber;
    });

    setCompletedFlightDraft((current) => {
      if (!matchingFlight) {
        return { ...current, registrationNumber };
      }

      const mergedAuthorityPins = Array.from(
        new Set(
          [
            ...(Array.isArray(current.authorityPins) ? current.authorityPins : []),
            ...(Array.isArray(matchingFlight.authorityPins) ? matchingFlight.authorityPins : []),
            current.authorityPin,
            matchingFlight.authorityPin,
          ]
            .map(normalizeAuthorityPin)
            .filter(Boolean)
        )
      );

      return {
        ...current,
        sourceLogbookId: matchingFlight.id || matchingFlight.sourceLogbookId || current.sourceLogbookId || "",
        registrationNumber,
        authorityPin: normalizeAuthorityPin(matchingFlight.authorityPin) || current.authorityPin || "",
        authorityPins: mergedAuthorityPins,
        date: normalizeIsoDate(matchingFlight.date) || matchingFlight.date || current.date || "",
        startTime: matchingFlight.startTime || current.startTime || "",
        endTime: matchingFlight.endTime || current.endTime || "",
        flightArea: matchingFlight.flightArea || current.flightArea || "",
        city: matchingFlight.city || current.city || "",
        coordinates: matchingFlight.coordinates || current.coordinates || "",
        pilot: matchingFlight.pilot || current.pilot || "",
        drone: matchingFlight.drone || current.drone || "",
        purpose: matchingFlight.purpose || current.purpose || "",
        notes: current.notes || matchingFlight.notes || "",
        updatedAt: current.updatedAt || new Date().toLocaleString("de-DE"),
      };
    });
  }

  function resetCompletedFlightDraftWorking() {
    setCompletedFlightDraft({
      registrationNumber: "",
      authorityPin: "",
      date: "",
      startTime: "",
      endTime: "",
      actualStartTime: "",
      actualEndTime: "",
      city: "",
      flightArea: "",
      coordinates: "",
      pilot: "",
      drone: "",
      purpose: "",
      distanceKm: "",
      batteryStart: "",
      batteryEnd: "",
      weather: "",
      wind: "",
      gusts: "",
      actualWind: "",
      actualGusts: "",
      maxHeight: "",
      maxDistance: "",
      temperature: "",
      authorityInspection: "",
      authorityType: "",
      authorityControlDate: "",
      authorityOffice: "",
      authorityResult: "",
      authorityInspectionNotes: "",
      incidents: "",
      actualIncidents: "",
      actualNotes: "",
      attachments: normalizeCompletedFlightAttachments(),
      attachmentsVisibleForAuthorities: true,
      attachmentsIncludeInPdf: true,
      attachmentsIncludeInMail: false,
      updatedAt: "",
      notes: "",
    });
    setEditingCompletedFlightId(null);
    setSelectedCompletedFlightId("");
  }

  function addCompletedFlightManualWorking() {
    if (!adminUnlocked) {
      alert("Bitte zuerst als Admin einloggen.");
      return;
    }

    const pin = normalizeAuthorityPin(completedFlightDraft.authorityPin) || createAuthorityPin(getAllKnownAuthorityPins([...logbook, ...completedFlights]));
    const now = new Date().toLocaleString("de-DE");
    const completedId = editingCompletedFlightId || completedFlightDraft.completedId || `completed-manual-${Date.now()}`;

    const draft = {
      ...completedFlightDraft,
      id: completedFlightDraft.id || completedId,
      completedId,
      authorityPin: pin,
      authorityPins: Array.from(
        new Set(
          [
            ...(Array.isArray(completedFlightDraft.authorityPins) ? completedFlightDraft.authorityPins : []),
            completedFlightDraft.authorityPin,
            pin,
          ]
            .map(normalizeAuthorityPin)
            .filter(Boolean)
        )
      ),
      attachments: normalizeCompletedFlightAttachments(completedFlightDraft.attachments),
attachmentsVisibleForAuthorities: completedFlightDraft.attachmentsVisibleForAuthorities !== false,
attachmentsIncludeInPdf: completedFlightDraft.attachmentsIncludeInPdf !== false,
attachmentsIncludeInMail: Boolean(completedFlightDraft.attachmentsIncludeInMail),
      actualStartTime: completedFlightDraft.actualStartTime || completedFlightDraft.startTime || "",
      actualEndTime: completedFlightDraft.actualEndTime || completedFlightDraft.endTime || "",
      actualIncidents: completedFlightDraft.actualIncidents || completedFlightDraft.incidents || "",
      actualNotes: completedFlightDraft.actualNotes || completedFlightDraft.notes || "",
      actualWeather: completedFlightDraft.actualWeather || completedFlightDraft.weather || "",
      wind: completedFlightDraft.wind || completedFlightDraft.actualWind || "",
      gusts: completedFlightDraft.gusts || completedFlightDraft.actualGusts || "",
      actualWind: completedFlightDraft.actualWind || completedFlightDraft.wind || "",
      actualGusts: completedFlightDraft.actualGusts || completedFlightDraft.gusts || "",
      maxHeight: completedFlightDraft.maxHeight || "",
      maxDistance: completedFlightDraft.maxDistance || "",
      temperature: completedFlightDraft.temperature || "",
      authorityInspection: completedFlightDraft.authorityInspection || "",
      authorityType: completedFlightDraft.authorityInspection === "Ja" ? (completedFlightDraft.authorityType || "") : "",
      authorityControlDate: completedFlightDraft.authorityInspection === "Ja" ? (completedFlightDraft.authorityControlDate || "") : "",
      authorityOffice: completedFlightDraft.authorityInspection === "Ja" ? (completedFlightDraft.authorityOffice || "") : "",
      authorityResult: completedFlightDraft.authorityInspection === "Ja" ? (completedFlightDraft.authorityResult || "") : "",
      authorityInspectionNotes: completedFlightDraft.authorityInspectionNotes || "",
      attachments: normalizeCompletedFlightAttachments(completedFlightDraft.attachments),
      attachmentsVisibleForAuthorities: completedFlightDraft.attachmentsVisibleForAuthorities !== false,
      attachmentsIncludeInPdf: completedFlightDraft.attachmentsIncludeInPdf !== false,
      attachmentsIncludeInMail: Boolean(completedFlightDraft.attachmentsIncludeInMail),
      actualDistanceKm: completedFlightDraft.actualDistanceKm || completedFlightDraft.distanceKm || "",
      actualBatteryStart: completedFlightDraft.actualBatteryStart || completedFlightDraft.batteryStart || "",
      actualBatteryEnd: completedFlightDraft.actualBatteryEnd || completedFlightDraft.batteryEnd || "",
      completedAt: completedFlightDraft.completedAt || now,
      updatedAt: now,
      status: "Erfolgt",
      score: completedFlightDraft.score || 100,
    };

    if (!draft.registrationNumber && !draft.date && !draft.city && !draft.flightArea && !draft.pilot && !draft.drone) {
      alert("Bitte mindestens Vorgangsnummer, Datum, Ort, Fluggebiet, Pilot oder Drohne eintragen.");
      return;
    }

    const next = [
      draft,
      ...completedFlights.filter((item) =>
        String(item.completedId || item.id || item.registrationNumber || "") !== String(completedId) &&
        (!draft.registrationNumber || String(item.registrationNumber || "") !== String(draft.registrationNumber || ""))
      ),
    ].slice(0, 300);

    saveCompletedFlightArchiveWorking(next);
    resetCompletedFlightDraftWorking();
    setSelectedCompletedFlightId(getCompletedFlightKey(draft));

    alert(editingCompletedFlightId ? "Erfolgter Flug wurde aktualisiert." : "Erfolgter Flug wurde nachträglich eingetragen.");
  }

  function openCompletedFlightWorking(entry) {
    if (!adminUnlocked) {
      alert("Bitte zuerst als Admin einloggen.");
      return;
    }
    if (!entry) return;

    setCompletedFlightDraft({
      ...entry,
      date: normalizeIsoDate(entry.date) || entry.date || "",
      authorityPin: normalizeAuthorityPin(entry.authorityPin) || "",
      actualStartTime: entry.actualStartTime || entry.startTime || "",
      actualEndTime: entry.actualEndTime || entry.endTime || "",
      actualIncidents: entry.actualIncidents || entry.incidents || "",
      actualNotes: entry.actualNotes || entry.notes || "",
      actualWeather: entry.actualWeather || entry.weather || "",
      wind: entry.wind || entry.actualWind || "",
      gusts: entry.gusts || entry.actualGusts || "",
      actualWind: entry.actualWind || entry.wind || "",
      actualGusts: entry.actualGusts || entry.gusts || "",
      maxHeight: entry.maxHeight || "",
      maxDistance: entry.maxDistance || "",
      temperature: entry.temperature || "",
      authorityInspection: entry.authorityInspection || "",
      authorityType: entry.authorityInspection === "Ja" ? (entry.authorityType || "") : "",
      authorityControlDate: entry.authorityInspection === "Ja" ? (entry.authorityControlDate || "") : "",
      authorityOffice: entry.authorityInspection === "Ja" ? (entry.authorityOffice || "") : "",
      authorityResult: entry.authorityInspection === "Ja" ? (entry.authorityResult || "") : "",
      authorityInspectionNotes: entry.authorityInspectionNotes || "",
      attachments: normalizeCompletedFlightAttachments(entry.attachments),
      attachmentsVisibleForAuthorities: entry.attachmentsVisibleForAuthorities !== false,
      attachmentsIncludeInPdf: entry.attachmentsIncludeInPdf !== false,
      attachmentsIncludeInMail: Boolean(entry.attachmentsIncludeInMail),
      updatedAt: entry.updatedAt || entry.completedAt || "",
      actualDistanceKm: entry.actualDistanceKm || entry.distanceKm || "",
      actualBatteryStart: entry.actualBatteryStart || entry.batteryStart || "",
      actualBatteryEnd: entry.actualBatteryEnd || entry.batteryEnd || "",
    });
    setEditingCompletedFlightId(entry.completedId || entry.id || entry.registrationNumber || null);
    setSelectedCompletedFlightId(getCompletedFlightKey(entry));
    setAdminCenterTab("flights");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteCompletedFlightWorking(entry) {
    if (!adminUnlocked) {
      alert("Bitte zuerst als Admin einloggen.");
      return;
    }
    if (!entry) return;
    if (!window.confirm("Diesen abgeschlossenen Flug wirklich löschen?")) return;

    const deletedValues = new Set(getCompletedFlightCompareValues(entry));
    const deletedCompletedId = String(entry.completedId || entry.id || "");
    const deletedRegistrationNumber = String(entry.registrationNumber || "").trim().toLowerCase();

    const next = completedFlights.filter((item) => {
      const sameCompletedId =
        deletedCompletedId && String(item.completedId || item.id || "") === deletedCompletedId;
      const sameRegistrationNumber =
        deletedRegistrationNumber &&
        String(item.registrationNumber || "").trim().toLowerCase() === deletedRegistrationNumber;
      const sameKnownValue = getCompletedFlightCompareValues(item).some((value) => deletedValues.has(value));

      return !(sameCompletedId || sameRegistrationNumber || sameKnownValue);
    });

    saveCompletedFlightArchiveWorking(next);

    // Wichtig: Der gelöschte abgeschlossene Flug darf danach nicht wieder unter
    // „Letzte Einträge“ erscheinen. Deshalb wird der dazugehörige Logbuch-/
    // Fluganmeldungs-Eintrag anhand ID, sourceLogbookId, Vorgangsnummer oder PIN
    // ebenfalls entfernt.
    const nextLogbook = logbook.filter((logEntry) => {
      const logValues = getCompletedFlightCompareValues(logEntry);
      const sameKnownValue = logValues.some((value) => deletedValues.has(value));
      const sameRegistrationNumber =
        deletedRegistrationNumber &&
        String(logEntry.registrationNumber || "").trim().toLowerCase() === deletedRegistrationNumber;
      const sameSourceId =
        String(entry.sourceLogbookId || "") &&
        String(logEntry.id || "") === String(entry.sourceLogbookId || "");

      return !(sameKnownValue || sameRegistrationNumber || sameSourceId);
    });

    if (nextLogbook.length !== logbook.length) {
      setLogbook(nextLogbook);
      localStorage.setItem("droneready_logbook", JSON.stringify(nextLogbook));
      setLogbookPage(1);
    }

    if (selectedCompletedFlightId === getCompletedFlightKey(entry)) {
      resetCompletedFlightDraftWorking();
    }
  }

function exportCsvWorking() {
    const rows = [
      ["Vorgangsnummer", "Datum", "Ort", "Pilot", "Drohne", "Zweck", "Strecke", "AkkuStart", "AkkuEnde", "Score", "Wind", "Empfehlung", "Notizen"],
      ...logbook.map((e) => [e.registrationNumber, e.date, e.city, e.pilot, e.drone, e.purpose, e.distanceKm, e.batteryStart, e.batteryEnd, e.score, e.wind, e.recommendation, e.notes]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell || "").replaceAll('"', '""')}"`).join(";")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "droneready-fluglog.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function openPrintWindow(title, html) {
    const win = window.open("", "_blank");
    if (!win) {
      alert("Popup wurde blockiert. Bitte Popups für diese Seite erlauben.");
      return;
    }

    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();

    // Wichtig: erst drucken, wenn alle Bilder geladen sind.
    // Sonst erscheint der QR-Code im Druck/PDF manchmal als leeres Feld.
    const printWhenReady = () => {
      const images = Array.from(win.document.images || []);
      if (!images.length) {
        win.print();
        return;
      }

      let loaded = 0;
      const done = () => {
        loaded += 1;
        if (loaded >= images.length) {
          setTimeout(() => win.print(), 250);
        }
      };

      images.forEach((img) => {
        if (img.complete) {
          done();
        } else {
          img.onload = done;
          img.onerror = done;
        }
      });

      // Sicherheits-Fallback, falls ein externer QR-Dienst langsam ist.
      setTimeout(() => {
        try {
          win.print();
        } catch {}
      }, 2500);
    };

    if (win.document.readyState === "complete") {
      printWhenReady();
    } else {
      win.onload = printWhenReady;
    }
  }

  function reportHtml(entry) {
    const logo = `${window.location.origin}/logo_neu.png`;
    return [`<html><head><title>Flugbericht ${entry.registrationNumber || ""}</title>`,
      `<style>body{font-family:Arial,sans-serif;padding:32px;line-height:1.55;color:#0f172a}.logo{text-align:center;margin-bottom:20px}.logo img{max-width:180px;height:auto}table{border-collapse:collapse;width:100%;margin-top:18px;font-size:13px}td,th{border:1px solid #cbd5e1;padding:9px;text-align:left;vertical-align:top}th{background:#f1f5f9}.note{margin-top:24px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px}</style>`,
      `</head><body><div class="logo"><img src="${logo}" alt="Pixel Foto" /></div><h1>UAS-Fluganmeldung</h1>`,
      `<p><strong>Vorgangsnummer:</strong> ${entry.registrationNumber || "-"}<br/><strong>Gespeichert:</strong> ${entry.savedAt || "-"}</p>`,
      `<table><tbody>`,
      `<tr><th>Datum</th><td>${entry.date || ""}</td></tr><tr><th>Zeit</th><td>${entry.startTime || ""}${entry.endTime ? " – " + entry.endTime : ""}</td></tr>`,
      `<tr><th>Ort</th><td>${entry.city || ""}</td></tr><tr><th>Pilot</th><td>${entry.pilot || ""}</td></tr><tr><th>Ausnahmegenehmigung</th><td>${entry.exceptionPermit || ""}</td></tr><tr><th>Fernpiloten-ID</th><td>${entry.remotePilotId || ""}</td></tr><tr><th>Drohne</th><td>${entry.drone || ""}</td></tr>`,
      `<tr><th>Zweck</th><td>${entry.purpose || ""}</td></tr><tr><th>Strecke</th><td>${cleanManualDistanceKm(entry.distanceKm) ? cleanManualDistanceKm(entry.distanceKm) + " km" : ""}</td></tr>`,
      `<tr><th>Akku</th><td>${entry.batteryStart || ""}${entry.batteryEnd ? " → " + entry.batteryEnd : ""}</td></tr>`,
      `<tr><th>Wetter</th><td>${entry.weather || ""}</td></tr>${(entry.wind || entry.gusts) ? `<tr><th>Wind / Böen</th><td>${entry.wind || "-"} / ${entry.gusts || "-"} km/h</td></tr>` : ""}`,
      `<tr><th>Vorkommnisse</th><td>${entry.incidents || "Keine"}</td></tr>`,
      `</tbody></table><div class="note"><strong>Sicherheitsvorkehrungen:</strong><br/>${entry.safetyMeasures || DEFAULT_SAFETY_MEASURES}</div><div class="note"><strong>Rechtliche Bestätigung:</strong><br/>${entry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT}</div><div class="note"><strong>Notizen:</strong><br/>${entry.notes || "Keine Notizen"}</div></body></html>`].join("");
  }


  function registrationHtml(entry, outputMode = "flight") {
    const logo = `${window.location.origin}/logo_neu.png`;

    const escapeHtml = (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const formatGermanDate = (value) => {
      if (!value) return "";
      const text = String(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const [year, month, day] = text.split("-");
        return `${day}.${month}.${year}`;
      }
      const date = new Date(text);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
      }
      return text;
    };

    const formatGermanDateTime = (value) => {
      if (!value) return "";
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        return date.toLocaleString("de-DE", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
      }
      return String(value);
    };

    const yesNo = (value) => (value ? "Bestätigt" : "Nicht bestätigt");
    const safe = (value, fallback = "-") => escapeHtml(value || fallback);
    const fullAddress = [entry.street, [entry.zip, entry.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const flightTime = [entry.startTime, entry.endTime].filter(Boolean).join(" – ");
    const batteryText = formatManualBattery(entry.batteryStart, entry.batteryEnd);
    const legalText = entry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT;
    const safetyText = entry.safetyMeasures || DEFAULT_SAFETY_MEASURES;
    const authorityPin = entry.authorityPin || "";
    const authorityLink = getAuthorityLink();
    const authorityQrLink =
      typeof window !== "undefined" && authorityPin
        ? `${window.location.origin}${window.location.pathname}#behoerde?pin=${encodeURIComponent(authorityPin)}`
        : authorityLink;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=170x170&margin=10&data=${encodeURIComponent(authorityQrLink)}`;
    const showDigitalSignature = Boolean(
      digitalSignature &&
        ((outputMode === "authority" && signatureAuthorityReports) ||
          (outputMode !== "authority" && signatureFlightReports))
    );
    const signatureTitle = outputMode === "authority" ? "Bestätigung der Angaben" : "Fernpilot";

    const row = (label, value) => {
      if (!isFilledDisplayValue(value)) return "";
      return `<tr><th>${escapeHtml(label)}</th><td>${safe(value)}</td></tr>`;
    };

    const section = (title, rows) =>
      `<div class="section"><h2>${escapeHtml(title)}</h2><table>${rows}</table></div>`;

    return [`<html><head><meta charset="UTF-8" /><title>Fluganmeldung ${escapeHtml(entry.registrationNumber || "")}</title>`,
      `<style>
        @page{margin:18mm 16mm 18mm 16mm;}
        *{box-sizing:border-box;}
        body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;font-size:12px;line-height:1.42;margin:0;background:#fff;}
        .topLogo{text-align:center;margin:0 0 12px 0;}
        .topLogo img{max-width:165px;max-height:74px;height:auto;object-fit:contain;}
        .titleBox{border:1px solid #cbd5e1;background:#f8fafc;border-radius:10px;padding:14px 16px;margin-bottom:14px;}
        h1{font-size:26px;line-height:1.1;margin:0 0 10px 0;letter-spacing:-.3px;color:#020617;}
        .meta{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px;}
        .meta td{border:0;padding:3px 10px 3px 0;color:#334155;vertical-align:top;}
        .meta strong{color:#0f172a;}
        .section{margin-top:13px;page-break-inside:avoid;}
        h2{font-size:16px;margin:0 0 7px 0;padding-bottom:4px;border-bottom:1px solid #cbd5e1;color:#020617;}
        table{border-collapse:collapse;width:100%;font-size:11.4px;}
        th,td{border:1px solid #d7dee8;padding:7px 8px;text-align:left;vertical-align:top;}
        th{background:#eef2f7;width:30%;font-weight:700;color:#0f172a;}
        td{background:#fff;color:#111827;}
        .twoCol{width:100%;border-collapse:separate;border-spacing:0 0;margin:0;}
        .twoCol>tbody>tr>td{border:0;background:transparent;padding:0 7px 0 0;width:50%;}
        .twoCol>tbody>tr>td:last-child{padding-right:0;padding-left:7px;}
        .note{margin-top:10px;padding:10px 11px;border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;white-space:pre-wrap;font-size:11.4px;page-break-inside:avoid;}
        .note strong{font-size:12px;color:#020617;}
        .confirm{border-color:#86efac;background:#f0fdf4;}
        .qrBox{margin:0 auto 12px auto;max-width:380px;text-align:center;border:2px solid #020617;border-radius:12px;padding:12px 14px;background:#fff;page-break-inside:avoid;}
        .qrBox .label{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#475569;font-weight:700;margin-bottom:8px;}
        .qrBox img{width:118px;height:118px;object-fit:contain;display:block;margin:0 auto 8px auto;}
        .qrBox .hint{font-size:11px;color:#0f172a;font-weight:700;margin-bottom:3px;}
        .qrBox .link{font-size:9.8px;color:#475569;word-break:break-all;}
        .signatureBox{margin-top:16px;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;page-break-inside:avoid;}
        .signatureBox .sigTitle{font-weight:700;color:#020617;margin-bottom:8px;}
        .signatureBox img{max-width:190px;max-height:62px;width:auto;height:auto;object-fit:contain;display:block;margin:4px 0 8px 0;}
        .signatureBox .sigName{font-weight:700;color:#0f172a;}
        .footer{margin-top:18px;border-top:1px solid #cbd5e1;padding-top:8px;color:#64748b;font-size:10.5px;text-align:center;}
      </style>`,
      `</head><body>`,
      `<div class="topLogo"><img src="${logo}" alt="flymonitor.de Logo" /></div>`,
      `<div class="qrBox"><div class="label">Behörden-Login</div><img src="${qrImageUrl}" alt="QR-Code Behörden-Login" /><div class="hint">QR-Code scannen und Behörden-Login öffnen</div><div class="link">${escapeHtml(authorityQrLink)}</div></div>`,
      `<div class="titleBox">`,
      `<h1>Drohnenflug-Anmeldung</h1>`,
      `<table class="meta"><tbody>`,
      `<tr><td><strong>Vorgangsnummer:</strong> ${safe(entry.registrationNumber)}</td><td><strong>Flugdatum:</strong> ${safe(formatGermanDate(entry.date))}</td></tr>`,
      `<tr><td><strong>Erstellt / gespeichert:</strong> ${safe(formatGermanDateTime(entry.savedAt))}</td><td><strong>Behörden-PIN:</strong> ${safe(authorityPin)}</td></tr>`,
      `<tr><td><strong>Behörden-Link:</strong> ${escapeHtml(authorityLink)}</td><td><strong>Status:</strong> ${safe(entry.status || "Geplant")}</td></tr>`,
      `</tbody></table>`,
      `</div>`,

      `<table class="twoCol"><tbody><tr><td>`,
      section("Kontaktdaten", [
        row("Firma", entry.company),
        row("Ansprechpartner", entry.contactName),
        row("E-Mail", entry.email),
        row("Telefon", entry.phone),
        row("Anschrift", fullAddress),
      ].join("")),
      `</td><td>`,
      section("Pilot / Betreiber", [
        row("Betreiber-ID", entry.operatorId),
        row("Pilot", entry.pilot),
        row("Spotter / Beobachter", (entry.spotterAvailable || "Nein") === "Ja" ? (entry.spotterName || "Ja") : "Nein"),
        (entry.spotterAvailable || "Nein") === "Ja" ? row("Telefon Beobachter", entry.spotterPhone) : "",
        (entry.spotterAvailable || "Nein") === "Ja" ? row("Kommunikationsmittel", entry.communicationMethod) : "",
        row("Ausnahmegenehmigung", entry.exceptionPermit),
        row("Kompetenznachweis / Lizenz", entry.license),
        row("Fernpiloten-ID", entry.remotePilotId),
        row("Versicherung", entry.insurance),
        row("Versicherungsnummer", entry.insuranceNumber),
      ].join("")),
      `</td></tr></tbody></table>`,
'<div style="page-break-before: always;"></div>',
      section("Flugdaten", [
        row("Flugdatum", formatGermanDate(entry.date)),
        row("Uhrzeit von / bis", flightTime),
        row("Fluggebiet / Einsatzstelle", entry.flightArea || entry.city),
        row("Koordinaten", entry.coordinates),
        row("Max. Flughöhe", entry.maxHeight ? `${entry.maxHeight} m` : ""),
      ].join("")),

      section("Drohne / Auftrag", [
        row("Drohnenmodell", entry.drone),
        row("Gewicht", entry.weight ? `${entry.weight} g` : ""),
        row("Zweck des Fluges", entry.purpose),
        row("Strecke", cleanManualDistanceKm(entry.distanceKm) ? `${cleanManualDistanceKm(entry.distanceKm)} km` : ""),
        row("Akku Start / Ende", batteryText),
        row("Wetter", entry.weather),
        row("Wind / Böen", entry.wind || entry.gusts ? `${entry.wind || "-"} / ${entry.gusts || "-"} km/h` : ""),
        row("Vorkommnisse", entry.incidents || "Keine"),
      ].join("")),

      `<div class="note"><strong>Sicherheitsvorkehrungen</strong><br/><br/>${escapeHtml(safetyText)}</div>`,
      `<div class="note confirm"><strong>Rechtliche Bestätigung</strong><br/><br/>${escapeHtml(legalText)}<br/><br/><strong>Status:</strong> ${escapeHtml(yesNo(entry.legalConfirm))}</div>`,
      `<div class="note"><strong>Bemerkungen / Notizen</strong><br/><br/>${escapeHtml(entry.notes || "-")}</div>`,
      showDigitalSignature
        ? `<div class="signatureBox"><div class="sigTitle">${escapeHtml(signatureTitle)}</div><img src="${digitalSignature}" alt="Digitale Unterschrift" /><div class="sigName">${safe(entry.pilot || "Robert Bajela")}</div><div>FlyMonitor.de</div></div>`
        : "",
      `<div class="footer">flymonitor.de · Automatisch erzeugte UAS-Fluganmeldung · Ausdruck/PDF über Browser oder E-Mail-Versand</div>`,
      `</body></html>`].join("");
  }

  function printFlightRegistrationPdfWorking(entry) {
    openPrintWindow("Fluganmeldung", registrationHtml(entry));
  }

  async function printCompletedFlightPdfWorking(entry) {
    if (!entry) {
      alert("Bitte zuerst einen abgeschlossenen Flug auswählen.");
      return;
    }

    const pdfEntry = {
      ...entry,
      status: entry.status || "Erfolgt",
      startTime: entry.actualStartTime || entry.startTime || "",
      endTime: entry.actualEndTime || entry.endTime || "",
      wind: entry.actualWind || entry.wind || "",
      gusts: entry.actualGusts || entry.gusts || "",
      incidents: entry.actualIncidents || entry.incidents || "",
      notes: entry.actualNotes || entry.notes || "",
      savedAt: entry.completedAt || entry.savedAt || entry.updatedAt || new Date().toLocaleString("de-DE"),
    };

    try {
      const blob = await createFlightReportPdfBlob(pdfEntry);
      const url = URL.createObjectURL(blob);
      const fileName = `Abgeschlossener_Flug_${String(pdfEntry.registrationNumber || pdfEntry.authorityPin || "Flug").replace(/[^a-zA-Z0-9_-]+/g, "_")}.pdf`;

      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }

      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      console.error("PDF für abgeschlossenen Flug konnte nicht erstellt werden:", error);
      alert("PDF konnte nicht erstellt werden. Bitte später erneut versuchen.");
    }
  }



  function printDroneLogbookPdfWorking() {
    const rows = buildDroneLogbookRows(filteredCompletedFlights);
    if (!rows.length) {
      alert("Keine abgeschlossenen Flüge für das Drohnen-Logbuch im aktuellen Filter vorhanden.");
      return;
    }

    const pdf = createPdfDocument({ unit: "mm", format: "a4", orientation: "landscape" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const createdAt = new Date().toLocaleString("de-DE");
    const totalMinutes = rows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
    const droneCount = new Set(rows.map((row) => row.drone).filter(Boolean)).size;
    const inspections = rows.filter((row) => row.authorityInspection === "Ja").length;
    const activeFilters = [
      completedFlightSearch ? `Suche: ${completedFlightSearch}` : "",
      completedFlightFilterFrom ? `Von: ${completedFlightFilterFrom}` : "",
      completedFlightFilterTo ? `Bis: ${completedFlightFilterTo}` : "",
      completedFlightFilterPilot ? `Pilot: ${completedFlightFilterPilot}` : "",
      completedFlightFilterDrone ? `Drohne: ${completedFlightFilterDrone}` : "",
    ].filter(Boolean).join(" · ") || "Alle abgeschlossenen Flüge";

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(26);
    pdf.text("Drohnen-Logbuch", pageWidth / 2, 48, { align: "center" });

    pdf.setFontSize(13);
    pdf.setFont("helvetica", "normal");
    pdf.text("Automatisch erstellt aus abgeschlossenen Flügen", pageWidth / 2, 60, { align: "center" });

    pdf.setFontSize(11);
    pdf.text(`Erstellt am: ${createdAt}`, pageWidth / 2, 75, { align: "center" });
    pdf.text(`Filter: ${activeFilters}`, pageWidth / 2, 84, { align: "center" });

    const summaryRows = [
      ["Gesamtflüge", rows.length],
      ["Gesamtflugzeit", formatTotalFlightTime(totalMinutes)],
      ["Drohnen", droneCount],
      ["Behördenkontrollen", inspections],
    ];

    let coverY = 105;
    summaryRows.forEach(([label, value]) => {
      pdf.setDrawColor(203, 213, 225);
      pdf.setFillColor(248, 250, 252);
      pdf.rect(pageWidth / 2 - 55, coverY - 6, 110, 12, "FD");
      pdf.setFont("helvetica", "bold");
      pdf.text(String(label), pageWidth / 2 - 50, coverY + 1);
      pdf.setFont("helvetica", "normal");
      pdf.text(String(value), pageWidth / 2 + 50, coverY + 1, { align: "right" });
      coverY += 15;
    });

    pdf.setFontSize(9);
    pdf.text("Hinweis: Leere Felder wurden nicht automatisch ergänzt. Wetter/Wind erscheinen nur, wenn sie erfasst wurden.", pageWidth / 2, pageHeight - 20, { align: "center" });

    pdf.addPage();

    let y = 16;
    const addHeader = () => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(15);
      pdf.text("Drohnen-Logbuch", margin, y);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8.5);
      pdf.text(`Erstellt am: ${createdAt}`, pageWidth - margin, y, { align: "right" });
      y += 7;
      pdf.text(`Filter: ${activeFilters}`, margin, y);
      y += 6;
      pdf.text(`Gesamtflüge: ${rows.length} · Gesamtflugzeit: ${formatTotalFlightTime(totalMinutes)} · Drohnen: ${droneCount} · Behördenkontrollen: ${inspections}`, margin, y);
      y += 7;
    };

    const drawRow = (values, isHeader = false) => {
      const widths = [24, 36, 34, 42, 28, 26, 22, 22, 24, 28, 44];
      let x = margin;
      const rowHeight = isHeader ? 8 : 10;

      pdf.setFont("helvetica", isHeader ? "bold" : "normal");
      pdf.setFontSize(isHeader ? 8 : 7.2);

      values.forEach((value, index) => {
        const width = widths[index];
        pdf.setDrawColor(203, 213, 225);
        pdf.setFillColor(isHeader ? 241 : 255, isHeader ? 245 : 255, isHeader ? 249 : 255);
        pdf.rect(x, y, width, rowHeight, "FD");

        const lines = pdf.splitTextToSize(String(value || "-"), width - 3).slice(0, 2);
        pdf.text(lines, x + 1.5, y + 4.5);
        x += width;
      });

      y += rowHeight;
    };

    const tableHeader = ["Datum", "Vorgang", "Drohne", "Pilot", "Start/Ende", "Dauer", "Höhe", "Wind/Böen", "Status", "Akku", "Fluggebiet"];

    addHeader();
    drawRow(tableHeader, true);

    rows.forEach((row) => {
      if (y > pageHeight - 20) {
        pdf.addPage();
        y = 16;
        addHeader();
        drawRow(tableHeader, true);
      }

      drawRow([
        row.date,
        row.registrationNumber || row.authorityPin,
        row.drone,
        row.pilot,
        [row.startTime, row.endTime].filter(Boolean).join(" - "),
        row.duration,
        row.maxHeight ? `${row.maxHeight} m` : "",
        [row.wind ? `${row.wind}` : "", row.gusts ? `${row.gusts}` : ""].filter(Boolean).join(" / "),
        row.status,
        [row.batteryStart ? `${row.batteryStart}%` : "", row.batteryEnd ? `${row.batteryEnd}%` : ""].filter(Boolean).join(" / "),
        row.flightArea,
      ]);
    });

    const pageCount = pdf.internal.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.text(`Seite ${page} von ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
      pdf.text("DroneReady / FlyMonitor", margin, pageHeight - 8);
    }

    pdf.save(`Drohnen_Logbuch_${new Date().toISOString().slice(0, 10)}.pdf`);
  }


  function printSingleReport(entry) {
    openPrintWindow("Flugbericht", reportHtml(entry));
  }

  function printLogbookPdfWorking() {
    const rows = logbook.length
      ? logbook.map((e) => `<tr><td>${e.registrationNumber || ""}</td><td>${e.date || ""}</td><td>${e.city || ""}</td><td>${e.pilot || ""}</td><td>${e.drone || ""}</td><td>${e.purpose || ""}</td><td>${e.distanceKm || ""}</td><td>${e.score || ""}/100</td><td>${e.notes || ""}</td></tr>`).join("")
      : `<tr><td colspan="9">Noch keine Logbucheinträge vorhanden.</td></tr>`;
    const html = [`<html><head><title>DroneReady Fluglogbuch</title>`,
      `<style>body{font-family:Arial,sans-serif;padding:28px;color:#0f172a}table{border-collapse:collapse;width:100%;font-size:12px;margin-top:18px}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:top}th{background:#f1f5f9}</style>`,
      `</head><body><h1>DroneReady Fluglogbuch</h1><p>Erstellt am ${new Date().toLocaleString("de-DE")} · ${logbook.length} Einträge</p><table><thead><tr><th>Vorgang</th><th>Datum</th><th>Ort</th><th>Pilot</th><th>Drohne</th><th>Zweck</th><th>km</th><th>Score</th><th>Notizen</th></tr></thead><tbody>${rows}</tbody></table></body></html>`].join("");
    openPrintWindow("Logbuch", html);
  }


  function exportMaintenanceCsvWorking() {
    const rows = [
      ["Datum", "Drohne", "Art", "Beschreibung", "Kosten", "Nächste Wartung", "Notizen"],
      ...maintenanceEntries.map((entry) => {
        const drone = droneAssets.find((item) => String(item.id) === String(entry.droneId));
        return [entry.date, getDroneDisplayName(drone), entry.type, entry.description, entry.costs, entry.nextMaintenance, entry.notes];
      }),
    ];
    downloadCsvFile(`wartungsbuch_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  function exportBatteryCsvWorking() {
    const rows = [
      ["Akku", "Drohne", "Seriennummer", "Ladezyklen", "Zustand %", "Status", "Kaufdatum", "Notizen"],
      ...batteryAssets.map((battery) => {
        const drone = droneAssets.find((item) => String(item.id) === String(battery.droneId));
        return [battery.name, getDroneDisplayName(drone), battery.serialNumber, battery.chargeCycles, battery.healthPercent, battery.status, battery.purchaseDate, battery.notes];
      }),
    ];
    downloadCsvFile(`akkuverwaltung_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  function exportAuthorityControlsCsvWorking() {
    const rows = [
      ["Vorgang", "Datum", "Pilot", "Drohne", "Behörde", "Dienststelle", "Ergebnis", "Bemerkungen"],
      ...completedFlights
        .filter((entry) => String(entry.authorityInspection || "").toLowerCase() === "ja" || entry.authorityType || entry.authorityOffice || entry.authorityResult)
        .map((entry) => [entry.registrationNumber, entry.date, entry.pilot, entry.drone, entry.authorityType, entry.authorityOffice, entry.authorityResult, entry.authorityInspectionNotes]),
    ];
    downloadCsvFile(`behoerdenkontrollen_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }

  function exportAnnualFlightsCsvWorking() {
    const rows = [
      ["Datum", "Vorgang", "Pilot", "Drohne", "Start", "Ende", "Flugzeit", "Fluggebiet", "Max. Höhe", "Status"],
      ...annualFlightRows.map((row) => [row.date, row.registrationNumber, row.pilot, row.drone, row.startTime, row.endTime, row.duration, row.flightArea, row.maxHeight, row.status]),
    ];
    downloadCsvFile(`drohnenbetriebsbuch_fluege_${annualReportYear}.csv`, rows);
  }

  function handleAnnualReportLogoUploadWorking(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!String(file.type || "").startsWith("image/")) {
      alert("Bitte eine Bilddatei als Logo auswählen.");
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAnnualReportLogo(String(reader.result || ""));
      event.target.value = "";
    };
    reader.onerror = () => {
      alert("Logo konnte nicht gelesen werden.");
      event.target.value = "";
    };
    reader.readAsDataURL(file);
  }

  function handleDigitalSignatureUploadWorking(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!String(file.type || "").startsWith("image/")) {
      alert("Bitte eine Bilddatei als Unterschrift auswählen.");
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setDigitalSignature(String(reader.result || ""));
      event.target.value = "";
    };
    reader.onerror = () => {
      alert("Unterschrift konnte nicht gelesen werden.");
      event.target.value = "";
    };
    reader.readAsDataURL(file);
  }

  async function generateAnnualOperationsPdfWorking() {
    const year = String(annualReportYear || new Date().getFullYear());
    const rows = buildDroneLogbookRows(completedFlights).filter((row) => getEntryYear(row.date) === year);
    const monthStats = groupFlightRowsByMonth(rows);
    const totalMinutes = rows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
    const controls = completedFlights.filter((entry) => getEntryYear(entry.date || entry.completedAt) === year && (String(entry.authorityInspection || "").toLowerCase() === "ja" || entry.authorityType || entry.authorityOffice || entry.authorityResult));
    const maint = maintenanceEntries.filter((entry) => getEntryYear(entry.date) === year);
    const droneStatsForYear = Array.from(new Set(rows.map((row) => row.drone).filter(Boolean))).map((drone) => {
      const droneRows = rows.filter((row) => row.drone === drone);
      const minutes = droneRows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
      return { drone, flights: droneRows.length, time: formatTotalFlightTime(minutes), minutes };
    }).sort((a, b) => b.flights - a.flights);

    const pdf = createPdfDocument({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 14;
    const contentTop = 42; // PDF-FIX: Abstand unter der Kopfzeile, damit nichts überlappt
    const contentBottom = pageHeight - 18;
    let y = 18;

    const logoForPdf = annualReportLogo || await loadImageAsDataUrl("/logo_neu.png").catch(() => "");

    const getLogoFormat = (dataUrl = "") => {
      if (dataUrl.includes("image/png")) return "PNG";
      if (dataUrl.includes("image/webp")) return "WEBP";
      return "JPEG";
    };

    const safeAddLogo = (x, yPos, maxWidth, maxHeight, align = "right") => {
      if (!logoForPdf) return false;

      try {
        const properties = pdf.getImageProperties(logoForPdf);
        const originalWidth = Number(properties?.width || 1);
        const originalHeight = Number(properties?.height || 1);
        const ratio = originalWidth / originalHeight;

        let drawWidth = Number(maxWidth || 0);
        let drawHeight = drawWidth / ratio;

        if (drawHeight > Number(maxHeight || 0)) {
          drawHeight = Number(maxHeight || 0);
          drawWidth = drawHeight * ratio;
        }

        const drawX = align === "center" ? x + (maxWidth - drawWidth) / 2 : align === "left" ? x : x + (maxWidth - drawWidth);
        const drawY = yPos + (maxHeight - drawHeight) / 2;

        pdf.addImage(logoForPdf, getLogoFormat(logoForPdf), drawX, drawY, drawWidth, drawHeight, undefined, "FAST");
        return true;
      } catch (error) {
        console.warn("Logo konnte nicht proportional in das PDF eingefügt werden:", error);
        return false;
      }
    };

    const safeAddSignature = (x, yPos, maxWidth, maxHeight, align = "left") => {
      if (!digitalSignature) return false;

      try {
        const properties = pdf.getImageProperties(digitalSignature);
        const originalWidth = Number(properties?.width || 1);
        const originalHeight = Number(properties?.height || 1);
        const ratio = originalWidth / originalHeight;

        let drawWidth = Number(maxWidth || 0);
        let drawHeight = drawWidth / ratio;

        if (drawHeight > Number(maxHeight || 0)) {
          drawHeight = Number(maxHeight || 0);
          drawWidth = drawHeight * ratio;
        }

        const drawX = align === "center" ? x + (maxWidth - drawWidth) / 2 : align === "right" ? x + (maxWidth - drawWidth) : x;
        const drawY = yPos + (maxHeight - drawHeight) / 2;

        pdf.addImage(digitalSignature, getLogoFormat(digitalSignature), drawX, drawY, drawWidth, drawHeight, undefined, "FAST");
        return true;
      } catch (error) {
        console.warn("Digitale Unterschrift konnte nicht proportional in das PDF eingefügt werden:", error);
        return false;
      }
    };

    const addPageIfNeeded = (needed = 12) => {
      if (y + needed > contentBottom) {
        pdf.addPage();
        y = contentTop;
      }
    };

    const heading = (text, size = 15) => {
      addPageIfNeeded(18);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(size);
      pdf.text(text, margin, y);
      y += size > 16 ? 12 : 8;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
    };

    const line = (label, value) => {
      addPageIfNeeded(7);
      pdf.setFont("helvetica", "bold");
      pdf.text(`${label}:`, margin, y);
      pdf.setFont("helvetica", "normal");
      pdf.text(String(value || "-"), margin + 45, y);
      y += 6;
    };

    const textBlock = (label, value, options = {}) => {
      const labelWidth = options.labelWidth || 42;
      const valueWidth = options.valueWidth || (pageWidth - margin * 2 - labelWidth - 4);
      const labelText = String(label || "-");
      const valueText = String(value || "-");
      const valueLines = pdf.splitTextToSize(valueText, valueWidth);
      const blockHeight = Math.max(7, valueLines.length * 5 + 2);

      addPageIfNeeded(blockHeight + 2);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8.5);
      pdf.text(pdf.splitTextToSize(`${labelText}:`, labelWidth), margin, y);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8.5);
      pdf.text(valueLines, margin + labelWidth + 4, y);
      y += blockHeight;
    };

    const toc = [
      ["1", "Deckblatt"],
      ["2", "Inhaltsverzeichnis"],
      ["3", "Flugübersicht"],
      ["4", "Flugstunden & Monatsübersicht"],
      ["5", "Drohnenübersicht"],
      ["6", "Behördenkontrollen"],
      ["7", "Wartungen"],
      ["8", "Dokumentenstatus"],
      ["9", "Akkuübersicht"],
      ["10", "Jahresstatistik"],
    ];

    // Deckblatt
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(28);
    pdf.text("Drohnenbetriebsbuch", margin, 34);
    pdf.setFontSize(18);
    pdf.text(`Jahresnachweis ${year}`, margin, 48);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.text("FlyMonitor.de · Robert Bajela", margin, 62);
    pdf.text(`Erstellt am ${new Date().toLocaleString("de-DE")}`, margin, 70);
    if (logoForPdf) {
      safeAddLogo(pageWidth - margin - 62, 24, 55, 32);
    }
    y = 92;
    line("Flüge", rows.length);
    line("Gesamtflugzeit", formatTotalFlightTime(totalMinutes));
    line("Durchschn. Flugdauer", rows.length ? formatTotalFlightTime(Math.round(totalMinutes / rows.length)) : "0:00 h");
    line("Behördenkontrollen", controls.length);
    line("Wartungen", maint.length);
    line("Aktive Drohnen", droneAssets.filter((drone) => drone.status !== "Außer Betrieb").length);
    line("Akkus", batteryAssets.length);
    line("Dokumente", `${mailPdfDocumentSummary.total} gesamt, ${mailPdfDocumentSummary.expiring} laufen bald ab, ${mailPdfDocumentSummary.expired} abgelaufen`);

    // Inhaltsverzeichnis
    pdf.addPage();
    y = contentTop;
    heading("Inhaltsverzeichnis", 20);
    pdf.setFontSize(10);
    toc.forEach(([number, title], index) => {
      addPageIfNeeded(8);
      pdf.setFont("helvetica", "bold");
      pdf.text(number, margin, y);
      pdf.setFont("helvetica", "normal");
      pdf.text(title, margin + 14, y);
      pdf.text(`${index + 1}`, pageWidth - margin, y, { align: "right" });
      y += 8;
    });

    // Flugübersicht
    pdf.addPage();
    y = contentTop;
    heading("Flugübersicht", 16);
    const flightHeader = ["Datum", "Vorgang", "Drohne", "Pilot", "Zeit", "Dauer", "Ort"];
    const colWidths = [22, 36, 36, 30, 24, 18, 120];
    const drawTableRow = (cells, bold = false) => {
      addPageIfNeeded(8);
      let x = margin;
      pdf.setFont("helvetica", bold ? "bold" : "normal");
      pdf.setFontSize(7.5);
      cells.forEach((cell, index) => {
        const width = colWidths[index] || 24;
        const text = pdf.splitTextToSize(String(cell || ""), width - 2).slice(0, 2);
        pdf.text(text, x + 1, y);
        x += width;
      });
      y += 7;
    };
    drawTableRow(flightHeader, true);
    rows.forEach((row) => drawTableRow([row.date, row.registrationNumber, row.drone, row.pilot, [row.startTime, row.endTime].filter(Boolean).join("-"), row.duration, row.flightArea]));
    if (!rows.length) {
      pdf.text("Keine Flüge für dieses Jahr vorhanden.", margin, y);
      y += 8;
    }

    // Flugstunden
    pdf.addPage();
    y = contentTop;
    heading("Flugstunden & Monatsübersicht", 16);
    monthStats.forEach((month) => {
      const barWidth = Math.min(90, month.flights * 8);
      addPageIfNeeded(8);
      pdf.setFont("helvetica", "normal");
      pdf.text(`${month.label}/${year}: ${month.flights} Flug/Flüge · ${formatTotalFlightTime(month.minutes)}`, margin, y);
      pdf.rect(margin + 86, y - 4, barWidth, 4, "F");
      y += 7;
    });

    // Drohnenübersicht
    pdf.addPage();
    y = contentTop;
    heading("Drohnenübersicht", 16);
    droneStatsForYear.forEach((item) => {
      line(item.drone, `${item.flights} Flug/Flüge · ${item.time}`);
    });
    if (!droneStatsForYear.length) { pdf.text("Keine Drohnenflüge in diesem Jahr dokumentiert.", margin, y); y += 8; }

    // Behörden
    pdf.addPage();
    y = contentTop;
    heading("Behördenkontrollen", 16);
    controls.forEach((entry) => {
      addPageIfNeeded(24);
      pdf.setFont("helvetica", "bold");
      pdf.text(`${entry.date || "-"} · ${entry.registrationNumber || "-"}`, margin, y);
      y += 6;
      pdf.setFont("helvetica", "normal");
      const lines = pdf.splitTextToSize(`${entry.authorityType || "Behörde"} · ${entry.authorityOffice || ""} · ${entry.authorityResult || ""}`, pageWidth - margin * 2);
      pdf.text(lines, margin, y);
      y += Math.max(10, lines.length * 5 + 3);
    });
    if (!controls.length) { pdf.text("Keine Behördenkontrollen dokumentiert.", margin, y); y += 8; }

    // Wartungen
    pdf.addPage();
    y = contentTop;
    heading("Wartungen", 16);
    maint.forEach((entry) => {
      const drone = droneAssets.find((item) => String(item.id) === String(entry.droneId));
      addPageIfNeeded(16);
      line(`${entry.date || "-"} · ${getDroneDisplayName(drone)}`, `${entry.type || "Wartung"} · ${entry.costs ? `${entry.costs} €` : ""}`);
      if (entry.description) textBlock("Beschreibung", entry.description);
    });
    if (!maint.length) { pdf.text("Keine Wartungen in diesem Jahr dokumentiert.", margin, y); y += 8; }

    // Dokumentenstatus
    pdf.addPage();
    y = contentTop;
    heading("Dokumentenstatus", 16);
    const documentStatusLabel = (document) => {
      const status = getMailPdfDocumentStatus(document);
      return status.label || "-";
    };
    if (mailPdfDocuments.length) {
      mailPdfDocuments.forEach((document, index) => {
        const title = document.title || document.name || `Dokument ${index + 1}`;
        const titleLines = pdf.splitTextToSize(String(title), pageWidth - margin * 2);
        addPageIfNeeded(36 + titleLines.length * 5);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9.5);
        pdf.text(titleLines, margin, y);
        y += titleLines.length * 5 + 2;
        textBlock("Kategorie", document.category || "Sonstiges");
        textBlock("Dokumentnummer", document.documentNumber || "-");
        textBlock("Ausgestellt am", formatMailPdfGermanDate(document.issuedAt) || "-");
        textBlock("Gültig bis", formatMailPdfGermanDate(document.validUntil) || "-");
        textBlock("Auto-Anhang", document.autoAttach ? "Ja" : "Nein");
        textBlock("Status", documentStatusLabel(document));
        y += 3;
      });
    } else {
      pdf.text("Keine PDF-Dokumente hinterlegt.", margin, y);
      y += 8;
    }

    // Akkus
    pdf.addPage();
    y = contentTop;
    heading("Akkuübersicht", 16);
    if (batteryAssets.length) {
      batteryAssets.forEach((battery, index) => {
        const drone = droneAssets.find((item) => String(item.id) === String(battery.droneId));
        const title = battery.name || battery.serialNumber || `Akku ${index + 1}`;
        addPageIfNeeded(30);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9.5);
        pdf.text(String(title), margin, y);
        y += 6;
        textBlock("Drohne", getDroneDisplayName(drone));
        textBlock("Seriennummer", battery.serialNumber || "-");
        textBlock("Ladezyklen", battery.chargeCycles || 0);
        textBlock("Zustand", `${battery.healthPercent || "-"}% · ${battery.status || ""}`);
        y += 3;
      });
    } else {
      pdf.text("Keine Akkus hinterlegt.", margin, y);
      y += 8;
    }

    // Jahresstatistik
    pdf.addPage();
    y = contentTop;
    heading("Jahresstatistik", 16);
    line("Gesamtflüge", rows.length);
    line("Gesamtflugzeit", formatTotalFlightTime(totalMinutes));
    line("Durchschnittliche Flugdauer", rows.length ? formatTotalFlightTime(Math.round(totalMinutes / rows.length)) : "0:00 h");
    line("Flüge pro Drohne", droneStatsForYear.map((item) => `${item.drone}: ${item.flights}`).join(" · ") || "-");
    y += 4;
    heading("Monatswerte", 13);
    monthStats.forEach((month) => {
      textBlock(`${month.label}/${year}`, `${month.flights} Flug/Flüge · ${formatTotalFlightTime(month.minutes)}`);
    });


    if (signatureAnnualReport && digitalSignature) {
      pdf.addPage();
      y = 34;
      heading("Digitale Bestätigung", 18);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.text(`Erstellt am: ${new Date().toLocaleString("de-DE")}`, margin, y);
      y += 18;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(12);
      pdf.text("Verantwortlicher Fernpilot", margin, y);
      y += 12;
      safeAddSignature(margin, y, 62, 24, "left");
      y += 32;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11);
      pdf.text("Robert Bajela", margin, y);
      y += 7;
      pdf.setFont("helvetica", "normal");
      pdf.text("FlyMonitor.de", margin, y);
    }
    const pageCount = pdf.internal.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);

      if (page > 1) {
        // PDF-FIX: Kopfzeile nachträglich setzen; Inhalt beginnt bei contentTop = 42.
        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, pageWidth, 24, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8.5);
        pdf.text("FlyMonitor.de", margin, 10);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7.5);
        pdf.text(`Drohnenbetriebsbuch ${year}`, margin, 15);

        if (logoForPdf) {
          safeAddLogo(pageWidth - margin - 32, 5, 30, 12);
        }

        pdf.setDrawColor(180, 220, 230);
        pdf.setLineWidth(0.2);
        pdf.line(margin, 22, pageWidth - margin, 22);
      }

      pdf.setDrawColor(180, 220, 230);
      pdf.setLineWidth(0.2);
      pdf.line(margin, pageHeight - 14, pageWidth - margin, pageHeight - 14);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.text(`FlyMonitor.de · Drohnenbetriebsbuch ${year} `, margin, pageHeight - 8);
      pdf.text(`Seite ${page} von ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
    }

    pdf.save(`Drohnenbetriebsbuch_${year}.pdf`);
  }


  function parseEmailList(value) {
    return String(value || "")
      .split(/[;,]/)
      .map((mail) => mail.trim())
      .filter(Boolean);
  }

  function saveEmailRecipientsToStorage(next) {
    setSavedEmailRecipients(next);
    localStorage.setItem("droneready_email_recipients", JSON.stringify(next));
  }

  function addSavedEmailRecipientWorking() {
    const emails = parseEmailList(newRecipientEmails);
    if (!emails.length) {
      alert("Bitte mindestens eine E-Mail-Adresse eintragen.");
      return;
    }

    const item = {
      id: Date.now(),
      category: getEffectiveRecipientCategory(),
      subcategory: getEffectiveRecipientSubcategory(getEffectiveRecipientCategory()),
      name: newRecipientName.trim() || emails.join(", "),
      responsibility: newRecipientResponsibility.trim(),
      emails,
      createdAt: new Date().toLocaleString("de-DE"),
    };

    saveEmailRecipientsToStorage([item, ...savedEmailRecipients].slice(0, 100));
    setNewRecipientName("");
    setNewRecipientResponsibility("");
    setNewRecipientEmails("");
    alert("Empfänger wurde gespeichert.");
  }

  function deleteSavedEmailRecipientWorking(id) {
    const next = savedEmailRecipients.filter((item) => item.id !== id);
    saveEmailRecipientsToStorage(next);
    setSelectedRecipientIds((ids) => ids.filter((itemId) => itemId !== id));
  }

  function startEditSavedEmailRecipient(recipient) {
    setEditingRecipientId(recipient.id);
    setEditRecipient({
      ...recipient,
      emailsText: (recipient.emails || []).join(", "),
    });
  }

  function cancelEditSavedEmailRecipient() {
    setEditingRecipientId(null);
    setEditRecipient({});
  }

  function saveEditedSavedEmailRecipientWorking() {
    const emails = parseEmailList(editRecipient.emailsText);
    if (!emails.length) {
      alert("Bitte mindestens eine E-Mail-Adresse eintragen.");
      return;
    }

    const next = savedEmailRecipients.map((item) =>
      item.id === editingRecipientId
        ? {
            ...item,
            category: String(editRecipient.category || "Ohne Kategorie").trim() || "Ohne Kategorie",
            name: String(editRecipient.name || emails.join(", ")),
            responsibility: String(editRecipient.responsibility || ""),
            subcategory: String(editRecipient.subcategory || ""),
            emails,
          }
        : item
    );

    saveEmailRecipientsToStorage(next);
    cancelEditSavedEmailRecipient();
  }

  function startEditRecipientCategory(category) {
    setEditingRecipientCategory(category);
    setEditRecipientCategoryName(category);
  }

  function cancelEditRecipientCategory() {
    setEditingRecipientCategory(null);
    setEditRecipientCategoryName("");
  }

  function saveEditedRecipientCategoryWorking(oldCategory) {
    const nextCategory = editRecipientCategoryName.trim() || "Ohne Kategorie";
    const next = savedEmailRecipients.map((item) =>
      (item.category || "Ohne Kategorie") === oldCategory
        ? { ...item, category: nextCategory }
        : item
    );

    saveEmailRecipientsToStorage(next);
    cancelEditRecipientCategory();
  }

  function deleteRecipientCategoryWorking(category) {
    if (!window.confirm(`Kategorie "${category}" und alle enthaltenen Empfänger wirklich löschen?`)) return;
    const removedIds = savedEmailRecipients
      .filter((item) => (item.category || "Ohne Kategorie") === category)
      .map((item) => item.id);
    const next = savedEmailRecipients.filter((item) => (item.category || "Ohne Kategorie") !== category);

    saveEmailRecipientsToStorage(next);
    setSelectedRecipientIds((ids) => ids.filter((id) => !removedIds.includes(id)));
    if (editingRecipientCategory === category) cancelEditRecipientCategory();
  }

  function toggleSavedEmailRecipient(id) {
    setSelectedRecipientIds((ids) =>
      ids.includes(id) ? ids.filter((itemId) => itemId !== id) : [...ids, id]
    );
  }

  function selectedAndManualRecipients() {
    const selectedEmails = savedEmailRecipients
      .filter((item) => selectedRecipientIds.includes(item.id))
      .flatMap((item) => item.emails || []);

    const manualEmails = parseEmailList(adminEmail);
    return Array.from(new Set([...selectedEmails, ...manualEmails])).join(",");
  }

  function emailLogbookWorking() {
    const recipients = selectedAndManualRecipients();

    if (!recipients) {
      alert("Bitte zuerst mindestens eine Empfänger-E-Mail eintragen oder gespeicherte Empfänger auswählen.");
      return;
    }

    const subject = encodeURIComponent("DroneReady Fluglogbuch");

    const bodyText = logbook.length
      ? logbook
          .map((entry, index) =>
            [
              `Flug ${index + 1}`,
              `Vorgang: ${entry.registrationNumber || ""}`,
              `Datum: ${entry.date || ""}`,
              `Ort: ${entry.city || ""}`,
              `Pilot: ${entry.pilot || ""}`,
              `Drohne: ${entry.drone || ""}`,
              `Zweck: ${entry.purpose || ""}`,
              `Notizen: ${entry.notes || ""}`,
            ].join("\n")
          )
          .join("\n\n--------------------\n\n")
      : "Es sind noch keine Logbucheinträge vorhanden.";

    const mailto =
      `mailto:${recipients}` +
      `?subject=${subject}` +
      `&body=${encodeURIComponent(bodyText)}`;

    window.location.href = mailto;
  }

    
  
  
  function saveEmailRecipientsWorking(next) {
    const clean = normalizeEmailRecipientList(next);

    setSavedEmailRecipients(clean);

    const value = JSON.stringify(clean);
    localStorage.setItem("droneready_email_recipients_touched", "1");
    localStorage.setItem("droneready_email_recipients", value);
    localStorage.setItem("emailRecipients", value);
    localStorage.setItem("flymonitor_email_recipients", value);
    localStorage.setItem("savedEmailRecipients", value);
  }

  function sameEmailRecipient(a, b) {
    if (!a || !b) return false;

    if (a.id && b.id && String(a.id) === String(b.id)) return true;

    const aEmails = (a.emails || []).map((email) => String(email).toLowerCase()).join("|");
    const bEmails = (b.emails || []).map((email) => String(email).toLowerCase()).join("|");

    return (
      String(a.category || "") === String(b.category || "") &&
      String(a.subcategory || "") === String(b.subcategory || "") &&
      String(a.name || "") === String(b.name || "") &&
      aEmails === bEmails
    );
  }

  function deleteEmailRecipientWorking(recipient) {
    if (!recipient) return;

    if (!window.confirm(`E-Mail-Empfänger „${recipient.name}“ wirklich löschen?`)) return;

    const removed = savedEmailRecipients.filter((item) => sameEmailRecipient(item, recipient));
    const removedIds = removed.map((item) => item.id);

    const next = savedEmailRecipients.filter((item) => !sameEmailRecipient(item, recipient));

    saveEmailRecipientsWorking(next);
    setSelectedRecipientIds((prev) => prev.filter((id) => !removedIds.includes(id)));
  }

  function deleteEmailSubcategoryWorking(category, subcategory) {
    const normalizedCategory = String(category || "Allgemein");
    const normalizedSubcategory = String(subcategory || "Allgemein");

    const affected = savedEmailRecipients.filter(
      (item) =>
        String(item.category || "Allgemein") === normalizedCategory &&
        String(item.subcategory || "Allgemein") === normalizedSubcategory
    );

    if (!affected.length) {
      alert("In dieser Unterkategorie wurden keine Empfänger gefunden.");
      return;
    }

    if (!window.confirm(`Unterkategorie „${normalizedSubcategory}“ mit ${affected.length} Empfänger(n) wirklich löschen?`)) return;

    const affectedIds = affected.map((item) => item.id);
    const next = savedEmailRecipients.filter((item) => !affectedIds.includes(item.id));

    saveEmailRecipientsWorking(next);
    setSelectedRecipientIds((prev) => prev.filter((id) => !affectedIds.includes(id)));
  }

  function deleteEmailCategoryWorking(category) {
    const normalizedCategory = String(category || "Allgemein");

    const affected = savedEmailRecipients.filter(
      (item) => String(item.category || "Allgemein") === normalizedCategory
    );

    if (!affected.length) {
      alert("In dieser Kategorie wurden keine Empfänger gefunden.");
      return;
    }

    if (!window.confirm(`Kategorie „${normalizedCategory}“ mit ${affected.length} Empfänger(n) wirklich löschen?`)) return;

    const affectedIds = affected.map((item) => item.id);
    const next = savedEmailRecipients.filter((item) => !affectedIds.includes(item.id));

    saveEmailRecipientsWorking(next);
    setSelectedRecipientIds((prev) => prev.filter((id) => !affectedIds.includes(id)));
  }

  function moveEmailRecipientWorking(recipient) {
    if (!recipient) return;

    const newCategory = window.prompt(
      "In welche Kategorie soll der Empfänger verschoben werden?",
      recipient.category || "Allgemein"
    );

    if (newCategory === null) return;

    const newSubcategory = window.prompt(
      "In welche Unterkategorie soll der Empfänger verschoben werden?",
      recipient.subcategory || ""
    );

    if (newSubcategory === null) return;

    const targetEmail = window.prompt(
      "Optional: Unterhalb welcher bestehenden E-Mail-Adresse einsortieren? Leer lassen = am Ende der neuen Unterkategorie.",
      ""
    );

    const rawCategory = normalizeRecipientCategoryName(newCategory) || "Allgemein";
    const targetCategory = findExistingRecipientCategory(recipientCategoryOptions, rawCategory) || rawCategory;

    const movedRecipient = {
      ...recipient,
      category: targetCategory,
      subcategory:
        normalizeRecipientCategoryName(newSubcategory)
          ? findExistingRecipientSubcategory(savedEmailRecipients, targetCategory, newSubcategory) ||
            normalizeRecipientCategoryName(newSubcategory)
          : "",
    };

    const withoutMoved = savedEmailRecipients.filter((item) => item.id !== recipient.id);

    if (targetEmail && targetEmail.trim()) {
      const normalizedTarget = targetEmail.trim().toLowerCase();
      const targetIndex = withoutMoved.findIndex((item) =>
        (item.emails || []).some((email) => String(email).toLowerCase() === normalizedTarget)
      );

      if (targetIndex >= 0) {
        const next = [
          ...withoutMoved.slice(0, targetIndex + 1),
          movedRecipient,
          ...withoutMoved.slice(targetIndex + 1),
        ];

        setSavedEmailRecipients(next);
        localStorage.setItem("droneready_email_recipients", JSON.stringify(next));
        localStorage.setItem("emailRecipients", JSON.stringify(next));
        localStorage.setItem("flymonitor_email_recipients", JSON.stringify(next));
        return;
      }

      alert("Ziel-E-Mail wurde nicht gefunden. Empfänger wird am Ende der neuen Unterkategorie eingefügt.");
    }

    const targetIndexes = withoutMoved
      .map((item, index) => ({ item, index }))
      .filter(({ item }) =>
        String(item.category || "Allgemein") === movedRecipient.category &&
        String(item.subcategory || "") === String(movedRecipient.subcategory || "")
      )
      .map(({ index }) => index);

    const insertAt = targetIndexes.length ? targetIndexes[targetIndexes.length - 1] + 1 : withoutMoved.length;

    const next = [
      ...withoutMoved.slice(0, insertAt),
      movedRecipient,
      ...withoutMoved.slice(insertAt),
    ];

    setSavedEmailRecipients(next);
    localStorage.setItem("droneready_email_recipients", JSON.stringify(next));
    localStorage.setItem("emailRecipients", JSON.stringify(next));
    localStorage.setItem("flymonitor_email_recipients", JSON.stringify(next));
  }


  function getEffectiveRecipientCategory() {
    const custom = normalizeRecipientCategoryName(newRecipientCategoryCustom);
    if (custom) {
      return findExistingRecipientCategory(recipientCategoryOptions, custom) || custom;
    }

    const selected = normalizeRecipientCategoryName(newRecipientCategory);
    if (selected) {
      return findExistingRecipientCategory(recipientCategoryOptions, selected) || selected;
    }

    return "Allgemein";
  }

  function getEffectiveRecipientSubcategory(category) {
    const custom = normalizeRecipientCategoryName(newRecipientSubcategoryCustom);
    if (custom) {
      return findExistingRecipientSubcategory(savedEmailRecipients, category, custom) || custom;
    }

    const selected = normalizeRecipientCategoryName(newRecipientSubcategory);
    if (selected) {
      return findExistingRecipientSubcategory(savedEmailRecipients, category, selected) || selected;
    }

    return "";
  }

function addBulkEmailRecipientsWorking() {
    const category = getEffectiveRecipientCategory();
    const subcategory = getEffectiveRecipientSubcategory(category);
    const parsed = parseEmailRecipientBulkInput(bulkRecipientInput, category, subcategory);

    if (!parsed.length) {
      alert("Bitte mindestens eine gültige E-Mail-Adresse eintragen.");
      return;
    }

    const next = normalizeEmailRecipientList([...savedEmailRecipients, ...parsed]);
    const newIds = parsed.map((recipient) => recipient.id);

    setSavedEmailRecipients(next);
    setSelectedRecipientIds((prev) => Array.from(new Set([...prev, ...newIds])));
    setBulkRecipientInput("");
    setNewRecipientCategoryCustom("");
    setNewRecipientSubcategoryCustom("");

    localStorage.setItem("droneready_email_recipients", JSON.stringify(next));
    localStorage.setItem("emailRecipients", JSON.stringify(next));
    localStorage.setItem("flymonitor_email_recipients", JSON.stringify(next));

    alert(`${parsed.length} Empfänger wurden in der Kategorie „${category}“ angelegt.`);
  }

  async function addMailPdfDocumentsWorking(fileList) {
    const files = Array.from(fileList || []).filter((file) =>
      file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""))
    );

    if (!files.length) {
      alert("Bitte eine oder mehrere PDF-Dateien auswählen.");
      return;
    }

    try {
      const newDocuments = await Promise.all(files.map(readFileAsCompletedFlightAttachment));
      const normalizedDocuments = newDocuments.map((file) =>
        normalizeMailPdfDocument({
          ...file,
          group: "PDF-Dokument",
          title: (file.name || "PDF-Dokument").replace(/\.pdf$/i, ""),
          category: "Sonstiges",
          reminderDays: 30,
          autoAttach: false,
          addedAt: file.addedAt || new Date().toLocaleString("de-DE"),
        })
      );

      const next = [...normalizedDocuments, ...normalizeMailPdfDocumentList(mailPdfDocuments || [])].slice(0, 50);
      setMailPdfDocuments(next);
      localStorage.setItem("droneready_mail_pdf_documents", JSON.stringify(next));
      alert(`${normalizedDocuments.length} PDF-Dokument(e) wurden hinterlegt.`);
    } catch (error) {
      console.error(error);
      alert(`PDF-Dokumente konnten nicht gelesen werden: ${error.message || error}`);
    }
  }

  function deleteMailPdfDocumentWorking(documentId) {
    if (!window.confirm("Dieses PDF-Dokument wirklich löschen?")) return;

    const next = normalizeMailPdfDocumentList(mailPdfDocuments || []).filter((document) => String(document.id) !== String(documentId));
    setMailPdfDocuments(next);
    setSelectedMailPdfDocumentIds((current) => current.filter((id) => String(id) !== String(documentId)));
    localStorage.setItem("droneready_mail_pdf_documents", JSON.stringify(next));
  }

  function toggleMailPdfDocumentSelection(documentId, checked) {
    setSelectedMailPdfDocumentIds((current) =>
      checked
        ? Array.from(new Set([...current, documentId]))
        : current.filter((id) => String(id) !== String(documentId))
    );
  }

  function updateMailPdfDocumentWorking(documentId, patch) {
    const next = normalizeMailPdfDocumentList(mailPdfDocuments).map((document) =>
      String(document.id) === String(documentId)
        ? normalizeMailPdfDocument({ ...document, ...patch })
        : document
    );
    setMailPdfDocuments(next);
    localStorage.setItem("droneready_mail_pdf_documents", JSON.stringify(next));
  }

  function getAutoAttachMailPdfDocumentIds() {
    return normalizeMailPdfDocumentList(mailPdfDocuments)
      .filter((document) => document.autoAttach)
      .map((document) => document.id);
  }

function openEmailDialogWorking(entry) {
    if (!entry) {
      alert("Keine Fluganmeldung ausgewählt.");
      return;
    }

    const defaultIds = Array.isArray(selectedRecipientIds) && selectedRecipientIds.length
      ? selectedRecipientIds
      : savedEmailRecipients.map((recipient) => recipient.id);

    setEmailEntry(entry);
    setEmailRecipientSelection(defaultIds);
    setSelectedMailPdfDocumentIds(getAutoAttachMailPdfDocumentIds());
    setEmailRecipientSearch("");
    setEmailDialogOpen(true);
  }

  function sendSelectedFlightEmailWorking() {
    if (!emailEntry) {
      alert("Keine Fluganmeldung ausgewählt.");
      return;
    }

    const cleanManual = String(adminEmail || "").trim();
    if (!emailRecipientSelection.length && !cleanManual) {
      alert("Bitte mindestens einen Empfänger auswählen oder manuell eintragen.");
      return;
    }

    setSelectedRecipientIds(emailRecipientSelection);
    setEmailDialogOpen(false);
    emailFlightRegistrationWorking(emailEntry, emailRecipientSelection, cleanManual, selectedMailPdfDocumentIds);
  }

  async function emailFlightRegistrationWorking(selectedEntry, recipientIdsOverride = null, manualEmailOverride = null, documentIdsOverride = null) {
    try {
      const availableRecipients = savedEmailRecipients.length
        ? savedEmailRecipients
        : loadEmailRecipientsFromAllKnownKeys();

      const recipientIdsToUse = Array.isArray(recipientIdsOverride)
        ? recipientIdsOverride
        : selectedRecipientIds;

      const selectedRecipients = availableRecipients.filter((recipient) =>
        recipientIdsToUse.includes(recipient.id)
      );

      const selectedEmails = selectedRecipients.flatMap((recipient) => recipient.emails || []);
      const manualEmails = String(manualEmailOverride ?? adminEmail ?? "")
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter(Boolean);

      const recipients = Array.from(new Set([...selectedEmails, ...manualEmails])).filter(Boolean);
      const documentIdsToUse = Array.isArray(documentIdsOverride)
        ? documentIdsOverride
        : selectedMailPdfDocumentIds;
      const selectedMailDocuments = normalizeMailPdfDocumentList(mailPdfDocuments || []).filter((document) =>
        documentIdsToUse.map(String).includes(String(document.id))
      );

      if (!recipients.length) {
        const restoredRecipients = loadEmailRecipientsFromAllKnownKeys();
        setSavedEmailRecipients(restoredRecipients);
        setSelectedRecipientIds(restoredRecipients.map((recipient) => recipient.id));

        alert("Empfänger wurden wiederhergestellt. Bitte jetzt erneut auf „Fluganmeldung senden“ klicken.");
        return;
      }

      let entryWithPin = buildExactSelectedFlightReportEntry(selectedEntry, logbook, createAuthorityPin);

      if (!entryWithPin) {
        alert("Die angeklickte Fluganmeldung wurde nicht gefunden.");
        return;
      }

      // PDF-Daten endgültig zusammenführen:
      // 1. gespeicherter Logbuch-Eintrag
      // 2. frischer localStorage-Eintrag
      // 3. aktueller Bearbeitungs-/Formularstand
      // Leere Felder überschreiben dabei NICHT mehr vorhandene Werte.
      const freshLogbook = safeLoad("droneready_logbook", logbook);
      const freshSameEntry =
        freshLogbook.find((item) => String(item.id) === String(selectedEntry?.id)) ||
        freshLogbook.find(
          (item) =>
            String(item.registrationNumber || "").trim() &&
            String(item.registrationNumber || "").trim() === String(entryWithPin.registrationNumber || "").trim()
        );

      const currentFormSameReg =
        String(flightReportForm?.registrationNumber || "").trim() &&
        String(flightReportForm.registrationNumber || "").trim() ===
          String(entryWithPin.registrationNumber || "").trim()
          ? flightReportForm
          : null;

      const editSameReg =
        String(editLogEntry?.registrationNumber || "").trim() &&
        String(editLogEntry.registrationNumber || "").trim() ===
          String(entryWithPin.registrationNumber || "").trim()
          ? editLogEntry
          : null;

      entryWithPin = mergeNonEmptyFields(
        entryWithPin,
        freshSameEntry,
        selectedEntry,
        editSameReg,
        currentFormSameReg
      );

      entryWithPin = hydrateEntryWithCurrentFormData(
        entryWithPin,
        flightReportForm,
        editLogEntry,
        editingLogId
      );

      const clickedRegistration = String(selectedEntry?.registrationNumber || "").trim();
      const pdfRegistration = String(entryWithPin.registrationNumber || "").trim();

      if (clickedRegistration && clickedRegistration !== pdfRegistration) {
        throw new Error(
          `Abbruch: Button gehört zu ${clickedRegistration}, PDF-Daten enthalten aber ${pdfRegistration}.`
        );
      }

      // Den exakt angeklickten Eintrag mit PIN zurück ins Logbuch schreiben.
      const next = logbook.map((item) =>
        String(item.id) === String(selectedEntry.id) ? entryWithPin : item
      );

      setLogbook(next);
      localStorage.setItem("droneready_logbook", JSON.stringify(next));

      const serverSaved = await saveFlightEntryToServer(entryWithPin);
      if (!serverSaved) {
        alert(
          "Die PIN wurde erzeugt, aber NICHT auf dem Server gespeichert.\n\n" +
          "Darum funktioniert die Behörden-PIN nicht.\n\n" +
          "Bitte prüfen:\n" +
          "1. /api/flight-store.php existiert\n" +
          "2. /api/data/ beschreibbar ist"
        );
        return;
      }

      const subject = `UAS-Fluganmeldung ${entryWithPin.registrationNumber} ${entryWithPin.city || ""}`.trim();

      const bodyText = [
        "Sehr geehrte Damen und Herren,",
        "",
        "anbei erhalten Sie die vollständige UAS-Fluganmeldung als PDF-Anhang.",
        "",
        `Vorgangsnummer: ${entryWithPin.registrationNumber}`,
        `Behörden-PIN: ${entryWithPin.authorityPin}`,
        `Behörden-Link: ${getAuthorityLink()}?pin=${encodeURIComponent(entryWithPin.authorityPin)}`,
        "",
        ...[
          ["Status", entryWithPin.status || "Geplant"],
          ["Aktualisiert am", formatFlightStatusTimestamp(entryWithPin.updatedAt)],
          ["Spotter / Beobachter", (entryWithPin.spotterAvailable || "Nein") === "Ja" ? (entryWithPin.spotterName || "Ja") : "Nein"],
          ["Telefon Beobachter", (entryWithPin.spotterAvailable || "Nein") === "Ja" ? entryWithPin.spotterPhone : ""],
          ["Kommunikationsmittel", (entryWithPin.spotterAvailable || "Nein") === "Ja" ? entryWithPin.communicationMethod : ""],
          ["Ausnahmegenehmigung", entryWithPin.exceptionPermit],
          ["Gültigkeit Ausnahmegenehmigung", formatGermanDate(entryWithPin.exceptionPermitValidUntil)],
          ["Kompetenznachweis / Lizenz", entryWithPin.license],
          ["Gültigkeit Kompetenznachweis / Lizenz", formatGermanDate(entryWithPin.licenseValidUntil)],
          ["Versicherung", entryWithPin.insurance],
          ["Versicherungsnummer", entryWithPin.insuranceNumber],
          ["Gültigkeit Versicherung", formatGermanDate(entryWithPin.insuranceValidUntil)],
          ["Storno-Begründung", entryWithPin.status === "Storno" ? entryWithPin.cancellationReason : ""],
          ["Neuer Termin", entryWithPin.status === "Verschiebung" ? `${formatGermanDate(entryWithPin.postponementDate)} ${entryWithPin.postponementStartTime || ""}${entryWithPin.postponementEndTime ? ` – ${entryWithPin.postponementEndTime}` : ""}`.trim() : ""],
          ["Dokumente & Medien", formatCompletedFlightAttachmentSummary(entryWithPin)],
          ["Zusätzliche PDF-Dokumente", selectedMailDocuments.map((document) => document.name || document.title || "PDF-Dokument").join(", ")],
        ]
          .filter(([, value]) => isFilledDisplayValue(value))
          .map(([label, value]) => `${label}: ${value}`),
        "",
        "Mit freundlichen Grüßen",
        "FlyMonitor.de",
      ].join("\n");

      const pdfBlob = await createFlightReportPdfBlob(entryWithPin);
      const fileName = `UAS-Fluganmeldung-${entryWithPin.registrationNumber}.pdf`;

      if (!pdfBlob || pdfBlob.size < 5000) {
        throw new Error(`Die erzeugte PDF ist zu klein (${pdfBlob?.size || 0} Bytes).`);
      }

      const confirmed = window.confirm(
        `Bitte prüfen:\n\nANGEKLICKTE Fluganmeldung: ${clickedRegistration || "-"}\nPDF wird erzeugt für: ${entryWithPin.registrationNumber}\nOrt: ${entryWithPin.flightArea || entryWithPin.city || "-"}\nBehörden-PIN: ${entryWithPin.authorityPin}\n\nNur senden, wenn diese Daten exakt stimmen.`
      );

      if (!confirmed) return;

      const formData = new FormData();
      formData.append("to", recipients.join(","));
      formData.append("recipients", recipients.join(","));
      formData.append("subject", subject);
      formData.append("message", bodyText);
      formData.append("registrationNumber", entryWithPin.registrationNumber);
      formData.append("authorityPin", entryWithPin.authorityPin);
      formData.append("pdfSource", "EXACT_CLICKED_LOGBOOK_OBJECT");
      formData.append("attachment", pdfBlob, fileName);

      if (entryWithPin.attachmentsIncludeInMail) {
        getCompletedFlightAttachmentList(entryWithPin).forEach((file, index) => {
          if (!file.dataUrl) return;
          try {
            formData.append("attachments[]", dataUrlToBlob(file.dataUrl), file.name || `anlage-${index + 1}`);
          } catch (error) {
            console.warn("Zusätzlicher Anhang konnte nicht angefügt werden:", file.name, error);
          }
        });
      }

      selectedMailDocuments.forEach((file, index) => {
        if (!file.dataUrl) return;
        try {
          formData.append("attachments[]", dataUrlToBlob(file.dataUrl), file.name || `PDF-Dokument-${index + 1}.pdf`);
        } catch (error) {
          console.warn("Hinterlegtes PDF-Dokument konnte nicht angefügt werden:", file.name, error);
        }
      });

      const response = await fetch("/api/send-flightmail-browser-pdf.php?v=multi-pdf-attachments-final", {
        method: "POST",
        body: formData,
        cache: "no-store",
      });

      const rawText = await response.text();
      let data = {};

      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = { ok: false, error: rawText || "Der Server hat keine gültige JSON-Antwort gesendet." };
      }

      if (!response.ok || !(data.ok || data.success)) {
        throw new Error(data.error || data.message || "Die E-Mail konnte nicht gesendet werden.");
      }

      alert(
        `PDF versendet.\n\nVorgangsnummer: ${entryWithPin.registrationNumber}\nBehörden-PIN: ${entryWithPin.authorityPin}\nAnhang: ${data.attachment || fileName}`
      );
    } catch (error) {
      console.error(error);
      alert(`Fehler beim PDF-E-Mail-Versand: ${error.message}`);
    }
  }

  function normalizeCompletedFlightForAuthority(entry) {
    if (!entry) return null;

    return {
      ...entry,
      actualStartTime: entry.actualStartTime || entry.realStartTime || entry.startActual || entry.startTime || "",
      actualEndTime: entry.actualEndTime || entry.realEndTime || entry.endActual || entry.endTime || "",
      actualIncidents: entry.actualIncidents || entry.incidents || "",
      actualNotes: entry.actualNotes || entry.notes || "",
      actualDistanceKm: entry.actualDistanceKm || entry.distanceKm || "",
      actualBatteryStart: entry.actualBatteryStart || entry.batteryStart || "",
      actualBatteryEnd: entry.actualBatteryEnd || entry.batteryEnd || "",
      actualWeather: entry.actualWeather || entry.weather || "",
      wind: entry.wind || entry.actualWind || "",
      gusts: entry.gusts || entry.actualGusts || "",
      actualWind: entry.actualWind || entry.wind || "",
      actualGusts: entry.actualGusts || entry.gusts || "",
      maxHeight: entry.maxHeight || "",
      maxDistance: entry.maxDistance || "",
      temperature: entry.temperature || "",
      authorityInspection: entry.authorityInspection || "",
      authorityInspectionNotes: entry.authorityInspectionNotes || "",
      updatedAt: entry.updatedAt || entry.completedAt || "",
    };
  }

  function findCompletedFlightForAuthorityReport(report, completedList = []) {
    if (!report) return null;

    const reportRegistration = String(report.registrationNumber || "").trim().toLowerCase();
    const reportId = String(report.id || "").trim();
    const reportPin = normalizeAuthorityPin(report.authorityPin);
    const reportPins = new Set([
      report.authorityPin,
      ...(Array.isArray(report.authorityPins) ? report.authorityPins : []),
    ].map(normalizeAuthorityPin).filter(Boolean));

    return (completedList || [])
      .map(normalizeCompletedFlightForAuthority)
      .find((completed) => {
        if (!completed) return false;

        const completedRegistration = String(completed.registrationNumber || "").trim().toLowerCase();
        if (reportRegistration && completedRegistration && reportRegistration === completedRegistration) return true;

        const completedId = String(completed.id || "").trim();
        const completedSourceId = String(completed.sourceLogbookId || completed.logbookId || "").trim();
        if (reportId && (completedId === reportId || completedSourceId === reportId)) return true;

        const completedPins = [
          completed.authorityPin,
          ...(Array.isArray(completed.authorityPins) ? completed.authorityPins : []),
        ].map(normalizeAuthorityPin).filter(Boolean);

        if (reportPin && completedPins.includes(reportPin)) return true;
        return completedPins.some((pin) => reportPins.has(pin));
      }) || null;
  }

  async function loadCompletedFlightsForAuthorityWorking() {
    const localCompleted = safeLoad("flymonitor_completed_flights", completedFlights);

    try {
      const result = await apiGetJson(COMPLETED_FLIGHTS_API);
      if (result?.ok && Array.isArray(result.items)) {
        setCompletedFlights(result.items);
        localStorage.setItem("flymonitor_completed_flights", JSON.stringify(result.items));
        return result.items;
      }
    } catch (error) {
      console.warn("Abgeschlossene Flüge konnten nicht vom Server geladen werden:", error);
    }

    return Array.isArray(localCompleted) ? localCompleted : [];
  }

  function attachCompletedFlightToAuthorityReport(report, completedList = []) {
    const completed = findCompletedFlightForAuthorityReport(report, completedList);
    if (!completed) return report;

    return {
      ...report,
      completedFlight: completed,
      completedAt: completed.completedAt || report.completedAt,
      actualStartTime: completed.actualStartTime || report.actualStartTime,
      actualEndTime: completed.actualEndTime || report.actualEndTime,
      actualIncidents: completed.actualIncidents || report.actualIncidents,
      actualNotes: completed.actualNotes || report.actualNotes,
      actualWeather: completed.actualWeather || report.actualWeather,
      wind: completed.actualWind || completed.wind || report.wind,
      gusts: completed.actualGusts || completed.gusts || report.gusts,
      actualWind: completed.actualWind || completed.wind || report.actualWind,
      actualGusts: completed.actualGusts || completed.gusts || report.actualGusts,
      maxHeight: completed.maxHeight || report.maxHeight,
      maxDistance: completed.maxDistance || report.maxDistance,
      temperature: completed.temperature || report.temperature,
      authorityInspection: completed.authorityInspection || report.authorityInspection,
      authorityType: completed.authorityType || report.authorityType,
      authorityControlDate: completed.authorityControlDate || report.authorityControlDate,
      authorityOffice: completed.authorityOffice || report.authorityOffice,
      authorityResult: completed.authorityResult || report.authorityResult,
      authorityInspectionNotes: completed.authorityInspectionNotes || report.authorityInspectionNotes,
      attachments: normalizeCompletedFlightAttachments(completed.attachments || report.attachments),
      attachmentsVisibleForAuthorities: completed.attachmentsVisibleForAuthorities !== false,
      attachmentsIncludeInPdf: completed.attachmentsIncludeInPdf !== false,
      attachmentsIncludeInMail: Boolean(completed.attachmentsIncludeInMail),
      updatedAt: completed.updatedAt || completed.completedAt || report.updatedAt,
      actualDistanceKm: completed.actualDistanceKm || report.actualDistanceKm,
      actualBatteryStart: completed.actualBatteryStart || report.actualBatteryStart,
      actualBatteryEnd: completed.actualBatteryEnd || report.actualBatteryEnd,
    };
  }

  async function findAuthorityReport() {
    const q = normalizeAuthorityPin(authorityQuery);

    if (!/^\d{6}$/.test(q)) {
      setAuthorityReport(null);
      setAuthorityError("Bitte eine gültige 6-stellige Behörden-PIN eingeben.");
      return;
    }

    const freshLocalLogbook = safeLoad("droneready_logbook", logbook);
    const completedForAuthority = await loadCompletedFlightsForAuthorityWorking();
    const localFound = freshLocalLogbook.find((entry) => entryHasAuthorityPin(entry, q));

    if (localFound) {
      setAuthorityError("");
      setAuthorityReport(attachCompletedFlightToAuthorityReport(localFound, completedForAuthority));
      setLogbook(freshLocalLogbook);
      return;
    }

    setAuthorityError("Fluganmeldung wird vom Server geladen ...");

    const serverFound = await getFlightEntryFromServerByPin(q);

    if (!serverFound) {
      setAuthorityReport(null);
      setAuthorityError(
        "Keine UAS-Fluganmeldung mit dieser PIN gefunden. Bitte prüfen Sie die PIN oder senden Sie die Fluganmeldung erneut."
      );
      return;
    }

    const next = mergeServerEntryIntoLocalLogbook(freshLocalLogbook, serverFound);
    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    setAuthorityError("");
    setAuthorityReport(attachCompletedFlightToAuthorityReport(serverFound, completedForAuthority));
  }

  function prepareEditableOpenFlightEntry(entry) {
    if (!entry) return null;

    const editable = {
      ...entry,
      id:
        entry.id ||
        entry.sourceLogbookId ||
        `log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      status: entry.status || "Geplant",
      safetyMeasures: entry.safetyMeasures || DEFAULT_SAFETY_MEASURES,
      legalConfirmationText: entry.legalConfirmationText || LEGAL_CONFIRMATION_TEXT,
    };

    const current = safeLoad("droneready_logbook", logbook);
    const editableRegistration = String(editable.registrationNumber || "").trim().toLowerCase();
    const editablePins = [
      editable.authorityPin,
      ...(Array.isArray(editable.authorityPins) ? editable.authorityPins : []),
    ]
      .map(normalizeAuthorityPin)
      .filter(Boolean);

    const existingIndex = (Array.isArray(current) ? current : []).findIndex((item) => {
      const itemRegistration = String(item?.registrationNumber || "").trim().toLowerCase();
      const sameRegistration = editableRegistration && itemRegistration && itemRegistration === editableRegistration;
      const sameId = item?.id && editable.id && String(item.id) === String(editable.id);
      const samePin = editablePins.some((pin) => entryHasAuthorityPin(item, pin));
      return sameId || sameRegistration || samePin;
    });

    const next = existingIndex >= 0
      ? current.map((item, index) => index === existingIndex ? { ...item, ...editable } : item)
      : [editable, ...(Array.isArray(current) ? current : [])].slice(0, 200);

    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    return existingIndex >= 0 ? { ...next[existingIndex], ...editable } : editable;
  }

  async function loadOpenFlightByPinWorking(pinValue = openFlightSearch) {
    const pin = normalizeAuthorityPin(pinValue);

    if (!/^\d{6}$/.test(pin)) {
      alert("Bitte eine gültige 6-stellige Behörden-PIN eingeben.");
      return null;
    }

    const freshLocalLogbook = safeLoad("droneready_logbook", logbook);
    const localFound = freshLocalLogbook.find((entry) => entryHasAuthorityPin(entry, pin));

    if (localFound) {
      const editable = prepareEditableOpenFlightEntry(localFound);
      setOpenFlightSearch(editable?.registrationNumber || pin);
      alert("Flug wurde lokal gefunden und in der Liste angezeigt.");
      return editable;
    }

    const serverFound = await getFlightEntryFromServerByPin(pin);

    if (!serverFound) {
      alert("Keine Fluganmeldung mit dieser PIN gefunden.");
      return null;
    }

    const next = mergeServerEntryIntoLocalLogbook(freshLocalLogbook, serverFound);
    const merged = next.find((entry) => entryHasAuthorityPin(entry, pin)) || serverFound;
    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    const editable = prepareEditableOpenFlightEntry(merged);
    setOpenFlightSearch(editable?.registrationNumber || serverFound.registrationNumber || pin);
    alert(`Flug ${editable?.registrationNumber || serverFound.registrationNumber || pin} wurde geladen und unter offene/geplante Flüge angezeigt.`);
    return editable;
  }

  async function loadOpenFlightByPinAndEditWorking(pinValue = openFlightSearch) {
    const editable = await loadOpenFlightByPinWorking(pinValue);
    if (editable) {
      startEditLogEntryWorking(editable);
    }
  }

  async function requestNewAuthorityPinWorking() {
    const mail = authorityPinRequestEmail.trim().toLowerCase();

    if (!mail || !mail.includes("@")) {
      alert("Bitte eine gültige E-Mail-Adresse für die neue PIN eingeben.");
      return;
    }

    const report = authorityReport;
    if (!report) {
      alert("Keine Fluganmeldung ausgewählt.");
      return;
    }

    const newPin = createAuthorityPin();
    const updated = {
      ...report,
      authorityPin: newPin,
      authorityPins: Array.from(
        new Set(
          [
            ...(Array.isArray(report.authorityPins) ? report.authorityPins : []),
            report.authorityPin,
            newPin,
          ]
            .map(normalizeAuthorityPin)
            .filter(Boolean)
        )
      ),
      pinCreatedAt: new Date().toLocaleString("de-DE"),
    };

    const next = logbook.map((entry) => (entry.id === updated.id ? updated : entry));
    setLogbook(next);
    localStorage.setItem("droneready_logbook", JSON.stringify(next));
    setAuthorityReport(updated);
    await saveFlightEntryToServer(updated);

    const subject = `Neue Behörden-PIN für UAS-Fluganmeldung ${updated.registrationNumber || ""}`.trim();
    const bodyText = [
      "Guten Tag,",
      "",
      "für die UAS-Fluganmeldung wurde eine neue Behörden-PIN erstellt.",
      "",
      `Behörden-PIN: ${newPin}`,
      `Vorgangsnummer: ${updated.registrationNumber || "-"}`,
      `Flugdatum: ${formatGermanDate(updated.date)}`,
      "",
      "Behörden-Login:",
      `${getAuthorityLink()}?pin=${encodeURIComponent(newPin)}`,
      "",
      "Mit freundlichen Grüßen",
      "FlyMonitor",
    ].join("\n");

    window.location.href =
      `mailto:${encodeURIComponent(mail)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(bodyText)}`;

    setAuthorityPinRequestEmail("");
    alert("Neue PIN wurde gespeichert. Das E-Mail-Programm wird mit der vorbereiteten PIN-Mail geöffnet.");
  }

  function addWaypointWorking() {
    const n = waypoints.length;
    const name = n === 0 ? "Start" : n === 1 ? "WP1" : `WP${n}`;
    setWaypoints([...waypoints, { name, latOffset: n * 0.006, lonOffset: n * 0.007 }]);
  }

  function deleteWaypointWorking(index) {
    setWaypoints((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
  }

  function resetWaypointsWorking() {
    if (!window.confirm("Alle Wegpunkte wirklich löschen?")) return;
    setWaypoints([]);
  }

  function saveDroneProfileWorking() {
    localStorage.setItem("droneready_drone", JSON.stringify({ ...droneProfile, savedAt: new Date().toLocaleString("de-DE") }));
    alert("Drohnenprofil wurde lokal gespeichert.");
  }

  useEffect(() => {
    const pinFromUrl = getPinFromCurrentUrl();

    if (!pinFromUrl || !/^\d{6}$/.test(pinFromUrl)) return;

    let cancelled = false;

    async function loadAuthorityReportFromUrl() {
      setActivePage("authority");
      setAuthorityQuery(pinFromUrl);

      const completedForAuthority = await loadCompletedFlightsForAuthorityWorking();
      const localFound = logbook.find((entry) => entryHasAuthorityPin(entry, pinFromUrl));

      if (localFound) {
        if (!cancelled) {
          setAuthorityReport(attachCompletedFlightToAuthorityReport(localFound, completedForAuthority));
          setAuthorityError("");
        }
        return;
      }

      if (!cancelled) {
        setAuthorityReport(null);
        setAuthorityError("Fluganmeldung wird vom Server geladen ...");
      }

      const serverFound = await getFlightEntryFromServerByPin(pinFromUrl);

      if (cancelled) return;

      if (serverFound) {
        const next = mergeServerEntryIntoLocalLogbook(logbook, serverFound);
        setLogbook(next);
        localStorage.setItem("droneready_logbook", JSON.stringify(next));
        setAuthorityReport(attachCompletedFlightToAuthorityReport(serverFound, completedForAuthority));
        setAuthorityError("");
      } else {
        setAuthorityReport(null);
        setAuthorityError("Keine UAS-Fluganmeldung mit dieser PIN gefunden. Bitte prüfen Sie die PIN oder fordern Sie eine neue PIN an.");
      }
    }

    loadAuthorityReportFromUrl();

    return () => {
      cancelled = true;
    };
  }, [logbook]);


  useEffect(() => {
    if (activePage !== "registrationForm") return;

    setFlightReportForm((prev) => {
      if (String(prev.registrationNumber || "").trim()) return prev;
      return {
        ...prev,
        registrationNumber: createUniqueRegistrationNumber(logbook),
      };
    });
  }, [activePage, logbook]);

  const cleanManualDistanceKm = (value) => {
    const v = String(value || "").trim();
    return v === "2.4" ? "" : v;
  };

  const cleanManualBatteryEnd = (value) => {
    const v = String(value || "").trim();
    return v === "31" ? "" : v;
  };

  const formatManualBattery = (startValue, endValue) => {
    const start = String(startValue || "").trim();
    const end = cleanManualBatteryEnd(endValue);

    if (!start && !end) return "";
    if (start && end) return `${start} → ${end}`;
    return start || end;
  };

  const wt = result.wind > 25 || result.gusts > 40 ? "danger-card" : result.wind > 18 ? "warning-card" : "good-card";
  const rt = result.rain > 50 ? "danger-card" : result.rain > 20 ? "warning-card" : "good-card";
  const st = score > 78 ? "good-card" : score > 54 ? "warning-card" : "danger-card";

  const goldenHourInfo = (() => {
    const parseTime = (value) => {
      const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
      if (!match) return null;
      return Number(match[1]) * 60 + Number(match[2]);
    };

    const toTime = (minutes) => {
      const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
      const h = String(Math.floor(normalized / 60)).padStart(2, "0");
      const m = String(normalized % 60).padStart(2, "0");
      return `${h}:${m}`;
    };

    const sr = parseTime(result.sunrise);
    const ss = parseTime(result.sunset);

    if (sr === null || ss === null) {
      return {
        sunrise: result.sunrise || "-",
        sunset: result.sunset || "-",
        morning: "-",
        evening: "-",
      };
    }

    return {
      sunrise: result.sunrise,
      sunset: result.sunset,
      morning: `${toTime(sr + 20)}–${toTime(sr + 80)}`,
      evening: `${toTime(ss - 80)}–${toTime(ss - 20)}`,
    };
  })();
  const aiFlightAssessment = (() => {
    const issues = [];

    if (Number(result.wind || 0) > 22) issues.push("Wind erhöht");
    if (Number(result.gusts || 0) > 35) issues.push("Böen kritisch");
    if (Number(result.rain || 0) > 35) issues.push("Regenrisiko erhöht");
    if (Number(result.visibility || 10) < 7) issues.push("Sichtweite eingeschränkt");

    if (issues.length) {
      return {
        status: result.status === "danger" ? "danger" : "warning",
        title: result.status === "danger"
          ? "KI-Flugbewertung: Flug verschieben"
          : "KI-Flugbewertung: eingeschränkt empfohlen",
        text: `${issues.join(", ")}. Vor dem Start Wetter, NOTAM, UAS-Zonen und RTH-Höhe erneut prüfen.`,
      };
    }

    return {
      status: "good",
      title: "KI-Flugbewertung: gutes Flugfenster",
      text: "Wetterwerte wirken geeignet. Trotzdem lokale Regeln, Sichtkontakt, Akkus und Einsatzgebiet vor Ort prüfen.",
    };
  })();
  const windHeights = (() => {
    const wind10 = Number(result.wind || 0);
    const gust10 = Number(result.gusts || wind10);

    return [
      { height: "10 m", wind: Math.round(wind10), gusts: Math.round(gust10) },
      { height: "80 m", wind: Math.round(wind10 * 1.25), gusts: Math.round(gust10 * 1.2) },
      { height: "120 m", wind: Math.round(wind10 * 1.4), gusts: Math.round(gust10 * 1.35) },
    ];
  })();

  function exportFlightCalendarWorking() {
    try {
      const pad = (value) => String(value).padStart(2, "0");

      const normalizeDate = (value) => {
        const raw = String(value || "").trim();

        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

        const german = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (german) {
          return `${german[3]}-${pad(german[2])}-${pad(german[1])}`;
        }

        return new Date().toISOString().slice(0, 10);
      };

      const normalizeTime = (value, fallback) => {
        const raw = String(value || "").trim();
        const match = raw.match(/^(\d{1,2}):(\d{2})$/);

        if (!match) return fallback;

        return `${pad(match[1])}:${pad(match[2])}`;
      };

      const date = normalizeDate(flightReportForm.date);
      const startTime = normalizeTime(flightReportForm.startTime, "10:00");
      const endTime = normalizeTime(flightReportForm.endTime, "11:00");

      const toIcsDate = (dateValue, timeValue) => {
        const [year, month, day] = dateValue.split("-").map(Number);
        const [hour, minute] = timeValue.split(":").map(Number);

        return `${year}${pad(month)}${pad(day)}T${pad(hour)}${pad(minute)}00`;
      };

      const escapeIcs = (value) =>
        String(value || "")
          .replace(/\\/g, "\\\\")
          .replace(/\r?\n/g, "\\n")
          .replace(/,/g, "\\,")
          .replace(/;/g, "\\;");

      const location = flightReportForm.flightArea || result.city || "Drohnenflug";
      const title = `Drohnenflug ${flightReportForm.registrationNumber || result.city || ""}`.trim();

      const description = [
        `Vorgangsnummer: ${flightReportForm.registrationNumber || "-"}`,
        `Ort: ${location}`,
        `Koordinaten: ${flightReportForm.coordinates || `${result.lat}, ${result.lon}`}`,
        `Wetter: ${result.summary || "-"}`,
        `Wind/Böen: ${result.wind || "-"} / ${result.gusts || "-"} km/h`,
        "Erinnerung wurde 30 Minuten vor Flugbeginn gesetzt.",
      ].join("\\n");

      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//flymonitor.de//Drohnenwetter//DE",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:pxfoto-${Date.now()}@flymonitor.de`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
        `DTSTART:${toIcsDate(date, startTime)}`,
        `DTEND:${toIcsDate(date, endTime)}`,
        `SUMMARY:${escapeIcs(title)}`,
        `LOCATION:${escapeIcs(location)}`,
        `DESCRIPTION:${escapeIcs(description)}`,
        "BEGIN:VALARM",
        "TRIGGER:-PT30M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Erinnerung Drohnenflug",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\\r\\n");

      const filename = `drohnenflug-${date}.ics`;
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      const blobUrl = URL.createObjectURL(blob);
      const dataUrl = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;

      setCalendarDownloadHref(dataUrl);
      setCalendarDownloadName(filename);

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      link.rel = "noopener";
      link.style.display = "none";

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

      setCalendarNotice("Kalenderdatei wurde erstellt. Falls kein Download startet, bitte den unten angezeigten Download-Link anklicken.");
    } catch (error) {
      console.error("Kalenderexport fehlgeschlagen:", error);
      setCalendarNotice("Kalenderdatei konnte nicht erstellt werden. Bitte den Browser-Download erlauben oder einen anderen Browser testen.");
    }
  }


  
  function saveTickerMessagesWorking(next) {
    setTickerMessages(next);
    localStorage.setItem("droneready_news_ticker", JSON.stringify(next));
  }

  function addTickerMessageWorking() {
    const textValue = tickerInput.trim();

    if (!textValue) return;

    const next = [
      {
        id: `ticker-${Date.now()}`,
        text: textValue,
        createdAt: new Date().toLocaleString("de-DE"),
      },
      ...tickerMessages,
    ].slice(0, 30);

    saveTickerMessagesWorking(next);
    setTickerInput("");
  }

  function startEditTickerMessageWorking(item) {
    setEditingTickerId(item.id);
    setEditingTickerText(item.text);
  }

  function saveEditedTickerMessageWorking() {
    const textValue = editingTickerText.trim();

    if (!textValue || !editingTickerId) return;

    const next = tickerMessages.map((item) =>
      item.id === editingTickerId
        ? { ...item, text: textValue, updatedAt: new Date().toLocaleString("de-DE") }
        : item
    );

    saveTickerMessagesWorking(next);
    setEditingTickerId(null);
    setEditingTickerText("");
  }

  function deleteTickerMessageWorking(id) {
    if (!window.confirm("Ticker-Meldung wirklich löschen?")) return;

    const next = tickerMessages.filter((item) => item.id !== id);
    saveTickerMessagesWorking(next);
  }

  async function submitAdminLoginModalWorking() {
    const ok = await unlockAdminWorking();
    if (ok) setShowAdminLoginModal(false);
  }

function AdminMenuControls({ showSource = false }) {
    return (
      <>
        <div
          className="navbuttons"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <button type="button" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
            {dark ? "Light" : "Dark"}
          </button>

          {adminUnlocked ? (
            <label className="templateSwitch" title="Template wechseln">
              <span>Template</span>
              <select
                value={activeTemplate}
                onChange={(event) => activateTemplateWorking(event.target.value)}
              >
                {professionalTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {!adminUnlocked ? (
            <button
              type="button"
              className="primary smallButton"
              onClick={() => setShowAdminLoginModal(true)}
            >
              Admin
            </button>
          ) : (
            <>
              {publicPreviewMode ? (
                <button
                  type="button"
                  className="primary smallButton"
                  onClick={() => {
                    setPublicPreviewMode(false);
                    setActivePage("home");
                    setAdminCenterTab("overview");
                    if (typeof window !== "undefined") {
                      window.location.hash = "";
                      window.history.replaceState(null, "", window.location.pathname + window.location.search);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }
                  }}
                >
                  Zurück ins Admin Center
                </button>
              ) : null}
              <span className="status good">Admin · {adminRole}</span>
              <button
              type="button"
              style={LOGOUT_BUTTON_STYLE}
              onClick={lockAdminWorking}
            >
              Admin Logout
            </button>
            </>
          )}

          {showSource ? <span>{source}</span> : null}
        </div>

        {showAdminLoginModal ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(15,23,42,.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
              padding: "20px",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: "420px",
                background: "#ffffff",
                borderRadius: "24px",
                padding: "28px",
                boxShadow: "0 25px 60px rgba(15,23,42,.25)",
              }}
            >
              <h2 style={{ marginBottom: "10px", color: "#0f172a" }}>
                Admin Login
              </h2>

              <p style={{ marginBottom: "18px", color: "#64748b" }}>
                Bitte Passwort eingeben. Die Session läuft nach 30 Minuten Inaktivität automatisch ab.
              </p>

              {adminNotice ? (
                <p style={{ marginBottom: "14px", color: "#0f172a", fontWeight: 700 }}>
                  {adminNotice}
                </p>
              ) : null}

              <input
                type="password"
                value={adminPasswordInput}
                onChange={(e) => setAdminPasswordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    submitAdminLoginModalWorking();
                  }
                }}
                autoFocus
                placeholder="Passwort"
                style={{
                  width: "100%",
                  height: "52px",
                  borderRadius: "16px",
                  border: "1px solid #cbd5e1",
                  padding: "0 16px",
                  fontSize: "16px",
                  marginBottom: "18px",
                  outline: "none",
                  color: "#0f172a",
                }}
              />

              <div
                style={{
                  display: "flex",
                  gap: "12px",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => setShowAdminLoginModal(false)}
                >
                  Abbrechen
                </button>

                <button
                  type="button"
                  className="primary smallButton"
                  onClick={() => {
                    submitAdminLoginModalWorking();
                  }}
                >
                  Login
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  function NewsTickerStyles() {
    return (
      <style>{`
        .newsTickerWrapper{
          width: min(1320px, calc(100% - 40px));
          margin: 18px auto 24px;
          background: rgba(255,255,255,0.92);
          border: 1px solid rgba(120,140,180,0.18);
          border-radius: 26px;
          overflow: hidden;
          backdrop-filter: blur(18px);
          box-shadow: 0 10px 35px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.65);
        }

        .newsTickerHeader{
          display: flex;
          align-items: center;
          gap: 14px;
          background: linear-gradient(135deg,#081226,#0f2747);
          color: #fff;
          padding: 12px 18px;
        }

        .newsTickerLabel{
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: rgba(34,197,94,.18);
          border: 1px solid rgba(134,239,172,.45);
          border-radius: 999px;
          padding: 7px 12px;
          font-weight: 900;
          letter-spacing: .9px;
          font-size: 12px;
          text-transform: uppercase;
        }

        .newsTickerTitle{
          font-weight: 800;
          font-size: 14px;
          opacity: .95;
        }

        .tickerViewport{
          overflow: hidden;
          white-space: nowrap;
          background: linear-gradient(90deg, rgba(255,255,255,1), rgba(248,250,255,1));
          border-top: 1px solid rgba(120,140,180,0.15);
        }

        /* Ticker-Speed-Fix-2400s */
        .tickerTrack{
          display: inline-flex;
          align-items: center;
          gap: 48px;
          padding: 18px 0;
          min-width: max-content;
          animation: tickerScroll 600s linear infinite;
        }

        .tickerTrack:hover{
          animation-play-state: paused;
        }

        .tickerItem{
          font-size: 15px;
          font-weight: 700;
          color: #0f172a;
          padding-left: 40px;
          position: relative;
        }

        .tickerItem::before{
          content: "";
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #16a34a;
          position: absolute;
          left: 14px;
          top: 50%;
          transform: translateY(-50%);
          box-shadow: 0 0 12px rgba(22,163,74,0.7);
        }

        @keyframes tickerScroll{
          from{ transform: translateX(0); }
          to{ transform: translateX(-50%); }
        }

        .templateSwitch{
          display: inline-flex;
          align-items: center;
          gap: 8px;
          height: 42px;
          padding: 0 10px 0 14px;
          border-radius: 999px;
          background: rgba(255,255,255,.92);
          border: 1px solid rgba(148,163,184,.32);
          box-shadow: 0 10px 28px rgba(15,23,42,.08);
          color: #0f172a;
          font-size: 13px;
          font-weight: 800;
        }

        .templateSwitch select{
          height: 30px;
          border: none;
          outline: none;
          border-radius: 999px;
          background: #0f172a;
          color: #fff;
          font-weight: 800;
          padding: 0 10px;
          cursor: pointer;
        }

        .template-executive{
          background:
            radial-gradient(circle at top left, rgba(59,130,246,.18), transparent 34%),
            linear-gradient(135deg, #f8fafc 0%, #eef4ff 45%, #f8fafc 100%);
        }

        .template-executive .card,
        .template-executive .logbookWide > .card{
          border: 1px solid rgba(148,163,184,.26);
          background: rgba(255,255,255,.94);
          box-shadow: 0 24px 70px rgba(15,23,42,.10);
        }

        .template-executive .nav{
          background: rgba(255,255,255,.86);
          border: 1px solid rgba(148,163,184,.24);
          border-radius: 30px;
          padding: 14px 18px;
          box-shadow: 0 20px 55px rgba(15,23,42,.09);
          backdrop-filter: blur(18px);
        }

        .template-executive .hero{
          background: linear-gradient(135deg, rgba(15,23,42,.96), rgba(30,64,175,.90));
          color: #fff;
          border: 1px solid rgba(255,255,255,.18);
          box-shadow: 0 30px 80px rgba(15,23,42,.20);
        }

        .template-aero{
          background:
            radial-gradient(circle at 20% 0%, rgba(14,165,233,.22), transparent 32%),
            radial-gradient(circle at 85% 15%, rgba(34,197,94,.16), transparent 30%),
            #f8fbff;
        }

        .template-aero .card,
        .template-aero .nav,
        .template-aero .logbookWide > .card{
          background: rgba(255,255,255,.72);
          border: 1px solid rgba(255,255,255,.72);
          box-shadow: 0 22px 60px rgba(2,132,199,.13);
          backdrop-filter: blur(22px);
        }

        .template-classic{
          background: #f7f8fb;
        }

        .template-classic .card,
        .template-classic .nav,
        .template-classic .logbookWide > .card{
          background: #ffffff;
          border: 1px solid #e2e8f0;
          box-shadow: 0 12px 30px rgba(15,23,42,.06);
        }



        .template-command{
          background:
            radial-gradient(circle at 14% 12%, rgba(56,189,248,.18), transparent 28%),
            radial-gradient(circle at 88% 4%, rgba(99,102,241,.16), transparent 30%),
            linear-gradient(135deg, #0f172a 0%, #111827 42%, #020617 100%);
          color: #e5eefb;
        }

        .template-command .card,
        .template-command .nav,
        .template-command .logbookWide > .card{
          background: rgba(15,23,42,.78);
          border: 1px solid rgba(125,211,252,.20);
          box-shadow: 0 28px 80px rgba(2,6,23,.34);
          backdrop-filter: blur(18px);
          color: #e5eefb;
        }

        .template-command .hero{
          background: linear-gradient(135deg, rgba(2,6,23,.96), rgba(8,47,73,.92));
          border: 1px solid rgba(125,211,252,.24);
          color: #ffffff;
        }

        .template-aviation{
          background:
            linear-gradient(90deg, rgba(2,132,199,.07) 1px, transparent 1px),
            linear-gradient(0deg, rgba(2,132,199,.06) 1px, transparent 1px),
            linear-gradient(135deg, #f8fafc 0%, #eaf3ff 100%);
          background-size: 42px 42px, 42px 42px, auto;
        }

        .template-aviation .card,
        .template-aviation .nav,
        .template-aviation .logbookWide > .card{
          background: rgba(255,255,255,.96);
          border: 1px solid rgba(37,99,235,.18);
          box-shadow: 0 22px 58px rgba(30,64,175,.10);
        }

        .template-aviation .hero{
          background: linear-gradient(135deg, #ffffff, #edf6ff);
          border: 1px solid rgba(37,99,235,.18);
          color: #0f172a;
        }

        .template-stealth{
          background:
            radial-gradient(circle at top, rgba(20,184,166,.12), transparent 36%),
            linear-gradient(135deg, #020617 0%, #09090b 52%, #111827 100%);
          color: #f8fafc;
        }

        .template-stealth .card,
        .template-stealth .nav,
        .template-stealth .logbookWide > .card{
          background: rgba(9,9,11,.86);
          border: 1px solid rgba(255,255,255,.12);
          box-shadow: 0 28px 85px rgba(0,0,0,.38);
          color: #f8fafc;
        }

        .template-stealth .hero{
          background: linear-gradient(135deg, #020617, #111827);
          border: 1px solid rgba(34,211,238,.20);
          color: #ffffff;
        }

        .template-safety{
          background:
            repeating-linear-gradient(135deg, rgba(15,23,42,.035) 0 12px, transparent 12px 28px),
            linear-gradient(135deg, #fff7ed 0%, #fffbeb 50%, #f8fafc 100%);
        }

        .template-safety .card,
        .template-safety .nav,
        .template-safety .logbookWide > .card{
          background: rgba(255,255,255,.94);
          border: 1px solid rgba(245,158,11,.28);
          box-shadow: 0 24px 64px rgba(180,83,9,.11);
        }

        .template-safety .hero{
          background: linear-gradient(135deg, #111827, #92400e);
          border: 1px solid rgba(251,191,36,.35);
          color: #ffffff;
        }

        .template-minimal{
          background: #ffffff;
        }

        .template-minimal .card,
        .template-minimal .nav,
        .template-minimal .logbookWide > .card{
          background: #ffffff;
          border: 1px solid #e5e7eb;
          box-shadow: 0 8px 22px rgba(15,23,42,.045);
        }

        .template-minimal .hero{
          background: #ffffff;
          border: 1px solid #e5e7eb;
          color: #111827;
          box-shadow: 0 14px 36px rgba(15,23,42,.06);
        }

        .template-ocean{
          background:
            radial-gradient(circle at 12% 10%, rgba(45,212,191,.22), transparent 34%),
            radial-gradient(circle at 90% 18%, rgba(14,165,233,.18), transparent 30%),
            linear-gradient(135deg, #ecfeff 0%, #eff6ff 52%, #f8fafc 100%);
        }

        .template-ocean .card,
        .template-ocean .nav,
        .template-ocean .logbookWide > .card{
          background: rgba(255,255,255,.82);
          border: 1px solid rgba(6,182,212,.22);
          box-shadow: 0 24px 68px rgba(8,145,178,.12);
          backdrop-filter: blur(18px);
        }

        .template-ocean .hero{
          background: linear-gradient(135deg, #083344, #0891b2);
          border: 1px solid rgba(103,232,249,.28);
          color: #ffffff;
        }

        .designCenter .sectionHead{
          align-items: flex-start;
        }

        .templateGrid{
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
          margin-top: 18px;
        }

        .templateCard{
          text-align: left;
          min-height: 138px;
          padding: 18px;
          border-radius: 22px;
          border: 1px solid rgba(148,163,184,.28);
          background: rgba(255,255,255,.78);
          box-shadow: 0 16px 42px rgba(15,23,42,.08);
          display: flex;
          flex-direction: column;
          gap: 9px;
          cursor: pointer;
          color: inherit;
          transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
        }

        .templateCard:hover{
          transform: translateY(-2px);
          box-shadow: 0 22px 58px rgba(15,23,42,.13);
        }

        .templateCard.active{
          border-color: #00b2e2;
          box-shadow: 0 24px 68px rgba(0,178,226,.18);
        }

        .templateCard strong{
          font-size: 17px;
        }

        .templateCard small{
          color: #64748b;
          line-height: 1.45;
        }

        .templateBadge{
          align-self: flex-start;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: .08em;
          text-transform: uppercase;
          border-radius: 999px;
          padding: 5px 9px;
          background: rgba(0,178,226,.12);
          color: #0369a1;
        }

        .template-platinum{
          background:
            radial-gradient(circle at 20% 0%, rgba(0,178,226,.24), transparent 30%),
            radial-gradient(circle at 88% 12%, rgba(56,189,248,.16), transparent 28%),
            linear-gradient(135deg, #021b33 0%, #0f172a 48%, #020617 100%);
          color: #f8fafc;
        }
        .template-platinum .card, .template-platinum .nav, .template-platinum .logbookWide > .card{
          background: rgba(255,255,255,.09);
          border: 1px solid rgba(125,211,252,.22);
          box-shadow: 0 28px 90px rgba(0,0,0,.32);
          backdrop-filter: blur(22px);
          color: #f8fafc;
        }
        .template-platinum .hero{
          background: linear-gradient(135deg, rgba(2,27,51,.95), rgba(0,178,226,.28));
          border: 1px solid rgba(125,211,252,.30);
          color: #fff;
        }

        .template-executiveDark, .template-black, .template-cyber{
          background: radial-gradient(circle at 20% 0%, rgba(0,178,226,.14), transparent 32%), linear-gradient(135deg, #050505, #111827 58%, #020617);
          color: #f8fafc;
        }
        .template-executiveDark .card, .template-executiveDark .nav, .template-executiveDark .logbookWide > .card,
        .template-black .card, .template-black .nav, .template-black .logbookWide > .card,
        .template-cyber .card, .template-cyber .nav, .template-cyber .logbookWide > .card{
          background: rgba(8,13,23,.88);
          border: 1px solid rgba(255,255,255,.12);
          box-shadow: 0 30px 85px rgba(0,0,0,.40);
          color: #f8fafc;
        }
        .template-executiveDark .hero, .template-black .hero, .template-cyber .hero{
          background: linear-gradient(135deg, #020617, #083344);
          color: #ffffff;
          border: 1px solid rgba(0,178,226,.32);
        }

        .template-mission, .template-tower, .template-droneCommand{
          background:
            linear-gradient(90deg, rgba(34,197,94,.10) 1px, transparent 1px),
            linear-gradient(0deg, rgba(34,197,94,.08) 1px, transparent 1px),
            linear-gradient(135deg, #03131f, #0f172a);
          background-size: 38px 38px, 38px 38px, auto;
          color: #dffaf0;
        }
        .template-mission .card, .template-mission .nav, .template-mission .logbookWide > .card,
        .template-tower .card, .template-tower .nav, .template-tower .logbookWide > .card,
        .template-droneCommand .card, .template-droneCommand .nav, .template-droneCommand .logbookWide > .card{
          background: rgba(2,6,23,.82);
          border: 1px solid rgba(34,197,94,.24);
          color: #eafff6;
          box-shadow: 0 28px 80px rgba(0,0,0,.34);
        }

        .template-government, .template-authorityPortal{
          background: linear-gradient(135deg, #f8fafc, #edf2fb);
        }
        .template-government .card, .template-government .nav, .template-government .logbookWide > .card,
        .template-authorityPortal .card, .template-authorityPortal .nav, .template-authorityPortal .logbookWide > .card{
          background: #ffffff;
          border: 1px solid rgba(30,64,175,.20);
          box-shadow: 0 18px 48px rgba(30,64,175,.09);
        }
        .template-government .hero, .template-authorityPortal .hero{
          background: linear-gradient(135deg, #0b1f4d, #1d4ed8);
          color: #fff;
        }

        .template-dji{
          background: linear-gradient(135deg, #ffffff, #f8fafc 52%, #fff7ed);
        }
        .template-dji .card, .template-dji .nav, .template-dji .logbookWide > .card{
          background: rgba(255,255,255,.95);
          border: 1px solid rgba(249,115,22,.24);
          box-shadow: 0 20px 54px rgba(124,45,18,.09);
        }

        .template-apple, .template-microsoft, .template-google, .template-tesla, .template-platinumLight{
          background: linear-gradient(135deg, #ffffff, #f8fafc);
        }
        .template-apple .card, .template-apple .nav, .template-apple .logbookWide > .card,
        .template-microsoft .card, .template-microsoft .nav, .template-microsoft .logbookWide > .card,
        .template-google .card, .template-google .nav, .template-google .logbookWide > .card,
        .template-tesla .card, .template-tesla .nav, .template-tesla .logbookWide > .card,
        .template-platinumLight .card, .template-platinumLight .nav, .template-platinumLight .logbookWide > .card{
          background: rgba(255,255,255,.86);
          border: 1px solid rgba(226,232,240,.90);
          box-shadow: 0 18px 50px rgba(15,23,42,.07);
          backdrop-filter: blur(16px);
        }

        .template-lufthansa, .template-airbus, .template-corporateBlue, .template-enterprise{
          background: radial-gradient(circle at 15% 0%, rgba(59,130,246,.16), transparent 32%), linear-gradient(135deg, #eff6ff, #f8fafc);
        }
        .template-lufthansa .card, .template-lufthansa .nav, .template-lufthansa .logbookWide > .card,
        .template-airbus .card, .template-airbus .nav, .template-airbus .logbookWide > .card,
        .template-corporateBlue .card, .template-corporateBlue .nav, .template-corporateBlue .logbookWide > .card,
        .template-enterprise .card, .template-enterprise .nav, .template-enterprise .logbookWide > .card{
          background: rgba(255,255,255,.92);
          border: 1px solid rgba(37,99,235,.18);
          box-shadow: 0 22px 58px rgba(30,64,175,.10);
        }

        .template-nato, .template-corporateGreen{
          background: linear-gradient(135deg, #ecfdf5, #f7fee7);
        }
        .template-nato .card, .template-nato .nav, .template-nato .logbookWide > .card,
        .template-corporateGreen .card, .template-corporateGreen .nav, .template-corporateGreen .logbookWide > .card{
          background: rgba(255,255,255,.92);
          border: 1px solid rgba(22,163,74,.22);
          box-shadow: 0 22px 58px rgba(22,101,52,.09);
        }

        .template-emergency, .template-corporateRed{
          background: linear-gradient(135deg, #fff1f2, #f8fafc);
        }
        .template-emergency .card, .template-emergency .nav, .template-emergency .logbookWide > .card,
        .template-corporateRed .card, .template-corporateRed .nav, .template-corporateRed .logbookWide > .card{
          background: rgba(255,255,255,.94);
          border: 1px solid rgba(220,38,38,.20);
          box-shadow: 0 22px 58px rgba(127,29,29,.08);
        }

        .template-radarGreen, .template-matrix, .template-terminal{
          background: linear-gradient(135deg, #020617, #000000 58%, #052e16);
          color: #d1fae5;
        }
        .template-radarGreen .card, .template-radarGreen .nav, .template-radarGreen .logbookWide > .card,
        .template-matrix .card, .template-matrix .nav, .template-matrix .logbookWide > .card,
        .template-terminal .card, .template-terminal .nav, .template-terminal .logbookWide > .card{
          background: rgba(2,6,23,.88);
          border: 1px solid rgba(34,197,94,.28);
          box-shadow: 0 26px 76px rgba(0,0,0,.42);
          color: #dcfce7;
        }
        .template-radarGreen .hero, .template-matrix .hero, .template-terminal .hero{
          background: linear-gradient(135deg, #000000, #064e3b);
          color: #ecfdf5;
          border: 1px solid rgba(57,255,20,.28);
        }

        .template-policeBlue, .template-slateGov, .template-nightMap{
          background: linear-gradient(135deg, #e0f2fe, #f8fafc);
        }
        .template-policeBlue .card, .template-policeBlue .nav, .template-policeBlue .logbookWide > .card,
        .template-slateGov .card, .template-slateGov .nav, .template-slateGov .logbookWide > .card,
        .template-nightMap .card, .template-nightMap .nav, .template-nightMap .logbookWide > .card{
          background: rgba(255,255,255,.92);
          border: 1px solid rgba(37,99,235,.20);
          box-shadow: 0 22px 58px rgba(30,64,175,.10);
        }
        .template-policeBlue .hero, .template-slateGov .hero, .template-nightMap .hero{
          background: linear-gradient(135deg, #06172d, #2563eb);
          color: #ffffff;
        }

        .template-fireOps{
          background: radial-gradient(circle at 10% 0%, rgba(239,68,68,.22), transparent 34%), linear-gradient(135deg, #1f0505, #450a0a);
          color: #fee2e2;
        }
        .template-fireOps .card, .template-fireOps .nav, .template-fireOps .logbookWide > .card{
          background: rgba(69,10,10,.78);
          border: 1px solid rgba(248,113,113,.24);
          color: #fff1f2;
          box-shadow: 0 26px 76px rgba(127,29,29,.30);
        }

        .template-medicalAir, .template-nordicIce, .template-whiteLabel{
          background: linear-gradient(135deg, #ffffff, #f0f9ff);
        }
        .template-medicalAir .card, .template-medicalAir .nav, .template-medicalAir .logbookWide > .card,
        .template-nordicIce .card, .template-nordicIce .nav, .template-nordicIce .logbookWide > .card,
        .template-whiteLabel .card, .template-whiteLabel .nav, .template-whiteLabel .logbookWide > .card{
          background: rgba(255,255,255,.94);
          border: 1px solid rgba(14,165,233,.18);
          box-shadow: 0 18px 48px rgba(14,116,144,.08);
        }

        .template-sarOps, .template-desertOps, .template-sunrise{
          background: linear-gradient(135deg, #fff7ed, #fef3c7 54%, #f8fafc);
        }
        .template-sarOps .card, .template-sarOps .nav, .template-sarOps .logbookWide > .card,
        .template-desertOps .card, .template-desertOps .nav, .template-desertOps .logbookWide > .card,
        .template-sunrise .card, .template-sunrise .nav, .template-sunrise .logbookWide > .card{
          background: rgba(255,255,255,.92);
          border: 1px solid rgba(249,115,22,.22);
          box-shadow: 0 22px 58px rgba(180,83,9,.10);
        }

        .template-maritime{
          background: radial-gradient(circle at 15% 0%, rgba(6,182,212,.22), transparent 32%), linear-gradient(135deg, #e0f2fe, #ecfeff);
        }
        .template-maritime .card, .template-maritime .nav, .template-maritime .logbookWide > .card{
          background: rgba(255,255,255,.86);
          border: 1px solid rgba(6,182,212,.24);
          box-shadow: 0 22px 58px rgba(8,145,178,.12);
          backdrop-filter: blur(18px);
        }

        .template-forest{
          background: linear-gradient(135deg, #052e16, #ecfdf5);
        }
        .template-forest .card, .template-forest .nav, .template-forest .logbookWide > .card{
          background: rgba(255,255,255,.90);
          border: 1px solid rgba(34,197,94,.25);
          box-shadow: 0 22px 58px rgba(22,101,52,.12);
        }

        .template-aurora, .template-neonBlue, .template-carbon, .template-bronze{
          background: radial-gradient(circle at 20% 0%, rgba(168,85,247,.24), transparent 32%), linear-gradient(135deg, #020617, #111827);
          color: #f8fafc;
        }
        .template-aurora .card, .template-aurora .nav, .template-aurora .logbookWide > .card,
        .template-neonBlue .card, .template-neonBlue .nav, .template-neonBlue .logbookWide > .card,
        .template-carbon .card, .template-carbon .nav, .template-carbon .logbookWide > .card,
        .template-bronze .card, .template-bronze .nav, .template-bronze .logbookWide > .card{
          background: rgba(9,9,11,.84);
          border: 1px solid rgba(255,255,255,.12);
          box-shadow: 0 28px 85px rgba(0,0,0,.38);
          color: #f8fafc;
        }
        .template-aurora .hero{ background: linear-gradient(135deg, #020617, #7e22ce, #0891b2); color: #fff; }
        .template-neonBlue .hero{ background: linear-gradient(135deg, #020617, #1d4ed8); color: #fff; }
        .template-carbon .hero{ background: linear-gradient(135deg, #09090b, #334155); color: #fff; }
        .template-bronze .hero{ background: linear-gradient(135deg, #1c1917, #92400e); color: #fff; }

        .template-custom{
          background: linear-gradient(135deg, #f8fafc, #eef2ff);
        }
        .template-custom .card, .template-custom .nav, .template-custom .logbookWide > .card{
          background: rgba(255,255,255,.88);
          border: 1px dashed rgba(99,102,241,.38);
          box-shadow: 0 18px 48px rgba(99,102,241,.08);
        }

        .template-radarGreen, .template-terminal, .template-matrix, .template-nightMap, .template-neonBlue{
          background: linear-gradient(135deg, #020617, #0f172a);
          color: #f8fafc;
        }
        .template-radarGreen .card, .template-terminal .card, .template-matrix .card, .template-nightMap .card, .template-neonBlue .card,
        .template-radarGreen .nav, .template-terminal .nav, .template-matrix .nav, .template-nightMap .nav, .template-neonBlue .nav{
          background: rgba(2,6,23,.86);
          border: 1px solid rgba(34,211,238,.22);
          box-shadow: 0 24px 70px rgba(0,0,0,.34);
          color: #f8fafc;
        }
        .template-policeBlue, .template-slateGov{
          background: linear-gradient(135deg, #e0f2fe, #f8fafc);
        }
        .template-fireOps{
          background: linear-gradient(135deg, #450a0a, #fff1f2);
        }
        .template-medicalAir, .template-nordicIce, .template-whiteLabel{
          background: linear-gradient(135deg, #ffffff, #f8fafc);
        }
        .template-sarOps, .template-desertOps, .template-sunrise{
          background: linear-gradient(135deg, #fff7ed, #f8fafc);
        }
        .template-maritime{
          background: linear-gradient(135deg, #e0f2fe, #ecfeff);
        }
        .template-forest{
          background: linear-gradient(135deg, #ecfdf5, #f0fdf4);
        }
        .template-aurora, .template-carbon, .template-bronze{
          background: linear-gradient(135deg, #020617, #1e1b4b);
          color: #f8fafc;
        }
        .template-policeBlue .card, .template-fireOps .card, .template-medicalAir .card, .template-sarOps .card, .template-maritime .card, .template-forest .card, .template-desertOps .card, .template-aurora .card, .template-carbon .card, .template-slateGov .card, .template-sunrise .card, .template-nordicIce .card, .template-bronze .card, .template-whiteLabel .card,
        .template-policeBlue .nav, .template-fireOps .nav, .template-medicalAir .nav, .template-sarOps .nav, .template-maritime .nav, .template-forest .nav, .template-desertOps .nav, .template-aurora .nav, .template-carbon .nav, .template-slateGov .nav, .template-sunrise .nav, .template-nordicIce .nav, .template-bronze .nav, .template-whiteLabel .nav{
          background: rgba(255,255,255,.90);
          border: 1px solid rgba(148,163,184,.28);
          box-shadow: 0 22px 58px rgba(15,23,42,.10);
        }
        .template-aurora .card, .template-carbon .card, .template-bronze .card{
          background: rgba(15,23,42,.86);
          border-color: rgba(255,255,255,.14);
          color: #f8fafc;
        }

        .template-customized{
          background: linear-gradient(135deg, var(--fm-template-background), var(--fm-template-surface)) !important;
          color: var(--fm-template-text) !important;
        }
        .template-customized .hero{
          background: linear-gradient(135deg, var(--fm-template-secondary), var(--fm-template-primary)) !important;
          color: #ffffff !important;
          border-color: color-mix(in srgb, var(--fm-template-accent) 40%, transparent) !important;
        }
        .template-customized .card,
        .template-customized .nav,
        .template-customized .logbookWide > .card{
          background: color-mix(in srgb, var(--fm-template-surface) 92%, white 8%) !important;
          border-color: color-mix(in srgb, var(--fm-template-primary) 30%, #e2e8f0 70%) !important;
          box-shadow: 0 22px 58px color-mix(in srgb, var(--fm-template-secondary) 18%, transparent) !important;
          color: var(--fm-template-text) !important;
        }
        .template-customized .primary,
        .template-customized button.primary{
          background: linear-gradient(135deg, var(--fm-template-primary), var(--fm-template-accent)) !important;
          color: #ffffff !important;
          border-color: transparent !important;
        }
        .template-customized .status.good{
          background: color-mix(in srgb, var(--fm-template-primary) 16%, white 84%) !important;
          color: var(--fm-template-secondary) !important;
        }

        .tickerAdminPanel{
          margin-top: 14px;
          border-top: 1px solid rgba(148,163,184,.22);
          padding-top: 14px;
        }

        .tickerAdminList{
          display: grid;
          gap: 10px;
          margin-top: 14px;
        }

        .tickerAdminItem{
          display: grid;
          gap: 10px;
          border: 1px solid rgba(148,163,184,.25);
          border-radius: 18px;
          padding: 14px;
          background: rgba(248,250,252,.8);
        }

        .tickerAdminItem strong{
          color: #0f172a;
        }

        .tickerAdminItem span{
          color: #64748b;
          font-size: 13px;
        }
      `}</style>
    );
  }




  if (adminUnlocked && !publicPreviewMode && activePage !== "registrationForm") {
    const adminModules = [
      ["overview", "Übersicht", "Dashboard & Schnellzugriff"],
      ["customers", "CRM", "Kundenakte, Aktivitäten & Portal"],
      ["offers", "Angebote", "Angebote erstellen & verwalten"],
      ["contracts", "Verträge", "Verträge, Laufzeiten, Fristen & Dokumente"],
      ["invoices", "Rechnungen", "Rechnungen verwalten"],
      ["droneLogbook", "Drohnen-Logbuch", "Automatisches Logbuch aus abgeschlossenen Flügen"],
      ["fleet", "Wartung", "Drohnen, Akkus, Wartungen, Erinnerungen & Flugstunden"],
      ["flightMap", "Flugorte-Karte", "Alle abgeschlossenen Flugorte"],
      ["gallery", "Galerie", "Bilder, Kategorien & Unterkategorien"],
      ["proTools", "Pro-Module", "Kundenportal, Missionen, Medien & Backup"],
      ["customerPortalPro", "Customer Portal", "Kundenlogin, Downloads, Dokumente & Freigaben"],
      ["business", "Business-Dashboard", "Statistik & Jahresnachweis"],
      ["flights", "Flüge", "Abgeschlossene Flüge & Flugbuch"],
      ["authorityCenterPro", "Behörden-Center", "Genehmigungen, Fristen & Dokumente"],
      ["authorities", "Behörden", "Empfänger & Kontakte"],
      ["design", "Design", "Templates & Branding"],
      ["liveticker", "Liveticker", "UAS Meldungen & Quellen"],
      ["users", "Rollen & Rechte", "Benutzer, Rollenmatrix & Zugriff"],
      ["exports", "Exporte", "PDF, CSV & Berichte"],
      ["cloudSync", "Cloud Sync", "Cloud-Ziele, Backup-Sync & Restore"],
      ["mobilePro", "PWA Mobile", "Offline-Modus, mobile Missionen & Checklisten"],
      ["aiCopilot", "AI Copilot", "Assistent, Warnungen & Berichte"],
      ["commercialRelease", "Commercial Release", "Lizenz, White Label, API & Deployment"],
      ["releaseCandidate", "RC1 Release Check", "Abnahme, Test-Checkliste & Release-Status"],
      ["bugfixStabilization", "Bugfix Stabilization", "Fehlerliste, Build-Check & Stabilität"],
      ["productionDeployment", "Production Deployment", "Livegang, PWA, Backup & Security"],
      ["finalRelease", "Final Release", "Paket, Dokumentation & Abschluss-Check"],
      ["system", "System", "Backup & Audit"],
    ];

    const activeTemplateColors = templateColorOverrides?.[activeTemplate]
      ? [
          templateColorOverrides[activeTemplate].secondary || templateColorOverrides[activeTemplate].background || "#021B33",
          templateColorOverrides[activeTemplate].primary || templateColorOverrides[activeTemplate].accent || "#00B2E2",
          templateColorOverrides[activeTemplate].surface || "#ffffff",
        ]
      : (templatePreviewColors[activeTemplate] || templatePreviewColors.custom);
    const adminAccentColor = activeTemplateColors[1] || "#00B2E2";
    const adminShellBackground = `linear-gradient(135deg, ${activeTemplateColors[0]}22, ${activeTemplateColors[1]}18, #f8fafc)`;
    const adminSidebarBackground = `linear-gradient(180deg, ${activeTemplateColors[0]}, ${activeTemplateColors[1]})`;
    const adminMainBackground = dark || ["stealth", "black", "cyber", "radarGreen", "terminal", "matrix", "nightMap", "carbon", "aurora", "bronze"].includes(activeTemplate)
      ? `linear-gradient(135deg, ${activeTemplateColors[0]}, #0f172a)`
      : `linear-gradient(135deg, #ffffff, ${activeTemplateColors[2]}55)`;

    return (
      <div className={appClassName} style={templateColorStyle}>
        <div className="adminOnlyPage" style={{ minHeight: "100vh", padding: "18px", background: adminShellBackground }}>
          <NewsTickerStyles />
          <div className="card" style={{ maxWidth: "1440px", margin: "0 auto", padding: 0, overflow: "hidden", border: "1px solid rgba(148,163,184,.28)", boxShadow: "0 28px 90px rgba(15,23,42,.16)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0,1fr)", minHeight: "calc(100vh - 36px)" }}>
              <aside style={{ background: adminSidebarBackground, color: "white", padding: "22px", overflowY: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
                  <img src="/logo_neu.png" alt="FlyMonitor" style={{ width: "92px", height: "44px", objectFit: "contain", background: "rgba(255,255,255,.08)", borderRadius: "14px" }} />
                  <div>
                    <strong style={{ display: "block", fontSize: "18px" }}>Admin Center</strong>
                    <span style={{ color: "rgba(255,255,255,.68)", fontSize: "13px" }}>Rolle: {adminRole}</span>
                  </div>
                </div>

                {adminModules.map(([id, title, subtitle]) => (
                  <button key={id} type="button" onClick={() => setAdminCenterTab(id)} style={{ width: "100%", textAlign: "left", border: "1px solid rgba(255,255,255,.12)", background: adminCenterTab === id ? `${adminAccentColor}44` : "rgba(255,255,255,.06)", color: "white", borderRadius: "18px", padding: "13px 14px", marginBottom: "10px", cursor: "pointer" }}>
                    <strong style={{ display: "block" }}>{title}</strong>
                    <span style={{ color: "rgba(255,255,255,.64)", fontSize: "12px" }}>{subtitle}</span>
                  </button>
                ))}

                <div style={{ marginTop: "22px", display: "grid", gap: "10px" }}>
                  <button
                    type="button"
                    className="secondary smallButton"
                    onClick={() => {
                      setPublicPreviewMode(true);
                      setShowAdminLoginModal(false);
                      setActivePage("home");
                      if (typeof window !== "undefined") {
                        window.location.hash = "";
                        window.history.replaceState(null, "", window.location.pathname + window.location.search);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }
                    }}
                  >
                    Öffentliche Seite öffnen
                  </button>
                  <button type="button" style={LOGOUT_BUTTON_STYLE} onClick={lockAdminWorking}>Admin Logout</button>
                </div>
              </aside>

              <main style={{ padding: "28px", overflowY: "auto", maxHeight: "calc(100vh - 36px)", background: adminMainBackground }}>
                <div className="sectionHead" style={{ marginBottom: "18px" }}>
                  <div>
                    <h1 style={{ marginBottom: 4 }}>FlyMonitor Admin Center</h1>
                    <p style={{ margin: 0 }}>Alle Verwaltungsbereiche sind jetzt links erreichbar. Kein langes Scrollen mehr.</p>
                  </div>
                  <Status status="good">Admin aktiv</Status>
                </div>

                {adminCenterTab === "overview" ? (
                  <>
                    <section className="ultimateDashboard" style={{ marginTop: "16px" }}>
                      <div className="dashCard"><strong>{logbook.length}</strong><span>Flugbuch Einträge</span></div>
                      <div className="dashCard"><strong>{completedFlights.length}</strong><span>Abgeschlossene Flüge</span></div>
                      <div className="dashCard"><strong>{savedEmailRecipients.length}</strong><span>Empfänger</span></div>
                      <div className="dashCard"><strong>{customers.length}</strong><span>Kunden</span></div>
                      <div className="dashCard"><strong>{offers.length}</strong><span>Angebote</span></div>
                      <div className="dashCard"><strong>{contracts.length}</strong><span>Verträge</span></div>
                      <div className="dashCard"><strong>{invoices.length}</strong><span>Rechnungen</span></div>
                      <div className="dashCard"><strong>{mailPdfDocumentSummary.expired ? `🔴 ${mailPdfDocumentSummary.expired}` : mailPdfDocumentSummary.expiring ? `🟡 ${mailPdfDocumentSummary.expiring}` : mailPdfDocumentSummary.total}</strong><span>PDF-Dokumente</span></div>
                      <div className="dashCard"><strong>{activeTemplateLabel}</strong><span>Aktives Template</span></div>
                    </section>
                    <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", marginTop: "18px" }}>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("droneLogbook")} style={{ textAlign: "left", border: "2px solid #22c55e" }}><h3>📖 Drohnen-Logbuch</h3><p>Automatisches Logbuch aus abgeschlossenen Flügen öffnen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("flights")} style={{ textAlign: "left" }}><h3>Flüge verwalten</h3><p>Abgeschlossene Flüge, Nachträge und Flugbuch öffnen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("flightMap")} style={{ textAlign: "left" }}><h3>🗺 Flugorte-Karte</h3><p>Alle abgeschlossenen Flugorte auf einer Karte anzeigen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("gallery")} style={{ textAlign: "left", border: "2px solid #a855f7" }}><h3>🖼 Galerie</h3><p>Bilder, Kategorien und Unterkategorien vollständig verwalten.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("design")} style={{ textAlign: "left" }}><h3>Design Center</h3><p>Templates live wechseln und Branding prüfen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("authorities")} style={{ textAlign: "left" }}><h3>Behördenkontakte</h3><p>Empfänger, Kategorien und Unterkategorien pflegen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("customers")} style={{ textAlign: "left", border: "2px solid #0ea5e9" }}><h3>Kunden</h3><p>Kundenportal, Angebote und Rechnungen vorbereiten.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("offers")} style={{ textAlign: "left" }}><h3>📄 Angebote</h3><p>Angebote anlegen, anzeigen und später als PDF exportieren.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("contracts")} style={{ textAlign: "left" }}><h3>🧾 Verträge</h3><p>Kundenverträge, Rahmenverträge, Laufzeiten und Fristen verwalten.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("invoices")} style={{ textAlign: "left" }}><h3>🧾 Rechnungen</h3><p>Rechnungen anzeigen und später aus Angeboten erzeugen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("liveticker")} style={{ textAlign: "left" }}><h3>UAS Liveticker</h3><p>Meldungen aktualisieren, Status prüfen und Quellen testen.</p></button>
                      <button type="button" className="card" onClick={() => setAdminCenterTab("system")} style={{ textAlign: "left" }}><h3>Systemstatus</h3><p>Session, Backup-Hinweise und Audit prüfen.</p></button>
                    </div>
                  </>
                ) : null}

                {adminCenterTab === "gallery" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>Galerie</h2>
                        <p>Professionelle Galerie mit Bildern, Kategorien und Unterkategorien verwalten.</p>
                      </div>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <Status status="good">{galleryItems.length} Bilder</Status>
                        <Status status="good">{galleryManagedCategories.length} Kategorien</Status>
                        <button
                          type="button"
                          className="secondary smallButton"
                          onClick={() => {
                            setPublicPreviewMode(true);
                            setActivePage("gallery");
                            if (typeof window !== "undefined") {
                              window.location.hash = "gallery";
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }
                          }}
                        >
                          Öffentliche Galerie ansehen
                        </button>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead">
                        <div>
                          <h3>Kategorien & Unterkategorien</h3>
                          <p>Kategorien anlegen, umbenennen, Unterkategorien pflegen oder löschen.</p>
                        </div>
                        <Status status="good">{galleryManagedCategories.length} aktiv</Status>
                      </div>
                      <div className="profileGrid">
                        <label>Kategorie-Name<input value={newGalleryCategory.name} onChange={(e) => setNewGalleryCategory({ ...newGalleryCategory, name: e.target.value })} placeholder="z. B. Baustellen" /></label>
                        <label>Erste Unterkategorie<input value={newGalleryCategory.subcategory} onChange={(e) => setNewGalleryCategory({ ...newGalleryCategory, subcategory: e.target.value })} placeholder="z. B. Stadion" /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={2} value={newGalleryCategory.description} onChange={(e) => setNewGalleryCategory({ ...newGalleryCategory, description: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow"><button type="button" className="primary smallButton" onClick={addGalleryCategoryWorking}>Kategorie hinzufügen</button></div>
                      <div className="logbookList" style={{ marginTop: "14px", maxHeight: "420px", overflowY: "auto" }}>
                        {galleryManagedCategories.map((category) => (
                          <div key={category.id} className="listitem">
                            {editingGalleryCategoryId === category.id ? (
                              <div>
                                <strong>Kategorie bearbeiten</strong>
                                <div className="profileGrid" style={{ marginTop: "10px" }}>
                                  <label>Name<input value={editGalleryCategory.name} onChange={(e) => setEditGalleryCategory({ ...editGalleryCategory, name: e.target.value })} /></label>
                                  <label>Unterkategorien<textarea rows={4} value={editGalleryCategory.subcategoriesText} onChange={(e) => setEditGalleryCategory({ ...editGalleryCategory, subcategoriesText: e.target.value })} placeholder={"Eine Unterkategorie pro Zeile"} /></label>
                                  <label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={2} value={editGalleryCategory.description} onChange={(e) => setEditGalleryCategory({ ...editGalleryCategory, description: e.target.value })} /></label>
                                </div>
                                <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveEditedGalleryCategoryWorking}>Kategorie speichern</button><button type="button" className="secondary smallButton" onClick={() => setEditingGalleryCategoryId(null)}>Abbrechen</button></div>
                              </div>
                            ) : (
                              <>
                                <strong>{category.name}</strong>
                                {category.description ? <span>{category.description}</span> : null}
                                <span>Unterkategorien: {(category.subcategories || []).join(", ") || "Sonstiges"}</span>
                                <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => startEditGalleryCategoryWorking(category)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => deleteGalleryCategoryWorking(category)}>Löschen</button></div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead">
                        <div><h3>Bilder hochladen</h3><p>Mehrere Bilder gleichzeitig auswählen. Bilder werden automatisch verkleinert.</p></div>
                        <button type="button" className="secondary smallButton" onClick={() => { if (window.confirm("Alle Galerieeinträge löschen?")) { setGalleryItems([]); localStorage.removeItem("droneready_gallery_items"); } }}>Alle Galerieeinträge löschen</button>
                      </div>
                      <div className="profileGrid">
                        <label>Kategorie<select value={newGalleryItem.category} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, category: e.target.value, subcategory: getGallerySubcategories(galleryManagedCategories, e.target.value)[0] || "Sonstiges" })}>{galleryManagedCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
                        <label>Unterkategorie<select value={newGalleryItem.subcategory || "Sonstiges"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, subcategory: e.target.value })}>{newGallerySubcategoryOptions.length ? newGallerySubcategoryOptions.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>) : <option value="Sonstiges">Sonstiges</option>}</select></label>
                        <label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(newGalleryItem.featured)} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, featured: e.target.checked })} /> Als Highlight markieren</label>
                        <label style={{ gridColumn: "1 / -1" }}>Text für alle Bilder<textarea rows={2} value={newGalleryItem.text} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, text: e.target.value })} /></label>
                        <label>Mehrfach-Upload Bilder/Videos<input type="file" accept="image/*,video/*" multiple onChange={addGalleryFilesWorking} /></label>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <h3>Einzelnen Galerieeintrag hinzufügen</h3>
                      <div className="profileGrid">
                        <label>Kategorie<select value={newGalleryItem.category} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, category: e.target.value, subcategory: getGallerySubcategories(galleryManagedCategories, e.target.value)[0] || "Sonstiges" })}>{galleryManagedCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
                        <label>Unterkategorie<select value={newGalleryItem.subcategory || "Sonstiges"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, subcategory: e.target.value })}>{newGallerySubcategoryOptions.length ? newGallerySubcategoryOptions.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>) : <option value="Sonstiges">Sonstiges</option>}</select></label>
                        <label>Titel<input value={newGalleryItem.title} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, title: e.target.value })} /></label>
                        <label>Medientyp<select value={newGalleryItem.mediaType || "image"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, mediaType: e.target.value })}><option value="image">Bild</option><option value="video">Video</option></select></label>
                        <label>Bild-URL<input value={newGalleryItem.imageUrl || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, imageUrl: e.target.value, mediaType: "image" })} placeholder="https://..." /></label>
                        <label>Video-URL<input value={newGalleryItem.videoUrl || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, videoUrl: e.target.value, mediaType: "video" })} placeholder="https://...mp4" /></label><label>Koordinaten<input value={newGalleryItem.coordinates || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, coordinates: e.target.value })} placeholder="54.323000, 10.122000" /></label><label>Adresse/Ort<input value={newGalleryItem.address || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, address: e.target.value })} /></label><label>Kunde<select value={newGalleryItem.customerId || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, customerId: e.target.value })}><option value="">Kein Kunde</option>{(customers || []).map((customer) => <option key={`new-gallery-customer-${customer.id || customer.customerNumber || customer.company}`} value={customer.customerNumber || customer.id || customer.company || customer.contactName}>{customer.company || customer.contactName || customer.customerNumber}</option>)}</select></label><label>Projekt/Mission<select value={newGalleryItem.projectId || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, projectId: e.target.value })}><option value="">Kein Projekt</option>{(missions || []).map((mission) => <option key={`new-gallery-project-${mission.id || mission.title}`} value={mission.title || mission.id}>{mission.title || mission.name || mission.id}</option>)}</select></label><label>Tags<input value={newGalleryItem.tags || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, tags: e.target.value })} placeholder="Baustelle, Kiel, Kunde" /></label><label>Wasserzeichen<select value={newGalleryItem.watermarkMode || "inherit"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, watermarkMode: e.target.value })}><option value="inherit">Global übernehmen</option><option value="custom">Eigenes Wasserzeichen</option><option value="off">Für dieses Medium aus</option></select></label><label>Eigenes Wasserzeichen<input value={newGalleryItem.watermarkText || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, watermarkText: e.target.value, watermarkMode: e.target.value ? "custom" : newGalleryItem.watermarkMode })} placeholder="{copyright} • {customer}" /></label><label>Wasserzeichen-Position<select value={newGalleryItem.watermarkPosition || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, watermarkPosition: e.target.value })}><option value="">Global</option><option value="bottom-right">unten rechts</option><option value="bottom-left">unten links</option><option value="top-right">oben rechts</option><option value="top-left">oben links</option></select></label><label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(newGalleryItem.favorite)} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, favorite: e.target.checked })} /> Favorit</label><div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => assignCurrentMapPointToGalleryDraftWorking("new")}>Aktuellen Kartenpunkt übernehmen</button></div>
                        <label>Bild/Video hochladen<input type="file" accept="image/*,video/*" onChange={(e) => uploadGalleryImageWorking(e, "new")} /></label>
                        <label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(newGalleryItem.featured)} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, featured: e.target.checked })} /> Highlight</label>
                        <label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={3} value={newGalleryItem.text} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, text: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow"><button type="button" className="primary smallButton" onClick={addGalleryItemWorking}>Galerie speichern</button></div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead"><div><h3>Galerieeinträge verwalten</h3><p>Filtern, bearbeiten und löschen.</p></div><Status status={filteredGalleryItems.length ? "good" : "warning"}>{filteredGalleryItems.length} Treffer</Status></div>
                      <div className="profileGrid">
                        <label>Kategorie<select value={galleryCategoryFilter} onChange={(e) => { setGalleryCategoryFilter(e.target.value); setGallerySubcategoryFilter("Alle"); }}>{galleryCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
                        <label>Unterkategorie<select value={gallerySubcategoryFilter} onChange={(e) => setGallerySubcategoryFilter(e.target.value)}>{gallerySubcategories.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>)}</select></label>
                      </div>
                      <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginTop: "16px" }}>
                        {filteredGalleryItems.map((item) => (
                          <div key={item.id} className="card" style={{ padding: "14px" }}>
                            {editingGalleryId === item.id ? (
                              <>
                                <strong>Galerieeintrag bearbeiten</strong>
                                <label>Kategorie<select value={editGalleryItem.category} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, category: e.target.value, subcategory: getGallerySubcategories(galleryManagedCategories, e.target.value)[0] || "Sonstiges" })}>{galleryManagedCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
                                <label>Unterkategorie<select value={editGalleryItem.subcategory || "Sonstiges"} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, subcategory: e.target.value })}>{editGallerySubcategoryOptions.length ? editGallerySubcategoryOptions.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>) : <option value="Sonstiges">Sonstiges</option>}</select></label>
                                <label>Titel<input value={editGalleryItem.title || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, title: e.target.value })} /></label>
                                <label>Medientyp<select value={editGalleryItem.mediaType || "image"} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, mediaType: e.target.value })}><option value="image">Bild</option><option value="video">Video</option></select></label>
                                <label>Bild-URL<input value={editGalleryItem.imageUrl || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, imageUrl: e.target.value, mediaType: "image" })} /></label>
                                <label>Video-URL<input value={editGalleryItem.videoUrl || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, videoUrl: e.target.value, mediaType: "video" })} /></label><label>Koordinaten<input value={editGalleryItem.coordinates || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, coordinates: e.target.value })} placeholder="54.323000, 10.122000" /></label><label>Adresse/Ort<input value={editGalleryItem.address || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, address: e.target.value })} /></label><label>Kunde<select value={editGalleryItem.customerId || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, customerId: e.target.value })}><option value="">Kein Kunde</option>{(customers || []).map((customer) => <option key={`edit-gallery-customer-${customer.id || customer.customerNumber || customer.company}`} value={customer.customerNumber || customer.id || customer.company || customer.contactName}>{customer.company || customer.contactName || customer.customerNumber}</option>)}</select></label><label>Projekt/Mission<select value={editGalleryItem.projectId || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, projectId: e.target.value })}><option value="">Kein Projekt</option>{(missions || []).map((mission) => <option key={`edit-gallery-project-${mission.id || mission.title}`} value={mission.title || mission.id}>{mission.title || mission.name || mission.id}</option>)}</select></label><label>Tags<input value={editGalleryItem.tags || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, tags: e.target.value })} placeholder="Baustelle, Kiel, Kunde" /></label><label>Wasserzeichen<select value={editGalleryItem.watermarkMode || "inherit"} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, watermarkMode: e.target.value })}><option value="inherit">Global übernehmen</option><option value="custom">Eigenes Wasserzeichen</option><option value="off">Für dieses Medium aus</option></select></label><label>Eigenes Wasserzeichen<input value={editGalleryItem.watermarkText || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, watermarkText: e.target.value, watermarkMode: e.target.value ? "custom" : editGalleryItem.watermarkMode })} placeholder="{copyright} • {customer}" /></label><label>Wasserzeichen-Position<select value={editGalleryItem.watermarkPosition || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, watermarkPosition: e.target.value })}><option value="">Global</option><option value="bottom-right">unten rechts</option><option value="bottom-left">unten links</option><option value="top-right">oben rechts</option><option value="top-left">oben links</option></select></label><label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(editGalleryItem.favorite)} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, favorite: e.target.checked })} /> Favorit</label><div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => assignCurrentMapPointToGalleryDraftWorking("edit")}>Aktuellen Kartenpunkt übernehmen</button></div>
                                <label>Bild/Video ersetzen<input type="file" accept="image/*,video/*" onChange={(e) => uploadGalleryImageWorking(e, "edit")} /></label>
                                <label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(editGalleryItem.featured)} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, featured: e.target.checked })} /> Highlight</label>
                                <label>Beschreibung<textarea rows={3} value={editGalleryItem.text || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, text: e.target.value })} /></label>
                                <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveEditedGalleryItemWorking}>Speichern</button><button type="button" className="secondary smallButton" onClick={cancelEditGalleryItemWorking}>Abbrechen</button></div>
                              </>
                            ) : (
                              <>
                                {getGalleryMediaType(item) === "video" && getGalleryMediaUrl(item) ? <video src={getGalleryMediaUrl(item)} controls style={{ width: "100%", height: "170px", objectFit: "cover", borderRadius: "18px", marginBottom: "10px", background: "#0f172a" }} /> : item.imageUrl ? <img src={item.imageUrl} alt={item.title} style={{ width: "100%", height: "170px", objectFit: "cover", borderRadius: "18px", marginBottom: "10px" }} /> : <div style={{ height: "170px", borderRadius: "18px", background: "#e2e8f0", display: "grid", placeItems: "center", marginBottom: "10px" }}>Kein Medium</div>}
                                <strong>{item.title || "Galeriebild"}</strong>
                                <span>{item.category || "Allgemein"}{item.subcategory ? ` · ${item.subcategory}` : ""} · {getGalleryMediaType(item) === "video" ? "Video" : "Bild"}{item.featured ? " · Highlight" : ""}</span>
                                {item.text ? <small>{item.text}</small> : null}
                                <div className="buttonRow" style={{ marginTop: "10px" }}><button type="button" className="secondary smallButton" onClick={() => startEditGalleryItemWorking(item)}>Bearbeiten</button><button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteGalleryItemWorking(item.id)}>Löschen</button></div>
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "proTools" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>FlyMonitor Pro-Module</h2>
                        <p>Karten-Galerie, Vorher/Nachher, Kundenportal, Download-Center, Wasserzeichen, Missionen, Wetterhistorie, Medienbibliothek, Showcase und Backup-Historie.</p>
                      </div>
                      <Status status="good">aktiv</Status>
                    </div>

                    <div className="dashboardGrid" style={{ marginTop: "18px" }}>
                      <div className="card"><h3>🗺 Karten-Galerie</h3><p>{galleryMapItems.length} Medien mit Koordinaten.</p><button type="button" className="secondary smallButton" onClick={() => { setPublicPreviewMode(true); setActivePage("gallery"); window.location.hash = "gallery"; }}>Öffentliche Karte ansehen</button></div>
                      <div className="card"><h3>🖼 Showcase</h3><p>{showcaseGalleryItems.length} Medien für die Startseiten-Präsentation.</p><button type="button" className="secondary smallButton" onClick={() => setFlymonitorProSettings({ ...flymonitorProSettings, showcaseEnabled: !flymonitorProSettings.showcaseEnabled })}>{flymonitorProSettings.showcaseEnabled ? "Showcase deaktivieren" : "Showcase aktivieren"}</button></div>
                      <div className="card"><h3>🔐 Kundenportal</h3><p>{customers.length} Kunde(n), {invoices.length} Rechnung(en).</p><button type="button" className="secondary smallButton" onClick={() => setFlymonitorProSettings({ ...flymonitorProSettings, customerPortalEnabled: !flymonitorProSettings.customerPortalEnabled })}>{flymonitorProSettings.customerPortalEnabled ? "Portal aktiv" : "Portal aktivieren"}</button></div>
                      <div className="card"><h3>💾 Backup Pro</h3><p>{backupJobs.length} Backup-Eintrag/Ereignis(se).</p><button type="button" className="secondary smallButton" onClick={() => createBackupJobWorking("Manuell")}>Backup-Ereignis speichern</button></div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(320px,1fr) minmax(320px,1fr)", alignItems: "start", marginTop: "18px" }}>
                      <div className="card">
                        <div className="sectionHead"><div><h3>Vorher/Nachher-Vergleich</h3><p>Zwei Galerie-Medien auswählen und vergleichen.</p></div></div>
                        <div className="profileGrid">
                          <label>Vorher<select value={compareBeforeId} onChange={(e) => setCompareBeforeId(e.target.value)}><option value="">Bitte wählen</option>{galleryItems.map((item) => <option key={`before-${item.id}`} value={item.id}>{item.title || item.name || item.id}</option>)}</select></label>
                          <label>Nachher<select value={compareAfterId} onChange={(e) => setCompareAfterId(e.target.value)}><option value="">Bitte wählen</option>{galleryItems.map((item) => <option key={`after-${item.id}`} value={item.id}>{item.title || item.name || item.id}</option>)}</select></label>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "12px" }}>
                          {[comparisonBefore, comparisonAfter].map((item, index) => item ? <div key={index} style={{ border: "1px solid #dbe3ef", borderRadius: "18px", overflow: "hidden" }}>{getGalleryMediaType(item) === "video" ? <video src={getGalleryMediaUrl(item)} controls style={{ width: "100%", height: 190, objectFit: "cover", background: "#0f172a" }} /> : <img src={normalizeUploadUrl(item.imageUrl || getGalleryMediaUrl(item))} alt={item.title} style={{ width: "100%", height: 190, objectFit: "cover" }} />}<div style={{ padding: 10 }}><strong>{index === 0 ? "Vorher" : "Nachher"}</strong><br /><span>{item.title}</span></div></div> : <div key={index} style={{ border: "1px dashed #cbd5e1", borderRadius: "18px", minHeight: 240, display: "grid", placeItems: "center", color: "#64748b" }}>{index === 0 ? "Vorher wählen" : "Nachher wählen"}</div>)}
                        </div>
                      </div>

                      <div className="card">
                        <div className="sectionHead"><div><h3>Wasserzeichen-System Pro</h3><p>Globale, kunden- und projektbezogene Wasserzeichen mit Vorschau.</p></div><Status status={flymonitorProSettings.watermarkEnabled ? "good" : "warning"}>{flymonitorProSettings.watermarkEnabled ? "aktiv" : "inaktiv"}</Status></div>
                        <div className="profileGrid">
                          <label>Basis-Text<input value={flymonitorProSettings.watermarkText || ""} onChange={(e) => setFlymonitorProSettings({ ...flymonitorProSettings, watermarkText: e.target.value })} placeholder="© FlyMonitor" /></label>
                          <label style={{ gridColumn: "1 / -1" }}>Vorlage<input value={flymonitorProSettings.watermarkTemplate || "{copyright}"} onChange={(e) => setFlymonitorProSettings({ ...flymonitorProSettings, watermarkTemplate: e.target.value })} placeholder="{copyright} • {customer} • {project}" /></label>
                          <label>Position<select value={flymonitorProSettings.watermarkPosition || "bottom-right"} onChange={(e) => setFlymonitorProSettings({ ...flymonitorProSettings, watermarkPosition: e.target.value })}><option value="bottom-right">unten rechts</option><option value="bottom-left">unten links</option><option value="top-right">oben rechts</option><option value="top-left">oben links</option></select></label>
                          <label>Deckkraft<input type="number" min="20" max="95" value={flymonitorProSettings.watermarkOpacity || 62} onChange={(e) => setFlymonitorProSettings({ ...flymonitorProSettings, watermarkOpacity: Number(e.target.value || 62) })} /></label>
                          <label style={{ display: "flex", alignItems: "center", gap: 9 }}><input type="checkbox" checked={Boolean(flymonitorProSettings.watermarkEnabled)} onChange={(e) => setFlymonitorProSettings({ ...flymonitorProSettings, watermarkEnabled: e.target.checked })} /> Wasserzeichen aktivieren</label>
                          <label style={{ display: "flex", alignItems: "center", gap: 9 }}><input type="checkbox" checked={Boolean(flymonitorProSettings.watermarkApplyToVideos)} onChange={(e) => setFlymonitorProSettings({ ...flymonitorProSettings, watermarkApplyToVideos: e.target.checked })} /> auch bei Videos anzeigen</label>
                        </div>
                        <div style={{ position: "relative", height: 120, borderRadius: 18, background: "linear-gradient(135deg,#dbeafe,#0f172a)", marginTop: 12, overflow: "hidden" }}>
                          {(() => { const wm = resolveGalleryWatermark({ title: "Vorschau", customerName: "Kunde", projectName: "Projekt", category: "Galerie", mediaType: "image" }, flymonitorProSettings, customers, missions); return wm ? <span style={getWatermarkStyle(wm.position, wm.opacity)}>{wm.text}</span> : null; })()}
                        </div>
                        <small>Platzhalter: {"{copyright}"}, {"{customer}"}, {"{project}"}, {"{mission}"}, {"{category}"}, {"{title}"}, {"{date}"}</small>
                      </div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(320px,1fr) minmax(320px,1fr)", alignItems: "start", marginTop: "18px" }}>
                      <div className="card">
                        <div className="sectionHead"><div><h3>🚁 Missionen Pro</h3><p>Missionen mit Kunde, Team, Drohne, Standort, Checkliste, Medien, Flügen und Bericht.</p></div><Status status="good">{missions.length}</Status></div>
                        <div className="profileGrid">
                          <label>Titel<input value={missionDraft.title} onChange={(e) => setMissionDraft({ ...missionDraft, title: e.target.value })} placeholder="z. B. Baustellendokumentation" /></label>
                          <label>Kunde<select value={missionDraft.customerId} onChange={(e) => setMissionDraft({ ...missionDraft, customerId: e.target.value })}><option value="">Ohne Kunde</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.company || customer.contactName || customer.customerNumber}</option>)}</select></label>
                          <label>Pilot<input value={missionDraft.pilot} onChange={(e) => setMissionDraft({ ...missionDraft, pilot: e.target.value })} /></label>
                          <label>Spotter<input value={missionDraft.spotter || ""} onChange={(e) => setMissionDraft({ ...missionDraft, spotter: e.target.value })} /></label>
                          <label>Kamera/Assistenz<input value={missionDraft.cameraOperator || ""} onChange={(e) => setMissionDraft({ ...missionDraft, cameraOperator: e.target.value })} /></label>
                          <label>Drohne<input value={missionDraft.drone} onChange={(e) => setMissionDraft({ ...missionDraft, drone: e.target.value })} /></label>
                          <label>Datum<input type="date" value={missionDraft.date} onChange={(e) => setMissionDraft({ ...missionDraft, date: e.target.value })} /></label>
                          <label>Start<input type="time" value={missionDraft.startTime || ""} onChange={(e) => setMissionDraft({ ...missionDraft, startTime: e.target.value })} /></label>
                          <label>Ende<input type="time" value={missionDraft.endTime || ""} onChange={(e) => setMissionDraft({ ...missionDraft, endTime: e.target.value })} /></label>
                          <label>Status<select value={missionDraft.status} onChange={(e) => setMissionDraft({ ...missionDraft, status: e.target.value })}>{["Geplant", "Aktiv", "Pausiert", "Erfolgt", "Storno"].map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
                          <label>Priorität<select value={missionDraft.priority || "Normal"} onChange={(e) => setMissionDraft({ ...missionDraft, priority: e.target.value })}><option>Normal</option><option>Hoch</option><option>Kritisch</option></select></label>
                          <label>Koordinaten<input value={missionDraft.coordinates || ""} onChange={(e) => setMissionDraft({ ...missionDraft, coordinates: e.target.value })} placeholder="54.323000, 10.122000" /></label>
                          <label style={{ gridColumn: "1 / -1" }}>Standort<input value={missionDraft.location} onChange={(e) => setMissionDraft({ ...missionDraft, location: e.target.value })} /></label>
                          <label style={{ gridColumn: "1 / -1" }}>Adresse<input value={missionDraft.address || ""} onChange={(e) => setMissionDraft({ ...missionDraft, address: e.target.value })} /></label>
                          <label style={{ gridColumn: "1 / -1" }}>Notizen<textarea rows={3} value={missionDraft.notes || ""} onChange={(e) => setMissionDraft({ ...missionDraft, notes: e.target.value })} /></label>
                        </div>
                        <div className="buttonRow"><button type="button" className="primary smallButton" onClick={addMissionWorking}>Mission speichern</button></div>
                        <div className="profileGrid" style={{ marginTop: 12 }}>
                          <label>Mission suchen<input value={missionSearch} onChange={(e) => setMissionSearch(e.target.value)} placeholder="Titel, Kunde, Pilot, Ort" /></label>
                          <label>Statusfilter<select value={missionStatusFilter} onChange={(e) => setMissionStatusFilter(e.target.value)}>{["Alle", "Geplant", "Aktiv", "Pausiert", "Erfolgt", "Storno"].map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
                        </div>
                        <div className="logbookList" style={{ marginTop: 12, maxHeight: 460, overflowY: "auto" }}>{filteredMissions.map((mission) => { const media = getMissionMediaWorking(mission); const flights = getMissionFlightsWorking(mission); const checklist = Array.isArray(mission.checklist) ? mission.checklist : []; const done = checklist.filter((item) => item.done).length; return <div key={mission.id} className="listitem"><strong>{mission.title}</strong><span>{mission.customerName} · {mission.date || "ohne Datum"}{mission.startTime ? ` · ${mission.startTime}` : ""}{mission.endTime ? `–${mission.endTime}` : ""} · {mission.pilot} · {mission.drone}</span><small>{mission.location || mission.address || "ohne Standort"} · {mission.status} · Priorität: {mission.priority || "Normal"} · Medien: {media.length} · Flüge: {flights.length} · Checkliste: {done}/{checklist.length}</small>{mission.notes ? <small>{mission.notes}</small> : null}<div style={{ marginTop: 8 }}>{checklist.slice(0, 5).map((check) => <label key={check.id} style={{ display: "flex", alignItems: "center", gap: 8, margin: "3px 0" }}><input type="checkbox" checked={Boolean(check.done)} onChange={() => toggleMissionChecklistWorking(mission.id, check.id)} /> <span>{check.label}</span></label>)}</div><div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => updateMissionWorking(mission.id, { status: mission.status === "Erfolgt" ? "Geplant" : "Erfolgt" })}>Status wechseln</button><button type="button" className="secondary smallButton" onClick={() => addMissionChecklistItemWorking(mission.id)}>Checkliste +</button><button type="button" className="secondary smallButton" onClick={() => exportMissionPdfWorking(mission)}>PDF-Bericht</button><button type="button" className="secondary smallButton" onClick={() => exportMissionJsonWorking(mission)}>JSON</button><button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => window.confirm("Mission wirklich löschen?") && setMissions(missions.filter((item) => item.id !== mission.id))}>Löschen</button></div></div>; })}</div>
                      </div>

                      <div className="card">
                        <div className="sectionHead"><div><h3>Wetterhistorie</h3><p>Wetterdaten zu Flügen speichern und nachvollziehen.</p></div><Status status="good">{weatherHistory.length}</Status></div>
                        <div className="buttonRow"><button type="button" className="primary smallButton" onClick={() => captureWeatherSnapshotWorking()}>Aktuelles Wetter speichern</button><button type="button" className="secondary smallButton" onClick={() => setWeatherHistory([])}>Historie leeren</button></div>
                        <div className="logbookList" style={{ marginTop: 12, maxHeight: 320, overflowY: "auto" }}>{weatherHistory.map((entry) => <div key={entry.id} className="listitem"><strong>{entry.registrationNumber || entry.location || "Wetter"}</strong><span>{entry.date} · {entry.temperature} °C · Wind {entry.wind} km/h · Böen {entry.gusts} km/h</span><small>{entry.createdAt}</small></div>)}</div>
                      </div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(320px,1fr) minmax(320px,1fr)", alignItems: "start", marginTop: "18px" }}>
                      <div className="card">
                        <div className="sectionHead"><div><h3>Kundenportal & Kunden-Dashboard</h3><p>Kundenbezogene Übersicht über Projekte, Medien, Rechnungen und Flüge.</p></div><Status status={flymonitorProSettings.customerPortalEnabled ? "good" : "warning"}>{flymonitorProSettings.customerPortalEnabled ? "aktiv" : "inaktiv"}</Status></div>
                        <label>Suche<input value={customerPortalSearch} onChange={(e) => setCustomerPortalSearch(e.target.value)} placeholder="Kunde suchen" /></label>
                        <div className="logbookList" style={{ marginTop: 12, maxHeight: 360, overflowY: "auto" }}>{customerPortalCustomers.map((customer) => { const customerInvoices = invoices.filter((invoice) => String(invoice.customerId) === String(customer.id) || String(invoice.customerName || "").toLowerCase().includes(String(customer.company || customer.contactName || "").toLowerCase())); return <div key={customer.id} className="listitem"><strong>{customer.company || customer.contactName || "Kunde"}</strong><span>{customer.email || "Keine E-Mail"} · {customerInvoices.length} Rechnung(en)</span><small>Portal-Code: {customer.portalCode || "noch nicht vergeben"}</small></div>; })}</div>
                      </div>

                      <div className="card">
                        <div className="sectionHead"><div><h3>📦 Download-Center Pro</h3><p>Medien, Galerien, Kunden- und Projektpakete exportieren.</p></div><Status status={downloadCenterItems.length ? "good" : "warning"}>{downloadCenterItems.length} Treffer</Status></div>
                        <div className="profileGrid">
                          <label>Suche<input value={downloadCenterSearch} onChange={(e) => setDownloadCenterSearch(e.target.value)} placeholder="Titel, Tag, Kunde, Projekt" /></label>
                          <label>Kategorie<select value={downloadCenterCategory} onChange={(e) => setDownloadCenterCategory(e.target.value)}>{galleryCategories.map((category) => <option key={`download-cat-${category}`} value={category}>{category}</option>)}</select></label>
                          <label>Kunde<select value={downloadCenterCustomer} onChange={(e) => setDownloadCenterCustomer(e.target.value)}>{downloadCenterCustomerOptions.map((customer) => <option key={`download-customer-${customer}`} value={customer}>{customer}</option>)}</select></label>
                          <label>Projekt/Mission<select value={downloadCenterProject} onChange={(e) => setDownloadCenterProject(e.target.value)}>{downloadCenterProjectOptions.map((project) => <option key={`download-project-${project}`} value={project}>{project}</option>)}</select></label>
                          <label>Medientyp<select value={downloadCenterMediaType} onChange={(e) => setDownloadCenterMediaType(e.target.value)}><option value="Alle">Alle</option><option value="image">Bilder</option><option value="video">Videos</option></select></label>
                          <label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={downloadCenterFavoritesOnly} onChange={(e) => setDownloadCenterFavoritesOnly(e.target.checked)} /> Nur Favoriten/Highlights</label>
                        </div>
                        <div className="buttonRow" style={{ marginTop: "12px" }}>
                          <button type="button" className="primary smallButton" onClick={() => exportDownloadPackageWorking(downloadCenterItems, "flymonitor-download-paket")}>Download-Paket JSON</button>
                          <button type="button" className="secondary smallButton" onClick={() => exportGalleryPdfWorking(downloadCenterItems, "FlyMonitor Galerie-PDF")}>Galerie-PDF</button>
                          <button type="button" className="secondary smallButton" onClick={() => exportDownloadHtmlWorking(downloadCenterItems, "FlyMonitor Galerie-Download")}>HTML-Galerie</button>
                          <button type="button" className="secondary smallButton" onClick={() => downloadJsonWorking(`flymonitor-komplett-${Date.now()}.json`, { customers, invoices, galleryItems, galleryManagedCategories, missions, weatherHistory, completedFlights })}>Komplett-Export</button>
                        </div>
                        <div className="logbookList" style={{ marginTop: 12, maxHeight: 360, overflowY: "auto" }}>
                          {downloadCenterItems.slice(0, 30).map((item) => (
                            <div key={`download-center-${item.id}`} className="listitem">
                              <strong>{item.title || "Medium"}</strong>
                              <span>{getGalleryMediaType(item) === "video" ? "Video" : "Bild"} · {item.category || "Allgemein"}{item.subcategory ? ` / ${item.subcategory}` : ""}{item.customerId ? ` · Kunde: ${item.customerId}` : ""}{item.projectId ? ` · Projekt: ${item.projectId}` : ""}</span>
                              <small>{formatGalleryCoordinates(item) || item.address || "Kein Standort"}</small>
                              <div className="buttonRow">
                                <button type="button" className="secondary smallButton" onClick={() => downloadGalleryMediaWorking(item)}>Original herunterladen</button>
                                <button type="button" className="secondary smallButton" onClick={() => setSelectedGalleryMapItem(item)}>Vorschau öffnen</button>
                              </div>
                            </div>
                          ))}
                        </div>
                        <p style={{ color: "#64748b", marginTop: "10px" }}>Hinweis: Ein echter ZIP-Download benötigt serverseitig eine ZIP-API oder eine installierte JSZip-Bibliothek. Diese Version erzeugt sofort nutzbare JSON-, HTML- und PDF-Exportpakete mit Original-Downloadlinks.</p>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead"><div><h3>Backup-System Pro</h3><p>Backup-Historie, Export und Server-Backup kombinieren.</p></div><Status status="good">{backupJobs.length} Einträge</Status></div>
                      <div className="buttonRow"><button type="button" className="primary smallButton" onClick={() => createBackupJobWorking("Täglich")}>Tägliches Backup vormerken</button><button type="button" className="secondary smallButton" onClick={() => downloadJsonWorking(`flymonitor-backup-local-${Date.now()}.json`, { customers, offers, invoices, galleryItems, galleryManagedCategories, missions, weatherHistory, completedFlights })}>Lokales Backup herunterladen</button></div>
                      <div className="logbookList" style={{ marginTop: 12 }}>{backupJobs.map((job) => <div key={job.id} className="listitem"><strong>{job.type} Backup</strong><span>{job.status} · {job.createdAt}</span><small>{job.note}</small></div>)}</div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "cloudSync" ? (
                  <div>
                    <div className="sectionHead">
                      <div><h2>Cloud Sync Pro</h2><p>Cloud-Ziele, Backup-Synchronisation, Exportpakete und Wiederherstellung vorbereiten.</p></div>
                      <Status status={cloudSyncDashboardStatsPro.errors ? "warning" : cloudSyncDashboardStatsPro.activeTargets ? "good" : "warning"}>{cloudSyncDashboardStatsPro.activeTargets} aktiv</Status>
                    </div>

                    <div className="dashboardGrid" style={{ marginBottom: 18 }}>
                      <div className="dashCard"><strong>{cloudSyncDashboardStatsPro.totalTargets}</strong><span>Cloud-Ziele</span></div>
                      <div className="dashCard"><strong>{cloudSyncDashboardStatsPro.activeTargets}</strong><span>Aktiv</span></div>
                      <div className="dashCard"><strong>{cloudSyncDashboardStatsPro.totalLogs}</strong><span>Sync-Protokolle</span></div>
                      <div className="dashCard"><strong>{cloudSyncDashboardStatsPro.errors}</strong><span>Fehler</span></div>
                      <div className="dashCard"><strong>{cloudSyncDashboardStatsPro.lastSyncAt}</strong><span>Letzte Sicherung</span></div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(320px, 0.9fr) minmax(420px, 1.1fr)", alignItems: "start" }}>
                      <div className="card">
                        <h3>{editingCloudSyncTargetId ? "Cloud-Ziel bearbeiten" : "Cloud-Ziel hinzufügen"}</h3>
                        <div className="profileGrid">
                          <label>Name<input value={cloudSyncTargetDraft.name || ""} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, name: e.target.value })} placeholder="z.B. Nextcloud FlyMonitor" /></label>
                          <label>Typ<select value={cloudSyncTargetDraft.type || "Nextcloud"} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, type: e.target.value })}>{CLOUD_SYNC_TARGET_TYPES_PRO.map((type) => <option key={`cloud-type-${type}`} value={type}>{type}</option>)}</select></label>
                          <label>URL / Zielpfad<input value={cloudSyncTargetDraft.url || ""} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, url: e.target.value })} placeholder="https://cloud.example.de/remote.php/dav/..." /></label>
                          <label>Benutzer<input value={cloudSyncTargetDraft.username || ""} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, username: e.target.value })} placeholder="Benutzername / Konto" /></label>
                          <label>Token-Hinweis<input value={cloudSyncTargetDraft.tokenHint || ""} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, tokenHint: e.target.value })} placeholder="Token nicht im Klartext speichern" /></label>
                          <label>Intervall<select value={cloudSyncTargetDraft.interval || "Manuell"} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, interval: e.target.value })}>{CLOUD_SYNC_INTERVALS_PRO.map((interval) => <option key={`cloud-interval-${interval}`} value={interval}>{interval}</option>)}</select></label>
                          <label>Status<select value={cloudSyncTargetDraft.active === false ? "Inaktiv" : "Aktiv"} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, active: e.target.value === "Aktiv" })}><option>Aktiv</option><option>Inaktiv</option></select></label>
                          <label>Notizen<textarea value={cloudSyncTargetDraft.notes || ""} onChange={(e) => setCloudSyncTargetDraft({ ...cloudSyncTargetDraft, notes: e.target.value })} placeholder="Hinweise zu Pfad, Freigaben oder Restore" /></label>
                        </div>

                        <div style={{ marginTop: 12 }}>
                          <strong>Zu synchronisierende Bereiche</strong>
                          <div className="chipRow" style={{ marginTop: 8 }}>
                            {CLOUD_SYNC_SCOPES_PRO.map((scope) => (
                              <label key={`scope-${scope}`} className="chip" style={{ cursor: "pointer" }}>
                                <input type="checkbox" checked={(cloudSyncTargetDraft.scopes || []).includes(scope)} onChange={(e) => updateCloudSyncTargetScopePro(scope, e.target.checked)} /> {scope}
                              </label>
                            ))}
                          </div>
                        </div>

                        <div className="buttonRow" style={{ marginTop: 12 }}>
                          <button type="button" className="primary smallButton" onClick={saveCloudSyncTargetPro}>{editingCloudSyncTargetId ? "Änderungen speichern" : "Cloud-Ziel speichern"}</button>
                          <button type="button" className="secondary smallButton" onClick={resetCloudSyncTargetDraftPro}>Zurücksetzen</button>
                          <button type="button" className="secondary smallButton" onClick={exportCloudSyncSettingsPro}>Konfiguration exportieren</button>
                        </div>
                        <p style={{ color: "#64748b", marginTop: 10 }}>Hinweis: Diese App erzeugt sichere Exportpakete und Protokolle. Die echte Übertragung zu Nextcloud, Google Drive, OneDrive oder Dropbox benötigt serverseitige API-Endpunkte/OAuth.</p>
                      </div>

                      <div className="card">
                        <div className="sectionHead"><div><h3>Cloud-Ziele</h3><p>Ziele filtern, manuell sichern und Exportpakete erzeugen.</p></div><Status status={filteredCloudSyncTargetsPro.length ? "good" : "warning"}>{filteredCloudSyncTargetsPro.length} Treffer</Status></div>
                        <div className="profileGrid">
                          <label>Suche<input value={cloudSyncSearch} onChange={(e) => setCloudSyncSearch(e.target.value)} placeholder="Name, Typ, URL, Bereich" /></label>
                          <label>Bereich<select value={cloudSyncScopeFilter} onChange={(e) => setCloudSyncScopeFilter(e.target.value)}><option value="Alle">Alle</option>{CLOUD_SYNC_SCOPES_PRO.map((scope) => <option key={`cloud-filter-${scope}`} value={scope}>{scope}</option>)}</select></label>
                        </div>
                        <div className="logbookList" style={{ marginTop: 12, maxHeight: 430, overflowY: "auto" }}>
                          {filteredCloudSyncTargetsPro.map((target) => (
                            <div key={target.id} className="listitem">
                              <strong>{target.name}</strong>
                              <span>{target.type} · {target.interval} · {target.active === false ? "Inaktiv" : "Aktiv"} · {target.status || "Bereit"}</span>
                              <small>{target.url || "Kein Zielpfad"}</small>
                              <small>Bereiche: {(target.scopes || []).join(", ") || "Keine"}</small>
                              <small>Letzte Sicherung: {target.lastSyncAt || "noch nicht ausgeführt"}</small>
                              <div className="buttonRow">
                                <button type="button" className="primary smallButton" onClick={() => runCloudSyncTargetPro(target)}>Jetzt sichern</button>
                                <button type="button" className="secondary smallButton" onClick={() => editCloudSyncTargetPro(target)}>Bearbeiten</button>
                                <button type="button" className="secondary smallButton" onClick={() => deleteCloudSyncTargetPro(target.id)}>Löschen</button>
                              </div>
                            </div>
                          ))}
                          {!filteredCloudSyncTargetsPro.length ? <p>Noch keine Cloud-Ziele vorhanden.</p> : null}
                        </div>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: 18 }}>
                      <div className="sectionHead"><div><h3>Sync-Protokoll & Restore-Vorbereitung</h3><p>Alle Cloud-Sicherungen werden mit Status und Details protokolliert.</p></div><Status status={cloudSyncLogsPro.length ? "good" : "warning"}>{cloudSyncLogsPro.length} Einträge</Status></div>
                      <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => downloadJsonWorking(`flymonitor-cloud-sync-full-${Date.now()}.json`, buildCloudSyncPayloadPro())}>Komplettes Sync-Paket herunterladen</button><button type="button" className="secondary smallButton" onClick={() => setCloudSyncLogsPro([])}>Protokoll leeren</button></div>
                      <div className="logbookList" style={{ marginTop: 12, maxHeight: 300, overflowY: "auto" }}>
                        {(cloudSyncLogsPro || []).map((log) => <div key={log.id} className="listitem"><strong>{log.targetName}</strong><span>{log.status} · {log.type} · {log.createdAt}</span><small>{log.details}</small></div>)}
                        {!cloudSyncLogsPro.length ? <p>Noch keine Synchronisation protokolliert.</p> : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "mobilePro" ? (
                  <div>
                    <div className="sectionHead">
                      <div><h2>PWA / Mobile Pro</h2><p>Installierbare Web-App, Offline-Missionen, mobile Checklisten, GPS und Smartphone-Uploads vorbereiten.</p></div>
                      <Status status={mobilePwaSettingsPro.offlineEnabled ? "good" : "warning"}>{mobileDashboardStatsPro.offlineReady} offline bereit</Status>
                    </div>

                    <div className="dashGrid" style={{ marginBottom: 18 }}>
                      <div className="dashCard"><strong>{mobileDashboardStatsPro.total}</strong><span>Mobile Missionen</span></div>
                      <div className="dashCard"><strong>{mobileDashboardStatsPro.active}</strong><span>Aktiv/Gestartet</span></div>
                      <div className="dashCard"><strong>{mobileDashboardStatsPro.unsynced}</strong><span>Noch nicht synchron</span></div>
                      <div className="dashCard"><strong>{mobileDashboardStatsPro.mediaCount}</strong><span>Mobile Medien</span></div>
                      <div className="dashCard"><strong>{mobileDashboardStatsPro.installReady}</strong><span>PWA Status</span></div>
                    </div>

                    <div className="card" style={{ marginBottom: 18 }}>
                      <div className="sectionHead"><div><h3>PWA Einstellungen</h3><p>Grundlage für Manifest, Offline-Cache und Push-Vorbereitung.</p></div><button type="button" className="secondary smallButton" onClick={exportPwaMobilePackagePro}>PWA-Konfiguration exportieren</button></div>
                      <div className="formGrid">
                        <label>App-Name<input value={mobilePwaSettingsPro.appName || ""} onChange={(e) => setMobilePwaSettingsPro({ ...mobilePwaSettingsPro, appName: e.target.value })} /></label>
                        <label>Offline-Modus<select value={mobilePwaSettingsPro.offlineEnabled ? "Aktiv" : "Inaktiv"} onChange={(e) => setMobilePwaSettingsPro({ ...mobilePwaSettingsPro, offlineEnabled: e.target.value === "Aktiv" })}><option>Aktiv</option><option>Inaktiv</option></select></label>
                        <label>Service-Worker Check<input value={mobilePwaSettingsPro.lastServiceWorkerCheck || ""} onChange={(e) => setMobilePwaSettingsPro({ ...mobilePwaSettingsPro, lastServiceWorkerCheck: e.target.value })} placeholder="z.B. 10.06.2026, geprüft" /></label>
                      </div>
                    </div>

                    <div className="card" style={{ marginBottom: 18 }}>
                      <div className="sectionHead"><div><h3>{editingMobileMissionIdPro ? "Mobile Mission bearbeiten" : "Mobile Mission anlegen"}</h3><p>Für Vor-Ort-Einsätze mit GPS, Checklisten und Offline-Status.</p></div><button type="button" className="secondary smallButton" onClick={resetMobileMissionDraftPro}>Zurücksetzen</button></div>
                      <div className="formGrid">
                        <label>Titel<input value={mobileMissionDraftPro.title || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, title: e.target.value })} placeholder="z.B. Baustelle Kiel – Vor-Ort Einsatz" /></label>
                        <label>Kunde<input value={mobileMissionDraftPro.customerId || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, customerId: e.target.value })} /></label>
                        <label>Projekt<input value={mobileMissionDraftPro.projectId || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, projectId: e.target.value })} /></label>
                        <label>Pilot<input value={mobileMissionDraftPro.pilot || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, pilot: e.target.value })} /></label>
                        <label>Drohne<input value={mobileMissionDraftPro.drone || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, drone: e.target.value })} /></label>
                        <label>Status<select value={mobileMissionDraftPro.status || "Geplant"} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, status: e.target.value })}><option>Geplant</option><option>Aktiv</option><option>Gestartet</option><option>Abgeschlossen</option><option>Synchronisiert</option></select></label>
                        <label>Datum<input type="date" value={mobileMissionDraftPro.date || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, date: e.target.value })} /></label>
                        <label>Adresse<input value={mobileMissionDraftPro.address || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, address: e.target.value })} /></label>
                        <label>Koordinaten<input value={mobileMissionDraftPro.coordinates || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, coordinates: e.target.value })} /></label>
                        <label>Mobile Medienanzahl<input type="number" min="0" value={mobileMissionDraftPro.mediaCount || 0} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, mediaCount: Number(e.target.value || 0) })} /></label>
                        <label>Notizen<textarea value={mobileMissionDraftPro.notes || ""} onChange={(e) => setMobileMissionDraftPro({ ...mobileMissionDraftPro, notes: e.target.value })} /></label>
                      </div>
                      <div className="actions" style={{ marginTop: 12 }}>
                        <button type="button" className="secondary smallButton" onClick={useCurrentPositionForMobileMissionPro}>GPS übernehmen</button>
                        <button type="button" className="primary smallButton" onClick={saveMobileMissionPro}>{editingMobileMissionIdPro ? "Mobile Mission speichern" : "Mobile Mission hinzufügen"}</button>
                      </div>
                      <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", marginTop: 14 }}>
                        <div className="card"><h4>Vorflug-Checkliste</h4>{(mobileMissionDraftPro.preflightChecklist || []).map((item, index) => <label key={`preflight-${index}`} style={{ display: "block", marginBottom: 6 }}><input type="checkbox" checked={Boolean(item.done)} onChange={() => toggleMobileChecklistItemPro("preflightChecklist", index)} /> {item.label}</label>)}</div>
                        <div className="card"><h4>Nachflug-Checkliste</h4>{(mobileMissionDraftPro.postflightChecklist || []).map((item, index) => <label key={`postflight-${index}`} style={{ display: "block", marginBottom: 6 }}><input type="checkbox" checked={Boolean(item.done)} onChange={() => toggleMobileChecklistItemPro("postflightChecklist", index)} /> {item.label}</label>)}</div>
                      </div>
                    </div>

                    <div className="card">
                      <div className="sectionHead"><div><h3>Mobile Missionen</h3><p>Offline-fähige Einsätze für Smartphone und Tablet.</p></div><Status status={filteredMobileMissionsPro.length ? "good" : "warning"}>{filteredMobileMissionsPro.length} Treffer</Status></div>
                      <div className="formGrid" style={{ marginBottom: 12 }}>
                        <label>Suche<input value={mobileMissionSearchPro} onChange={(e) => setMobileMissionSearchPro(e.target.value)} placeholder="Titel, Kunde, Drohne, Ort" /></label>
                        <label>Status<select value={mobileMissionStatusFilterPro} onChange={(e) => setMobileMissionStatusFilterPro(e.target.value)}><option>Alle</option><option>Geplant</option><option>Aktiv</option><option>Gestartet</option><option>Abgeschlossen</option><option>Synchronisiert</option></select></label>
                      </div>
                      <div className="stackList">
                        {filteredMobileMissionsPro.map((mission) => {
                          const preDone = (mission.preflightChecklist || []).filter((item) => item.done).length;
                          const postDone = (mission.postflightChecklist || []).filter((item) => item.done).length;
                          return (
                            <div key={mission.id} className="listitem">
                              <strong>{mission.title}</strong>
                              <span>{mission.status} · {mission.date || "ohne Datum"} · {mission.pilot || "ohne Pilot"} · {mission.drone || "ohne Drohne"}</span>
                              <small>{mission.address || mission.coordinates || "Kein Standort"} · Vorflug {preDone}/{(mission.preflightChecklist || []).length} · Nachflug {postDone}/{(mission.postflightChecklist || []).length} · {mission.synced ? "Synchronisiert" : "Offline/ausstehend"}</small>
                              <div className="actions"><button type="button" className="secondary smallButton" onClick={() => editMobileMissionPro(mission)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => markMobileMissionSyncedPro(mission.id)}>Als synchron markieren</button><button type="button" className="danger smallButton" onClick={() => deleteMobileMissionPro(mission.id)}>Löschen</button></div>
                            </div>
                          );
                        })}
                        {!filteredMobileMissionsPro.length ? <p>Noch keine mobilen Missionen vorhanden.</p> : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "customerPortalPro" ? (
                  <div>
                    <div className="sectionHead">
                      <div><h2>Customer Portal Pro</h2><p>Kundenlogin, Missionsstatus, Dokumente, Rechnungen, Medien und Download-Freigaben zentral verwalten.</p></div>
                      <button type="button" className="secondary smallButton" onClick={exportCustomerPortalProPackage}>Portal-Paket exportieren</button>
                    </div>

                    <section className="ultimateDashboard" style={{ marginTop: "16px" }}>
                      <div className="dashCard"><strong>{customerPortalProStats.total}</strong><span>Kunden im Portal</span></div>
                      <div className="dashCard"><strong>{customerPortalProStats.active}</strong><span>Portal aktiv</span></div>
                      <div className="dashCard"><strong>{customerPortalProStats.withoutCode}</strong><span>Ohne Portalcode</span></div>
                      <div className="dashCard"><strong>{customerPortalProStats.openMissions}</strong><span>Offene Missionen</span></div>
                      <div className="dashCard"><strong>{customerPortalProStats.openInvoices}</strong><span>Offene Rechnungen</span></div>
                      <div className="dashCard"><strong>{customerPortalProStats.media}</strong><span>Kundenmedien</span></div>
                    </section>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead"><div><h3>Portal-Filter</h3><p>Kunden nach Portalstatus, Code, Firma oder E-Mail durchsuchen.</p></div><Status status={flymonitorProSettings.customerPortalEnabled ? "good" : "warning"}>{flymonitorProSettings.customerPortalEnabled ? "Portal aktiv" : "Portal inaktiv"}</Status></div>
                      <div className="formGrid">
                        <label>Suche<input value={customerPortalSearch} onChange={(e) => setCustomerPortalSearch(e.target.value)} placeholder="Kunde, Portalcode, E-Mail" /></label>
                        <label>Status<select value={customerPortalStatusFilterPro} onChange={(e) => setCustomerPortalStatusFilterPro(e.target.value)}><option>Alle</option><option>Aktiv</option><option>Ohne Code</option></select></label>
                        <label>Portal global<button type="button" className="secondary smallButton" onClick={() => setFlymonitorProSettings({ ...flymonitorProSettings, customerPortalEnabled: !flymonitorProSettings.customerPortalEnabled })}>{flymonitorProSettings.customerPortalEnabled ? "Portal deaktivieren" : "Portal aktivieren"}</button></label>
                      </div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", marginTop: "18px" }}>
                      {customerPortalProRows.map((row) => {
                        const customer = row.customer;
                        const portalUrl = typeof window !== "undefined" ? `${window.location.origin}${window.location.pathname}#kundenportal?code=${encodeURIComponent(row.portalCode || "")}` : "";
                        return (
                          <div key={customer.id || customer.customerNumber || customer.email} className="card">
                            <div className="sectionHead"><div><h3>{customer.company || customer.contactName || "Kunde"}</h3><p>{customer.email || "Keine E-Mail"}</p></div><Status status={row.status === "Aktiv" ? "good" : "warning"}>{row.status}</Status></div>
                            <div className="stackList">
                              <div className="listitem"><strong>Portalcode</strong><span>{row.portalCode || "noch nicht vergeben"}</span><small>{portalUrl || "Portal-Link wird im Browser erzeugt"}</small></div>
                              <div className="listitem"><strong>Missionen</strong><span>{row.customerMissions.length} gesamt · {row.openMissions.length} offen</span></div>
                              <div className="listitem"><strong>Rechnungen</strong><span>{row.customerInvoices.length} gesamt · {row.openInvoices.length} offen</span></div>
                              <div className="listitem"><strong>Medien & Dokumente</strong><span>{row.customerMedia.length} Medien · {row.customerDocuments.length} Dokument(e)</span></div>
                            </div>
                            <div className="actions" style={{ marginTop: 12 }}>
                              <button type="button" className="secondary smallButton" onClick={() => { setCrmSelectedCustomerId(customer.id); setAdminCenterTab("customers"); }}>CRM öffnen</button>
                              <button type="button" className="secondary smallButton" onClick={() => navigator.clipboard?.writeText(portalUrl)}>Link kopieren</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {!customerPortalProRows.length ? <div className="card" style={{ marginTop: 18 }}><p>Keine Kunden für die aktuelle Auswahl gefunden.</p></div> : null}
                  </div>
                ) : null}

                {adminCenterTab === "flights" ? (
                  <div>
                    <div className="sectionHead"><div><h2>Flüge</h2><p>Abgeschlossene Flüge und Flugbuch zentral verwalten.</p></div><button type="button" className="primary smallButton" onClick={openNewFlightRegistrationWorking}>Neue Fluganmeldung</button></div>
                    <section className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
                      <div className="card"><h3>Abgeschlossene Flüge</h3><p>{completedFlights.length} abgeschlossene Flüge gespeichert.</p><button type="button" className="secondary smallButton" onClick={exportCompletedFlightsCsvWorking}>CSV exportieren</button></div>
                      <div className="card"><h3>Flugbuch</h3><p>{logbook.length} Einträge vorhanden.</p><button type="button" className="secondary smallButton" onClick={exportCsvWorking}>CSV exportieren</button></div>
                      <div className="card"><h3>E-Mail Versand</h3><p>{selectedRecipientIds.length} Empfänger ausgewählt. Manuelle Empfänger können ergänzt werden.</p><input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="zusatz@example.de; weitere@example.de" /><button type="button" className="secondary smallButton" style={{ marginTop: "10px" }} onClick={() => setAdminCenterTab("authorities")}>Empfänger verwalten</button></div>
                    </section>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead">
                        <div>
                          <h3>PDF-Dokumente für E-Mail-Anhänge</h3>
                          <p>PDFs mit Kategorie, Gültigkeit, Ablaufwarnung und automatischer Vorauswahl verwalten.</p>
                        </div>
                        <Status status={mailPdfDocumentSummary.expired ? "danger" : mailPdfDocumentSummary.expiring ? "warning" : mailPdfDocuments.length ? "good" : "warning"}>
                          {mailPdfDocuments.length} PDF(s) · {mailPdfDocumentSummary.autoAttach} Auto
                        </Status>
                      </div>

                      {mailPdfDocumentSummary.expired || mailPdfDocumentSummary.expiring ? (
                        <div className="card" style={{ background: mailPdfDocumentSummary.expired ? "#fee2e2" : "#fff7ed", borderColor: mailPdfDocumentSummary.expired ? "#fecaca" : "#fed7aa", marginBottom: "14px" }}>
                          <strong>{mailPdfDocumentSummary.expired ? "Dokumente abgelaufen" : "Dokumente laufen bald ab"}</strong>
                          {[...mailPdfDocumentSummary.expiredItems, ...mailPdfDocumentSummary.expiringItems].slice(0, 6).map((document) => (
                            <span key={document.id} style={{ display: "block", marginTop: "6px" }}>
                              {document.title || document.name} · {formatMailPdfDocumentLine(document)}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      <label>
                        PDF-Dokumente hochladen
                        <input
                          type="file"
                          accept="application/pdf,.pdf"
                          multiple
                          onChange={(event) => {
                            addMailPdfDocumentsWorking(event.target.files);
                            event.target.value = "";
                          }}
                        />
                      </label>

                      <div className="logbookList" style={{ marginTop: "12px" }}>
                        {normalizeMailPdfDocumentList(mailPdfDocuments).map((document) => {
                          const documentStatus = getMailPdfDocumentStatus(document);
                          return (
                            <div key={document.id} className="listitem">
                              <div className="sectionHead" style={{ gap: "10px", alignItems: "flex-start" }}>
                                <div>
                                  <strong>{document.title || document.name || "PDF-Dokument"}</strong>
                                  <span>{document.name || "PDF-Datei"} · gespeichert: {document.addedAt || "-"}</span>
                                  <span>{formatMailPdfDocumentLine(document)}</span>
                                </div>
                                <Status status={documentStatus.tone}>{documentStatus.label}</Status>
                              </div>

                              <div className="profileGrid" style={{ marginTop: "10px" }}>
                                <label>Titel<input value={document.title || ""} onChange={(event) => updateMailPdfDocumentWorking(document.id, { title: event.target.value })} /></label>
                                <label>Kategorie
                                  <select value={document.category || "Sonstiges"} onChange={(event) => updateMailPdfDocumentWorking(document.id, { category: event.target.value })}>
                                    {MAIL_PDF_DOCUMENT_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                                  </select>
                                </label>
                                <label>Dokumentnummer<input value={document.documentNumber || ""} onChange={(event) => updateMailPdfDocumentWorking(document.id, { documentNumber: event.target.value })} placeholder="z. B. Versicherungsschein-Nr." /></label>
                                <label>Ausgestellt am<input type="date" value={document.issuedAt || ""} onChange={(event) => updateMailPdfDocumentWorking(document.id, { issuedAt: event.target.value })} /></label>
                                <label>Gültig bis<input type="date" value={document.validUntil || ""} onChange={(event) => updateMailPdfDocumentWorking(document.id, { validUntil: event.target.value })} /></label>
                                <label>Erinnerung Tage vorher<input type="number" min="1" value={document.reminderDays || 30} onChange={(event) => updateMailPdfDocumentWorking(document.id, { reminderDays: event.target.value })} /></label>
                              </div>

                              <label style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "10px", fontWeight: 800 }}>
                                <input
                                  type="checkbox"
                                  checked={Boolean(document.autoAttach)}
                                  onChange={(event) => updateMailPdfDocumentWorking(document.id, { autoAttach: event.target.checked })}
                                  style={{ width: 18, height: 18 }}
                                />
                                Automatisch bei Fluganmeldung per E-Mail anhängen
                              </label>

                              <div className="buttonRow" style={{ marginTop: "8px" }}>
                                {document.dataUrl ? (
                                  <a className="secondary smallButton" href={document.dataUrl} target="_blank" rel="noopener noreferrer">Öffnen</a>
                                ) : null}
                                <button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteMailPdfDocumentWorking(document.id)}>Löschen</button>
                              </div>
                            </div>
                          );
                        })}
                        {!mailPdfDocuments.length ? <p>Noch keine PDF-Dokumente hinterlegt.</p> : null}
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead">
                        <div>
                          <h3>Abgeschlossenen Flug auswählen</h3>
                          <p>Wähle einen abgeschlossenen Flug aus. Danach erscheint das vollständige Formular zum Anzeigen und Bearbeiten.</p>
                        </div>
                        <Status status={selectedCompletedFlightId ? "good" : "warning"}>{selectedCompletedFlightId ? "Ausgewählt" : "Bitte wählen"}</Status>
                      </div>
                      <div className="profileGrid">
                        <label style={{ gridColumn: "1 / -1" }}>
                          Suche in abgeschlossenen Flügen
                          <input
                            value={completedFlightSearch}
                            onChange={(event) => setCompletedFlightSearch(event.target.value)}
                            placeholder="Vorgangsnummer, PIN, Pilot, Drohne, Ort, Zweck, Status suchen"
                          />
                        </label>
                        <label>
                          Datum von
                          <input type="date" value={completedFlightFilterFrom} onChange={(event) => setCompletedFlightFilterFrom(event.target.value)} />
                        </label>
                        <label>
                          Datum bis
                          <input type="date" value={completedFlightFilterTo} onChange={(event) => setCompletedFlightFilterTo(event.target.value)} />
                        </label>
                        <label>
                          Pilot
                          <select value={completedFlightFilterPilot} onChange={(event) => setCompletedFlightFilterPilot(event.target.value)}>
                            <option value="">Alle Piloten</option>
                            {completedFlightPilots.map((pilot) => (
                              <option key={pilot} value={pilot}>{pilot}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Drohne
                          <select value={completedFlightFilterDrone} onChange={(event) => setCompletedFlightFilterDrone(event.target.value)}>
                            <option value="">Alle Drohnen</option>
                            {completedFlightDrones.map((drone) => (
                              <option key={drone} value={drone}>{drone}</option>
                            ))}
                          </select>
                        </label>
                        <div className="buttonRow" style={{ alignItems: "flex-end" }}>
                          <button type="button" className="secondary smallButton" onClick={resetCompletedFlightFiltersWorking}>Filter zurücksetzen</button>
                          <Status status={filteredCompletedFlights.length ? "good" : "warning"}>{filteredCompletedFlights.length} Treffer</Status>
                        </div>
                        <label style={{ gridColumn: "1 / -1" }}>
                          Abgeschlossener Flug
                          <select
                            value={selectedCompletedFlightId}
                            onChange={(event) => {
                              const value = event.target.value;
                              if (!value) {
                                resetCompletedFlightDraftWorking();
                                return;
                              }
                              if (value === "__new__") {
                                resetCompletedFlightDraftWorking();
                                setSelectedCompletedFlightId("__new__");
                                return;
                              }
                              const selected = completedFlights.find((entry) => getCompletedFlightKey(entry) === value);
                              if (selected) {
                                openCompletedFlightWorking(selected);
                              }
                            }}
                            style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px", fontWeight: 800 }}
                          >
                            <option value="">Bitte abgeschlossenen Flug auswählen</option>
                            <option value="__new__">+ Neuen abgeschlossenen Flug manuell erfassen</option>
                            {filteredCompletedFlights.map((entry) => (
                              <option key={getCompletedFlightKey(entry)} value={getCompletedFlightKey(entry)}>
                                {getCompletedFlightLabel(entry)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>

                    {(selectedCompletedFlightId || !completedFlights.length) ? (
                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead"><div><h3>{editingCompletedFlightId ? "Abgeschlossenen Flug bearbeiten" : "Erfolgten Flug manuell hinzufügen"}</h3><p>{editingCompletedFlightId ? "Der ausgewählte abgeschlossene Flug ist geladen und kann vollständig bearbeitet werden." : "Nachträge ohne vorherige Fluganmeldung direkt als abgeschlossenen Flug speichern."}</p></div><Status status="good">Admin</Status></div>
                      <div className="profileGrid">
                        <div className="listitem" style={{ gridColumn: "1 / -1", border: "2px solid #22c55e", background: "#dcfce7" }}><strong>UPDATE AKTIV</strong><span>Max. Flughöhe, Max. Entfernung, Temperatur und Behördenkontrolle sind eingebaut.</span></div>
                        <label>Vorgangsnummer<input value={completedFlightDraft.registrationNumber || ""} onChange={(e) => applyCompletedFlightRegistrationLookupWorking(e.target.value)} placeholder="z. B. FM-2026-000001" /></label>
                        <label>Behörden-PIN<input inputMode="numeric" maxLength={6} value={completedFlightDraft.authorityPin || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, authorityPin: e.target.value.replace(/\D/g, "").slice(0, 6) })} placeholder="6-stellige PIN" /></label>
                        <label>Datum<input type="date" value={completedFlightDraft.date || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, date: e.target.value })} /></label>
                        <label>Geplante Startzeit<input type="time" value={completedFlightDraft.startTime || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, startTime: e.target.value })} /></label>
                        <label>Geplante Endzeit<input type="time" value={completedFlightDraft.endTime || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, endTime: e.target.value })} /></label>
                        <label>Tatsächlicher Start<input type="time" value={completedFlightDraft.actualStartTime || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, actualStartTime: e.target.value })} /></label>
                        <label>Tatsächliches Ende<input type="time" value={completedFlightDraft.actualEndTime || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, actualEndTime: e.target.value })} /></label>
                        <label>Ort<input value={completedFlightDraft.city || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, city: e.target.value })} placeholder="z. B. Kiel" /></label>
                        <label>Fluggebiet<input value={completedFlightDraft.flightArea || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, flightArea: e.target.value })} placeholder="Einsatzstelle / Fluggebiet" /></label>
                        <label>Koordinaten<input value={completedFlightDraft.coordinates || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, coordinates: e.target.value })} placeholder="54.3510903, 10.1207161" /></label>
                        <label>Pilot<input value={completedFlightDraft.pilot || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, pilot: e.target.value })} /></label>
                        <label>Spotter / Beobachter vorhanden
                          <select value={completedFlightDraft.spotterAvailable || "Nein"} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, spotterAvailable: e.target.value })}>
                            <option value="Nein">Nein</option>
                            <option value="Ja">Ja</option>
                          </select>
                        </label>
                        {(completedFlightDraft.spotterAvailable || "Nein") === "Ja" ? (
                          <>
                            <label>Name Beobachter<input value={completedFlightDraft.spotterName || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, spotterName: e.target.value })} /></label>
                            <label>Telefon Beobachter<input value={completedFlightDraft.spotterPhone || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, spotterPhone: e.target.value })} /></label>
                            <label>Kommunikationsmittel
                              <select value={completedFlightDraft.communicationMethod || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, communicationMethod: e.target.value })}>
                                <option value="">Bitte auswählen</option>
                                {COMMUNICATION_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
                              </select>
                            </label>
                          </>
                        ) : null}
                        <label>Drohne<input value={completedFlightDraft.drone || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, drone: e.target.value })} /></label>
                        <label>Zweck<input value={completedFlightDraft.purpose || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, purpose: e.target.value })} /></label>
                        <label>Geflogene Strecke km<input type="number" step="0.1" value={completedFlightDraft.distanceKm || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, distanceKm: e.target.value })} /></label>
                        <label>Max. Flughöhe (m)<input type="number" value={completedFlightDraft.maxHeight || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, maxHeight: e.target.value })} placeholder="z. B. 120" /></label>
                        <label>Max. Entfernung zum Piloten (m)<input type="number" value={completedFlightDraft.maxDistance || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, maxDistance: e.target.value })} placeholder="z. B. 300" /></label>
                        <label>Akku Start %<input type="number" value={completedFlightDraft.batteryStart || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, batteryStart: e.target.value })} /></label>
                        <label>Akku Ende %<input type="number" value={completedFlightDraft.batteryEnd || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, batteryEnd: e.target.value })} /></label>
                        <label>Wetter am Flugtag<input value={completedFlightDraft.weather || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, weather: e.target.value })} /></label>
                        <label>Temperatur (°C)<input type="number" step="0.1" value={completedFlightDraft.temperature || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, temperature: e.target.value })} placeholder="z. B. 18.5" /></label>
                        <label>Wind in km/h<input type="number" value={completedFlightDraft.wind || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, wind: e.target.value, actualWind: e.target.value })} placeholder="z. B. 18" /></label>
                        <label>Böen in km/h<input type="number" value={completedFlightDraft.gusts || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, gusts: e.target.value, actualGusts: e.target.value })} placeholder="z. B. 28" /></label>
                        <label>Aktualisiert am<input value={formatFlightStatusTimestamp(completedFlightDraft.updatedAt)} readOnly style={{ background: "#f1f5f9", fontWeight: 700 }} /></label>
                        <label>Behördenkontrolle erfolgt
                          <select
                            value={completedFlightDraft.authorityInspection || ""}
                            onChange={(e) => {
                              const value = e.target.value;
                              setCompletedFlightDraft({
                                ...completedFlightDraft,
                                authorityInspection: value,
                                authorityType: value === "Ja" ? (completedFlightDraft.authorityType || "") : "",
                                authorityControlDate: value === "Ja" ? (completedFlightDraft.authorityControlDate || "") : "",
                                authorityOffice: value === "Ja" ? (completedFlightDraft.authorityOffice || "") : "",
                                authorityResult: value === "Ja" ? (completedFlightDraft.authorityResult || "") : "",
                              });
                            }}
                            style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px" }}
                          >
                            <option value="">Bitte wählen</option>
                            <option value="Nein">Nein</option>
                            <option value="Ja">Ja</option>
                          </select>
                        </label>
                        {completedFlightDraft.authorityInspection === "Ja" ? (
                          <>
                            <label>Kontrollierende Behörde
                              <select
                                value={completedFlightDraft.authorityType || ""}
                                onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, authorityType: e.target.value })}
                                style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px" }}
                              >
                                <option value="">Bitte wählen</option>
                                <option value="Polizei">Polizei</option>
                                <option value="Ordnungsamt">Ordnungsamt</option>
                                <option value="LBA">LBA</option>
                              </select>
                            </label>
                            <label>Datum und Uhrzeit der Kontrolle
                              <input
                                type="datetime-local"
                                value={completedFlightDraft.authorityControlDate || ""}
                                onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, authorityControlDate: e.target.value })}
                              />
                            </label>
                            <label>Dienststelle
                              <input
                                value={completedFlightDraft.authorityOffice || ""}
                                onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, authorityOffice: e.target.value })}
                                placeholder="z. B. Polizeirevier Kiel"
                              />
                            </label>
                            <label>Ergebnis der Kontrolle
                              <select
                                value={completedFlightDraft.authorityResult || ""}
                                onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, authorityResult: e.target.value })}
                                style={{ height: "52px", borderRadius: "16px", border: "1px solid #cbd5e1", padding: "0 16px" }}
                              >
                                <option value="">Bitte wählen</option>
                                <option value="Ohne Beanstandung">Ohne Beanstandung</option>
                                <option value="Dokumente geprüft">Dokumente geprüft</option>
                                <option value="Hinweis erteilt">Hinweis erteilt</option>
                                <option value="Mangel festgestellt">Mangel festgestellt</option>
                                <option value="Verfahren eingeleitet">Verfahren eingeleitet</option>
                                <option value="Flug untersagt">Flug untersagt</option>
                              </select>
                            </label>
                          </>
                        ) : null}
                        <label style={{ gridColumn: "1 / -1" }}>Bemerkungen zur Behördenkontrolle<textarea rows={2} value={completedFlightDraft.authorityInspectionNotes || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, authorityInspectionNotes: e.target.value })} placeholder="z. B. keine Kontrolle oder Name der Behörde / Hinweise" /></label>

                        <div className="listitem" style={{ gridColumn: "1 / -1", alignItems: "stretch" }}>
                          <strong>Dokumente & Medien</strong>
                          <span>Fotos, Videos, Einsatzberichte und Behördendokumente dem abgeschlossenen Flug zuordnen.</span>
                          <div className="profileGrid" style={{ marginTop: "12px" }}>
                            <label>Fotos hochladen<input type="file" multiple accept="image/*" onChange={(e) => addCompletedFlightAttachmentsWorking("photos", e.target.files)} /></label>
                            <label>Videos hochladen<input type="file" multiple accept="video/*" onChange={(e) => addCompletedFlightAttachmentsWorking("videos", e.target.files)} /></label>
                            <label>Einsatzbericht PDF<input type="file" multiple accept=".pdf,application/pdf" onChange={(e) => addCompletedFlightAttachmentsWorking("reports", e.target.files)} /></label>
                            <label>Behördendokumente<input type="file" multiple accept=".pdf,image/*" onChange={(e) => addCompletedFlightAttachmentsWorking("authorityDocs", e.target.files)} /></label>
                            <label>Sonstige Dateien<input type="file" multiple onChange={(e) => addCompletedFlightAttachmentsWorking("otherFiles", e.target.files)} /></label>
                          </div>
                          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px", marginTop: "10px" }}>
                            <input type="checkbox" checked={completedFlightDraft.attachmentsVisibleForAuthorities !== false} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, attachmentsVisibleForAuthorities: e.target.checked })} style={{ width: "18px", height: "18px" }} />
                            Für Behörden sichtbar
                          </label>
                          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
                            <input type="checkbox" checked={completedFlightDraft.attachmentsIncludeInPdf !== false} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, attachmentsIncludeInPdf: e.target.checked })} style={{ width: "18px", height: "18px" }} />
                            Im PDF aufführen
                          </label>
                          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
                            <input type="checkbox" checked={Boolean(completedFlightDraft.attachmentsIncludeInMail)} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, attachmentsIncludeInMail: e.target.checked })} style={{ width: "18px", height: "18px" }} />
                            Per E-Mail mitsenden
                          </label>
                          {getCompletedFlightAttachmentList(completedFlightDraft).length ? (
                            <div style={{ marginTop: "10px", display: "grid", gap: "6px" }}>
                              {getCompletedFlightAttachmentList(completedFlightDraft).map((file, index) => {
                                const kind =
                                  file.group === "Foto" ? "photos" :
                                  file.group === "Video" ? "videos" :
                                  file.group === "Einsatzbericht" ? "reports" :
                                  file.group === "Behördendokument" ? "authorityDocs" :
                                  "otherFiles";
                                return (
                                  <span key={file.id || `${file.name}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
                                    <span>{file.group}: {file.name}</span>
                                    <button type="button" className="secondary smallButton" onClick={() => removeCompletedFlightAttachmentWorking(kind, file.id)}>Entfernen</button>
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>

                        <label style={{ gridColumn: "1 / -1" }}>Besondere Vorkommnisse<textarea rows={3} value={completedFlightDraft.actualIncidents || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, actualIncidents: e.target.value })} placeholder="z. B. keine, Abbruch, Personen im Fluggebiet, Wetteränderung ..." /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Flugnotizen<textarea rows={3} value={completedFlightDraft.actualNotes || completedFlightDraft.notes || ""} onChange={(e) => setCompletedFlightDraft({ ...completedFlightDraft, actualNotes: e.target.value, notes: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow" style={{ marginTop: "12px" }}>
                        <button type="button" className="primary smallButton" onClick={addCompletedFlightManualWorking}>{editingCompletedFlightId ? "Erfolgten Flug aktualisieren" : "Erfolgten Flug speichern"}</button>
                        <button type="button" className="secondary smallButton" onClick={resetCompletedFlightDraftWorking}>{editingCompletedFlightId ? "Bearbeitung abbrechen" : "Formular leeren"}</button>
                      </div>
                    </div>
                    ) : null}

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead"><div><h3>Ausgewählter abgeschlossener Flug</h3><p>Details, E-Mail-Versand oder Löschen zum aktuell ausgewählten Flug.</p></div><Status status="good">{completedFlights.length} gespeichert</Status></div>
                      <div className="logbookList">
                        {selectedCompletedFlightEntry ? (
                          <div key={getCompletedFlightKey(selectedCompletedFlightEntry)} className="listitem">
                            <strong>{selectedCompletedFlightEntry.registrationNumber || "Ohne Vorgangsnummer"}{selectedCompletedFlightEntry.authorityPin ? ` · PIN ${selectedCompletedFlightEntry.authorityPin}` : ""}</strong>
                            <span>{selectedCompletedFlightEntry.date || "-"} · Ist-Zeit: {selectedCompletedFlightEntry.actualStartTime || selectedCompletedFlightEntry.startTime || "-"}{selectedCompletedFlightEntry.actualEndTime || selectedCompletedFlightEntry.endTime ? ` – ${selectedCompletedFlightEntry.actualEndTime || selectedCompletedFlightEntry.endTime}` : ""} · {selectedCompletedFlightEntry.pilot || "Pilot unbekannt"} · {selectedCompletedFlightEntry.drone || "Drohne unbekannt"} · {selectedCompletedFlightEntry.city || selectedCompletedFlightEntry.flightArea || "Ort unbekannt"}</span>
                            {(selectedCompletedFlightEntry.updatedAt || selectedCompletedFlightEntry.completedAt) ? <small>Aktualisiert am: {selectedCompletedFlightEntry.updatedAt || selectedCompletedFlightEntry.completedAt}</small> : null}
                            {(selectedCompletedFlightEntry.wind || selectedCompletedFlightEntry.actualWind || selectedCompletedFlightEntry.gusts || selectedCompletedFlightEntry.actualGusts) ? <small>Wind/Böen: {[selectedCompletedFlightEntry.actualWind || selectedCompletedFlightEntry.wind ? `${selectedCompletedFlightEntry.actualWind || selectedCompletedFlightEntry.wind} km/h` : "", selectedCompletedFlightEntry.actualGusts || selectedCompletedFlightEntry.gusts ? `${selectedCompletedFlightEntry.actualGusts || selectedCompletedFlightEntry.gusts} km/h` : ""].filter(Boolean).join(" / ")}</small> : null}
                            {formatCompletedFlightAttachmentSummary(selectedCompletedFlightEntry) ? <small>Dokumente & Medien: {formatCompletedFlightAttachmentSummary(selectedCompletedFlightEntry)}</small> : null}
                            {(selectedCompletedFlightEntry.actualIncidents || selectedCompletedFlightEntry.incidents || selectedCompletedFlightEntry.actualNotes || selectedCompletedFlightEntry.notes) ? <small>Vorkommnisse/Notizen: {selectedCompletedFlightEntry.actualIncidents || selectedCompletedFlightEntry.incidents || selectedCompletedFlightEntry.actualNotes || selectedCompletedFlightEntry.notes}</small> : null}
                            <div className="buttonRow" style={{ marginTop: "10px" }}>
                              <button type="button" className="primary smallButton" onClick={() => openCompletedFlightWorking(selectedCompletedFlightEntry)}>Vollständiges Formular anzeigen</button>
                              <button type="button" className="secondary smallButton" onClick={() => printCompletedFlightPdfWorking(selectedCompletedFlightEntry)}>Als PDF drucken</button>
                              <button type="button" className="secondary smallButton" onClick={() => openEmailDialogWorking(selectedCompletedFlightEntry)}>Per E-Mail senden</button>
                              <button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteCompletedFlightWorking(selectedCompletedFlightEntry)}>Löschen</button>
                            </div>
                          </div>
                        ) : completedFlights.length ? (
                          <p>Bitte oben einen abgeschlossenen Flug auswählen.</p>
                        ) : (
                          <p>Noch keine abgeschlossenen Flüge vorhanden.</p>
                        )}
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      {(() => {
                        const isClosedStatus = (entry) => {
                          const status = String(entry?.status || "Geplant").trim().toLowerCase();
                          return ["erfolgt", "abgeschlossen", "completed"].includes(status);
                        };

                        const keyOf = (entry) =>
                          String(entry?.registrationNumber || entry?.id || entry?.authorityPin || "").trim().toLowerCase();

                        const openMap = new Map();

                        (Array.isArray(logbook) ? logbook : [])
                          .filter((entry) => !isClosedStatus(entry))
                          .forEach((entry) => {
                            const key = keyOf(entry) || `open-${Math.random()}`;
                            openMap.set(key, entry);
                          });

                        if (authorityReport && !isClosedStatus(authorityReport)) {
                          const key = keyOf(authorityReport) || "authority-report";
                          openMap.set(key, { ...authorityReport, sourceHint: "PIN-Anzeige" });
                        }

                        const allOpenLogbookEntries = Array.from(openMap.values());
                        const search = String(openFlightSearch || "").trim().toLowerCase();
                        const openLogbookEntries = search
                          ? allOpenLogbookEntries.filter((entry) => {
                              const haystack = [
                                entry.registrationNumber,
                                entry.authorityPin,
                                ...(Array.isArray(entry.authorityPins) ? entry.authorityPins : []),
                                entry.status,
                                entry.date,
                                entry.startTime,
                                entry.endTime,
                                entry.pilot,
                                entry.drone,
                                entry.city,
                                entry.flightArea,
                                entry.coordinates,
                                entry.purpose,
                                entry.notes,
                                entry.sourceHint,
                              ]
                                .filter(Boolean)
                                .join(" ")
                                .toLowerCase();
                              return haystack.includes(search);
                            })
                          : allOpenLogbookEntries;

                        const canLoadPin = /^\d{6}$/.test(normalizeAuthorityPin(openFlightSearch));

                        return (
                          <>
                            <div className="sectionHead">
                              <div>
                                <h3>Offene / geplante Flüge</h3>
                                <p>Geplante und noch nicht abgeschlossene Flüge. Server-Flüge können direkt per Behörden-PIN geladen werden.</p>
                              </div>
                              <Status status={openLogbookEntries.length ? "good" : "warning"}>{openLogbookEntries.length} sichtbar</Status>
                            </div>

                            <div className="profileGrid" style={{ marginBottom: "12px" }}>
                              <label style={{ gridColumn: "1 / -1" }}>
                                Offene / geplante Flüge suchen oder Behörden-PIN laden
                                <input
                                  value={openFlightSearch}
                                  onChange={(event) => setOpenFlightSearch(event.target.value)}
                                  placeholder="Vorgangsnummer, PIN, Datum, Pilot, Drohne, Ort, Zweck oder Status suchen"
                                />
                              </label>
                              <div className="buttonRow" style={{ gridColumn: "1 / -1" }}>
                                <button
                                  type="button"
                                  className="secondary smallButton"
                                  onClick={() => loadOpenFlightByPinWorking(openFlightSearch)}
                                  disabled={!canLoadPin}
                                  title={canLoadPin ? "Flug per PIN vom Server laden" : "Bitte 6-stellige PIN eingeben"}
                                >
                                  PIN vom Server laden
                                </button>
                                <button
                                  type="button"
                                  className="primary smallButton"
                                  onClick={() => loadOpenFlightByPinAndEditWorking(openFlightSearch)}
                                  disabled={!canLoadPin}
                                  title={canLoadPin ? "Flug per PIN laden und direkt bearbeiten" : "Bitte 6-stellige PIN eingeben"}
                                >
                                  PIN laden & bearbeiten
                                </button>
                                <button type="button" className="secondary smallButton" onClick={() => setOpenFlightSearch("")}>Suche leeren</button>
                              </div>
                            </div>

                            <div className="logbookList">
                              {openLogbookEntries.slice(0, 100).map((entry) => (
                                <div key={entry.id || entry.registrationNumber || entry.authorityPin} className="listitem">
                                  <strong>{entry.registrationNumber || "Ohne Vorgangsnummer"}{entry.authorityPin ? ` · PIN ${entry.authorityPin}` : ""}</strong>
                                  <span>{entry.date || "-"} · {entry.status || "Geplant"} · {entry.pilot || "Pilot unbekannt"} · {entry.drone || "Drohne unbekannt"} · {entry.city || entry.flightArea || "Ort unbekannt"}</span>
                                  {entry.sourceHint ? <small>Quelle: {entry.sourceHint}</small> : null}
                                  <div className="buttonRow" style={{ marginTop: "10px" }}>
                                    <button type="button" className="secondary smallButton" onClick={() => openEmailDialogWorking(entry)}>Per E-Mail senden</button>
                                    <button type="button" className="secondary smallButton" onClick={() => startEditLogEntryWorking(prepareEditableOpenFlightEntry(entry))}>Bearbeiten</button>
                                    <button type="button" className="secondary smallButton" onClick={() => duplicateLogEntryForNewRegistration(entry)}>Duplizieren</button>
                                    <button type="button" className="secondary smallButton" onClick={() => archiveCompletedFlightWorking(entry)}>Zu abgeschlossenen Flügen</button>
                                    {entry.id ? <button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteLogEntryWorking(entry.id)}>Löschen</button> : null}
                                  </div>
                                </div>
                              ))}
                              {openLogbookEntries.length > 100 ? <p>Es werden die ersten 100 Treffer angezeigt. Bitte Suche eingrenzen.</p> : null}
                              {!openLogbookEntries.length ? <p>Keine offenen oder geplanten Flugbuch-Einträge gefunden. Falls der Flug nur per PIN im Behördenportal existiert, bitte die 6-stellige PIN eingeben und „PIN vom Server laden“ klicken.</p> : null}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                ) : null}


                {adminCenterTab === "droneLogbook" ? (
                  <div>
                    {(() => {
                      const droneLogbookRows = buildDroneLogbookRows(filteredCompletedFlights);
                      const totalMinutes = droneLogbookRows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0);
                      const droneStats = droneLogbookRows.reduce((acc, row) => {
                        const key = row.drone || "Unbekannte Drohne";
                        acc[key] = (acc[key] || 0) + 1;
                        return acc;
                      }, {});
                      const inspections = droneLogbookRows.filter((row) => row.authorityInspection === "Ja").length;
                      const incidents = droneLogbookRows.filter((row) => isFilledDisplayValue(row.incidents)).length;

                      return (
                        <>
                          <div className="sectionHead">
                            <div>
                              <h2>Drohnen-Logbuch</h2>
                              <p>Automatisch aus den abgeschlossenen Flügen erstellt. Keine doppelte Eingabe erforderlich.</p>
                            </div>
                            <div className="buttonRow">
                              <Status status="good">{droneLogbookRows.length} Flüge</Status>
                              <button type="button" className="primary smallButton" onClick={printDroneLogbookPdfWorking}>
                                Logbuch als PDF
                              </button>
                            </div>
                          </div>

                          <div className="card" style={{ marginBottom: "18px" }}>
                            <div className="sectionHead">
                              <div>
                                <h3>Suche & Filter</h3>
                                <p>Die Filter gelten auch für Tabelle und PDF-Export.</p>
                              </div>
                              <Status status={filteredCompletedFlights.length ? "good" : "warning"}>{filteredCompletedFlights.length} Treffer</Status>
                            </div>
                            <div className="profileGrid">
                              <label style={{ gridColumn: "1 / -1" }}>Suche<input value={completedFlightSearch} onChange={(event) => setCompletedFlightSearch(event.target.value)} placeholder="Vorgangsnummer, PIN, Pilot, Drohne, Ort, Zweck, Status suchen" /></label>
                              <label>Datum von<input type="date" value={completedFlightFilterFrom} onChange={(event) => setCompletedFlightFilterFrom(event.target.value)} /></label>
                              <label>Datum bis<input type="date" value={completedFlightFilterTo} onChange={(event) => setCompletedFlightFilterTo(event.target.value)} /></label>
                              <label>Pilot<select value={completedFlightFilterPilot} onChange={(event) => setCompletedFlightFilterPilot(event.target.value)}><option value="">Alle Piloten</option>{completedFlightPilots.map((pilot) => <option key={pilot} value={pilot}>{pilot}</option>)}</select></label>
                              <label>Drohne<select value={completedFlightFilterDrone} onChange={(event) => setCompletedFlightFilterDrone(event.target.value)}><option value="">Alle Drohnen</option>{completedFlightDrones.map((drone) => <option key={drone} value={drone}>{drone}</option>)}</select></label>
                            </div>
                            <div className="buttonRow" style={{ marginTop: "12px" }}>
                              <button type="button" className="secondary smallButton" onClick={resetCompletedFlightFiltersWorking}>Filter zurücksetzen</button>
                            </div>
                          </div>

                          <div className="statsGrid" style={{ marginBottom: "18px" }}>
                            <div className="dashCard"><strong>Gesamtflüge</strong><span>{droneLogbookRows.length}</span></div>
                            <div className="dashCard"><strong>Gesamtflugzeit</strong><span>{formatTotalFlightTime(totalMinutes)}</span></div>
                            <div className="dashCard"><strong>Behördenkontrollen</strong><span>{inspections}</span></div>
                            <div className="dashCard"><strong>Vorkommnisse</strong><span>{incidents}</span></div>
                          </div>

                          <div className="card" style={{ marginBottom: "18px" }}>
                            <div className="sectionHead">
                              <div>
                                <h3>Flüge je Drohne</h3>
                                <p>Automatische Auswertung nach Drohnenmodell.</p>
                              </div>
                            </div>
                            <div className="miniList">
                              {Object.entries(droneStats).map(([drone, count]) => (
                                <div key={drone} className="listitem">
                                  <strong>{drone}</strong>
                                  <span>{count} Flug/Flüge</span>
                                </div>
                              ))}
                              {!Object.keys(droneStats).length ? <p>Noch keine Drohnenflüge vorhanden.</p> : null}
                            </div>
                          </div>

                          <div className="card">
                            <div className="sectionHead">
                              <div>
                                <h3>Logbuch-Einträge</h3>
                                <p>Alle abgeschlossenen Flüge als fortlaufendes Drohnen-Logbuch.</p>
                              </div>
                            </div>

                            <div style={{ overflowX: "auto" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "1100px" }}>
                                <thead>
                                  <tr>
                                    {["Datum", "Vorgang", "Drohne", "Pilot", "Fluggebiet", "Start", "Ende", "Dauer", "Max. Höhe", "Wind/Böen", "Akku", "Status", "Kontrolle"].map((head) => (
                                      <th key={head} style={{ textAlign: "left", padding: "10px", borderBottom: "1px solid #cbd5e1", fontSize: "13px" }}>{head}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {droneLogbookRows.map((row) => (
                                    <tr key={row.id || `${row.registrationNumber}-${row.date}`}>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.date || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.registrationNumber || row.authorityPin || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.drone || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.pilot || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0", maxWidth: "280px", whiteSpace: "pre-wrap" }}>{row.flightArea || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.startTime || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.endTime || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.duration}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.maxHeight ? `${row.maxHeight} m` : "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{[row.wind ? `${row.wind} km/h` : "", row.gusts ? `${row.gusts} km/h` : ""].filter(Boolean).join(" / ") || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{[row.batteryStart ? `${row.batteryStart}%` : "", row.batteryEnd ? `${row.batteryEnd}%` : ""].filter(Boolean).join(" / ") || "-"}</td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}><FlightStatusBadge value={row.status} /></td>
                                      <td style={{ padding: "10px", borderBottom: "1px solid #e2e8f0" }}>{row.authorityInspection || "-"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            {!droneLogbookRows.length ? (
                              <div className="listitem">
                                <strong>Noch kein Drohnen-Logbuch vorhanden.</strong>
                                <span>Sobald ein Flug unter „Abgeschlossene Flüge“ gespeichert wird, erscheint er automatisch hier.</span>
                              </div>
                            ) : null}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : null}


                {adminCenterTab === "flightMap" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>Flugorte-Karte</h2>
                        <p>Alle abgeschlossenen Flüge mit Koordinaten als Marker. Klick auf Marker zeigt Flugdetails.</p>
                      </div>
                      <Status status={completedFlights.length ? "good" : "warning"}>{completedFlights.length} abgeschlossene Flüge</Status>
                    </div>
                    <FlightPlacesMap flights={completedFlights} />
                  </div>
                ) : null}

                {adminCenterTab === "design" ? (
                  <div>
                    <div className="sectionHead"><div><h2>Design Center</h2><p>Templates, Farben, Logo und eigenes Corporate-Theme speichern.</p></div><Status status="good">{activeTemplateLabel}</Status></div>
                    <div className="card" style={{ marginBottom: "18px", border: "1px solid rgba(14,165,233,.22)" }}>
                      <div className="sectionHead"><div><h3>Aktives Template farblich anpassen</h3><p>Ändert das ausgewählte vorhandene Template sofort sichtbar. Speichern sichert die Farben dauerhaft.</p></div><Status status={hasActiveTemplateOverride ? "good" : "warning"}>{hasActiveTemplateOverride ? "Individuell" : "Standardfarben"}</Status></div>
                      <div className="profileGrid">
                        <label>Primärfarbe<input type="color" value={activeTemplateColorDraft.primary} onChange={(e) => updateActiveTemplateColorWorking("primary", e.target.value)} /></label>
                        <label>Sekundärfarbe<input type="color" value={activeTemplateColorDraft.secondary} onChange={(e) => updateActiveTemplateColorWorking("secondary", e.target.value)} /></label>
                        <label>Akzentfarbe<input type="color" value={activeTemplateColorDraft.accent} onChange={(e) => updateActiveTemplateColorWorking("accent", e.target.value)} /></label>
                        <label>Hintergrund<input type="color" value={activeTemplateColorDraft.background} onChange={(e) => updateActiveTemplateColorWorking("background", e.target.value)} /></label>
                        <label>Karten-/Flächenfarbe<input type="color" value={activeTemplateColorDraft.surface} onChange={(e) => updateActiveTemplateColorWorking("surface", e.target.value)} /></label>
                        <label>Textfarbe<input type="color" value={activeTemplateColorDraft.text} onChange={(e) => updateActiveTemplateColorWorking("text", e.target.value)} /></label>
                      </div>
                      <div className="buttonRow" style={{ marginTop: "14px" }}>
                        <button type="button" className="primary smallButton" onClick={saveDesignSettingsWorking}>Farben speichern</button>
                        <button type="button" className="secondary smallButton" onClick={resetActiveTemplateColorsWorking}>Standardfarben wiederherstellen</button>
                      </div>
                    </div>
                    <div className="profileGrid" style={{ marginBottom: "18px" }}><label>Custom Name<input value={customTheme.name} onChange={(e) => setCustomTheme({ ...customTheme, name: e.target.value })} /></label><label>Custom Primärfarbe<input type="color" value={customTheme.primary} onChange={(e) => setCustomTheme({ ...customTheme, primary: e.target.value })} /></label><label>Custom Sekundärfarbe<input type="color" value={customTheme.secondary} onChange={(e) => setCustomTheme({ ...customTheme, secondary: e.target.value })} /></label><label>Custom Hintergrund<input type="color" value={customTheme.background} onChange={(e) => setCustomTheme({ ...customTheme, background: e.target.value })} /></label><label style={{ gridColumn: "1 / -1" }}>Logo URL<input value={customTheme.logoUrl} onChange={(e) => setCustomTheme({ ...customTheme, logoUrl: e.target.value })} placeholder="https://.../logo.png" /></label></div><div className="buttonRow"><button type="button" className="secondary smallButton" onClick={saveDesignSettingsWorking}>Design speichern</button><button type="button" className="secondary smallButton" onClick={() => { activateTemplateWorking("platinum"); setCustomTheme({ name: "FlyMonitor Platinum", primary: "#00B2E2", secondary: "#021B33", background: "#0F172A", logoUrl: "", mode: "dark" }); }}>Platinum Standard</button></div>
                    <div className="themeGrid" style={{ marginTop: "16px" }}>
                      {professionalTemplates.map((tpl) => (
                        <button key={tpl.id} type="button" onClick={() => activateTemplateWorking(tpl.id)} className={`themeCard ${activeTemplate === tpl.id ? "active" : ""}`}>
                          <span className="themeSwatch" style={{ background: `linear-gradient(135deg, ${(templatePreviewColors[tpl.id] || templatePreviewColors.custom)[0]} 0 33%, ${(templatePreviewColors[tpl.id] || templatePreviewColors.custom)[1]} 33% 66%, ${(templatePreviewColors[tpl.id] || templatePreviewColors.custom)[2]} 66% 100%)` }} />
                          <strong>{tpl.name}</strong>
                          <small>{tpl.group} · {tpl.description}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "liveticker" ? (
                  <div>
                    <div className="sectionHead"><div><h2>UAS Liveticker Verwaltung</h2><p>Aktuelle UAS-/Drohnenmeldungen prüfen, manuell aktualisieren und Status kontrollieren.</p></div><Status status="good">{uasTicker.length} Meldungen</Status></div>
                    <section className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", marginBottom: "18px" }}>
                      <div className="card"><h3>Letzte Aktualisierung</h3><p>{uasTickerLastUpdate}</p></div>
                      <div className="card"><h3>API Status</h3><p>{uasTickerAdminStatus}</p></div>
                      <div className="card"><h3>Quelle</h3><p>/api/get-uas-ticker.php</p></div>
                    </section>
                    <div className="buttonRow" style={{ marginBottom: "18px" }}>
                      <button type="button" className="primary smallButton" onClick={() => loadUasTickerWorking(true)}>Jetzt aktualisieren</button>
                      <button type="button" className="secondary smallButton" onClick={clearUasTickerCacheWorking}>Cache lokal leeren</button>
                      <button type="button" className="secondary smallButton" onClick={() => window.open(`/api/get-uas-ticker.php?force=1&t=${Date.now()}`, "_blank")}>API testen</button>
                    </div>
                    <div className="card">
                      <h3>Aktuelle Meldungen</h3>
                      <div className="tickerAdminList">
                        {uasTicker.slice(0, 12).map((item, index) => (
                          <div key={item.id || item.url || index} className="tickerAdminItem">
                            <strong>{item.title || item.text || "UAS-Meldung"}</strong>
                            <span>{item.source || "UAS-Liveticker"} · {item.date || item.createdAt || "Automatisch"}</span>
                            {item.text ? <p style={{ margin: 0 }}>{item.text}</p> : null}
                            {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">Quelle öffnen</a> : null}
                          </div>
                        ))}
                        {!uasTicker.length ? <p>Noch keine Meldungen geladen.</p> : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "customers" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>CRM</h2>
                        <p>Kundenakte 360°, Ansprechpartner, Aktivitäten, Portal, Angebote und Rechnungen.</p>
                      </div>
                      <Status status={customers.length ? "good" : "warning"}>{customers.length} Kunde(n)</Status>
                    </div>

                    <div
  className="wideGrid"
  style={{
    display: "grid",
    gridTemplateColumns: "520px 480px",
    gap: "24px",
    alignItems: "start",
    justifyContent: "start"
  }}
>
                      <div className="card">
                        <h3>{editingCustomerId ? "Kunde bearbeiten" : "Kunde anlegen"}</h3>
                        <div className="profileGrid">
                          <label>Kundennummer<input value={customerForm.customerNumber} onChange={(e) => setCustomerForm((prev) => ({ ...prev, customerNumber: e.target.value }))} placeholder="automatisch" /></label>
                          <label>Firma<input value={customerForm.company} onChange={(e) => setCustomerForm((prev) => ({ ...prev, company: e.target.value }))} placeholder="Firma / Kunde" /></label>
                          <label>Ansprechpartner<input value={customerForm.contactName} onChange={(e) => setCustomerForm((prev) => ({ ...prev, contactName: e.target.value }))} placeholder="Name" /></label>
                          <label>Straße<input value={customerForm.street} onChange={(e) => setCustomerForm((prev) => ({ ...prev, street: e.target.value }))} placeholder="Straße und Hausnummer" /></label>
                          <label>PLZ<input value={customerForm.zip} onChange={(e) => setCustomerForm((prev) => ({ ...prev, zip: e.target.value }))} placeholder="24106" /></label>
                          <label>Ort<input value={customerForm.city} onChange={(e) => setCustomerForm((prev) => ({ ...prev, city: e.target.value }))} placeholder="Kiel" /></label>
                          <label>E-Mail<input value={customerForm.email} onChange={(e) => setCustomerForm((prev) => ({ ...prev, email: e.target.value }))} placeholder="kunde@example.de" /></label>
                          <label>Telefon<input value={customerForm.phone} onChange={(e) => setCustomerForm((prev) => ({ ...prev, phone: e.target.value }))} placeholder="Telefon" /></label>
                          <label>Website<input value={customerForm.website} onChange={(e) => setCustomerForm((prev) => ({ ...prev, website: e.target.value }))} placeholder="https://" /></label>
                          <label>Portalcode<input value={customerForm.portalCode} onChange={(e) => setCustomerForm((prev) => ({ ...prev, portalCode: e.target.value }))} placeholder="automatisch" /></label>
                          <label style={{ gridColumn: "1 / -1" }}>Notizen<textarea value={customerForm.notes} onChange={(e) => setCustomerForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Interne Hinweise, Abrechnung, Portalnotizen" /></label>
                        </div>
                        <div className="buttonRow" style={{ marginTop: 14 }}>
                          <button type="button" className="primary smallButton" onClick={saveCustomerWorking}>{editingCustomerId ? "Änderungen speichern" : "Kunde speichern"}</button>
                          <button type="button" className="secondary smallButton" onClick={() => setCustomerForm((prev) => ({ ...prev, customerNumber: prev.customerNumber || createCustomerNumberWorking(), portalCode: prev.portalCode || createCustomerPortalCodeWorking() }))}>Nummern erzeugen</button>
                          {editingCustomerId ? <button type="button" className="secondary smallButton" onClick={resetCustomerFormWorking}>Neu anlegen</button> : null}
                        </div>
                      </div>

                      <div className="card">
                        <div className="sectionHead">
                          <div>
                            <h3>Kundenliste</h3>
                            <p>{filteredCustomers.length} von {customers.length} Kunde(n) angezeigt.</p>
                          </div>
                          <button type="button" className="secondary smallButton" onClick={exportCustomersCsvWorking}>Kunden CSV</button>
                        </div>
                        <input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Kunden suchen..." />
                        <div className="logbookList" style={{ marginTop: 14 }}>
                          {filteredCustomers.map((customer) => (
                            <div key={customer.id || customer.customerNumber} className="listitem">
                              <strong>{customer.company || customer.contactName || "Kunde"}</strong>
                              <span>{customer.customerNumber || "ohne Kundennummer"} · {customer.contactName || "kein Ansprechpartner"} · {customer.city || "kein Ort"}</span>
                              <small>{customer.email || "keine E-Mail"}{customer.phone ? ` · ${customer.phone}` : ""}{customer.portalCode ? ` · Portalcode ${customer.portalCode}` : ""}</small>
                              <div className="buttonRow" style={{ marginTop: 8 }}>
                                <button type="button" className="secondary smallButton" onClick={() => editCustomerWorking(customer)}>Bearbeiten</button>
                                <button type="button" className="secondary smallButton" onClick={() => {
                                  const portalUrl = `${window.location.origin}${window.location.pathname}#kundenportal?code=${encodeURIComponent(customer.portalCode || "")}`;
                                  navigator.clipboard?.writeText(portalUrl);
                                  alert(`Kundenportal-Link kopiert:\n${portalUrl}`);
                                }}>Portal-Link</button>
                                <button type="button" className="secondary smallButton" onClick={() => deleteCustomerWorking(customer.id)}>Löschen</button>
                              </div>
                            </div>
                          ))}
                          {!filteredCustomers.length ? <p>Noch keine Kunden gefunden.</p> : null}
                        </div>
                      </div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginTop: "18px" }}>
                      <div className="dashCard"><strong>{crmDashboardStats.activeCustomers}</strong><span>Aktive Kunden</span></div>
                      <div className="dashCard"><strong>{crmDashboardStats.openOffers}</strong><span>Offene Angebote</span></div>
                      <div className="dashCard"><strong>{crmDashboardStats.openInvoices}</strong><span>Offene Rechnungen</span></div>
                      <div className="dashCard"><strong>{crmDashboardStats.crmActivityCount}</strong><span>CRM-Aktivitäten</span></div>
                    </div>

                    <div className="card" style={{ marginTop: "18px" }}>
                      <div className="sectionHead">
                        <div>
                          <h3>🧑‍💼 Kundenakte 360°</h3>
                          <p>CRM-Zentrale für Ansprechpartner, Aktivitäten, Missionen, Medien, Angebote und Rechnungen.</p>
                        </div>
                        <Status status={crmSelectedCustomer ? "good" : "warning"}>{crmSelectedCustomer ? "Akte aktiv" : "Kein Kunde"}</Status>
                      </div>
                      <div className="profileGrid">
                        <label>Kundenakte auswählen<select value={crmSelectedCustomerKey || ""} onChange={(e) => setCrmSelectedCustomerId(e.target.value)}><option value="">Ersten Kunden verwenden</option>{(customers || []).map((customer) => <option key={`crm-customer-${getCrmCustomerKey(customer)}`} value={getCrmCustomerKey(customer)}>{customer.company || customer.contactName || customer.customerNumber || "Kunde"}</option>)}</select></label>
                        <label>Aktivitätstyp<select value={crmActivityForm.type} onChange={(e) => setCrmActivityForm({ ...crmActivityForm, type: e.target.value })}><option>Notiz</option><option>Telefonat</option><option>E-Mail</option><option>Meeting</option><option>Aufgabe</option><option>Freigabe</option><option>Rechnung</option></select></label>
                        <label>Titel<input value={crmActivityForm.title} onChange={(e) => setCrmActivityForm({ ...crmActivityForm, title: e.target.value })} placeholder="z. B. Telefonat zur Baustelle" /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Notiz / Aktivität<textarea rows={3} value={crmActivityForm.text} onChange={(e) => setCrmActivityForm({ ...crmActivityForm, text: e.target.value })} placeholder="Gesprächsnotiz, Aufgabe oder Kundenhinweis" /></label>
                      </div>
                      <div className="buttonRow" style={{ marginTop: 12 }}>
                        <button type="button" className="primary smallButton" onClick={() => addCrmActivityWorking()}>Aktivität speichern</button>
                        <button type="button" className="secondary smallButton" onClick={() => addCrmActivityWorking("Aufgabe")}>Als Aufgabe speichern</button>
                        <button type="button" className="secondary smallButton" onClick={() => exportCrmCustomerDossierPdfWorking()}>Kundenakte PDF</button>
                      </div>

                      {crmSelectedCustomer ? (
                        <div className="wideGrid" style={{ gridTemplateColumns: "minmax(280px, .9fr) minmax(320px, 1.1fr)", marginTop: "18px" }}>
                          <div className="card" style={{ background: "#f8fafc" }}>
                            <h3>{crmSelectedCustomer.company || crmSelectedCustomer.contactName || "Kunde"}</h3>
                            <p style={{ marginTop: 0 }}>{crmSelectedCustomer.customerNumber || "ohne Kundennummer"} · {crmSelectedCustomer.city || "kein Ort"}</p>
                            <div className="logbookList">
                              <div className="listitem"><strong>Kontakt</strong><span>{crmSelectedCustomer.contactName || "-"}</span><small>{crmSelectedCustomer.email || "keine E-Mail"}{crmSelectedCustomer.phone ? ` · ${crmSelectedCustomer.phone}` : ""}</small></div>
                              <div className="listitem"><strong>Portal</strong><span>{crmSelectedCustomer.portalCode || "kein Portalcode"}</span><small>Kundenportal-Code für geschützte Projektansicht.</small></div>
                              <div className="listitem"><strong>Verknüpfungen</strong><span>{(missions || []).filter((mission) => String(mission.customerId || mission.customerKey || "") === String(crmSelectedCustomerKey)).length} Mission(en) · {(galleryItems || []).filter((item) => String(item.customerId || item.customerKey || "") === String(crmSelectedCustomerKey)).length} Medium/Medien</span></div>
                            </div>
                          </div>

                          <div className="card" style={{ background: "#f8fafc" }}>
                            <h3>Ansprechpartner</h3>
                            <div className="profileGrid">
                              <label>Name<input value={crmContactForm.name} onChange={(e) => setCrmContactForm({ ...crmContactForm, name: e.target.value })} /></label>
                              <label>Position<input value={crmContactForm.role} onChange={(e) => setCrmContactForm({ ...crmContactForm, role: e.target.value })} /></label>
                              <label>E-Mail<input value={crmContactForm.email} onChange={(e) => setCrmContactForm({ ...crmContactForm, email: e.target.value })} /></label>
                              <label>Telefon<input value={crmContactForm.phone} onChange={(e) => setCrmContactForm({ ...crmContactForm, phone: e.target.value })} /></label>
                            </div>
                            <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={saveCrmContactWorking}>Ansprechpartner speichern</button></div>
                            <div className="logbookList" style={{ marginTop: 12 }}>
                              {crmCustomerContacts.map((contact) => <div key={contact.id} className="listitem"><strong>{contact.name}</strong><span>{contact.role || "Ansprechpartner"}</span><small>{contact.email || "keine E-Mail"}{contact.phone ? ` · ${contact.phone}` : ""}</small><button type="button" className="secondary smallButton" onClick={() => deleteCrmContactWorking(contact.id)}>Löschen</button></div>)}
                              {!crmCustomerContacts.length ? <p>Noch keine weiteren Ansprechpartner.</p> : null}
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="card" style={{ marginTop: "18px", background: "#f8fafc" }}>
                        <h3>Aktivitäten-Timeline</h3>
                        <div className="logbookList">
                          {crmCustomerActivities.slice(0, 30).map((activity) => (
                            <div key={activity.id} className="listitem">
                              <strong>{activity.type || "Aktivität"} · {activity.title || "Ohne Titel"}</strong>
                              <span>{activity.createdAt || "ohne Datum"} · Quelle: {activity.source || "CRM"}</span>
                              {activity.text ? <small>{activity.text}</small> : null}
                            </div>
                          ))}
                          {!crmCustomerActivities.length ? <p>Noch keine Aktivitäten für diesen Kunden.</p> : null}
                        </div>
                      </div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", marginTop: "18px" }}>
                      <div className="card"><h3>Kundenportal</h3><p>Portalcode und Kundenlink sind vorbereitet. Der öffentliche Portalbereich kann im nächsten Schritt angebunden werden.</p></div>
                      <div className="card"><h3>Angebote</h3><p>Kundenstammdaten liegen jetzt zentral vor und können für Angebots-PDFs genutzt werden.</p></div>
                      <div className="card"><h3>Rechnungen</h3><p>Rechnungsmodul kann nun Kundennummer, Adresse und Ansprechpartner automatisch übernehmen.</p></div>
                    </div>
                  </div>
                ) : null}


                {adminCenterTab === "contracts" ? (() => {
                  const contractList = Array.isArray(contracts) ? contracts : [];
                  const customerList = Array.isArray(customers) ? customers : [];
                  const offerList = Array.isArray(offers) ? offers : [];
                  const invoiceList = Array.isArray(invoices) ? invoices : [];
                  const contractStatuses = ["Entwurf", "Aktiv", "Gekündigt", "Abgelaufen", "Archiviert"];
                  const contractTypes = ["Kundenvertrag", "Rahmenvertrag", "Wartungsvertrag", "Projektvertrag", "Dienstleistungsvertrag", "Sonstiger Vertrag"];
                  const contractDaysLeft = (value) => {
                    if (!value) return null;
                    const d = new Date(`${value}T23:59:59`);
                    if (Number.isNaN(d.getTime())) return null;
                    return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
                  };
                  const contractStatusTone = (contract = {}) => {
                    const days = contractDaysLeft(contract.endDate);
                    if (contract.status === "Abgelaufen" || (days !== null && days < 0)) return "danger";
                    if (contract.status === "Gekündigt" || (days !== null && days <= Number(contract.noticePeriodDays || 30))) return "warning";
                    if (contract.status === "Aktiv") return "good";
                    return "warning";
                  };
                  const contractStats = contractList.reduce((acc, contract) => {
                    acc.total += 1;
                    acc[contract.status || "Entwurf"] = (acc[contract.status || "Entwurf"] || 0) + 1;
                    acc.value += Number(contract.value || 0);
                    const days = contractDaysLeft(contract.endDate);
                    if (days !== null && days < 0) acc.expired += 1;
                    else if (days !== null && days <= Number(contract.noticePeriodDays || 30)) acc.dueSoon += 1;
                    return acc;
                  }, { total: 0, value: 0, expired: 0, dueSoon: 0 });
                  const selectedContract = contractList.find((item) => item.id === selectedContractId) || null;
                  const resetContractDraft = () => setContractDraft({
                    contractNumber: `V-${new Date().getFullYear()}-${String(contractList.length + 1).padStart(4, "0")}`,
                    title: "",
                    customerId: "",
                    customerName: "",
                    type: "Kundenvertrag",
                    status: "Entwurf",
                    startDate: new Date().toISOString().slice(0, 10),
                    endDate: "",
                    noticePeriodDays: 30,
                    value: "",
                    relatedOfferId: "",
                    relatedInvoiceId: "",
                    documentName: "",
                    documentUrl: "",
                    notes: "",
                  });
                  const saveContractDraft = () => {
                    const customer = customerList.find((item) => String(item.id || item.customerNumber || item.company) === String(contractDraft.customerId));
                    const next = {
                      ...contractDraft,
                      id: `contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      contractNumber: contractDraft.contractNumber || `V-${new Date().getFullYear()}-${String(contractList.length + 1).padStart(4, "0")}`,
                      customerName: contractDraft.customerName || customer?.company || customer?.contactName || "",
                      createdAt: new Date().toLocaleString("de-DE"),
                      updatedAt: new Date().toLocaleString("de-DE"),
                    };
                    setContracts([next, ...contractList].slice(0, 500));
                    setSelectedContractId(next.id);
                    writeAuditLog("Vertrag erstellt", { contractId: next.id, customerName: next.customerName });
                    resetContractDraft();
                  };
                  const updateContract = (id, patch) => {
                    setContracts((current) => (Array.isArray(current) ? current : []).map((contract) => contract.id === id ? { ...contract, ...patch, updatedAt: new Date().toLocaleString("de-DE") } : contract));
                  };
                  const exportContractPdf = (contract) => {
                    const doc = createPdfDocument();
                    doc.setFontSize(18);
                    doc.text("FlyMonitor Vertrag", 20, 22);
                    doc.setFontSize(11);
                    doc.text(`Vertragsnummer: ${contract.contractNumber || contract.id}`, 20, 38);
                    doc.text(`Titel: ${contract.title || "-"}`, 20, 48);
                    doc.text(`Kunde: ${contract.customerName || "-"}`, 20, 58);
                    doc.text(`Typ: ${contract.type || "-"}`, 20, 68);
                    doc.text(`Status: ${contract.status || "-"}`, 20, 78);
                    doc.text(`Laufzeit: ${contract.startDate || "-"} bis ${contract.endDate || "-"}`, 20, 88);
                    doc.text(`Kündigungsfrist: ${contract.noticePeriodDays || 0} Tage`, 20, 98);
                    doc.text(`Vertragswert: ${Number(contract.value || 0).toFixed(2)} EUR`, 20, 108);
                    const notes = doc.splitTextToSize(`Notizen: ${contract.notes || "-"}`, 170);
                    doc.text(notes, 20, 124);
                    doc.save(`${contract.contractNumber || contract.id || "Vertrag"}.pdf`);
                    writeAuditLog("Vertrags-PDF erzeugt", { contractId: contract.id });
                  };

                  return (
                    <section className="card" style={ADMIN_AREA_STYLE}>
                      <div className="sectionTitle">
                        <div><p className="label">Contract Pro</p><h2>🧾 Vertragsverwaltung</h2><p>Kundenverträge, Rahmenverträge, Wartungsverträge, Laufzeiten, Fristen und Dokumente zentral verwalten.</p></div>
                        <Status status={contractStats.dueSoon || contractStats.expired ? "warning" : contractStats.total ? "good" : "warning"}>{contractStats.total} Vertrag(e)</Status>
                      </div>
                      <div className="dashGrid">
                        <div className="dashCard"><strong>{contractStats.total}</strong><span>Verträge gesamt</span></div>
                        <div className="dashCard"><strong>{contractStats.Aktiv || 0}</strong><span>Aktiv</span></div>
                        <div className="dashCard"><strong>{contractStats.dueSoon}</strong><span>Fristnah</span></div>
                        <div className="dashCard"><strong>{contractStats.expired}</strong><span>Abgelaufen</span></div>
                        <div className="dashCard"><strong>{contractStats.value.toFixed(2)} €</strong><span>Vertragsvolumen</span></div>
                      </div>

                      <div className="grid2" style={{ marginTop: 18 }}>
                        <div className="card">
                          <h3>Neuen Vertrag anlegen</h3>
                          <div className="formgrid">
                            <label>Vertragsnummer<input value={contractDraft.contractNumber} onChange={(e) => setContractDraft({ ...contractDraft, contractNumber: e.target.value })} placeholder={`V-${new Date().getFullYear()}-0001`} /></label>
                            <label>Titel<input value={contractDraft.title} onChange={(e) => setContractDraft({ ...contractDraft, title: e.target.value })} placeholder="z. B. Rahmenvertrag Drohnendienstleistung" /></label>
                            <label>Kunde<select value={contractDraft.customerId} onChange={(e) => {
                              const customer = customerList.find((item) => String(item.id || item.customerNumber || item.company) === e.target.value);
                              setContractDraft({ ...contractDraft, customerId: e.target.value, customerName: customer?.company || customer?.contactName || "" });
                            }}><option value="">Kunde auswählen</option>{customerList.map((customer) => <option key={customer.id || customer.customerNumber || customer.company} value={customer.id || customer.customerNumber || customer.company}>{customer.company || customer.contactName || customer.customerNumber}</option>)}</select></label>
                            <label>Typ<select value={contractDraft.type} onChange={(e) => setContractDraft({ ...contractDraft, type: e.target.value })}>{contractTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
                            <label>Status<select value={contractDraft.status} onChange={(e) => setContractDraft({ ...contractDraft, status: e.target.value })}>{contractStatuses.map((status) => <option key={status}>{status}</option>)}</select></label>
                            <label>Startdatum<input type="date" value={contractDraft.startDate} onChange={(e) => setContractDraft({ ...contractDraft, startDate: e.target.value })} /></label>
                            <label>Enddatum<input type="date" value={contractDraft.endDate} onChange={(e) => setContractDraft({ ...contractDraft, endDate: e.target.value })} /></label>
                            <label>Kündigungsfrist Tage<input type="number" value={contractDraft.noticePeriodDays} onChange={(e) => setContractDraft({ ...contractDraft, noticePeriodDays: e.target.value })} /></label>
                            <label>Vertragswert €<input type="number" step="0.01" value={contractDraft.value} onChange={(e) => setContractDraft({ ...contractDraft, value: e.target.value })} /></label>
                            <label>Verknüpftes Angebot<select value={contractDraft.relatedOfferId} onChange={(e) => setContractDraft({ ...contractDraft, relatedOfferId: e.target.value })}><option value="">Kein Angebot</option>{offerList.map((offer) => <option key={offer.id} value={offer.id}>{offer.offerNumber || offer.id} · {offer.customerName || ""}</option>)}</select></label>
                            <label>Verknüpfte Rechnung<select value={contractDraft.relatedInvoiceId} onChange={(e) => setContractDraft({ ...contractDraft, relatedInvoiceId: e.target.value })}><option value="">Keine Rechnung</option>{invoiceList.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoiceNumber || invoice.id} · {invoice.customerName || ""}</option>)}</select></label>
                            <label>Dokumentenname<input value={contractDraft.documentName} onChange={(e) => setContractDraft({ ...contractDraft, documentName: e.target.value })} placeholder="vertrag.pdf" /></label>
                            <label>Dokument-URL<input value={contractDraft.documentUrl} onChange={(e) => setContractDraft({ ...contractDraft, documentUrl: e.target.value })} placeholder="/uploads/vertrag.pdf" /></label>
                          </div>
                          <label>Notizen<textarea value={contractDraft.notes} onChange={(e) => setContractDraft({ ...contractDraft, notes: e.target.value })} placeholder="Besondere Vereinbarungen, Laufzeiten, Ansprechpartner ..." /></label>
                          <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveContractDraft}>Vertrag speichern</button><button type="button" className="secondary smallButton" onClick={resetContractDraft}>Formular leeren</button></div>
                        </div>

                        <div className="card">
                          <h3>Vertragsliste</h3>
                          <div className="list" style={{ maxHeight: 520, overflow: "auto" }}>
                            {contractList.map((contract) => {
                              const days = contractDaysLeft(contract.endDate);
                              const isSelected = selectedContractId === contract.id;
                              return (
                                <div key={contract.id} className="listitem" style={isSelected ? { borderColor: "#2563eb", boxShadow: "0 0 0 2px rgba(37,99,235,.12)" } : undefined}>
                                  <strong>{contract.contractNumber || contract.id}</strong>
                                  <span>{contract.customerName || "Ohne Kunde"} · {contract.title || contract.type}</span>
                                  <small>{contract.status || "Entwurf"} · {contract.type || "Vertrag"}{contract.endDate ? ` · Ende ${contract.endDate}` : ""}{days !== null ? ` · ${days < 0 ? "abgelaufen" : `${days} Tag(e)`}` : ""}</small>
                                  <div className="buttonRow">
                                    <Status status={contractStatusTone(contract)}>{contract.status || "Entwurf"}</Status>
                                    <button type="button" className="secondary smallButton" onClick={() => setSelectedContractId(contract.id)}>Öffnen</button>
                                    <button type="button" className="secondary smallButton" onClick={() => exportContractPdf(contract)}>PDF</button>
                                    <button type="button" className="danger smallButton" onClick={() => { if (confirm("Vertrag löschen?")) { setContracts(contractList.filter((item) => item.id !== contract.id)); if (selectedContractId === contract.id) setSelectedContractId(""); writeAuditLog("Vertrag gelöscht", { contractId: contract.id }); } }}>Löschen</button>
                                  </div>
                                </div>
                              );
                            })}
                            {!contractList.length ? <p>Noch keine Verträge vorhanden.</p> : null}
                          </div>
                        </div>
                      </div>

                      {selectedContract ? (
                        <div className="card" style={{ marginTop: 18 }}>
                          <div className="sectionTitle"><div><p className="label">Vertrag bearbeiten</p><h3>{selectedContract.contractNumber || selectedContract.id}</h3></div><Status status={contractStatusTone(selectedContract)}>{selectedContract.status || "Entwurf"}</Status></div>
                          <div className="formgrid">
                            <label>Titel<input value={selectedContract.title || ""} onChange={(e) => updateContract(selectedContract.id, { title: e.target.value })} /></label>
                            <label>Kunde<input value={selectedContract.customerName || ""} onChange={(e) => updateContract(selectedContract.id, { customerName: e.target.value })} /></label>
                            <label>Typ<select value={selectedContract.type || "Kundenvertrag"} onChange={(e) => updateContract(selectedContract.id, { type: e.target.value })}>{contractTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
                            <label>Status<select value={selectedContract.status || "Entwurf"} onChange={(e) => updateContract(selectedContract.id, { status: e.target.value })}>{contractStatuses.map((status) => <option key={status}>{status}</option>)}</select></label>
                            <label>Start<input type="date" value={selectedContract.startDate || ""} onChange={(e) => updateContract(selectedContract.id, { startDate: e.target.value })} /></label>
                            <label>Ende<input type="date" value={selectedContract.endDate || ""} onChange={(e) => updateContract(selectedContract.id, { endDate: e.target.value })} /></label>
                            <label>Kündigungsfrist<input type="number" value={selectedContract.noticePeriodDays || 30} onChange={(e) => updateContract(selectedContract.id, { noticePeriodDays: e.target.value })} /></label>
                            <label>Vertragswert<input type="number" step="0.01" value={selectedContract.value || ""} onChange={(e) => updateContract(selectedContract.id, { value: e.target.value })} /></label>
                            <label>Dokument<input value={selectedContract.documentName || ""} onChange={(e) => updateContract(selectedContract.id, { documentName: e.target.value })} /></label>
                            <label>Dokument-URL<input value={selectedContract.documentUrl || ""} onChange={(e) => updateContract(selectedContract.id, { documentUrl: e.target.value })} /></label>
                          </div>
                          <label>Notizen<textarea value={selectedContract.notes || ""} onChange={(e) => updateContract(selectedContract.id, { notes: e.target.value })} /></label>
                          <div className="buttonRow"><button type="button" className="primary smallButton" onClick={() => exportContractPdf(selectedContract)}>PDF exportieren</button>{selectedContract.documentUrl ? <a className="secondary smallButton" href={normalizeUploadUrl(selectedContract.documentUrl)} target="_blank" rel="noreferrer">Dokument öffnen</a> : null}</div>
                        </div>
                      ) : null}
                    </section>
                  );
                })() : null}

                {adminCenterTab === "offers" ? (() => {
                  const offerList = Array.isArray(offers) ? offers : [];
                  const customerList = Array.isArray(customers) ? customers : [];
                  const invoiceList = Array.isArray(invoices) ? invoices : [];
                  const offerStatuses = ["Entwurf", "Gesendet", "Angenommen", "Abgelehnt", "Abgelaufen"];
                  const parseAmount = (value) => Number(String(value || 0).replace("€", "").replace(/\s/g, "").replace(",", ".")) || 0;
                  const calcOfferTotals = (offer = {}) => {
                    const items = Array.isArray(offer.items) ? offer.items : [];
                    const net = items.reduce((sum, item) => {
                      const qty = parseAmount(item.qty || item.quantity || 0);
                      const price = parseAmount(item.price || item.unitPrice || 0);
                      return sum + qty * price;
                    }, 0);
                    const vatRate = Number(offer.vatRate ?? 19);
                    const vat = Math.round(net * (vatRate / 100) * 100) / 100;
                    const gross = Math.round((net + vat) * 100) / 100;
                    return { net, vat, gross, vatRate };
                  };
                  const offerStats = offerList.reduce((acc, offer) => {
                    const totals = calcOfferTotals(offer);
                    acc.total += 1;
                    acc.volume += totals.gross;
                    acc[offer.status || "Entwurf"] = (acc[offer.status || "Entwurf"] || 0) + 1;
                    return acc;
                  }, { total: 0, volume: 0 });
                  const updateOfferById = (offerId, patch) => {
                    setOffers((current) => (Array.isArray(current) ? current : []).map((item) => {
                      if (item.id !== offerId) return item;
                      const next = { ...item, ...patch, updatedAt: new Date().toLocaleString("de-DE") };
                      return { ...next, amount: calcOfferTotals(next).gross };
                    }));
                  };
                  const createOffer = () => {
                    const customer = customerList[0] || null;
                    const nextOffer = {
                      id: `ANG-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`,
                      offerNumber: `ANG-${new Date().getFullYear()}-${String(offerList.length + 1).padStart(4, "0")}`,
                      customerId: customer?.id || "",
                      customerName: customer?.company || customer?.contactName || "Ohne Kunde",
                      project: "",
                      title: "Neues Angebot",
                      status: "Entwurf",
                      validUntil: "",
                      vatRate: 19,
                      items: [
                        { id: `pos-${Date.now()}`, description: "Drohnenflug / Luftaufnahmen", qty: "1", unit: "Pauschal", price: "0" },
                      ],
                      notes: "",
                      terms: "Dieses Angebot ist, sofern nicht anders angegeben, 14 Tage gültig.",
                      createdAt: new Date().toLocaleString("de-DE"),
                      updatedAt: new Date().toLocaleString("de-DE"),
                    };
                    const totals = calcOfferTotals(nextOffer);
                    setOffers([{ ...nextOffer, amount: totals.gross }, ...offerList].slice(0, 300));
                    setSelectedOfferId(nextOffer.id);
                    writeAuditLog("Angebot erstellt", { offerId: nextOffer.id, customerName: nextOffer.customerName });
                  };
                  const selectedOffer = offerList.find((item) => item.id === selectedOfferId) || null;

                  return (
                    <div>
                      <div className="sectionHead">
                        <div>
                          <h2>Quote / Offer Pro</h2>
                          <p>Angebote mit Positionen, Netto/MwSt/Brutto, Status, PDF-Export und Übergabe an Rechnungen verwalten.</p>
                        </div>
                        <div className="buttonRow">
                          <Status status={offerList.length ? "good" : "warning"}>{offerList.length} Angebot(e)</Status>
                          <button type="button" className="primary smallButton" onClick={createOffer}>Neues Angebot</button>
                        </div>
                      </div>

                      <section className="ultimateDashboard" style={{ marginBottom: 18 }}>
                        <div className="dashCard"><strong>{offerStats.total}</strong><span>Angebote gesamt</span></div>
                        <div className="dashCard"><strong>{offerStats.Entwurf || 0}</strong><span>Entwürfe</span></div>
                        <div className="dashCard"><strong>{offerStats.Gesendet || 0}</strong><span>Gesendet</span></div>
                        <div className="dashCard"><strong>{offerStats.Angenommen || 0}</strong><span>Angenommen</span></div>
                        <div className="dashCard"><strong>{offerStats.volume.toFixed(2)} €</strong><span>Angebotsvolumen</span></div>
                      </section>

                      <div className="wideGrid" style={{ gridTemplateColumns: "minmax(320px,440px) minmax(360px,1fr)", alignItems: "start" }}>
                        <div className="card">
                          <div className="sectionHead">
                            <div>
                              <h3>Angebotsliste</h3>
                              <p>CRM-, Rechnungs- und Kundenportal-fähige Angebotsverwaltung.</p>
                            </div>
                          </div>

                          <div className="logbookList" style={{ marginTop: 14 }}>
                            {offerList.map((offer) => {
                              const totals = calcOfferTotals(offer);
                              const isSelected = selectedOfferId === offer.id;
                              return (
                                <div key={offer.id} className="listitem" style={isSelected ? { borderColor: "#2563eb", boxShadow: "0 0 0 2px rgba(37,99,235,.12)" } : undefined}>
                                  <strong>{offer.offerNumber || offer.id || "Angebot"}</strong>
                                  <span>{offer.customerName || "Ohne Kunde"} · {offer.title || "Ohne Titel"}</span>
                                  <small>{offer.status || "Entwurf"} · Netto {totals.net.toFixed(2)} € · Brutto {totals.gross.toFixed(2)} €{offer.validUntil ? ` · gültig bis ${offer.validUntil}` : ""}</small>
                                  <div className="buttonRow" style={{ marginTop: 8 }}>
                                    <button type="button" className="secondary smallButton" onClick={() => setSelectedOfferId(offer.id)}>Öffnen</button>
                                    <button
                                      type="button"
                                      className="secondary smallButton"
                                      onClick={() => {
                                        const clone = {
                                          ...offer,
                                          id: `ANG-${Date.now()}`,
                                          offerNumber: `${offer.offerNumber || "ANG"}-KOPIE`,
                                          status: "Entwurf",
                                          createdAt: new Date().toLocaleString("de-DE"),
                                          updatedAt: new Date().toLocaleString("de-DE"),
                                        };
                                        setOffers([clone, ...offerList].slice(0, 300));
                                        setSelectedOfferId(clone.id);
                                      }}
                                    >
                                      Duplizieren
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary smallButton"
                                      onClick={() => {
                                        setOffers(offerList.filter((item) => item.id !== offer.id));
                                        if (selectedOfferId === offer.id) setSelectedOfferId("");
                                      }}
                                    >
                                      Löschen
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                            {!offerList.length ? <p>Noch keine Angebote vorhanden. Klicke auf „Neues Angebot“.</p> : null}
                          </div>
                        </div>

                        <div className="card">
                          {!selectedOffer ? (
                            <div>
                              <h3>Angebot bearbeiten</h3>
                              <p>Wähle links ein Angebot aus oder erstelle ein neues Angebot.</p>
                            </div>
                          ) : (() => {
                            const items = Array.isArray(selectedOffer.items) ? selectedOffer.items : [];
                            const totals = calcOfferTotals(selectedOffer);
                            const customer = customerList.find((c) => c.id === selectedOffer.customerId);
                            const invoiceExists = invoiceList.some((invoice) => invoice.offerId === selectedOffer.id);

                            const updateItem = (index, patch) => {
                              const nextItems = items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
                              updateOfferById(selectedOffer.id, { items: nextItems });
                            };

                            const createOfferPdf = () => {
                              const doc = createPdfDocument();
                              doc.setFontSize(20);
                              doc.text("FlyMonitor Angebot", 20, 20);
                              doc.setFontSize(10);
                              doc.text(`Angebotsnummer: ${selectedOffer.offerNumber || selectedOffer.id}`, 20, 34);
                              doc.text(`Datum: ${selectedOffer.createdAt || new Date().toLocaleDateString("de-DE")}`, 20, 42);
                              doc.text(`Gültig bis: ${selectedOffer.validUntil || "-"}`, 20, 50);
                              doc.text(`Status: ${selectedOffer.status || "Entwurf"}`, 20, 58);

                              doc.setFontSize(12);
                              doc.text("Kunde", 20, 74);
                              doc.setFontSize(10);
                              doc.text(String(customer?.company || selectedOffer.customerName || "Ohne Kunde").slice(0, 70), 20, 82);
                              doc.text(String(customer?.contactName || "").slice(0, 70), 20, 90);
                              doc.text(String(customer?.street || "").slice(0, 70), 20, 98);
                              doc.text(`${customer?.zip || ""} ${customer?.city || ""}`.trim(), 20, 106);
                              doc.text(String(customer?.email || "").slice(0, 70), 20, 114);

                              doc.setFontSize(12);
                              doc.text(selectedOffer.title || "Angebot", 20, 132);
                              doc.setFontSize(10);
                              let y = 146;
                              doc.text("Position", 20, y);
                              doc.text("Menge", 114, y);
                              doc.text("Einzelpreis", 138, y);
                              doc.text("Summe", 174, y);
                              y += 8;

                              items.forEach((item, index) => {
                                const qty = parseAmount(item.qty);
                                const price = parseAmount(item.price);
                                const lineTotal = qty * price;
                                if (y > 270) {
                                  doc.addPage();
                                  y = 24;
                                }
                                doc.text(`${index + 1}. ${String(item.description || "-").slice(0, 55)}`, 20, y);
                                doc.text(`${qty} ${item.unit || ""}`.trim().slice(0, 18), 114, y);
                                doc.text(`${price.toFixed(2)} EUR`, 138, y);
                                doc.text(`${lineTotal.toFixed(2)} EUR`, 174, y);
                                y += 8;
                              });

                              y += 10;
                              doc.text(`Netto: ${totals.net.toFixed(2)} EUR`, 138, y);
                              y += 8;
                              doc.text(`MwSt. ${totals.vatRate}%: ${totals.vat.toFixed(2)} EUR`, 138, y);
                              y += 8;
                              doc.setFontSize(13);
                              doc.text(`Brutto: ${totals.gross.toFixed(2)} EUR`, 138, y);

                              if (selectedOffer.terms || selectedOffer.notes) {
                                y += 18;
                                doc.setFontSize(10);
                                doc.text("Hinweise / Bedingungen:", 20, y);
                                y += 8;
                                doc.text(String(selectedOffer.terms || selectedOffer.notes || "").slice(0, 220), 20, y, { maxWidth: 170 });
                              }

                              doc.save(`${selectedOffer.offerNumber || selectedOffer.id || "Angebot"}.pdf`);
                              writeAuditLog("Angebots-PDF erzeugt", { offerId: selectedOffer.id });
                            };

                            const convertToInvoice = () => {
                              const invoice = {
                                id: `RE-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`,
                                invoiceNumber: `RE-${new Date().getFullYear()}-${String(invoiceList.length + 1).padStart(4, "0")}`,
                                offerId: selectedOffer.id,
                                customerId: selectedOffer.customerId,
                                customerName: selectedOffer.customerName,
                                title: selectedOffer.title,
                                items: selectedOffer.items || [],
                                amount: totals.gross,
                                net: totals.net,
                                vat: totals.vat,
                                vatRate: totals.vatRate,
                                status: "offen",
                                dueDate: "",
                                paymentTerms: "Zahlbar innerhalb von 14 Tagen ohne Abzug.",
                                createdAt: new Date().toLocaleDateString("de-DE"),
                              };
                              setInvoices([invoice, ...invoiceList]);
                              updateOfferById(selectedOffer.id, { status: "Angenommen", invoiceId: invoice.id });
                              writeAuditLog("Angebot in Rechnung umgewandelt", { offerId: selectedOffer.id, invoiceId: invoice.id });
                              alert(`Rechnung ${invoice.invoiceNumber || invoice.id} wurde erstellt.`);
                            };

                            return (
                              <div>
                                <div className="sectionHead">
                                  <div>
                                    <h3>Angebot bearbeiten</h3>
                                    <p>{selectedOffer.offerNumber || selectedOffer.id}</p>
                                  </div>
                                  <Status status={selectedOffer.status === "Angenommen" ? "good" : selectedOffer.status === "Abgelehnt" || selectedOffer.status === "Abgelaufen" ? "danger" : "warning"}>{selectedOffer.status || "Entwurf"}</Status>
                                </div>

                                <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                                  <div>
                                    <label>Angebotsnummer</label>
                                    <input value={selectedOffer.offerNumber || ""} onChange={(event) => updateOfferById(selectedOffer.id, { offerNumber: event.target.value })} />
                                  </div>
                                  <div>
                                    <label>Kunde</label>
                                    <select
                                      value={selectedOffer.customerId || ""}
                                      onChange={(event) => {
                                        const c = customerList.find((item) => item.id === event.target.value);
                                        updateOfferById(selectedOffer.id, {
                                          customerId: c?.id || "",
                                          customerName: c?.company || c?.contactName || "Ohne Kunde",
                                        });
                                      }}
                                    >
                                      <option value="">Ohne Kunde</option>
                                      {customerList.map((c) => (
                                        <option key={c.id} value={c.id}>{c.company || c.contactName || c.customerNumber}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <div>
                                    <label>Status</label>
                                    <select value={selectedOffer.status || "Entwurf"} onChange={(event) => updateOfferById(selectedOffer.id, { status: event.target.value })}>
                                      {offerStatuses.map((status) => <option key={status}>{status}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <label>Gültig bis</label>
                                    <input type="date" value={selectedOffer.validUntil || ""} onChange={(event) => updateOfferById(selectedOffer.id, { validUntil: event.target.value })} />
                                  </div>
                                </div>

                                <label>Titel / Projekt</label>
                                <input value={selectedOffer.title || ""} onChange={(event) => updateOfferById(selectedOffer.id, { title: event.target.value })} placeholder="z. B. Drohnenaufnahmen Baustelle Kiel" />

                                <label>Projekt / interne Referenz</label>
                                <input value={selectedOffer.project || ""} onChange={(event) => updateOfferById(selectedOffer.id, { project: event.target.value })} placeholder="Projektname oder Referenz" />

                                <h4 style={{ marginTop: 18 }}>Positionen</h4>
                                <div className="logbookList">
                                  {items.map((item, index) => (
                                    <div key={item.id || index} className="listitem">
                                      <input value={item.description || ""} onChange={(event) => updateItem(index, { description: event.target.value })} placeholder="Leistung / Beschreibung" />
                                      <div className="wideGrid" style={{ gridTemplateColumns: "90px 110px 140px 1fr" }}>
                                        <input value={item.qty || ""} onChange={(event) => updateItem(index, { qty: event.target.value })} placeholder="Menge" />
                                        <input value={item.unit || ""} onChange={(event) => updateItem(index, { unit: event.target.value })} placeholder="Einheit" />
                                        <input value={item.price || ""} onChange={(event) => updateItem(index, { price: event.target.value })} placeholder="Einzelpreis €" />
                                        <button type="button" className="secondary smallButton" onClick={() => updateOfferById(selectedOffer.id, { items: items.filter((_, itemIndex) => itemIndex !== index) })}>Position löschen</button>
                                      </div>
                                    </div>
                                  ))}
                                  {!items.length ? <p>Noch keine Positionen vorhanden.</p> : null}
                                </div>

                                <div className="buttonRow" style={{ marginTop: 12 }}>
                                  <button
                                    type="button"
                                    className="secondary smallButton"
                                    onClick={() => updateOfferById(selectedOffer.id, { items: [...items, { id: `pos-${Date.now()}`, description: "", qty: "1", unit: "Stk.", price: "" }] })}
                                  >
                                    Position hinzufügen
                                  </button>
                                </div>

                                <div className="card" style={{ marginTop: 18 }}>
                                  <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
                                    <div><p className="label">Netto</p><h3>{totals.net.toFixed(2)} €</h3></div>
                                    <div><p className="label">MwSt.</p><h3>{totals.vat.toFixed(2)} €</h3></div>
                                    <div><p className="label">Brutto</p><h3>{totals.gross.toFixed(2)} €</h3></div>
                                    <div>
                                      <label>MwSt.-Satz</label>
                                      <input type="number" value={selectedOffer.vatRate ?? 19} onChange={(event) => updateOfferById(selectedOffer.id, { vatRate: Number(event.target.value || 0) })} />
                                    </div>
                                  </div>
                                </div>

                                <label>Zahlungs-/Angebotsbedingungen</label>
                                <textarea value={selectedOffer.terms || ""} onChange={(event) => updateOfferById(selectedOffer.id, { terms: event.target.value })} rows={3} />

                                <label>Interne Notizen</label>
                                <textarea value={selectedOffer.notes || ""} onChange={(event) => updateOfferById(selectedOffer.id, { notes: event.target.value })} rows={3} />

                                <div className="buttonRow" style={{ marginTop: 16 }}>
                                  <button type="button" className="primary" onClick={createOfferPdf}>PDF-Angebot erzeugen</button>
                                  <button type="button" className="secondary" disabled={invoiceExists} onClick={convertToInvoice}>{invoiceExists ? "Rechnung vorhanden" : "In Rechnung umwandeln"}</button>
                                  <button type="button" className="secondary" onClick={() => setAdminCenterTab("customerPortalPro")}>Im Kundenportal prüfen</button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  );
                })() : null}


{adminCenterTab === "invoices" ? (() => {
                  const invoiceList = Array.isArray(invoices) ? invoices : [];
                  const customerList = Array.isArray(customers) ? customers : [];
                  const offerList = Array.isArray(offers) ? offers : [];

                  const parseMoney = (value) =>
                    Number(String(value || 0).replace("€", "").replace(/\s/g, "").replace(",", ".")) || 0;

                  const calcInvoiceTotals = (invoice) => {
                    const items = Array.isArray(invoice?.items) ? invoice.items : [];
                    const net = items.length
                      ? items.reduce((sum, item) => sum + parseMoney(item.qty || 0) * parseMoney(item.price || 0), 0)
                      : parseMoney(invoice?.netTotal || invoice?.amount || invoice?.totalNet || 0);
                    const vatRate = Number(invoice?.vatRate ?? 19) / 100;
                    const vat = Math.round(net * vatRate * 100) / 100;
                    const gross = Math.round((net + vat) * 100) / 100;
                    return { net, vat, gross };
                  };

                  const getInvoiceDateValue = (invoice) => {
                    const raw = String(invoice?.dueDate || "").trim();
                    if (!raw) return null;
                    const d = new Date(raw);
                    return Number.isNaN(d.getTime()) ? null : d;
                  };

                  const isInvoicePaid = (invoice) => ["bezahlt", "paid"].includes(String(invoice?.status || "").toLowerCase());
                  const isInvoiceOverdue = (invoice) => {
                    const due = getInvoiceDateValue(invoice);
                    return Boolean(due && !isInvoicePaid(invoice) && due.getTime() < Date.now());
                  };

                  const invoiceStats = invoiceList.reduce(
                    (acc, invoice) => {
                      const totals = calcInvoiceTotals(invoice);
                      acc.totalGross += totals.gross;
                      if (isInvoicePaid(invoice)) acc.paidGross += totals.gross;
                      else acc.openGross += totals.gross;
                      if (isInvoiceOverdue(invoice)) acc.overdueCount += 1;
                      return acc;
                    },
                    { totalGross: 0, paidGross: 0, openGross: 0, overdueCount: 0 }
                  );

                  const updateInvoice = (id, patch) => {
                    setInvoices(invoiceList.map((invoice) => invoice.id === id ? { ...invoice, ...patch, updatedAt: new Date().toLocaleString("de-DE") } : invoice));
                  };

                  const createInvoicePdf = (invoice) => {
                    const doc = createPdfDocument();
                    const customer = customerList.find((c) => String(c.id) === String(invoice.customerId));
                    const invoiceItems = Array.isArray(invoice.items) ? invoice.items : [];
                    const totals = calcInvoiceTotals(invoice);
                    const invoiceDate = invoice.invoiceDate || invoice.createdAt || new Date().toLocaleDateString("de-DE");
                    const dueDate = invoice.dueDate || "14 Tage netto";

                    doc.setFontSize(22);
                    doc.text("FlyMonitor", 20, 20);
                    doc.setFontSize(10);
                    doc.text("Robert Bajela", 20, 30);
                    doc.text("Moorkamp 1", 20, 36);
                    doc.text("24106 Kiel", 20, 42);
                    doc.text("info@flymonitor.de", 20, 48);

                    doc.setFontSize(18);
                    doc.text("Rechnung", 150, 20);
                    doc.setFontSize(10);
                    doc.text(`Rechnungsnummer: ${invoice.id || "RE"}`, 130, 35);
                    doc.text(`Datum: ${invoiceDate}`, 130, 42);
                    doc.text(`Fällig: ${dueDate}`, 130, 49);
                    doc.text(`Status: ${invoice.status || "Offen"}`, 130, 56);
                    doc.line(20, 62, 190, 62);

                    doc.setFontSize(11);
                    doc.text("Rechnung an:", 20, 74);
                    doc.text(customer?.company || customer?.contactName || invoice.customerName || "Ohne Kunde", 20, 84);
                    doc.text(customer?.street || "", 20, 92);
                    doc.text(`${customer?.zip || ""} ${customer?.city || ""}`, 20, 100);
                    doc.text(customer?.email || "", 20, 108);

                    doc.setFontSize(13);
                    doc.text(invoice.title || "Leistung", 20, 126);
                    let y = 142;
                    doc.setFontSize(10);
                    doc.text("Beschreibung", 20, y);
                    doc.text("Menge", 110, y);
                    doc.text("Einzelpreis", 135, y);
                    doc.text("Summe", 170, y);
                    doc.line(20, y + 3, 190, y + 3);
                    y += 12;

                    const rows = invoiceItems.length ? invoiceItems : [{ description: invoice.title || "Leistung", qty: 1, price: totals.net }];
                    rows.forEach((item) => {
                      if (y > 255) {
                        doc.addPage();
                        y = 24;
                      }
                      const qty = parseMoney(item.qty || 0) || 1;
                      const price = parseMoney(item.price || 0);
                      const lineTotal = qty * price;
                      doc.text(String(item.description || "-").slice(0, 45), 20, y);
                      doc.text(String(qty), 110, y);
                      doc.text(`${price.toFixed(2)} EUR`, 135, y);
                      doc.text(`${lineTotal.toFixed(2)} EUR`, 170, y);
                      y += 9;
                    });

                    y += 12;
                    doc.line(120, y, 190, y);
                    y += 10;
                    doc.text(`Netto: ${totals.net.toFixed(2)} EUR`, 135, y);
                    y += 8;
                    doc.text(`MwSt. ${invoice.vatRate ?? 19}%: ${totals.vat.toFixed(2)} EUR`, 135, y);
                    y += 10;
                    doc.setFontSize(13);
                    doc.text(`Brutto: ${totals.gross.toFixed(2)} EUR`, 135, y);
                    y += 22;
                    doc.setFontSize(10);
                    doc.text(invoice.paymentTerms || "Zahlbar innerhalb von 14 Tagen ohne Abzug.", 20, y);
                    doc.setFontSize(8);
                    doc.line(20, 275, 190, 275);
                    doc.text("FlyMonitor · Robert Bajela · Moorkamp 1 · 24106 Kiel · info@flymonitor.de", 20, 282);
                    doc.save(`${invoice.id || "Rechnung"}.pdf`);
                  };

                  const createInvoiceDraft = (sourceOffer = null) => {
                    const customer = sourceOffer?.customerId
                      ? customerList.find((item) => String(item.id) === String(sourceOffer.customerId))
                      : customerList[0];
                    const today = new Date();
                    const due = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
                    const invoice = {
                      id: `RE-${today.getFullYear()}-${String(Date.now()).slice(-6)}`,
                      offerId: sourceOffer?.id || "",
                      customerId: sourceOffer?.customerId || customer?.id || "",
                      customerName: sourceOffer?.customerName || customer?.company || customer?.contactName || "Ohne Kunde",
                      title: sourceOffer?.title || "Drohnenleistung",
                      items: Array.isArray(sourceOffer?.items) && sourceOffer.items.length
                        ? sourceOffer.items
                        : [{ id: `pos-${Date.now()}`, description: sourceOffer?.title || "Drohnenflug / Medienleistung", qty: "1", price: sourceOffer?.amount || "0" }],
                      vatRate: 19,
                      status: "Offen",
                      invoiceDate: today.toISOString().slice(0, 10),
                      dueDate: due.toISOString().slice(0, 10),
                      paymentTerms: "Zahlbar innerhalb von 14 Tagen ohne Abzug.",
                      createdAt: today.toLocaleString("de-DE"),
                    };
                    setInvoices([invoice, ...invoiceList].slice(0, 300));
                  };

                  return (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>Rechnungen Pro+</h2>
                        <p>Angebote, Kunden, Missionen und CRM direkt mit Rechnungen, Zahlungsstatus und PDF verknüpfen.</p>
                      </div>
                      <Status status={invoiceList.length ? "good" : "warning"}>{invoiceList.length} Rechnung(en)</Status>
                    </div>

                    <div className="dashGrid" style={{ marginBottom: 18 }}>
                      <div className="dashCard"><strong>{invoiceStats.totalGross.toFixed(2)} €</strong><span>Rechnungsvolumen</span></div>
                      <div className="dashCard"><strong>{invoiceStats.openGross.toFixed(2)} €</strong><span>Offen</span></div>
                      <div className="dashCard"><strong>{invoiceStats.paidGross.toFixed(2)} €</strong><span>Bezahlt</span></div>
                      <div className="dashCard"><strong>{invoiceStats.overdueCount}</strong><span>Überfällig</span></div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(280px,420px) minmax(320px,1fr)", alignItems: "start" }}>
                      <div className="card">
                        <h3>Rechnung erstellen</h3>
                        <p>Erstellt einen vollständigen Rechnungsentwurf mit Positionen, MwSt., Fälligkeit und PDF-Funktion.</p>
                        <div className="buttonRow">
                          <button type="button" className="primary smallButton" onClick={() => createInvoiceDraft()}>Neue Rechnung</button>
                          <button type="button" className="secondary smallButton" onClick={() => createInvoiceDraft(offerList[0])} disabled={!offerList.length}>Aus neuestem Angebot</button>
                        </div>
                        {!customerList.length ? <p style={{ marginTop: 10 }}>Hinweis: Es ist noch kein Kunde vorhanden. Die Rechnung wird ohne Kundenzuordnung erstellt.</p> : null}
                      </div>

                      <div className="card">
                        <div className="sectionHead">
                          <div>
                            <h3>Rechnungsliste</h3>
                            <p>Status, Fälligkeit, PDF und Zahlung direkt verwalten.</p>
                          </div>
                        </div>
                        <div className="logbookList" style={{ marginTop: 14 }}>
                          {invoiceList.map((invoice) => {
                            const totals = calcInvoiceTotals(invoice);
                            const overdue = isInvoiceOverdue(invoice);
                            return (
                            <div key={invoice.id} className="listitem" style={overdue ? { borderColor: "#fecaca", background: "#fff7f7" } : undefined}>
                              <strong>{invoice.id || "Rechnung"}</strong>
                              <span>{invoice.customerName || "Ohne Kunde"} · {invoice.title || "Ohne Titel"}</span>
                              <small>
                                {invoice.status || "Offen"} · {totals.gross.toFixed(2)} €
                                {invoice.dueDate ? ` · fällig ${invoice.dueDate}` : ""}
                                {invoice.offerId ? ` · aus ${invoice.offerId}` : ""}
                                {overdue ? " · ÜBERFÄLLIG" : ""}
                              </small>

                              <div className="profileGrid" style={{ marginTop: 10 }}>
                                <label>Status
                                  <select value={invoice.status || "Offen"} onChange={(e) => updateInvoice(invoice.id, { status: e.target.value })}>
                                    <option>Offen</option>
                                    <option>Teilbezahlt</option>
                                    <option>Bezahlt</option>
                                    <option>Überfällig</option>
                                    <option>Storniert</option>
                                  </select>
                                </label>
                                <label>Fällig am
                                  <input type="date" value={invoice.dueDate || ""} onChange={(e) => updateInvoice(invoice.id, { dueDate: e.target.value })} />
                                </label>
                                <label>Zahlungsziel / Hinweis
                                  <input value={invoice.paymentTerms || ""} onChange={(e) => updateInvoice(invoice.id, { paymentTerms: e.target.value })} placeholder="z.B. 14 Tage netto" />
                                </label>
                              </div>

                              <div className="buttonRow" style={{ marginTop: 8 }}>
                                <button type="button" className="secondary smallButton" onClick={() => createInvoicePdf(invoice)}>PDF öffnen</button>
                                <button type="button" className="secondary smallButton" onClick={() => updateInvoice(invoice.id, { status: "Bezahlt", paidAt: new Date().toLocaleString("de-DE") })}>Als bezahlt markieren</button>
                                <button type="button" className="secondary smallButton" onClick={() => updateInvoice(invoice.id, { status: "Offen", paidAt: "" })}>Auf offen setzen</button>
                                <button type="button" className="secondary smallButton" onClick={() => setInvoices(invoiceList.filter((item) => item.id !== invoice.id))}>Löschen</button>
                              </div>
                            </div>
                          );})}
                          {!invoiceList.length ? <p>Noch keine Rechnungen vorhanden.</p> : null}
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                })() : null}

                {adminCenterTab === "authorityCenterPro" ? (
                  <div>
                    <div className="sectionHead">
                      <div><h2>Behörden-Center</h2><p>Genehmigungen, Nachweise, Versicherungen, Fristen und Dokumentenarchiv zentral verwalten.</p></div>
                      <Status status={authorityDashboardStatsPro.expired ? "danger" : authorityDashboardStatsPro.warning ? "warning" : "good"}>{authorityDashboardStatsPro.total} Dokumente</Status>
                    </div>

                    <div className="dashboardGrid" style={{ marginBottom: 18 }}>
                      <div className="dashCard"><strong>{authorityDashboardStatsPro.total}</strong><span>Dokumente gesamt</span></div>
                      <div className="dashCard"><strong>{authorityDashboardStatsPro.valid}</strong><span>Gültig</span></div>
                      <div className="dashCard"><strong>{authorityDashboardStatsPro.warning}</strong><span>Bald ablaufend</span></div>
                      <div className="dashCard"><strong>{authorityDashboardStatsPro.expired}</strong><span>Abgelaufen</span></div>
                      <div className="dashCard"><strong>{authorityDashboardStatsPro.withoutDate}</strong><span>Ohne Frist</span></div>
                    </div>

                    <div className="card" style={{ marginBottom: 18 }}>
                      <div className="sectionHead"><div><h3>{editingAuthorityDocumentId ? "Dokument bearbeiten" : "Dokument hinzufügen"}</h3><p>A1/A3, A2, Versicherung, Betriebs- oder Sondergenehmigung hinterlegen.</p></div><button type="button" className="secondary smallButton" onClick={resetAuthorityDocumentDraftPro}>Neu</button></div>
                      <div className="profileGrid">
                        <label>Typ<select value={authorityDocumentDraft.type || "A2"} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, type: e.target.value })}>{AUTHORITY_DOCUMENT_TYPES_PRO.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
                        <label>Kategorie<select value={authorityDocumentDraft.category || "Genehmigungen"} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, category: e.target.value })}>{AUTHORITY_DOCUMENT_CATEGORIES_PRO.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
                        <label>Titel<input value={authorityDocumentDraft.title || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, title: e.target.value })} placeholder="z.B. A2 Fernpilotenzeugnis" /></label>
                        <label>Nummer / Aktenzeichen<input value={authorityDocumentDraft.number || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, number: e.target.value })} /></label>
                        <label>Aussteller<input value={authorityDocumentDraft.issuer || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, issuer: e.target.value })} placeholder="z.B. LBA / Versicherung / Behörde" /></label>
                        <label>Inhaber / Bezug<input value={authorityDocumentDraft.owner || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, owner: e.target.value })} /></label>
                        <label>Ausgestellt am<input type="date" value={authorityDocumentDraft.issuedAt || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, issuedAt: e.target.value })} /></label>
                        <label>Gültig bis<input type="date" value={authorityDocumentDraft.validUntil || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, validUntil: e.target.value })} /></label>
                        <label>Verknüpfte Drohne<select value={authorityDocumentDraft.relatedDroneId || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, relatedDroneId: e.target.value })}><option value="">Keine</option>{(droneAssets || []).map((drone) => <option key={drone.id} value={drone.id}>{getDroneDisplayName(drone)}</option>)}</select></label>
                        <label>Dokument-Datei<input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" onChange={(e) => attachAuthorityDocumentFilePro(e.target.files?.[0])} /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Externe Datei-URL<input value={authorityDocumentDraft.fileUrl && !String(authorityDocumentDraft.fileUrl).startsWith("data:") ? authorityDocumentDraft.fileUrl : ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, fileUrl: e.target.value })} placeholder="/uploads/... oder https://..." /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Notizen<textarea value={authorityDocumentDraft.notes || ""} onChange={(e) => setAuthorityDocumentDraft({ ...authorityDocumentDraft, notes: e.target.value })} rows={3} /></label>
                      </div>
                      <div className="buttonRow" style={{ marginTop: 12 }}>
                        <button type="button" className="primary smallButton" onClick={saveAuthorityDocumentPro}>Dokument speichern</button>
                        <button type="button" className="secondary smallButton" onClick={exportAuthorityDocumentsPdfPro}>Behörden-PDF</button>
                        {authorityDocumentDraft.fileName ? <span className="hint">Datei: {authorityDocumentDraft.fileName}</span> : null}
                      </div>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(280px,1fr) minmax(280px,1fr)", marginBottom: 18 }}>
                      <div className="card">
                        <h3>Fristen & Erinnerungen</h3>
                        <p>Warnstufen: {AUTHORITY_REMINDER_DAYS_PRO.join(" / ")} Tage vor Ablauf.</p>
                        <div className="logbookList">
                          {authorityReminderDocumentsPro.slice(0, 8).map(({ document, status }) => (
                            <div key={document.id} className="listitem"><strong>{formatAuthorityReminderTextPro(document)}</strong><span>{document.type} · {document.number || "ohne Nummer"}</span><Status status={status.tone}>{status.label}</Status></div>
                          ))}
                          {!authorityReminderDocumentsPro.length ? <p>Keine anstehenden Fristen innerhalb der nächsten 90 Tage.</p> : null}
                        </div>
                      </div>
                      <div className="card">
                        <h3>Filter</h3>
                        <div className="profileGrid">
                          <label>Suche<input value={authorityDocumentSearch} onChange={(e) => setAuthorityDocumentSearch(e.target.value)} placeholder="Titel, Nummer, Aussteller..." /></label>
                          <label>Filter<select value={authorityDocumentFilter} onChange={(e) => setAuthorityDocumentFilter(e.target.value)}><option>Alle</option><option>Gültig</option><option>Läuft bald ab</option><option>Abgelaufen</option>{AUTHORITY_DOCUMENT_TYPES_PRO.map((type) => <option key={type}>{type}</option>)}{AUTHORITY_DOCUMENT_CATEGORIES_PRO.map((category) => <option key={category}>{category}</option>)}</select></label>
                        </div>
                      </div>
                    </div>

                    <div className="card">
                      <div className="sectionHead"><div><h3>Dokumentenarchiv</h3><p>Genehmigungen, Versicherungen, Lizenzen und Behördenschreiben.</p></div><Status status="good">{filteredAuthorityDocumentsPro.length} Treffer</Status></div>
                      <div className="logbookList">
                        {filteredAuthorityDocumentsPro.map((document) => {
                          const status = getAuthorityDocumentStatusPro(document);
                          return (
                            <div key={document.id} className="listitem">
                              <strong>{document.title || document.type}</strong>
                              <span>{document.type} · {document.category} · Nr.: {document.number || "-"}</span>
                              <span>Aussteller: {document.issuer || "-"} · Gültig bis: {document.validUntil || "ohne Frist"}</span>
                              <Status status={status.tone}>{status.label}</Status>
                              {document.fileUrl ? <a href={normalizeUploadUrl(document.fileUrl)} target="_blank" rel="noreferrer">Dokument öffnen</a> : null}
                              <div className="buttonRow" style={{ marginTop: 8 }}>
                                <button type="button" className="secondary smallButton" onClick={() => editAuthorityDocumentPro(document)}>Bearbeiten</button>
                                <button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteAuthorityDocumentPro(document.id)}>Löschen</button>
                              </div>
                            </div>
                          );
                        })}
                        {!filteredAuthorityDocumentsPro.length ? <p>Noch keine Behördendokumente vorhanden.</p> : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "authorities" ? (
                  <div>
                    <div className="sectionHead"><div><h2>Behörden & Empfänger</h2><p>Empfänger bearbeiten, löschen, auswählen und für den Versand nutzen.</p></div><Status status="good">{savedEmailRecipients.length} Empfänger</Status></div>

                    <div className="card" style={{ marginBottom: "18px" }}>
                      <h3>Empfänger hinzufügen</h3>
                      <div className="profileGrid">
                        <label>Kategorie<input value={newRecipientCategory} onChange={(e) => setNewRecipientCategory(e.target.value)} placeholder="z. B. Behörde" /></label>
                        <label>Unterkategorie<input value={newRecipientSubcategory} onChange={(e) => setNewRecipientSubcategory(e.target.value)} placeholder="z. B. Kreis / Stadt" /></label>
                        <label>Name / Bezeichnung<input value={newRecipientName} onChange={(e) => setNewRecipientName(e.target.value)} placeholder="z. B. Ordnungsamt Kiel" /></label>
                        <label>Zuständigkeit<input value={newRecipientResponsibility} onChange={(e) => setNewRecipientResponsibility(e.target.value)} placeholder="z. B. UAS / Luftfahrt" /></label>
                        <label style={{ gridColumn: "1 / -1" }}>E-Mail-Adresse(n)<input value={newRecipientEmails} onChange={(e) => setNewRecipientEmails(e.target.value)} placeholder="amt@example.de; weitere@example.de" /></label>
                      </div>
                      <div className="buttonRow" style={{ marginTop: "12px" }}>
                        <button type="button" className="secondary smallButton" onClick={addSavedEmailRecipientWorking}>Empfänger speichern</button>
                        <button type="button" className="secondary smallButton" onClick={restoreDefaultEmailRecipientsWorking}>SH-Behörden laden</button>
                      </div>
                    </div>

                    <div className="card" style={{ marginBottom: "18px" }}>
                      <h3>Ausgewählte Empfänger für E-Mail-Versand</h3>
                      <p>{selectedRecipientIds.length} Empfänger ausgewählt. Diese Empfänger werden beim Button „Per E-Mail senden“ genutzt.</p>
                      <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="Optionale zusätzliche E-Mail-Adressen" />
                    </div>

                    <div className="logbookList">
                      {recipientsByCategory.map(({ category, recipients }) => (
                        <div key={category} className="listitem">
                          <div className="sectionHead" style={{ marginBottom: "10px" }}>
                            <div><strong>{category}</strong><span>{recipients.length} Empfänger</span></div>
                            <div className="buttonRow">
                              <button type="button" className="secondary smallButton" onClick={() => startEditRecipientCategory(category)}>Kategorie umbenennen</button>
                              <button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteRecipientCategoryWorking(category)}>Kategorie löschen</button>
                            </div>
                          </div>

                          {editingRecipientCategory === category ? (
                            <div className="profileGrid" style={{ marginBottom: "12px" }}>
                              <label>Neuer Kategoriename<input value={editRecipientCategoryName} onChange={(e) => setEditRecipientCategoryName(e.target.value)} /></label>
                              <div className="buttonRow" style={{ alignSelf: "end" }}>
                                <button type="button" className="secondary smallButton" onClick={() => saveEditedRecipientCategoryWorking(category)}>Speichern</button>
                                <button type="button" className="secondary smallButton" onClick={cancelEditRecipientCategory}>Abbrechen</button>
                              </div>
                            </div>
                          ) : null}

                          <div className="logbookList">
                            {recipients.map((recipient) => (
                              <div key={recipient.id || `${recipient.name}-${(recipient.emails || []).join(",")}`} className="listitem">
                                {editingRecipientId === recipient.id ? (
                                  <>
                                    <div className="profileGrid">
                                      <label>Kategorie<input value={editRecipient.category || ""} onChange={(e) => setEditRecipient({ ...editRecipient, category: e.target.value })} /></label>
                                      <label>Unterkategorie<input value={editRecipient.subcategory || ""} onChange={(e) => setEditRecipient({ ...editRecipient, subcategory: e.target.value })} /></label>
                                      <label>Name<input value={editRecipient.name || ""} onChange={(e) => setEditRecipient({ ...editRecipient, name: e.target.value })} /></label>
                                      <label>Zuständigkeit<input value={editRecipient.responsibility || ""} onChange={(e) => setEditRecipient({ ...editRecipient, responsibility: e.target.value })} /></label>
                                      <label style={{ gridColumn: "1 / -1" }}>E-Mail(s)<input value={editRecipient.emailsText || ""} onChange={(e) => setEditRecipient({ ...editRecipient, emailsText: e.target.value })} /></label>
                                    </div>
                                    <div className="buttonRow" style={{ marginTop: "10px" }}>
                                      <button type="button" className="secondary smallButton" onClick={saveEditedSavedEmailRecipientWorking}>Änderungen speichern</button>
                                      <button type="button" className="secondary smallButton" onClick={cancelEditSavedEmailRecipient}>Abbrechen</button>
                                    </div>
                                  </>
                                ) : (
                                  <>
                                    <strong>{recipient.name || "Empfänger"}</strong>
                                    <span>{recipient.subcategory ? `${recipient.subcategory} · ` : ""}{recipient.responsibility || "Keine Zuständigkeit hinterlegt"}</span>
                                    <small>{(recipient.emails || []).join(", ")}</small>
                                    <div className="buttonRow" style={{ marginTop: "10px" }}>
                                      <button type="button" className="secondary smallButton" onClick={() => toggleSavedEmailRecipient(recipient.id)}>{selectedRecipientIds.includes(recipient.id) ? "Für Versand abwählen" : "Für Versand auswählen"}</button>
                                      <button type="button" className="secondary smallButton" onClick={() => startEditSavedEmailRecipient(recipient)}>Bearbeiten</button>
                                      <button type="button" className="secondary smallButton" onClick={() => moveEmailRecipientWorking(recipient)}>Verschieben</button>
                                      <button type="button" className="secondary smallButton" style={{ color: "#b91c1c", borderColor: "#fecaca" }} onClick={() => deleteSavedEmailRecipientWorking(recipient.id)}>Löschen</button>
                                    </div>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}


                {adminCenterTab === "fleet" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>Wartung</h2>
                        <p>Drohnenakte, Akkuverwaltung, Wartungsplan, Erinnerungen und automatisch berechnete Flugstunden.</p>
                      </div>
                      <Status status={dueMaintenanceEntries.length || batteryWarnings.length ? "warning" : "good"}>
                        {droneAssets.length} Drohne(n) · {formatTotalFlightTime(totalDroneFlightMinutes)}
                      </Status>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", marginBottom: 18 }}>
                      <div className="card"><h3>Aktive Drohnen</h3><p style={{ fontSize: 28, fontWeight: 900 }}>{droneAssets.filter((item) => item.status === "Aktiv").length}</p><p>von {droneAssets.length} erfasst</p></div>
                      <div className="card"><h3>Gesamtflugzeit</h3><p style={{ fontSize: 28, fontWeight: 900 }}>{formatTotalFlightTime(totalDroneFlightMinutes)}</p><p>aus abgeschlossenen Flügen</p></div>
                      <div className="card"><h3>Akku-Warnungen</h3><p style={{ fontSize: 28, fontWeight: 900 }}>{batteryWarnings.length}</p><p>ab 150 Zyklen oder geringer Gesundheit</p></div>
                      <div className="card"><h3>Wartungen fällig</h3><p style={{ fontSize: 28, fontWeight: 900 }}>{dueMaintenanceEntries.length}</p><p>überfällig oder in den nächsten 14 Tagen</p></div>
                    </div>

                    <div className="card" style={{ marginBottom: 18 }}>
                      <h3>Drohne anlegen / bearbeiten</h3>
                      <div className="profileGrid">
                        <label>Name<input value={droneAssetDraft.name || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, name: e.target.value })} placeholder="z. B. DJI Air 3S" /></label>
                        <label>Hersteller<input value={droneAssetDraft.manufacturer || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, manufacturer: e.target.value })} /></label>
                        <label>Modell<input value={droneAssetDraft.model || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, model: e.target.value })} /></label>
                        <label>Seriennummer<input value={droneAssetDraft.serialNumber || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, serialNumber: e.target.value })} /></label>
                        <label>Remote-ID<input value={droneAssetDraft.remoteId || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, remoteId: e.target.value })} placeholder="Remote-ID / Broadcast-ID" /></label>
                        <label>C-Klasse<select value={droneAssetDraft.cClass || "Unbekannt"} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, cClass: e.target.value })}>{DRONE_C_CLASS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                        <label>Gewicht in g<input value={droneAssetDraft.weight || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, weight: e.target.value })} /></label>
                        <label>Kaufdatum<input type="date" value={droneAssetDraft.purchaseDate || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, purchaseDate: e.target.value })} /></label>
                        <label>Firmware<input value={droneAssetDraft.firmwareVersion || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, firmwareVersion: e.target.value })} placeholder="z. B. 01.00.0600" /></label>
                        <label>Letzte Prüfung<input type="date" value={droneAssetDraft.lastInspectionDate || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, lastInspectionDate: e.target.value })} /></label>
                        <label>Status<select value={droneAssetDraft.status || "Aktiv"} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, status: e.target.value })}>{DRONE_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                        <label style={{ gridColumn: "1 / -1" }}>Bild-URL optional<input value={droneAssetDraft.imageUrl || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, imageUrl: e.target.value })} placeholder="https://..." /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Notizen<textarea rows={3} value={droneAssetDraft.notes || ""} onChange={(e) => setDroneAssetDraft({ ...droneAssetDraft, notes: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveDroneAssetWorking}>Drohne speichern</button><button type="button" className="secondary smallButton" onClick={() => setDroneAssetDraft(createEmptyDroneAsset())}>Neu</button></div>
                    </div>

                    <div className="logbookList" style={{ marginBottom: 18 }}>
                      {droneAssets.map((drone) => {
                        const stats = droneFlightStats.find((item) => item.droneId === drone.id) || {};
                        return <div key={drone.id} className="listitem">
                          <strong>{getDroneDisplayName(drone)} · {drone.status}</strong>
                          <span>{drone.serialNumber ? `SN: ${drone.serialNumber} · ` : ""}{drone.remoteId ? `Remote-ID: ${drone.remoteId} · ` : ""}{drone.cClass || ""}{drone.weight ? ` · ${drone.weight} g` : ""}{drone.firmwareVersion ? ` · Firmware ${drone.firmwareVersion}` : ""}{drone.lastInspectionDate ? ` · Prüfung ${formatMailPdfGermanDate(drone.lastInspectionDate)}` : ""}</span>
                          <span>Flüge: {stats.flights || 0} · Flugzeit: {stats.totalTime || "0:00 h"} · Ø {stats.averageTime || "0:00 h"} · Letzter Flug: {formatMailPdfGermanDate(stats.lastFlight) || "-"}</span>
                          <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => editDroneAssetWorking(drone)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => deleteDroneAssetWorking(drone.id)}>Löschen</button></div>
                        </div>;
                      })}
                      {!droneAssets.length ? <p>Noch keine Drohnen erfasst.</p> : null}
                    </div>

                    <div className="card" style={{ marginBottom: 18 }}>
                      <h3>Akku anlegen / bearbeiten</h3>
                      <div className="profileGrid">
                        <label>Akku-Name<input value={batteryAssetDraft.name || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, name: e.target.value })} placeholder="z. B. Akku 1" /></label>
                        <label>Zugeordnete Drohne<select value={batteryAssetDraft.droneId || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, droneId: e.target.value })}><option value="">Keine Zuordnung</option>{droneAssets.map((drone) => <option key={drone.id} value={drone.id}>{getDroneDisplayName(drone)}</option>)}</select></label>
                        <label>Seriennummer<input value={batteryAssetDraft.serialNumber || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, serialNumber: e.target.value })} /></label>
                        <label>Ladezyklen<input type="number" min="0" value={batteryAssetDraft.chargeCycles || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, chargeCycles: e.target.value })} /></label>
                        <label>Zustand %<input type="number" min="0" max="100" value={batteryAssetDraft.healthPercent || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, healthPercent: e.target.value })} /></label>
                        <label>Kaufdatum<input type="date" value={batteryAssetDraft.purchaseDate || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, purchaseDate: e.target.value })} /></label>
                        <label>Letzter Akku-Check<input type="date" value={batteryAssetDraft.lastCheckDate || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, lastCheckDate: e.target.value })} /></label>
                        <label>Status<select value={batteryAssetDraft.status || "Gut"} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, status: e.target.value })}>{BATTERY_STATUS_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                        <label style={{ gridColumn: "1 / -1" }}>Notizen<textarea rows={3} value={batteryAssetDraft.notes || ""} onChange={(e) => setBatteryAssetDraft({ ...batteryAssetDraft, notes: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveBatteryAssetWorking}>Akku speichern</button><button type="button" className="secondary smallButton" onClick={() => setBatteryAssetDraft(createEmptyBatteryAsset())}>Neu</button></div>
                    </div>

                    <div className="logbookList" style={{ marginBottom: 18 }}>
                      {batteryAssets.map((battery) => {
                        const drone = droneAssets.find((item) => String(item.id) === String(battery.droneId));
                        const tone = getBatteryWarningTone(battery);
                        return <div key={battery.id} className="listitem">
                          <strong>{battery.name || battery.serialNumber || "Akku"} <Status status={tone}>{tone === "danger" ? "kritisch" : tone === "warning" ? "beobachten" : "ok"}</Status></strong>
                          <span>Drohne: {getDroneDisplayName(drone)} · Zyklen: {battery.chargeCycles || 0} · Zustand: {battery.healthPercent || "-"}% · Status: {battery.status}</span>
                          <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => editBatteryAssetWorking(battery)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => deleteBatteryAssetWorking(battery.id)}>Löschen</button></div>
                        </div>;
                      })}
                      {!batteryAssets.length ? <p>Noch keine Akkus erfasst.</p> : null}
                    </div>

                    <div className="card" style={{ marginBottom: 18 }}>
                      <div className="sectionHead"><div><h3>Wartungsbuch</h3><p>Wartungen, Reparaturen, Propellerwechsel und nächste Wartung dokumentieren.</p></div><button type="button" className="secondary smallButton" onClick={exportMaintenancePdfWorking}>Wartungsbuch PDF</button></div>
                      <div className="profileGrid">
                        <label>Drohne<select value={maintenanceDraft.droneId || ""} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, droneId: e.target.value })}><option value="">Drohne wählen</option>{droneAssets.map((drone) => <option key={drone.id} value={drone.id}>{getDroneDisplayName(drone)}</option>)}</select></label>
                        <label>Datum<input type="date" value={maintenanceDraft.date || ""} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, date: e.target.value })} /></label>
                        <label>Wartungsart<select value={maintenanceDraft.type || "Sichtprüfung"} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, type: e.target.value })}>{MAINTENANCE_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                        <label>Kosten EUR<input value={maintenanceDraft.costs || ""} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, costs: e.target.value })} /></label>
                        <label>Nächste Wartung<input type="date" value={maintenanceDraft.nextMaintenance || ""} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, nextMaintenance: e.target.value })} /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={3} value={maintenanceDraft.description || ""} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, description: e.target.value })} /></label>
                        <label style={{ gridColumn: "1 / -1" }}>Notizen<textarea rows={2} value={maintenanceDraft.notes || ""} onChange={(e) => setMaintenanceDraft({ ...maintenanceDraft, notes: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveMaintenanceEntryWorking}>Wartung speichern</button><button type="button" className="secondary smallButton" onClick={() => setMaintenanceDraft(createEmptyMaintenanceEntry())}>Neu</button></div>
                    </div>

                    <div className="logbookList">
                      {maintenanceEntries.map((entry) => {
                        const drone = droneAssets.find((item) => String(item.id) === String(entry.droneId));
                        const tone = getMaintenanceTone(entry);
                        return <div key={entry.id} className="listitem">
                          <strong>{formatMailPdfGermanDate(entry.date)} · {getDroneDisplayName(drone)} · {entry.type} <Status status={tone}>{tone === "danger" ? "überfällig" : tone === "warning" ? "bald fällig" : "ok"}</Status></strong>
                          <span>{entry.description || "Keine Beschreibung"}</span>
                          <span>{entry.nextMaintenance ? `Nächste Wartung: ${formatMailPdfGermanDate(entry.nextMaintenance)}` : "Keine nächste Wartung eingetragen"}{entry.costs ? ` · Kosten: ${entry.costs} EUR` : ""}</span>
                          <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => editMaintenanceEntryWorking(entry)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => deleteMaintenanceEntryWorking(entry.id)}>Löschen</button></div>
                        </div>;
                      })}
                      {!maintenanceEntries.length ? <p>Noch keine Wartungen erfasst.</p> : null}
                    </div>
                  </div>
                ) : null}
                {adminCenterTab === "users" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>Rollen & Rechte Pro</h2>
                        <p>Benutzer, Rollen, Modulrechte und Zugriffsstatus zentral verwalten.</p>
                      </div>
                      <Status status={roleDashboardStats.locked ? "warning" : "good"}>{roleDashboardStats.total} Benutzer</Status>
                    </div>

                    <section className="ultimateDashboard" style={{ marginTop: "16px" }}>
                      <div className="dashCard"><strong>{roleDashboardStats.total}</strong><span>Benutzer gesamt</span></div>
                      <div className="dashCard"><strong>{roleDashboardStats.admins}</strong><span>Admins</span></div>
                      <div className="dashCard"><strong>{roleDashboardStats.pilots}</strong><span>Piloten</span></div>
                      <div className="dashCard"><strong>{roleDashboardStats.customers}</strong><span>Kunden</span></div>
                      <div className="dashCard"><strong>{roleDashboardStats.locked}</strong><span>Gesperrt</span></div>
                      <div className="dashCard"><strong>{roleDashboardStats.inactive}</strong><span>Inaktiv</span></div>
                    </section>

                    <div className="card" style={{ marginTop: 18 }}>
                      <div className="sectionHead">
                        <div><h3>Benutzer anlegen</h3><p>Lokale Benutzerverwaltung mit Rollen und Status. Server-Benutzer werden zusätzlich angezeigt.</p></div>
                        <button type="button" className="secondary smallButton" onClick={loadUsersWorking}>Server-Benutzer neu laden</button>
                      </div>
                      <div className="profileGrid">
                        <label>Name<input value={newUserForm.name} onChange={(e) => setNewUserForm({ ...newUserForm, name: e.target.value })} /></label>
                        <label>E-Mail<input type="email" value={newUserForm.email} onChange={(e) => setNewUserForm({ ...newUserForm, email: e.target.value })} /></label>
                        <label>Rolle<select value={newUserForm.role} onChange={(e) => setNewUserForm({ ...newUserForm, role: e.target.value })}>{ROLE_OPTIONS_PRO.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label>
                        <label>Start-Passwort / Hinweis<input type="password" value={newUserForm.password} onChange={(e) => setNewUserForm({ ...newUserForm, password: e.target.value })} /></label>
                      </div>
                      <div className="buttonRow">
                        <button type="button" className="primary smallButton" onClick={createLocalAccessUserWorking}>Lokal speichern</button>
                        <button type="button" className="secondary smallButton" onClick={createUserWorking}>Auf Server anlegen</button>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: 18 }}>
                      <div className="sectionHead"><div><h3>Benutzerliste</h3><p>Rolle und Status schnell ändern.</p></div><Status status="good">{filteredAccessUsers.length} Treffer</Status></div>
                      <div className="profileGrid">
                        <label>Suche<input value={roleSearch} onChange={(e) => setRoleSearch(e.target.value)} placeholder="Name, E-Mail, Rolle..." /></label>
                        <label>Rolle filtern<select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}><option value="Alle">Alle Rollen</option>{ROLE_OPTIONS_PRO.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label>
                      </div>
                      <div className="logbookList" style={{ marginTop: "18px" }}>
                        {filteredAccessUsers.length ? filteredAccessUsers.map((user) => (
                          <div key={user.id || user.email} className="listitem">
                            <strong>{user.name || "Ohne Name"} · {user.email || "ohne E-Mail"} <Status status={userStatusTone(user.status)}>{user.status}</Status></strong>
                            <span>Rolle: {getRoleLabel(user.role)} · Quelle: {user.source === "server" ? "Server" : "Lokal"} · Letzter Login: {user.lastLogin || "-"}</span>
                            <div className="buttonRow">
                              <select value={user.role} onChange={(e) => user.source === "server" ? updateUserRoleWorking(user.id, e.target.value) : updateLocalAccessUser(user.id, { role: e.target.value })}>{ROLE_OPTIONS_PRO.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select>
                              <select value={user.status} onChange={(e) => updateLocalAccessUser(user.id, { status: e.target.value })}><option>Aktiv</option><option>Inaktiv</option><option>Gesperrt</option></select>
                              {user.source === "server" ? <button type="button" className="secondary smallButton" onClick={() => toggleUserActiveWorking(user.id, user.status !== "Aktiv")}>{user.status === "Aktiv" ? "Server deaktivieren" : "Server aktivieren"}</button> : <button type="button" className="secondary smallButton" onClick={() => deleteLocalAccessUserWorking(user.id)}>Entfernen</button>}
                            </div>
                          </div>
                        )) : <p>Keine Benutzer gefunden.</p>}
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: 18 }}>
                      <div className="sectionHead">
                        <div><h3>Rechte-Matrix</h3><p>Modulrechte pro Rolle steuern. Diese Matrix bereitet die spätere harte Zugriffskontrolle vor.</p></div>
                        <button type="button" className="secondary smallButton" onClick={resetRolePermissionsWorking}>Standard wiederherstellen</button>
                      </div>
                      <div className="profileGrid">
                        <label>Rolle auswählen<select value={selectedPermissionRole} onChange={(e) => setSelectedPermissionRole(e.target.value)}>{ROLE_OPTIONS_PRO.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label>
                      </div>
                      <div style={{ overflowX: "auto", marginTop: 14 }}>
                        <table className="dataTable" style={{ minWidth: 760 }}>
                          <thead><tr><th>Modul</th>{ROLE_RIGHT_KEYS.map((right) => <th key={right}>{ROLE_RIGHT_LABELS[right]}</th>)}</tr></thead>
                          <tbody>
                            {ROLE_MODULES.map((module) => (
                              <tr key={module.id}>
                                <td><strong>{module.label}</strong></td>
                                {ROLE_RIGHT_KEYS.map((right) => {
                                  const checked = Boolean(rolePermissionMatrix?.[selectedPermissionRole]?.[module.id]?.[right]);
                                  return <td key={right}><label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={checked} onChange={() => togglePermissionWorking(selectedPermissionRole, module.id, right)} /> {checked ? "Ja" : "Nein"}</label></td>;
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: 18 }}>
                      <div className="sectionHead"><div><h3>Audit-Log & Security-Vorbereitung</h3><p>Vorbereitung für Security Pro, Login-Historie, 2FA und Session-Verwaltung.</p></div><Status status="good">{auditLog.length} Einträge</Status></div>
                      <div className="logbookList">
                        {(auditLog || []).slice(0, 12).map((entry) => <div key={entry.id} className="listitem"><strong>{entry.createdAt || "-"} · {entry.action}</strong><span>{JSON.stringify(entry.details || {})}</span></div>)}
                        {!auditLog.length ? <p>Noch keine Audit-Log-Einträge vorhanden.</p> : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "business" ? (
                  <div>
                    <div className="sectionHead">
                      <div>
                        <h2>Business-Dashboard & Jahresnachweis</h2>
                        <p>Flugstatistik, Behördenkontrollen, Wartungen, Akkus, Dokumentenstatus und Betriebsbuch-PDF.</p>
                      </div>
                      <Status status={businessDashboardStats.documentsExpired || businessDashboardStats.maintenanceDue || businessDashboardStats.batteryCritical ? "warning" : "good"}>
                        {businessDashboardStats.totalFlights} Flüge · {businessDashboardStats.totalTime}
                      </Status>
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                      <Metric icon={Plane} title="Flugstatistik" value={businessDashboardStats.totalFlights} text={`${businessDashboardStats.flightsThisYear} dieses Jahr · ${businessDashboardStats.flightsThisMonth} diesen Monat · ${businessDashboardStats.flightsThisWeek} diese Woche`} />
                      <Metric icon={Gauge} title="Flugstunden" value={businessDashboardStats.totalTime} text={`Ø ${businessDashboardStats.averageFlightTime} · ${businessDashboardStats.activeDrones} aktive Drohnen`} />
                      <Metric icon={ShieldCheck} title="Behördenkontrollen" value={businessDashboardStats.authorityControls} text={`Polizei ${businessDashboardStats.authorityPolice} · Ordnungsamt ${businessDashboardStats.authorityOffice} · LBA ${businessDashboardStats.authorityLba}`} tone={businessDashboardStats.authorityControls ? "warning" : ""} />
                      <Metric icon={BatteryCharging} title="Akkus" value={businessDashboardStats.batteries} text={`${businessDashboardStats.batteryCritical} kritisch · Ø ${businessDashboardStats.averageCycles} Ladezyklen`} tone={businessDashboardStats.batteryCritical ? "warning" : ""} />
                      <Metric icon={Bell} title="Wartungen" value={businessDashboardStats.maintenanceTotal} text={`${businessDashboardStats.maintenanceDue} fällig · ${businessDashboardStats.maintenanceCosts.toFixed(2)} € Kosten`} tone={businessDashboardStats.maintenanceDue ? "warning" : ""} />
                      <Metric icon={Download} title="Dokumente" value={businessDashboardStats.documents} text={`${businessDashboardStats.documentsExpiring} bald ablaufend · ${businessDashboardStats.documentsExpired} abgelaufen`} tone={businessDashboardStats.documentsExpired ? "danger" : businessDashboardStats.documentsExpiring ? "warning" : ""} />
                    </div>

                    <div className="wideGrid" style={{ gridTemplateColumns: "minmax(280px,1fr) minmax(280px,1fr)", marginTop: 18 }}>
                      <div className="card">
                        <h3>Flüge pro Monat</h3>
                        <div className="logbookList">
                          {businessDashboardStats.months.map((month) => (
                            <div key={month.label} className="listitem">
                              <strong>{month.label}</strong>
                              <span>{month.flights} Flug/Flüge · {formatTotalFlightTime(month.minutes)}</span>
                              <div style={{ height: 8, borderRadius: 999, background: "#e2e8f0", overflow: "hidden" }}>
                                <div style={{ width: `${Math.min(100, month.flights * 10)}%`, height: "100%", background: adminAccentColor }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="card">
                        <h3>Flüge pro Drohne</h3>
                        <div className="logbookList">
                          {businessDashboardStats.flightsByDrone.length ? businessDashboardStats.flightsByDrone.map((item) => (
                            <div key={item.drone} className="listitem">
                              <strong>{item.drone}</strong>
                              <span>{item.flights} Flug/Flüge · {item.totalTime}</span>
                            </div>
                          )) : <p>Noch keine Drohnen-Flugdaten vorhanden.</p>}
                        </div>
                      </div>
                    </div>

                    <div className="card" style={{ marginTop: 18 }}>
                      <div className="sectionHead">
                        <div>
                          <h3>Jahresnachweis / Drohnenbetriebsbuch <small style={{ color: "#0ea5e9" }}></small></h3>
                          <p>Erstellt ein PDF mit Flügen, Flugstunden, Behördenkontrollen, Wartungen, Dokumentenstatus und Akkuübersicht.</p>
                        </div>
                        <Status status="good">{annualFlightRows.length} Flüge {annualReportYear}</Status>
                      </div>
                      <div className="profileGrid">
                        <label>
                          Jahr auswählen
                          <select value={annualReportYear} onChange={(event) => setAnnualReportYear(event.target.value)}>
                            {annualReportYears.map((year) => <option key={year} value={year}>{year}</option>)}
                          </select>
                        </label>
                        <label>
                          Logo für Jahresbericht hochladen (PDF-Kopfzeile)
                          <input type="file" accept="image/*" onChange={handleAnnualReportLogoUploadWorking} />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
                          <input
                            type="checkbox"
                            checked={annualReportLogoEveryPage}
                            onChange={(event) => setAnnualReportLogoEveryPage(event.target.checked)}
                            style={{ width: 18, height: 18 }}
                          />
                          Logo auch in PDF-Kopfzeile anzeigen
                        </label>
                        <div className="listitem">
                          <strong>Flugzeit {annualReportYear}</strong>
                          <span>{formatTotalFlightTime(annualFlightRows.reduce((sum, row) => sum + Number(row.durationMinutes || 0), 0))}</span>
                        </div>
                        <div className="listitem" style={{ gridColumn: "1 / -1", alignItems: "stretch" }}>
                          <strong>Logo-Vorschau</strong>
                          {annualReportLogo ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                              <img src={annualReportLogo} alt="Jahresbericht Logo" style={{ maxHeight: 70, maxWidth: 220, objectFit: "contain", border: "1px solid #cbd5e1", borderRadius: 12, padding: 8, background: "white" }} />
                              <button type="button" className="secondary smallButton" onClick={() => setAnnualReportLogo("")}>Logo entfernen</button>
                            </div>
                          ) : (
                            <span>Kein eigenes Logo hinterlegt. Es wird automatisch /logo_neu.png verwendet.</span>
                          )}
                        </div>
                        <div className="listitem" style={{ gridColumn: "1 / -1", alignItems: "stretch" }}>
                          <strong>Digitale Unterschrift</strong>
                          <label style={{ marginTop: 8 }}>
                            Unterschrift hochladen
                            <input type="file" accept="image/*" onChange={handleDigitalSignatureUploadWorking} />
                          </label>
                          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
                            {digitalSignature ? (
                              <>
                                <img src={digitalSignature} alt="Digitale Unterschrift" style={{ maxHeight: 76, maxWidth: 240, objectFit: "contain", border: "1px solid #cbd5e1", borderRadius: 12, padding: 8, background: "white" }} />
                                <button type="button" className="secondary smallButton" onClick={() => setDigitalSignature("")}>Unterschrift entfernen</button>
                              </>
                            ) : (
                              <span>Keine Unterschrift hinterlegt.</span>
                            )}
                          </div>
                          <div className="profileGrid" style={{ marginTop: 12 }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
                              <input type="checkbox" checked={signatureAnnualReport} onChange={(event) => setSignatureAnnualReport(event.target.checked)} style={{ width: 18, height: 18 }} />
                              Auf Jahresnachweis / Drohnenbetriebsbuch anzeigen
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
                              <input type="checkbox" checked={signatureFlightReports} onChange={(event) => setSignatureFlightReports(event.target.checked)} style={{ width: 18, height: 18 }} />
                              Auf Fluganmeldungen anzeigen
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800 }}>
                              <input type="checkbox" checked={signatureAuthorityReports} onChange={(event) => setSignatureAuthorityReports(event.target.checked)} style={{ width: 18, height: 18 }} />
                              Auf Behörden-PDFs anzeigen
                            </label>
                          </div>
                        </div>
                      </div>
                      <div className="buttonRow" style={{ marginTop: 14 }}>
                        <button type="button" className="primary smallButton" onClick={generateAnnualOperationsPdfWorking}>Jahresnachweis PDF erstellen</button>
                        <button type="button" className="secondary smallButton" onClick={exportAnnualFlightsCsvWorking}>Jahres-Flüge CSV</button>
                        <button type="button" className="secondary smallButton" onClick={exportMaintenanceCsvWorking}>Wartungen CSV</button>
                        <button type="button" className="secondary smallButton" onClick={exportBatteryCsvWorking}>Akkus CSV</button>
                        <button type="button" className="secondary smallButton" onClick={exportAuthorityControlsCsvWorking}>Behördenkontrollen CSV</button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {adminCenterTab === "exports" ? <div><div className="sectionHead"><div><h2>Export Center</h2><p>Flugbuch, abgeschlossene Flüge und Monatsberichte exportieren.</p></div><Status status="good">Export aktiv</Status></div><div className="wideGrid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}><div className="card"><h3>Flugbuch</h3><p>Alle Einträge als CSV.</p><button type="button" className="secondary smallButton" onClick={exportCsvWorking}>Flugbuch CSV</button></div><div className="card"><h3>Abgeschlossene Flüge</h3><p>Excel-kompatible CSV.</p><button type="button" className="secondary smallButton" onClick={exportCompletedFlightsCsvWorking}>Erfolgte Flüge CSV</button></div><div className="card"><h3>Jahresnachweis</h3><p>Betriebsbuch-PDF und Statistik.</p><button type="button" className="secondary smallButton" onClick={() => setAdminCenterTab("business")}>Zum Business-Dashboard</button></div><div className="card"><h3>Wartungen</h3><p>Wartungsbuch als CSV.</p><button type="button" className="secondary smallButton" onClick={exportMaintenanceCsvWorking}>Wartungen CSV</button></div><div className="card"><h3>Akkus</h3><p>Akkuverwaltung als CSV.</p><button type="button" className="secondary smallButton" onClick={exportBatteryCsvWorking}>Akkus CSV</button></div><div className="card"><h3>Behördenkontrollen</h3><p>Kontrollen als CSV.</p><button type="button" className="secondary smallButton" onClick={exportAuthorityControlsCsvWorking}>Kontrollen CSV</button></div><div className="card"><h3>PDF Center</h3><p>PDFs direkt in den Flugdetails erstellen.</p><button type="button" className="secondary smallButton" onClick={() => setAdminCenterTab("flights")}>Zu Flügen</button></div></div></div> : null}


                {adminCenterTab === "aiCopilot" ? (
                  <FlyMonitorAICopilotPro />
                ) : null}

                {adminCenterTab === "commercialRelease" ? (
                  <FlyMonitorCommercialReleasePro />
                ) : null}

                {adminCenterTab === "releaseCandidate" ? (
                  <FlyMonitorReleaseCandidateRC1Pro />
                ) : null}

                {adminCenterTab === "bugfixStabilization" ? (
                  <FlyMonitorBugfixStabilizationPro />
                ) : null}

                {adminCenterTab === "productionDeployment" ? (
                  <FlyMonitorProductionDeploymentPro />
                ) : null}

                {adminCenterTab === "finalRelease" ? (
                  <FinalReleasePackagePro />
                ) : null}

                {adminCenterTab === "system" ? (
  <div>
    <div className="sectionHead">
      <div>
        <h2>System</h2>
        <p>Backup, Audit-Log, Session und Login-Schutz.</p>
      </div>
      <Status status="good">Session aktiv</Status>
    </div>

    <div
      className="wideGrid"
      style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}
    >
      <div className="card">
        <h3>Session</h3>
        <p>Auto-Logout nach Inaktivität und Login-Sperre nach Fehlversuchen.</p>
      </div>

      <div className="card">
        <h3>Backup</h3>
        <p>Server-Backup für MySQL/JSON.</p>
        <button
          type="button"
          className="secondary smallButton"
          onClick={runBackupWorking}
        >
          Backup jetzt erstellen
        </button>
        {backupNotice ? <p><strong>{backupNotice}</strong></p> : null}
      </div>

      <div className="card">
        <h3>Audit-Log</h3>
        <p>{auditLog.length} Einträge geladen.</p>
        <button
          type="button"
          className="secondary smallButton"
          onClick={loadAuditLogWorking}
        >
          Audit neu laden
        </button>
      </div>

      <div className="card">
        <h3>🔔 Benachrichtigungen</h3>
        <p>
          Status:{" "}
          {"Notification" in window
            ? Notification.permission === "granted"
              ? "aktiviert"
              : Notification.permission === "denied"
                ? "blockiert"
                : "nicht aktiviert"
            : "nicht unterstützt"}
        </p>
        <button
          type="button"
          className="secondary smallButton"
          onClick={async () => {
            if (!("Notification" in window)) {
              alert("Dieser Browser unterstützt keine Benachrichtigungen.");
              return;
            }

            const permission = await Notification.requestPermission();

            if (permission === "granted") {
              new Notification("FlyMonitor", {
                body: "Benachrichtigungen wurden erfolgreich aktiviert.",
                icon: "/logo_neu.png",
              });
            } else {
              alert("Benachrichtigungen wurden nicht erlaubt.");
            }
          }}
        >
          Benachrichtigungen aktivieren
        </button>
      </div>

      <div className="card">
        <h3>⚠ Wetterwarnungen</h3>
        <p>Warnungen bei Wind, Böen und schlechtem Flugwetter.</p>
        <button
          type="button"
          className="secondary smallButton"
          onClick={async () => {
            if (!("Notification" in window)) {
              localStorage.setItem("flymonitor_weather_notifications", "1");
              alert("Wetterwarnungen wurden aktiviert. Browser-Benachrichtigungen werden nicht unterstützt.");
              return;
            }

            const permission = await Notification.requestPermission();
            localStorage.setItem("flymonitor_weather_notifications", "1");

            if (permission === "granted") {
              new Notification("FlyMonitor Wetterwarnungen aktiviert", {
                body: "Sie erhalten künftig Wetterwarnungen.",
                icon: "/logo_neu.png",
              });
            } else {
              alert("Wetterwarnungen wurden aktiviert. Benachrichtigungen sind im Browser noch nicht erlaubt.");
            }
          }}
        >
          Wetterwarnungen aktivieren
        </button>
        <button
  type="button"
  className="secondary smallButton"
  style={{ marginTop: 10 }}
  onClick={() => {
    alert("Test-Warnung ausgelöst");

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("⚠ FlyMonitor Wetterwarnung", {
        body: "Dies ist eine Test-Warnung.",
        icon: "/logo_neu.png",
      });
    }
  }}
>
  Test-Warnung senden
</button>
      </div>
    </div>

    <div className="card" style={{ marginTop: "18px" }}>
      <h3>Letzte Admin-Aktivitäten</h3>
      <div className="logbookList">
        {auditLog.slice(0, 30).map((item, index) => (
          <div
            key={item.id || item.created_at || item.time || index}
            className="listitem"
          >
            <strong>{item.action || "Aktion"}</strong>
            <span>
              {item.created_at || item.createdAt || item.time || ""} ·{" "}
              {item.email || item.role || "System"}
            </span>
            <small>
              {typeof item.details === "string"
                ? item.details
                : JSON.stringify(item.details || item.details_json || {})}
            </small>
          </div>
        ))}
        {!auditLog.length ? <p>Noch keine Audit-Einträge geladen.</p> : null}
      </div>
    </div>
  </div>
) : null}


                {emailDialogOpen ? (
                  <div
                    className="modalBackdrop"
                    style={{
                      position: "fixed",
                      inset: 0,
                      zIndex: 99999,
                      background: "rgba(15, 23, 42, 0.62)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "18px",
                    }}
                  >
                    <div className="card" style={{ maxWidth: 820, width: "94vw", maxHeight: "88vh", overflowY: "auto" }}>
                      <div className="sectionHead">
                        <div>
                          <h2>Empfänger auswählen</h2>
                          <p>{emailEntry?.registrationNumber || "Fluganmeldung"} per E-Mail senden</p>
                        </div>
                        <Status status={emailRecipientSelection.length ? "good" : "warning"}>
                          {emailRecipientSelection.length} ausgewählt
                        </Status>
                      </div>

                      <div className="profileGrid">
                        <label style={{ gridColumn: "1 / -1" }}>
                          Empfänger suchen
                          <input
                            value={emailRecipientSearch}
                            onChange={(e) => setEmailRecipientSearch(e.target.value)}
                            placeholder="Name, Kategorie oder E-Mail suchen..."
                          />
                        </label>
                      </div>

                      <div className="buttonRow" style={{ marginTop: 10 }}>
                        <button
                          type="button"
                          className="secondary smallButton"
                          onClick={() => setEmailRecipientSelection(savedEmailRecipients.map((recipient) => recipient.id))}
                        >
                          Alle auswählen
                        </button>
                        <button
                          type="button"
                          className="secondary smallButton"
                          onClick={() => setEmailRecipientSelection([])}
                        >
                          Auswahl leeren
                        </button>
                        <button
                          type="button"
                          className="secondary smallButton"
                          onClick={() => {
                            setEmailDialogOpen(false);
                            setAdminCenterTab("authorities");
                          }}
                        >
                          Empfänger verwalten
                        </button>
                      </div>

                      <div className="logbookList" style={{ maxHeight: 360, overflowY: "auto", marginTop: 14 }}>
                        {savedEmailRecipients
                          .filter((recipient) =>
                            `${recipient.name || ""} ${recipient.category || ""} ${recipient.subcategory || ""} ${recipient.responsibility || ""} ${(recipient.emails || []).join(" ")}`
                              .toLowerCase()
                              .includes(emailRecipientSearch.toLowerCase())
                          )
                          .map((recipient) => (
                            <label key={recipient.id} className="listitem" style={{ cursor: "pointer" }}>
                              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                <input
                                  type="checkbox"
                                  checked={emailRecipientSelection.includes(recipient.id)}
                                  onChange={(e) => {
                                    setEmailRecipientSelection((prev) =>
                                      e.target.checked
                                        ? Array.from(new Set([...prev, recipient.id]))
                                        : prev.filter((id) => id !== recipient.id)
                                    );
                                  }}
                                  style={{ width: 18, height: 18, marginTop: 3 }}
                                />
                                <div>
                                  <strong>{recipient.name || "Empfänger"}</strong>
                                  <span>
                                    {recipient.category || "Allgemein"}
                                    {recipient.subcategory ? ` · ${recipient.subcategory}` : ""}
                                    {recipient.responsibility ? ` · ${recipient.responsibility}` : ""}
                                  </span>
                                  <span>{(recipient.emails || []).join(", ")}</span>
                                </div>
                              </div>
                            </label>
                          ))}
                        {!savedEmailRecipients.length ? <p>Noch keine Empfänger gespeichert. Bitte im Bereich „Behörden“ Empfänger anlegen oder „SH-Behörden laden“ klicken.</p> : null}
                      </div>

                      <label style={{ display: "block", marginTop: 14 }}>
                        Zusätzliche Empfänger
                        <input
                          value={adminEmail}
                          onChange={(e) => setAdminEmail(e.target.value)}
                          placeholder="zusatz@example.de; weitere@example.de"
                        />
                      </label>

                      <div className="card" style={{ marginTop: 14, background: "#f8fafc" }}>
                        <div className="sectionHead">
                          <div>
                            <h3>PDF-Dokumente anhängen</h3>
                            <p>Wähle hinterlegte PDFs aus, die zusätzlich zur Fluganmeldung mitgesendet werden.</p>
                          </div>
                          <Status status={selectedMailPdfDocumentIds.length ? "good" : "warning"}>
                            {selectedMailPdfDocumentIds.length} PDF(s)
                          </Status>
                        </div>

                        <label>
                          Weitere PDF-Dokumente hinterlegen
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            multiple
                            onChange={(event) => {
                              addMailPdfDocumentsWorking(event.target.files);
                              event.target.value = "";
                            }}
                          />
                        </label>

                        <div className="logbookList" style={{ maxHeight: 220, overflowY: "auto", marginTop: 12 }}>
                          {mailPdfDocuments.map((document) => (
                            <label key={document.id} className="listitem" style={{ cursor: "pointer" }}>
                              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                <input
                                  type="checkbox"
                                  checked={selectedMailPdfDocumentIds.map(String).includes(String(document.id))}
                                  onChange={(event) => toggleMailPdfDocumentSelection(document.id, event.target.checked)}
                                  style={{ width: 18, height: 18, marginTop: 3 }}
                                />
                                <div>
                                  <strong>{document.title || document.name || "PDF-Dokument"}</strong>
                                  <span>{document.name || "PDF-Datei"}</span>
                                  <span>{formatMailPdfDocumentLine(normalizeMailPdfDocument(document))}</span>
                                </div>
                              </div>
                            </label>
                          ))}
                          {!mailPdfDocuments.length ? <p>Noch keine PDF-Dokumente hinterlegt.</p> : null}
                        </div>

                        {mailPdfDocuments.length ? (
                          <div className="buttonRow" style={{ marginTop: 10 }}>
                            <button type="button" className="secondary smallButton" onClick={() => setSelectedMailPdfDocumentIds(mailPdfDocuments.map((document) => document.id))}>Alle PDFs auswählen</button>
                            <button type="button" className="secondary smallButton" onClick={() => setSelectedMailPdfDocumentIds(getAutoAttachMailPdfDocumentIds())}>Auto-PDFs auswählen</button>
                            <button type="button" className="secondary smallButton" onClick={() => setSelectedMailPdfDocumentIds([])}>PDF-Auswahl leeren</button>
                          </div>
                        ) : null}
                      </div>

                      <div className="buttonRow" style={{ marginTop: 16 }}>
                        <button type="button" className="secondary smallButton" onClick={() => setEmailDialogOpen(false)}>
                          Abbrechen
                        </button>
                        <button type="button" className="primary smallButton" onClick={sendSelectedFlightEmailWorking}>
                          Per E-Mail senden
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

              </main>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (activePage === "registrationForm" && adminUnlocked) {
    return (
      <div className={appClassName} style={templateColorStyle}>
        <div className="page">
          <nav className="nav" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"18px",flexWrap:"wrap"}}>
            <a
              href="https://www.flymonitor.de/"
              className="brand"
              style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}
            >
              <div className="brandicon">
                <img src="/logo_neu.png" alt="PX Logo" style={{ width: "200px", height: "84px", objectFit: "contain" }} />
              </div>
              <div>
                <strong>flymonitor.de</strong>
                <span>Drohnenfluganmeldung</span>
              </div>
            </a>

            <div className="menuBar">
              <button type="button" onClick={() => setActivePage("home")}>Zur Startseite</button>
              <button type="button" onClick={() => { window.location.hash = "behoerde"; setActivePage("authority"); }}>Behörde</button>
            </div>

            <AdminMenuControls showSource />
          </nav>

          <NewsTickerStyles />

        {adminUnlocked ? (
          <div
            className="card"
            style={{
              margin: "18px 0",
              border: "1px solid rgba(0,178,226,.28)",
              background: "linear-gradient(135deg,rgba(0,178,226,.10),rgba(2,27,51,.06))",
            }}
          >
            <div className="sectionHead">
              <div>
                <h2 style={{ marginBottom: 4 }}>Neue Fluganmeldung</h2>
                <p style={{ margin: 0 }}>
                  Das Formular ist geöffnet. Vorgangsnummer und Behörden-PIN können automatisch erzeugt oder manuell eingetragen werden.
                </p>
              </div>
              <div className="buttonRow">
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => {
                    setActivePage("home");
                    setAdminCenterTab("flights");
                    if (typeof window !== "undefined") {
                      window.location.hash = "";
                      setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
                    }
                  }}
                >
                  Zurück ins Admin Center
                </button>
              </div>
            </div>
          </div>
        ) : null}


          <section className="logbookWide">
            <div className="card">
              <div className="sectionHead">
                <div>
                  <h1>{editingLogId ? "Fluganmeldung bearbeiten" : "Drohnenfluganmeldung"}</h1>
                  <p>{editingLogId ? "Admin-Bearbeitungsmodus: Bestehende Fluganmeldung anpassen und speichern." : "Bitte die geplanten Flugdaten vollständig eintragen und anschließend speichern."}</p>
                </div>
                <Status status={flightReportForm.registrationNumber ? "good" : "warning"}>
                  {flightReportForm.registrationNumber || "Vorgangsnummer wird erzeugt"}
                </Status>
              </div>                <div className="card" style={{ marginBottom: "18px" }}>
                  <div className="sectionHead">
                    <div>
                      <h2>DJI FlightRecord importieren</h2>
                      <p>DJI Air 3S FlightRecord-Dateien hochladen und automatisch übernehmen.</p>
                    </div>
                    <Status status={djiImportReports.length ? "good" : "warning"}>
                      {djiImportReports.length} Import(e)
                    </Status>
                  </div>

                  <div className="profileGrid">
                    <label>
                      DJI FlightRecord Upload
                      <input
                        type="file"
                        accept=".txt,.csv,.log,text/plain"
                        multiple
                        onChange={importDjiFlightRecordsWorking}
                      />
                    </label>
                  </div>

                  {djiImportReports.length ? (
                    <div className="logbookList" style={{ marginTop: "14px", maxHeight: "260px", overflowY: "auto" }}>
                      {djiImportReports.map((report, index) => (
                        <div key={`${report.fileName}-${index}`} className="listitem">
                          <strong>{report.fileName}</strong>
                          <span>
                            {report.date}
                            {report.startTime ? ` · ${report.startTime}` : ""}
                            {report.endTime ? `–${report.endTime}` : ""}
                          </span>
                          <span>
                            Drohne: {report.drone || "DJI Air 3S"} · Höhe: {report.maxHeight || "-"} m · Strecke: {report.distanceKm || "-"} km
                          </span>
                          <span>{report.routeSummary}</span>
                          <div className="buttonRow">
                            <button
                              type="button"
                              className="secondary smallButton"
                              onClick={() => applyDjiImportToFlightReportWorking(report)}
                            >
                              In Fluganmeldung übernehmen
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>



              <FlightRegistrationEditFields
                data={flightReportForm}
                setData={setFlightReportForm}
                mapFavoritePlaces={mapFavoritePlaces}
                droneAssets={droneAssets}
                usedAuthorityPins={getAllKnownAuthorityPins([...logbook, ...completedFlights])}
                existingFlightEntries={[...logbook, ...completedFlights]}
              />

              <div className="buttonRow" style={{ marginTop: "16px" }}>
                <button
                  type="button"
                  className="primary smallButton"
                  onClick={saveActualFlightReportWorking}
                >
                  {editingLogId ? "Änderungen speichern" : "Fluganmeldung speichern"}
                </button>

                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => {
                    setEditingLogId(null);
                    setEditLogEntry({});
                    setFlightReportForm({ ...emptyFlightReport });
                    setActivePage("home");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  Abbrechen
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }


if (activePage === "authority") {
  return (
    <div className={appClassName} style={templateColorStyle}>
      <div className="page">
        <nav className="nav" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"18px",flexWrap:"wrap"}}>
          <a
            href="https://www.flymonitor.de/"
            className="brand"
            style={{
              textDecoration: "none",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            <div className="brandicon">
              <img
                src="/logo_neu.png"
                alt="PX Logo"
                style={{
                  width: "200px",
                  height: "84px",
                  objectFit: "contain",
                }}
              />
            </div>

            <div>
              <strong>flymonitor.de</strong>
              <span>OpenStreetMap · Open-Meteo · OpenSky</span>
            </div>
          </a>

            <div className="menuBar">
              
              
              

              {authorityReport ? (
                <button
                  type="button"
                  style={LOGOUT_BUTTON_STYLE}
                  onClick={() => {
                    setAuthorityQuery("");
                    setAuthorityReport(null);
                    setAuthorityError("");
                    window.location.hash = "behoerde";
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  Logout
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    window.location.hash = "behoerde";
                    setActivePage("authority");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  Behörde
                </button>
              )}
            </div>

<AdminMenuControls showSource />
          </nav>

          <section className="logbookWide">
            <div className="card">
              <div className="sectionHead">
                <div>
                  <h1>UAS-Fluganmeldung</h1>
                  <p>Bitte 6-stellige Behörden-PIN eingeben. Danach wird die UAS-Fluganmeldung angezeigt.</p>
                </div>
                <Status status={authorityReport ? "good" : "warning"}>
                  {authorityReport ? "PIN akzeptiert" : "PIN erforderlich"}
                </Status>
              </div>

              <div className="profileGrid">
                <label>
                  Behörden-PIN
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={authorityQuery}
                    onChange={(e) => setAuthorityQuery(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    onKeyDown={(e) => e.key === "Enter" && findAuthorityReport()}
                    placeholder="6-stellige PIN"
                  />
                </label>
              </div>

              {authorityError ? (
                <p style={{ color: "#b91c1c", fontWeight: 800, marginTop: "12px" }}>
                  {authorityError}
                </p>
              ) : null}

              <div className="buttonRow" style={{ marginTop: "14px" }}>
                <button type="button" className="primary smallButton" onClick={findAuthorityReport}>
                  UAS-Fluganmeldung per PIN anzeigen
                </button>
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => {
                    setAuthorityQuery("");
                    setAuthorityReport(null);
                    setAuthorityError("");
                  }}
                >
                  Zurücksetzen
                </button>
              </div>

              <div className="card" style={{ marginTop: "14px" }}>
                <h2>Neue Behörden-PIN anfordern</h2>
                <p>Falls die PIN fehlt oder abgelaufen ist, kann eine neue 6-stellige PIN per E-Mail gesendet werden.</p>
                <div className="profileGrid">
                  <label>E-Mail für neue PIN
                    <input
                      type="email"
                      value={authorityPinRequestEmail}
                      onChange={(e) => setAuthorityPinRequestEmail(e.target.value)}
                      placeholder="empfaenger@example.de"
                    />
                  </label>
                </div>
                <button type="button" className="secondary smallButton" style={{ marginTop: "12px" }} onClick={requestNewAuthorityPinWorking}>
                  Neue PIN per E-Mail senden
                </button>
              </div>

              {authorityReport ? (
                <div className="card" style={{ marginTop: "14px" }}>
                  <h2>UAS Fluganmeldung</h2>

                  <div className="profileGrid">
                    <ReadOnlyValue label="Vorgangsnummer" value={authorityReport.registrationNumber} />
                    <ReadOnlyValue label="Behörden-PIN" value={authorityReport.authorityPin} />
                    <ReadOnlyValue label="Datum" value={formatGermanDate(authorityReport.date)} />
                    <ReadOnlyValue
                      label="Zeit"
                      value={`${authorityReport.startTime || ""}${authorityReport.endTime ? " – " + authorityReport.endTime : ""}`}
                    />

                    <div className="listitem">
                      <strong>Status</strong>
                      <FlightStatusBadge value={authorityReport.status || "Geplant"} />
                    </div>
                    <ReadOnlyValue label="Aktualisiert am" value={formatFlightStatusTimestamp(authorityReport.updatedAt)} />
                    {authorityReport.status === "Storno" ? (
                      <ReadOnlyValue label="Storno-Begründung" value={authorityReport.cancellationReason} />
                    ) : null}
                    {authorityReport.status === "Verschiebung" ? (
                      <ReadOnlyValue
                        label="Neuer Termin"
                        value={`${formatGermanDate(authorityReport.postponementDate)} ${authorityReport.postponementStartTime || ""}${authorityReport.postponementEndTime ? " – " + authorityReport.postponementEndTime : ""}`}
                      />
                    ) : null}

                    <ReadOnlyValue label="Firma" value={authorityReport.company} />
                    <ReadOnlyValue label="Ansprechpartner" value={authorityReport.contactName} />
                    <ReadOnlyValue label="E-Mail" value={authorityReport.email} />

                    <ReadOnlyValue label="Telefon" value={authorityReport.phone} />
                    <ReadOnlyValue label="Straße" value={authorityReport.street} />
                    <ReadOnlyValue label="PLZ / Ort" value={`${authorityReport.zip || ""} ${authorityReport.city || ""}`} />

                    <ReadOnlyValue label="Betreiber-ID" value={authorityReport.operatorId} />
                    <ReadOnlyValue label="Pilot" value={authorityReport.pilot} />
                    <ReadOnlyValue label="Spotter / Beobachter" value={(authorityReport.spotterAvailable || "Nein") === "Ja" ? (authorityReport.spotterName || "Ja") : "Nein"} />
                    {(authorityReport.spotterAvailable || "Nein") === "Ja" ? (
                      <>
                        <ReadOnlyValue label="Telefon Beobachter" value={authorityReport.spotterPhone} />
                        <ReadOnlyValue label="Kommunikationsmittel" value={authorityReport.communicationMethod} />
                      </>
                    ) : null}
                    <ReadOnlyValue label="Ausnahmegenehmigung" value={authorityReport.exceptionPermit} />
                    <ReadOnlyValue label="Gültigkeit Ausnahmegenehmigung" value={formatGermanDate(authorityReport.exceptionPermitValidUntil)} />
                    <ReadOnlyValue label="Kompetenznachweis / Lizenz" value={authorityReport.license} />
                    <ReadOnlyValue label="Gültigkeit Kompetenznachweis / Lizenz" value={formatGermanDate(authorityReport.licenseValidUntil)} />

                    <ReadOnlyValue label="Versicherung" value={authorityReport.insurance} />
                    <ReadOnlyValue label="Versicherungsnummer" value={authorityReport.insuranceNumber} />
                    <ReadOnlyValue label="Gültigkeit Versicherung" value={formatGermanDate(authorityReport.insuranceValidUntil)} />
                    <ReadOnlyValue label="Fluggebiet / Einsatzstelle" value={authorityReport.flightArea || authorityReport.city} />

                    <ReadOnlyValue label="Koordinaten" value={authorityReport.coordinates} />
                    <ReadOnlyValue label="Max. Flughöhe" value={authorityReport.maxHeight ? `${authorityReport.maxHeight} m` : ""} />
                    <ReadOnlyValue label="Drohnenmodell" value={authorityReport.drone} />

                    <ReadOnlyValue label="Gewicht" value={authorityReport.weight ? `${authorityReport.weight} g` : ""} />
                    <ReadOnlyValue label="Zweck des Fluges" value={authorityReport.purpose} />
                    <ReadOnlyValue label="Strecke" value={cleanManualDistanceKm(authorityReport.distanceKm) ? `${cleanManualDistanceKm(authorityReport.distanceKm)} km` : ""} />

                    <ReadOnlyValue
                      label="Akku"
                      value={formatManualBattery(authorityReport.batteryStart, authorityReport.batteryEnd)}
                    />
                    <ReadOnlyValue label="Wetter" value={authorityReport.weather} />
                    <ReadOnlyValue label="Wind / Böen" value={(authorityReport.wind || authorityReport.gusts) ? `${authorityReport.wind || "-"} / ${authorityReport.gusts || "-"} km/h` : ""} />

                    <ReadOnlyValue label="Vorkommnisse" value={authorityReport.incidents || "Keine"} />
                    <ReadOnlyValue label="Sicherheitsvorkehrungen" value={authorityReport.safetyMeasures} />
                    <ReadOnlyValue label="Rechtliche Bestätigung" value={authorityReport.legalConfirm ? "Bestätigt" : "Nicht bestätigt"} />
                    <ReadOnlyValue label="Bestätigungstext" value={authorityReport.legalConfirmationText || LEGAL_CONFIRMATION_TEXT} />
                    <ReadOnlyValue label="Bemerkungen / Notizen" value={authorityReport.notes} />
                  </div>

                  {(() => {
                    const actualFlight = authorityReport.completedFlight || authorityReport;
                    const showActualFlight = Boolean(
                      actualFlight && (
                        actualFlight.completedAt ||
                        actualFlight.actualStartTime ||
                        actualFlight.actualEndTime ||
                        actualFlight.actualDistanceKm ||
                        actualFlight.distanceKm ||
                        actualFlight.actualBatteryStart ||
                        actualFlight.actualBatteryEnd ||
                        actualFlight.actualWeather ||
                        actualFlight.actualWind ||
                        actualFlight.actualGusts ||
                        actualFlight.maxHeight ||
                        actualFlight.maxDistance ||
                        actualFlight.temperature ||
                        actualFlight.authorityInspection ||
                        actualFlight.actualIncidents ||
                        actualFlight.actualNotes ||
                        String(actualFlight.status || "").toLowerCase() === "erfolgt"
                      )
                    );

                    return showActualFlight ? (
                    <div className="card" style={{ marginTop: "14px", background: "#f8fafc" }}>
                      <div className="sectionHead">
                        <div>
                          <h2>Tatsächlich abgeschlossener Flug</h2>
                          <p>Diese Angaben wurden nach dem Flug vom Admin aktualisiert</p>
                        </div>
                        <Status status="good">Erfolgt</Status>
                      </div>
                      <div className="profileGrid">
                        <ReadOnlyValue label="Vorgangsnummer" value={actualFlight.registrationNumber || authorityReport.registrationNumber} />
                        <ReadOnlyValue label="Behörden-PIN" value={actualFlight.authorityPin || authorityReport.authorityPin} />
                        <ReadOnlyValue label="Gespeichert" value={actualFlight.completedAt} />
                        <ReadOnlyValue label="Aktualisiert am" value={actualFlight.updatedAt || authorityReport.updatedAt} />
                        <ReadOnlyValue label="Tatsächliche Flugzeit" value={`${actualFlight.actualStartTime || actualFlight.startTime || "-"}${actualFlight.actualEndTime || actualFlight.endTime ? " – " + (actualFlight.actualEndTime || actualFlight.endTime) : ""}`} />
                        <ReadOnlyValue label="Spotter / Beobachter" value={(actualFlight.spotterAvailable || authorityReport.spotterAvailable || "Nein") === "Ja" ? (actualFlight.spotterName || authorityReport.spotterName || "Ja") : "Nein"} />
                        {(actualFlight.spotterAvailable || authorityReport.spotterAvailable || "Nein") === "Ja" ? (
                          <>
                            <ReadOnlyValue label="Telefon Beobachter" value={actualFlight.spotterPhone || authorityReport.spotterPhone} />
                            <ReadOnlyValue label="Kommunikationsmittel" value={actualFlight.communicationMethod || authorityReport.communicationMethod} />
                          </>
                        ) : null}
                        <ReadOnlyValue label="Geflogene Strecke" value={actualFlight.actualDistanceKm || actualFlight.distanceKm ? `${actualFlight.actualDistanceKm || actualFlight.distanceKm} km` : ""} />
                        <ReadOnlyValue label="Akkuverlauf" value={formatManualBattery(actualFlight.actualBatteryStart || actualFlight.batteryStart, actualFlight.actualBatteryEnd || actualFlight.batteryEnd)} />
                        <ReadOnlyValue label="Wetter am Flugtag" value={actualFlight.actualWeather || actualFlight.weather} />
                        <ReadOnlyValue label="Wind" value={actualFlight.actualWind || actualFlight.wind ? `${actualFlight.actualWind || actualFlight.wind} km/h` : ""} />
                        <ReadOnlyValue label="Böen" value={actualFlight.actualGusts || actualFlight.gusts ? `${actualFlight.actualGusts || actualFlight.gusts} km/h` : ""} />
                        <ReadOnlyValue label="Max. Flughöhe" value={actualFlight.maxHeight ? `${actualFlight.maxHeight} m` : ""} />
                        <ReadOnlyValue label="Max. Entfernung zum Piloten" value={actualFlight.maxDistance ? `${actualFlight.maxDistance} m` : ""} />
                        <ReadOnlyValue label="Temperatur" value={actualFlight.temperature ? `${actualFlight.temperature} °C` : ""} />
                        <ReadOnlyValue label="Behördenkontrolle" value={actualFlight.authorityInspection} />
                        {actualFlight.authorityInspection === "Ja" ? (
                          <>
                            <ReadOnlyValue label="Kontrollierende Behörde" value={actualFlight.authorityType} />
                            <ReadOnlyValue label="Dienststelle" value={actualFlight.authorityOffice} />
                            <ReadOnlyValue label="Kontrollergebnis" value={actualFlight.authorityResult} />
                            <ReadOnlyValue label="Kontrollzeitpunkt" value={formatFlightStatusTimestamp(actualFlight.authorityControlDate)} />
                          </>
                        ) : null}
                        <ReadOnlyValue label="Bemerkungen zur Behördenkontrolle" value={actualFlight.authorityInspectionNotes} />
                        <ReadOnlyValue label="Besondere Vorkommnisse" value={actualFlight.actualIncidents || actualFlight.incidents || "Keine"} />
                        <ReadOnlyValue label="Flugnotizen" value={actualFlight.actualNotes || actualFlight.notes} />
                        {actualFlight.authorityInspection === "Ja" ? (
                          <button
                            type="button"
                            className="primary smallButton"
                            style={{ gridColumn: "1 / -1", width: "fit-content" }}
                            onClick={() => generateAuthorityControlProtocolPdf(actualFlight)}
                          >
                            Kontrollprotokoll PDF öffnen
                          </button>
                        ) : null}
                        <CompletedFlightAttachmentsView entry={actualFlight} authoritiesOnly />
                      </div>
                    </div>
                    ) : null;
                  })()}

                  <button
                    type="button"
                    className="primary smallButton"
                    style={{ marginTop: "14px" }}
                    onClick={() => {
                      if (!authorityReport) return;

                      // Gleiche HTML-Vorlage verwenden wie beim E-Mail-Versand.
                      // Dadurch sind Behörden-PDF und E-Mail-Anhang optisch identisch.
                      openPrintWindow(
                        `UAS-Fluganmeldung ${authorityReport.registrationNumber || ""}`,
                        registrationHtml(authorityReport, "authority")
                      );
                    }}
                  >
                    UAS-Fluganmeldung als PDF öffnen
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    );
  }


  if (activePage === "locations") {
    return (
      <div className={appClassName} style={templateColorStyle}>
        <div className="page">
          <nav className="nav" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"18px",flexWrap:"wrap"}}>
            <a href="https://www.flymonitor.de/" className="brand" style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}><div className="brandicon"><img src="/logo_neu.png" alt="PX Logo" style={{ width: "200px", height: "84px", objectFit: "contain" }} /></div><div><strong>flymonitor.de</strong><span>Locations</span></div></a>
            <div className="menuBar"><button type="button" onClick={() => setActivePage("locations")}>Locations</button><button type="button" onClick={() => setActivePage("blog")}>Blog</button><button type="button" onClick={() => { window.location.hash = "gallery"; setActivePage("gallery"); }}>Galerie</button><button type="button" onClick={() => setActivePage("authority")}>Behörde</button></div>
            <AdminMenuControls />
          </nav>

          <section className="logbookWide">
            <div className="card">
              <div className="sectionHead">
                <div>
                  <h1>Drohnen-Locations</h1>
                  <p>Vorgeschlagene Orte können mit einem Klick zu „Kartenpunkt/Favoriten“ hinzugefügt werden.</p>
                </div>
                <Status status="good">{filteredDroneLocations.length} Locations</Status>
              </div>

              {adminUnlocked ? (
                <div className="buttonRow">
                  <button type="button" className="secondary smallButton" onClick={() => runWeeklyLocationUpdateWorking(true)}>
                    Schleswig-Holstein Locations jetzt aktualisieren
                  </button>
                </div>
              ) : null}

              <div className="buttonRow">
                {droneLocationCategories.map((category) => (
                  <button type="button" key={category} className={locationCategoryFilter === category ? "primary smallButton" : "secondary smallButton"} onClick={() => setLocationCategoryFilter(category)}>{category}</button>
                ))}
              </div>

              <div className="logbookList" style={{ maxHeight: "650px", overflowY: "auto", paddingRight: "6px" }}>
                {filteredDroneLocations.map((location) => (
                  <div key={location.id} className="listitem">
                    {editingLocationId === location.id ? (
                      <div>
                        <strong>Location bearbeiten</strong>
                        <div className="profileGrid">
                          <label>Kategorie<input value={editDroneLocation.category} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, category: e.target.value })} /></label>
                          <label>Name<input value={editDroneLocation.name} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, name: e.target.value })} /></label>
                          <label>Adresse<input value={editDroneLocation.address} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, address: e.target.value })} /></label>
                          <label>Koordinaten<input value={editDroneLocation.coordinates} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, coordinates: e.target.value })} placeholder="54.1234567, 10.1234567" /></label>
                          <label>Latitude<input value={editDroneLocation.lat} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, lat: e.target.value })} /></label>
                          <label>Longitude<input value={editDroneLocation.lon} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, lon: e.target.value })} /></label>
                          <label>Hinweis<textarea rows={3} value={editDroneLocation.note} onChange={(e) => setEditDroneLocation({ ...editDroneLocation, note: e.target.value })} /></label>
                        </div>
                        <div className="buttonRow">
                          <button type="button" className="primary smallButton" onClick={saveEditedDroneLocationWorking}>Speichern</button>
                          <button type="button" className="secondary smallButton" onClick={() => setEditingLocationId(null)}>Abbrechen</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <strong>{location.name}</strong>
                        <span>{location.address}</span>
                        <span>Koordinaten: {location.coordinates}</span>
                        {location.note ? <span>{location.note}</span> : null}
                        <div className="buttonRow">
                          <button type="button" className="primary smallButton" onClick={() => addDroneLocationToFavoritesWorking(location)}>Zu Kartenpunkt/Favoriten hinzufügen</button>
                          {adminUnlocked ? (
                            <>
                              <button type="button" className="secondary smallButton" onClick={() => startEditDroneLocationWorking(location)}>Bearbeiten</button>
                              <button type="button" className="secondary smallButton" onClick={() => deleteDroneLocationWorking(location.id)}>Löschen</button>
                            </>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {adminUnlocked ? (
                <div className="card" style={{ marginTop: "14px" }}>
                  <h2>Location hinzufügen</h2>
                  <div className="profileGrid">
                    <label>Kategorie<input value={newDroneLocation.category} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, category: e.target.value })} /></label>
                    <label>Name<input value={newDroneLocation.name} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, name: e.target.value })} /></label>
                    <label>Adresse<input value={newDroneLocation.address} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, address: e.target.value })} /></label>
                    <label>Koordinaten<input value={newDroneLocation.coordinates} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, coordinates: e.target.value })} placeholder="54.1234567, 10.1234567" /></label>
                    <label>Latitude<input value={newDroneLocation.lat} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, lat: e.target.value })} /></label>
                    <label>Longitude<input value={newDroneLocation.lon} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, lon: e.target.value })} /></label>
                    <label>Hinweis<textarea rows={3} value={newDroneLocation.note} onChange={(e) => setNewDroneLocation({ ...newDroneLocation, note: e.target.value })} /></label>
                  </div>
                  <div className="buttonRow">
                    <button type="button" className="primary smallButton" onClick={addDroneLocationWorking}>Location speichern</button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (activePage === "blog") {
    return (
      <div className={appClassName} style={templateColorStyle}>
        <div className="page">
          <nav className="nav" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"18px",flexWrap:"wrap"}}>
            <a href="https://www.flymonitor.de/" className="brand" style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}><div className="brandicon"><img src="/logo_neu.png" alt="PX Logo" style={{ width: "200px", height: "84px", objectFit: "contain" }} /></div><div><strong>flymonitor.de</strong><span>Blog</span></div></a>
            <div className="menuBar"><button type="button" onClick={() => setActivePage("locations")}>Locations</button><button type="button" onClick={() => setActivePage("blog")}>Blog</button><button type="button" onClick={() => { window.location.hash = "gallery"; setActivePage("gallery"); }}>Galerie</button><button type="button" onClick={() => setActivePage("authority")}>Behörde</button></div>
            <AdminMenuControls />
          </nav>

          <section className="logbookWide">
            <div className="card">
              <div className="sectionHead">
                <div>
                  <h1>Blog</h1>
                  <p>Beiträge mit Kategorien für Tipps, Wetter und Drohnenpraxis.</p>
                </div>
                <Status status="good">{blogPosts.length} Beiträge</Status>
              </div>

              <div className="buttonRow">
                {blogCategories.map((category) => (
                  <button type="button" key={category} className={blogCategoryFilter === category ? "primary smallButton" : "secondary smallButton"} onClick={() => setBlogCategoryFilter(category)}>{category}</button>
                ))}
              </div>

              <div className="logbookList" style={{ maxHeight: "650px", overflowY: "auto", paddingRight: "6px" }}>
                {filteredBlogPosts.map((post) => (
                  <div key={post.id} className="listitem">
                    {editingBlogId === post.id ? (
                      <div>
                        <strong>Blogbeitrag bearbeiten</strong>
                        <div className="profileGrid">
                          <label>Kategorie<input value={editBlogPost.category} onChange={(e) => setEditBlogPost({ ...editBlogPost, category: e.target.value })} /></label>
                          <label>Titel<input value={editBlogPost.title} onChange={(e) => setEditBlogPost({ ...editBlogPost, title: e.target.value })} /></label>
                          <label>Bild-URL<input value={editBlogPost.imageUrl || ""} onChange={(e) => setEditBlogPost({ ...editBlogPost, imageUrl: e.target.value })} placeholder="https://... oder Upload nutzen" /></label>
                          <label>Bild hochladen<input type="file" accept="image/*" onChange={(e) => uploadBlogImageWorking(e, "edit")} /></label>
                          <label>Text<textarea rows={6} value={editBlogPost.text} onChange={(e) => setEditBlogPost({ ...editBlogPost, text: e.target.value })} /></label>
                        </div>
                        <div className="buttonRow">
                          <button type="button" className="primary smallButton" onClick={saveEditedBlogPostWorking}>Speichern</button>
                          <button type="button" className="secondary smallButton" onClick={() => setEditingBlogId(null)}>Abbrechen</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <strong>{post.title}</strong>
                        <span>{post.category} · {formatGermanDate(post.date)}</span>
                        {post.imageUrl ? <img src={post.imageUrl} alt={post.title} style={{ width: "100%", maxHeight: "360px", objectFit: "cover", borderRadius: "18px", border: "1px solid #dbe3ef" }} /> : null}
                        <span>{shownBlogText(post)}</span>
                        {blogNeedsReadMore(post) ? (
                          <span>
                            {" "}
                            <a
                              href="#"
                              onClick={(e) => {
                                e.preventDefault();
                                setExpandedBlogPosts((prev) => ({
                                  ...prev,
                                  [post.id]: !prev[post.id],
                                }));
                              }}
                              style={{
                                color: "#2563eb",
                                textDecoration: "underline",
                                fontWeight: 600,
                              }}
                            >
                              {expandedBlogPosts[post.id] ? "Weniger anzeigen" : "Weiterlesen"}
                            </a>
                          </span>
                        ) : null}
                        {adminUnlocked ? (
                          <div className="buttonRow">
                            <button type="button" className="secondary smallButton" onClick={() => startEditBlogPostWorking(post)}>Bearbeiten</button>
                            <button type="button" className="secondary smallButton" onClick={() => deleteBlogPostWorking(post.id)}>Löschen</button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {adminUnlocked ? (
                <div className="card" style={{ marginTop: "14px" }}>
                  <h2>Blogbeitrag hinzufügen</h2>
                  <div className="profileGrid">
                    <label>Kategorie<input value={newBlogPost.category} onChange={(e) => setNewBlogPost({ ...newBlogPost, category: e.target.value })} /></label>
                    <label>Titel<input value={newBlogPost.title} onChange={(e) => setNewBlogPost({ ...newBlogPost, title: e.target.value })} /></label>
                    <label>Bild-URL<input value={newBlogPost.imageUrl || ""} onChange={(e) => setNewBlogPost({ ...newBlogPost, imageUrl: e.target.value })} placeholder="https://... oder Upload nutzen" /></label>
                    <label>Bild hochladen<input type="file" accept="image/*" onChange={(e) => uploadBlogImageWorking(e, "new")} /></label>
                    <label>Text<textarea rows={4} value={newBlogPost.text} onChange={(e) => setNewBlogPost({ ...newBlogPost, text: e.target.value })} /></label>
                  </div>
                  <div className="buttonRow"><button type="button" className="primary smallButton" onClick={addBlogPostWorking}>Blog speichern</button></div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (activePage === "gallery") {
    const featuredGalleryItems = filteredGalleryItems.filter((item) => item.featured).slice(0, 6);

    return (
      <div className={appClassName} style={templateColorStyle}>
        <div className="page">
          <nav className="nav" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"18px",flexWrap:"wrap"}}>
            <a href="https://www.flymonitor.de/" className="brand" style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}><div className="brandicon"><img src="/logo_neu.png" alt="PX Logo" style={{ width: "200px", height: "84px", objectFit: "contain" }} /></div><div><strong>flymonitor.de</strong><span>Galerie</span></div></a>
            <div className="menuBar"><button type="button" onClick={() => setActivePage("locations")}>Locations</button><button type="button" onClick={() => setActivePage("blog")}>Blog</button><button type="button" onClick={() => { window.location.hash = "gallery"; setActivePage("gallery"); }}>Galerie</button><button type="button" onClick={() => setActivePage("authority")}>Behörde</button></div>
            <AdminMenuControls />
          </nav>

          <section className="logbookWide">
            <div className="card" style={{ overflow: "hidden" }}>
              <div className="sectionHead">
                <div>
                  <p className="label">FlyMonitor Galerie</p>
                  <h1>Galerie</h1>
                  <p>Professionelle Bildgalerie mit Kategorien, Unterkategorien, Highlights und voller Admin-Verwaltung.</p>
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                  <Status status="good">{galleryItems.length} Bilder</Status>
                  <Status status="good">{galleryManagedCategories.length} Kategorien</Status>
                </div>
              </div>

              {featuredGalleryItems.length ? (
                <div className="card" style={{ marginBottom: "16px", background: "linear-gradient(135deg, rgba(15,23,42,.04), rgba(14,165,233,.07))" }}>
                  <div className="sectionHead"><div><h2>Ausgewählte Bilder</h2><p>Markierte Highlights aus der Galerie.</p></div></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" }}>
                    {featuredGalleryItems.map((item) => (
                      <div key={`featured-${item.id}`} style={{ borderRadius: "22px", overflow: "hidden", border: "1px solid #dbe3ef", background: "#fff", boxShadow: "0 10px 26px rgba(15,23,42,.08)" }}>
                        {item.imageUrl ? <img src={item.imageUrl} alt={item.title} style={{ width: "100%", height: "280px", objectFit: "cover", display: "block" }} /> : null}
                        <div style={{ padding: "12px" }}><strong>{item.title}</strong><p style={{ margin: "6px 0 0", color: "#64748b" }}>{item.category || "Allgemein"}{item.subcategory ? ` · ${item.subcategory}` : ""}</p></div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {flymonitorProSettings.showcaseEnabled && showcaseGalleryItems.length ? (
                <div className="card" style={{ marginBottom: "16px", background: "linear-gradient(135deg, rgba(14,165,233,.08), rgba(15,23,42,.04))" }}>
                  <div className="sectionHead"><div><h2>Galerie Showcase</h2><p>Große Präsentation ausgewählter Bilder und Videos ohne Kartenansicht.</p></div><Status status="good">{showcaseGalleryItems.length} Medien</Status></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "22px" }}>
                    {showcaseGalleryItems.slice(0, 8).map((item) => (
                      <div key={`showcase-${item.id}`} style={{ position: "relative", borderRadius: "22px", overflow: "hidden", background: "#0f172a", minHeight: 280, boxShadow: "0 18px 34px rgba(15,23,42,.14)" }}>
                        {getGalleryMediaType(item) === "video" && getGalleryMediaUrl(item) ? <video src={getGalleryMediaUrl(item)} controls preload="metadata" playsInline style={{ width: "100%", height: "280px", objectFit: "cover", display: "block" }} /> : <img src={normalizeUploadUrl(item.imageUrl || getGalleryMediaUrl(item))} alt={item.title} style={{ width: "100%", height: "280px", objectFit: "cover", display: "block" }} />}
                        {(() => { const wm = resolveGalleryWatermark(item, flymonitorProSettings, customers, missions); return wm ? <span style={getWatermarkStyle(wm.position, wm.opacity)}>{wm.text}</span> : null; })()}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Karten-Galerie Pro entfernt: Fläche wird für den Galerie-Showcase genutzt. */}

              <div className="card" style={{ marginBottom: "16px" }}>
                <div className="sectionHead"><div><h2>Galerie filtern</h2><p>Kategorie und Unterkategorie auswählen.</p></div><Status status={filteredGalleryItems.length ? "good" : "warning"}>{filteredGalleryItems.length} Treffer</Status></div>
                <div className="profileGrid">
                  <label>Kategorie<select value={galleryCategoryFilter} onChange={(e) => { setGalleryCategoryFilter(e.target.value); setGallerySubcategoryFilter("Alle"); }}>{galleryCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
                  <label>Unterkategorie<select value={gallerySubcategoryFilter} onChange={(e) => setGallerySubcategoryFilter(e.target.value)}>{gallerySubcategories.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>)}</select></label>
                </div>
                <div className="buttonRow">{galleryCategories.map((category) => <button type="button" key={category} className={galleryCategoryFilter === category ? "primary smallButton" : "secondary smallButton"} onClick={() => { setGalleryCategoryFilter(category); setGallerySubcategoryFilter("Alle"); }}>{category}</button>)}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px" }}>
                {filteredGalleryItems.length ? filteredGalleryItems.map((item) => (
                  <div key={item.id} className="listitem" style={{ overflow: "hidden", padding: 0, position: "relative" }}>
                    {editingGalleryId === item.id ? (
                      <div style={{ padding: "16px" }}>
                        <strong>Galerieeintrag bearbeiten</strong>
                        <div className="profileGrid" style={{ marginTop: "12px" }}>
                          <label>Kategorie<select value={editGalleryItem.category} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, category: e.target.value, subcategory: getGallerySubcategories(galleryManagedCategories, e.target.value)[0] || "Sonstiges" })}>{galleryManagedCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label>
                          <label>Unterkategorie<select value={editGalleryItem.subcategory || "Sonstiges"} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, subcategory: e.target.value })}>{editGallerySubcategoryOptions.length ? editGallerySubcategoryOptions.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>) : <option value="Sonstiges">Sonstiges</option>}</select></label>
                          <label>Titel<input value={editGalleryItem.title} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, title: e.target.value })} /></label>
                          <label>Medientyp<select value={editGalleryItem.mediaType || "image"} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, mediaType: e.target.value })}><option value="image">Bild</option><option value="video">Video</option></select></label>
                          <label>Bild-URL<input value={editGalleryItem.imageUrl || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, imageUrl: e.target.value, mediaType: "image" })} /></label>
                          <label>Video-URL<input value={editGalleryItem.videoUrl || ""} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, videoUrl: e.target.value, mediaType: "video" })} /></label>
                          <label>Bild/Video hochladen<input type="file" accept="image/*,video/*" onChange={(e) => uploadGalleryImageWorking(e, "edit")} /></label>
                          <label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(editGalleryItem.featured)} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, featured: e.target.checked })} /> Highlight</label>
                          <label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={3} value={editGalleryItem.text} onChange={(e) => setEditGalleryItem({ ...editGalleryItem, text: e.target.value })} /></label>
                        </div>
                        <div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveEditedGalleryItemWorking}>Speichern</button><button type="button" className="secondary smallButton" onClick={() => setEditingGalleryId(null)}>Abbrechen</button></div>
                      </div>
                    ) : (
                      <>
                        {getGalleryMediaType(item) === "video" && getGalleryMediaUrl(item) ? (
                          <video
                            src={getGalleryMediaUrl(item)}
                            controls
                            preload="metadata"
                            playsInline
                            style={{ width: "100%", height: "280px", objectFit: "cover", borderRadius: "18px 18px 0 0", display: "block", background: "#0f172a" }}
                          />
                        ) : item.imageUrl ? (
                          <img src={normalizeUploadUrl(item.imageUrl)} alt={item.title} style={{ width: "100%", height: "280px", objectFit: "cover", borderRadius: "18px 18px 0 0", display: "block" }} />
                        ) : getGalleryMediaUrl(item) ? (
                          <img src={getGalleryMediaUrl(item)} alt={item.title} style={{ width: "100%", height: "280px", objectFit: "cover", borderRadius: "18px 18px 0 0", display: "block" }} />
                        ) : (
                          <div style={{ height: "230px", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", color: "#64748b" }}>Kein Medium vorhanden.</div>
                        )}
                        {(() => { const wm = resolveGalleryWatermark(item, flymonitorProSettings, customers, missions); return wm ? <span style={getWatermarkStyle(wm.position, wm.opacity)}>{wm.text}</span> : null; })()}
                        <div style={{ padding: "15px" }}>
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}><span className="status good" style={{ padding: "5px 9px", fontSize: "12px" }}>{item.category || "Allgemein"}</span><span className="status warning" style={{ padding: "5px 9px", fontSize: "12px" }}>{item.subcategory || item.subCategory || "Sonstiges"}</span>{item.featured ? <span className="status good" style={{ padding: "5px 9px", fontSize: "12px" }}>Highlight</span> : null}</div>
                          <strong>{item.title}</strong>
                          {item.text ? <p style={{ color: "#64748b", marginTop: "8px" }}>{translateTickerTextToGerman(decodeTickerHtmlEntities(item.text))}</p> : null}
                          {adminUnlocked ? <div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => startEditGalleryItemWorking(item)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => deleteGalleryItemWorking(item.id)}>Löschen</button></div> : null}
                        </div>
                      </>
                    )}
                  </div>
                )) : <p>Keine Galerieeinträge für diese Auswahl vorhanden.</p>}
              </div>

              {adminUnlocked ? (
                <div className="card" style={{ marginTop: "18px", border: "1px solid rgba(14,165,233,.28)" }}>
                  <div className="sectionHead"><div><h2>Admin: Kategorien & Unterkategorien</h2><p>Kategorien anlegen, umbenennen, Unterkategorien verwalten oder löschen.</p></div><Status status="good">{galleryManagedCategories.length} aktiv</Status></div>
                  <div className="profileGrid"><label>Neue Kategorie<input value={newGalleryCategory.name} onChange={(e) => setNewGalleryCategory({ ...newGalleryCategory, name: e.target.value })} placeholder="z. B. Baustellen" /></label><label>Erste Unterkategorie<input value={newGalleryCategory.subcategory} onChange={(e) => setNewGalleryCategory({ ...newGalleryCategory, subcategory: e.target.value })} placeholder="z. B. Stadion" /></label><label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={2} value={newGalleryCategory.description} onChange={(e) => setNewGalleryCategory({ ...newGalleryCategory, description: e.target.value })} /></label></div>
                  <div className="buttonRow"><button type="button" className="primary smallButton" onClick={addGalleryCategoryWorking}>Kategorie hinzufügen</button></div>
                  <div className="logbookList" style={{ marginTop: "14px", maxHeight: "420px", overflowY: "auto" }}>
                    {galleryManagedCategories.map((category) => <div key={category.id} className="listitem">{editingGalleryCategoryId === category.id ? <div><strong>Kategorie bearbeiten</strong><div className="profileGrid" style={{ marginTop: "10px" }}><label>Name<input value={editGalleryCategory.name} onChange={(e) => setEditGalleryCategory({ ...editGalleryCategory, name: e.target.value })} /></label><label>Unterkategorien<textarea rows={4} value={editGalleryCategory.subcategoriesText} onChange={(e) => setEditGalleryCategory({ ...editGalleryCategory, subcategoriesText: e.target.value })} placeholder={"Eine Unterkategorie pro Zeile"} /></label><label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={2} value={editGalleryCategory.description} onChange={(e) => setEditGalleryCategory({ ...editGalleryCategory, description: e.target.value })} /></label></div><div className="buttonRow"><button type="button" className="primary smallButton" onClick={saveEditedGalleryCategoryWorking}>Kategorie speichern</button><button type="button" className="secondary smallButton" onClick={() => setEditingGalleryCategoryId(null)}>Abbrechen</button></div></div> : <><strong>{category.name}</strong>{category.description ? <span>{category.description}</span> : null}<span>Unterkategorien: {(category.subcategories || []).join(", ") || "Sonstiges"}</span><div className="buttonRow"><button type="button" className="secondary smallButton" onClick={() => startEditGalleryCategoryWorking(category)}>Bearbeiten</button><button type="button" className="secondary smallButton" onClick={() => deleteGalleryCategoryWorking(category)}>Löschen</button></div></>}</div>)}
                  </div>
                </div>
              ) : null}

              {adminUnlocked ? (
                <div className="card" style={{ marginTop: "18px" }}>
                  <div className="sectionHead"><div><h2>Admin: Galerie-Bilder hochladen</h2><p>Mehrere Bilder gleichzeitig auswählen. Die Bilder werden automatisch verkleinert.</p></div><button type="button" className="secondary smallButton" onClick={() => { if (window.confirm("Alle Galerieeinträge löschen?")) { setGalleryItems([]); localStorage.removeItem("droneready_gallery_items"); } }}>Alle Galerieeinträge löschen</button></div>
                  <div className="profileGrid"><label>Kategorie<select value={newGalleryItem.category} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, category: e.target.value, subcategory: getGallerySubcategories(galleryManagedCategories, e.target.value)[0] || "Sonstiges" })}>{galleryManagedCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label><label>Unterkategorie<select value={newGalleryItem.subcategory || "Sonstiges"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, subcategory: e.target.value })}>{newGallerySubcategoryOptions.length ? newGallerySubcategoryOptions.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>) : <option value="Sonstiges">Sonstiges</option>}</select></label><label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(newGalleryItem.featured)} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, featured: e.target.checked })} /> Als Highlight markieren</label><label style={{ gridColumn: "1 / -1" }}>Text für alle Bilder<textarea rows={2} value={newGalleryItem.text} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, text: e.target.value })} /></label><label>Mehrfach-Upload Bilder/Videos<input type="file" accept="image/*,video/*" multiple onChange={addGalleryFilesWorking} /></label></div>
                </div>
              ) : null}

              {adminUnlocked ? (
                <div className="card" style={{ marginTop: "18px" }}>
                  <h2>Admin: Einzelnen Galerieeintrag hinzufügen</h2>
                  <div className="profileGrid"><label>Kategorie<select value={newGalleryItem.category} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, category: e.target.value, subcategory: getGallerySubcategories(galleryManagedCategories, e.target.value)[0] || "Sonstiges" })}>{galleryManagedCategories.map((category) => <option key={category.id} value={category.name}>{category.name}</option>)}</select></label><label>Unterkategorie<select value={newGalleryItem.subcategory || "Sonstiges"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, subcategory: e.target.value })}>{newGallerySubcategoryOptions.length ? newGallerySubcategoryOptions.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>) : <option value="Sonstiges">Sonstiges</option>}</select></label><label>Titel<input value={newGalleryItem.title} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, title: e.target.value })} /></label><label>Medientyp<select value={newGalleryItem.mediaType || "image"} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, mediaType: e.target.value })}><option value="image">Bild</option><option value="video">Video</option></select></label><label>Bild-URL<input value={newGalleryItem.imageUrl || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, imageUrl: e.target.value, mediaType: "image" })} placeholder="https://..." /></label><label>Video-URL<input value={newGalleryItem.videoUrl || ""} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, videoUrl: e.target.value, mediaType: "video" })} placeholder="https://...mp4" /></label><label>Bild/Video hochladen<input type="file" accept="image/*,video/*" onChange={(e) => uploadGalleryImageWorking(e, "new")} /></label><label style={{ display: "flex", alignItems: "center", gap: "9px" }}><input type="checkbox" checked={Boolean(newGalleryItem.featured)} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, featured: e.target.checked })} /> Highlight</label><label style={{ gridColumn: "1 / -1" }}>Beschreibung<textarea rows={3} value={newGalleryItem.text} onChange={(e) => setNewGalleryItem({ ...newGalleryItem, text: e.target.value })} /></label></div>
                  <div className="buttonRow"><button type="button" className="primary smallButton" onClick={addGalleryItemWorking}>Galerie speichern</button></div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    );
  }


  return (
    <div className={appClassName} style={templateColorStyle}>
      <div className="page">
        <nav className="nav" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:"18px",flexWrap:"wrap"}}>
          <a
            href="https://www.flymonitor.de/"
            className="brand"
            style={{ textDecoration: "none", color: "inherit", cursor: "pointer" }}
          >
            <div className="brandicon">
              <img src="/logo_neu.png" alt="PX Logo" style={{ width: "200px", height: "84px", objectFit: "contain" }} />
            </div>
            <div>
              <strong>flymonitor.de</strong>
              <span>OpenStreetMap · Open-Meteo · OpenSky</span>
            </div>
          </a>
          <div className="menuBar"><button type="button" onClick={() => { setActivePage("locations"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Locations</button><button type="button" onClick={() => { setActivePage("blog"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Blog</button><button type="button" onClick={() => { window.location.hash = "gallery"; setActivePage("gallery"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Galerie</button><button type="button" onClick={() => { window.location.hash = "behoerde"; setActivePage("authority"); }}>Behörde</button></div>
          <AdminMenuControls showSource />
        </nav>

        <NewsTickerStyles />

        {adminUnlocked && publicPreviewMode ? (
          <div className="card" style={{ margin: "0 auto 18px", maxWidth: "1200px", border: "1px solid rgba(0,178,226,.28)", background: "linear-gradient(135deg,rgba(0,178,226,.10),rgba(2,27,51,.05))" }}>
            <div className="sectionHead">
              <div>
                <strong>Öffentliche Vorschau aktiv</strong>
                <p style={{ margin: 0 }}>Du bist weiterhin als Admin angemeldet.</p>
              </div>
              <button
                type="button"
                className="primary smallButton"
                onClick={() => {
                  setPublicPreviewMode(false);
                  setActivePage("home");
                  setAdminCenterTab("overview");
                  if (typeof window !== "undefined") {
                    window.location.hash = "";
                    window.history.replaceState(null, "", window.location.pathname + window.location.search);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }
                }}
              >
                Zurück ins Admin Center
              </button>
            </div>
          </div>
        ) : null}

                <section
          className="logbookWide"
          aria-label="UAS-Liveticker"
          style={{
            maxWidth: "1200px",
            margin: "0 auto 26px",
            width: "100%"
          }}
        >
          <div
            style={{
              overflow: "hidden",
              borderRadius: "28px",
              background: "#ffffff",
              boxShadow: "0 18px 45px rgba(15,23,42,.08)",
              border: "1px solid rgba(148,163,184,.22)"
            }}
          >
            <div
              style={{
                background: "#0f1f35",
                color: "#ffffff",
                padding: "18px 22px",
                display: "flex",
                alignItems: "center",
                gap: "16px"
              }}
            >
              <span
                style={{
                  border: "1px solid #22c55e",
                  color: "#ffffff",
                  background: "#064e3b",
                  borderRadius: "999px",
                  padding: "7px 13px",
                  fontWeight: 800,
                  fontSize: "13px"
                }}
              >
                LIVE
              </span>

              <strong>UAS-Liveticker</strong>

              <span style={{ marginLeft: "auto", color: "#cbd5e1", fontSize: "14px" }}>
                {uasTicker.length} Meldungen
              </span>
            </div>

            <div
              style={{
                overflow: "hidden",
                width: "100%",
                background: "#ffffff",
                padding: "16px 0"
              }}
            >
              <style>{`
                @keyframes flymonitorTickerMoveBottom {
                  0% { transform: translateX(0); }
                  100% { transform: translateX(-50%); }
                }
              `}</style>

              {uasTicker.length ? (
                <div
                  style={{
                    display: "inline-flex",
                    gap: "64px",
                    whiteSpace: "nowrap",
                    alignItems: "center",
                    animation: "flymonitorTickerMoveBottom 600s linear infinite"
                  }}
                >
                  {[...uasTicker, ...uasTicker].map((item, index) => (
                    <div
                      key={`${item.id || index}-${index}`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "14px",
                        color: "#0f172a",
                        fontSize: "15px",
                        fontWeight: 700
                      }}
                    >
                      <span
                        style={{
                          width: "12px",
                          height: "12px",
                          borderRadius: "999px",
                          background: "#22c55e",
                          boxShadow: "0 0 14px rgba(34,197,94,.75)"
                        }}
                      />
                      <TickerNewsLink item={item} style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
                        <span>
                          {translateTickerTextToGerman(decodeTickerHtmlEntities(item.title || item.message || "UAS-Meldung"))}
                        </span>
                        {item.text ? (
                          <span style={{ color: "#475569", fontWeight: 600 }}>
                            {translateTickerTextToGerman(decodeTickerHtmlEntities(item.text))}
                          </span>
                        ) : null}
                      </TickerNewsLink>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ padding: "0 22px", color: "#64748b", margin: 0 }}>
                  Noch keine UAS-Meldungen geladen. Bitte /api/update-uas-ticker.php einmal ausführen.
                </p>
              )}
            </div>
          </div>
        </section>


        <section className="hero">
          <div className="heroText">
            <h1>Drohnenflug kostenlos mit Live-Daten prüfen.</h1>
            <p>OpenStreetMap-Karte, Open-Meteo Live-Wetter, OpenSky-Live-Flugzeuge, GPS, 14-Tage-Vorhersage, Flugplanung und Risiko-Score.</p>
            <div className="searchbox">
              <div className="inputwrap"><Search size={21} /><input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && checkWeather()} placeholder="Ort eingeben, z. B. Frankfurt Flughafen" /></div>
              <button type="button" className="primary" onClick={() => checkWeather()}>{loading ? "Lädt..." : "Prüfen"}</button>
              <button type="button" className="secondary" onClick={useGps}><MapPin size={18} /> GPS</button>
              <button type="button" className="secondary" onClick={installPwaWorking}>PWA installieren</button>
              <div className="chips">{["Kiel", "Berlin", "Hamburg", "München"].map((c) => <button type="button" key={c} onClick={() => { setQuery(c); checkWeather(c); }}>{c}</button>)}</div>
            </div>
          </div>
          <div className={fullscreenMap ? "mapFull" : ""}><DroneMap
              result={result}
              routeKm={routeKm}
              aircraft={aircraft}
              pickedLocation={mapPick}
              onPick={(picked) => {
                setMapPick(picked);
                setFlightReportForm((prev) => ({
                  ...prev,
                  coordinates: picked.coordinates,
                  flightArea: picked.address || picked.coordinates,
                }));
              }}
              mapFavoritePlaces={mapFavoritePlaces}
              setMapFavoritePlaces={setMapFavoritePlaces}
            /><button type="button" className="mapFullButton" onClick={() => setFullscreenMap(!fullscreenMap)}>{fullscreenMap ? "Karte schließen" : "Vollbildkarte"}</button></div>

          {adminUnlocked ? (
          <div className="card sectionGap">
            <div className="sectionHead">
              <div>
                <h2><MapPin size={22} /> Kartenpunkt / Favoriten</h2>
                <p>Klicke auf die Karte, um einen Einsatzort zu setzen. Es ist immer nur ein aktueller Punkt aktiv.</p>
              </div>
              <Status status={mapPick ? "good" : "warning"}>{mapPick ? "Punkt gesetzt" : "Kein Punkt gesetzt"}</Status>
            </div>

            {mapPick ? (
              <div className="listitem">
                <strong>Aktueller Kartenpunkt</strong>
                <span>{mapPick.address || mapPick.coordinates}</span>
                <span>Koordinaten: {mapPick.coordinates}</span>
                <div className="buttonRow">
                  <button type="button" className="primary smallButton" onClick={saveMapPickAsFavoriteWorking}>
                    Als Favorit speichern
                  </button>
                  <button
                    type="button"
                    className="secondary smallButton"
                    onClick={() => {
                      setMapPick(null);
                      setFlightReportForm((prev) => ({
                        ...prev,
                        coordinates: "",
                        flightArea: "",
                      }));
                    }}
                  >
                    Punkt entfernen
                  </button>
                </div>
              </div>
            ) : null}

            <div
              className="miniList"
              style={{
                maxHeight: "420px",
                overflowY: "auto",
                paddingRight: "6px",
              }}
            >
              {mapFavoritePlaces.length ? (
                mapFavoritePlaces.map((place) => (
                  <div key={place.id} className="listitem">
                    {editingFavoriteId === place.id ? (
                      <>
                        <strong>Favorit bearbeiten</strong>
                        <div className="profileGrid" style={{ gridColumn: "1 / -1" }}>
                          <label>
                            Name
                            <input
                              value={editFavorite.name}
                              onChange={(event) =>
                                setEditFavorite({
                                  ...editFavorite,
                                  name: event.target.value,
                                })
                              }
                              placeholder="z. B. Kiel Stadion"
                            />
                          </label>
                          <label>
                            Anschrift
                            <input
                              value={editFavorite.address}
                              onChange={(event) =>
                                setEditFavorite({
                                  ...editFavorite,
                                  address: event.target.value,
                                })
                              }
                              placeholder="Straße, Ort"
                            />
                          </label>
                        </div>
                        <span>Koordinaten: {place.coordinates}</span>
                        <div className="buttonRow">
                          <button type="button" className="primary smallButton" onClick={() => saveEditedMapFavoriteWorking(place.id)}>
                            Speichern
                          </button>
                          <button
                            type="button"
                            className="secondary smallButton"
                            onClick={() => {
                              setEditingFavoriteId(null);
                              setEditFavorite({ name: "", address: "" });
                            }}
                          >
                            Abbrechen
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <strong>{place.name || place.address || place.coordinates}</strong>
                        {place.address ? <span>{place.address}</span> : null}
                        <span>Koordinaten: {place.coordinates}</span>
                        <span>Gespeichert: {place.savedAt}</span>
                        {place.updatedAt ? <span>Bearbeitet: {place.updatedAt}</span> : null}
                        <div className="buttonRow">
                          <button type="button" className="primary smallButton" onClick={() => useMapFavoriteWorking(place)}>
                            Favorit verwenden
                          </button>
                          <button type="button" className="secondary smallButton" onClick={() => startEditMapFavoriteWorking(place)}>
                            Bearbeiten
                          </button>
                          <button type="button" className="secondary smallButton" onClick={() => deleteMapFavoriteWorking(place.id)}>
                            Löschen
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              ) : (
                <div className="listitem">
                  <strong>Noch keine Karten-Favoriten gespeichert.</strong>
                  <span>Setze zuerst einen Punkt auf der Karte und speichere ihn als Favorit.</span>
                </div>
              )}
            </div>
          </div>
          ) : null}
        </section>

        <section className="metrics">
          <Metric icon={Wind} title="Wind & Böen" value={`${result.wind} / ${result.gusts} km/h`} text={`Richtung ${result.direction}`} tone={wt} />
          <Metric icon={Thermometer} title="Temperatur / Taupunkt" value={`${result.temp}° / ${result.dew}°`} text="Taupunkt geschätzt" />
          <Metric icon={CloudRain} title="Regen & Wolken" value={`${result.rain}% / ${result.cloud}%`} text={`${result.visibility} km Sichtweite`} tone={rt} />
          <Metric icon={Gauge} title="Risiko-Score" value={`${score}/100`} text={result.summary} tone={st} />
        </section>

        <section className="proStrip"><div><Sunrise size={22} /><strong>{result.sunrise}</strong><span>Sonnenaufgang</span></div><div><Sunset size={22} /><strong>{result.sunset}</strong><span>Sonnenuntergang</span></div><div><Plane size={22} /><strong>{aircraft.length}</strong><span>Flugzeuge</span></div><div><Bell size={22} /><strong>3</strong><span>Warnungen</span></div></section>

        <section className="wideGrid">
          <div className="card">
            <div className="sectionHead">
              <div>
                <h2><CloudRain size={22} /> Live-Regenradar</h2>
                <p>Animiertes Live-Regenradar direkt in der App.</p>
              </div>
              <Status status="good">Radar aktiv</Status>
            </div>

            <div
              style={{
                width: "100%",
                height: "520px",
                overflow: "hidden",
                borderRadius: "24px",
                border: "1px solid rgba(15,23,42,.08)",
                marginTop: "18px",
                background: "#e2e8f0",
              }}
            >
              <iframe
                title="Live-Regenradar"
                src={`https://www.rainviewer.com/map.html?loc=${result.lat},${result.lon},8&oFa=0&oC=1&oU=0&oCS=1&oF=0&oAP=1&c=3&o=83&lm=1&layer=radar&sm=1&sn=1`}
                width="100%"
                height="100%"
                frameBorder="0"
                allowFullScreen
                loading="lazy"
                style={{
                  border: "0",
                  width: "100%",
                  height: "100%",
                }}
              />
            </div>

            <div className="buttonRow" style={{ marginTop: "12px" }}>
              <a
                className="secondary smallButton"
                href={`https://www.rainviewer.com/map.html?loc=${result.lat},${result.lon},8&oFa=0&oC=1&oU=0&oCS=1&oF=0&oAP=1&c=3&o=83&lm=1&layer=radar&sm=1&sn=1`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Regenradar groß öffnen
              </a>
            </div>
          </div>

          <div className="card">
            <div className="sectionHead">
              <div>
                <h2><Sunrise size={22} /> Sonnenstand & Golden Hour</h2>
                <p>Hilft bei Foto- und Videoflügen mit besserem Licht.</p>
              </div>
              <Status status="good">{goldenHourInfo.sunrise} / {goldenHourInfo.sunset}</Status>
            </div>
            <div className="dataBadges">
              <span>Sonnenaufgang: {goldenHourInfo.sunrise}</span>
              <span>Golden Hour morgens: {goldenHourInfo.morning}</span>
              <span>Golden Hour abends: {goldenHourInfo.evening}</span>
              <span>Sonnenuntergang: {goldenHourInfo.sunset}</span>
            </div>
          </div>
        </section>

        <section className="logbookWide">
          <div className="card">
            <div className="sectionHead">
              <div>
                <h2><Plane size={22} /> ADS-B / OpenSky Flugverkehr live</h2>
                <p>Live-Flugzeuge im Kartenbereich. Aktualisierung alle 120 Sekunden.</p>
              </div>
              <Status status={aircraft.length ? "good" : "warning"}>{aircraft.length} Flugzeuge</Status>
            </div>

            <div style={{ display: "grid", gap: "14px", maxHeight: "430px", overflow: "auto", paddingRight: "8px" }}>
              {aircraft.length ? aircraft.slice(0, 30).map((plane, index) => {
                const lat = Number(plane.latitude ?? plane.lat);
                const lon = Number(plane.longitude ?? plane.lon);
                const altitude = Math.round(Number(plane.altitude ?? plane.geo_altitude ?? plane.baro_altitude ?? 0));
                const velocity = Math.round(Number(plane.velocity ?? plane.speed ?? 0));
                const heading = Math.round(Number(plane.heading ?? plane.true_track ?? 0));
                const verticalRate = Math.round(Number(plane.verticalRate ?? plane.vertical_rate ?? 0));
                const callsign = String(plane.callsign || plane.callSign || plane.icao24 || "UNKNOWN").trim() || "UNKNOWN";
                const country = plane.origin_country || plane.country || "Unbekannt";
                const icao24 = String(plane.icao24 || "").trim().toLowerCase();
                const hasPosition = Number.isFinite(lat) && Number.isFinite(lon);
                const distanceKm = hasPosition && result?.lat && result?.lon
                  ? haversineKm(result.lat, result.lon, lat, lon)
                  : null;
                const isLow = altitude > 0 && altitude < 1500;
                const isNear = distanceKm !== null && distanceKm < 10;

                return (
                  <div
                    key={`${icao24 || callsign}-${index}`}
                    style={{
                      border: "1px solid rgba(120,140,180,.28)",
                      borderRadius: "18px",
                      padding: "14px",
                      background: "rgba(248,250,252,.82)"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap", marginBottom: "10px" }}>
                      <strong>{callsign}</strong>
                      <div className="buttonRow" style={{ margin: 0 }}>
                        {isNear ? <span className="status warning">Nahbereich</span> : null}
                        {isLow ? <span className="status warning">Niedrig</span> : null}
                        {icao24 ? (
                          <a
                            className="secondary smallButton"
                            href={`https://globe.adsbexchange.com/?icao=${icao24}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Live verfolgen
                          </a>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: "8px 14px", color: "#64748b", fontSize: "14px" }}>
                      <span>ICAO24: {icao24 || "-"}</span>
                      <span>Land: {country}</span>
                      <span>Höhe: {altitude ? `${altitude} m` : "-"}</span>
                      <span>Geschwindigkeit: {velocity ? `${velocity} km/h` : "-"}</span>
                      <span>Kurs: {Number.isFinite(heading) ? `${heading}°` : "-"}</span>
                      <span>Steigen/Sinken: {verticalRate ? `${verticalRate} m/s` : "0 m/s"}</span>
                      <span>Entfernung: {distanceKm !== null ? `${distanceKm.toFixed(1)} km` : "-"}</span>
                      <span>Position: {hasPosition ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : "-"}</span>
                    </div>

                    {hasPosition ? (
                      <div className="buttonRow" style={{ marginTop: "12px" }}>
                        <button
                          type="button"
                          className="secondary smallButton"
                          onClick={() => {
                            setMapPick({
                              name: callsign,
                              lat,
                              lon,
                              latitude: lat,
                              longitude: lon,
                              coordinates: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
                              address: `${callsign} · ${country}`,
                            });
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          Auf Karte markieren
                        </button>
                        <a
                          className="secondary smallButton"
                          href={`https://www.google.com/maps?q=${lat},${lon}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Google Maps
                        </a>
                      </div>
                    ) : null}
                  </div>
                );
              }) : (
                <p>Keine Live-Flugzeuge im aktuellen Kartenbereich gefunden.</p>
              )}
            </div>
          </div>
        </section>

        <section className="wideGrid">
          <div className={`card advice ${aiFlightAssessment.status}`}>
            <div className="sectionHead">
              <div>
                <h2><ShieldAlert size={22} /> KI-Flugbewertung</h2>
                <p>Regelbasierte Bewertung aus Wind, Böen, Sicht und Regen.</p>
              </div>
              <Status status={aiFlightAssessment.status}>{aiFlightAssessment.status === "good" ? "geeignet" : "prüfen"}</Status>
            </div>
            <h3>{aiFlightAssessment.title}</h3>
            <p>{aiFlightAssessment.text}</p>
          </div>

          <div className="card">
            <div className="sectionHead">
              <div>
                <h2><Bell size={22} /> NOTAM-Anzeige</h2>
                <p>Direkte Prüfung über amtliche bzw. externe Informationsquellen.</p>
              </div>
          
            </div>
            <div className="buttonRow">
              <a className="secondary smallButton" href="https://ais.dfs.de/pilotservice/home.jsp?lang=de" target="_blank" rel="noopener noreferrer">DFS AIS-Portal öffnen</a>
              <a className="secondary smallButton" href="https://maptool-dipul.dfs.de/?language=de" target="_blank" rel="noopener noreferrer">DIPUL-Karte prüfen</a>
            </div>
            <p>Eine vollautomatische NOTAM-Auswertung benötigt eine gesonderte NOTAM-/AIS-Schnittstelle.</p>
          </div>
        </section>

        {adminUnlocked ? (
        <section className="wideGrid">
          <div className="card">
            <div className="sectionHead">
              <div>
                <h2><Bell size={22} /> Kalenderintegration</h2>
                <p>Erstellt eine .ics-Kalenderdatei mit 30-Minuten-Erinnerung.</p>
              </div>
            
            </div>
            <div className="buttonRow">
              <button type="button" className="primary smallButton" onClick={exportFlightCalendarWorking}>
                Flugtermin in Kalender speichern
              </button>
            </div>
            {calendarNotice ? <p>{calendarNotice}</p> : <p>Verwendet Datum, Startzeit, Endzeit und Einsatzort aus der Fluganmeldung.</p>}
            {calendarDownloadHref ? (
              <div className="buttonRow" style={{ marginTop: "10px" }}>
                <a
                  className="secondary smallButton"
                  href={calendarDownloadHref}
                  download={calendarDownloadName}
                >
                  Kalenderdatei herunterladen
                </a>
              </div>
            ) : null}

            <div className="flightCalendar" style={{ marginTop: "18px" }}>
              <div className="buttonRow" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
                >
                  ◀ Voriger Monat
                </button>

                <strong>
                  {calendarMonth.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}
                </strong>

                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
                >
                  Nächster Monat ▶
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                  gap: "8px",
                  marginTop: "14px",
                }}
              >
                {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((dayName) => (
                  <strong key={dayName} style={{ color: "#64748b", fontSize: "13px" }}>
                    {dayName}
                  </strong>
                ))}

                {calendarDays.map((day) => (
                  <div
                    key={day.iso}
                    style={{
                      minHeight: "86px",
                      border: "1px solid rgba(148,163,184,.28)",
                      borderRadius: "16px",
                      padding: "8px",
                      background: day.inMonth ? "rgba(255,255,255,.88)" : "rgba(226,232,240,.45)",
                    }}
                  >
                    <strong style={{ color: day.inMonth ? "#0f172a" : "#94a3b8" }}>
                      {formatGermanDate(day.iso).slice(0, 2)}
                    </strong>

                    <div style={{ display: "grid", gap: "5px", marginTop: "6px" }}>
                      {day.flights.map((entry) => (
                        <button
                          key={entry.id || entry.registrationNumber}
                          type="button"
                          className="secondary smallButton"
                          style={{
                            padding: "6px 8px",
                            fontSize: "12px",
                            textAlign: "left",
                            justifyContent: "flex-start",
                            whiteSpace: "normal",
                          }}
                          onClick={() => setSelectedCalendarFlight(entry)}
                        >
                          {entry.startTime || "--:--"} {entry.city || entry.flightArea || "Flug"}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {selectedCalendarFlight ? (
                <div className="listitem" style={{ marginTop: "14px" }}>
                  <strong>Fluganmeldung</strong>
                  <span>
                    Datum: {formatGermanDate(selectedCalendarFlight.date)}
                    <br />
                    Uhrzeit: {selectedCalendarFlight.startTime || "-"}{selectedCalendarFlight.endTime ? ` – ${selectedCalendarFlight.endTime}` : ""}
                    <br />
                    Ort: {selectedCalendarFlight.flightArea || selectedCalendarFlight.city || "-"}
                  </span>
                  <div className="buttonRow" style={{ marginTop: "10px" }}>
                    <button type="button" className="secondary smallButton" onClick={() => setSelectedCalendarFlight(null)}>
                      Schließen
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="sectionHead">
              <div>
                <h2><CheckCircle2 size={22} /> Erinnerungs-Checkliste</h2>
                <p>Wird mit der Kalendererinnerung praktisch vor dem Start geprüft.</p>
              </div>
          
            </div>
            <div className="dataBadges">
              <span>Akkus</span>
              <span>Wetter</span>
              <span>NOTAM/dipul</span>
              <span>Versicherung</span>
              <span>Genehmigung</span>
            </div>
          </div>
        </section>

        ) : null}

        <section className="forecast">
          <h2>14-Tage-Vorhersage</h2>
          <div className="forecastGrid">
            {(result.forecast?.length ? result.forecast.slice(0, 14) : Array.from({ length: 14 }, (_, i) => ({ day: i === 0 ? "Heute" : i === 1 ? "Morgen" : `Tag ${i + 1}`, max: 18 + (i % 4), min: 8 + (i % 5), rain: 10 + i, hourly: [] }))).map((d, index) => (
              <button type="button" className="card forecastCard" key={`${d.day}-${index}`} onClick={() => setSelectedForecastDay(d)} style={{ cursor: "pointer", border: selectedForecastDay?.day === d.day ? "2px solid #38bdf8" : undefined }}>
                <strong>{index === 0 ? "Heute" : index === 1 ? "Morgen" : (String(d.day).includes("-") ? new Date(d.day) : new Date(Date.now() + index * 86400000)).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}</strong>
                <span>{d.min}° / {d.max}°</span>
                <small>Regen {d.rain}%</small>
              </button>
            ))}
          </div>

          {selectedForecastDay ? (
            <div className="card sectionGap">
              <div className="sectionHead">
                <div>
                  <h2>Wetterdetails nach Uhrzeit</h2>
                  <p>{String(selectedForecastDay.day).includes("-") ? new Date(selectedForecastDay.day).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }) : selectedForecastDay.day}{selectedForecastDay.sunrise || selectedForecastDay.sunset ? ` · Sonnenaufgang ${selectedForecastDay.sunrise || "-"} · Sonnenuntergang ${selectedForecastDay.sunset || "-"}` : ""}</p>
                </div>
                <Status status="good">{(selectedForecastDay.hourly?.length ? selectedForecastDay.hourly : buildFallbackHourly(selectedForecastDay)).length} Stundenwerte</Status>
              </div>
              <div className="logbookList" style={{ maxHeight: "360px", overflowY: "auto", paddingRight: "6px" }}>
                {(selectedForecastDay.hourly?.length ? selectedForecastDay.hourly : buildFallbackHourly(selectedForecastDay)).map((hour) => (
                  <div key={hour.time} className="listitem">
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      {getWeatherIcon(hour)}
                      <strong>{hour.hour} Uhr</strong>
                    </div>
                    <div style={{ display: "grid", gap: "6px", marginTop: "6px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Thermometer size={16} />
                        <span>Temperatur: {hour.temp}°</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <CloudRain size={16} />
                        <span>Regenwahrscheinlichkeit: {hour.rain}%</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Droplets size={16} />
                        <span>Niederschlag: {hour.precipitation} mm</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Wind size={16} />
                        <span>Wind/Böen: {hour.wind} / {hour.gusts} km/h</span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Cloud size={16} />
                        <span>Wolken: {hour.cloud}%</span>
                      </div>

                      {hour.visibility !== null ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <Eye size={16} />
                          <span>Sicht: {hour.visibility} km</span>
                        </div>
                      ) : null}
                    </div>
                    {hour.fallback ? <span>Hinweis: Schätzung aus Tageswerten. Für Live-Stundenwerte bitte „Prüfen“ erneut anklicken.</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        

        {/* Öffentliche Seite: Drohnenfluganmeldung und Fluglogbuch werden hier bewusst nicht angezeigt.
            Diese Bereiche sind nur im Admin Center unter „Flüge“ erreichbar. */}


        {emailDialogOpen ? (
          <div
            className="modalBackdrop"
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              background: "rgba(15, 23, 42, 0.58)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "18px",
            }}
          >
            <div className="card" style={{ maxWidth: 820, width: "94vw", maxHeight: "88vh", overflowY: "auto" }}>
              <div className="sectionHead">
                <div>
                  <h2>Empfänger auswählen</h2>
                  <p>{emailEntry?.registrationNumber || "Fluganmeldung"} per E-Mail senden</p>
                </div>
                <Status status={emailRecipientSelection.length ? "good" : "warning"}>
                  {emailRecipientSelection.length} ausgewählt
                </Status>
              </div>

              <div className="profileGrid">
                <label style={{ gridColumn: "1 / -1" }}>
                  Empfänger suchen
                  <input
                    value={emailRecipientSearch}
                    onChange={(e) => setEmailRecipientSearch(e.target.value)}
                    placeholder="Name, Kategorie oder E-Mail suchen..."
                  />
                </label>
              </div>

              <div className="buttonRow" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => setEmailRecipientSelection(savedEmailRecipients.map((recipient) => recipient.id))}
                >
                  Alle auswählen
                </button>
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => setEmailRecipientSelection([])}
                >
                  Auswahl leeren
                </button>
                <button
                  type="button"
                  className="secondary smallButton"
                  onClick={() => setAdminCenterTab("authorities")}
                >
                  Empfänger verwalten
                </button>
              </div>

              <div className="logbookList" style={{ maxHeight: 360, overflowY: "auto", marginTop: 14 }}>
                {savedEmailRecipients
                  .filter((recipient) =>
                    `${recipient.name || ""} ${recipient.category || ""} ${recipient.subcategory || ""} ${recipient.responsibility || ""} ${(recipient.emails || []).join(" ")}`
                      .toLowerCase()
                      .includes(emailRecipientSearch.toLowerCase())
                  )
                  .map((recipient) => (
                    <label key={recipient.id} className="listitem" style={{ cursor: "pointer" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <input
                          type="checkbox"
                          checked={emailRecipientSelection.includes(recipient.id)}
                          onChange={(e) => {
                            setEmailRecipientSelection((prev) =>
                              e.target.checked
                                ? Array.from(new Set([...prev, recipient.id]))
                                : prev.filter((id) => id !== recipient.id)
                            );
                          }}
                          style={{ width: 18, height: 18, marginTop: 3 }}
                        />
                        <div>
                          <strong>{recipient.name || "Empfänger"}</strong>
                          <span>
                            {recipient.category || "Allgemein"}
                            {recipient.subcategory ? ` · ${recipient.subcategory}` : ""}
                            {recipient.responsibility ? ` · ${recipient.responsibility}` : ""}
                          </span>
                          <span>{(recipient.emails || []).join(", ")}</span>
                        </div>
                      </div>
                    </label>
                  ))}
                {!savedEmailRecipients.length ? <p>Noch keine Empfänger gespeichert.</p> : null}
              </div>

              <label style={{ display: "block", marginTop: 14 }}>
                Zusätzliche Empfänger
                <input
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="zusatz@example.de; weitere@example.de"
                />
              </label>

              <div className="card" style={{ marginTop: 14, background: "#f8fafc" }}>
                <div className="sectionHead">
                  <div>
                    <h3>PDF-Dokumente anhängen</h3>
                    <p>Wähle hinterlegte PDFs aus, die zusätzlich zur Fluganmeldung mitgesendet werden.</p>
                  </div>
                  <Status status={selectedMailPdfDocumentIds.length ? "good" : "warning"}>
                    {selectedMailPdfDocumentIds.length} PDF(s)
                  </Status>
                </div>

                <label>
                  Weitere PDF-Dokumente hinterlegen
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    multiple
                    onChange={(event) => {
                      addMailPdfDocumentsWorking(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>

                <div className="logbookList" style={{ maxHeight: 220, overflowY: "auto", marginTop: 12 }}>
                  {mailPdfDocuments.map((document) => (
                    <label key={document.id} className="listitem" style={{ cursor: "pointer" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <input
                          type="checkbox"
                          checked={selectedMailPdfDocumentIds.map(String).includes(String(document.id))}
                          onChange={(event) => toggleMailPdfDocumentSelection(document.id, event.target.checked)}
                          style={{ width: 18, height: 18, marginTop: 3 }}
                        />
                        <div>
                          <strong>{document.title || document.name || "PDF-Dokument"}</strong>
                          <span>{document.name || "PDF-Datei"}</span>
                        </div>
                      </div>
                    </label>
                  ))}
                  {!mailPdfDocuments.length ? <p>Noch keine PDF-Dokumente hinterlegt.</p> : null}
                </div>

                {mailPdfDocuments.length ? (
                  <div className="buttonRow" style={{ marginTop: 10 }}>
                    <button type="button" className="secondary smallButton" onClick={() => setSelectedMailPdfDocumentIds(mailPdfDocuments.map((document) => document.id))}>Alle PDFs auswählen</button>
                    <button type="button" className="secondary smallButton" onClick={() => setSelectedMailPdfDocumentIds([])}>PDF-Auswahl leeren</button>
                  </div>
                ) : null}
              </div>

              <div className="buttonRow" style={{ marginTop: 16 }}>
                <button type="button" className="secondary smallButton" onClick={() => setEmailDialogOpen(false)}>
                  Abbrechen
                </button>
                <button type="button" className="primary smallButton" onClick={sendSelectedFlightEmailWorking}>
                  Per E-Mail senden
                </button>
              </div>
            </div>
          </div>
        ) : null}



        <section className="ultimateDashboard"><div className="dashCard"><strong>{uvIndex}</strong><span>UV-Index live</span></div><div className="dashCard"><strong>{airQuality.quality}</strong><span>Luftqualität</span></div><div className="dashCard"><strong>{airQuality.pm25}</strong><span>PM2.5 µg/m³</span></div><div className="dashCard"><strong>{waypoints.length}</strong><span>Wegpunkte</span></div></section>

        

        

        {updateReady ? (
          <div
            className="updateBanner"
            style={{
              position: "fixed",
              left: "50%",
              bottom: 20,
              transform: "translateX(-50%)",
              zIndex: 99999,
              width: "calc(100% - 32px)",
              maxWidth: 720,
              background: "#020617",
              color: "#fff",
              padding: "14px 18px",
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              boxShadow: "0 18px 45px rgba(2, 6, 23, 0.35)",
            }}
          >
            <div>
              <strong>Neue FlyMonitor-Version verfügbar</strong>
              <div style={{ opacity: 0.88, fontWeight: 500, marginTop: 2 }}>
                Bitte aktualisieren, um die neueste Version zu nutzen.
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                border: "none",
                borderRadius: 999,
                padding: "10px 16px",
                cursor: "pointer",
                fontWeight: 800,
                background: "#22d3ee",
                color: "#020617",
                whiteSpace: "nowrap",
              }}
            >
              Jetzt aktualisieren
            </button>
          </div>
        ) : null}

        <footer><div><strong>flymonitor.de</strong><p>© 2026 flymonitor.de</p></div><div>
<strong>Rechtliches</strong>
<p>
  <a href="https://www.flymonitor.de/impressum.html" target="_blank" rel="noopener noreferrer">Impressum</a>
  {" · "}
  <a href="https://www.flymonitor.de/datenschutz.html" target="_blank" rel="noopener noreferrer">Datenschutz</a>
  {" · "}
  <a href="/haftungsausschluss.html">Haftungsausschluss</a>
</p>
</div><div><strong>Kostenlose Quellen</strong><p>Open-Meteo · OpenStreetMap · OpenSky · OpenAIP vorbereitet</p></div></footer>
      </div>

    </div>
  );
}



function FlyMonitorAICopilotPro() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: "Hallo, ich bin dein FlyMonitor AI Copilot. Ich kann offene Missionen, Rechnungen, Wartung, Behördenfristen, CRM und Verträge zusammenfassen.",
    },
  ]);

  const readLocal = (keys, fallback = []) => {
    for (const key of keys) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        if (Array.isArray(value)) return value;
        if (value && typeof value === "object") return value;
      } catch {}
    }
    return fallback;
  };

  const getDaysUntil = (value) => {
    if (!value) return null;
    const date = new Date(`${value}T23:59:59`);
    if (Number.isNaN(date.getTime())) return null;
    return Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  };

  const analyzeFlyMonitor = () => {
    const missions = readLocal(["flymonitor_missions", "droneready_missions", "missions"], []);
    const invoices = readLocal(["flymonitor_invoices", "droneready_invoices", "invoices"], []);
    const customers = readLocal(["droneready_customers", "flymonitor_customers", "customers"], []);
    const maintenanceTasks = readLocal(["flymonitor_maintenance_tasks", "droneready_maintenance_tasks"], []);
    const authorityDocs = readLocal(["flymonitor_authority_documents", "authorityDocuments"], []);
    const contracts = readLocal(["flymonitor_contracts", "contracts"], []);
    const offers = readLocal(["flymonitor_offers", "offers"], []);

    const today = new Date().toISOString().slice(0, 10);

    const openMissions = (Array.isArray(missions) ? missions : []).filter((item) =>
      !["abgeschlossen", "erledigt", "storniert"].includes(String(item.status || "").toLowerCase())
    );

    const overdueMissions = openMissions.filter((item) => item.date && item.date < today);

    const openInvoices = (Array.isArray(invoices) ? invoices : []).filter((item) =>
      !["bezahlt", "paid"].includes(String(item.status || "").toLowerCase())
    );

    const overdueInvoices = openInvoices.filter((item) => {
      const due = item.dueDate || item.validUntil || item.dateDue;
      return due && due < today;
    });

    const expiringAuthority = (Array.isArray(authorityDocs) ? authorityDocs : []).filter((item) => {
      const days = getDaysUntil(item.validUntil || item.expiresAt || item.expiryDate);
      return days !== null && days <= 30;
    });

    const expiringContracts = (Array.isArray(contracts) ? contracts : []).filter((item) => {
      const days = getDaysUntil(item.endDate || item.validUntil || item.expiresAt);
      return days !== null && days <= 60;
    });

    const openOffers = (Array.isArray(offers) ? offers : []).filter((item) =>
      ["entwurf", "gesendet", "offen"].includes(String(item.status || "").toLowerCase())
    );

    const urgentMaintenance = (Array.isArray(maintenanceTasks) ? maintenanceTasks : []).filter((item) =>
      ["fällig", "überfällig", "offen", "kritisch"].includes(String(item.status || "").toLowerCase())
    );

    const totalInvoiceVolume = openInvoices.reduce((sum, item) => {
      const amount = Number(item.gross || item.total || item.amount || item.brutto || 0);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    const warnings = [
      overdueMissions.length ? `⚠ ${overdueMissions.length} Mission(en) sind überfällig.` : "",
      overdueInvoices.length ? `⚠ ${overdueInvoices.length} Rechnung(en) sind überfällig.` : "",
      expiringAuthority.length ? `⚠ ${expiringAuthority.length} Behörden-/Versicherungsdokument(e) laufen bald ab.` : "",
      expiringContracts.length ? `⚠ ${expiringContracts.length} Vertrag/Verträge laufen innerhalb von 60 Tagen ab.` : "",
      urgentMaintenance.length ? `⚠ ${urgentMaintenance.length} Wartungsaufgabe(n) sind offen oder kritisch.` : "",
    ].filter(Boolean);

    const recommendations = [
      openOffers.length ? `📦 ${openOffers.length} offene Angebot(e): Nachfassen oder in Auftrag umwandeln.` : "",
      openInvoices.length ? `💰 Offenes Rechnungsvolumen: ${totalInvoiceVolume.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}.` : "",
      customers.length ? `👥 ${customers.length} Kunde(n) im CRM: Top-Kunden und inaktive Kunden prüfen.` : "",
      openMissions.length ? `🚁 ${openMissions.length} offene Mission(en): Prioritäten und Ressourcen prüfen.` : "",
    ].filter(Boolean);

    return {
      missions,
      invoices,
      customers,
      maintenanceTasks,
      authorityDocs,
      contracts,
      offers,
      warnings,
      recommendations,
      summary: [
        `Offene Missionen: ${openMissions.length}`,
        `Überfällige Missionen: ${overdueMissions.length}`,
        `Offene Rechnungen: ${openInvoices.length}`,
        `Überfällige Rechnungen: ${overdueInvoices.length}`,
        `Offene Angebote: ${openOffers.length}`,
        `Bald ablaufende Behördenfristen: ${expiringAuthority.length}`,
        `Bald ablaufende Verträge: ${expiringContracts.length}`,
        `Wartungshinweise: ${urgentMaintenance.length}`,
      ],
    };
  };

  const buildAnswer = (input) => {
    const data = analyzeFlyMonitor();
    const q = String(input || "").toLowerCase();

    if (q.includes("rechnung")) {
      return [
        "💰 Rechnungsanalyse",
        ...data.summary.filter((line) => line.toLowerCase().includes("rechnung")),
        ...data.recommendations.filter((line) => line.includes("💰")),
      ].join("\n");
    }

    if (q.includes("mission")) {
      return [
        "🚁 Missionsanalyse",
        ...data.summary.filter((line) => line.toLowerCase().includes("mission")),
        ...data.recommendations.filter((line) => line.includes("🚁")),
      ].join("\n");
    }

    if (q.includes("vertrag")) {
      return [
        "🧾 Vertragsanalyse",
        ...data.summary.filter((line) => line.toLowerCase().includes("vertrag")),
        "Empfehlung: ablaufende Verträge prüfen und rechtzeitig verlängern oder kündigen.",
      ].join("\n");
    }

    if (q.includes("behörde") || q.includes("frist") || q.includes("versicherung") || q.includes("a2")) {
      return [
        "🏛 Behörden- und Fristenanalyse",
        ...data.summary.filter((line) => line.toLowerCase().includes("behörden")),
        ...data.warnings.filter((line) => line.toLowerCase().includes("behörden") || line.toLowerCase().includes("versicherung")),
      ].join("\n");
    }

    if (q.includes("wartung") || q.includes("akku") || q.includes("drohne")) {
      return [
        "🛠 Wartungsanalyse",
        ...data.summary.filter((line) => line.toLowerCase().includes("wartung")),
        ...data.warnings.filter((line) => line.toLowerCase().includes("wartung")),
      ].join("\n");
    }

    return [
      "🤖 FlyMonitor AI Copilot Übersicht",
      "",
      ...data.summary,
      "",
      "Warnungen:",
      ...(data.warnings.length ? data.warnings : ["✅ Keine kritischen Warnungen erkannt."]),
      "",
      "Empfehlungen:",
      ...(data.recommendations.length ? data.recommendations : ["✅ Keine zusätzlichen Empfehlungen vorhanden."]),
    ].join("\n");
  };

  const ask = () => {
    const trimmed = question.trim();
    if (!trimmed) return;
    const answer = buildAnswer(trimmed);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: trimmed },
      { role: "assistant", text: answer },
    ]);
    setQuestion("");
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          position: "fixed",
          right: 18,
          bottom: 18,
          zIndex: 99998,
          border: "none",
          borderRadius: 999,
          padding: "14px 18px",
          fontWeight: 900,
          cursor: "pointer",
          background: "linear-gradient(135deg,#0f172a,#2563eb)",
          color: "#fff",
          boxShadow: "0 18px 45px rgba(15,23,42,.35)",
        }}
      >
        🤖 AI Copilot
      </button>

      {open ? (
        <div
          style={{
            position: "fixed",
            right: 18,
            bottom: 78,
            zIndex: 99998,
            width: "min(420px, calc(100vw - 36px))",
            maxHeight: "70vh",
            background: "#fff",
            color: "#0f172a",
            borderRadius: 24,
            border: "1px solid #dbeafe",
            boxShadow: "0 24px 70px rgba(15,23,42,.28)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 16, background: "linear-gradient(135deg,#eff6ff,#ecfeff)", borderBottom: "1px solid #dbeafe" }}>
            <strong>🤖 FlyMonitor AI Copilot Pro</strong>
            <p style={{ margin: "6px 0 0", color: "#475569", fontSize: 13 }}>
              Analysiert Missionen, Rechnungen, Verträge, Wartung, CRM und Behördenfristen lokal aus deiner App.
            </p>
          </div>

          <div style={{ padding: 14, maxHeight: "42vh", overflow: "auto" }}>
            {messages.map((message, index) => (
              <div
                key={index}
                style={{
                  marginBottom: 10,
                  padding: 12,
                  borderRadius: 16,
                  background: message.role === "assistant" ? "#f8fafc" : "#dbeafe",
                  border: "1px solid #e2e8f0",
                  whiteSpace: "pre-wrap",
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
              >
                <strong>{message.role === "assistant" ? "Copilot" : "Du"}:</strong>
                <br />
                {message.text}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #e2e8f0" }}>
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") ask();
              }}
              placeholder="z.B. Welche Rechnungen sind offen?"
              style={{
                flex: 1,
                border: "1px solid #cbd5e1",
                borderRadius: 12,
                padding: "10px 12px",
              }}
            />
            <button
              type="button"
              onClick={ask}
              style={{
                border: "none",
                borderRadius: 12,
                padding: "10px 14px",
                background: "#2563eb",
                color: "#fff",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Fragen
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}


function FlyMonitorCommercialReleasePro() {
  const [license, setLicense] = useState(() =>
    safeLoad("flymonitor_commercial_license", {
      key: "",
      plan: "Professional",
      status: "Testversion",
      expiresAt: "",
      activatedAt: "",
      companyName: "FlyMonitor",
    })
  );

  const [branding, setBranding] = useState(() =>
    safeLoad("flymonitor_white_label_settings", {
      logoUrl: "",
      primaryColor: "#0f172a",
      accentColor: "#2563eb",
      domain: "",
      emailLayout: "Standard",
      pdfLayout: "FlyMonitor Pro",
      customerPortalBranding: true,
    })
  );

  const [apiKeys, setApiKeys] = useState(() =>
    safeLoad("flymonitor_api_keys", [
      {
        id: "api-demo-main",
        name: "Haupt-API",
        keyPreview: "fm_live_••••••••",
        scopes: ["CRM", "Missionen", "Rechnungen", "Dokumente"],
        rateLimit: "1000 / Stunde",
        status: "Aktiv",
        createdAt: new Date().toLocaleDateString("de-DE"),
      },
    ])
  );

  const [deployments, setDeployments] = useState(() =>
    safeLoad("flymonitor_deployments", [
      {
        id: "deploy-local",
        name: "Produktivsystem",
        type: "Server / Webhosting",
        version: "RC3",
        status: "Bereit",
        lastUpdate: new Date().toLocaleDateString("de-DE"),
      },
    ])
  );

  const commercialStats = useMemo(() => {
    const activeApiKeys = (apiKeys || []).filter((item) => item.status === "Aktiv").length;
    const activeDeployments = (deployments || []).filter((item) => item.status !== "Fehler").length;
    return {
      plan: license.plan || "Professional",
      status: license.status || "Testversion",
      apiKeys: apiKeys.length,
      activeApiKeys,
      deployments: deployments.length,
      activeDeployments,
    };
  }, [apiKeys, deployments, license]);

  function persistLicense(next) {
    setLicense(next);
    localStorage.setItem("flymonitor_commercial_license", JSON.stringify(next));
    writeAuditLog("Commercial Release Lizenz aktualisiert", { plan: next.plan, status: next.status });
  }

  function persistBranding(next) {
    setBranding(next);
    localStorage.setItem("flymonitor_white_label_settings", JSON.stringify(next));
    writeAuditLog("White Label Einstellungen aktualisiert", { domain: next.domain, pdfLayout: next.pdfLayout });
  }

  function createApiKey() {
    const nextKey = {
      id: `api-${Date.now()}`,
      name: `API Key ${apiKeys.length + 1}`,
      keyPreview: `fm_live_${Math.random().toString(36).slice(2, 6)}••••`,
      scopes: ["CRM", "Missionen"],
      rateLimit: "500 / Stunde",
      status: "Aktiv",
      createdAt: new Date().toLocaleDateString("de-DE"),
    };
    const next = [nextKey, ...apiKeys];
    setApiKeys(next);
    localStorage.setItem("flymonitor_api_keys", JSON.stringify(next));
    writeAuditLog("API Key erstellt", { name: nextKey.name });
  }

  function createDeploymentSnapshot() {
    const nextDeployment = {
      id: `deploy-${Date.now()}`,
      name: "Release Snapshot",
      type: "Backup / Rollback",
      version: `Build ${new Date().toISOString().slice(0, 10)}`,
      status: "Bereit",
      lastUpdate: new Date().toLocaleString("de-DE"),
    };
    const next = [nextDeployment, ...deployments].slice(0, 20);
    setDeployments(next);
    localStorage.setItem("flymonitor_deployments", JSON.stringify(next));
    writeAuditLog("Deployment Snapshot erstellt", { version: nextDeployment.version });
  }

  return (
    <section className="card" style={{ marginTop: 24, border: "2px solid #c7d2fe" }}>
      <div className="sectionHead">
        <div>
          <p className="label">Commercial Release Pro</p>
          <h2>🏆 Lizenz, White Label, API & Deployment</h2>
          <p>Bereitet FlyMonitor für kommerzielle Nutzung, Kundeninstallationen und Enterprise-Betrieb vor.</p>
        </div>
      </div>

      <div className="grid metrics">
        <Metric icon={ShieldCheck} title="Tarif" value={commercialStats.plan} text={commercialStats.status} tone="good" />
        <Metric icon={Layers} title="API Keys" value={commercialStats.apiKeys} text={`${commercialStats.activeApiKeys} aktiv`} />
        <Metric icon={Cloud} title="Deployments" value={commercialStats.deployments} text={`${commercialStats.activeDeployments} bereit`} />
        <Metric icon={Gauge} title="Release" value="RC3" text="Commercial vorbereitet" tone="good" />
      </div>

      <div className="grid two" style={{ marginTop: 18 }}>
        <div className="card soft">
          <h3>Lizenzverwaltung</h3>
          <div className="grid two">
            <label>
              Lizenzschlüssel
              <input
                value={license.key}
                placeholder="FM-XXXX-XXXX"
                onChange={(event) => persistLicense({ ...license, key: event.target.value })}
              />
            </label>
            <label>
              Tarif
              <select value={license.plan} onChange={(event) => persistLicense({ ...license, plan: event.target.value })}>
                {["Starter", "Professional", "Business", "Enterprise"].map((plan) => (
                  <option key={plan}>{plan}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={license.status} onChange={(event) => persistLicense({ ...license, status: event.target.value })}>
                {["Aktiv", "Testversion", "Abgelaufen", "Gesperrt"].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
            <label>
              Ablaufdatum
              <input type="date" value={license.expiresAt} onChange={(event) => persistLicense({ ...license, expiresAt: event.target.value })} />
            </label>
          </div>
        </div>

        <div className="card soft">
          <h3>White Label Pro</h3>
          <div className="grid two">
            <label>
              Firmenname
              <input value={license.companyName} onChange={(event) => persistLicense({ ...license, companyName: event.target.value })} />
            </label>
            <label>
              Domain
              <input value={branding.domain} placeholder="app.meine-domain.de" onChange={(event) => persistBranding({ ...branding, domain: event.target.value })} />
            </label>
            <label>
              Primärfarbe
              <input value={branding.primaryColor} onChange={(event) => persistBranding({ ...branding, primaryColor: event.target.value })} />
            </label>
            <label>
              PDF Layout
              <input value={branding.pdfLayout} onChange={(event) => persistBranding({ ...branding, pdfLayout: event.target.value })} />
            </label>
          </div>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 18 }}>
        <div className="card soft">
          <div className="sectionHead">
            <div>
              <h3>API Center</h3>
              <p>REST-API-Vorbereitung für CRM, Missionen, Angebote, Rechnungen, Verträge und Dokumente.</p>
            </div>
            <button type="button" onClick={createApiKey}>API Key erzeugen</button>
          </div>
          <div className="list">
            {apiKeys.map((item) => (
              <div className="listitem" key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.keyPreview} · {item.status} · {item.rateLimit}</span>
                <small>{(item.scopes || []).join(", ")}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="card soft">
          <div className="sectionHead">
            <div>
              <h3>Deployment Center</h3>
              <p>Installationen, Versionen, Rollback und Release Notes verwalten.</p>
            </div>
            <button type="button" onClick={createDeploymentSnapshot}>Snapshot</button>
          </div>
          <div className="list">
            {deployments.map((item) => (
              <div className="listitem" key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.type} · {item.version} · {item.status}</span>
                <small>Letztes Update: {item.lastUpdate}</small>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card soft" style={{ marginTop: 18 }}>
        <h3>Monitoring Dashboard</h3>
        <div className="grid four">
          <div className="listitem"><strong>Benutzer</strong><span>über Rollen & Rechte</span></div>
          <div className="listitem"><strong>Backups</strong><span>über Cloud Sync Pro</span></div>
          <div className="listitem"><strong>API Nutzung</strong><span>Rate Limits vorbereitet</span></div>
          <div className="listitem"><strong>Audit</strong><span>kritische Aktionen protokolliert</span></div>
        </div>
      </div>
    </section>
  );
}


function FlyMonitorReleaseCandidateRC1Pro() {
  const rcModules = [
    { name: "CRM Pro", status: "Bereit", area: "Kunden" },
    { name: "Rechnungen Pro", status: "Bereit", area: "Finanzen" },
    { name: "Analytics Pro", status: "Bereit", area: "Auswertung" },
    { name: "Wartung Pro", status: "Bereit", area: "Technik" },
    { name: "Rollen & Rechte Pro", status: "Bereit", area: "Security" },
    { name: "Behörden-Center Pro", status: "Bereit", area: "Compliance" },
    { name: "Security Pro", status: "Bereit", area: "Security" },
    { name: "Cloud Sync Pro", status: "Bereit", area: "Backup" },
    { name: "PWA Mobile Pro", status: "Bereit", area: "Mobile" },
    { name: "Customer Portal Pro", status: "Bereit", area: "Portal" },
    { name: "Quote / Offer Pro", status: "Bereit", area: "Vertrieb" },
    { name: "Contract Pro", status: "Bereit", area: "Verträge" },
    { name: "AI Copilot Pro", status: "Bereit", area: "KI" },
    { name: "Commercial Release Pro", status: "Bereit", area: "Release" },
  ];

  const rcChecks = [
    { title: "Build prüfen", status: "Offen", note: "npm run build ausführen und Fehler bereinigen" },
    { title: "Navigation prüfen", status: "Offen", note: "Alle Menüpunkte öffnen und Scroll-/Layoutfehler prüfen" },
    { title: "Formulare prüfen", status: "Offen", note: "CRM, Angebote, Verträge, Rechnungen und Wartung testen" },
    { title: "PWA prüfen", status: "Offen", note: "Manifest und Service Worker im public-Ordner testen" },
    { title: "Backup prüfen", status: "Offen", note: "Cloud Sync Export und Restore simulieren" },
    { title: "Rechte prüfen", status: "Offen", note: "Admin, Pilot, Kunde, Behörde und Gast testen" },
    { title: "Audit Log prüfen", status: "Offen", note: "Kritische Aktionen müssen protokolliert werden" },
    { title: "Deployment prüfen", status: "Offen", note: "API-Pfade, Upload-Ordner und HTTPS prüfen" },
  ];

  const readyCount = rcModules.filter((item) => item.status === "Bereit").length;
  const progress = Math.round((readyCount / rcModules.length) * 100);

  const badgeStyle = {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "6px 10px",
    fontWeight: 800,
    background: "#dcfce7",
    color: "#166534",
    border: "1px solid #22c55e",
  };

  return (
    <section id="release-candidate-rc1" className="card" style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <p className="label">FlyMonitor Enterprise</p>
          <h2>🚀 Release Candidate RC1</h2>
          <p>
            Zentrale Release-Statusseite für Modulübersicht, Systemprüfung, offene Aufgaben,
            Deployment-Check, Backup-Check, PWA-Check und Sicherheitsprüfung.
          </p>
        </div>
        <div style={{ minWidth: 180 }}>
          <span style={badgeStyle}>{progress}% Modulbereit</span>
          <p style={{ marginTop: 8, fontWeight: 800 }}>{readyCount} von {rcModules.length} Modulen markiert</p>
        </div>
      </div>

      <div className="grid four" style={{ marginTop: 18 }}>
        <div className="card metric good">
          <div>
            <p className="label">Module</p>
            <h3>{rcModules.length}</h3>
            <p>RC1-Funktionsumfang</p>
          </div>
        </div>
        <div className="card metric warning">
          <div>
            <p className="label">Offene Checks</p>
            <h3>{rcChecks.length}</h3>
            <p>Vor Produktivsetzung prüfen</p>
          </div>
        </div>
        <div className="card metric good">
          <div>
            <p className="label">Release</p>
            <h3>RC1</h3>
            <p>Stabilisierungsphase</p>
          </div>
        </div>
        <div className="card metric">
          <div>
            <p className="label">Nächstes Ziel</p>
            <h3>Production</h3>
            <p>Build, Tests, Deployment</p>
          </div>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 18 }}>
        <div className="card soft">
          <h3>Modulübersicht</h3>
          <div className="list">
            {rcModules.map((item) => (
              <div className="listitem" key={item.name}>
                <strong>{item.name}</strong>
                <span>{item.area} · {item.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card soft">
          <h3>RC1-Abnahmeliste</h3>
          <div className="list">
            {rcChecks.map((item) => (
              <div className="listitem" key={item.title}>
                <strong>{item.title}</strong>
                <span>{item.status} · {item.note}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card soft" style={{ marginTop: 18 }}>
        <h3>Deployment-Check</h3>
        <div className="grid four">
          <div className="listitem"><strong>HTTPS</strong><span>Pflicht für PWA, Kamera, GPS und Service Worker</span></div>
          <div className="listitem"><strong>API-Pfade</strong><span>/api/*.php auf Server prüfen</span></div>
          <div className="listitem"><strong>Uploads</strong><span>Schreibrechte und Dateigrößen prüfen</span></div>
          <div className="listitem"><strong>Backup</strong><span>Cloud Sync und Restore testen</span></div>
        </div>
      </div>
    </section>
  );
}


function FlyMonitorBugfixStabilizationPro() {
  const stabilityChecks = [
    { area: "Build", title: "npm run build ausführen", status: "Offen", note: "Produktions-Build ohne Syntaxfehler prüfen." },
    { area: "Imports", title: "Ungenutzte Imports prüfen", status: "Offen", note: "Lucide-Icons und Komponenten bereinigen." },
    { area: "State", title: "Doppelte States zusammenführen", status: "Offen", note: "LocalStorage-Keys und useState-Strukturen vereinheitlichen." },
    { area: "Navigation", title: "Module konsolidieren", status: "Offen", note: "Alle Pro-Module im Admin-/Dashboard-Menü sauber verlinken." },
    { area: "Security", title: "Rechteprüfung testen", status: "Offen", note: "Rollenrechte für CRM, Rechnungen, Behörden, Cloud und Admin prüfen." },
    { area: "PWA", title: "Service Worker prüfen", status: "Offen", note: "Cache, Manifest, Offline-Fallback und HTTPS testen." },
    { area: "API", title: "PHP-Endpunkte prüfen", status: "Offen", note: "admin-auth, users, backup, audit-log, uploads und completed-flights testen." },
    { area: "Release", title: "Release Notes erstellen", status: "Offen", note: "Änderungen und bekannte Einschränkungen dokumentieren." },
  ];

  const duplicateRiskItems = [
    "Mehrfach angelegte Pro-Komponenten am Dateiende prüfen",
    "LocalStorage-Keys mit Prefix flymonitor_* vereinheitlichen",
    "Demo-Daten klar von echten Produktivdaten trennen",
    "PDF-Export und Upload-Funktionen mit großen Dateien testen",
    "Mobile Browser: iOS Safari und Android Chrome separat prüfen",
  ];

  const buildReadiness = [
    { label: "Syntax", value: "prüfen" },
    { label: "Imports", value: "bereinigen" },
    { label: "States", value: "ordnen" },
    { label: "APIs", value: "testen" },
  ];

  return (
    <section className="section" id="bugfix-stabilization-pro">
      <div className="sectionHead">
        <div>
          <p className="eyebrow">App_87_BUGFIX_STABILIZATION</p>
          <h2>🧰 Bugfix & Stabilisierung</h2>
          <p>
            Zentrale Qualitätskontrolle vor dem produktiven Deployment: Build-Check,
            Navigation, doppelte States, Imports, PWA, APIs und Release-Aufgaben.
          </p>
        </div>
        <span className="pill">RC1 → Production</span>
      </div>

      <div className="grid four" style={{ marginTop: 18 }}>
        {buildReadiness.map((item) => (
          <div className="card metric warning" key={item.label}>
            <div>
              <p className="label">{item.label}</p>
              <h3>{item.value}</h3>
              <p>vor Deployment</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid two" style={{ marginTop: 18 }}>
        <div className="card soft">
          <h3>Stabilitäts-Checkliste</h3>
          <div className="list">
            {stabilityChecks.map((item) => (
              <div className="listitem" key={`${item.area}-${item.title}`}>
                <strong>{item.area}: {item.title}</strong>
                <span>{item.status} · {item.note}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card soft">
          <h3>Technische Risiken</h3>
          <div className="list">
            {duplicateRiskItems.map((item) => (
              <div className="listitem" key={item}>
                <strong>Prüfpunkt</strong>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card soft" style={{ marginTop: 18 }}>
        <h3>Empfohlene Reihenfolge</h3>
        <div className="grid four">
          <div className="listitem"><strong>1. Build</strong><span>npm install und npm run build ausführen</span></div>
          <div className="listitem"><strong>2. UI-Test</strong><span>Alle Hauptmodule im Browser öffnen</span></div>
          <div className="listitem"><strong>3. API-Test</strong><span>Speichern, Uploads, Backup und Login prüfen</span></div>
          <div className="listitem"><strong>4. Release</strong><span>Produktivpaket mit Manifest und Service Worker erstellen</span></div>
        </div>
      </div>
    </section>
  );
}



function FlyMonitorProductionDeploymentPro() {
  const deploymentChecks = [
    { title: "Build prüfen", text: "npm run build ohne Fehler ausführen", status: "Offen" },
    { title: "App.jsx finalisieren", text: "Aktuelle integrierte App als Produktionsbasis verwenden", status: "Bereit" },
    { title: "PWA Manifest", text: "manifest.flymonitor.webmanifest im public-Ordner bereitstellen", status: "Bereit" },
    { title: "Service Worker", text: "flymonitor-service-worker.js registrieren und Offline-Cache testen", status: "Bereit" },
    { title: "Backup testen", text: "Backup und Restore mit Echtdaten prüfen", status: "Offen" },
    { title: "Security prüfen", text: "Admin-Login, Session, Audit-Log und Rollen testen", status: "Offen" },
    { title: "Cloud Sync prüfen", text: "Cloud-Ziele und Fehlermeldungen validieren", status: "Offen" },
    { title: "Release Notes", text: "Version, Module und bekannte Hinweise dokumentieren", status: "Bereit" },
  ];

  const packageFiles = [
    "App.jsx",
    "manifest.flymonitor.webmanifest",
    "flymonitor-service-worker.js",
    "README_DEPLOYMENT.md",
    "RELEASE_NOTES.md",
    ".env.production.example",
  ];

  const deploymentSteps = [
    "Abhängigkeiten installieren: npm install",
    "Produktions-Build erstellen: npm run build",
    "dist/ oder build/ auf Server hochladen",
    "API-Endpunkte und .env.production prüfen",
    "public/manifest.flymonitor.webmanifest und Service Worker bereitstellen",
    "HTTPS aktivieren, danach PWA und Offline-Modus testen",
  ];

  return (
    <section className="section" id="production-deployment-pro">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">App_88</p>
          <h2>🚀 Production Deployment</h2>
          <p>
            Finaler Deployment-Bereich für FlyMonitor Enterprise RC1 mit Produktions-Checkliste,
            PWA-Dateien, Release Notes und Installationsschritten.
          </p>
        </div>
        <Status status="good">Deployment vorbereitet</Status>
      </div>

      <div className="grid three">
        <Metric icon={CheckCircle2} title="Checks" value={deploymentChecks.length} text="Produktionsprüfungen" tone="good" />
        <Metric icon={UploadCloud} title="Paketdateien" value={packageFiles.length} text="Benötigte Release-Dateien" tone="warning" />
        <Metric icon={ShieldCheck} title="Release" value="RC1" text="FlyMonitor Enterprise" tone="good" />
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Produktions-Checkliste</h3>
          <div className="list">
            {deploymentChecks.map((item, index) => (
              <div className="listitem" key={index}>
                <strong>{item.title}</strong>
                <span>{item.text}</span>
                <small>{item.status}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>Release-Paket</h3>
          <div className="list">
            {packageFiles.map((file) => (
              <div className="listitem" key={file}>
                <strong>{file}</strong>
                <span>Für das finale Deployment-Paket vorgesehen</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Installationsschritte</h3>
        <div className="list">
          {deploymentSteps.map((step, index) => (
            <div className="listitem" key={index}>
              <strong>{index + 1}. Schritt</strong>
              <span>{step}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Release Notes – FlyMonitor Enterprise RC1</h3>
        <p>
          Enthält CRM, Rechnungen, Analytics, Wartung, Rollen & Rechte, Behörden-Center,
          Security, Cloud Sync, PWA Mobile, KI-Assistent, Customer Portal, Angebote,
          Verträge, Commercial Release, RC1-Check und Bugfix-Stabilisierung.
        </p>
      </div>
    </section>
  );
}



// === APP_89_FINAL_RELEASE_PACKAGE_INTEGRATED ===

const FINAL_RELEASE_PACKAGE_ITEMS_PRO = [
  { area: "Kernsystem", item: "App.jsx Enterprise Version", status: "Bereit" },
  { area: "PWA", item: "manifest.flymonitor.webmanifest", status: "Bereit" },
  { area: "PWA", item: "flymonitor-service-worker.js", status: "Bereit" },
  { area: "Dokumentation", item: "README.md", status: "Vorbereitet" },
  { area: "Dokumentation", item: "INSTALLATION.md", status: "Vorbereitet" },
  { area: "Dokumentation", item: "CHANGELOG.md", status: "Vorbereitet" },
  { area: "Dokumentation", item: "RELEASE_NOTES.md", status: "Vorbereitet" },
  { area: "Deployment", item: "Backup-/Restore-Check", status: "Prüfen" },
  { area: "Deployment", item: "Security-/Rechteprüfung", status: "Prüfen" },
  { area: "Deployment", item: "PWA-/Offline-Test", status: "Prüfen" },
];

const FINAL_RELEASE_MODULES_PRO = [
  "CRM Pro",
  "Rechnungen Pro",
  "Analytics Pro",
  "Wartung Pro",
  "Rollen & Rechte Pro",
  "Behörden-Center Pro",
  "Security Pro",
  "Cloud Sync Pro",
  "PWA Mobile Pro",
  "KI-Assistent Pro",
  "Team Collaboration Pro",
  "Business Intelligence Pro",
  "Fleet Management Pro",
  "Document Management Pro",
  "Customer Portal Pro",
  "Quote / Offer Pro",
  "Contract Pro",
  "AI Copilot Pro",
  "Commercial Release Pro",
  "RC1 Release Check",
  "Bugfix Stabilization",
  "Production Deployment",
];

function FinalReleasePackagePro() {
  const readyCount = FINAL_RELEASE_PACKAGE_ITEMS_PRO.filter((item) => item.status === "Bereit").length;
  const preparedCount = FINAL_RELEASE_PACKAGE_ITEMS_PRO.filter((item) => item.status === "Vorbereitet").length;
  const checkCount = FINAL_RELEASE_PACKAGE_ITEMS_PRO.filter((item) => item.status === "Prüfen").length;

  return (
    <section className="card" style={{ marginTop: 24, border: "2px solid #22c55e" }}>
      <div className="sectionHead">
        <div>
          <p className="eyebrow">App_89_FINAL_RELEASE_PACKAGE</p>
          <h2>📦 Final Release Package</h2>
          <p>
            Zentrale Übersicht für das finale FlyMonitor Enterprise Release-Paket mit App-Datei,
            PWA-Dateien, Dokumentation, Deployment-Check und Release-Status.
          </p>
        </div>
        <Status status="good">Release-Paket vorbereitet</Status>
      </div>

      <div className="grid3">
        <Metric icon={CheckCircle2} title="Bereit" value={readyCount} text="Dateien oder Bereiche fertig vorbereitet" tone="good" />
        <Metric icon={Layers} title="Vorbereitet" value={preparedCount} text="Dokumentation oder Struktur vorhanden" />
        <Metric icon={AlertTriangle} title="Noch prüfen" value={checkCount} text="Tests vor Livegang durchführen" tone="warning" />
      </div>

      <h3>Release-Inhalt</h3>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Bereich</th>
              <th>Element</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {FINAL_RELEASE_PACKAGE_ITEMS_PRO.map((item, index) => (
              <tr key={`${item.area}-${item.item}-${index}`}>
                <td>{item.area}</td>
                <td>{item.item}</td>
                <td>
                  <Status status={item.status === "Prüfen" ? "warning" : "good"}>
                    {item.status}
                  </Status>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Enthaltene Enterprise-Module</h3>
      <div className="pillGrid">
        {FINAL_RELEASE_MODULES_PRO.map((module) => (
          <span className="pill" key={module}>✅ {module}</span>
        ))}
      </div>

      <h3>Deployment-Checkliste</h3>
      <ul className="checkList">
        <li>Aktuelle App.jsx als produktive Version sichern.</li>
        <li>manifest.flymonitor.webmanifest in den public-Ordner legen.</li>
        <li>flymonitor-service-worker.js in den public-Ordner legen.</li>
        <li>Build lokal testen und Konsolenfehler prüfen.</li>
        <li>Backup vor Deployment erstellen.</li>
        <li>Admin-Login, Rollen, PWA, Cloud Sync und PDF-Export testen.</li>
      </ul>
    </section>
  );
}




function FlyMonitorCustomerPortalLinkedPro() {
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="sectionHead">
        <div>
          <p className="eyebrow">Customer Portal</p>
          <h2>🌐 Kundenportal</h2>
          <p>Geschützter Kundenbereich für Projektstatus, Dokumente, Rechnungen und Freigaben.</p>
        </div>
        <Status status="good">Portal vorbereitet</Status>
      </div>

      <div className="grid3">
        <Metric icon={Eye} title="Projektansicht" value="Aktiv" text="Kunden können Projekte und Status einsehen." />
        <Metric icon={Download} title="Downloads" value="PDF" text="Berichte, Rechnungen und Dokumente vorbereiten." />
        <Metric icon={ShieldCheck} title="Zugang" value="Portalcode" text="Geschützte Ansicht per Kundenportal-Code." tone="good" />
      </div>

      <div className="card">
        <h3>Portal-Funktionen</h3>
        <ul className="checkList">
          <li>Projekt- und Missionsstatus anzeigen</li>
          <li>Rechnungen und Dokumente bereitstellen</li>
          <li>Kundenfreigaben vorbereiten</li>
          <li>Portalcode je Kunde nutzen</li>
        </ul>
      </div>
    </section>
  );
}





function ContractFormSafeProfessionalStyles() {
  return (
    <style>{`
      /* RC2 safe styling: verbessert Vertragsformulare ohne JSX-Umbau */
      .card h3 + label,
      .card h3 + input,
      .card h3 + select {
        margin-top: 14px;
      }

      .card input,
      .card select,
      .card textarea {
        min-height: 40px;
        border-radius: 12px;
        border: 1px solid #cbd5e1;
        padding: 9px 11px;
        margin: 5px 8px 9px 0;
        background: #fff;
        color: #0f172a;
        font-size: 14px;
        vertical-align: middle;
      }

      .card textarea {
        min-height: 78px;
        min-width: 260px;
        resize: vertical;
      }

      .card input:focus,
      .card select:focus,
      .card textarea:focus {
        outline: none;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,.12);
      }

      .card button {
        margin: 8px 8px 0 0;
      }

      @media (max-width: 900px) {
        .card input,
        .card select,
        .card textarea {
          width: 100%;
          max-width: 100%;
          display: block;
        }
      }
    `}</style>
  );
}


export default function App() {
  return (
    <AppErrorBoundary>
      <ContractFormSafeProfessionalStyles />
      <AppContent />
    </AppErrorBoundary>
  );
}


