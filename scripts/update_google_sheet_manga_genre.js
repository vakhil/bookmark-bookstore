/**
 * Google Apps Script to update all Japanese Comics / Manga in your Google Sheet:
 * - Sets Column J (Simple_Genre) to "Manga"
 * - Ensures Column H (Genre) contains "Manga"
 * 
 * Instructions:
 * 1. Open your Google Sheet: https://docs.google.com/spreadsheets/d/1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU/edit
 * 2. In the top menu, click: Extensions -> Apps Script
 * 3. Paste this function and click "Run" (▶).
 */
function updateMangaGenres() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  
  if (lastRow <= 1) {
    SpreadsheetApp.getUi().alert("No data rows found.");
    return;
  }

  var mangaSeries = [
    "naruto", "one piece", "dragon ball", "bleach", "jujutsu kaisen",
    "demon slayer", "chainsaw man", "attack on titan", "death note",
    "berserk", "my hero academia", "tokyo ghoul", "haikyu", "vinland saga",
    "spy x family", "fullmetal alchemist", "hunter x hunter", "slam dunk",
    "pokemon adventures", "vagabond", "bakuman", "boruto", "doraemon",
    "fairy tail", "black clover", "blue lock", "makoto shinkai",
    "uzumaki", "junji ito", "one-punch man", "one punch man", "tokyo revengers"
  ];

  // Read Columns A through J (indices 0 to 9)
  var range = sheet.getRange(2, 1, lastRow - 1, 10);
  var values = range.getValues();
  var updatedCount = 0;

  for (var i = 0; i < values.length; i++) {
    var title = (values[i][5] || "").toString().toLowerCase(); // Col F: Title
    var genre = (values[i][7] || "").toString();              // Col H: Genre
    var genreLower = genre.toLowerCase();
    var author = (values[i][6] || "").toString().toLowerCase(); // Col G: Author

    var isManga = false;
    if (genreLower.indexOf("manga") !== -1) {
      isManga = true;
    } else {
      for (var k = 0; k < mangaSeries.length; k++) {
        var kw = mangaSeries[k];
        if (title.indexOf(kw) !== -1 || genreLower.indexOf(kw) !== -1 || author.indexOf(kw) !== -1) {
          isManga = true;
          break;
        }
      }
    }

    if (isManga) {
      // Set Column J (Simple_Genre) to "Manga"
      values[i][9] = "Manga";

      // If Column H (Genre) doesn't already contain Manga, format it
      if (genreLower.indexOf("manga") === -1) {
        values[i][7] = genre ? ("Manga / " + genre) : "Manga";
      }
      updatedCount++;
    }
  }

  // Write changes back to the sheet
  range.setValues(values);
  SpreadsheetApp.getUi().alert("Finished! Identified and updated " + updatedCount + " books to genre 'Manga'.");
}
