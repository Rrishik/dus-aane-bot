// Minimal in-memory SpreadsheetApp mock for unit tests.
//
// Implements only the surface area used by GoogleSheetUtils.js + its callers:
//   SpreadsheetApp.openById(id)
//   spreadsheet.getSheets() / getSheetByName(name) / insertSheet(name)
//   sheet.getLastRow() / getLastColumn() / appendRow(row) / deleteRow(row)
//   sheet.getRange(row, col)               (single cell)
//   sheet.getRange(row, col, nRows, nCols) (rectangle)
//   sheet.getDataRange()
//   range.getValue() / getValues() / setValue(v) / setValues(arr) / clearContent()
//
// Conventions match Apps Script: 1-indexed rows/cols, getValues() returns a 2D
// array, missing cells read as empty string.

class MockSheet {
  constructor(name) {
    this.name = name;
    this.data = []; // 2D array of cell values (rows of cols)
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    return this.data.length;
  }
  getLastColumn() {
    if (this.data.length === 0) return 0;
    var max = 0;
    for (var i = 0; i < this.data.length; i++) {
      if (this.data[i].length > max) max = this.data[i].length;
    }
    return max;
  }
  appendRow(row) {
    this.data.push(row.slice());
  }
  deleteRow(rowNum) {
    this.data.splice(rowNum - 1, 1);
  }
  getDataRange() {
    var rows = this.data.length;
    var cols = this.getLastColumn();
    return new MockRange(this, 1, 1, rows || 1, cols || 1);
  }
  getRange(row, col, numRows, numCols) {
    if (numRows === undefined) return new MockRange(this, row, col, 1, 1);
    return new MockRange(this, row, col, numRows, numCols);
  }
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValue() {
    return this.getValues()[0][0];
  }
  getValues() {
    var out = [];
    for (var i = 0; i < this.numRows; i++) {
      var rowArr = [];
      var srcRow = this.sheet.data[this.row - 1 + i] || [];
      for (var j = 0; j < this.numCols; j++) {
        var v = srcRow[this.col - 1 + j];
        rowArr.push(v === undefined ? "" : v);
      }
      out.push(rowArr);
    }
    return out;
  }
  setValue(v) {
    this._ensureCell(this.row, this.col);
    this.sheet.data[this.row - 1][this.col - 1] = v;
  }
  setValues(arr) {
    for (var i = 0; i < arr.length; i++) {
      for (var j = 0; j < arr[i].length; j++) {
        this._ensureCell(this.row + i, this.col + j);
        this.sheet.data[this.row - 1 + i][this.col - 1 + j] = arr[i][j];
      }
    }
  }
  clearContent() {
    for (var i = 0; i < this.numRows; i++) {
      var rowIdx = this.row - 1 + i;
      if (!this.sheet.data[rowIdx]) continue;
      for (var j = 0; j < this.numCols; j++) {
        this.sheet.data[rowIdx][this.col - 1 + j] = "";
      }
    }
  }
  _ensureCell(row, col) {
    while (this.sheet.data.length < row) this.sheet.data.push([]);
    var r = this.sheet.data[row - 1];
    while (r.length < col) r.push("");
  }
}

class MockSpreadsheet {
  constructor(id) {
    this.id = id;
    this.sheets = [new MockSheet("Sheet1")];
  }
  getId() {
    return this.id;
  }
  getSheets() {
    return this.sheets;
  }
  getSheetByName(name) {
    for (var i = 0; i < this.sheets.length; i++) {
      if (this.sheets[i].name === name) return this.sheets[i];
    }
    return null;
  }
  insertSheet(name) {
    var s = new MockSheet(name);
    this.sheets.push(s);
    return s;
  }
}

export function makeSpreadsheetApp() {
  var byId = {};
  return {
    openById(id) {
      if (!byId[id]) byId[id] = new MockSpreadsheet(id);
      return byId[id];
    },
    // Test helper, not on real API
    _store: byId
  };
}
