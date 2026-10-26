/**
 * Google Apps Script to automatically add and populate the "Simple_Genre" column in Column J.
 * 
 * Instructions:
 * 1. Open the Google Spreadsheet: https://docs.google.com/spreadsheets/d/1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU/edit
 * 2. In the top menu, click: Extensions -> Apps Script
 * 3. Delete any code in the editor, and paste this entire file.
 * 4. Click "Save" (disk icon), then click "Run" (play button).
 * 5. Column J will be instantly populated with "Simple_Genre" for all 4,295 books!
 */

function addSimpleGenreColumn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow <= 1) {
    SpreadsheetApp.getUi().alert("No data rows found in this sheet.");
    return;
  }

  // Read all rows (Header + Data)
  var data = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 10)).getValues();
  var header = data[0];

  // Locate Title and Genre columns (defaults: Title=Col 6 / index 5, Genre=Col 8 / index 7)
  var titleColIdx = 5;
  var genreColIdx = 7;

  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]).trim().toLowerCase();
    if (h === "title") titleColIdx = c;
    if (h === "genre") genreColIdx = c;
  }

  // Column J is column 10 (1-indexed)
  var simpleGenreCol = 10;
  sheet.getRange(1, simpleGenreCol).setValue("Simple_Genre");

  // Prepare batch values for all rows
  var outputValues = [];
  for (var r = 1; r < data.length; r++) {
    var rawGenre = String(data[r][genreColIdx] || "");
    var title = String(data[r][titleColIdx] || "");
    var simpleGenre = classifyCommonGenre(rawGenre, title);
    outputValues.push([simpleGenre]);
  }

  // Batch write all classified genres into Column J in one call
  sheet.getRange(2, simpleGenreCol, outputValues.length, 1).setValues(outputValues);

  // Auto-format header
  sheet.getRange(1, simpleGenreCol).setFontWeight("bold");

  Logger.log("Successfully populated Column J (Simple_Genre) for " + outputValues.length + " rows.");
  SpreadsheetApp.getActiveSpreadsheet().toast("Successfully populated Column J (Simple_Genre) for " + outputValues.length + " books!", "Complete", 5);
}

/**
 * 1-Click Function to immediately sync BK-11010 to your Google Sheet:
 * 1. Creates the "Sales_Transactions" tab (if not already there) and records the ₹2,000 sale.
 * 2. Marks BK-11010 (Row 1694) in Column K as "SOLD OUT" with red badge styling.
 * 
 * Select "syncSoldBooksNow" in the Apps Script top toolbar and click "Run".
 */
function syncSoldBooksNow() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];

  // 1. Mark BK-11010 as SOLD OUT in Column K (Row 1694)
  var res = handleUpdateStatus(sheet, { book_id: "BK-11010", status: "SOLD OUT" });

  // 2. Append to Sales_Transactions tab
  handleAppendSale(ss, {
    transaction_ref: "TX-20261026-0001",
    book_id: "BK-11010",
    title: "Export Marketing",
    author: "B. Bhattacharyya",
    selling_price: 2000,
    sold_at: "2026-10-26T18:11:08",
    sold_by: "Staff",
    notes: ""
  });

  SpreadsheetApp.getActiveSpreadsheet().toast("✅ BK-11010 marked SOLD OUT & added to Sales_Transactions tab!", "Success", 6);
}

