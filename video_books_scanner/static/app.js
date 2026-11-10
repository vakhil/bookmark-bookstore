// Indra OCR Video Bookshelf Scanner Client Logic

let selectedFile = null;
let currentBooks = [];

const fileInput = document.getElementById('videoFileInput');
const dropZone = document.getElementById('dropZone');
const selectedFileInfo = document.getElementById('selectedFileInfo');
const btnProcessVideo = document.getElementById('btnProcessVideo');
const btnLoadSample = document.getElementById('btnLoadSampleData');
const btnClearAll = document.getElementById('btnClearAll');
const videoPreviewWrap = document.getElementById('videoPreviewWrap');
const videoPreview = document.getElementById('videoPreview');
const progressWrap = document.getElementById('progressWrap');
const progressBarFill = document.getElementById('progressBarFill');
const progressText = document.getElementById('progressText');
const booksTableBody = document.getElementById('booksTableBody');
const bookCountElem = document.getElementById('bookCount');
const rawTsvOutput = document.getElementById('rawTsvOutput');
const rackInput = document.getElementById('rackInput');
const columnsInput = document.getElementById('columnsInput');
const fpsInput = document.getElementById('fpsInput');

// Drag and drop event listeners
['dragenter', 'dragover'].forEach(name => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(name => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});

dropZone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    handleSelectedVideo(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    handleSelectedVideo(e.target.files[0]);
  }
});

