// Utility to update a Google Sheet cell
function updateGoogleSheetCell(sheetId, rowNumber, columnNumber, value) {
  var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];

  if (isNaN(rowNumber) || rowNumber <= 0) {
    console.log("Error: Invalid row number:", rowNumber);
    return;
  }

  try {
    sheet.getRange(rowNumber, columnNumber).setValue(value);
  } catch (error) {
    console.log("Error updating sheet:", error.message);
  }
}

// Utility to append a row to a Google Sheet
function appendRowToGoogleSheet(sheetId, rowData) {
  var sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];

  try {
    sheet.appendRow(rowData);
  } catch (error) {
    console.log("Error appending row to sheet:", error.message);
  }
}