/**
 * Live Webhook Listener for real-time sync from the Bookstore App.
 * When deployed as a Web App, external POST requests from server.py trigger this.
 */
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheets()[0];
    var contents = e.postData.contents;
    var req = JSON.parse(contents);
    var action = req.action;
    var payload = req.payload || {};
    var result = { success: false };

    if (action === "UPDATE_STATUS") {
      result = handleUpdateStatus(sheet, payload);
    } else if (action === "APPEND_SALE") {
      result = handleAppendSale(ss, payload);
    } else if (action === "INSERT_ROW" || action === "ADD_BOOK") {
      result = handleAddBook(sheet, payload);
    } else if (action === "DELETE_ROW") {
      result = handleDeleteBook(sheet, payload);
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function handleUpdateStatus(sheet, payload) {
  var bookId = String(payload.book_id || "").trim();
  var status = String(payload.status || "SOLD OUT").trim();
  if (!bookId) return { success: false, error: "Missing book_id" };

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  // Ensure Column K (11) has Status header
  var statusCol = 11;
  sheet.getRange(1, statusCol).setValue("Status").setFontWeight("bold");

  // Read Column B (Book_ID)
  var ids = sheet.getRange(1, 2, lastRow, 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === bookId) {
      var cell = sheet.getRange(i + 1, statusCol);
      cell.setValue(status);
      if (status === "SOLD OUT") {
        cell.setBackground("#fee2e2").setFontColor("#b91c1c").setFontWeight("bold");
      } else {
        cell.setBackground(null).setFontColor(null).setFontWeight("normal");
      }
      return { success: true, row: i + 1, book_id: bookId, status: status };
    }
  }
  return { success: false, error: "Book ID " + bookId + " not found" };
}

function handleAppendSale(ss, payload) {
  var salesSheet = ss.getSheetByName("Sales_Transactions");
  if (!salesSheet) {
    salesSheet = ss.insertSheet("Sales_Transactions");
    salesSheet.appendRow(["Transaction_Ref", "Book_ID", "Title", "Author", "Selling_Price", "Sold_At", "Sold_By", "Notes"]);
    var headerRange = salesSheet.getRange(1, 1, 1, 8);
    headerRange.setFontWeight("bold");
    headerRange.setBackground("#f3f4f6");
  }
  salesSheet.appendRow([
    payload.transaction_ref || "",
    payload.book_id || "",
    payload.title || "",
    payload.author || "",
    payload.selling_price !== null && payload.selling_price !== undefined ? payload.selling_price : "",
    payload.sold_at || new Date().toISOString(),
    payload.sold_by || "Staff",
    payload.notes || ""
  ]);
  return { success: true };
}

function handleAddBook(sheet, payload) {
  var lastRow = sheet.getLastRow();
  var newIndex = lastRow;
  var simpleGenre = classifyCommonGenre(payload.genre || "", payload.title || "");
  sheet.appendRow([
    newIndex,
    payload.book_id || "",
    payload.rack || "",
    payload.column || "",
    payload.position || "",
    payload.title || "",
    payload.author || "",
    payload.genre || "",
    payload.notes || "",
    simpleGenre,
    payload.status || "Available"
  ]);
  return { success: true, row: lastRow + 1 };
}

function handleDeleteBook(sheet, payload) {
  var bookId = String(payload.book_id || "").trim();
  if (!bookId) return { success: false, error: "Missing book_id" };
  var lastRow = sheet.getLastRow();
  var ids = sheet.getRange(1, 2, lastRow, 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === bookId) {
      sheet.deleteRow(i + 1);
      return { success: true, deleted_book_id: bookId };
    }
  }
  return { success: false, error: "Book ID not found" };
}

/**
 * Maps raw detailed book genres to the fixed canonical 20 genres.
 */
