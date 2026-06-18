import React, { useEffect, useMemo, useState } from "react";

const STORAGE_KEYS = {
  members: "club_members",
  flights: "club_flights",
  events: "club_events",
  notices: "club_notices",
  drones: "club_drones",
  places: "club_places",
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
  const [drones, setDrones] = useState([]);
  const [places, setPlaces] = useState([]);

  const [memberName, setMemberName] = useState("");
  const [flightLocation, setFlightLocation] = useState("");
  const [flightDate, setFlightDate] = useState("");
  const [flightPilot, setFlightPilot] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventLocation, setEventLocation] = useState("");
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeText, setNoticeText] = useState("");
  const [droneName, setDroneName] = useState("");
  const [droneOwner, setDroneOwner] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [placeLocation, setPlaceLocation] = useState("");

  useEffect(() => {
    setMembers(load(STORAGE_KEYS.members, []));
    setFlights(load(STORAGE_KEYS.flights, []));
    setEvents(load(STORAGE_KEYS.events, []));
    setNotices(load(STORAGE_KEYS.notices, []));
    setDrones(load(STORAGE_KEYS.drones, []));
    setPlaces(load(STORAGE_KEYS.places, []));
  }, []);

  useEffect(() => save(STORAGE_KEYS.members, members), [members]);
  useEffect(() => save(STORAGE_KEYS.flights, flights), [flights]);
  useEffect(() => save(STORAGE_KEYS.events, events), [events]);
  useEffect(() => save(STORAGE_KEYS.notices, notices), [notices]);
  useEffect(() => save(STORAGE_KEYS.drones, drones), [drones]);
  useEffect(() => save(STORAGE_KEYS.places, places), [places]);

  const stats = useMemo(
    () => ({
      members: members.length,
      flights: flights.length,
      events: events.length,
      notices: notices.length,
      drones: drones.length,
      places: places.length,
    }),
    [members, flights, events, notices, drones, places]
  );

  const ranking = useMemo(() => {
    const flightCountByPilot = flights.reduce((acc, flight) => {
      const pilot = String(flight.pilot || "").trim();
      if (!pilot) return acc;
      acc[pilot] = (acc[pilot] || 0) + 1;
      return acc;
    }, {});

    return members
      .map((member) => ({
        ...member,
        flights: flightCountByPilot[member.name] || 0,
      }))
      .sort((a, b) => b.flights - a.flights || a.name.localeCompare(b.name, "de"));
  }, [members, flights]);

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
        pilot: flightPilot.trim(),
        description: "",
      },
    ]);
    setFlightLocation("");
    setFlightDate("");
    setFlightPilot("");
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
        attendees: [],
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

  const addDrone = () => {
    if (!droneName.trim()) return;
    setDrones([
      ...drones,
      {
        id: Date.now(),
        name: droneName.trim(),
        owner: droneOwner.trim(),
      },
    ]);
    setDroneName("");
    setDroneOwner("");
  };

  const addPlace = () => {
    if (!placeName.trim()) return;
    setPlaces([
      ...places,
      {
        id: Date.now(),
        name: placeName.trim(),
        location: placeLocation.trim(),
      },
    ]);
    setPlaceName("");
    setPlaceLocation("");
  };

  const toggleEventAttendee = (eventId, memberName) => {
    if (!memberName) return;
    setEvents(
      events.map((event) => {
        if (event.id !== eventId) return event;
        const attendees = Array.isArray(event.attendees) ? event.attendees : [];
        const nextAttendees = attendees.includes(memberName)
          ? attendees.filter((name) => name !== memberName)
          : [...attendees, memberName];

        return { ...event, attendees: nextAttendees };
      })
    );
  };

  return (
    <section style={{ padding: 24 }}>
      <h2>🚁 Drohnenclub</h2>
      <p style={{ opacity: 0.75 }}>
        Öffentliche Clubinformationen, Termine, Flugaktivitäten und Vereinsressourcen.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
          margin: "18px 0",
        }}
      >
        <Stat label="Clubflüge" value={stats.flights} />
        <Stat label="Events" value={stats.events} />
        <Stat label="Beiträge" value={stats.notices} />
        <Stat label="Drohnen" value={stats.drones} />
        <Stat label="Flugplätze" value={stats.places} />
        {isAdmin && <Stat label="Mitglieder" value={stats.members} />}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <button onClick={() => setActiveTab("flights")}>🛩️ Clubflüge</button>
        <button onClick={() => setActiveTab("events")}>📅 Veranstaltungen</button>
        <button onClick={() => setActiveTab("notices")}>📌 Schwarzes Brett</button>
        <button onClick={() => setActiveTab("ranking")}>🏆 Rangliste</button>
        <button onClick={() => setActiveTab("drones")}>🚁 Drohnen</button>
        <button onClick={() => setActiveTab("places")}>🗺️ Flugplätze</button>
        {isAdmin && <button onClick={() => setActiveTab("members")}>👥 Mitglieder</button>}
      </div>

      {activeTab === "flights" && (
        <Panel title="🛩️ Clubflüge">
          {isAdmin && (
            <FormRow>
              <input
                value={flightLocation}
                onChange={(e) => setFlightLocation(e.target.value)}
                placeholder="Ort"
              />
              <input
                type="date"
                value={flightDate}
                onChange={(e) => setFlightDate(e.target.value)}
              />
              <select value={flightPilot} onChange={(e) => setFlightPilot(e.target.value)}>
                <option value="">Pilot optional</option>
                {members.map((member) => (
                  <option key={member.id} value={member.name}>
                    {member.name}
                  </option>
                ))}
              </select>
              <button onClick={addFlight}>Hinzufügen</button>
            </FormRow>
          )}

          {flights.length === 0 && <Empty text="Noch keine Clubflüge eingetragen." />}

          {flights.map((flight) => (
            <Card key={flight.id}>
              <strong>{flight.date}</strong> – {flight.location}
              {flight.pilot && (
                <>
                  <br />
                  Pilot: {flight.pilot}
                </>
              )}
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
              <input
                value={eventTitle}
                onChange={(e) => setEventTitle(e.target.value)}
                placeholder="Titel"
              />
              <input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
              <input
                value={eventLocation}
                onChange={(e) => setEventLocation(e.target.value)}
                placeholder="Ort"
              />
              <button onClick={addEvent}>Hinzufügen</button>
            </FormRow>
          )}

          {events.length === 0 && <Empty text="Noch keine Veranstaltungen geplant." />}

          {events.map((event) => (
            <Card key={event.id}>
              <strong>{event.title}</strong>
              <br />
              {event.date} {event.location && `– ${event.location}`}
              <br />
              <small>Zusagen: {(event.attendees || []).length}</small>

              {isAdmin && members.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <strong>Teilnehmer:</strong>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                    {members.map((member) => (
                      <button
                        key={member.id}
                        onClick={() => toggleEventAttendee(event.id, member.name)}
                        style={{
                          border:
                            (event.attendees || []).includes(member.name)
                              ? "2px solid #16a34a"
                              : "1px solid #d1d5db",
                        }}
                      >
                        {(event.attendees || []).includes(member.name) ? "✓ " : ""}
                        {member.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

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
              <input
                value={noticeTitle}
                onChange={(e) => setNoticeTitle(e.target.value)}
                placeholder="Titel"
              />
              <textarea
                value={noticeText}
                onChange={(e) => setNoticeText(e.target.value)}
                placeholder="Nachricht"
                rows={3}
              />
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

      {activeTab === "ranking" && (
        <Panel title="🏆 Piloten-Rangliste">
          {ranking.length === 0 && <Empty text="Noch keine Mitglieder vorhanden." />}

          {ranking.map((pilot, index) => (
            <Card key={pilot.id}>
              <strong>#{index + 1} – {pilot.name}</strong>
              <br />
              Clubflüge: {pilot.flights || 0}
            </Card>
          ))}
        </Panel>
      )}

      {activeTab === "drones" && (
        <Panel title="🚁 Drohnen-Datenbank">
          {isAdmin && (
            <FormRow>
              <input
                value={droneName}
                onChange={(e) => setDroneName(e.target.value)}
                placeholder="Drohnenmodell"
              />
              <input
                value={droneOwner}
                onChange={(e) => setDroneOwner(e.target.value)}
                placeholder="Besitzer"
              />
              <button onClick={addDrone}>Hinzufügen</button>
            </FormRow>
          )}

          {drones.length === 0 && <Empty text="Noch keine Drohnen eingetragen." />}

          {drones.map((drone) => (
            <Card key={drone.id}>
              <strong>{drone.name}</strong>
              <br />
              Besitzer: {drone.owner || "-"}
              {isAdmin && (
                <button onClick={() => setDrones(drones.filter((d) => d.id !== drone.id))}>
                  Löschen
                </button>
              )}
            </Card>
          ))}
        </Panel>
      )}

      {activeTab === "places" && (
        <Panel title="🗺️ Flugplätze">
          {isAdmin && (
            <FormRow>
              <input
                value={placeName}
                onChange={(e) => setPlaceName(e.target.value)}
                placeholder="Flugplatz"
              />
              <input
                value={placeLocation}
                onChange={(e) => setPlaceLocation(e.target.value)}
                placeholder="Ort"
              />
              <button onClick={addPlace}>Hinzufügen</button>
            </FormRow>
          )}

          {places.length === 0 && <Empty text="Noch keine Flugplätze eingetragen." />}

          {places.map((place) => (
            <Card key={place.id}>
              <strong>{place.name}</strong>
              <br />
              {place.location || "-"}
              {isAdmin && (
                <button onClick={() => setPlaces(places.filter((p) => p.id !== place.id))}>
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
            <input
              value={memberName}
              onChange={(e) => setMemberName(e.target.value)}
              placeholder="Mitgliedsname"
            />
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
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <p style={{ opacity: 0.65 }}>{text}</p>;
}
