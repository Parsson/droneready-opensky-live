import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEYS = {
  members: "club_members",
  flights: "club_flights",
  events: "club_events",
  notices: "club_notices",
};

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export default function DroneClub() {
  const isAdmin =
    sessionStorage.getItem("droneready_admin_unlocked") === "true";

  const [activeTab, setActiveTab] = useState("flights");

  const [members, setMembers] = useState([]);
  const [flights, setFlights] = useState([]);
  const [events, setEvents] = useState([]);
  const [notices, setNotices] = useState([]);

  const [memberName, setMemberName] = useState("");
  const [flightLocation, setFlightLocation] = useState("");
  const [flightDate, setFlightDate] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeText, setNoticeText] = useState("");

  useEffect(() => {
    setMembers(load(STORAGE_KEYS.members, []));
    setFlights(load(STORAGE_KEYS.flights, []));
    setEvents(load(STORAGE_KEYS.events, []));
    setNotices(load(STORAGE_KEYS.notices, []));
  }, []);

  useEffect(() => save(STORAGE_KEYS.members, members), [members]);
  useEffect(() => save(STORAGE_KEYS.flights, flights), [flights]);
  useEffect(() => save(STORAGE_KEYS.events, events), [events]);
  useEffect(() => save(STORAGE_KEYS.notices, notices), [notices]);

  const stats = useMemo(
    () => ({
      members: members.length,
      flights: flights.length,
      events: events.length,
      notices: notices.length,
    }),
    [members, flights, events, notices]
  );

  const addMember = () => {
    if (!memberName.trim()) return;
    setMembers([
      ...members,
      {
        id: Date.now(),
        name: memberName.trim(),
        role: "Mitglied",
        joinedAt: new Date().toLocaleDateString("de-DE"),
      },
    ]);
    setMemberName("");
  };

  const addFlight = () => {
    if (!flightLocation.trim() || !flightDate) return;
    setFlights([
      ...flights,
      {
        id: Date.now(),
        location: flightLocation.trim(),
        date: flightDate,
        description: "",
      },
    ]);
    setFlightLocation("");
    setFlightDate("");
  };

  const addEvent = () => {
    if (!eventTitle.trim() || !eventDate) return;
    setEvents([
      ...events,
      {
        id: Date.now(),
        title: eventTitle.trim(),
        date: eventDate,
        location: eventLocation.trim(),
      },
    ]);
    setEventTitle("");
    setEventDate("");
    setEventLocation("");
  };

  const addNotice = () => {
    if (!noticeTitle.trim()) return;
    setNotices([
      {
        id: Date.now(),
        title: noticeTitle.trim(),
        text: noticeText.trim(),
        createdAt: new Date().toLocaleDateString("de-DE"),
      },
      ...notices,
    ]);
    setNoticeTitle("");
    setNoticeText("");
  };

  return (
    <section style={{ padding: 24 }}>
      <h2>🚁 Drohnenclub</h2>
      <p style={{ opacity: 0.75 }}>
        Öffentliche Clubinformationen, Termine und Flugaktivitäten.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, margin: "18px 0" }}>
        <Stat label="Clubflüge" value={stats.flights} />
        <Stat label="Events" value={stats.events} />
        <Stat label="Beiträge" value={stats.notices} />
        {isAdmin && <Stat label="Mitglieder" value={stats.members} />}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <button onClick={() => setActiveTab("flights")}>🛩️ Clubflüge</button>
        <button onClick={() => setActiveTab("events")}>📅 Veranstaltungen</button>
        <button onClick={() => setActiveTab("notices")}>📌 Schwarzes Brett</button>
        {isAdmin && (
          <button onClick={() => setActiveTab("members")}>👥 Mitglieder</button>
        )}
      </div>

      {activeTab === "flights" && (
        <Panel title="🛩️ Clubflüge">
          {isAdmin && (
            <FormRow>
              <input value={flightLocation} onChange={(e) => setFlightLocation(e.target.value)} placeholder="Ort" />
              <input type="date" value={flightDate} onChange={(e) => setFlightDate(e.target.value)} />
              <button onClick={addFlight}>Hinzufügen</button>
            </FormRow>
          )}

          {flights.length === 0 && <Empty text="Noch keine Clubflüge eingetragen." />}

          {flights.map((flight) => (
            <Card key={flight.id}>
              <strong>{flight.date}</strong> – {flight.location}
              {isAdmin && (
                <button onClick={() => setFlights(flights.filter((f) => f.id !== flight.id))}>
                  Löschen
                </button>
              )}
            </Card>
          ))}
        </Panel>
      )}

      {activeTab === "events" && (
        <Panel title="📅 Veranstaltungen">
          {isAdmin && (
            <FormRow>
              <input value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} placeholder="Titel" />
              <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
              <input value={eventLocation} onChange={(e) => setEventLocation(e.target.value)} placeholder="Ort" />
              <button onClick={addEvent}>Hinzufügen</button>
            </FormRow>
          )}

          {events.length === 0 && <Empty text="Noch keine Veranstaltungen geplant." />}

          {events.map((event) => (
            <Card key={event.id}>
              <strong>{event.title}</strong>
              <br />
              {event.date} {event.location && `– ${event.location}`}
              {isAdmin && (
                <button onClick={() => setEvents(events.filter((e) => e.id !== event.id))}>
                  Löschen
                </button>
              )}
            </Card>
          ))}
        </Panel>
      )}

      {activeTab === "notices" && (
        <Panel title="📌 Schwarzes Brett">
          {isAdmin && (
            <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
              <input value={noticeTitle} onChange={(e) => setNoticeTitle(e.target.value)} placeholder="Titel" />
              <textarea value={noticeText} onChange={(e) => setNoticeText(e.target.value)} placeholder="Nachricht" rows={3} />
              <button onClick={addNotice}>Veröffentlichen</button>
            </div>
          )}

          {notices.length === 0 && <Empty text="Noch keine Beiträge vorhanden." />}

          {notices.map((notice) => (
            <Card key={notice.id}>
              <strong>{notice.title}</strong>
              <p>{notice.text}</p>
              <small>{notice.createdAt}</small>
              {isAdmin && (
                <button onClick={() => setNotices(notices.filter((n) => n.id !== notice.id))}>
                  Löschen
                </button>
              )}
            </Card>
          ))}
        </Panel>
      )}

      {isAdmin && activeTab === "members" && (
        <Panel title="👥 Mitglieder">
          <FormRow>
            <input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder="Mitgliedsname" />
            <button onClick={addMember}>Hinzufügen</button>
          </FormRow>

          {members.length === 0 && <Empty text="Noch keine Mitglieder eingetragen." />}

          {members.map((member) => (
            <Card key={member.id}>
              <strong>{member.name}</strong>
              <br />
              {member.role} · seit {member.joinedAt}
              <button onClick={() => setMembers(members.filter((m) => m.id !== member.id))}>
                Löschen
              </button>
            </Card>
          ))}
        </Panel>
      )}
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ padding: 14, border: "1px solid #dbe3ef", borderRadius: 14 }}>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
      <div style={{ opacity: 0.75 }}>{label}</div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{ border: "1px solid #dbe3ef", borderRadius: 18, padding: 18, background: "#fff" }}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Card({ children }) {
  return (
    <div style={{ padding: 14, marginBottom: 10, border: "1px solid #e5e7eb", borderRadius: 12 }}>
      {children}
    </div>
  );
}

function FormRow({ children }) {
  return <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>{children}</div>;
}

function Empty({ text }) {
  return <p style={{ opacity: 0.65 }}>{text}</p>;
}