function handleSelectedVideo(file) {
  selectedFile = file;
  selectedFileInfo.style.display = 'inline-block';
  selectedFileInfo.textContent = `📹 Selected: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
  btnProcessVideo.disabled = false;

  const videoUrl = URL.createObjectURL(file);
  videoPreview.src = videoUrl;
  videoPreviewWrap.style.display = 'block';
}

btnClearAll.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  selectedFileInfo.style.display = 'none';
  btnProcessVideo.disabled = true;
  videoPreview.src = '';
  videoPreviewWrap.style.display = 'none';
  progressWrap.style.display = 'none';
  currentBooks = [];
  renderTable([]);
});

// Process video via backend API using Indra OCR
btnProcessVideo.addEventListener('click', async () => {
  if (!selectedFile) return;

  btnProcessVideo.disabled = true;
  progressWrap.style.display = 'block';
  progressBarFill.style.width = '20%';
  progressText.textContent = 'Reading video file bytes...';

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;
      progressBarFill.style.width = '45%';
      progressText.textContent = '⚡ Running Indra OCR neural network on video frames...';

      try {
        const res = await fetch('/api/process-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            video_data: base64Data,
            rack: rackInput.value.trim() || 'Rack 92',
            columns: parseInt(columnsInput.value, 10) || 4,
            fps: parseFloat(fpsInput.value) || 1.5
          })
        });

        progressBarFill.style.width = '85%';
        const data = await res.json();

        if (data.error) {
          alert('Server notice: ' + data.error);
          progressWrap.style.display = 'none';
          btnProcessVideo.disabled = false;
          return;
        }

        progressBarFill.style.width = '100%';
        progressText.textContent = `✅ Successfully extracted ${data.books.length} books!`;
        currentBooks = data.books || [];
        renderTable(currentBooks);

        setTimeout(() => {
          progressWrap.style.display = 'none';
          btnProcessVideo.disabled = false;
        }, 1500);

      } catch (err) {
        alert('Processing error: ' + err.message);
        progressWrap.style.display = 'none';
        btnProcessVideo.disabled = false;
      }
    };
    reader.readAsDataURL(selectedFile);
  } catch (err) {
    alert('Error reading video: ' + err.message);
    btnProcessVideo.disabled = false;
  }
});

// Load verified sample dataset (matching user reference)
btnLoadSample.addEventListener('click', () => {
  const sampleBooks = [
    { Book_ID: "BK-12399", Rack: "Rack 92", Column: "Column 1", Pos: 1, Title: "The Lives of Strangers", Author_or_Editor: "Chitra Banerjee Divakaruni", Genre: "Short Stories / Contemporary Fiction", Notes: "Vertical standing book 1; illustrated tan spine" },
    { Book_ID: "BK-12400", Rack: "Rack 92", Column: "Column 1", Pos: 2, Title: "Switchcraft", Author_or_Editor: "Elaine Fox", Genre: "Psychology / Mental Agility", Notes: "Vertical standing book 2; light blue spine" },
    { Book_ID: "BK-12401", Rack: "Rack 92", Column: "Column 1", Pos: 3, Title: "The End of Alchemy", Author_or_Editor: "Mervyn King", Genre: "Economics / Banking & Financial Crises", Notes: "Vertical standing book 3; dark blue spine" },
    { Book_ID: "BK-12402", Rack: "Rack 92", Column: "Column 1", Pos: 4, Title: "Rebel Ideas", Author_or_Editor: "Matthew Syed", Genre: "Cognitive Diversity / Innovation", Notes: "Vertical standing book 4; cyan/blue spine" },
    { Book_ID: "BK-12403", Rack: "Rack 92", Column: "Column 1", Pos: 5, Title: "The Right Choice", Author_or_Editor: "Shiv Shivakumar", Genre: "Career / Decision Making & Leadership", Notes: "Vertical standing book 5; white spine with red text" },
    { Book_ID: "BK-12404", Rack: "Rack 92", Column: "Column 1", Pos: 6, Title: "10-10-10", Author_or_Editor: "Suzy Welch", Genre: "Personal Growth / Decision Making", Notes: "Vertical standing book 6; white/light blue spine" },
    { Book_ID: "BK-12405", Rack: "Rack 92", Column: "Column 1", Pos: 7, Title: "Sacred Games", Author_or_Editor: "Vikram Chandra", Genre: "Crime Thriller / Mumbai Noir", Notes: "Lower vertical book 1 on left; red/orange spine" },
    { Book_ID: "BK-12406", Rack: "Rack 92", Column: "Column 1", Pos: 8, Title: "Complaint!", Author_or_Editor: "Sara Ahmed", Genre: "Feminist Theory / Institutional Critique", Notes: "Lower vertical book 2; blue spine with white title" },
    { Book_ID: "BK-12407", Rack: "Rack 92", Column: "Column 1", Pos: 9, Title: "The Trail to Enlightenment", Author_or_Editor: "Shuvendu Patnaik", Genre: "Spirituality / Self-Help", Notes: "Lower vertical book 3; dark navy spine" },
    { Book_ID: "BK-12408", Rack: "Rack 92", Column: "Column 1", Pos: 10, Title: "Traction", Author_or_Editor: "Gino Wickman", Genre: "Business / Entrepreneurial Operating System", Notes: "Lower vertical book 4; black spine with orange title" },
    { Book_ID: "BK-12409", Rack: "Rack 92", Column: "Column 1", Pos: 11, Title: "The Great Reversal: How America Gave Up on Free Markets", Author_or_Editor: "Thomas Philippon", Genre: "Economics / Market Competition", Notes: "Lower vertical book 5; green/grey spine" },
    { Book_ID: "BK-12410", Rack: "Rack 92", Column: "Column 1", Pos: 12, Title: "Crucial Confrontations", Author_or_Editor: "Kerry Patterson et al.", Genre: "Communication / Conflict Resolution", Notes: "Lower vertical book 6; blue/purple spine" },
    { Book_ID: "BK-12411", Rack: "Rack 92", Column: "Column 1", Pos: 13, Title: "Fit for the Fast Track", Author_or_Editor: "Michael Heppell", Genre: "Personal Development / Career Success", Notes: "Lower vertical book 7; teal spine" },
    { Book_ID: "BK-12412", Rack: "Rack 92", Column: "Column 2", Pos: 1, Title: "Winning", Author_or_Editor: "Jack Welch with Suzy Welch", Genre: "Business / Executive Leadership", Notes: "Top horizontal book below boundary; black/white spine" },
    { Book_ID: "BK-12413", Rack: "Rack 92", Column: "Column 2", Pos: 2, Title: "Focus", Author_or_Editor: "Daniel Goleman", Genre: "Psychology / Attention & Excellence", Notes: "White spine with bold black title" },
    { Book_ID: "BK-12414", Rack: "Rack 92", Column: "Column 2", Pos: 3, Title: "On the Plain of Snakes", Author_or_Editor: "Paul Theroux", Genre: "Travel Writing / Mexican Borderlands", Notes: "Light blue spine with white text" },
    { Book_ID: "BK-12415", Rack: "Rack 92", Column: "Column 2", Pos: 4, Title: "The Ministry of Utmost Happiness", Author_or_Editor: "Arundhati Roy", Genre: "Literary Fiction / Contemporary India", Notes: "Light blue/grey spine" },
    { Book_ID: "BK-12416", Rack: "Rack 92", Column: "Column 2", Pos: 5, Title: "The Second Coming of Christ (Vol 1)", Author_or_Editor: "Paramahansa Yogananda", Genre: "Spiritual Commentary / Christian Mysticism", Notes: "Thick maroon/brown spine with gold lettering" },
    { Book_ID: "BK-12417", Rack: "Rack 92", Column: "Column 2", Pos: 6, Title: "HR Competencies", Author_or_Editor: "David G. Bettman", Genre: "Human Resources / Organizational Design", Notes: "Blue spine" },
    { Book_ID: "BK-12418", Rack: "Rack 92", Column: "Column 2", Pos: 7, Title: "Basic Montessori", Author_or_Editor: "David Gettman", Genre: "Early Childhood Education / Montessori Method", Notes: "White spine with blue text" },
    { Book_ID: "BK-12419", Rack: "Rack 92", Column: "Column 2", Pos: 8, Title: "Winston S. Churchill: The Second World War", Author_or_Editor: "Winston S. Churchill", Genre: "History / WWII Memoirs", Notes: "Purple/black spine" },
    { Book_ID: "BK-12420", Rack: "Rack 92", Column: "Column 2", Pos: 9, Title: "7 Secrets to Investing Like Warren Buffett", Author_or_Editor: "Mary Buffett & Sean Seah", Genre: "Value Investing / Personal Finance", Notes: "Light yellow/cream spine" },
    { Book_ID: "BK-12421", Rack: "Rack 92", Column: "Column 2", Pos: 10, Title: "Cometh the Hour", Author_or_Editor: "Jeffrey Archer", Genre: "Historical Fiction / The Clifton Chronicles", Notes: "Dark purple spine" },
    { Book_ID: "BK-12422", Rack: "Rack 92", Column: "Column 2", Pos: 11, Title: "7 Untold Secrets of Living Abroad", Author_or_Editor: "Karan Agrawal", Genre: "Travel / Expat Guidebook", Notes: "White wrapped spine" },
    { Book_ID: "BK-12423", Rack: "Rack 92", Column: "Column 2", Pos: 12, Title: "No Reference Point", Author_or_Editor: "JVC Sreeram", Genre: "Self-Help / Transformation", Notes: "Black spine with green/white text" },
    { Book_ID: "BK-12424", Rack: "Rack 92", Column: "Column 2", Pos: 13, Title: "Maradona: The Boy. The Rebel. The God.", Author_or_Editor: "Guillem Balague", Genre: "Sports Biography / Football", Notes: "Yellow spine with bold black lettering" },
    { Book_ID: "BK-12425", Rack: "Rack 92", Column: "Column 2", Pos: 14, Title: "Stones of the Goddess", Author_or_Editor: "Various", Genre: "Archaeology / Neolithic Spirituality", Notes: "Red/orange spine" },
    { Book_ID: "BK-12426", Rack: "Rack 92", Column: "Column 2", Pos: 15, Title: "Light Footprint Management", Author_or_Editor: "Charles-Edouard Bouée", Genre: "Business Strategy / Crisis Leadership", Notes: "Black spine with red/white text" },
    { Book_ID: "BK-12427", Rack: "Rack 92", Column: "Column 2", Pos: 16, Title: "Om Shantih Shantih Shantih", Author_or_Editor: "Osho", Genre: "Spirituality / Eastern Philosophy", Notes: "Deep blue spine with white lettering" },
    { Book_ID: "BK-12428", Rack: "Rack 92", Column: "Column 2", Pos: 17, Title: "The Lost Book of the White", Author_or_Editor: "Cassandra Clare & Wesley Chu", Genre: "YA Fantasy / Shadowhunters Series", Notes: "Black spine with white title" },
    { Book_ID: "BK-12429", Rack: "Rack 92", Column: "Column 2", Pos: 18, Title: "Brushes with History: An Autobiography", Author_or_Editor: "Krishna Kumar Birla", Genre: "Business Autobiography / Indian History", Notes: "Mustard yellow spine" },
    { Book_ID: "BK-12430", Rack: "Rack 92", Column: "Column 2", Pos: 19, Title: "The Cottingley Secret", Author_or_Editor: "Hazel Gaynor", Genre: "Historical Fiction / Fairy Photographs", Notes: "Bottom book of Column 2 stack; dark green spine" },
    { Book_ID: "BK-12431", Rack: "Rack 92", Column: "Column 3", Pos: 1, Title: "Endure: Mind, Body, and the Curiously Elastic Limits of Human Performance", Author_or_Editor: "Alex Hutchinson", Genre: "Sports Science / Physiology & Endurance", Notes: "Top book of Column 3 below boundary; white/blue spine" },
    { Book_ID: "BK-12432", Rack: "Rack 92", Column: "Column 3", Pos: 2, Title: "A Manager's Guide to Coaching", Author_or_Editor: "Anne Scoular", Genre: "Business Management / Executive Coaching", Notes: "White spine with blue banner" },
    { Book_ID: "BK-12433", Rack: "Rack 92", Column: "Column 3", Pos: 3, Title: "The Courage to Be Disliked", Author_or_Editor: "Ichiro Kishimi & Fumitake Koga", Genre: "Adlerian Psychology / Self-Help", Notes: "Light blue/grey spine with red title" },
    { Book_ID: "BK-12434", Rack: "Rack 92", Column: "Column 3", Pos: 4, Title: "I Do What I Do", Author_or_Editor: "Raghuram G. Rajan", Genre: "Economics / Monetary Policy & Essays", Notes: "White spine with bold red/black lettering" },
    { Book_ID: "BK-12435", Rack: "Rack 92", Column: "Column 3", Pos: 5, Title: "A Mind at a Time", Author_or_Editor: "Mel Levine, M.D.", Genre: "Child Development / Cognitive Neuroscience", Notes: "Yellow spine with black text" },
    { Book_ID: "BK-12436", Rack: "Rack 92", Column: "Column 3", Pos: 6, Title: "The Ride of a Lifetime", Author_or_Editor: "Robert Iger", Genre: "Business Memoir / Disney Leadership", Notes: "Dark blue spine with white lettering" },
    { Book_ID: "BK-12437", Rack: "Rack 92", Column: "Column 3", Pos: 7, Title: "Source Code Meditation", Author_or_Editor: "Dr. Michael Cotton", Genre: "Neuroscience / Meditation & Consciousness", Notes: "Blue spine with green text" },
    { Book_ID: "BK-12438", Rack: "Rack 92", Column: "Column 3", Pos: 8, Title: "The Ideal Team Player", Author_or_Editor: "Patrick Lencioni", Genre: "Business Leadership / Team Dynamics", Notes: "White spine with red title panel" },
    { Book_ID: "BK-12439", Rack: "Rack 92", Column: "Column 3", Pos: 9, Title: "Lady Joker (Volume 2)", Author_or_Editor: "Kaoru Takamura", Genre: "Japanese Crime Noir / Literary Fiction", Notes: "Orange spine with silhouetted running figure" },
    { Book_ID: "BK-12440", Rack: "Rack 92", Column: "Column 3", Pos: 10, Title: "Lifepass", Author_or_Editor: "Payal Kadakia", Genre: "Entrepreneurship / Personal Goal Setting", Notes: "Cyan/light blue spine" }
  ];

  currentBooks = sampleBooks;
  renderTable(currentBooks);
});

// Render extracted books to table & raw TSV/Database preview
function renderTable(books) {
  bookCountElem.textContent = books.length;

  if (books.length === 0) {
    booksTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-cell">
          No books scanned yet. Supply a bookshelf video above or click "Load Verified Sample".
        </td>
      </tr>
    `;
    rawTsvOutput.value = '';
    return;
  }

  // Populate HTML Table
  booksTableBody.innerHTML = books.map(b => `
    <tr>
      <td><b>${escapeHtml(b.Book_ID)}</b></td>
      <td>${escapeHtml(b.Rack)}</td>
      <td>${escapeHtml(b.Column)}</td>
      <td>${b.Pos}</td>
      <td><b>${escapeHtml(b.Title)}</b></td>
      <td>${escapeHtml(b.Author_or_Editor)}</td>
      <td><span style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-weight:600; font-size:0.8rem;">${escapeHtml(b.Genre)}</span></td>
      <td style="color:#64748b; font-size:0.82rem;">${escapeHtml(b.Notes || '')}</td>
    </tr>
  `).join('');

  // Populate TSV formatted with Header line followed by rows
  const headers = ["Book_ID", "Rack", "Column", "Pos", "Title", "Author_or_Editor", "Genre", "Notes"];
  const tsvLines = [headers.join("\t")];

  books.forEach(b => {
    tsvLines.push([
      b.Book_ID,
      b.Rack,
      b.Column,
      b.Pos,
      b.Title,
      b.Author_or_Editor,
      b.Genre,
      b.Notes || ""
    ].join("\t"));
  });

  rawTsvOutput.value = tsvLines.join("\n");
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Export actions
document.getElementById('btnCopyTSV').addEventListener('click', () => {
  if (!rawTsvOutput.value) return alert('No table data to copy.');
  navigator.clipboard.writeText(rawTsvOutput.value);
  alert('✅ TSV database output copied to clipboard! Ready to paste directly into Google Sheets, Excel, or SQL importer.');
});

document.getElementById('btnDownloadCSV').addEventListener('click', () => {
  if (currentBooks.length === 0) return alert('No table data to download.');
  const headers = ["Book_ID", "Rack", "Column", "Pos", "Title", "Author_or_Editor", "Genre", "Notes"];
  const csvRows = [headers.map(h => `"${h}"`).join(",")];

  currentBooks.forEach(b => {
    csvRows.push([
      `"${b.Book_ID}"`,
      `"${b.Rack}"`,
      `"${b.Column}"`,
      b.Pos,
      `"${(b.Title || '').replace(/"/g, '""')}"`,
      `"${(b.Author_or_Editor || '').replace(/"/g, '""')}"`,
      `"${(b.Genre || '').replace(/"/g, '""')}"`,
      `"${(b.Notes || '').replace(/"/g, '""')}"`
    ].join(","));
  });

  const blob = new Blob([csvRows.join("\n")], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `indra_video_books_${Date.now()}.csv`;
  a.click();
});

document.getElementById('btnDownloadJSON').addEventListener('click', () => {
  if (currentBooks.length === 0) return alert('No table data to export.');
  const blob = new Blob([JSON.stringify(currentBooks, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `indra_video_books_${Date.now()}.json`;
  a.click();
});
