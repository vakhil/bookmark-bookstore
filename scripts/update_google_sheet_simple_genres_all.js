/**
 * Google Apps Script to auto-populate Column J (Simple_Genre) across all rows in the Google Sheet.
 * 
 * Instructions:
 * 1. Open Google Sheet: https://docs.google.com/spreadsheets/d/1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU/edit
 * 2. Extensions -> Apps Script
 * 3. Paste this code and click Run (▶).
 */
function populateSimpleGenreForAllRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var range = sheet.getRange(2, 1, lastRow - 1, 10);
  var values = range.getValues();
  var updated = 0;

  var mangaKeywords = [
    "naruto", "one piece", "dragon ball", "bleach", "jujutsu kaisen",
    "demon slayer", "chainsaw man", "attack on titan", "death note",
    "berserk", "my hero academia", "tokyo ghoul", "haikyu", "vinland saga",
    "spy x family", "fullmetal alchemist", "hunter x hunter", "slam dunk",
    "pokemon adventures", "vagabond", "bakuman", "boruto", "doraemon",
    "fairy tail", "black clover", "blue lock", "makoto shinkai",
    "uzumaki", "junji ito", "one-punch man", "one punch man", "tokyo revengers",
    "manga", "juni taisen"
  ];

  for (var i = 0; i < values.length; i++) {
    var title = (values[i][5] || "").toString().toLowerCase();
    var genre = (values[i][7] || "").toString().toLowerCase();
    var author = (values[i][6] || "").toString().toLowerCase();

    if (!title) continue;

    var currentSimple = (values[i][9] || "").toString().trim();
    if (currentSimple) continue; // Already set

    // Determine category
    var assigned = "General Non-Fiction";

    var isManga = false;
    for (var k = 0; k < mangaKeywords.length; k++) {
      if (title.indexOf(mangaKeywords[k]) !== -1 || genre.indexOf(mangaKeywords[k]) !== -1 || author.indexOf(mangaKeywords[k]) !== -1) {
        isManga = true;
        break;
      }
    }

    if (isManga) {
      assigned = "Manga";
    } else if (genre.indexOf("philosophy") !== -1) {
      assigned = "Philosophy";
    } else if (genre.indexOf("self-help") !== -1 || genre.indexOf("motivation") !== -1) {
      assigned = "Self-Help";
    } else if (genre.indexOf("business") !== -1 || genre.indexOf("economics") !== -1 || genre.indexOf("finance") !== -1) {
      assigned = "Business & Economics";
    } else if (genre.indexOf("history") !== -1) {
      assigned = "History";
    } else if (genre.indexOf("biography") !== -1 || genre.indexOf("memoir") !== -1 || genre.indexOf("autobiography") !== -1) {
      assigned = "Biography";
    } else if (genre.indexOf("politics") !== -1 || genre.indexOf("political") !== -1) {
      assigned = "Politics";
    } else if (genre.indexOf("reference") !== -1 || genre.indexOf("dictionary") !== -1 || genre.indexOf("language") !== -1) {
      assigned = "Education & Reference";
    } else if (genre.indexOf("children") !== -1 || genre.indexOf("young adult") !== -1 || genre.indexOf("middle grade") !== -1) {
      assigned = "Children & Young Adult";
    } else if (genre.indexOf("fiction") !== -1 || genre.indexOf("novel") !== -1) {
      assigned = "Fiction";
    } else if (genre.indexOf("sports") !== -1 || genre.indexOf("fitness") !== -1 || genre.indexOf("health") !== -1) {
      assigned = "Health & Wellness";
    } else if (genre.indexOf("music") !== -1) {
      assigned = "Music";
    } else if (genre.indexOf("art") !== -1 || genre.indexOf("photography") !== -1) {
      assigned = "Art & Culture";
    } else if (genre.indexOf("travel") !== -1) {
      assigned = "Travel & Adventure";
    } else if (genre.indexOf("humor") !== -1 || genre.indexOf("comedy") !== -1) {
      assigned = "Humor & Lifestyle";
    }

    values[i][9] = assigned;
    updated++;
  }

  range.setValues(values);
  SpreadsheetApp.getUi().alert("Finished! Populated Simple_Genre for " + updated + " books.");
}
