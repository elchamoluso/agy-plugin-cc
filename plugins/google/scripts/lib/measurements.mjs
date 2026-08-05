// Locally measured servers, layered over the shipped catalogue.
//
// The catalogue records what Google publishes; this records what YOU probed. They have to
// be separate files because an installed plugin lives under ~/.claude/plugins/cache/, so
// anything written there is lost on the next reinstall — and because a measurement taken
// on one machine is not a fact about the catalogue, it is a fact about that probe.
//
// Without this, /google:doctor --probe=<id> printed a measurement and threw it away, so
// `add` kept refusing the server it had just told you to measure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function overlayFile() {
  const dir = process.env.GOOGLE_PLUGIN_DATA || path.join(os.homedir(), ".cache", "google-plugin");
  return path.join(dir, "measurements.json");
}

export function loadMeasurements() {
  try {
    const parsed = JSON.parse(fs.readFileSync(overlayFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Best-effort: losing a measurement is an annoyance, never a reason to fail a diagnosis.
export function recordMeasurement(id, { toolCount, schemaBytes }) {
  try {
    const all = loadMeasurements();
    all[id] = {
      toolCount,
      schemaBytes,
      measuredAt: new Date().toISOString().slice(0, 10),
      measuredLocally: true
    };
    const file = overlayFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    return file;
  } catch {
    return null;
  }
}

// Merge the overlay over the catalogue. A locally measured server is promoted to
// "verified" so `add` accepts it, and keeps measuredLocally so `list` can say where the
// number came from — a probe from this machine is weaker evidence than one that shipped.
export function applyMeasurements(servers) {
  const measured = loadMeasurements();
  for (const [id, m] of Object.entries(measured)) {
    const server = servers[id];
    if (!server) continue;
    server.toolCount = m.toolCount;
    server.schemaBytes = m.schemaBytes;
    server.measuredAt = m.measuredAt;
    server.measuredLocally = true;
    if (server.status === "listed") server.status = "verified";
  }
  return servers;
}
