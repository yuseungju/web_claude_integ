// 파일 변환 — 완전히 클라이언트(브라우저)에서 처리되는 변환만 지원
const CONV_MAP = {
  png:  ['jpg', 'webp', 'bmp', 'pdf'],
  jpg:  ['png', 'webp', 'bmp', 'pdf'],
  jpeg: ['png', 'webp', 'bmp', 'pdf'],
  webp: ['png', 'jpg', 'bmp', 'pdf'],
  bmp:  ['png', 'jpg', 'webp', 'pdf'],
  gif:  ['png', 'jpg', 'webp', 'bmp', 'pdf'],
  pdf:  ['png', 'jpg'],
  csv:  ['xlsx'],
  xlsx: ['csv'],
  xls:  ['csv', 'xlsx'],
};
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
const SHEET_EXTS = ['csv', 'xlsx', 'xls'];

let currentFile = null;
let currentExt  = null;

document.addEventListener('DOMContentLoaded', () => {
  const dropZone  = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  }
});

function handleFile(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  currentFile = file;
  currentExt  = ext;

  document.getElementById('dropZone').classList.add('has-file');
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('convertCard').style.display = '';
  document.getElementById('srcExtBadge').textContent = ext ? ext.toUpperCase() : '?';
  setStatus('', '');

  const targets = CONV_MAP[ext] || [];
  const select  = document.getElementById('targetExt');
  const unsupportedMsg = document.getElementById('unsupportedMsg');
  const btn = document.getElementById('btnConvert');

  if (!targets.length) {
    select.innerHTML = '';
    select.disabled = true;
    unsupportedMsg.style.display = '';
    btn.disabled = true;
    return;
  }
  unsupportedMsg.style.display = 'none';
  select.disabled = false;
  select.innerHTML = targets.map(t => `<option value="${t}">${t.toUpperCase()}</option>`).join('');
  btn.disabled = false;
}

function setStatus(msg, type) {
  const el = document.getElementById('convStatus');
  el.textContent = msg;
  el.className = 'conv-status' + (type ? ' ' + type : '');
}

async function runConvert() {
  if (!currentFile) return;
  const targetExt = document.getElementById('targetExt').value;
  const btn = document.getElementById('btnConvert');
  btn.disabled = true;
  setStatus('변환 중...', 'info');

  try {
    let blob, outExt = targetExt;
    if (IMAGE_EXTS.includes(currentExt) && IMAGE_EXTS.includes(targetExt)) {
      blob = await imageToImage(currentFile, targetExt);
    } else if (IMAGE_EXTS.includes(currentExt) && targetExt === 'pdf') {
      blob = await imageToPdf(currentFile);
    } else if (currentExt === 'pdf' && IMAGE_EXTS.includes(targetExt)) {
      const result = await pdfToImage(currentFile, targetExt);
      blob = result.blob;
      if (result.zip) outExt = 'zip';
    } else if (SHEET_EXTS.includes(currentExt) && SHEET_EXTS.includes(targetExt)) {
      blob = await convertSpreadsheet(currentFile, currentExt, targetExt);
    } else {
      throw new Error('지원하지 않는 변환입니다.');
    }

    const baseName = currentFile.name.replace(/\.[^.]+$/, '');
    downloadBlob(blob, `${baseName}.${outExt}`);
    setStatus('✅ 변환 완료! 다운로드되었습니다.', 'success');
  } catch (e) {
    console.error(e);
    setStatus('❌ ' + (e.message || '변환 중 오류가 발생했습니다.'), 'error');
  } finally {
    btn.disabled = false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── 이미지 ↔ 이미지 / 이미지 → PDF ─────────────────────── */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload  = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 불러올 수 없습니다.')); };
    img.src = url;
  });
}

async function imageToImage(file, targetExt) {
  const { img, url } = await loadImage(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (targetExt === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0);
    if (targetExt === 'bmp') return canvasToBmpBlob(canvas);
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[targetExt];
    return await new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('이미지 변환에 실패했습니다.')), mime, 0.92)
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 24bpp BMP 인코더 (canvas.toBlob이 image/bmp를 지원하지 않으므로 직접 생성)
function canvasToBmpBlob(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, w, h).data;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pad = rowSize - w * 3;
  const pixelArraySize = rowSize * h;
  const fileSize = 54 + pixelArraySize;
  const buf  = new ArrayBuffer(fileSize);
  const view = new DataView(buf);

  view.setUint8(0, 0x42); view.setUint8(1, 0x4D); // 'BM'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);   // DIB 헤더 크기
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);    // planes
  view.setUint16(28, 24, true);   // bpp
  view.setUint32(30, 0, true);    // BI_RGB
  view.setUint32(34, pixelArraySize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);

  let offset = 54;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      view.setUint8(offset++, imgData[i + 2]); // B
      view.setUint8(offset++, imgData[i + 1]); // G
      view.setUint8(offset++, imgData[i]);     // R
    }
    for (let p = 0; p < pad; p++) view.setUint8(offset++, 0);
  }
  return new Blob([buf], { type: 'image/bmp' });
}

async function imageToPdf(file) {
  const { img, url } = await loadImage(file);
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: w >= h ? 'landscape' : 'portrait', unit: 'px', format: [w, h] });
    pdf.addImage(dataUrl, 'JPEG', 0, 0, w, h);
    return pdf.output('blob');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ── PDF → 이미지 ─────────────────────────────────────── */
async function pdfToImage(file, targetExt) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const mime = targetExt === 'jpg' ? 'image/jpeg' : 'image/png';
  const blobs = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (targetExt === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('이미지 변환에 실패했습니다.')), mime, 0.92)
    );
    blobs.push(blob);
  }

  if (blobs.length === 1) return { blob: blobs[0], zip: false };

  const zip = new JSZip();
  blobs.forEach((b, i) => zip.file(`page-${String(i + 1).padStart(2, '0')}.${targetExt}`, b));
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return { blob: zipBlob, zip: true };
}

/* ── CSV / XLSX / XLS ─────────────────────────────────── */
async function convertSpreadsheet(file, srcExt, targetExt) {
  let wb;
  if (srcExt === 'csv') {
    const text = await file.text();
    wb = XLSX.read(text, { type: 'string' });
  } else {
    const data = await file.arrayBuffer();
    wb = XLSX.read(data, { type: 'array' });
  }

  if (targetExt === 'csv') {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const csv = XLSX.utils.sheet_to_csv(ws);
    return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  }

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
