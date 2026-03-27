// ============================================================
// AIIMS Jodhpur — Nursing Evaluation Backend (Google Apps Script)
// ============================================================
// SETUP INSTRUCTIONS:
// 1. Go to https://script.google.com and create a new project
// 2. Paste this entire code into Code.gs
// 3. Click "Deploy" → "New deployment"
// 4. Select type: "Web app"
// 5. Set "Execute as": Me (your account)
// 6. Set "Who has access": Anyone
// 7. Click "Deploy" and copy the Web App URL
// 8. Paste the URL into the HTML app's Settings → Backend URL
// ============================================================

// Spreadsheet will be auto-created on first use
var SPREADSHEET_NAME = 'AIIMS_Nursing_Evaluation_Data';

function getOrCreateSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var ssId = props.getProperty('SPREADSHEET_ID');

  if (ssId) {
    try {
      return SpreadsheetApp.openById(ssId);
    } catch (e) {
      // Spreadsheet was deleted, create new one
    }
  }

  var ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());

  // Create sheets
  var roundsSheet = ss.getSheetByName('Sheet1');
  roundsSheet.setName('Rounds');
  roundsSheet.appendRow([
    'Timestamp', 'Date', 'Time', 'Supervisor', 'Designation', 'Ward',
    'Shift', 'PIN', 'Beds Assessed', 'Avg Compliance %', 'Total NC',
    'Total Remarks', 'Flagged', 'Duration (min)', 'Full Data (JSON)'
  ]);
  roundsSheet.setFrozenRows(1);
  roundsSheet.getRange('1:1').setFontWeight('bold').setBackground('#00695c').setFontColor('#ffffff');

  var bedsSheet = ss.insertSheet('Beds');
  bedsSheet.appendRow([
    'Round Timestamp', 'Date', 'Supervisor', 'Bed No', 'Staff Name',
    'Shift', 'Compliance %', 'NC Count', 'NC Items', 'Remarks'
  ]);
  bedsSheet.setFrozenRows(1);
  bedsSheet.getRange('1:1').setFontWeight('bold').setBackground('#1565c0').setFontColor('#ffffff');

  var pinsSheet = ss.insertSheet('PINs');
  pinsSheet.appendRow(['Supervisor Name', 'PIN', 'Role', 'Last Updated']);
  pinsSheet.setFrozenRows(1);
  pinsSheet.getRange('1:1').setFontWeight('bold').setBackground('#6a1b9a').setFontColor('#ffffff');

  var sessionsSheet = ss.insertSheet('Sessions');
  sessionsSheet.appendRow(['Session Key', 'Data (JSON)', 'Last Updated']);
  sessionsSheet.setFrozenRows(1);
  sessionsSheet.getRange('1:1').setFontWeight('bold').setBackground('#e65100').setFontColor('#ffffff');

  return ss;
}

function getSheet(name) {
  var ss = getOrCreateSpreadsheet();
  return ss.getSheetByName(name);
}

