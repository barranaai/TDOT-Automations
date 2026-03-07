/**
 * Extracts a typed value from a Monday.com column_values entry.
 * @param {Array} columnValues - Array of column value objects from the Monday API
 * @param {string} columnId - The column ID to look up
 * @returns {string|null} The text value of the column, or null if not found
 */
function extractColumnValue(columnValues, columnId) {
  const column = columnValues.find((col) => col.id === columnId);
  return column ? column.text : null;
}

module.exports = extractColumnValue;
