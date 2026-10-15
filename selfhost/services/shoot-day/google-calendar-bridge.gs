/**
 * Shoot Day -> Google Kalender (Apps Script als Web-App, laeuft als du selbst).
 * Der Shoot-Day-Server schickt pro Projekt einen POST mit JSON:
 *   { secret, action: "upsert"|"delete", project, title, start, end, allDay, date, location, description, calendarId? }
 * Das Geheimwort liegt in den Skripteigenschaften (SHOOT_SECRET), nicht im Code.
 */

// Einmal ausfuehren (Play-Knopf): Geheimwort setzen und Kalender-Zugriff erlauben.
function setup() {
  var geheimwort = 'HIER-EIGENES-GEHEIMWORT-EINTRAGEN'; // vor dem Ausfuehren aendern, danach wieder entfernen
  PropertiesService.getScriptProperties().setProperty('SHOOT_SECRET', geheimwort);
  CalendarApp.getDefaultCalendar(); // loest die Zustimmungsabfrage aus
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SHOOT_SECRET');
    if (!secret || d.secret !== secret) return antwort({ ok: false, error: 'forbidden' });
    if (!d.project) return antwort({ ok: false, error: 'project missing' });

    var cal = d.calendarId ? CalendarApp.getCalendarById(d.calendarId) : CalendarApp.getDefaultCalendar();
    if (!cal) return antwort({ ok: false, error: 'calendar not found' });

    // Vorhandenen Termin dieses Projekts ueber das Tag suchen (+-1 Jahr um den neuen oder heutigen Termin)
    var mitte = d.allDay ? new Date(d.date + 'T12:00:00') : (d.start ? new Date(d.start) : new Date());
    var von = new Date(mitte.getTime() - 366 * 864e5);
    var bis = new Date(mitte.getTime() + 366 * 864e5);
    var treffer = cal.getEvents(von, bis).filter(function (ev) { return ev.getTag('shootDayProject') === d.project; });

    if (d.action === 'delete') {
      // Beim Loeschen ist kein Datum bekannt: grosszuegig suchen
      if (!treffer.length) {
        var jetzt = new Date();
        treffer = cal.getEvents(new Date(jetzt.getTime() - 5 * 366 * 864e5), new Date(jetzt.getTime() + 5 * 366 * 864e5))
          .filter(function (ev) { return ev.getTag('shootDayProject') === d.project; });
      }
      treffer.forEach(function (ev) { ev.deleteEvent(); });
      return antwort({ ok: true, deleted: treffer.length });
    }
    if (d.action !== 'upsert') return antwort({ ok: false, error: 'unknown action' });

    var opts = { location: d.location || '', description: d.description || '' };
    var ev = treffer[0];
    if (ev) {
      // Zeit neu setzen; Mehrfachtreffer (Dubletten) werden entfernt
      treffer.slice(1).forEach(function (x) { x.deleteEvent(); });
      ev.setTitle(d.title);
      if (d.allDay) ev.setAllDayDate(new Date(d.date + 'T12:00:00'));
      else ev.setTime(new Date(d.start), new Date(d.end));
      ev.setLocation(opts.location);
      ev.setDescription(opts.description);
    } else {
      ev = d.allDay
        ? cal.createAllDayEvent(d.title, new Date(d.date + 'T12:00:00'), opts)
        : cal.createEvent(d.title, new Date(d.start), new Date(d.end), opts);
      ev.setTag('shootDayProject', d.project);
    }
    return antwort({ ok: true, eventId: ev.getId() });
  } catch (err) {
    return antwort({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