// ── CORS + Routing ──────────────────────────────────────────

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || '';
  var result;

  try {
    if (action === 'ping') {
      result = { success: true, message: 'Backend connected!', spreadsheetUrl: getOrCreateSpreadsheet().getUrl() };
    } else if (action === 'getHistory') {
      result = handleGetHistory();
    } else if (action === 'getPins') {
      result = handleGetPins();
    } else if (action === 'getSession') {
      var key = e.parameter.key || '';
      result = handleGetSession(key);
    } else {
      result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var result;

  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || '';

    if (action === 'saveRound') {
      result = handleSaveRound(body.data);
    } else if (action === 'savePins') {
      result = handleSavePins(body.data);
    } else if (action === 'saveSession') {
      result = handleSaveSession(body.key, body.data);
    } else if (action === 'deleteRound') {
      result = handleDeleteRound(body.ts);
    } else if (action === 'clearHistory') {
      result = handleClearHistory();
    } else {
      result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── ROUND HANDLERS ──────────────────────────────────────────

function handleSaveRound(data) {
  if (!data) return { success: false, error: 'No data provided' };

  var roundsSheet = getSheet('Rounds');
  var bedsSheet = getSheet('Beds');

  // Check for duplicate (same timestamp)
  var existing = roundsSheet.getDataRange().getValues();
  for (var i = 1; i < existing.length; i++) {
    if (String(existing[i][0]) === String(data.ts)) {
      return { success: true, message: 'Round already exists, skipped duplicate' };
    }
  }

  // Save round summary row
  roundsSheet.appendRow([
    data.ts || Date.now(),
    data.date || '',
    data.time || '',
    data.supervisor || '',
    data.desig || '',
    data.ward || '',
    data.shift || '',
    data.pin || '',
    data.beds ? data.beds.length : 0,
    data.avgPct || 0,
    data.totalNC || 0,
    data.totalRemarks || 0,
    data.suspicious ? 'YES' : 'NO',
    data.durationMin || 0,
    JSON.stringify(data)
  ]);

  // Save individual bed rows
  if (data.beds && data.beds.length > 0) {
    var bedRows = data.beds.map(function(b) {
      return [
        data.ts || Date.now(),
        data.date || '',
        data.supervisor || '',
        b.bed || '',
        b.staff || '',
        b.shift || '',
        b.pct || 0,
        b.nc || 0,
        (b.ncItems && b.ncItems.length > 0) ? b.ncItems.join('; ') : '',
        b.remarks || ''
      ];
    });

    bedsSheet.getRange(
      bedsSheet.getLastRow() + 1, 1,
      bedRows.length, bedRows[0].length
    ).setValues(bedRows);
  }

  return { success: true, message: 'Round saved', ts: data.ts };
}

function handleGetHistory() {
  var sheet = getSheet('Rounds');
  var data = sheet.getDataRange().getValues();
  var history = [];

  for (var i = 1; i < data.length; i++) {
    try {
      var jsonStr = data[i][14]; // Full Data JSON column
      if (jsonStr) {
        var round = JSON.parse(jsonStr);
        history.push(round);
      }
    } catch (e) {
      // Skip malformed rows
    }
  }

  return { success: true, history: history, count: history.length };
}

function handleDeleteRound(ts) {
  if (!ts) return { success: false, error: 'No timestamp provided' };

  var tsStr = String(ts);

  // Delete from Rounds sheet
  var roundsSheet = getSheet('Rounds');
  var roundsData = roundsSheet.getDataRange().getValues();
  for (var i = roundsData.length - 1; i >= 1; i--) {
    if (String(roundsData[i][0]) === tsStr) {
      roundsSheet.deleteRow(i + 1);
    }
  }

  // Delete from Beds sheet
  var bedsSheet = getSheet('Beds');
  var bedsData = bedsSheet.getDataRange().getValues();
  for (var j = bedsData.length - 1; j >= 1; j--) {
    if (String(bedsData[j][0]) === tsStr) {
      bedsSheet.deleteRow(j + 1);
    }
  }

  return { success: true, message: 'Round deleted' };
}

function handleClearHistory() {
  var roundsSheet = getSheet('Rounds');
  var bedsSheet = getSheet('Beds');

  if (roundsSheet.getLastRow() > 1) {
    roundsSheet.deleteRows(2, roundsSheet.getLastRow() - 1);
  }
  if (bedsSheet.getLastRow() > 1) {
    bedsSheet.deleteRows(2, bedsSheet.getLastRow() - 1);
  }

  return { success: true, message: 'All history cleared' };
}

// ── PIN HANDLERS ────────────────────────────────────────────

function handleSavePins(data) {
  if (!data) return { success: false, error: 'No PIN data provided' };

  var sheet = getSheet('PINs');
  // Clear existing (except header)
  if (sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }

  var now = new Date().toISOString();
  var rows = Object.keys(data).map(function(name) {
    return [name, data[name].pin || '', data[name].role || '', now];
  });

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  }

  return { success: true, message: rows.length + ' PINs saved' };
}

function handleGetPins() {
  var sheet = getSheet('PINs');
  var data = sheet.getDataRange().getValues();
  var pins = {};

  for (var i = 1; i < data.length; i++) {
    var name = data[i][0];
    if (name) {
      pins[name] = { pin: String(data[i][1]), role: data[i][2] || '' };
    }
  }

  return { success: true, pins: pins };
}

// ── SESSION HANDLERS ────────────────────────────────────────

function handleSaveSession(key, data) {
  if (!key) return { success: false, error: 'No session key' };

  var sheet = getSheet('Sessions');
  var existing = sheet.getDataRange().getValues();

  // Update existing or append
  for (var i = 1; i < existing.length; i++) {
    if (existing[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(JSON.stringify(data));
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      return { success: true, message: 'Session updated' };
    }
  }

  sheet.appendRow([key, JSON.stringify(data), new Date().toISOString()]);
  return { success: true, message: 'Session saved' };
}

function handleGetSession(key) {
  if (!key) return { success: false, error: 'No session key' };

  var sheet = getSheet('Sessions');
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      try {
        return { success: true, data: JSON.parse(data[i][1]) };
      } catch (e) {
        return { success: false, error: 'Corrupt session data' };
      }
    }
  }

  return { success: false, error: 'Session not found' };
}
