// ── DOM Helpers ──────────────────────────────────────────────────────────────
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── ExcelReader ──────────────────────────────────────────────────────────────
// Reads an .xlsx / .xls / .csv file using SheetJS.
// Returns { sheetNames: string[], sheets: { [name]: { headers, rows } } }
//   headers : string[]   — first row of the sheet
//   rows    : any[][]    — remaining rows as 2-D array
class ExcelReader {
  static read(file, { cellDates = false } = {}) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsArrayBuffer(file);
      reader.onload = ({ target: { result } }) => {
        try {
          const wb     = XLSX.read(result, { type: 'array', cellDates });
          const sheets = {};
          wb.SheetNames.forEach(name => {
            const raw     = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
            const headers = (raw[0] || []).map(String);
            const rows    = raw.slice(1);
            sheets[name]  = { headers, rows };
          });
          resolve({ sheetNames: wb.SheetNames, sheets });
        } catch (err) {
          reject(new Error('파일 파싱 실패: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('파일 읽기 실패'));
    });
  }
}

// ── FileDropZone ─────────────────────────────────────────────────────────────
// Wraps a drop-zone element with drag-and-drop + click-to-browse.
// Options: { onFile(file) }
class FileDropZone {
  constructor(zoneEl, inputEl, { onFile } = {}) {
    this.zoneEl  = zoneEl;
    this.inputEl = inputEl;
    this.onFile  = onFile;
    this._bind();
  }

  _bind() {
    const { zoneEl, inputEl } = this;

    zoneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      zoneEl.classList.add('drag-over');
    });
    zoneEl.addEventListener('dragleave', (e) => {
      // Only remove if leaving the zone itself (not a child)
      if (!zoneEl.contains(e.relatedTarget)) zoneEl.classList.remove('drag-over');
    });
    zoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      zoneEl.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) this._handle(file);
    });
    zoneEl.addEventListener('click', (e) => {
      // Don't double-fire when the hidden input itself is clicked
      if (e.target === inputEl) return;
      inputEl.click();
    });
    inputEl.addEventListener('change', ({ target: { files } }) => {
      if (files[0]) this._handle(files[0]);
    });
  }

  _handle(file) {
    this.zoneEl.classList.remove('drag-over');
    this.zoneEl.classList.add('has-file');
    const nameEl  = this.zoneEl.querySelector('.upload-file-name');
    const titleEl = this.zoneEl.querySelector('.upload-title');
    if (nameEl)  nameEl.textContent  = '✓  ' + file.name;
    if (titleEl) titleEl.textContent = '파일이 선택되었습니다';
    this.onFile?.(file);
  }

  reset() {
    this.zoneEl.classList.remove('has-file', 'drag-over');
    const nameEl  = this.zoneEl.querySelector('.upload-file-name');
    const titleEl = this.zoneEl.querySelector('.upload-title');
    if (nameEl)  nameEl.textContent  = '';
    if (titleEl) titleEl.textContent = '파일을 드래그하거나 클릭하세요';
    this.inputEl.value = '';
  }
}

// ── Table Renderer ───────────────────────────────────────────────────────────
// Renders an array of row arrays (+ headers) into .data-table HTML.
// rowClassFn(rowArr, index) → extra CSS class string or ''
function renderTable(containerEl, headers, rows, rowClassFn = () => '') {
  const thead = `<tr>
    <th class="col-num">#</th>
    ${headers.map(h => `<th title="${h}">${h}</th>`).join('')}
  </tr>`;

  const tbody = rows.map((row, i) => {
    const extraClass = rowClassFn(row, i);
    const cells = headers.map((_, j) => {
      const v = row[j] ?? '';
      return `<td title="${v}">${v}</td>`;
    }).join('');
    return `<tr class="${extraClass}"><td class="col-num">${i + 1}</td>${cells}</tr>`;
  }).join('');

  containerEl.innerHTML = `
    <table class="data-table">
      <thead>${thead}</thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

// ── Object-row Table Renderer ────────────────────────────────────────────────
// Renders an array of objects (e.g. AlaSQL results) into .data-table HTML.
function renderObjectTable(containerEl, rows) {
  if (!rows.length) {
    containerEl.innerHTML = '<p style="padding:1.5rem;text-align:center;color:var(--text-muted)">결과가 없습니다</p>';
    return;
  }
  const cols  = Object.keys(rows[0]);
  const thead = `<tr>
    <th class="col-num">#</th>
    ${cols.map(c => `<th title="${c}">${c}</th>`).join('')}
  </tr>`;
  const tbody = rows.map((row, i) => {
    const cells = cols.map(c => { const v = row[c] ?? ''; return `<td title="${v}">${v}</td>`; }).join('');
    return `<tr><td class="col-num">${i + 1}</td>${cells}</tr>`;
  }).join('');

  containerEl.innerHTML = `
    <table class="data-table">
      <thead>${thead}</thead>
      <tbody>${tbody}</tbody>
    </table>`;
}
