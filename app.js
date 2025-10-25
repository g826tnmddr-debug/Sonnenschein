/*
 * app.js – Logik für die Wetter‑Finder‑App
 *
 * Dieses Skript verarbeitet die Benutzereingaben, ruft den
 * Geocoding‑Dienst von Open‑Meteo ab, generiert Kandidaten
 * innerhalb des angegebenen Radius und ermittelt anhand der
 * Wetterdaten von wttr.in den Ort mit der höchsten Chance auf
 * trockenes Wetter. Die Ergebnisse werden anschließend im
 * Browser angezeigt. Außerdem registriert das Skript den
 * Service‑Worker für die PWA‑Funktionalität.
 */

// Registriere den Service‑Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch((err) => {
            console.error('Service‑Worker konnte nicht registriert werden:', err);
        });
    });
}

// DOM‑Elemente abrufen
const form = document.getElementById('searchForm');
const locationInput = document.getElementById('location');
const radiusInput = document.getElementById('radius');
const resultSection = document.getElementById('result');
const loadingSection = document.getElementById('loading');

// Event‑Listener für das Formular
form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const location = locationInput.value.trim();
    const radiusKm = parseFloat(radiusInput.value);
    if (!location || isNaN(radiusKm)) {
        return;
    }

    resultSection.classList.add('hidden');
    loadingSection.classList.remove('hidden');
    loadingSection.textContent = 'Suche läuft…';

    try {
        // 1. Geocoding – Koordinaten des Ortes abrufen
        const coords = await getCoordinates(location);
        if (!coords) {
            throw new Error('Ort konnte nicht gefunden werden.');
        }
        // 2. Kandidatenpunkte im Umkreis berechnen
        const candidates = generateCandidatePoints(coords.lat, coords.lon, radiusKm);
        // 3. Wetterdaten abrufen und besten Standort ermitteln
        const best = await findBestWeather(candidates);
        // 4. Ergebnis anzeigen
        showResult(best, location, radiusKm);
    } catch (error) {
        console.error(error);
        resultSection.innerHTML = `<div class="card"><p>Es ist ein Fehler aufgetreten: ${error.message}</p></div>`;
        resultSection.classList.remove('hidden');
    } finally {
        loadingSection.classList.add('hidden');
    }
});

const proxyPrefix = 'https://api.allorigins.win/raw?url=';

/**
 * Ruft die geographischen Koordinaten (Breite, Länge) für einen Ort ab
 * mithilfe der Open‑Meteo Geocoding API.
 * @param {string} place Name des Ortes
 * @returns {Promise<{lat:number, lon:number}|null>} Koordinaten oder null
 */
