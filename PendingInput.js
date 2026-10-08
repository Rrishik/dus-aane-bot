// Pending-input flags
// "Waiting for your next message" state (bare /ask, bare /register, 🏷 Tag).
// Expires so a forgotten prompt can't swallow an unrelated later message
// (e.g. a pasted SMS hours afterwards).
var PENDING_INPUT_TTL_MS = 10 * 60 * 1000;

function setPendingInput(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({ v: value, t: Date.now() }));
}

// Returns the stashed value, or null when absent / expired / legacy-format
// (those are deleted on read).
function getPendingInput(key) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(key);
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Date.now() - Number(parsed.t) < PENDING_INPUT_TTL_MS) {
      return parsed.v;
    }
  } catch (_) {}
  props.deleteProperty(key);
  return null;
}

function clearPendingInput(key) {
  PropertiesService.getScriptProperties().deleteProperty(key);
}