function classifyCommonGenre(rawGenre, title) {
  if (!rawGenre) return "General Non-Fiction";
  var g = rawGenre.toLowerCase().trim();
  var primary = g.split("/")[0].trim();

  // 1. Law
  var lawKeywords = [
    "tax law", "corporate law", "criminal law", "civil law", "labour law", "labor law",
    "patent law", "medical law", "company law", "legal reference", "legal studies",
    "constitutional law", "legal history", "legal memoir", "jurisprudence", "intellectual property",
    "leases", "securities law", "entertainment law", "gst reference", "finance reference & law"
  ];
  if (lawKeywords.some(function(k) { return g.indexOf(k) !== -1; }) || 
      (["law", "legal"].some(function(k) { return primary.indexOf(k) !== -1; }) && g.indexOf("law of attraction") === -1)) {
    if (g.indexOf("law of attraction") === -1) return "Law";
  }

  // 2. Music
  var musicPrimary = ["music", "sound studies", "albums", "records", "beatles"];
  var musicKeywords = [
    "music history", "music theory", "popular music", "music production",
    "sound art", "songwriting", "jazz", "classical music", "rock music", "hip hop",
    "opera", "musicians", "soundtrack"
  ];
  if (musicPrimary.some(function(k) { return primary.indexOf(k) !== -1; }) || 
      musicKeywords.some(function(k) { return g.indexOf(k) !== -1; })) {
    return "Music";
  }

  // 3. Philosophy
  var philKeywords = [
    "philosophy", "philosophical", "aesthetics", "ethics", "epistemology",
    "metaphysics", "existentialism", "stoic", "stoicism", "kantian", "nietzsche",
    "logic", "spinoza", "hegel", "wittgenstein", "heidegger", "socrat"
  ];
  if (philKeywords.some(function(k) { return g.indexOf(k) !== -1; })) {
    return "Philosophy";
  }

  // 4. Self-Help
  var selfHelpKeywords = [
    "self-help", "self help", "personal development", "personal growth", "motivation",
    "motivational", "productivity", "habits", "habit formation", "mindset", "life skills",
    "time management", "inspirational", "happiness", "mindfulness", "confidence",
    "career planning", "career guide", "professional growth", "personal reinvention",
    "personal branding", "interpersonal skills", "trust building", "positive thinking",
    "creative thinking", "solitude", "self-discovery", "nlp", "neuro-linguistic"
  ];
  if (selfHelpKeywords.some(function(k) { return g.indexOf(k) !== -1; })) {
    return "Self-Help";
  }

  // 5. Biography & Memoir
  var bioPrimary = ["biography", "autobiography", "memoir", "diaries", "life of", "biographical", "collected letters"];
  if (bioPrimary.some(function(k) { return primary.indexOf(k) !== -1; }) || 
      ["biography", "autobiography", "memoir", "diaries"].some(function(k) { return g.indexOf(k) !== -1; })) {
    return "Biography";
  }

  // 6. History
  var histPrimary = [
    "history", "historical", "historian", "civil war", "world war", "ancient",
    "medieval", "colonial", "archaeology", "antiquity", "empire", "dynasty", "revolution"
  ];
  if (histPrimary.some(function(k) { return primary.indexOf(k) !== -1; })) return "History";

  // 7. Politics
  var polKeywords = [
    "international relations", "politics", "political", "geopolitics", "government",
    "public policy", "diplomacy", "foreign policy", "governance", "democracy",
    "communism", "socialism", "public administration", "security studies", "espionage",
    "cold war", "middle eastern studies", "caucasian", "civics", "sociology", "social policy",
    "social criticism", "feminist essays", "public affairs", "social activism", "feminism",
    "human rights", "marxism"
  ];
  if (polKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Politics";
  if (histPrimary.some(function(k) { return g.indexOf(k) !== -1; })) return "History";

  // 8. Business & Economics
  var bizKeywords = [
    "business", "finance", "financial", "economics", "economic", "investing",
    "investment", "stock market", "management", "marketing", "advertising",
    "entrepreneurship", "leadership", "accounting", "commerce", "corporate",
    "startup", "wealth", "money", "banking", "sales", "real estate", "industry",
    "trade", "taxation", "logistics", "supply chain", "public relations", "social enterprise",
    "innovation", "freelancing", "remote work", "organizational development", "mentorship"
  ];
  if (bizKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Business & Economics";

  // 9. Psychology
  var psychKeywords = [
    "psychology", "psychological", "psychiatry", "cognitive science", "mental health",
    "psychoanalysis", "behavioral", "behavioural", "counseling", "neurodiversity",
    "autism", "addiction recovery", "trauma", "neuroscience", "cbt"
  ];
  if (psychKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Psychology";

  if (g.indexOf("law") !== -1 && g.indexOf("law of attraction") === -1) return "Law";

  // 10. Religion & Spirituality
  var relKeywords = [
    "religion", "religious", "spirituality", "spiritual", "theology", "mythology",
    "hinduism", "buddhism", "christianity", "islam", "judaism", "sufism", "meditation",
    "vedic", "gita", "upanishad", "bible", "quran", "scripture", "mysticism", "occult",
    "zen", "sikhism", "jainism", "prayer", "god", "law of attraction", "astrology"
  ];
  if (relKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Religion & Spirituality";

  // 11. Science & Technology
  var sciKeywords = [
    "science", "scientific", "physics", "chemistry", "biology", "biological",
    "astronomy", "astrophysics", "mathematics", "math", "computer science",
    "programming", "software", "technology", "artificial intelligence", "machine learning",
    "data science", "cyber", "engineering", "genetics", "evolution", "quantum",
    "nature", "botany", "zoology", "environment", "ecology", "geology", "climate"
  ];
  if (sciKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Science & Technology";

  // 12. Health & Wellness
  var healthKeywords = [
    "health", "fitness", "medicine", "medical", "nutrition", "diet", "wellness",
    "yoga", "workout", "healing", "exercise", "disease", "anatomy", "physiology",
    "pharmacy", "nursing", "weight loss", "physical therapy", "pilates"
  ];
  if (healthKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Health & Wellness";

  // 13. Cookery & Food
  var foodKeywords = [
    "cookery", "cooking", "cookbook", "food", "baking", "recipe", "culinary",
    "gastronomy", "wine", "cocktails", "cuisine", "dietary", "dessert"
  ];
  if (foodKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Cookery & Food";

  // 14. Children & Young Adult
  var childKeywords = [
    "children", "young adult", "ya", "picture book", "middle grade", "juvenile",
    "teen", "fairy tale", "nursery", "comics", "manga", "graphic novel", "fables"
  ];
  if (childKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Children & Young Adult";

  // 15. Art & Culture
  var artKeywords = [
    "art", "photography", "cinema", "film", "theater", "theatre",
    "design", "architecture", "fashion", "performing arts", "painting", "sculpture",
    "media studies", "journalism", "cultural studies", "broadcasting", "anthropology"
  ];
  if (artKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Art & Culture";

  // 16. Travel & Adventure
  var travelKeywords = [
    "travel", "geography", "exploration", "adventure", "outdoors", "mountaineering",
    "expedition", "guidebook", "cartography", "tourism"
  ];
  if (travelKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Travel & Adventure";

  // 17. Education & Reference
  var eduKeywords = [
    "education", "educational", "reference", "dictionary", "grammar", "textbook",
    "study guide", "pedagogy", "linguistics", "language", "encyclopedia",
    "academic writing", "higher education", "teaching", "school", "rhetoric", "communication",
    "writing guide", "authorship"
  ];
  if (eduKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Education & Reference";

  // 18. Humor & Lifestyle
  var humorKeywords = [
    "humor", "humour", "comedy", "satire", "jokes", "trivia", "pop culture",
    "games", "puzzles", "lifestyle", "parenting", "relationships", "dating",
    "marriage", "sports", "cricket", "football", "chess", "animals", "pet care"
  ];
  if (humorKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Humor & Lifestyle";

  // 19. Fiction
  var ficKeywords = [
    "fiction", "novel", "thriller", "mystery", "crime", "detective", "romance",
    "sci-fi", "science fiction", "fantasy", "horror", "suspense", "stories",
    "short stories", "drama", "plays", "poetry", "poems", "classics", "classic literature",
    "literary", "literature", "anthology"
  ];
  if (ficKeywords.some(function(k) { return g.indexOf(k) !== -1; })) return "Fiction";

  return "General Non-Fiction";
}