async function getCoordinates(place) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=de&format=json`;
    // Verwendung eines Proxy, um CORS‑Restriktionen zu umgehen
    const proxiedUrl = proxyPrefix + encodeURIComponent(url);
    const response = await proxiedFetch(proxiedUrl);
    if (!response.ok) {
        throw new Error('Geocoding‑Anfrage fehlgeschlagen.');
    }
    const data = await response.json();
    if (data && Array.isArray(data.results) && data.results.length > 0) {
        const result = data.results[0];
        return { lat: result.latitude, lon: result.longitude };
    }
    return null;
}

/**
 * Generiert eine Liste von Koordinaten im Umkreis des Ursprungs.
 * Die Punkte werden in mehreren Richtungen um die zentrale Position
 * mit dem angegebenen Radius verteilt.
 * @param {number} lat Ursprungslatitude
 * @param {number} lon Ursprungslongitude
 * @param {number} radiusKm Radius in Kilometern
 * @returns {Array<{lat:number, lon:number}>}
 */
function generateCandidatePoints(lat, lon, radiusKm) {
    const candidates = [];
    // Der Mittelpunkt zählt ebenfalls
    candidates.push({ lat, lon });
    const degToRad = Math.PI / 180;
    const radToDeg = 180 / Math.PI;
    // Umrechnung: 1° Breitengrad ≈ 111 km; Längengrad abhängig von Breitengrad
    const latDelta = radiusKm / 111; // grobe Näherung
    const lonDelta = radiusKm / (111 * Math.cos(lat * degToRad));
    // 8 Richtungen (N, NE, E, SE, S, SW, W, NW)
    const directions = [0, 45, 90, 135, 180, 225, 270, 315];
    directions.forEach((angleDeg) => {
        const angleRad = angleDeg * degToRad;
        const dLat = latDelta * Math.cos(angleRad);
        const dLon = lonDelta * Math.sin(angleRad);
        candidates.push({ lat: lat + dLat, lon: lon + dLon });
    });
    return candidates;
}

/**
 * Ruft für mehrere Koordinaten die Wetterdaten ab und bestimmt den besten Standort.
 * Bewertungskriterium ist die durchschnittliche Chance, trocken zu bleiben
 * (chanceofremdry) des ersten Tages. Bei gleicher Trockenheitschance wird der
 * Ort mit dem geringsten Niederschlag (precipMM) bevorzugt.
 * @param {Array<{lat:number, lon:number}>} points Kandidaten
 * @returns {Promise<{lat:number, lon:number, dryness:number, precip:number}>}
 */
async function findBestWeather(points) {
    const results = [];
    for (const pt of points) {
        try {
            const data = await getWeather(pt.lat, pt.lon);
            if (data) {
                results.push({
                    lat: pt.lat,
                    lon: pt.lon,
                    dryness: data.dryness,
                    precip: data.precip,
                    nearest: data.nearest
                });
            }
        } catch (err) {
            console.warn('Fehler beim Abrufen der Wetterdaten für', pt, err);
        }
    }
    // Sortieren: höhere Trockenheit zuerst, dann weniger Niederschlag
    results.sort((a, b) => {
        if (b.dryness !== a.dryness) return b.dryness - a.dryness;
        return a.precip - b.precip;
    });
    return results[0];
}

/**
 * Ruft Wetterdaten von wttr.in im JSON‑Format ab und berechnet
 * eine Durchschnittskennzahl für Trockenheit und Gesamtniederschlag
 * für den ersten Vorhersagetag.
 * @param {number} lat Latitude
 * @param {number} lon Longitude
 * @returns {Promise<{dryness:number, precip:number, nearest:string}>}
 */
async function getWeather(lat, lon) {
    // wttr.in liefert JSON‑Daten; wir verwenden ?format=j1
    const url = `https://wttr.in/${lat.toFixed(4)},${lon.toFixed(4)}?format=j1`;
    const proxiedUrl = proxyPrefix + encodeURIComponent(url);
    const resp = await proxiedFetch(proxiedUrl);
    if (!resp.ok) {
        throw new Error('Wetterdaten konnten nicht abgerufen werden.');
    }
    const data = await resp.json();
    const weather = data.weather && data.weather[0];
    if (!weather || !Array.isArray(weather.hourly)) {
        throw new Error('Unvollständige Wetterdaten erhalten.');
    }
    const hourly = weather.hourly;
    let drynessSum = 0;
    let precipSum = 0;
    hourly.forEach((h) => {
        drynessSum += Number(h.chanceofremdry);
        precipSum += parseFloat(h.precipMM);
    });
    const drynessAvg = drynessSum / hourly.length;
    const precipTotal = precipSum;
    // Name des nächstgelegenen Ortes falls vorhanden
    let nearestName = '';
    if (Array.isArray(data.nearest_area) && data.nearest_area[0] && data.nearest_area[0].areaName) {
        nearestName = data.nearest_area[0].areaName[0].value;
    }
    return { dryness: drynessAvg, precip: precipTotal, nearest: nearestName };
}

/**
 * Zeigt das Ergebnis im DOM an.
 * @param {{lat:number, lon:number, dryness:number, precip:number, nearest:string}} best Bestes Ergebnis
 * @param {string} place Ursprünglicher Ort
 * @param {number} radiusKm Radius in Kilometern
 */
function showResult(best, place, radiusKm) {
    if (!best) {
        resultSection.innerHTML = '<div class="card"><p>Kein geeigneter Ort gefunden.</p></div>';
        resultSection.classList.remove('hidden');
        return;
    }
    const drynessPercent = Math.round(best.dryness);
    const precipMM = best.precip.toFixed(1);
    resultSection.innerHTML = `
        <div class="card">
            <h2>Bestes Wetter gefunden</h2>
            <p><strong>Ursprungsort:</strong> ${place}</p>
            <p><strong>Radius:</strong> ${radiusKm} km</p>
            ${best.nearest ? `<p><strong>Nächster Ort:</strong> ${best.nearest}</p>` : ''}
            <p><strong>Koordinaten:</strong> ${best.lat.toFixed(4)}, ${best.lon.toFixed(4)}</p>
            <p><strong>Trockenheits‑Chance:</strong> <span class="highlight">${drynessPercent}%</span></p>
            <p><strong>Niederschlag (gesamt 24h):</strong> ${precipMM} mm</p>
        </div>
    `;
    resultSection.classList.remove('hidden');
}

/**
 * Führt einen Fetch mit einem Timeout aus, um festhängende Anfragen zu vermeiden.
 * Außerdem ermöglicht diese Funktion die Verwendung eines Proxys zur CORS‑Umgehung.
 * @param {string} url Die abzurufende URL (bereits ggf. mit Proxy versehen)
 * @param {number} timeoutMs Maximale Dauer in Millisekunden
 * @returns {Promise<Response>}
 */
async function proxiedFetch(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}